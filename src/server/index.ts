import { createServer } from "node:http";
import type { AgentBackend } from "./backend.js";
import { loadConfig } from "./config.js";
import { DemoBackend } from "./demo-backend.js";
import { createGateway } from "./gateway.js";
import { loadOrCreatePairingToken } from "./pairing-token.js";
import { PrimeBackend } from "./prime-backend.js";
import { loadOrCreateVapidKeys } from "./vapid-keys.js";
import { buildPairingUrl } from "../protocol.js";

const loaded = loadConfig();
// Resolved here rather than in loadConfig, which stays free of file I/O so the
// suite cannot write to an operator's real configuration directory.
const config = {
  ...loaded,
  ...(loaded.generatedPairingToken
    ? { pairingToken: await loadOrCreatePairingToken(loaded.pairingTokenPath) }
    : {}),
  // Push is on by default now. It used to require three environment variables
  // that nothing in the project could produce, so it was off for every install
  // that did not already know what VAPID is.
  ...(loaded.generatedWebPush
    ? { webPush: await loadOrCreateVapidKeys(loaded.vapidKeysPath, loaded.webPushSubject) }
    : {}),
};
const backend: AgentBackend = config.backend === "prime"
  ? new PrimeBackend(config.primeModule, config.daemonSocket)
  : new DemoBackend();
const gateway = await createGateway(config, { backend });

const server = createServer(gateway.requestListener);
server.on("upgrade", gateway.upgradeListener);

/**
 * Without this a failed bind is an unhandled 'error' event, which takes the
 * process down with a stack trace and nothing else. `prime-agent-web start`
 * detaches this child with its stdio ignored, so the only symptom anyone sees
 * is a gateway that is simply not there — no message, no exit code, nothing to
 * search for. Say what went wrong and which setting changes it.
 */
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use on ${config.host}.`);
    console.error("Another gateway is probably still running. Stop it first, or set PRIME_WEB_PORT to a free port.");
  } else if (error.code === "EACCES") {
    console.error(`Not permitted to bind ${config.host}:${config.port}.`);
    console.error("Ports below 1024 need elevated privileges; set PRIME_WEB_PORT to a higher one.");
  } else {
    console.error(`Could not start the gateway on ${config.host}:${config.port}: ${error.message}`);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`Prime Agent Web gateway listening on http://${config.host}:${config.port}`);
  console.log(`Backend: ${backend.kind}`);
  // A directly-run gateway prints one pairing link at boot. The setup token
  // itself is never printed: it mints links, it is not one, and it lives in
  // the token file for the CLI or an operator's curl to read.
  const grant = gateway.auth.grants.mint();
  // The allowlist can carry a dev server's origin as well as this gateway's;
  // the link should be one this gateway serves, so its own port wins.
  const origins = [...config.allowedOrigins];
  const origin = origins.find((candidate) => new URL(candidate).port === String(config.port)) ?? origins[0];
  if (origin) console.log(`Pairing link, good for ten minutes: ${buildPairingUrl(origin, grant.token)}`);
  console.log(`New links: POST /api/v1/auth/grants with the setup token at ${config.pairingTokenPath} as a bearer.`);
});

/**
 * `server.close()` stops accepting and then waits for every open connection to
 * end on its own. An idle keep-alive HTTP connection will wait indefinitely,
 * and `gateway.shutdown()` only *initiates* the WebSocket close handshake — a
 * phone that is asleep or already gone never answers it. So the port stayed
 * bound for the full five seconds after a stop, which is long enough for a
 * stop-then-start to fail EADDRINUSE on the port it had just released.
 *
 * Idle connections go immediately, live ones get a second to finish closing
 * politely, and anything still holding on after that is evicted.
 */
async function shutdown(): Promise<void> {
  await gateway.shutdown();
  server.closeIdleConnections();
  server.close(() => process.exit(0));
  setTimeout(() => server.closeAllConnections(), 1_000).unref();
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
