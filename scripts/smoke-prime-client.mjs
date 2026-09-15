import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Exercises the installed package's real SDK and backend against a disposable daemon. */
export async function smokePrimeClient(packageRoot) {
  const root = await realpath(resolve(packageRoot));
  const { resolvePrimeModule } = await import(pathToFileURL(join(root, "dist-server/server/prime-module.js")));
  const { PrimeBackend } = await import(pathToFileURL(join(root, "dist-server/server/prime-backend.js")));
  const { EventHub } = await import(pathToFileURL(join(root, "dist-server/server/event-hub.js")));
  const sdk = await resolvePrimeModule({ env: {}, globalRoot: "/nonexistent/legacy-sdk" });
  assert.equal(sdk.origin, "bundled");
  assert.ok(sdk.specifier.startsWith(root));
  const directory = await mkdtemp(join(tmpdir(), "remote-sdk-"));
  const previousAgentDirectory = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = join(directory, "agent-state");
  const socketPath = join(directory, "daemon.sock");
  const sockets = new Set();
  const commands = [];
  let connections = 0;
  let recovering = true;
  const summary = { id: "active", activeSessionId: "active", sessionId: "saved", sessionName: "SDK fixture", isSessionActive: true, activity: "idle", cwd: directory };
  const snapshot = { summary, state: { sessionId: "saved", activeSessionId: "active", isStreaming: false, isCompacting: false, isBashRunning: false }, messages: [] };
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write(`${JSON.stringify({ type: "daemon_hello", socketPath, protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 28, serverCapabilities: ["attach_snapshot", "event_sequence"] })}\n`);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const envelope = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        assert.equal(envelope.protocol.version, 7);
        const command = envelope.command;
        commands.push(command);
        let response = { id: envelope.id, type: "response", command: command.type, success: true, data: {} };
        if (command.type === "list") response.data = { sessions: [summary] };
        else if (command.type === "attach") {
          if (recovering) response = { ...response, success: false, error: "Private session is recovering", errorInfo: { code: "session_recovering", activeSessionId: "active" } };
          else response.data = { activeSessionId: "active", snapshot };
        } else if (command.type === "get_connection_state") response.data = snapshot.state;
        else if (command.type === "get_messages") response.data = { messages: snapshot.messages };
        else if (command.type === "get_session_context") response.data = { context: {} };
        else if (command.type !== "detach" && command.type !== "ack_result") response = { ...response, success: false, error: "Unsupported fixture command" };
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
  const backend = new PrimeBackend(undefined, socketPath);
  try {
    server.listen(socketPath);
    await once(server, "listening");
    const hub = new EventHub();
    await backend.initialize(hub);
    const id = backend.catalog().agents[0]?.id;
    assert.ok(id);
    await assert.rejects(backend.agentSnapshot(id), (error) => error.code === "session_recovering" && !error.message.includes("Private"));
    recovering = false;
    assert.equal((await backend.agentSnapshot(id)).agentId, id);
    assert.equal(backend.describe().primeVersion, "0.9.4+878410b");
    assert.equal(backend.describe().primeModule, "bundled");
    assert.ok(hub.has(`agent:${id}`));
    const frames = [];
    const attached = hub.attach(`agent:${id}`, null, (frame) => frames.push(frame));
    const message = { role: "assistant", content: [{ type: "text", text: "Fixture streaming reply" }], timestamp: 1 };
    for (const socket of sockets) socket.write(`${JSON.stringify({ type: "session_event", activeSessionId: "active", event: { type: "message_update", message } })}\n`);
    const streamingDeadline = Date.now() + 2_000;
    while (!frames.some((frame) => frame.type === "event") && Date.now() < streamingDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.ok((await backend.agentSnapshot(id)).messages.some((row) => row.text === "Fixture streaming reply"));
    assert.ok(attached);
    attached.detach();
    // The existing backend owns reconnection; the packaged SDK must preserve it.
    for (const socket of sockets) socket.destroy();
    const deadline = Date.now() + 8_000;
    while ((connections < 2 || !backend.describe().connected) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.ok(connections >= 2, "Backend did not reconnect");
    assert.equal((await backend.agentSnapshot(id)).agentId, id);
    assert.ok(commands.filter((command) => command.type === "attach").length >= 3);
    assert.ok(commands.every((command) => !["prompt", "create", "kill"].includes(command.type)));
    console.log("Packaged bundled SDK: list, recovery, snapshot, streaming and reconnect passed");
  } finally {
    await backend.close();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
    if (previousAgentDirectory === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
    else process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDirectory;
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await smokePrimeClient(process.argv[2] ?? ".");
}
