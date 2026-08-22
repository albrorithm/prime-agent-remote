import { describe, expect, it } from "vitest";
import {
  executeSessionSlashCommandRequestSchema,
  sendMessageRequestSchema,
  SESSION_SLASH_COMMAND_NAMES,
} from "./protocol";

const valid = {
  requestId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 3,
  name: "goal",
  args: "status",
};

describe("session slash command requests", () => {
  it("accepts the four session-owned commands", () => {
    for (const name of SESSION_SLASH_COMMAND_NAMES) {
      expect(executeSessionSlashCommandRequestSchema.safeParse({ ...valid, name }).success).toBe(true);
    }
  });

  it("keeps slash input out of the ordinary prompt endpoint", () => {
    expect(sendMessageRequestSchema.safeParse({
      requestId: valid.requestId,
      expectedRevision: 3,
      text: "/model gpt",
      images: [],
    }).success).toBe(false);
  });

  it("rejects client-only, multiline, oversized, and extra input", () => {
    expect(executeSessionSlashCommandRequestSchema.safeParse({ ...valid, name: "model" }).success).toBe(false);
    for (const separator of ["\r", "\n", "\u2028", "\u2029"]) {
      expect(executeSessionSlashCommandRequestSchema.safeParse({ ...valid, args: `status${separator}now` }).success).toBe(false);
    }
    expect(executeSessionSlashCommandRequestSchema.safeParse({ ...valid, args: "x".repeat(4_001) }).success).toBe(false);
    expect(executeSessionSlashCommandRequestSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});
