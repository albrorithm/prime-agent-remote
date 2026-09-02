import type { ActivityStatus } from "../protocol.js";

type UnknownRecord = Record<string, unknown>;

export interface ToolTranscriptSummary {
  label: string;
  text: string;
  meta?: string;
  status: ActivityStatus;
  /** For ipython cells: whether the row reads as a bash or a python cell. */
  lang?: "python" | "bash";
}

const PYTHON_IMPORT = /^\s*(?:import\s+\S|from\s+\S+\s+import\s+)/;
const PYTHON_DEFINITION = /^\s*(?:async\s+def|def|class)\s+/;
const PYTHON_CALL = /^\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*\(/;
const PYTHON_ASSIGNMENT_CALL = /^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^=]+)?\s*=\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*\(/;
const PYTHON_EFFECT_CALL = /^\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\.(?:write_text|write_bytes|mkdir|unlink|rename|replace|touch|append|extend|update|add|remove|discard|close|commit|execute|run)\s*\(/;
const LOW_SIGNAL_CALL = /^\s*(?:await\s+)?(?:print|len|str|repr|int|float|list|dict|set|tuple)\s*\(/;
/* Prime Agent 0.9 replaced `%%bash` cells with a `bash("…")` callable in the
   Python REPL, so a shell command now arrives as a Python string literal. Saved
   transcripts from older builds still carry `%%bash`, so both are recognised. */
const BASH_CELL_MAGIC = /^(?:(?:[ \t]*\r?\n)*[ \t]*)%%bash\b[^\r\n]*(?:\r?\n|$)([\s\S]*)/;
const BASH_CALL_OPENER = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?(?:await\s+)?bash\s*\(\s*[rR]?("""|'''|"|')/;
const PYTHON_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", "\n": "" };

/**
 * The command inside a `bash("…")` call whose first argument is one plain
 * string literal, or undefined when it is anything else (an f-string, a
 * concatenation, a variable): those fall back to the ordinary Python preview
 * rather than guess at a command.
 */
export function bashCallCommand(code: string): string | undefined {
  const opener = code.match(BASH_CALL_OPENER);
  const quote = opener?.[1];
  if (!opener || !quote) return undefined;
  const raw = /[rR]$/.test(opener[0].slice(0, -quote.length));
  let value = "";
  let index = opener[0].length;
  while (index < code.length) {
    const char = code[index] ?? "";
    if (char === "\\" && index + 1 < code.length) {
      const next = code[index + 1] ?? "";
      if (!raw && !(next in PYTHON_ESCAPES)) return undefined;
      value += raw ? char + next : PYTHON_ESCAPES[next] ?? "";
      index += 2;
      continue;
    }
    if (code.startsWith(quote, index)) {
      const rest = code.slice(index + quote.length).trimStart();
      return rest.startsWith(",") || rest.startsWith(")") ? value : undefined;
    }
    if (quote.length === 1 && char === "\n") return undefined;
    value += char;
    index += 1;
  }
  return undefined;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? value as UnknownRecord : undefined;
}

// Hoisted once: constructing an Intl.Segmenter per call is expensive and truncate()
// is the chokepoint for every preview cutoff in this module.
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  // Budget stays in UTF-16 code units so existing maxChars semantics hold, but the
  // cut point is snapped to the nearest grapheme-cluster boundary that fits, so an
  // astral emoji, ZWJ sequence, combining mark, or flag pair is never split in half.
  const budget = Math.max(1, maxChars - 1);
  let cut = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    if (cut.length + segment.length > budget) break;
    cut += segment;
  }
  const trimmed = cut.trimEnd();
  return trimmed ? `${trimmed}…` : "…";
}

/* Quoted literals are not redacted, and that is a deliberate reversal.

   This module used to replace the contents of every quoted string that did not
   match an allowlist of obvious file paths, so `grep -rn 'visualViewport' src`
   reached the phone as `grep -rn '<redacted>' src`. A tool row is a one-line
   preview and it is the *only* rendering of that command the browser gets —
   there is no expandable full text behind it — so redacting the argument does
   not hide the interesting part of the row, it removes the row's entire content
   and leaves the word "redacted" in its place. That is what the operator kept
   seeing.

   It also bought nothing. Every caller of this module renders into the
   authenticated transcript of the person whose own machine ran the command;
   there is no reader here who is not already entitled to the terminal. Push
   payloads, the one thing that does leave that surface, carry no transcript
   text at all by construction — see `push-payload.ts`.

   What survives below is the part that is worth having on any surface:
   credentials, keys, tokens and long opaque blobs, which are never useful to
   read and always bad to keep. The narrow thing given up is a secret passed in
   a form none of those patterns match, `mysql -p'literal'` being the honest
   example. Weigh that against every quoted argument in the transcript before
   putting a blanket rule back. */

/** Keep compact previews free of credentials, machine paths, and opaque blobs. */
export function sanitizeTranscriptPreview(value: string, maxChars = 120): string {
  let safe = value
    .replace(/\/(?:Users|home)\/[^/\s'"`]+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s'"`]+/gi, "~")
    .replace(/\b(?:https?|wss?|ssh):\/\/[^\s'"`]+/gi, "<url>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<address>")
    .replace(/\b(?:ssh|scp|sftp)\s+\S+/gi, (match) => `${match.split(/\s+/)[0]} <target>`)
    .replace(/(--(?:api[-_]?key|authorization|host|hostname|password|secret|token|user|username)(?:=|\s+))\S+/gi, "$1<redacted>")
    .replace(/(-u\s+)\S+/gi, "$1<redacted>")
    .replace(/(-H\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>")
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "<blob>")
    .replace(/\b((?=\w*(?:token|key|secret|password))\w+)\s*=\s*(["'])[^"']*\2/gi, "$1=<redacted>")
    .replace(/\b((?=\w*(?:token|key|secret|password))\w+)\s*=\s*(?!["'])[^\s,;]+/gi, "$1=<redacted>")
    .replace(/(["'])sk-[^"']+\1/g, "$1<redacted>$1")
    // The optional quotes matter: this header is usually met inside JSON, as
    // `{"Authorization": "Bearer …"}`, where an unquoted pattern stops at the
    // opening quote and redacts nothing. The blanket quoted-literal rule used to
    // cover for that.
    .replace(/(authorization"?\s*:\s*"?(?:bearer\s+)?)[^\s,"']+/gi, "$1<redacted>")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1<redacted>");
  safe = safe.replace(/\s+/g, " ").trim();
  return truncate(safe, Math.max(20, maxChars));
}

/** Match Prime Agent's collapsed-thinking recap rule. */
export function thinkingRecap(thinking: string, fallback = "Thinking", maxChars = 120): string {
  const lines = thinking.split("\n").map((line) => line.trim()).filter(Boolean);
  const lastHeader = [...lines].reverse().find((line) => /^\*\*[^*]+\*\*:?$/.test(line) || /^#{1,6}\s+\S/.test(line));
  const source = lastHeader ?? lines[0] ?? fallback;
  const plain = source
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/:$/, "")
    .trim();
  return sanitizeTranscriptPreview(plain || fallback, maxChars);
}

function shellWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

function simplifyBash(line: string): string {
  const words = shellWords(line);
  const command = words[0]?.split("/").at(-1) ?? "command";
  if (command === "npm" && words[1] === "run" && words[2]) return `npm ${words[2]}${words.length > 3 ? " …" : ""}`;
  if (command === "cat" && words[1] === ">" && words[2]) return `write ${words[2].replace(/^\.\//, "")}`;
  if (command === "tee" && words.at(-1)) return `${words.includes("-a") ? "append" : "write"} ${words.at(-1)}`;
  if (command === "apply_patch") return "apply patch";
  if (["ssh", "scp", "sftp", "curl", "wget"].includes(command)) return `${command} <target>`;
  const safeSubcommandTools = new Set(["git", "npm", "npx", "pnpm", "prime-agent", "pytest", "tsc", "uv", "vitest", "yarn"]);
  const subcommand = words[1];
  if (safeSubcommandTools.has(command) && subcommand && /^[A-Za-z][A-Za-z0-9:_-]*$/.test(subcommand)) {
    return `${command} ${subcommand}${words.length > 2 ? " …" : ""}`;
  }
  return `${command}${words.length > 1 ? " …" : ""}`;
}

function bashScore(line: string, index: number): number {
  const command = shellWords(line)[0] ?? "";
  let score = 30 + index;
  if (["rm", "mv", "cp", "git", "npm", "pnpm", "pytest", "vitest"].includes(command)) score += 20;
  if (/\b(?:rm|mv|cp|git\s+(?:add|commit)|npm\s+install|sed\s+-i|perl\s+-pi|tee|cat\s*>|apply_patch)\b/.test(line)) score += 40;
  return score;
}

function previewBash(code: string): string {
  const lines = code.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const opener = lines[index]?.trim() ?? "";
    const heredoc = opener.match(/<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/);
    if (!heredoc?.[1]) continue;
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length && lines[cursor]?.trim() !== heredoc[1]; cursor += 1) body.push(lines[cursor] ?? "");
    if (/\bnode\b/.test(opener)) return `node: ${sanitizeTranscriptPreview(body.find((line) => line.trim()) ?? "", 76)}`;
    if (/\b(?:python|python3)\b/.test(opener)) return previewPython(body.join("\n")).text;
    const write = opener.match(/\b(?:cat|tee)\b.*(?:>|\s)(\S+)\s*<<-?/);
    if (write?.[1]) return `${opener.includes("tee -a") ? "append" : "write"} ${write[1]}`;
  }

  let best: { text: string; score: number } | undefined;
  let index = 0;
  for (const rawLine of lines) {
    for (let part of rawLine.split(/\s*(?:&&|;)\s*/)) {
      part = part.replace(/^\s*!/, "").trim().replace(/^cd\s+[^&;|]+(?:&&|;)\s*/, "").trim();
      if (!part || /^#/.test(part) || /^set\s+[-+]/.test(part) || /^(?:export\s+\w+=|source\s+\S+|\.\s+\S+)/.test(part)) continue;
      const candidate = { text: simplifyBash(part), score: bashScore(part, index++) };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  return sanitizeTranscriptPreview(best?.text ?? "", 92);
}

function pythonScore(line: string): number {
  const trimmed = line.trim();
  if (!trimmed || /^#/.test(trimmed) || PYTHON_IMPORT.test(line) || /^@/.test(trimmed)) return -1;
  if (PYTHON_EFFECT_CALL.test(line)) return 90;
  if (BASH_CALL_OPENER.test(line)) return 88;
  if (/subprocess\.(?:run|check_call|check_output|Popen)\s*\(/.test(line)) return 85;
  if (PYTHON_DEFINITION.test(line)) return 50;
  if (PYTHON_ASSIGNMENT_CALL.test(line)) return 60;
  if (PYTHON_CALL.test(line) && !LOW_SIGNAL_CALL.test(line)) return 65;
  if (PYTHON_CALL.test(line)) return 15;
  return 30;
}

function simplifyPython(line: string, lines: readonly string[]): string {
  const trimmed = line.trim();
  const subprocess = trimmed.match(/subprocess\.(?:run|check_call|check_output|Popen)\(\s*["`]([^"`]+)["`]/);
  if (subprocess?.[1]) return simplifyBash(subprocess[1]);
  const fileCall = trimmed.match(/^(?:await\s+)?([A-Za-z_]\w*)\.(write_text|write_bytes|read_text|read_bytes|mkdir|unlink|touch)\s*\(/);
  if (fileCall?.[1] && fileCall[2]) {
    const assignment = lines.map((item) => item.match(new RegExp(`^\\s*${fileCall[1]}\\s*=\\s*(?:Path|pathlib\\.Path)\\(["']([^"']+)["']\\)`))).find(Boolean);
    if (assignment?.[1]) {
      const action = fileCall[2].startsWith("write") ? "write" : fileCall[2].startsWith("read") ? "read" : fileCall[2] === "unlink" ? "delete" : fileCall[2];
      return `${action} ${assignment[1]}`;
    }
  }
  const printCall = trimmed.match(/^print\((.*)\)$/)?.[1]?.trim();
  const candidate = printCall && PYTHON_CALL.test(printCall) ? printCall : trimmed;
  const assignmentCall = candidate.match(/^([A-Za-z_]\w*\s*=\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/);
  if (assignmentCall?.[1]) return `${assignmentCall[1]}(${assignmentCall[2]?.trim() ? "…" : ""})`;
  const call = candidate.match(/^((?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/);
  if (call?.[1]) return `${call[1]}(${call[2]?.trim() ? "…" : ""})`;
  return candidate;
}

function previewPython(code: string): { text: string; lang: "python" | "bash" } {
  const lines = code.split(/\r?\n/);
  let bestIndex = -1;
  let bestScore = -1;
  lines.forEach((line, index) => {
    const score = pythonScore(line);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });
  if (bestIndex < 0) return { text: "", lang: "python" };
  // A cell whose most interesting line runs a shell command reads as a bash
  // cell, the way the daemon's own transcript labels it. The literal may span
  // lines, so it is read from the tail of the cell rather than the one line.
  const command = bashCallCommand(lines.slice(bestIndex).join("\n"));
  if (command !== undefined) return { text: sanitizeTranscriptPreview(previewBash(command) || "bash", 92), lang: "bash" };
  return { text: sanitizeTranscriptPreview(simplifyPython(lines[bestIndex] ?? "", lines), 92), lang: "python" };
}

function codeFromArguments(value: unknown): string {
  const args = asRecord(value);
  if (!args) return "";
  for (const key of ["code", "command", "query", "path"]) {
    if (typeof args[key] === "string") return args[key];
  }
  return "";
}

function outputText(result: UnknownRecord): string {
  const details = asRecord(result.details);
  if (details) {
    const structured = [details.stdout, details.stderr, details.result, details.backgroundOutput].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    if (structured.length) return structured.join("\n");
  }
  if (!Array.isArray(result.content)) return "";
  return result.content.flatMap((part) => {
    const block = asRecord(part);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

function lineCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\r?\n/).length : 0;
}

function formatDuration(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

function resultStatus(result: UnknownRecord | undefined, running: boolean): ActivityStatus {
  if (!result) return running ? "running" : "waiting";
  const details = asRecord(result.details);
  return result.isError === true || details?.status === "error" || details?.status === "aborted" ? "failed" : "complete";
}

function toolMeta(input: number, result: UnknownRecord | undefined): string | undefined {
  const details = asRecord(result?.details);
  const hasDiffs = Array.isArray(details?.diffs) && details.diffs.length > 0;
  const output = result && !hasDiffs ? lineCount(outputText(result)) : 0;
  const counts = [input > 0 ? `↑ ${input}` : "", output > 0 ? `↓ ${output}` : ""].filter(Boolean).join(" ");
  const duration = formatDuration(details?.durationMs);
  const error = asRecord(details?.error);
  const errorName = typeof error?.ename === "string"
    ? sanitizeTranscriptPreview(error.ename, 40)
    : typeof details?.errorEname === "string"
      ? sanitizeTranscriptPreview(details.errorEname, 40)
      : undefined;
  return [counts ? `${counts} lines` : "", duration ?? "", errorName ?? ""].filter(Boolean).join(" · ") || undefined;
}

export function summarizeToolCall(call: UnknownRecord, result?: UnknownRecord, running = false): ToolTranscriptSummary {
  const name = typeof call.name === "string" ? call.name : "tool";
  const code = codeFromArguments(call.arguments);
  if (name !== "ipython") {
    return {
      label: sanitizeTranscriptPreview(name, 32),
      text: `${sanitizeTranscriptPreview(name, 48)} call`,
      meta: toolMeta(lineCount(code), result),
      status: resultStatus(result, running),
    };
  }
  const bashCell = code.match(BASH_CELL_MAGIC);
  const preview = bashCell ? { text: previewBash(bashCell[1] ?? ""), lang: "bash" as const } : previewPython(code);
  return {
    label: preview.lang,
    text: preview.text || (running ? "waiting for code" : "no preview"),
    meta: toolMeta(lineCount(bashCell?.[1] ?? code), result),
    status: resultStatus(result, running),
    lang: preview.lang,
  };
}

export function summarizeBashExecution(message: UnknownRecord): ToolTranscriptSummary {
  const command = typeof message.command === "string" ? message.command : "";
  const output = typeof message.output === "string" ? message.output : "";
  const input = lineCount(command);
  const outputLines = lineCount(output);
  const counts = [input ? `↑ ${input}` : "", outputLines ? `↓ ${outputLines}` : ""].filter(Boolean).join(" ");
  return {
    label: "bash",
    text: previewBash(command) || "command",
    meta: counts ? `${counts} lines` : undefined,
    status: message.cancelled === true || (typeof message.exitCode === "number" && message.exitCode !== 0) ? "failed" : "complete",
  };
}
