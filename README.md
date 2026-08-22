# Prime Agent Mobile Web

A mobile-first, first-party web interface for Prime Agent. It keeps the daemon on the host and exposes a small authenticated gateway over HTTPS/WSS.

## What works

- Recursive root-agent and subagent tree.
- Chat-centered mobile shell with a swipe-open session drawer and compact ancestry navigation.
- On-demand activity drawer and a wide three-panel layout.
- Transcript streaming, live goal progress, and mature stop/send composer controls.
- Markdown-lite transcript rendering with copyable code blocks, including while streaming.
- In-transcript search with match highlighting.
- Optimistic send bubbles that reconcile against the server echo.
- JPEG, PNG, and WebP attachments for image-capable models, with client-side resizing and authenticated transcript thumbnails.
- Quick replies and per-agent drafts that survive reloads.
- Catalog-driven slash commands with nine explicit adapters and clearly marked experimental execution for detected Prime commands.
- Approval and question cards.
- Authenticated HTTP mutations and WebSocket events.
- Starting new sessions: pick a working directory with the in-app browser and name the session.
- Waking an inactive saved session by sending its next message.
- Per-stream sequence cursors, replay, and snapshot fallback.
- Safe demo backend for UI review.
- Live Prime Agent adapter through `DaemonClient` and `DaemonAgentConnection`.
- Installable manifest and shell-only service worker.

The browser never connects to the daemon socket directly. Terminal access and arbitrary host file contents are intentionally not exposed. The browser sends only images that the user explicitly selects, captures, pastes, or drops into the composer. The remaining filesystem surface is a read-only directory-name browser used to choose a working directory for new sessions; it lists directory names, never file contents.

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
