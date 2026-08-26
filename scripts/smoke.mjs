import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { WebSocket } from "ws";

const port = 18787;
const origin = `http://127.0.0.1:${port}`;
const pairingToken = "smoke-test-token";
// A real generated pair, used only for its shape: nothing here reaches a push
// service, and the default deployment below runs with no keys at all.
const VAPID_ENV = {
  PRIME_WEB_VAPID_PUBLIC_KEY: "BF1JW243veaons7uO0bcdtRHXVUTVJ74A_OzX7wiGhY114OpWvn0BOBrfXu2AhV3cmc0Nrb_LIRZHbFY4L8Xmgw",
  PRIME_WEB_VAPID_PRIVATE_KEY: "IPDx2j8nr-ShPjNWSqXsCAK3fA0W2cM78tjLvtG0jLA",
  PRIME_WEB_VAPID_SUBJECT: "mailto:operator@example.test",
};

const gateways = [];

function startGateway(gatewayPort, extraEnv = {}) {
  const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
  const gateway = spawn(process.execPath, ["dist-server/server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PRIME_WEB_PORT: String(gatewayPort),
      PRIME_WEB_HOST: "127.0.0.1",
      PRIME_WEB_ALLOWED_ORIGINS: gatewayOrigin,
      PRIME_WEB_PAIRING_TOKEN: pairingToken,
      PRIME_WEB_BACKEND: "demo",
      PRIME_WEB_SECURE_COOKIE: "false",
      // Never the operator's real store.
      PRIME_WEB_PUSH_STORE: join(mkdtempSync(join(tmpdir(), "prime-smoke-push-")), "push-subscriptions.json"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  gateway.stderr.on("data", (chunk) => { stderr += chunk; });
  gateways.push(gateway);
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Gateway did not start. ${stderr}`)), 8_000);
    gateway.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Gateway exited early with ${code}. ${stderr}`));
    });
    gateway.stdout.on("data", (chunk) => {
      if (String(chunk).includes("gateway listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return { origin: gatewayOrigin, ready };
}

function stop() {
  for (const gateway of gateways) if (!gateway.killed) gateway.kill("SIGTERM");
}

// The default deployment: no VAPID keys. Everything below has to work in it.
const defaultGateway = startGateway(port);

async function json(response) {
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value;
}

function websocketFrame(cookie, streamId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/v1/events`, {
      origin,
      headers: { Cookie: cookie },
    });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket snapshot timed out"));
    }, 5_000);
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "attach", version: 1, streamId, since: null }));
    });
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "snapshot") {
        clearTimeout(timeout);
        socket.close();
        resolve(frame);
      }
    });
    socket.once("error", reject);
  });
}

try {
  await defaultGateway.ready;

  const unauthenticated = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
  if (unauthenticated.status !== 401) throw new Error(`Expected unauthenticated 401, got ${unauthenticated.status}`);
  const unauthenticatedCommands = await fetch(`${origin}/api/v1/agents/unknown/commands`, { headers: { Origin: origin } });
  if (unauthenticatedCommands.status !== 401) throw new Error(`Expected unauthenticated command catalog 401, got ${unauthenticatedCommands.status}`);

  const wrongOrigin = await fetch(`${origin}/api/v1/auth/pair`, {
    method: "POST",
    headers: { Origin: "https://untrusted.invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ token: pairingToken }),
  });
  if (wrongOrigin.status !== 403) throw new Error(`Expected wrong-origin 403, got ${wrongOrigin.status}`);

  const pairResponse = await fetch(`${origin}/api/v1/auth/pair`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: pairingToken }),
  });
  const pairBody = await json(pairResponse);
  const cookie = pairResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie || !pairBody.csrfToken) throw new Error("Pairing did not issue a cookie and CSRF token");

  const bootstrap = await json(await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin, Cookie: cookie } }));
  if (bootstrap.protocolVersion !== 1 || bootstrap.catalog.agents.length < 1) throw new Error("Bootstrap projection is invalid");
  const agentId = bootstrap.catalog.agents.find((agent) => agent.capabilities.send)?.id;
  if (!agentId) throw new Error("No interactive demo agent found");
  const inactiveAgentId = bootstrap.catalog.agents.find((agent) => agent.capabilities.resume)?.id;
  if (!inactiveAgentId) throw new Error("No resumable demo agent found");
  const inactiveSnapshot = await json(await fetch(`${origin}/api/v1/agents/${encodeURIComponent(inactiveAgentId)}/snapshot`, {
    headers: { Origin: origin, Cookie: cookie },
  }));
  const wakeMessage = await fetch(`${origin}/api/v1/agents/${encodeURIComponent(inactiveAgentId)}/messages`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": pairBody.csrfToken,
    },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedRevision: inactiveSnapshot.revision,
      text: "Wake this thread",
    }),
  });
  if (wakeMessage.status !== 202) throw new Error(`Wake message failed: ${wakeMessage.status} ${await wakeMessage.text()}`);
  const resumedBootstrap = await json(await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin, Cookie: cookie } }));
  const resumed = resumedBootstrap.catalog.agents.find((agent) => agent.id === inactiveAgentId);
  if (!resumed?.capabilities.send || resumed.capabilities.resume) throw new Error("Resumed demo agent did not become interactive");

  const snapshot = await json(await fetch(`${origin}/api/v1/agents/${encodeURIComponent(agentId)}/snapshot`, {
    headers: { Origin: origin, Cookie: cookie },
  }));
  const catalogResponse = await fetch(`${origin}/api/v1/agents/${encodeURIComponent(agentId)}/commands`, {
    headers: { Origin: origin, Cookie: cookie },
  });
  const commandCatalog = await json(catalogResponse);
  if (catalogResponse.headers.get("cache-control") !== "no-store") throw new Error("Command catalog must be no-store");
  if (!commandCatalog.commands.some((command) => command.name === "model" && command.availability === "available")) {
    throw new Error("Explicit adapter commands are missing from the command catalog");
  }
  if (!commandCatalog.commands.some((command) => command.name === "demo-extension" && command.availability === "experimental")) {
    throw new Error("Detected commands are missing from the command catalog");
  }
  if (JSON.stringify(commandCatalog).includes("/hidden/")) throw new Error("Command catalog leaked daemon metadata");
  const frame = await websocketFrame(cookie, `agent:${agentId}`);
  if (frame.snapshot.agentId !== agentId) throw new Error("WebSocket stream returned the wrong snapshot");

  const message = await fetch(`${origin}/api/v1/agents/${encodeURIComponent(agentId)}/messages`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": pairBody.csrfToken,
    },
    body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: snapshot.revision, text: "Smoke test" }),
  });
  if (message.status !== 202) throw new Error(`Message admission failed: ${message.status} ${await message.text()}`);
  const messageBody = await message.json();
  const slashMessage = await fetch(`${origin}/api/v1/agents/${encodeURIComponent(agentId)}/messages`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": pairBody.csrfToken,
    },
    body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: messageBody.revision, text: "/settings" }),
  });
  if (slashMessage.status !== 400) throw new Error(`Expected ordinary slash prompt rejection, got ${slashMessage.status}`);
  const commandPath = `${origin}/api/v1/agents/${encodeURIComponent(agentId)}/commands`;
  const commandRequest = {
    requestId: crypto.randomUUID(),
    expectedRevision: messageBody.revision,
    name: "goal",
    args: "status",
  };
  const commandWithoutCsrf = await fetch(commandPath, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(commandRequest),
  });
  if (commandWithoutCsrf.status !== 403) throw new Error(`Expected command CSRF rejection, got ${commandWithoutCsrf.status}`);

  const commandHeaders = {
    Origin: origin,
    Cookie: cookie,
    "Content-Type": "application/json",
    "X-CSRF-Token": pairBody.csrfToken,
  };
  const command = await fetch(commandPath, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify(commandRequest),
  });
  if (command.status !== 202) throw new Error(`Command admission failed: ${command.status} ${await command.text()}`);
  const commandBody = await command.json();
  const duplicate = await fetch(commandPath, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify(commandRequest),
  });
  const duplicateBody = await json(duplicate);
  if (duplicate.status !== 202 || duplicateBody.requestId !== commandBody.requestId) {
    throw new Error("Command idempotency failed");
  }
  const mismatchedRetry = await fetch(commandPath, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({ ...commandRequest, name: "context", args: "" }),
  });
  if (mismatchedRetry.status !== 409) throw new Error(`Expected request ID binding conflict, got ${mismatchedRetry.status}`);

  const contextCommand = await fetch(commandPath, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedRevision: commandBody.revision,
      name: "context",
      args: "",
    }),
  });
  const contextBody = await json(contextCommand);
  if (contextCommand.status !== 202 || contextBody.result?.kind !== "context_usage") {
    throw new Error("Direct command adapter failed");
  }

  const experimentalCommand = await fetch(commandPath, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedRevision: commandBody.revision,
      name: "demo-extension",
      args: "target",
    }),
  });
  const experimentalBody = await json(experimentalCommand);
  if (experimentalCommand.status !== 202 || experimentalBody.result?.kind !== "experimental_accepted") {
    throw new Error("Experimental detected command failed");
  }

  const unknownCommand = await fetch(commandPath, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedRevision: commandBody.revision,
      name: "settings",
      args: "",
    }),
  });
  if (unknownCommand.status !== 403) throw new Error(`Expected unknown command rejection, got ${unknownCommand.status}`);

  const pushSubscription = {
    endpoint: "https://push.example.invalid/smoke-endpoint",
    keys: { p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU", auth: "3v0fHqQhH3xQ1r6mB3dOsg" },
  };
  const bootstrapPush = resumedBootstrap.push;
  if (bootstrapPush?.enabled !== false || bootstrapPush.publicKey !== null) {
    throw new Error("Bootstrap must report push off when no VAPID keys are configured");
  }
  // Without keys the gateway cannot send, so it must refuse the subscription
  // rather than bank a permission it can never act on.
  const subscribeWithoutKeys = await fetch(`${origin}/api/v1/push/subscribe`, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({ requestId: crypto.randomUUID(), subscription: pushSubscription }),
  });
  if (subscribeWithoutKeys.status !== 503) {
    throw new Error(`Expected unconfigured push 503, got ${subscribeWithoutKeys.status}`);
  }
  const subscribeWithoutCsrf = await fetch(`${origin}/api/v1/push/subscribe`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), subscription: pushSubscription }),
  });
  if (subscribeWithoutCsrf.status !== 403) {
    throw new Error(`Expected push CSRF rejection, got ${subscribeWithoutCsrf.status}`);
  }
  const malformedSubscribe = await fetch(`${origin}/api/v1/push/subscribe`, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({ requestId: crypto.randomUUID(), subscription: { endpoint: "not-a-url" } }),
  });
  if (malformedSubscribe.status !== 400) {
    throw new Error(`Expected malformed subscription 400, got ${malformedSubscribe.status}`);
  }
  // Unsubscribe stays open with push off: a device must always be able to
  // stop, even from a gateway whose keys were removed under it.
  const unsubscribe = await fetch(`${origin}/api/v1/push/unsubscribe`, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({ requestId: crypto.randomUUID(), endpoint: pushSubscription.endpoint }),
  });
  if (unsubscribe.status !== 202) {
    throw new Error(`Expected unsubscribe 202, got ${unsubscribe.status} ${await unsubscribe.text()}`);
  }

  // The configured path, end to end through the built server. Every other push
  // assertion above runs with keys absent, so this is the only place a
  // successful subscription is admitted by dist-server rather than by a unit
  // test's in-process gateway.
  const configured = startGateway(port + 1, VAPID_ENV);
  await configured.ready;
  const configuredPairResponse = await fetch(`${configured.origin}/api/v1/auth/pair`, {
    method: "POST",
    headers: { Origin: configured.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: pairingToken }),
  });
  const configuredPair = await json(configuredPairResponse);
  const configuredCookie = configuredPairResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!configuredCookie) throw new Error("Push-enabled gateway did not issue a cookie");
  const configuredHeaders = {
    Origin: configured.origin,
    Cookie: configuredCookie,
    "Content-Type": "application/json",
    "X-CSRF-Token": configuredPair.csrfToken,
  };
  const configuredBootstrap = await json(await fetch(`${configured.origin}/api/v1/bootstrap`, {
    headers: { Origin: configured.origin, Cookie: configuredCookie },
  }));
  if (configuredBootstrap.push?.enabled !== true
    || configuredBootstrap.push.publicKey !== VAPID_ENV.PRIME_WEB_VAPID_PUBLIC_KEY) {
    throw new Error("Bootstrap must publish the application server key when push is configured");
  }
  const subscribe = await fetch(`${configured.origin}/api/v1/push/subscribe`, {
    method: "POST",
    headers: configuredHeaders,
    body: JSON.stringify({ requestId: crypto.randomUUID(), subscription: pushSubscription }),
  });
  if (subscribe.status !== 202) throw new Error(`Subscribe failed: ${subscribe.status} ${await subscribe.text()}`);
  const configuredUnsubscribe = await fetch(`${configured.origin}/api/v1/push/unsubscribe`, {
    method: "POST",
    headers: configuredHeaders,
    body: JSON.stringify({ requestId: crypto.randomUUID(), endpoint: pushSubscription.endpoint }),
  });
  if (configuredUnsubscribe.status !== 202) {
    throw new Error(`Configured unsubscribe failed: ${configuredUnsubscribe.status}`);
  }

  console.log("Gateway smoke test passed");
} finally {
  stop();
}
