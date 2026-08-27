# Prime Agent Remote

A remote interface for [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).
It keeps the daemon on your machine and puts a small authenticated gateway in
front of it, so another device can drive an agent without exposing a terminal.

Built phone-first — installable as a home-screen app, with a swipe-open session
drawer — and it adapts to a desktop browser, where that drawer becomes a
permanent sidebar.

It is an independent client. This project is not affiliated with, endorsed by,
or sponsored by Prime Intellect.

## Install and start

Prime Agent itself must be installed first — it is not on npm, so use its own
installer:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

Then:

```bash
npm install -g @albrorithm/prime-agent-remote
prime-agent-remote install-command
```

The published package ships `dist/` and `dist-server/` already built, so nothing
compiles at install time and npm's install-scripts gate has nothing to skip.
`install-command` adds `/webui` to Prime Agent, which is where most people will
start this from — a separate step because writing into another tool's
configuration is not something an install should do behind your back.

Then, from a Prime Agent session:

```
/webui start
```

or from a terminal, `prime-agent-remote start`. Either way the launcher finds
your Prime Agent build, notices whether Tailscale is running, mints a setup
token the first time and reuses it afterwards, and prints the address to open
along with the token.

### From a checkout

For development, or to run your own edits:

```bash
git clone https://github.com/albrorithm/prime-agent-remote.git
cd prime-agent-remote
npm install
npm link
prime-agent-remote install-command
```

`npm install` builds both halves on its way through — the `prepare` script runs
the build — so there is no separate build step to remember. `npm link` puts the
CLI on PATH, which `/webui` needs because it shells out to the command by name.

If you would rather not link anything globally, `./dist-server/cli/index.js
start` runs the same launcher straight out of the checkout. `/webui` will not be
available.

Installing straight from GitHub — `npm install -g
git+https://github.com/albrorithm/prime-agent-remote.git` — also works, with one
catch: npm 11 gates a git dependency's `prepare` script behind explicit approval
and skips it silently otherwise, which leaves the CLI unbuilt with no error. If
`prime-agent-remote help` comes back empty right after installing that way, that
is why; approve the script and reinstall. `install-command` checks for this and
says so rather than reporting a `/webui` that cannot run. None of this applies to
the published package above, which needs no build step at all.

```
prime-agent-remote start      Start it in the background
prime-agent-remote status     Where is it, and is it up
prime-agent-remote stop       Stop it
prime-agent-remote token      Print the setup token (--rotate to replace it)
prime-agent-remote devices    List paired devices (--revoke <id|all> to cut one off)
prime-agent-remote rebuild    Rebuild the UI and make it live
prime-agent-remote install-command   Add /webui to Prime Agent
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

`/webui` is installed by `prime-agent-remote install-command` (see above). It
copies `extensions/webui.ts` into `~/.prime/agent/extensions/`, so the command
exists in every session rather than only inside this checkout — and being a
copy, it needs re-running after that file changes.

```
/webui [status|start|stop|token|help]
```

It reports where the interface is served and starts it if it is not running.
It is a thin wrapper over the same CLI, and it never parents the gateway to a
session.

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

`prime-agent-remote start --demo` runs against a safe fake backend that never
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

The butterfly mark used as the app icon comes from the Prime Agent repository
and is used under its MIT license — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). That license covers the
artwork, not the Prime Agent name or mark as a trademark; no rights in either
are claimed here.
