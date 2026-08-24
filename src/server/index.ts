import { createServer } from "node:http";
import type { AgentBackend } from "./backend.js";
import { loadConfig } from "./config.js";
import { DemoBackend } from "./demo-backend.js";
import { createGateway } from "./gateway.js";
import { PrimeBackend } from "./prime-backend.js";

const config = loadConfig();
const backend: AgentBackend = config.backend === "prime"
  ? new PrimeBackend(config.primeModule, config.daemonSocket)
  : new DemoBackend();
const gateway = await createGateway(config, { backend });

const server = createServer(gateway.requestListener);
server.on("upgrade", gateway.upgradeListener);
server.listen(config.port, config.host, () => {
  console.log(`Prime Agent Web gateway listening on http://${config.host}:${config.port}`);
  console.log(`Backend: ${backend.kind}`);
  if (config.generatedPairingToken) console.log(`Setup pairing token: ${config.pairingToken}`);
});

async function shutdown(): Promise<void> {
  await gateway.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
