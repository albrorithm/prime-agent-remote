/**
 * WebSocket transport limits cover the bounded Prime projections while keeping
 * a hard ceiling on serialization and queued output. Prime transcript text can
 * JSON-escape to about 12 MiB in its worst bounded case; catalog projections
 * and replay batches are bounded below this 16 MiB frame ceiling.
 */
export const MAX_WEBSOCKET_INBOUND_FRAME_BYTES = 128 * 1024;
export const MAX_WEBSOCKET_OUTBOUND_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_WEBSOCKET_BUFFERED_BYTES = 32 * 1024 * 1024;

export type RejectOutboundFrame = (code: 1009 | 1013, reason: string) => void;

/** Returns true only when the serialized frame can be queued safely. */
export function enforceOutboundFrameLimits(
  serializedBytes: number,
  bufferedBytes: number,
  reject: RejectOutboundFrame,
): boolean {
  if (serializedBytes > MAX_WEBSOCKET_OUTBOUND_FRAME_BYTES) {
    reject(1009, "Server frame is too large");
    return false;
  }
  if (bufferedBytes + serializedBytes > MAX_WEBSOCKET_BUFFERED_BYTES) {
    reject(1013, "Client is too slow");
    return false;
  }
  return true;
}
