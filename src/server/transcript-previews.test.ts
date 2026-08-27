import { describe, expect, it } from "vitest";
import { sanitizeTranscriptPreview, summarizeToolCall, thinkingRecap } from "./transcript-previews.js";

function hasNoLoneSurrogate(value: string): boolean {
  return [...value].every((char) => {
    const point = char.codePointAt(0) ?? 0;
    return point < 0xd800 || point > 0xdfff;
  });
}

describe("thinkingRecap", () => {
  it("uses the last Markdown section heading and removes its formatting", () => {
    expect(thinkingRecap("Opening note\n\n**Planning checks**\nDetails\n\n### Running validation"))
      .toBe("Running validation");
  });
});

describe("tool transcript previews", () => {
  it("summarizes bash cells without retaining their output", () => {
    const summary = summarizeToolCall(
      { type: "toolCall", name: "ipython", arguments: { code: "%%bash\nset -o pipefail\nnpm run test" } },
      {
        role: "toolResult",
        content: [{ type: "text", text: "full output stays server-side" }],
        details: { status: "ok", durationMs: 1250, stdout: "line one\nline two" },
      },
    );

    expect(summary).toEqual({
      label: "bash",
      text: "npm test",
      meta: "↑ 2 ↓ 2 lines · 1.3s",
      status: "complete",
    });
    expect(JSON.stringify(summary)).not.toContain("full output");
    expect(JSON.stringify(summary)).not.toContain("line one");
  });

  it("shows a safe error name without forwarding error output", () => {
    const summary = summarizeToolCall(
      { type: "toolCall", name: "ipython", arguments: { code: "run_check()" } },
      {
        role: "toolResult",
        isError: true,
        content: [{ type: "text", text: "long traceback remains hidden" }],
        details: { status: "error", durationMs: 8, error: { ename: "CheckError", traceback: ["hidden"] } },
      },
    );

    expect(summary.status).toBe("failed");
    expect(summary.meta).toBe("↑ 1 ↓ 1 lines · 8ms · CheckError");
    expect(JSON.stringify(summary)).not.toContain("traceback");
  });

  it("uses deny-by-default input previews for private literals and credentials", () => {
    const samples = [
      sanitizeTranscriptPreview('{"Authorization": "Bearer sensitive-value"}'),
      summarizeToolCall({ type: "toolCall", name: "ipython", arguments: { code: "send({\"Authorization\": \"Bearer sensitive-value\"})" } }).text,
      summarizeToolCall({ type: "toolCall", name: "ipython", arguments: { code: "%%bash\ncurl https://account:sensitive-value@example.invalid/private" } }).text,
      summarizeToolCall({ type: "toolCall", name: "search", arguments: { query: "sensitive-value" } }).text,
    ];

    expect(samples.every((sample) => !sample.includes("sensitive-value"))).toBe(true);
    expect(samples[1]).toBe("send(…)");
    expect(samples[2]).toBe("curl <target>");
    expect(samples[3]).toBe("search call");
    expect(sanitizeTranscriptPreview("read /home/example/project API_TOKEN='value'"))
      .toBe("read ~/project API_TOKEN=<redacted>");
  });

  // An apostrophe is not a quote. Pairing the one in "There'll" with the one in
  // "I'll" used to redact the whole span between them, which ate most of a
  // prose preview: "There'<redacted>'ll ...".
  it("leaves contractions in prose alone", () => {
    expect(sanitizeTranscriptPreview("There'll skip the .research directory, so I'll read the hook"))
      .toBe("There'll skip the .research directory, so I'll read the hook");
    expect(sanitizeTranscriptPreview("I'm checking the app shell layout CSS and the viewport hook"))
      .toBe("I'm checking the app shell layout CSS and the viewport hook");
    expect(sanitizeTranscriptPreview("it doesn't fit, the user's request wasn't clear"))
      .toBe("it doesn't fit, the user's request wasn't clear");
  });

  // ...and narrowing what counts as a literal must not narrow what is redacted.
  it("still redacts single-quoted literals wherever one can actually open", () => {
    expect(sanitizeTranscriptPreview("run --password='hunter2'")).toBe("run --password=<redacted>");
    expect(sanitizeTranscriptPreview("export SECRET='abc def'")).toBe("export SECRET=<redacted>");
    expect(sanitizeTranscriptPreview("echo 'private sentence here'")).toBe("echo '<redacted>'");
    expect(sanitizeTranscriptPreview("call('private sentence here')")).toBe("call('<redacted>')");
    // The allow-list is unchanged: a path literal still survives, quotes and
    // all, and a bare identifier is still redacted — this module is
    // deny-by-default and narrowing what counts as a quote does not change that.
    expect(sanitizeTranscriptPreview("sed -n '1,40p' 'src/web/styles.css'"))
      .toBe("sed -n '<redacted>' 'src/web/styles.css'");
    expect(sanitizeTranscriptPreview("grep -rn 'visualViewport' src")).toBe("grep -rn '<redacted>' src");
  });
});

describe("truncate() grapheme safety", () => {
  const FAMILY_ZWJ = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // 👨‍👩‍👧‍👦
  const COMBINING_E = "é"; // "e" + combining acute accent
  const FLAG_PAIR = "\u{1F1FA}\u{1F1F8}"; // 🇺🇸 regional indicator pair

  it("keeps every result free of unpaired surrogates, regardless of where the cut lands", () => {
    const samples = [
      sanitizeTranscriptPreview("a".repeat(18) + "\u{1F389}" + " more text after the emoji to force truncation", 20),
      sanitizeTranscriptPreview("a".repeat(10) + FAMILY_ZWJ + " and then plenty more words after to push past threshold", 20),
      sanitizeTranscriptPreview("a".repeat(18) + COMBINING_E + " padding words to exceed threshold nicely and reliably", 20),
      sanitizeTranscriptPreview("a".repeat(17) + COMBINING_E + " padding words to exceed threshold nicely and reliably", 20),
      sanitizeTranscriptPreview("a".repeat(16) + FLAG_PAIR + " padding words to exceed threshold nicely and reliably", 20),
      sanitizeTranscriptPreview("a".repeat(15) + FLAG_PAIR + " padding words to exceed threshold nicely and reliably", 20),
      sanitizeTranscriptPreview("\u{1F600}‍\u{1F600}‍\u{1F600}‍\u{1F600}‍\u{1F600}‍\u{1F600}‍\u{1F600}‍\u{1F600}", 20),
    ];
    for (const sample of samples) {
      expect(hasNoLoneSurrogate(sample)).toBe(true);
    }
  });

  it("excludes an astral emoji entirely rather than splitting its surrogate pair", () => {
    expect(sanitizeTranscriptPreview("a".repeat(18) + "\u{1F389}" + " more text after the emoji to force truncation", 20))
      .toBe(`${"a".repeat(18)}…`);
  });

  it("never splits a ZWJ sequence — it is excluded as a whole cluster when it doesn't fit", () => {
    expect(sanitizeTranscriptPreview("a".repeat(10) + FAMILY_ZWJ + " and then plenty more words after to push past threshold", 20))
      .toBe(`${"a".repeat(10)}…`);
  });

  it("never separates a combining mark from its base character", () => {
    // The cluster doesn't fit at all: excluded together, not left as a bare "e".
    expect(sanitizeTranscriptPreview("a".repeat(18) + COMBINING_E + " padding words to exceed threshold nicely and reliably", 20))
      .toBe(`${"a".repeat(18)}…`);
    // The cluster does fit: base and mark travel together.
    expect(sanitizeTranscriptPreview("a".repeat(17) + COMBINING_E + " padding words to exceed threshold nicely and reliably", 20))
      .toBe(`${"a".repeat(17)}${COMBINING_E}…`);
  });

  it("never splits a regional-indicator flag pair", () => {
    // Doesn't fit: excluded together, not left as one dangling regional indicator.
    expect(sanitizeTranscriptPreview("a".repeat(16) + FLAG_PAIR + " padding words to exceed threshold nicely and reliably", 20))
      .toBe(`${"a".repeat(16)}…`);
    // Fits: both regional indicators travel together.
    expect(sanitizeTranscriptPreview("a".repeat(15) + FLAG_PAIR + " padding words to exceed threshold nicely and reliably", 20))
      .toBe(`${"a".repeat(15)}${FLAG_PAIR}…`);
  });

  it("returns just the ellipsis when not even one whole grapheme fits the budget", () => {
    const oneHugeCluster = Array.from({ length: 8 }, () => "\u{1F600}").join("‍");
    expect(sanitizeTranscriptPreview(oneHugeCluster, 20)).toBe("…");
  });

  it("still truncates plain ASCII exactly as before (no behavior change for the common case)", () => {
    const value = "word ".repeat(40).trim();
    expect(sanitizeTranscriptPreview(value, 30)).toBe(`${value.slice(0, 29).trimEnd()}…`);
  });
});
