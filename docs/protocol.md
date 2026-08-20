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

## Projection states

Agent state is split into independent fields:

```text
lifecycle: starting | live | inactive | stopped | failed
activity:  working | idle | blocked
attention: approval | question | error | null
```

This avoids treating transport loss, agent lifecycle, and user attention as the same status.
