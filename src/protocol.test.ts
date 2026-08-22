import { describe, expect, it } from "vitest";
import {
  executeSlashCommandRequestSchema,
  sendMessageRequestSchema,
  EXECUTABLE_SLASH_COMMAND_NAMES,
} from "./protocol";

const valid = {
  requestId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 3,
  name: "goal",
  args: "status",
};

describe("slash command requests", () => {
  it("accepts the explicitly executable commands", () => {
    for (const name of EXECUTABLE_SLASH_COMMAND_NAMES) {
      expect(executeSlashCommandRequestSchema.safeParse({ ...valid, name }).success).toBe(true);
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

  it("accepts conservative command tokens but rejects malformed, multiline, oversized, and extra input", () => {
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, name: "settings" }).success).toBe(true);
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, name: "detected-extension" }).success).toBe(true);
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, name: "../../invalid" }).success).toBe(false);
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, name: "bad command" }).success).toBe(false);
    for (const separator of ["\r", "\n", "\u2028", "\u2029"]) {
      expect(executeSlashCommandRequestSchema.safeParse({ ...valid, args: `status${separator}now` }).success).toBe(false);
    }
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, args: "x".repeat(4_001) }).success).toBe(false);
    expect(executeSlashCommandRequestSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});
