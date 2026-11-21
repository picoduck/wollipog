import { useId, type ReactNode } from "react";
import { threadSpendingCopy, type ThreadSpendingState } from "../assistant-thread-spending.js";
import { formatUsd } from "../guardrail-values.js";
import { Notice } from "./Notice.js";

export function AssistantSpendingNotice({ state, trailing, onRaise, onSettings, onStop, onBreakdown, onDismiss, canStop }: {
  state: ThreadSpendingState;
  trailing: ReactNode;
  onRaise: () => void;
  onSettings: () => void;
  onStop: () => void;
  onBreakdown: () => void;
  onDismiss: () => void;
  canStop: boolean;
}) {
  const { kind, used, limit } = state;
  const paused = kind === "launch_paused";
  const launches = kind === "launch_limit" || paused;
  const over = kind === "over_budget";
  const exhausted = kind === "budget_used_up" || kind === "budget_committed";
  const near = kind === "near_budget";
  const stopReason = useId();
  const { title, message } = threadSpendingCopy(state);
  const display = launches ? String : formatUsd;
  const max = Math.max(used, limit ?? 0) || 1;
  const fillPercent = limit === 0 && used === 0 ? 100 : 100 * Math.min(used, limit ?? 0) / max;
  return <Notice className="assistant-spending-notice" tone={over ? "danger" : "warning"} role="status"
    title={title} trailing={trailing} compact={near || launches}
    onDismiss={near ? onDismiss : undefined} dismissLabel="Dismiss Near Budget"
    actions={<>
      <button className="btn sm" type="button" onClick={onRaise}>{paused ? "Manage Launches…" : launches ? "Raise Limit…" : "Raise Budget…"}</button>
      {exhausted && <button className="btn sm ghost" type="button" onClick={onSettings}>Thread Settings</button>}
      {over && <>
        <button className="btn sm" type="button" onClick={onStop} disabled={!canStop}
          aria-describedby={canStop ? undefined : stopReason}>Stop Launched Sessions…</button>
        <button className="btn sm ghost" type="button" onClick={onBreakdown}>Show Breakdown</button>
      </>}
    </>}>
    <p>{message}</p>
    {limit !== null && <div className="assistant-spending-meter">
      <div className={over ? "meter t-danger" : "meter t-warning"} role="meter"
        aria-label={launches ? "Session Launches" : "Budget"} aria-valuemin={0} aria-valuemax={max}
        aria-valuenow={used} aria-valuetext={display(used) + " of " + display(limit) + (launches ? " session launches used" : " spent")}>
        <span style={{ width: fillPercent + "%" }} />
        {over && <span className="assistant-spending-overflow" style={{ width: (100 - fillPercent) + "%" }} />}
      </div>
      {over && <span className="assistant-spending-total" aria-hidden="true">{formatUsd(used)} of {formatUsd(limit)} spent</span>}
    </div>}
    {over && !canStop && <p className="notice-meta" id={stopReason}>There are no running sessions to stop.</p>}
  </Notice>;
}
