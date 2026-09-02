import { Check, ChevronDown, Circle, CircleAlert, LoaderCircle, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { CellOutput, PythonCellDiff, TranscriptMessage, TranscriptPresentation } from "../../protocol";
import { loadCellOutput } from "../api";
import { MemoizedCodeBlock } from "./MessageContent";

export type PythonCellPresentation = Extract<TranscriptPresentation, { kind: "python" }>;

type FullOutputState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "loaded"; cell: CellOutput };

function CellStatusIcon({ status }: { status: PythonCellPresentation["status"] }) {
  if (status === "running") return <LoaderCircle className="spin" aria-hidden="true" />;
  if (status === "complete") return <Check aria-hidden="true" />;
  if (status === "failed") return <CircleAlert aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

function CellSection({ label, text, danger }: { label: string; text: string; danger?: boolean }) {
  return (
    <section className={`python-cell-section${danger ? " danger" : ""}`}>
      <h4 className="python-cell-section-label">{label}</h4>
      <pre className="python-cell-output"><code>{text}</code></pre>
    </section>
  );
}

function CellDiff({ diff }: { diff: PythonCellDiff }) {
  const oldLines = diff.oldStr ? diff.oldStr.split("\n") : [];
  const newLines = diff.newStr ? diff.newStr.split("\n") : [];
  return (
    <section className="python-cell-section python-cell-diff">
      <h4 className="python-cell-section-label">
        <code className="python-cell-diff-path">{diff.path}</code>
        {diff.startLine !== undefined && <span className="python-cell-diff-line">line {diff.startLine}</span>}
      </h4>
      <pre className="python-cell-output"><code>
        {oldLines.map((line, index) => <span key={`old-${index}`} className="python-diff-del">{`- ${line}`}</span>)}
        {newLines.map((line, index) => <span key={`new-${index}`} className="python-diff-add">{`+ ${line}`}</span>)}
      </code></pre>
      {diff.truncated && <p className="python-cell-note">Diff truncated.</p>}
    </section>
  );
}

export interface PythonCellRowProps {
  message: TranscriptMessage;
  presentation: PythonCellPresentation;
  /** Notified when the user expands or collapses the cell. */
  onToggle?: (open: boolean) => void;
  /** Injectable for tests; defaults to the API client. */
  fetchCell?: (cellId: string) => Promise<CellOutput>;
}

/**
 * The transcript row for one Python cell — Prime Agent's only tool, so this
 * is the tool-call display. Collapsed it reads like the existing tool rows
 * (glyph · label · preview · meta); expanded it shows the highlighted code and
 * one labeled section per output stream the cell actually produced.
 */
export function PythonCellRow({ message, presentation, onToggle, fetchCell = loadCellOutput }: PythonCellRowProps) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<FullOutputState>({ phase: "idle" });

  const streaming = message.state === "streaming";
  const status = presentation.status;
  const loaded = full.phase === "loaded" ? full.cell : null;
  const code = loaded?.code ?? presentation.code ?? presentation.preview;
  const stdout = loaded?.stdout ?? presentation.stdout;
  const stderr = loaded?.stderr ?? presentation.stderr;
  const result = loaded?.result ?? presentation.result;
  const traceback = loaded?.traceback ?? presentation.error?.traceback;
  const backgroundOutput = loaded?.backgroundOutput ?? presentation.backgroundOutput;
  const anyTruncated = Boolean(
    presentation.codeTruncated
    || presentation.stdoutTruncated
    || presentation.stderrTruncated
    || presentation.resultTruncated
    || presentation.backgroundOutputTruncated
    || presentation.error?.tracebackTruncated
    || presentation.diffsTruncated,
  );

  async function fetchFull() {
    const cellId = presentation.cellId;
    if (!cellId) return;
    setFull({ phase: "loading" });
    try {
      setFull({ phase: "loaded", cell: await fetchCell(cellId) });
    } catch (error) {
      setFull({
        phase: "error",
        message: error instanceof Error && error.message ? error.message : "Couldn't load the full output",
      });
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    onToggle?.(next);
  }

  const metaSuffix = presentation.meta ? `, ${presentation.meta}` : "";
  return (
    <div className={`python-cell ${status}${streaming ? " streaming" : ""}`} data-gesture-exclusion>
      <button
        type="button"
        className="python-cell-summary"
        aria-expanded={open}
        aria-label={`${presentation.lang} cell ${status}: ${presentation.preview}${metaSuffix}`}
        onClick={toggle}
      >
        <CellStatusIcon status={status} />
        <strong className="python-cell-lang">{presentation.lang}</strong>
        <span className="python-cell-separator" aria-hidden="true">·</span>
        <code className="python-cell-preview">{presentation.preview}</code>
        {streaming && <span className="python-cell-writing">writing…</span>}
        {presentation.meta && (
          <>
            <span className="python-cell-separator" aria-hidden="true">·</span>
            <span className="python-cell-meta">{presentation.meta}</span>
          </>
        )}
        <ChevronDown className="python-cell-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="python-cell-body">
          {presentation.kernelRestarted && (
            <p className="python-cell-notice">
              <RotateCcw aria-hidden="true" /> Kernel restarted during this cell — earlier variables were lost.
            </p>
          )}
          <MemoizedCodeBlock lang={presentation.codeLang ?? presentation.lang} code={code} streaming={streaming} />
          {stdout ? <CellSection label="stdout" text={stdout} /> : null}
          {stderr ? <CellSection label="stderr" text={stderr} danger={status === "failed"} /> : null}
          {result ? <CellSection label="result" text={result} /> : null}
          {presentation.error && (
            <section className="python-cell-section danger">
              <h4 className="python-cell-section-label">traceback</h4>
              <p className="python-cell-error-name">
                <code>{presentation.error.ename}{presentation.error.evalue ? `: ${presentation.error.evalue}` : ""}</code>
              </p>
              {traceback && <pre className="python-cell-output"><code>{traceback}</code></pre>}
            </section>
          )}
          {backgroundOutput ? <CellSection label="background output (unattributed)" text={backgroundOutput} /> : null}
          {presentation.diffs?.map((diff, index) => <CellDiff key={`${diff.path}-${index}`} diff={diff} />)}
          {anyTruncated && full.phase !== "loaded" && (
            presentation.cellId ? (
              <div className="python-cell-fetch">
                <button type="button" onClick={() => void fetchFull()} disabled={full.phase === "loading"}>
                  {full.phase === "loading"
                    ? <><LoaderCircle className="spin" aria-hidden="true" /> Loading full output…</>
                    : "View full output"}
                </button>
                {full.phase === "error" && <span className="python-cell-fetch-error" role="alert">{full.message}</span>}
              </div>
            ) : (
              <p className="python-cell-note">Output shown is truncated.</p>
            )
          )}
          {loaded?.truncated && <p className="python-cell-note">Some output is still truncated on the server.</p>}
        </div>
      )}
    </div>
  );
}
