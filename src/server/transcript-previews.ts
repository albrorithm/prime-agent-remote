import type { ActivityStatus } from "../protocol.js";

type UnknownRecord = Record<string, unknown>;

export interface ToolTranscriptSummary {
  label: string;
  text: string;
  meta?: string;
  status: ActivityStatus;
}

const PYTHON_IMPORT = /^\s*(?:import\s+\S|from\s+\S+\s+import\s+)/;
const PYTHON_DEFINITION = /^\s*(?:async\s+def|def|class)\s+/;
const PYTHON_CALL = /^\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*\(/;
const PYTHON_ASSIGNMENT_CALL = /^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^=]+)?\s*=\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*\(/;
const PYTHON_EFFECT_CALL = /^\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\.(?:write_text|write_bytes|mkdir|unlink|rename|replace|touch|append|extend|update|add|remove|discard|close|commit|execute|run)\s*\(/;
const LOW_SIGNAL_CALL = /^\s*(?:await\s+)?(?:print|len|str|repr|int|float|list|dict|set|tuple)\s*\(/;

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

function isSafeQuotedPreview(value: string): boolean {
  return /^(?:~\/|\.\.?\/|\/(?:tmp|workspace)\/)[A-Za-z0-9_./@+-]+$/.test(value)
    || /^(?:src|test|tests|packages|scripts|docs|dist)\/[A-Za-z0-9_./@+-]+$/.test(value)
    || /^node:[A-Za-z0-9_./-]+$/.test(value)
    || /^[A-Za-z0-9_.-]+\.(?:c|css|go|h|html|js|json|jsx|md|mjs|py|rs|sh|toml|ts|tsx|txt|yaml|yml)$/.test(value);
}

/* An apostrophe is not a quote.

   This used to treat ' exactly like " and `, so in ordinary prose it paired
   the apostrophe in one contraction with the apostrophe in the next and
   redacted everything between them: "There'll skip the .research directory,
   so I'll" came out as "There'<redacted>'ll". Thinking-row previews are prose
   and contractions are common, so this ate a large share of them on screen.

   A single quote therefore only opens a literal where a shell or code quote
   can actually start — at the beginning, or after whitespace or an opening
   delimiter — and only closes where one can end. An apostrophe sitting
   between two word characters is left alone. Credentials do not appear as
   word'word, so nothing that was redacted before stops being redacted:
   `--password='hunter2'`, `token='...'` and `grep 'literal'` all still pair. */
const DOUBLE_OR_BACKTICK = /"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;
const SINGLE_QUOTED = /(^|[\s=:,([{])'((?:\\.|[^'\\])*)'(?=$|[\s=:,.;!?)\]}])/g;

function redactLiteral(quote: string, content: string): string {
  return isSafeQuotedPreview(content) ? `${quote}${content}${quote}` : `${quote}<redacted>${quote}`;
}

function redactQuotedPreviews(value: string): string {
  return value
    .replace(DOUBLE_OR_BACKTICK, (literal) => redactLiteral(literal[0] ?? '"', literal.slice(1, -1)))
    .replace(SINGLE_QUOTED, (_match, lead: string, content: string) => `${lead}${redactLiteral("'", content)}`);
}

/** Keep compact previews useful without forwarding private literals, credentials, or machine paths. */
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
    .replace(/(authorization\s*:\s*(?:bearer\s+)?)[^\s,"']+/gi, "$1<redacted>")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1<redacted>");
  safe = redactQuotedPreviews(safe).replace(/\s+/g, " ").trim();
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
    if (/\b(?:python|python3)\b/.test(opener)) return previewPython(body.join("\n"));
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

function previewPython(code: string): string {
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
  return sanitizeTranscriptPreview(bestIndex >= 0 ? simplifyPython(lines[bestIndex] ?? "", lines) : "", 92);
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
    const structured = [details.stdout, details.stderr, details.result].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
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
  const bashCell = name === "ipython" ? code.match(/^(?:(?:[ \t]*\r?\n)*[ \t]*)%%bash\b[^\r\n]*(?:\r?\n|$)([\s\S]*)/) : undefined;
  const label = name === "ipython" ? (bashCell ? "bash" : "python") : sanitizeTranscriptPreview(name, 32);
  const text = name === "ipython"
    ? (bashCell ? previewBash(bashCell[1] ?? "") : previewPython(code))
    : `${sanitizeTranscriptPreview(name, 48)} call`;
  const inputCode = bashCell?.[1] ?? code;
  return {
    label,
    text: text || (running ? "waiting for code" : "no preview"),
    meta: toolMeta(lineCount(inputCode), result),
    status: resultStatus(result, running),
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
