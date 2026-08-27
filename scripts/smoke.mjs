import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { WebSocket } from "ws";

// The built artifact, so the isolation list below cannot drift from the real one.
import { CONFIG_FILE_VARIABLES } from "../dist-server/server/config.js";

const port = 18787;
const origin = `http://127.0.0.1:${port}`;
const pairingToken = "smoke-test-token";
// A real generated pair, used only for its shape: nothing here reaches a push
// service. The default deployment mints its own; these are the explicit
// PRIME_WEB_VAPID_* keys an operator can still supply to override that.
const VAPID_ENV = {
  PRIME_WEB_VAPID_PUBLIC_KEY: "BF1JW243veaons7uO0bcdtRHXVUTVJ74A_OzX7wiGhY114OpWvn0BOBrfXu2AhV3cmc0Nrb_LIRZHbFY4L8Xmgw",
  PRIME_WEB_VAPID_PRIVATE_KEY: "IPDx2j8nr-ShPjNWSqXsCAK3fA0W2cM78tjLvtG0jLA",
  PRIME_WEB_VAPID_SUBJECT: "mailto:operator@example.test",
};

/* One throw-away directory for every file the gateway persists.

   Derived from CONFIG_FILE_VARIABLES, not listed here. This was a hand-kept
   list with a comment asking the next person to extend it, and the next person
   did not, twice. First the device store was missing, so every smoke run
   paired its test devices into the operator's real devices.json — which keeps
   32 entries and evicts the oldest, so an afternoon of smoke runs pushed the
   operator's actual phone out of it. Then `fa3d77d` taught the gateway to mint
   its own VAPID keypair, and PRIME_WEB_VAPID_KEY_FILE was missing too: a smoke
   run on a machine with no keys yet writes them into the real config, and one
   that replaced an existing pair would silently kill every push subscription
   bound to it.

   Whatever configFilePath() learns about next is isolated the moment it is
   added there, without anyone remembering to come back here. */
const smokeConfigDir = mkdtempSync(join(tmpdir(), "prime-smoke-config-"));
const ISOLATED_STORES = Object.fromEntries(
  Object.values(CONFIG_FILE_VARIABLES).map((variable) => [variable, join(smokeConfigDir, variable)]),
);

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
      // Never the operator's real stores.
      ...ISOLATED_STORES,
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

/* Runs a command to completion and hands back everything it produced.

   Used for the installed-CLI check below, which is about what a program does
   when a shell runs it — so it has to be a real child process with a real exit
   code, not an imported function. The isolated stores go into its environment
   for the same reason the gateway gets them: nothing here may touch the
   operator's real ~/.config/prime-agent-web/. */
function runCommand(command, args, timeoutMs = 20_000) {
  return new Promise((settle, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...ISOLATED_STORES },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timeout); settle({ code, signal, stdout, stderr }); });
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The default deployment: no VAPID keys supplied, so the gateway mints its
// own. Everything below has to work in it.
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

  // Rename: the happy path, a malformed name, and a session the user never
  // opened — the drawer can reach all three.
  const renameTarget = bootstrap.catalog.agents.find((agent) => agent.capabilities.rename)?.id;
  if (!renameTarget) throw new Error("No renameable demo agent found");
  const renameSnapshot = await json(await fetch(`${origin}/api/v1/agents/${encodeURIComponent(renameTarget)}/snapshot`, {
    headers: { Origin: origin, Cookie: cookie },
  }));
  const renamePath = `${origin}/api/v1/agents/${encodeURIComponent(renameTarget)}/rename`;
  const renamed = await fetch(renamePath, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedRevision: renameSnapshot.revision,
      name: "Renamed by the smoke test",
    }),
  });
  if (renamed.status !== 202) throw new Error(`Rename failed: ${renamed.status} ${await renamed.text()}`);
  const renamedBootstrap = await json(await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin, Cookie: cookie } }));
  if (renamedBootstrap.catalog.agents.find((agent) => agent.id === renameTarget)?.name !== "Renamed by the smoke test") {
    throw new Error("Rename did not reach the catalog");
  }
  const renameWithoutCsrf = await fetch(renamePath, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: 1, name: "No CSRF" }),
  });
  if (renameWithoutCsrf.status !== 403) throw new Error(`Expected rename CSRF rejection, got ${renameWithoutCsrf.status}`);
  for (const name of ["", "   ", "two\nlines", "x".repeat(201)]) {
    const rejected = await fetch(renamePath, {
      method: "POST",
      headers: commandHeaders,
      body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: 1, name }),
    });
    if (rejected.status !== 400) {
      throw new Error(`Expected rename schema rejection for ${JSON.stringify(name)}, got ${rejected.status}`);
    }
  }

  // Stop: ends one live session and leaves it resumable, and is refused for a
  // session that has none. Both directions of the capability bit.
  const stopTarget = renamedBootstrap.catalog.agents.find((agent) => agent.capabilities.stop)?.id;
  if (!stopTarget) throw new Error("No stoppable demo agent found");
  const stopSnapshot = await json(await fetch(`${origin}/api/v1/agents/${encodeURIComponent(stopTarget)}/snapshot`, {
    headers: { Origin: origin, Cookie: cookie },
  }));
  const stopped = await fetch(`${origin}/api/v1/agents/${encodeURIComponent(stopTarget)}/stop`, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: stopSnapshot.revision }),
  });
  if (stopped.status !== 202) throw new Error(`Stop failed: ${stopped.status} ${await stopped.text()}`);
  const stoppedBootstrap = await json(await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin, Cookie: cookie } }));
  const stoppedAgent = stoppedBootstrap.catalog.agents.find((agent) => agent.id === stopTarget);
  if (stoppedAgent?.lifecycle !== "inactive" || !stoppedAgent.capabilities.resume || stoppedAgent.capabilities.stop) {
    throw new Error("Stopped demo agent did not become inactive and resumable");
  }
  // The same agent is now the refusal case: it has no live session left, and
  // the route must say so rather than accept a second stop.
  const stoppedSnapshot = await json(await fetch(`${origin}/api/v1/agents/${encodeURIComponent(stopTarget)}/snapshot`, {
    headers: { Origin: origin, Cookie: cookie },
  }));
  const stopRefused = await fetch(`${origin}/api/v1/agents/${encodeURIComponent(stopTarget)}/stop`, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: stoppedSnapshot.revision }),
  });
  if (stopRefused.status !== 403) throw new Error(`Expected stop capability refusal, got ${stopRefused.status}`);
  const stopWithoutCsrf = await fetch(`${origin}/api/v1/agents/${encodeURIComponent(stopTarget)}/stop`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: 1 }),
  });
  if (stopWithoutCsrf.status !== 403) throw new Error(`Expected stop CSRF rejection, got ${stopWithoutCsrf.status}`);

  // Delete: irreversible, so both refusal paths are checked before the one
  // that actually destroys something.
  const deleteTarget = stoppedBootstrap.catalog.agents.find((agent) => agent.capabilities.delete);
  const undeletableId = stoppedBootstrap.catalog.agents.find((agent) => !agent.capabilities.delete)?.id;
  if (!deleteTarget || !undeletableId) throw new Error("Demo catalog has no deletable and live pair");
  const deletePath = `${origin}/api/v1/agents/${encodeURIComponent(deleteTarget.id)}/delete`;
  const deleteRevision = async (id) => (await json(await fetch(
    `${origin}/api/v1/agents/${encodeURIComponent(id)}/snapshot`,
    { headers: { Origin: origin, Cookie: cookie } },
  ))).revision;

  const liveDelete = await fetch(`${origin}/api/v1/agents/${encodeURIComponent(undeletableId)}/delete`, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedRevision: await deleteRevision(undeletableId),
      confirmName: stoppedBootstrap.catalog.agents.find((agent) => agent.id === undeletableId).name,
    }),
  });
  if (liveDelete.status !== 403) throw new Error(`Expected live-session delete refusal, got ${liveDelete.status}`);

  const wrongName = await fetch(deletePath, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedRevision: await deleteRevision(deleteTarget.id),
      confirmName: "Not this session",
    }),
  });
  if (wrongName.status !== 403) throw new Error(`Expected mismatched-name delete refusal, got ${wrongName.status}`);

  // The confirmation is enforced by the gateway, so it cannot be skipped.
  const noConfirmation = await fetch(deletePath, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: 1 }),
  });
  if (noConfirmation.status !== 400) throw new Error(`Expected unconfirmed delete rejection, got ${noConfirmation.status}`);

  const deleteWithoutCsrf = await fetch(deletePath, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: 1, confirmName: deleteTarget.name }),
  });
  if (deleteWithoutCsrf.status !== 403) throw new Error(`Expected delete CSRF rejection, got ${deleteWithoutCsrf.status}`);

  const deleted = await fetch(deletePath, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedRevision: await deleteRevision(deleteTarget.id),
      confirmName: deleteTarget.name,
    }),
  });
  if (deleted.status !== 202) throw new Error(`Delete failed: ${deleted.status} ${await deleted.text()}`);
  const deletedBootstrap = await json(await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin, Cookie: cookie } }));
  if (deletedBootstrap.catalog.agents.some((agent) => agent.id === deleteTarget.id)) {
    throw new Error("Deleted demo agent is still in the catalog");
  }
  const deletedSnapshot = await fetch(`${origin}/api/v1/agents/${encodeURIComponent(deleteTarget.id)}/snapshot`, {
    headers: { Origin: origin, Cookie: cookie },
  });
  if (deletedSnapshot.status !== 404) throw new Error(`Expected deleted snapshot 404, got ${deletedSnapshot.status}`);

  const pushSubscription = {
    endpoint: "https://push.example.invalid/smoke-endpoint",
    keys: { p256dh: "BJrkVFj8uQz9pOn8Bj7cKAsZnhgsB6EuzJyY0oH4zjxU", auth: "3v0fHqQhH3xQ1r6mB3dOsg" },
  };
  /* Push configures itself. Supplying no VAPID keys used to mean push was off,
     and this file asserted that; `fa3d77d` made the gateway mint its own pair
     on first start instead, so "off" is no longer a state a shipped gateway
     can be in and the assertion had been failing ever since. The 503 branch is
     still live code — a gateway can be constructed without keys — and
     gateway.test.ts covers it in process. What cannot be reached through
     dist-server should not be asserted through dist-server. */
  const bootstrapPush = resumedBootstrap.push;
  if (bootstrapPush?.enabled !== true || typeof bootstrapPush.publicKey !== "string" || !bootstrapPush.publicKey) {
    throw new Error("Bootstrap must report push on, with the key the gateway minted for itself");
  }
  if (bootstrapPush.publicKey === VAPID_ENV.PRIME_WEB_VAPID_PUBLIC_KEY) {
    throw new Error("The default gateway published the supplied test key, so it minted nothing of its own");
  }
  /* The pair has to reach disk. A gateway that minted a fresh one on every
     start would hand out a new application server key each time, and every
     subscription taken against the last one stops being decryptable — push
     that works until the first restart. */
  const mintedKeys = JSON.parse(await readFile(ISOLATED_STORES.PRIME_WEB_VAPID_KEY_FILE, "utf8"));
  if (mintedKeys.publicKey !== bootstrapPush.publicKey) {
    throw new Error("The minted VAPID public key was not the one persisted to the key file");
  }
  // Subscribing against self-minted keys is the default path now — what every
  // install does — not the configured-only one it used to be.
  const subscribeDefault = await fetch(`${origin}/api/v1/push/subscribe`, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({ requestId: crypto.randomUUID(), subscription: pushSubscription }),
  });
  if (subscribeDefault.status !== 202) {
    throw new Error(`Expected self-configured push subscribe 202, got ${subscribeDefault.status} ${await subscribeDefault.text()}`);
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
  // Unsubscribe stays open even when push is not configured: a device must
  // always be able to stop, including from a gateway whose keys were removed
  // under it.
  const unsubscribe = await fetch(`${origin}/api/v1/push/unsubscribe`, {
    method: "POST",
    headers: commandHeaders,
    body: JSON.stringify({ requestId: crypto.randomUUID(), endpoint: pushSubscription.endpoint }),
  });
  if (unsubscribe.status !== 202) {
    throw new Error(`Expected unsubscribe 202, got ${unsubscribe.status} ${await unsubscribe.text()}`);
  }

  // Explicitly supplied keys still win over the pair the gateway would mint,
  // which is what an operator reusing one identity across two installs depends
  // on. Everything above ran on self-minted keys, so this is the only place
  // dist-server is shown honouring PRIME_WEB_VAPID_*.
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

  /* The CLI as npm actually installs it.

     `npm install -g` does not copy the bin entry; it links it. process.argv[1]
     is then the link in the global bin directory while import.meta.url is the
     resolved module URL inside the package, so an entry guard that compares
     the two plainly is false for every real installation. The CLI shipped that
     way: under its own name every subcommand printed nothing and exited 0,
     while `node dist-server/cli/index.js` — the only form the tests ever used —
     worked perfectly. Importing a function cannot see that. Only running the
     linked binary can.

     Read-only subcommands only: `help` and `status` inspect and print, and
     neither starts, stops, nor writes. `token` is excluded on purpose, because
     its entire output is a secret. */
  const manifest = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8"));
  const binName = Object.keys(manifest.bin ?? {})[0];
  if (!binName) throw new Error("package.json declares no bin entry to install");
  const binEntry = resolve(process.cwd(), manifest.bin[binName]);
  const installedBin = join(mkdtempSync(join(tmpdir(), "prime-smoke-bin-")), binName);
  symlinkSync(binEntry, installedBin);

  // Executing the link, not `node <link>`, so the shipped shebang and the
  // executable bit the build sets are part of what is being checked.
  const cliHelp = await runCommand(installedBin, ["help"]);
  if (cliHelp.code !== 0) {
    throw new Error(`Installed CLI \`help\` exited ${cliHelp.code} (signal ${cliHelp.signal}): ${cliHelp.stderr}`);
  }
  if (!cliHelp.stdout.includes("Usage:") || !cliHelp.stdout.includes(`${binName} start`)) {
    throw new Error(`Installed CLI \`help\` printed no usage. stdout=${JSON.stringify(cliHelp.stdout)} stderr=${JSON.stringify(cliHelp.stderr)}`);
  }

  // `status` goes further than `help`: it loads the config and reads the
  // gateway state file, which the isolated stores point at an empty temp
  // directory — so the answer is always "not running", and the documented exit
  // code for that is 1. A guard that never fires would give an empty stdout
  // and 0 here, which is exactly the shipped bug.
  const cliStatus = await runCommand(installedBin, ["status"]);
  if (!cliStatus.stdout.includes("Not running.")) {
    throw new Error(`Installed CLI \`status\` printed nothing usable. stdout=${JSON.stringify(cliStatus.stdout)} stderr=${JSON.stringify(cliStatus.stderr)}`);
  }
  if (cliStatus.code !== 1) {
    throw new Error(`Expected installed CLI \`status\` to exit 1 with no gateway running, got ${cliStatus.code}`);
  }

  /* What the gateway serves is what the build produced.

     A web change is not done when `dist/` changes; it is done when the bytes
     on the phone change. Nothing else in this repo compares the two, and a
     change reported as live while an old bundle was still being served is a
     failure no unit test can see. So: take the hashed assets index.html points
     at, ask the running gateway for them over HTTP, and hash both sides. */
  const distRoot = resolve(process.cwd(), "dist");
  const indexBytes = await readFile(join(distRoot, "index.html"));
  const references = [...indexBytes.toString("utf8").matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)]
    .map((match) => match[1]);
  if (references.length === 0) throw new Error("dist/index.html references no hashed assets; the build is not what it was");

  for (const [requestPath, expected] of [["/", indexBytes], ...references.map((reference) => [reference, null])]) {
    const onDisk = expected ?? await readFile(join(distRoot, requestPath.slice(1)));
    const response = await fetch(`${origin}${requestPath}`, { headers: { Origin: origin } });
    if (response.status !== 200) throw new Error(`Gateway did not serve ${requestPath}: ${response.status}`);
    const servedBytes = Buffer.from(await response.arrayBuffer());
    const servedHash = sha256(servedBytes);
    const diskHash = sha256(onDisk);
    if (servedHash !== diskHash) {
      throw new Error(`Served bytes differ from the build for ${requestPath}: served sha256 ${servedHash} (${servedBytes.byteLength} bytes), on disk ${diskHash} (${onDisk.byteLength} bytes)`);
    }
  }

  console.log("Gateway smoke test passed");
} finally {
  stop();
}
