# Prime Agent Mobile Web

A mobile-first web interface for [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).
It keeps the daemon on your machine and puts a small authenticated gateway in
front of it, so a phone can drive an agent without exposing a terminal.

## Install and start

Prime Agent itself must be installed (`npm install -g prime-agent`). Then:

```bash
npm install
npm run build
./dist-server/cli/index.js start
```

That is the whole setup for running it from this checkout. The launcher finds
your Prime Agent build, notices whether Tailscale is running, mints a setup
token the first time and reuses it afterwards, and prints the address to open
along with the token.

### Getting `prime-agent-mobile` onto PATH

Typing the full path to `dist-server/cli/index.js` is not required. `/webui`
(see below) shells out to a bare `prime-agent-mobile`, and if that is not
found on PATH it says so and points back here. Two ways to get it there, both
of which build the package for you via its `prepare` script — no separate
`npm run build`:

- **From this checkout**, so the command tracks your edits:
  ```bash
  npm install
  npm link
  ```
- **As a standalone install**, once this package is published to npm:
  ```bash
  npm install -g prime-agent-mobile
  ```
  Until then, install straight from GitHub:
  ```bash
  npm install -g git+https://github.com/albrorithm/prime-agent-mobile.git
  ```
  npm 11 and newer gate a git dependency's `prepare` script behind explicit
  approval (`npm help install-scripts`) and silently skip it otherwise,
  which leaves the CLI unbuilt with no error. If `prime-agent-mobile help`
  comes back empty right after installing this way, that is why — approve
  the script (npm will tell you the exact command; it names this package)
  and reinstall. If that does not take, the checkout path above always
  works and is the more reliable option until this is published.

  This does not affect `npm install -g prime-agent-mobile` once published —
  the registry tarball ships `dist/` and `dist-server/` already built, so
  nothing needs to run at install time.

```
prime-agent-mobile start      Start it in the background
prime-agent-mobile status     Where is it, and is it up
prime-agent-mobile stop       Stop it
prime-agent-mobile token      Print the setup token (--rotate to replace it)
prime-agent-mobile devices    List paired devices (--revoke <id|all> to cut one off)
prime-agent-mobile rebuild    Rebuild the UI and make it live
prime-agent-mobile install-command   Add /webui to Prime Agent
```

### How it is reachable

One choice, made once, with different consequences:

- `--tailscale` — the default when Tailscale is running. The gateway stays on
  loopback and Tailscale terminates HTTPS. Reachable from your phone anywhere,
  and a secure context, without installing a certificate. Publish it once with
  `tailscale serve --bg http://127.0.0.1:8787`.
- `--loopback` — this machine only. A phone cannot reach it.
- `--lan` — **experimental**. Binds every interface, so every device on your
  network can reach it and the setup token is what stops them. Without a
  certificate the device already trusts, plain HTTP outside `localhost` is not
  a secure context: no installable app, no service worker, no notifications and
  no app badge. It also means every credential that authenticates a request —
  the setup token, a paired session's cookie, and the 400-day device
  credential — crosses the network in the clear, so a bystander who can
  observe LAN traffic can copy any of them off the wire.

## Pairing

Open the address on your phone and enter the setup token once. The browser is
issued a device credential of its own, so it stays paired across gateway
restarts and never needs the token again. Signing out revokes that device,
clears both cookies, and ends every other session running from that device
too, sockets included. Letting a session lapse deliberately revokes nothing,
which is what lets a phone survive a restart.

Only a hash of the credential is stored, so the file on disk does not let
anyone become a paired device.

## From inside Prime Agent

```bash
prime-agent-mobile install-command
```

`/webui` then reports where the interface is served and starts it if it is not
running. It is a thin wrapper over the same CLI, and it never parents the
gateway to a session.

## What it does

- Recursive root-agent and subagent tree.
- Chat-centred mobile shell with a swipe-open session drawer and compact
  ancestry navigation.
- Transcript streaming, live goal progress, and stop/send composer controls.
- Markdown-lite rendering with copyable code blocks, including while streaming.
- In-transcript search, quick replies, and per-agent drafts that survive reloads.
- Image attachments for image-capable models, resized client-side.
- Catalog-driven slash commands, with clearly marked experimental execution.
- Dialog and question attention cards.
- Starting, renaming, stopping and deleting sessions from the phone.
- Optional web push, off until you configure it.
- Installable as a home-screen app.

The browser never reaches the daemon socket directly. There is no terminal, no
arbitrary shell, and no arbitrary file reading. The only filesystem surface is a
read-only directory-name browser for choosing a working directory.
[`docs/security.md`](docs/security.md) states the boundary in full.

## Demo mode

`prime-agent-mobile start --demo` runs against a safe fake backend that never
touches a real agent. Useful for looking at the interface.

It also keeps its own pairing token, paired devices, and gateway state in a
separate `prime-agent-web-demo` config directory, so a demo run never shares
credentials with a real one or evicts a real device from the paired-device
store. Pass `--demo` to `status`, `stop`, and `rebuild` too when you mean the
demo instance — without it they look at your real one.

## Documentation

- [Security model](docs/security.md) — the trust boundary, stated deliberately.
- [Deployment](docs/deployment.md) — environment variables and production notes.
- [Changing the web UI](docs/modifying-the-ui.md) — for agents and quick edits.
- [Protocol](docs/protocol.md) — the wire contract.
- [Contributing](CONTRIBUTING.md)

## Requirements

- Node.js 22 or newer.
- Prime Agent installed and its daemon reachable.
- Tailscale recommended for access from outside your machine.

## License

MIT. See [LICENSE](LICENSE).
