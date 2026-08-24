# Security model

## Boundary

The browser talks only to the web gateway. The gateway is the sole owner of daemon clients and attached agent connections.

The gateway currently permits these live operations:

- list projected agents;
- read projected transcripts and activity;
- send a text prompt or explicitly user-selected image prompt with queue-if-busy semantics, waking a daemon-projected saved session first when needed;
- execute four enumerated session commands and five explicit `AgentConnection` adapters with bounded single-line arguments;
- detect additional installed extension, prompt, and skill command names through a metadata-stripping projection;
- experimentally execute an exact currently detected command after a live catalog re-check;
- retrieve a projected image through an authenticated content-addressed attachment route;
- request abort;
- answer supported extension confirmation and selection requests;
- create a new daemon session in a chosen working directory;
- list directory names for the new-session picker.

Experimental detected extension commands can run with the local capabilities already granted to Prime Agent, while detected prompt and skill commands can create model turns. This expands the paired browser’s trust boundary and retains a catalog-reload race that may turn command text into a model prompt.

The gateway still adds no direct operations for terminal creation, arbitrary bash, arbitrary host file reads, daemon shutdown, raw daemon command objects, unknown slash names, or TUI-only slash-command execution. Experimental extensions are trusted local code and may provide equivalent side effects through their own implementation. Unknown slash input is not forwarded to the model. Command failures are sanitized before they cross the gateway boundary. Image bytes enter the gateway only after an explicit browser selection, capture, paste, or drop action.

The directory listing is deliberately narrow: absolute paths only (a relative path is rejected rather than resolved against any base), directory entries only — never files — with a bounded result size, and no path joining on the client. It answers "what child directories exist here" and nothing more.

## Authentication

A setup token is exchanged for an in-memory gateway session. The browser receives:

- an `HttpOnly` session cookie;
- `SameSite=Strict`;
- `Secure` when configured for HTTPS;
- a separate CSRF token returned inside authenticated JSON.

The setup token is never stored by the browser application. Production requires an explicitly configured setup token of at least 32 characters. Sessions expire in memory after the configured TTL. A WebSocket is bound to the session used during its upgrade and is closed when that session expires.

## Browser checks

- Exact origin allowlist for pairing and mutations.
- Origin and session validation during WebSocket upgrade.
- CSP, frame denial, no-referrer, and content-type protections.
- One MiB default HTTP request limit. Image-message requests have a separate bounded limit sized for three validated images.
- WebSocket limits of 128 KiB per inbound message, 16 MiB per serialized outbound frame, and 32 MiB of aggregate buffered output.
- Sliding-window rate limits: 5 pairing attempts per remote address per minute (failed attempts consume the budget, and over-limit attempts are answered like a wrong token) and 120 mutations per session per minute (`429` with `Retry-After`). Each limiter tracks at most 4,096 keys and refuses new keys at capacity.
- Text rendering for transcript content; no raw HTML injection.

## Tailscale

Tailscale provides encrypted transport and tailnet membership. It is not treated as the only application security layer. The gateway should stay on loopback behind `tailscale serve`.

## Caching

The service worker excludes `/api/` and `/ws`. It precaches the built application-shell index, fingerprinted JavaScript and CSS, manifest, and icons. Transcripts, prompts, cookies, and API responses are not added to its cache.

Validated image bytes use a 64 MiB in-memory LRU cache in the live backend. Validation checks canonical base64, container structure, checksums where available, dimensions, and per-image and per-request pixel limits before admission. Browser transcript snapshots receive only content-addressed metadata. Attachment responses require authentication, use private no-store headers, and never include local filenames.

## Remaining production work

Before a broad deployment:

- persist session revocation across gateway restarts if required;
- add an explicit logout and session-management screen;
- validate all Prime extension UI request shapes before adding free-text responses;
- perform a physical-device and reverse-proxy security test;
- add privacy-minimal push only after authoritative attention transitions are stable.
