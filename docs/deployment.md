# Deployment

## Development

`npm run dev` starts:

- the gateway on loopback port `8787`;
- Vite on loopback port `5173` with HTTP and WebSocket proxying.

Demo mode is the default and never executes local tools.

## Production

1. Run `npm run build`.
2. `PRIME_WEB_PAIRING_TOKEN` is optional: leave it unset and the gateway mints a
   32-byte token itself on first run, persisted at mode `0600`. Set one only to
   override that, and make it at least 32 characters — production rejects a
   shorter one.
3. Set exact `PRIME_WEB_ALLOWED_ORIGINS`.
4. Keep `PRIME_WEB_HOST=127.0.0.1`.
5. Set `PRIME_WEB_SECURE_COOKIE=true` behind HTTPS.
6. Run `npm start` under the host's service manager.
7. Publish loopback through Tailscale Serve.

The `dist/` directory contains the PWA. `dist-server/` contains the gateway.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PRIME_WEB_HOST` | `127.0.0.1` | Gateway bind address |
| `PRIME_WEB_PORT` | `8787` | Gateway port |
| `PRIME_WEB_ALLOWED_ORIGINS` | local development origins | Exact comma-separated browser origins |
| `PRIME_WEB_PAIRING_TOKEN` | minted once and persisted | Setup token override for a directly-run gateway (`npm start`); a configured one must be 32 or more characters in production. The `prime-agent-remote` CLI ignores this variable and always reads or mints its own token file instead — see `docs/security.md` |
| `PRIME_WEB_SECURE_COOKIE` | true in production | Add the cookie `Secure` attribute; accepts only `true`, `false`, `1`, or `0` |
| `PRIME_WEB_BACKEND` | `demo` | `demo` or `prime`; other values fail startup |
| `PRIME_AGENT_MODULE` | discovered | Override for the Prime Agent build; unset means search dependencies then `npm root -g` |
| `PRIME_AGENT_DAEMON_SOCKET` | Prime default | Optional daemon socket override |
| `PRIME_WEB_SESSION_TTL_MS` | `43200000` (12 hours) | In-memory HTTP and WebSocket session lifetime |
| `PRIME_WEB_VAPID_PUBLIC_KEY` | unset (minted on first start) | VAPID application server key, base64url; must decode to 65 bytes |
| `PRIME_WEB_VAPID_PRIVATE_KEY` | unset (minted on first start) | VAPID private key, base64url; must decode to 32 bytes |
| `PRIME_WEB_VAPID_SUBJECT` | the project URL | Contact for push services: a `mailto:` or `https://` URL |
| `PRIME_WEB_VAPID_KEY_FILE` | `$XDG_CONFIG_HOME/prime-agent-web/vapid-keys.json` (or under `~/.config`) | Absolute path to the VAPID keypair the gateway mints for itself when none is configured |
| `PRIME_WEB_PAIRING_TOKEN_FILE` | `$XDG_CONFIG_HOME/prime-agent-web/pairing-token` (or under `~/.config`) | Absolute path to the token the gateway mints for itself when none is configured |
| `PRIME_WEB_DEVICE_STORE` | `$XDG_CONFIG_HOME/prime-agent-web/devices.json` (or under `~/.config`) | Absolute path to the paired-device credential file |
| `PRIME_WEB_PUSH_STORE` | `$XDG_CONFIG_HOME/prime-agent-web/push-subscriptions.json` (or under `~/.config`) | Absolute path to the push subscription file |
| `PRIME_WEB_STATE_FILE` | `$XDG_CONFIG_HOME/prime-agent-web/gateway.json` (or under `~/.config`) | Absolute path to where the CLI launcher records a running gateway (pid, url, mode, backend) so `status`, `stop`, and `rebuild` can find it |

The two VAPID key variables are all-or-nothing: set both or neither. A partial
configuration fails startup rather than leaving the app offering a notification
switch that cannot work. `PRIME_WEB_VAPID_SUBJECT` is independent — it is the
one part worth setting by hand when the keys are generated for you.

Do not put real credentials in committed dotenv files.

## Notifications

Push and the app-icon badge are one feature, and the gateway configures itself
for it. On first start it mints a VAPID keypair, writes it to
`$XDG_CONFIG_HOME/prime-agent-web/vapid-keys.json` at mode `0600`, and reuses it
on every start after that — the same arrangement as the pairing token, and for
the same reason: a file the gateway owns beats a long-lived secret in the
process environment, where any `ps` can read it.

This used to require running a generator by hand and pinning three environment
variables, which meant push shipped switched off for anyone who did not already
know what VAPID is.

So there is one step:

1. Open the app, go to Settings → Notifications, and press *Turn on
   notifications*. Permission is requested from that button only; the browser
   ignores or auto-denies a prompt raised any other way, and a denial cannot be
   re-prompted from the page.

To use a keypair of your own instead — one shared between two installs, or kept
somewhere else — generate it with `node scripts/generate-vapid.mjs
mailto:you@example.com` and set `PRIME_WEB_VAPID_PUBLIC_KEY` and
`PRIME_WEB_VAPID_PRIVATE_KEY`. Explicit keys win and nothing is minted. Keep the
private key out of the repository.

Deleting `vapid-keys.json` is not data loss but an identity change: existing
subscriptions are bound to the key that created them, so each device turns
notifications on again. The app already unsubscribes and re-subscribes for this
case, so a stale subscription does not sit there failing quietly.

Notes an operator needs:

- On iOS the app must be installed to the Home Screen and opened from there.
  Notification permission and `setAppBadge` do nothing in Safari tabs, and the
  badge stays inert until notification permission is granted (iOS 16.4+).
- Push requires HTTPS, which `tailscale serve` already provides. It will not
  work over plain HTTP outside `localhost`.
- The service worker registers in production builds only, so notifications
  cannot be exercised under `npm run dev`. Use `npm run build && npm start`.
  Turning them on there now fails with a message rather than hanging, which is
  what it used to do.
- Nor can they be exercised against `PRIME_WEB_BACKEND=demo`. `onAttentionAdded`
  is optional on the backend interface and only the Prime backend implements it,
  so a demo gateway accepts and stores a subscription and can never send to it —
  silently, with no error anywhere. Push needs `backend=prime`.
- Rotating the keypair invalidates every existing subscription. Devices must
  turn notifications on again.
- Notifications name the session and the kind of attention it needs. They never
  contain prompt or transcript text.
- Settings → Notifications also offers "Also when a turn finishes", off by
  default and per device. Prime Agent does not end a turn cleanly — the root
  finishes and straggling subagents wake the session again for seconds at a
  time — so a turn counts as over only once the session has been continuously
  idle, and any return to work restarts that clock. One notification per turn:
  see `src/server/turn-end-notifier.ts` for why a straggler postpones rather
  than repeats.
- Signing out revokes that session's subscriptions. Letting a session expire
  deliberately does not, so notifications keep working overnight.

## Install-time theming

`public/manifest.webmanifest` pins `theme_color` and `background_color` to
`#000000`. Both are read once when the app is installed and cannot be changed
at runtime, so a single value has to serve both themes. Black is deliberate:
the product's identity is dark, and a black launch flash ahead of the light
theme is less jarring than a white one ahead of the dark theme.

The consequence is that a viewer whose OS is set to Light Appearance sees a
black splash before the app paints its light ground. The `<meta name="theme-color">`
in `index.html` has no such limit — `public/theme-init.js` corrects it before
first paint and `applySettings` keeps it on the active theme.
