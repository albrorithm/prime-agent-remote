import { spawn } from "node:child_process";
import process from "node:process";
import { WebSocket } from "ws";

const port = 18787;
const origin = `http://127.0.0.1:${port}`;
const pairingToken = "smoke-test-token";
const child = spawn(process.execPath, ["dist-server/server/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    PRIME_WEB_PORT: String(port),
    PRIME_WEB_HOST: "127.0.0.1",
    PRIME_WEB_ALLOWED_ORIGINS: origin,
    PRIME_WEB_PAIRING_TOKEN: pairingToken,
    PRIME_WEB_BACKEND: "demo",
    PRIME_WEB_SECURE_COOKIE: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });

function stop() {
  if (!child.killed) child.kill("SIGTERM");
}

async function waitForServer() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Gateway did not start. ${stderr}`)), 8_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Gateway exited early with ${code}. ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("gateway listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

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
  await waitForServer();

  const unauthenticated = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin } });
  if (unauthenticated.status !== 401) throw new Error(`Expected unauthenticated 401, got ${unauthenticated.status}`);

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

  const snapshot = await json(await fetch(`${origin}/api/v1/agents/${encodeURIComponent(agentId)}/snapshot`, {
    headers: { Origin: origin, Cookie: cookie },
  }));
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

  console.log("Gateway smoke test passed");
} finally {
  stop();
}
