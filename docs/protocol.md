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
