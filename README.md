# Prime Agent Remote

A remote interface for [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).
The daemon stays on your machine; a small authenticated gateway sits in front
of it, so another device can drive an agent without exposing a terminal.

It is built for phones: it installs to the home screen and opens its session
drawer with a swipe. Desktop browsers are supported (the drawer becomes a
permanent sidebar), but desktop is not what this is designed for or regularly
tested against.

It is an independent client. This project is not affiliated with, endorsed by,
or sponsored by Prime Intellect.

## Install and start

Install Prime Agent first. It is not on npm, so use its own installer:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

Then:

```bash
npm install -g @albrorithm/prime-agent-remote
prime-agent-remote install-command
```

The published package ships `dist/` and `dist-server/` prebuilt, so nothing
compiles at install time and npm's install-scripts gate has nothing to skip.
`install-command` adds the `/webui` command to Prime Agent. It is a separate
step because it writes into Prime Agent's own configuration directory, which
an install should not do without asking.

Then, from a Prime Agent session:

```
/webui start
```

or from a terminal, `prime-agent-remote start`. Either way the launcher finds
your Prime Agent build, checks whether Tailscale is running, generates a setup
token on first run and reuses it afterwards, and prints the address to open
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

`npm install` builds both the UI and the server via the `prepare` script, so
there is no separate build step. `npm link` puts the CLI on PATH, which
`/webui` needs because it shells out to the command by name.

If you would rather not link anything globally, `./dist-server/cli/index.js
start` runs the same launcher straight out of the checkout, but `/webui` will
not be available.

Installing straight from GitHub also works, with one catch:

```bash
npm install -g git+https://github.com/albrorithm/prime-agent-remote.git
```

npm 11 only runs a git dependency's `prepare` script with explicit approval,
and skips it silently otherwise, which leaves the CLI unbuilt with no error.
If `prime-agent-remote help` prints nothing right after installing this way,
that is what happened: approve the script and reinstall. `install-command`
checks for this case and says so, rather than reporting a clean install of a
`/webui` that cannot run. None of this applies to the published package above, which needs
no build step.

```
prime-agent-remote start      Start it in the background
prime-agent-remote status     Show the address and whether it is running
prime-agent-remote stop       Stop it
prime-agent-remote token      Print the setup token (--qr for a pairing link, --rotate to replace it)
prime-agent-remote devices    List paired devices (--revoke <id|all> to remove one)
prime-agent-remote rebuild    Rebuild the UI and make it live (a checkout only; reinstall a published copy)
prime-agent-remote install-command   Add /webui to Prime Agent
```

### How it is reachable

The gateway binds one of three ways, chosen when you start it:

- `--tailscale`: the default when Tailscale is running. The gateway stays on
  loopback and Tailscale terminates HTTPS, so the app is reachable from your
  phone anywhere, in a secure context, without installing a certificate.
  `start` publishes the Tailscale Serve mapping itself and `stop` removes it
  again, but only the mapping it created: one that was already there, or one
  pointing somewhere else, is left alone and the command to publish it by hand
  is printed instead. `--no-serve` never touches your Tailscale configuration.
- `--loopback`: this machine only. A phone cannot reach it.
- `--lan`: **experimental**. Binds every interface, so every device on your
  network can reach it and only the setup token stops them. Without a
  certificate the device already trusts, plain HTTP outside `localhost` is
  not a secure context: no installable app, no service worker, no
  notifications, no app badge. Every credential that authenticates a request
  (the setup token, a paired session's cookie, and the 400-day device
  credential) also crosses the network unencrypted, so anyone who can observe
  LAN traffic can copy them off the wire.

## Pairing

`start` prints a QR code beside the address. Scan it with the phone's camera
and the app pairs itself: the code is the address with the setup token in the
URL fragment, which the app spends and then strips out of the URL. Typing the
token into the pairing form does the same thing, if a camera is not to hand.
`prime-agent-remote token --qr` prints the code again for a gateway that is
already running.

A pairing link is as sensitive as the token it carries, and lasts as long —
until `prime-agent-remote token --rotate` **and the gateway is restarted**. A
running gateway holds the token it booted with and does not re-read the file,
so rotation alone does not invalidate a leaked link. Treat it like the token.

Either way the browser is then issued its own device credential, so it stays
paired across gateway restarts and never needs the token again. Signing out
revokes that device, clears both cookies, and ends every other session running
from that device, sockets included. Session expiry revokes nothing, by design,
so a phone stays paired across a gateway restart.

Only a hash of the credential is stored, so the file on disk does not let
anyone impersonate a paired device.

## Installing as a PWA

The full experience is the installed PWA: on iOS, notifications and the app
badge only work once the app has been added to the Home Screen and is opened
from there. In Safari, open the gateway address, then Share → Add to Home
Screen. Use the Tailscale HTTPS address, since being a secure context is what
makes the app installable at all. Chrome on Android offers the install on its
own.

The installed app may ask for the setup token again, because iOS can give it
storage separate from Safari's. If it does, that is expected rather than a
failed pairing, and the token is the same one you already used.
`prime-agent-remote token --qr` prints it, and a code to scan, again.

## From inside Prime Agent

`/webui` is installed by `prime-agent-remote install-command` (see above). It
copies `extensions/webui.ts` into `~/.prime/agent/extensions/`, so the command
exists in every session rather than only inside this checkout. Because it is a
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
- In-transcript search, quick replies, and per-agent drafts that survive
  reloads.
- Image attachments for image-capable models, resized client-side.
- Catalog-driven slash commands, with clearly marked experimental execution.
- Dialog and question attention cards.
- Starting, renaming, stopping and deleting sessions from the phone.
- Self-configuring web push: the gateway generates its own keys on first
  start, and each device opts in from Settings.
- Installable as a PWA.

The browser never reaches the daemon socket directly. There is no terminal, no
arbitrary shell, and no arbitrary file reading. The only filesystem surface is
a read-only directory-name browser for choosing a working directory.
[`docs/security.md`](docs/security.md) describes the boundary in full.

## Demo mode

`prime-agent-remote start --demo` runs against a safe fake backend that never
touches a real agent. Useful for looking at the interface without a running
agent, and for development.

Demo mode keeps its own pairing token, paired devices, gateway state, push
subscriptions, and VAPID keys in a separate `prime-agent-web-demo` config
directory, so a demo run never shares credentials with a real one or evicts a
real device from the paired-device store. Pass `--demo` to `status`, `stop`, and `rebuild` too when you mean the
demo instance; without it they operate on the real one.

## Documentation

- [Security model](docs/security.md): what the gateway does and does not
  defend against. Written by one person and not independently reviewed; a
  description, not a guarantee.
- [Deployment](docs/deployment.md): environment variables and production notes.
- [Changing the web UI](docs/modifying-the-ui.md): for agents and quick edits.
- [Protocol](docs/protocol.md): the wire contract.
- [Contributing](CONTRIBUTING.md)

## Requirements

- Node.js 22 or newer.
- Prime Agent installed and its daemon reachable.
- Tailscale recommended for access from outside your machine.

## License

MIT. See [LICENSE](LICENSE).

The butterfly mark used as the app icon comes from the Prime Agent repository
and is used under its MIT license. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). That license covers the
artwork, not the Prime Agent name or mark as a trademark, and no rights in
either are claimed here.
