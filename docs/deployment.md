# Deployment

## Development

`npm run dev` starts:

- the gateway on loopback port `8787`;
- Vite on loopback port `5173` with HTTP and WebSocket proxying.

Demo mode is the default and never executes local tools.

## Production

1. Run `npm run build`.
2. Set a long random `PRIME_WEB_PAIRING_TOKEN`.
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
| `PRIME_WEB_PAIRING_TOKEN` | random at startup | Setup token |
| `PRIME_WEB_SECURE_COOKIE` | true in production | Add the cookie `Secure` attribute |
| `PRIME_WEB_BACKEND` | `demo` | `demo` or `prime` |
| `PRIME_AGENT_MODULE` | package name | Compatible Prime Agent root module or built file path |
| `PRIME_AGENT_DAEMON_SOCKET` | Prime default | Optional daemon socket override |

Do not put real credentials in committed dotenv files.
