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
- rename one agent, by its id: a live session through the same `AgentConnection` adapter the `/name` command already uses, and a saved one through the daemon's own recorded session path — never a path the browser supplies. The name is schema-validated as a single line of at most 200 characters before it leaves the gateway;
- end one agent's live session, by its id, through the daemon's `kill` for that session's own active id. The session is left saved and resumable; this is not daemon shutdown, and the browser cannot express one;
- permanently delete one saved session and its transcript, by its id, through the daemon's `delete_saved_session` on that session's own recorded path. This is irreversible and the gateway keeps no copy. It is confirmed by the request carrying the session's current name, which the gateway checks server-side and refuses on any mismatch, so a browser cannot skip the confirmation and a stale catalog deletes nothing rather than the wrong session. A live session is refused outright and must be stopped first;
- answer supported extension confirmation and selection requests;
- create a new daemon session in a chosen working directory;
- list directory names for the new-session picker;
- register and revoke a browser push subscription for this device;
- explicitly sign out, invalidating the session, clearing its cookie, and revoking that session's push subscriptions.

Experimental detected extension commands can run with the local capabilities already granted to Prime Agent, while detected prompt and skill commands can create model turns. This expands the paired browser’s trust boundary and retains a catalog-reload race that may turn command text into a model prompt.

The gateway still adds no direct operations for terminal creation, arbitrary bash, arbitrary host file reads, daemon shutdown, raw daemon command objects, unknown slash names, or TUI-only slash-command execution. Experimental extensions are trusted local code and may provide equivalent side effects through their own implementation. Unknown slash input is not forwarded to the model. Command failures are sanitized before they cross the gateway boundary. Image bytes enter the gateway only after an explicit browser selection, capture, paste, or drop action.

The directory listing is deliberately narrow: absolute paths only (a relative path is rejected rather than resolved against any base), directory entries only — never files — with a bounded result size, and no path joining on the client. It answers "what child directories exist here" and nothing more.

## Authentication

A setup token is exchanged for an in-memory gateway session, and for a device
credential that outlives it.

### Device credentials

Pairing issues one credential per browser, stored as `id.secret` in a separate
`HttpOnly` cookie with the same attributes as the session cookie and a 400-day
maximum age, which is the ceiling browsers enforce anyway.

- Its purpose is restarts. Sessions are in memory and die with the process, so
  without it every restart returns every device to the setup token — which
  pushes operators into keeping that token somewhere convenient, and a
  bootstrap secret kept convenient is the problem it exists to avoid.
- Only `sha256` of the secret is written to disk. Unlike the setup token, which
  may sit in an environment variable, a leaked device store does not let anyone
  become a paired device. A test asserts the secret does not appear in the file
  it was issued from.
- `POST /api/v1/auth/resume` exchanges the credential for a new session. It is
  deliberately unauthenticated — the cookie is the credential — validates
  `Origin`, and shares the setup token's rate limit, because guessing a bearer
  credential deserves the same ceiling as guessing the token.
- Sign-out revokes the credential, clears both cookies, and ends every other
  session running from that device too, sockets included — a second tab, or a
  session opened before the sign-out, does not survive it. Each of those
  sessions' own push subscriptions is revoked as well, so the wake capability
  dies with them. Session expiry deliberately revokes nothing, which is
  exactly what lets a phone survive a restart.
- A credential that no longer verifies has its cookie cleared, so a browser
  stops presenting something that can never work again.
- Records are bounded in count and per-field size, written mode `0600` through
  a temp file and rename, and a corrupt store falls back to empty — one
  re-pairing, rather than a gateway that will not start.
- Rotating the setup token does not revoke any device. Revoking a device does
  not affect the others.

### Sessions

The browser receives:

- an `HttpOnly` session cookie;
- `SameSite=Strict`;
- `Secure` when configured for HTTPS;
- a separate CSRF token returned inside authenticated JSON.

The setup token is never stored by the browser application. Production no
longer requires the token to be configured: an unset one is minted at 32
random bytes and persisted at mode `0600` in the gateway's own configuration
directory, which is stronger than a human-chosen value. Where that token ends
up depends on how the gateway is started. Run directly (`npm start`, the
`docs/deployment.md` production path), the process reads or mints the file
into its own in-memory config and never puts the token in its environment.
Run through the CLI (`prime-agent-mobile start`, the normal path — see the
README) it does: the launcher reads or mints the same file itself, then passes
the value to the spawned gateway process as `PRIME_WEB_PAIRING_TOKEN`, so under
the CLI the token is present in the running gateway's environment for the life
of the process — readable by the same local user, or root, through `ps` or
`/proc/<pid>/environ` on Linux, or equivalent process inspection on macOS, but
not by another unprivileged account. A token that *is* configured must still
be at least 32 characters in production, though under the CLI an operator-set
`PRIME_WEB_PAIRING_TOKEN` is not what takes effect — the CLI always reads or
mints its own token file regardless of the environment, and only that value
reaches the gateway. Sessions expire in memory after the configured TTL, and
an explicit sign-out invalidates the session immediately and clears the cookie
with the same attributes it was set with. A WebSocket is bound to the session
used during its upgrade and is closed when that session expires or is signed
out, including a second tab sharing the session.

## Push notifications

Push is off unless the operator configures VAPID keys. With none set the routes refuse a subscription and the gateway behaves exactly as it did before push existed.

A push subscription is a long-lived capability to wake a device, and it deliberately outlives the session cookie that authorized it. That is the point: a subscription that died with the 12-hour session TTL would stop working overnight, which is the window it exists for. The consequences are stated plainly rather than mitigated away:

- Subscriptions are the gateway's only persistent state. They live in a JSON file at `PRIME_WEB_PUSH_STORE`, written mode `0600` through a temp file and rename, bounded in record count and per-field size. A corrupt or unreadable store falls back to empty rather than failing startup.
- Payloads carry a session label, an attention kind, opaque agent and attention ids, and a count. They never carry prompt text, transcript text, dialog titles or messages, or option labels. Agent output does not reach a lock screen. A test builds a payload from an attention request whose every daemon-authored field is a sentinel and asserts none survive. The label is `AgentSummary.notificationLabel`, not the display name: a display name falls back to the session's first user message and then to the daemon's recap, both of which are conversation text, so the label is drawn only from a name a person typed or the session's own directory, and is absent when neither exists. A second test pins that a session titled by its first message pushes its directory instead.
- Push fires only on an authoritative `AttentionRequest`. It never fires on `needsInput`, which the protocol documents as an advisory daemon guess and never a queue.
- Sign-out revokes: the logout route drops every record bound to that session, and the browser drops its own subscription before the request. Session expiry revokes nothing. A device re-registers its existing subscription on each new session so that sign-out can always find it.
- A record is otherwise removed only by an explicit unsubscribe or by a push service reporting the endpoint permanently gone (`404`/`410`). Not by time.
- Endpoints are device identifiers and are never written to logs.
- Rotating the VAPID keypair invalidates every existing subscription; devices must be turned on again.

## Browser checks

- Exact origin allowlist for pairing and mutations.
- Origin and session validation during WebSocket upgrade.
- CSP, frame denial, no-referrer, and content-type protections.
- One MiB default HTTP request limit. Image-message requests have a separate bounded limit sized for three validated images.
- WebSocket limits of 128 KiB per inbound message, 16 MiB per serialized outbound frame, and 32 MiB of aggregate buffered output.
- Sliding-window rate limits: 5 pairing attempts per remote address per minute (failed attempts consume the budget, and over-limit attempts are answered like a wrong token), 30 resume attempts per verified device per minute, and 120 mutations per session per minute (`429` with `Retry-After`). Each limiter tracks at most 4,096 keys and refuses new keys at capacity. A resume is charged to its device's own budget only once its credential verifies; an unverified resume attempt — a guess — is charged to the address budget instead, the same one pairing uses, so guessing a device token costs exactly what guessing the pairing token costs. That address budget is a single shared bucket behind a reverse proxy that terminates every connection from the same address — `tailscale serve` does this, presenting every client as `127.0.0.1` — so pairing a new device, or a resume attempt that fails verification, can exhaust it for the whole house; more than five of either in a minute will see the next one rejected until the window rolls over. Legitimate reconnects by already-paired devices are unaffected, since each has its own per-device budget.
- Text rendering for transcript content; no raw HTML injection.

## Tailscale

Tailscale provides encrypted transport and tailnet membership. It is not treated as the only application security layer. The gateway should stay on loopback behind `tailscale serve`.

## LAN mode

`--lan` binds every interface, so the setup token — not encryption — is what stops an arbitrary device on the network from pairing. Without a certificate the device already trusts, LAN mode runs over plain HTTP, and everything that authenticates a request crosses that wire in the clear: the pairing token used to pair a new device, the session cookie of one already paired, and the 400-day device credential minted for it. That is on top of the secure-context features plain HTTP outside `localhost` already loses (installability, notifications, the app badge). A bystander who can observe LAN traffic can copy any of those three credentials off the wire; treat LAN mode as a same-trust-network convenience, not a substitute for `--tailscale`.

## Caching

The service worker excludes `/api/` and `/ws`. It precaches the built application-shell index, fingerprinted JavaScript and CSS, manifest, and icons. Transcripts, prompts, cookies, and API responses are not added to its cache. Its `push` handler shows a notification and sets the app badge; nothing it receives is written to the cache.

Validated image bytes use a 64 MiB in-memory LRU cache in the live backend. Validation checks canonical base64, container structure, checksums where available, dimensions, and per-image and per-request pixel limits before admission. Browser transcript snapshots receive only content-addressed metadata. Attachment responses require authentication, use private no-store headers, and never include local filenames.

## Remaining production work

Before a broad deployment:

- add a session-management screen listing and revoking other sessions;
- add a device-management screen: credentials can currently be revoked only by
  signing out from the device itself, or by deleting the store;
- validate all Prime extension UI request shapes before adding free-text responses;
- perform a physical-device and reverse-proxy security test, including a real push delivered to an installed PWA with the app closed;
- add a device-management screen listing and revoking individual push subscriptions, which currently can only be revoked from the device that created one or by signing that session out.

Privacy-minimal push is now implemented against authoritative attention transitions, and its payload boundary is stated above. What remains is operational rather than a design question: subscriptions survive gateway restarts by design, so the store file is a credential-bearing artifact that belongs in the same backup and disposal policy as any other.
