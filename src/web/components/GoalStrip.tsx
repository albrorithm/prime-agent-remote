import { ChevronDown, Clock3, Gauge, Target } from "lucide-react";
import type { AgentGoal } from "../../protocol";
import { formatCoarseDuration } from "../duration";

function statusLabel(status: AgentGoal["status"]): string {
  return status === "budget_limited" ? "Budget limited" : status[0].toUpperCase() + status.slice(1);
}

export function GoalStrip({ goal }: { goal?: AgentGoal }) {
  if (!goal) return null;
  const progress = goal.tokenBudget && goal.tokenBudget > 0
    ? Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100))
    : null;
  return (
    <details className="goal-strip" data-gesture-exclusion>
      <summary>
        <Target aria-hidden="true" />
        <span className="goal-copy"><small>Goal</small><strong>{goal.objective}</strong></span>
        <span className={`goal-status ${goal.status}`}>{statusLabel(goal.status)}</span>
        {progress !== null && (
          <span className="goal-meter" aria-hidden="true" style={{ "--goal-progress": `${progress}%` } as React.CSSProperties} />
        )}
        <ChevronDown className="goal-chevron" aria-hidden="true" />
      </summary>
      <div className="goal-detail">
        {progress !== null && (
          <div className="goal-progress">
            <span><Gauge aria-hidden="true" /> Token budget</span><strong>{progress}%</strong>
            <div role="progressbar" aria-label="Goal token budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          </div>
        )}
        <span><Clock3 aria-hidden="true" /> {formatCoarseDuration(goal.timeUsedSeconds)}</span>
        <span>{goal.continuationsUsed} continuation{goal.continuationsUsed === 1 ? "" : "s"}</span>
        {goal.lastReason && <p>{goal.lastReason}</p>}
        {goal.lastError && <p className="goal-error">{goal.lastError}</p>}
      </div>
    </details>
  );
}
