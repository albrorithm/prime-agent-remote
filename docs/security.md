# Security model

## Boundary

The browser talks only to the web gateway. The gateway is the sole owner of daemon clients and attached agent connections.

The gateway currently permits these live operations:

- list projected agents;
- read projected transcripts and activity;
- send a text prompt or explicitly user-selected image prompt with queue-if-busy semantics;
- execute the four explicitly enumerated session commands (`compact`, `refine`, `goal`, and `autonomous`) with bounded single-line arguments;
- retrieve a projected image through an authenticated content-addressed attachment route;
- request abort;
- answer supported extension confirmation and selection requests;
- create a new daemon session in a chosen working directory;
- list directory names for the new-session picker.

It does not expose terminal creation, arbitrary bash, arbitrary host file contents, daemon shutdown, raw daemon commands, or client-only slash commands. Unknown slash input is not forwarded to the model. Command failures are sanitized before they cross the gateway boundary. Image bytes enter the gateway only after an explicit browser selection, capture, paste, or drop action.

The directory listing is deliberately narrow: absolute paths only (a relative path is rejected rather than resolved against any base), directory entries only — never files — with a bounded result size, and no path joining on the client. It answers "what child directories exist here" and nothing more.

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
- One MiB default HTTP request limit. Image-message requests have a separate bounded limit sized for three validated images.
- WebSocket message and buffered-output limits.
- Pairing and mutation rate limits.
- Text rendering for transcript content; no raw HTML injection.

## Tailscale

Tailscale provides encrypted transport and tailnet membership. It is not treated as the only application security layer. The gateway should stay on loopback behind `tailscale serve`.

## Caching

The service worker excludes `/api/` and `/ws`. It precaches only the application shell manifest and icon. Transcripts, prompts, cookies, and API responses are not added to its cache.

Validated image bytes use a 64 MiB in-memory LRU cache in the live backend. Browser transcript snapshots receive only content-addressed metadata. Attachment responses require authentication, use private no-store headers, and never include local filenames.

## Remaining production work

Before a broad deployment:

- persist session revocation across gateway restarts if required;
- add an explicit logout and session-management screen;
- validate all Prime extension UI request shapes before adding free-text responses;
- perform a physical-device and reverse-proxy security test;
- add privacy-minimal push only after authoritative attention transitions are stable.
