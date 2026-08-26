import { describe, expect, it, vi } from "vitest";
import type { ServerFrame, TranscriptMessage } from "../protocol.js";
import {
  enforceOutboundFrameLimits,
  MAX_WEBSOCKET_BUFFERED_BYTES,
  MAX_WEBSOCKET_INBOUND_FRAME_BYTES,
  MAX_WEBSOCKET_OUTBOUND_FRAME_BYTES,
} from "./websocket-frames.js";

describe("WebSocket frame limits", () => {
  it("keeps coherent bounded transport ceilings", () => {
    expect(MAX_WEBSOCKET_INBOUND_FRAME_BYTES).toBe(128 * 1024);
    expect(MAX_WEBSOCKET_OUTBOUND_FRAME_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_WEBSOCKET_BUFFERED_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_WEBSOCKET_BUFFERED_BYTES).toBeGreaterThan(MAX_WEBSOCKET_OUTBOUND_FRAME_BYTES);
  });

  it("accepts frames exactly at the 16 MiB serialized boundary", () => {
    const reject = vi.fn();
    expect(enforceOutboundFrameLimits(MAX_WEBSOCKET_OUTBOUND_FRAME_BYTES, 0, reject)).toBe(true);
    expect(reject).not.toHaveBeenCalled();
  });

  it("accepts a worst-case escaped bounded Prime transcript with attachment metadata", () => {
    let remainingText = 2 * 1024 * 1024;
    const attachments = Array.from({ length: 8 }, (_, index) => ({
      id: `image_${String(index).repeat(64)}`,
      type: "image" as const,
      mimeType: "image/png" as const,
    }));
    const messages: TranscriptMessage[] = Array.from({ length: 1_000 }, (_, index) => {
      const length = Math.min(120_000, remainingText);
      remainingText -= length;
      return {
        id: `message-${index}`,
        role: "assistant",
        text: "\0".repeat(length),
        state: "complete",
        createdAt: "1970-01-01T00:00:00.000Z",
        attachments,
      };
    });
    const frame: ServerFrame = {
      type: "snapshot",
      version: 1,
      streamId: "agent:bounded",
      cursor: { epoch: "bounded", seq: 1 },
      snapshot: { revision: 1, agentId: "bounded", messages, attention: [] },
    };
    const serializedBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    const reject = vi.fn();
    expect(serializedBytes).toBeGreaterThan(12 * 1024 * 1024);
    expect(serializedBytes).toBeLessThan(MAX_WEBSOCKET_OUTBOUND_FRAME_BYTES);
    expect(enforceOutboundFrameLimits(serializedBytes, 0, reject)).toBe(true);
    expect(reject).not.toHaveBeenCalled();
  });

  it("rejects the first byte beyond the serialized boundary", () => {
    const reject = vi.fn();
    expect(enforceOutboundFrameLimits(MAX_WEBSOCKET_OUTBOUND_FRAME_BYTES + 1, 0, reject)).toBe(false);
    expect(reject).toHaveBeenCalledWith(1009, "Server frame is too large");
  });

  it("accounts for the next frame at the buffered-output boundary", () => {
    const reject = vi.fn();
    expect(enforceOutboundFrameLimits(1, MAX_WEBSOCKET_BUFFERED_BYTES - 1, reject)).toBe(true);
    expect(enforceOutboundFrameLimits(1, MAX_WEBSOCKET_BUFFERED_BYTES, reject)).toBe(false);
    expect(reject).toHaveBeenLastCalledWith(1013, "Client is too slow");
  });
});
