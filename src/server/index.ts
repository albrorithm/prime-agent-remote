import { createServer } from "node:http";
import type { AgentBackend } from "./backend.js";
import { loadConfig } from "./config.js";
import { DemoBackend } from "./demo-backend.js";
import { createGateway } from "./gateway.js";
import { loadOrCreatePairingToken } from "./pairing-token.js";
import { PrimeBackend } from "./prime-backend.js";

const loaded = loadConfig();
// Resolved here rather than in loadConfig, which stays free of file I/O so the
// suite cannot write to an operator's real configuration directory.
const config = loaded.generatedPairingToken
  ? { ...loaded, pairingToken: await loadOrCreatePairingToken(loaded.pairingTokenPath) }
  : loaded;
const backend: AgentBackend = config.backend === "prime"
  ? new PrimeBackend(config.primeModule, config.daemonSocket)
  : new DemoBackend();
const gateway = await createGateway(config, { backend });

const server = createServer(gateway.requestListener);
server.on("upgrade", gateway.upgradeListener);
server.listen(config.port, config.host, () => {
  console.log(`Prime Agent Web gateway listening on http://${config.host}:${config.port}`);
  console.log(`Backend: ${backend.kind}`);
  if (config.generatedPairingToken) {
    console.log(`Setup pairing token: ${config.pairingToken}`);
    console.log(`  stored at ${config.pairingTokenPath}`);
  }
});

async function shutdown(): Promise<void> {
  await gateway.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
