# Prime Agent Mobile Web

A mobile-first, first-party web interface for Prime Agent. It keeps the daemon on the host and exposes a small authenticated gateway over HTTPS/WSS.

## What works

- Recursive root-agent and subagent tree.
- Mobile `Agents`, `Current`, and `Activity` views.
- Wide three-panel layout.
- Transcript streaming with stop and send controls.
- Approval and question cards.
- Authenticated HTTP mutations and WebSocket events.
- Per-stream sequence cursors, replay, and snapshot fallback.
- Safe demo backend for UI review.
- Live Prime Agent adapter through `DaemonClient` and `DaemonAgentConnection`.
- Installable manifest and shell-only service worker.

The browser never connects to the daemon socket directly. Terminal and arbitrary file access are intentionally not exposed.

## Requirements

- Node.js 22 or newer.
- A current Prime Agent build for live mode.
- Tailscale is recommended for remote access.

## Start in demo mode

```bash
npm install
npm run dev
```

The gateway prints a generated pairing token. Open `http://127.0.0.1:5173` and enter it on the pairing screen.

For a stable token:

```bash
PRIME_WEB_PAIRING_TOKEN='replace-with-a-long-random-token' npm run dev
```

## Production build

```bash
npm run build
PRIME_WEB_PAIRING_TOKEN='replace-with-a-long-random-token' \
PRIME_WEB_ALLOWED_ORIGINS='http://127.0.0.1:8787' \
PRIME_WEB_SECURE_COOKIE=false \
npm start
```

The gateway binds to `127.0.0.1:8787` by default.

## Live Prime Agent mode

The audited daemon APIs are available from the root export of a compatible `@earendil-works/pi-coding-agent` build. Point the gateway to that built module when it is not installed as this application's dependency:

```bash
PRIME_WEB_BACKEND=prime \
PRIME_AGENT_MODULE='/path/to/prime-agent/packages/coding-agent/dist/index.js' \
PRIME_WEB_PAIRING_TOKEN='replace-with-a-long-random-token' \
PRIME_WEB_ALLOWED_ORIGINS='http://127.0.0.1:8787' \
npm start
```

Optional:

```bash
PRIME_AGENT_DAEMON_SOCKET='/custom/daemon.sock'
```

The compatible module must export:

- `DaemonClient`
- `DaemonAgentConnection`
- `defaultDaemonSocketPath`

The current public npm registry line uses a different package API. The gateway therefore checks these exports at startup instead of silently using an incompatible client.

## Tailscale Serve

Keep the application bound to loopback and let Tailscale terminate HTTPS:

```bash
PRIME_WEB_SECURE_COOKIE=true \
PRIME_WEB_ALLOWED_ORIGINS='https://your-tailnet-host.example.ts.net' \
PRIME_WEB_PAIRING_TOKEN='replace-with-a-long-random-token' \
npm start

tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

Use the exact HTTPS origin reported by Tailscale in `PRIME_WEB_ALLOWED_ORIGINS`. Do not bind the gateway to all interfaces unless there is a separate, reviewed firewall and reverse proxy.

## Commands

```bash
npm run typecheck  # browser and server TypeScript
npm test           # protocol reducer, replay, and agent-tree tests
npm run build      # production web and server output
npm run smoke      # build plus authenticated HTTP/WebSocket smoke test
```

## Layout

```text
src/protocol.ts               Public browser DTOs and runtime request validation
src/server/backend.ts         Backend boundary
src/server/demo-backend.ts    Deterministic interactive demo
src/server/prime-backend.ts   Prime daemon adapter
src/server/event-hub.ts       Snapshot/replay streams
src/server/auth.ts            Pairing, sessions, and CSRF
src/server/index.ts           HTTP, WebSocket, and static gateway
src/web/                      React mobile PWA
```

See `docs/protocol.md`, `docs/security.md`, and `docs/deployment.md` for the public contract and deployment boundaries.
