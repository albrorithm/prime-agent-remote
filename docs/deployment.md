# Deployment

## Development

`npm run dev` starts:

- the gateway on loopback port `8787`;
- Vite on loopback port `5173` with HTTP and WebSocket proxying.

Demo mode is the default and never executes local tools.

## Production

1. Run `npm run build`.
2. Set a random `PRIME_WEB_PAIRING_TOKEN` with at least 32 characters. Production startup rejects a missing or shorter token.
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
| `PRIME_WEB_PAIRING_TOKEN` | random at startup outside production; required in production | Setup token (32 or more characters in production) |
| `PRIME_WEB_SECURE_COOKIE` | true in production | Add the cookie `Secure` attribute; accepts only `true`, `false`, `1`, or `0` |
| `PRIME_WEB_BACKEND` | `demo` | `demo` or `prime`; other values fail startup |
| `PRIME_AGENT_MODULE` | package name | Compatible Prime Agent root module or built file path |
| `PRIME_AGENT_DAEMON_SOCKET` | Prime default | Optional daemon socket override |
| `PRIME_WEB_SESSION_TTL_MS` | `43200000` (12 hours) | In-memory HTTP and WebSocket session lifetime |

Do not put real credentials in committed dotenv files.

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
