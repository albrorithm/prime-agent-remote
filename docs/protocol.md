# Gateway protocol

The browser protocol is kept separate from the local Prime Agent daemon protocol on purpose.

This document tries to be the exhaustive contract, but if the two ever
disagree, `src/protocol.ts` is the authority: it is the one module both the
gateway and the web app import, so a shape that drifts out of sync there
breaks the build instead of quietly going stale in prose. If you are
implementing against this API, check the Zod schemas there for anything this
document leaves ambiguous.

## Streams

- `catalog` contains the full browser-safe agent inventory.
- `agent:<opaque-id>` contains one agent transcript, activity projection, and pending attention requests.

Opaque IDs are derived from session identity. Local paths and daemon process identities are not exposed.

## Errors

Every REST failure returns a Problem Details body: `{ type, title, status, detail? }`. `type` is currently always `"about:blank"`; `status` and `title` carry the meaning. Common statuses: `400` invalid request, `401` authentication required, `403` origin/CSRF/capability refused, `404` not found, `409` state conflict (stale `expectedRevision` or a replayed request ID with a different body), `413` request too large, `429` rate limited (with `Retry-After` on mutation limits).

## WebSocket — `/ws/v1/events`

The upgrade itself is authenticated: a valid session cookie and an exact allowed `Origin`, both checked before the handshake completes. There is no separate login step over the socket.

### Client frames

```json
{ "type": "attach", "version": 1, "streamId": "agent:opaque-id", "since": { "epoch": "gateway-epoch", "seq": 42 } }
{ "type": "detach", "version": 1, "streamId": "agent:opaque-id" }
{ "type": "ping", "version": 1 }
```

`attach`'s `since` is optional/nullable; omit it for a cold attach. The server registers the subscriber and synchronously creates the initial response. The response is one of:

- `snapshot` for cold attach, changed epoch, stale cursor, or a large gap;
- `replay` when the ring buffer covers a small gap;
- `detached` when the stream no longer exists.

Live events follow the initial frame in sequence order as `event` frames. The browser drops duplicates and reattaches when it sees a gap. Attaching a `streamId` that is already subscribed on the same socket replaces the previous subscription.

`detach` drops a subscription; the server sends nothing back. `ping` gets exactly one `pong` in reply and does nothing else — it exists to keep idle connections, and any NAT or proxy in between, alive.

### Server frames

- `snapshot` — `{ streamId, cursor, snapshot }`, a full `CatalogSnapshot` or `AgentSnapshot` depending on the stream.
- `replay` — `{ streamId, cursor, events: EventEnvelope[] }`, the events since the requested cursor.
- `event` — `{ envelope: EventEnvelope }`, one live event.
- `detached` — `{ streamId, reason }`, where `reason` is `stream_gone`, `lagged`, `server_shutdown`, or `invalid_cursor`.
- `pong` — the reply to a client `ping`.

An `EventEnvelope` is `{ version, streamId, epoch, seq, emittedAt, event }`.

### GatewayEvent kinds

Six, all delivered as an `EventEnvelope.event`:

- `catalog.replaced` — payload is a full `CatalogSnapshot`; only on the `catalog` stream.
- `agent.replaced` — payload is a full `AgentSnapshot`; only on that agent's own `agent:<id>` stream.
- `agent.message_added` — payload is one `TranscriptMessage` newly appended to the transcript.
- `agent.message_updated` — payload is one `TranscriptMessage` sharing an `id` with one already delivered, typically as it streams in.
- `agent.attention_added` — payload is one `AttentionRequest` newly requiring a response.
- `agent.attention_resolved` — payload is `{ id }`, the id of an attention request that no longer needs one.

## Mutations

Mutations use HTTP instead of WebSocket. Every request includes:

- an authenticated session cookie;
- exact allowed `Origin`;
- `X-CSRF-Token`;
- a UUID `requestId`;
- an `expectedRevision` precondition (except where noted below).

Accepted request IDs are cached briefly so network retries do not duplicate prompts or approvals. Message and session-command mutations use Prime Agent's standard steering delivery when a run is active. Prime Agent applies the session's configured steering queue mode. A mutation route also enforces the session mutation rate limit (`docs/security.md`); sign-out is the one documented exception, since revoking a session must never be the one request that session cannot make.

## REST routes

### Authentication

- `POST /api/v1/auth/pair` — `{ token, deviceName? }`. Origin-checked; not session-authenticated, since there is no session yet. Success: `200 { paired: true, csrfToken }`, plus a session cookie and a device credential cookie. Shares the pairing rate limit described in `docs/security.md`.
- `POST /api/v1/auth/resume` — no body; the device credential cookie is the credential presented. Origin-checked; otherwise unauthenticated by design. Success: `200 { paired: true, csrfToken }` plus a new session cookie. Shares the same rate limit as pairing.
- `POST /api/v1/auth/logout` — authenticated, Origin- and CSRF-checked, but exempt by design from the mutation rate limit and request-ID deduplication (see `docs/security.md`). Success: `200 { signedOut: true }`; closes the caller's open WebSocket connections and clears both cookies.

### Bootstrap

- `GET /api/v1/bootstrap` — authenticated. Returns a `BootstrapResponse`: `{ protocolVersion, csrfToken, backend: "demo" | "prime", push: { enabled, publicKey }, catalog }`.

### Agents

- `GET /api/v1/agents/:id/snapshot` — authenticated. The same `AgentSnapshot` shape the WebSocket delivers; `404` if the id is unknown.
- `GET /api/v1/agents/:id/commands` — the slash-command catalog; see [Slash commands](#slash-commands).
- `POST /api/v1/agents/:id/commands` — execute a slash command; see [Slash commands](#slash-commands).
- `POST /api/v1/agents/:id/messages` — send text and/or images; see [Image messages](#image-messages).
- `POST /api/v1/agents/:id/abort` — `{ requestId, expectedRevision }`. Interrupts an active run; the agent stays live.
- `POST /api/v1/agents/:id/rename` — `{ requestId, expectedRevision, name }`. `name` is schema-validated as one line, at most 200 characters.
- `POST /api/v1/agents/:id/stop` — `{ requestId, expectedRevision }`. Ends the live session by id; it is left saved and resumable. This is not daemon shutdown.
- `POST /api/v1/agents/:id/delete` — `{ requestId, expectedRevision, confirmName }`. Permanently deletes a saved session and its transcript. `confirmName` must equal the session's current name, checked server-side; a mismatch or a live session is refused rather than deleted.

The mutation routes above return `202` with a `MutationAccepted` body, `{ accepted: true, requestId, revision }` (`commands` additionally carries a discriminated `result`; see below).

### Sessions and directories

- `POST /api/v1/sessions` — `{ requestId, cwd, name? }`. Creates a daemon session with `cwd` as its working directory. `202 { requestId, agentId }`.
- `GET /api/v1/directories?path=…` — the read-only companion for the new-session picker. `200 { path, home, crumbs, entries, truncated }`; every entry carries an absolute path and the client never joins path segments itself. `400` if `path` is not absolute.

### Attachments and cell output

- `GET /api/v1/attachments/:id` — authenticated, content-addressed, `Cache-Control: private, no-store`. Returns raw image bytes with the attachment's own `Content-Type`.
- `GET /api/v1/cells/:cellId` — authenticated. Returns the untruncated sections of one Python cell: `{ cellId, code?, stdout?, stderr?, result?, traceback?, truncated }`.

### Push

- `POST /api/v1/push/subscribe` — `{ requestId, subscription: { endpoint, keys: { p256dh, auth } } }`. `503` if the gateway has no VAPID keys configured.
- `POST /api/v1/push/unsubscribe` — `{ requestId, endpoint }`. Succeeds even for an endpoint the gateway never had, since that is the goal state either way.

Both return `202 { accepted: true, requestId }`.

### Attention

- `POST /api/v1/attention/:id/respond` — `{ requestId, expectedRevision, optionId }`. `202` with a `MutationAccepted` body.

### Slash commands

`GET /api/v1/agents/:id/commands` returns an authenticated, no-store, per-agent catalog. The gateway owns all descriptions and argument hints. Prime's dynamic `getCommands()` rows are reduced to a bounded command name and broad source category. Paths, package sources, raw descriptions, registered names, and other daemon metadata are discarded. Detected extension, prompt, and skill commands are exposed by sanitized name and broad source category as **experimental**. The gateway re-checks the live catalog immediately before execution, reconstructs the command server-side, and calls Prime's normal prompt entry point. A catalog reload between those two operations can still make Prime treat the text as a model prompt; this accepted experimental limitation is shown in the mobile UI.

`POST /api/v1/agents/:id/commands` accepts `{ requestId, expectedRevision, name, args }`. `name` must be a conservative bounded command token, `args` is a bounded single-line string, and unknown fields are rejected. The backend authorizes either one of the nine explicit commands or an exact name present in the current sanitized dynamic catalog. TUI-only and unknown names are rejected.

The four session-owned commands—`compact`, `refine`, `goal`, and `autonomous`—are reconstructed server-side and admitted through Prime's normal session-input path. The five adapter commands never use `prompt()`:

- `model` validates an exact available provider/model before calling `setModel()`;
- `effort` validates the current model's available thinking levels before calling `setThinkingLevel()`;
- `name` reads or updates the session name through `getState()` and `setSessionName()`;
- `context` returns only finite token, context-window, percentage, and cost fields from `getSessionStats()`;
- `heartbeat` maps conservative status, pause, resume, clear, and set syntax to the explicit heartbeat methods.

Command responses use a closed result union (`SlashCommandResult`: `session_accepted`, `experimental_accepted`, `model`, `effort`, `name`, `context_usage`, `heartbeat`). Experimental results contain only the broad command source. Responses never return raw models, context-tree labels, heartbeat prompts, filesystem paths, daemon errors, provider configuration, or extension output. Command mutations use authentication, CSRF, revision, rate-limit, and request-ID binding checks. They create no optimistic transcript bubbles. Unknown, unavailable, multiline, or stale-client slash input fails closed and never falls back through the ordinary message endpoint. Experimental commands are the explicit exception: after a live catalog re-check, they use Prime's prompt entry point and therefore retain Prime's acknowledged command-reload race.

### Image messages

`POST /api/v1/agents/:id/messages` accepts `text` plus up to three `images`. Each image is exactly `{ type: "image", mimeType, data }`, where `mimeType` is JPEG, PNG, or WebP and `data` is canonical base64. Either text or at least one image is required. The gateway validates count, per-image size, total size, canonical encoding, and MIME signature before calling Prime Agent's native image prompt API.

For a resumable inactive agent, the same revision-checked and request-ID-deduplicated message mutation first resolves the server-only saved-session path, creates and attaches the live Prime runtime, then admits the text prompt. The composer accepts text while inactive and describes this as `Send a message to wake`. Images and slash commands remain unavailable until the session is live.

Transcript streams contain only `{ id, type, mimeType }` attachment metadata. They never contain image base64. A paired browser loads bytes from `GET /api/v1/attachments/:id`; the content-addressed ID is opaque in the browser protocol and the route uses the same authenticated session boundary as snapshots.

## Projection states

Agent state is split into independent fields:

```text
lifecycle: starting | live | inactive | stopped | failed
activity:  working | idle | blocked
attention: dialog | question | error | null
```

This avoids treating transport loss, agent lifecycle, and user attention as the same status.
