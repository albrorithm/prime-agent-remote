import { describe, expect, it } from "vitest";
import { appendQuotation, buildQuotation, quotationRoom, WHOLE_MESSAGE_QUOTE_LIMIT } from "./quote";

describe("buildQuotation", () => {
  it("prefixes a one-line body with the source line and quote marker", () => {
    const { quotation, trimmed } = buildQuotation({ text: "hello", source: "Hello.", maxChars: 1000 });
    expect(quotation).toBe("> From Hello.:\n> hello\n\n");
    expect(trimmed).toBe(false);
  });

  it("prefixes every line of a multi-line body", () => {
    const { quotation } = buildQuotation({ text: "line one\nline two\nline three", source: "Agent", maxChars: 1000 });
    expect(quotation).toBe("> From Agent:\n> line one\n> line two\n> line three\n\n");
  });

  it("quotes a blank line as a bare '>' rather than a trailing space", () => {
    const { quotation } = buildQuotation({ text: "one\n\ntwo", source: "Agent", maxChars: 1000 });
    expect(quotation).toBe("> From Agent:\n> one\n>\n> two\n\n");
  });

  it("prefers a selection over the full message text", () => {
    const { quotation } = buildQuotation({ text: "the whole message", selection: "just this part", source: "Agent", maxChars: 1000 });
    expect(quotation).toBe("> From Agent:\n> just this part\n\n");
  });

  it("falls back to the whole message when the selection is empty or blank", () => {
    const { quotation } = buildQuotation({ text: "the whole message", selection: "   ", source: "Agent", maxChars: 1000 });
    expect(quotation).toBe("> From Agent:\n> the whole message\n\n");
  });

  it("bounds a whole-message quote to the limit with an ellipsis, but leaves a selection of the same length untouched", () => {
    const long = "x".repeat(WHOLE_MESSAGE_QUOTE_LIMIT + 50);
    const whole = buildQuotation({ text: long, source: "Agent", maxChars: 10_000 });
    expect(whole.trimmed).toBe(true);
    expect(whole.quotation).toContain("…");
    expect(whole.quotation.length).toBeLessThan(long.length);

    const selected = buildQuotation({ text: "short", selection: long, source: "Agent", maxChars: 10_000 });
    expect(selected.trimmed).toBe(false);
    expect(selected.quotation).toContain(long);
  });

  it("trims further to fit a small maxChars budget and reports the trim", () => {
    const { quotation, trimmed } = buildQuotation({ text: "a fairly long message body here", source: "Agent", maxChars: 30 });
    expect(trimmed).toBe(true);
    expect(quotation.length).toBeLessThanOrEqual(30);
    expect(quotation.startsWith("> From Agent:")).toBe(true);
  });

  it("never exceeds maxChars even when the header alone would overflow it", () => {
    const { quotation, trimmed } = buildQuotation({ text: "anything", source: "A very long agent name indeed", maxChars: 5 });
    expect(quotation.length).toBeLessThanOrEqual(5);
    expect(trimmed).toBe(true);
  });

  it("returns an empty quotation when there is no room at all", () => {
    const { quotation, trimmed } = buildQuotation({ text: "anything", source: "Agent", maxChars: 0 });
    expect(quotation).toBe("");
    expect(trimmed).toBe(true);
  });
});

describe("quotationRoom", () => {
  it("gives the full budget to an empty draft", () => {
    expect(quotationRoom("", 100)).toBe(100);
  });

  it("reserves a two-character blank-line separator for a non-empty draft", () => {
    expect(quotationRoom("hello", 100)).toBe(100 - "hello".length - 2);
  });

  it("ignores trailing whitespace already on the draft when sizing the separator", () => {
    expect(quotationRoom("hello\n\n\n", 100)).toBe(quotationRoom("hello", 100));
  });

  it("never goes negative when the draft already exceeds the budget", () => {
    expect(quotationRoom("x".repeat(200), 100)).toBe(0);
  });
});

describe("appendQuotation", () => {
  it("becomes the whole draft when there was nothing before it", () => {
    expect(appendQuotation("", "> From Agent:\n> hi\n\n")).toBe("> From Agent:\n> hi\n\n");
  });

  it("separates from an existing draft with exactly one blank line", () => {
    expect(appendQuotation("my reply so far", "> From Agent:\n> hi\n\n"))
      .toBe("my reply so far\n\n> From Agent:\n> hi\n\n");
  });

  it("normalizes an existing draft's trailing whitespace before separating", () => {
    expect(appendQuotation("my reply so far\n\n\n", "> From Agent:\n> hi\n\n"))
      .toBe("my reply so far\n\n> From Agent:\n> hi\n\n");
  });

  it("returns the draft unchanged when the quotation is empty", () => {
    expect(appendQuotation("my reply so far", "")).toBe("my reply so far");
  });
});
