# Security model

## Boundary

The browser talks only to the web gateway. The gateway is the sole owner of daemon clients and attached agent connections.

The gateway currently permits these live operations:

- list projected agents;
- read projected transcripts and activity;
- send a prompt with queue-if-busy semantics;
- request abort;
- answer supported extension confirmation and selection requests.

It does not expose terminal creation, arbitrary bash, unrestricted files, daemon shutdown, or raw daemon commands.

## Authentication

A setup token is exchanged for an in-memory gateway session. The browser receives:

- an `HttpOnly` session cookie;
- `SameSite=Strict`;
- `Secure` when configured for HTTPS;
- a separate CSRF token returned inside authenticated JSON.

The setup token is never stored by the browser application.

## Browser checks

- Exact origin allowlist for pairing and mutations.
- Origin and session validation during WebSocket upgrade.
- CSP, frame denial, no-referrer, and content-type protections.
- One MiB HTTP request limit.
- WebSocket message and buffered-output limits.
- Pairing and mutation rate limits.
- Text rendering for transcript content; no raw HTML injection.

## Tailscale

Tailscale provides encrypted transport and tailnet membership. It is not treated as the only application security layer. The gateway should stay on loopback behind `tailscale serve`.

## Caching

The service worker excludes `/api/` and `/ws`. It precaches only the application shell manifest and icon. Transcripts, prompts, cookies, and API responses are not added to its cache.

## Remaining production work

Before a broad deployment:

- persist session revocation across gateway restarts if required;
- add an explicit logout and session-management screen;
- validate all Prime extension UI request shapes before adding free-text responses;
- perform a physical-device and reverse-proxy security test;
- add privacy-minimal push only after authoritative attention transitions are stable.
