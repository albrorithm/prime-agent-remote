# Gateway protocol

The browser protocol is intentionally separate from the local Prime Agent daemon protocol.

## Streams

- `catalog` contains the full browser-safe agent inventory.
- `agent:<opaque-id>` contains one agent transcript, activity projection, and pending attention requests.

Opaque IDs are derived from session identity. Local paths and daemon process identities are not exposed.

## Attach

```json
{
  "type": "attach",
  "version": 1,
  "streamId": "agent:opaque-id",
  "since": { "epoch": "gateway-epoch", "seq": 42 }
}
```

The server registers the subscriber and synchronously creates the initial response. The response is one of:

- `snapshot` for cold attach, changed epoch, stale cursor, or a large gap;
- `replay` when the ring buffer covers a small gap;
- `detached` when the stream no longer exists.

Live events follow the initial frame in sequence order. The browser drops duplicates and reattaches when it sees a gap.

## Mutations

Mutations use HTTP instead of WebSocket. Every request includes:

- an authenticated session cookie;
- exact allowed `Origin`;
- `X-CSRF-Token`;
- a UUID `requestId`;
- an `expectedRevision` precondition.

Accepted request IDs are cached briefly so network retries do not duplicate prompts or approvals.

Session creation is a mutation too: `POST /api/v1/sessions` with `{ requestId, cwd, name? }` creates a daemon session with `cwd` as its working directory and returns the new agent id. `GET /api/v1/directories?path=…` is the read-only companion used by the picker: it returns one directory level as `{ path, home, crumbs, entries, truncated }` where every entry carries an absolute path and clients never join path segments themselves.

### Slash commands

`GET /api/v1/agents/:id/commands` returns an authenticated, no-store, per-agent catalog. The gateway owns all descriptions and argument hints. Prime’s dynamic `getCommands()` rows are reduced to a bounded command name and broad source category. Paths, package sources, raw descriptions, registered names, and other daemon metadata are discarded. Detected extension, prompt, and skill commands are exposed by sanitized name and broad source category as **experimental**. The gateway re-checks the live catalog immediately before execution, reconstructs the command server-side, and calls Prime’s normal prompt entry point. A catalog reload between those two operations can still make Prime treat the text as a model prompt; this accepted experimental limitation is shown in the mobile UI.

`POST /api/v1/agents/:id/commands` accepts `{ requestId, expectedRevision, name, args }`. `name` must be a conservative bounded command token, `args` is a bounded single-line string, and unknown fields are rejected. The backend authorizes either one of the nine explicit commands or an exact name present in the current sanitized dynamic catalog. TUI-only and unknown names are rejected.

The four session-owned commands—`compact`, `refine`, `goal`, and `autonomous`—are reconstructed server-side and admitted through Prime’s normal session-input path. The five adapter commands never use `prompt()`:

- `model` validates an exact available provider/model before calling `setModel()`;
- `effort` validates the current model’s available thinking levels before calling `setThinkingLevel()`;
- `name` reads or updates the session name through `getState()` and `setSessionName()`;
- `context` returns only finite token, context-window, percentage, and cost fields from `getSessionStats()`;
- `heartbeat` maps conservative status, pause, resume, clear, and set syntax to the explicit heartbeat methods.

Command responses use a closed result union. Experimental results contain only the broad command source. Responses never return raw models, context-tree labels, heartbeat prompts, filesystem paths, daemon errors, provider configuration, or extension output. Command mutations use authentication, CSRF, revision, rate-limit, and request-ID binding checks. They create no optimistic transcript bubbles. Unknown, unavailable, multiline, or stale-client slash input fails closed and never falls back through the ordinary message endpoint. Experimental commands are the explicit exception: after a live catalog re-check, they use Prime’s prompt entry point and therefore retain Prime’s acknowledged command-reload race.

### Image messages

`POST /api/v1/agents/:id/messages` accepts `text` plus up to three `images`. Each image is exactly `{ type: "image", mimeType, data }`, where `mimeType` is JPEG, PNG, or WebP and `data` is canonical base64. Either text or at least one image is required. The gateway validates count, per-image size, total size, canonical encoding, and MIME signature before calling Prime Agent's native image prompt API.

Transcript streams contain only `{ id, type, mimeType }` attachment metadata. They never contain image base64. A paired browser loads bytes from `GET /api/v1/attachments/:id`; the content-addressed ID is opaque in the browser protocol and the route uses the same authenticated session boundary as snapshots.

## Projection states

Agent state is split into independent fields:

```text
lifecycle: starting | live | inactive | stopped | failed
activity:  working | idle | blocked
attention: approval | question | error | null
```

This avoids treating transport loss, agent lifecycle, and user attention as the same status.
