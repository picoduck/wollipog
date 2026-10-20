import { useEffect, useRef, useState } from "react";
import type { AutomationExecution, AutomationSpec } from "@wollipog/protocol";
import {
  attemptsLabel,
  deliveredLabel,
  newestRunsFirst,
  oneSentence,
  RUN_HISTORY_PAGE,
  runDuration,
  runOpenTarget,
  runReason,
  runStartedAt,
  runStartedBy,
  runStepLabel,
  runStepStatus,
  startedBySignedTrigger,
} from "../automation-runs.js";
import { formatCalendarTime } from "../format.js";
import type { View } from "../navigation.js";
import { statusMeta } from "../status-meta.js";
import { ChevronRightIcon } from "./Icons.js";
import { ListFoot } from "./ListFoot.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { OneLineCodeWell } from "./OneLineCodeWell.js";
import { ActionsMenu } from "./PageHeader.js";
import { StatusBadge } from "./StatusBadge.js";

/** The longest one-line error Run Details' notice shows whole. */
const NOTICE_LIMIT = 240;

/** "Today, 2:00 AM", or a dash when there is no time. */
function when(value: number | undefined, now: number): string {
  return value === undefined ? "—" : formatCalendarTime(value, now);
}

/**
 * Run History (#2970, docs/design-system.md §14): every run of the automation, newest first, as a
 * table of Started, Result, Started By and Took in words, with Open Session (or Open Run) and ⋯ with
 * Run Details…. Ten rows show, and Show More adds ten. On a phone, and in any container under
 * 560px, each run is two lines: its start and result, then who started it and how long it took, or
 * why a skipped or expired run did not run. With no runs yet it is one quiet line naming the first.
 */
export function AutomationRunHistory({ executions, now, nextRun, policy, onOpen, onDetails }: {
  executions: readonly AutomationExecution[];
  now: number;
  /** When the first run is, in words; null when it is paused or has no next run. */
  nextRun: string | null;
  /** The automation's current runner policy: an expired run's limit when its own spec is absent. */
  policy: AutomationSpec["runnerPolicy"];
  onOpen: (view: View) => void;
  onDetails: (executionId: string) => void;
}) {
  const [shown, setShown] = useState(RUN_HISTORY_PAGE);
  const tableRef = useRef<HTMLTableElement>(null);
  // Show More's last press removes it: focus moves to the first run it revealed (§16.1).
  const focusRow = useRef<number | null>(null);
  useEffect(() => {
    const index = focusRow.current;
    focusRow.current = null;
    if (index === null) return;
    tableRef.current?.querySelectorAll<HTMLElement>("tbody tr")[index]
      ?.querySelector<HTMLElement>(".actions-cell button")?.focus();
  }, [shown]);

  if (executions.length === 0) {
    return (
      <p className="automation-empty">
        {nextRun ? `No runs yet. The first run is ${nextRun}.` : "No runs yet."}
      </p>
    );
  }
  const runs = newestRunsFirst(executions);
  const visible = runs.slice(0, shown);
  const remaining = runs.length - visible.length;
  const showMore = () => {
    if (remaining <= RUN_HISTORY_PAGE) focusRow.current = visible.length;
    setShown((count) => count + RUN_HISTORY_PAGE);
  };
  return (
    <>
      <div className="table-wrap">
        <table className="table automation-runs" aria-labelledby="automation-history" ref={tableRef}>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col" className="col-result">Result</th>
              <th scope="col" className="col-started-by">Started By</th>
              <th scope="col" className="col-took num">Took</th>
              <th scope="col" className="col-actions actions-cell"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((execution) => {
              const started = when(runStartedAt(execution), now);
              const took = runDuration(execution);
              const reason = runReason(execution, policy);
              const open = runOpenTarget(execution);
              return (
                <tr key={execution.executionId} data-execution-id={execution.executionId}>
                  <th scope="row">{started}</th>
                  <td className="cell-status"><StatusBadge inline meta={statusMeta("automation_run", execution.status)} /></td>
                  <td className="cell-meta">{runStartedBy(execution)}</td>
                  {/* On a phone a run with no duration yet (or ever) leaves it off line 2. */}
                  <td className={took ? "cell-meta num" : "cell-meta num cell-extra"}>
                    {took ? <><span className="cell-label">Took </span>{took}</> : "—"}
                  </td>
                  {reason && <td className="cell-meta cell-fill automation-run-reason">{reason}</td>}
                  <td className="actions-cell">
                    <span className="automation-run-actions">
                      {open && (
                        <button type="button" className="btn sm ghost" onClick={() => onOpen(open.view)}>{open.label}</button>
                      )}
                      <ActionsMenu
                        size="sm"
                        label={`Run Actions, ${started}`}
                        items={[{ label: "Run Details…", onClick: () => onDetails(execution.executionId) }]}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {remaining > 0 && (
        <ListFoot>
          <button type="button" className="btn sm ghost" onClick={showMore}>
            {`Show ${Math.min(remaining, RUN_HISTORY_PAGE)} More`}
          </button>
        </ListFoot>
      )}
    </>
  );
}

/**
 * Run Details (#2970, §7.1–§7.3, a sheet on phones): one run's facts, its steps with their attempts
 * and last error in one sentence, its error as a notice with the raw text behind Show Details, and
 * its run key only under Show Technical Details. Read-only, so its footer is Open Session (or Open
 * Run) and Done.
 */
export function RunDetailsDialog({ execution, now, policy, machineLabel, onOpen, onClose }: {
  execution: AutomationExecution;
  now: number;
  policy: AutomationSpec["runnerPolicy"];
  machineLabel: (runnerId: string) => string | undefined;
  onOpen: (view: View) => void;
  onClose: () => void;
}) {
  const reason = runReason(execution, policy);
  const took = runDuration(execution);
  const open = runOpenTarget(execution);
  const signed = startedBySignedTrigger(execution);
  const steps = [...execution.commands ?? []].sort((a, b) => a.ordinal - b.ordinal);
  const legacy = steps.length === 0 && execution.deliveryMode === "legacy_at_most_once";
  const finished = execution.completedAt !== undefined ? when(execution.completedAt, now)
    : execution.status === "dispatching" || execution.status === "running" ? "Not yet" : "—";
  // Only a failure or an expiry has an error worth reading; a skip's is an internal message whose
  // cause the Result already says.
  const error = execution.error && (execution.status === "failed" || execution.status === "expired")
    ? execution.error.trim() : "";
  // A notice body holds one or two sentences (§13.2): a short one-line error reads whole, as the
  // shared waiting sentences do; anything longer reads its first sentence, the rest behind Show Details.
  const errorSummary = !error ? "" : error.includes("\n") || error.length > NOTICE_LIMIT ? oneSentence(error) : error;
  return (
    <Modal
      title={when(runStartedAt(execution), now)}
      onClose={onClose}
      className="automation-run-details"
      footer={<>
        {open && (
          <button type="button" className="btn ghost" onClick={() => { onClose(); onOpen(open.view); }}>{open.label}</button>
        )}
        <button type="button" className="btn" onClick={onClose}>Done</button>
      </>}
    >
      {error && (
        <Notice
          tone={execution.status === "failed" ? "danger" : "warning"}
          details={errorSummary !== error ? <div className="code-well"><pre>{error}</pre></div> : undefined}
        >
          {errorSummary}
        </Notice>
      )}
      <dl className="facts">
        <div>
          <dt>Result</dt>
          <dd>
            <StatusBadge inline meta={statusMeta("automation_run", execution.status)} />
            {reason && <span className="automation-run-reason">{reason}</span>}
          </dd>
        </div>
        <div><dt>{signed ? "Received" : "Scheduled For"}</dt><dd>{when(execution.scheduledFor, now)}</dd></div>
        <div><dt>Started</dt><dd>{execution.startedAt !== undefined ? when(execution.startedAt, now) : "Didn't start"}</dd></div>
        <div><dt>Finished</dt><dd>{finished}</dd></div>
        <div><dt>Took</dt><dd className="num">{took ?? "—"}</dd></div>
        <div><dt>Started By</dt><dd>{runStartedBy(execution)}</dd></div>
        {execution.runnerId && (
          <div><dt>Machine</dt><dd>{machineLabel(execution.runnerId) ?? "A machine that isn't connected"}</dd></div>
        )}
        {execution.triggerDelivery && (
          <div><dt>Delivered</dt><dd>{deliveredLabel(execution.triggerDelivery)}</dd></div>
        )}
      </dl>
      {(steps.length > 0 || legacy) && (
        <section className="automation-run-steps-section" aria-labelledby="automation-run-steps">
          <h3 className="section-title" id="automation-run-steps">Steps</h3>
          {legacy ? <p className="automation-run-legacy">Sent once, without delivery receipts.</p> : (
            <ul className="automation-run-steps">
              {steps.map((step) => (
                <li key={step.commandId}>
                  <span className="automation-run-step-line">
                    <span className="automation-run-step-kind">{runStepLabel(step.kind)}</span>
                    <StatusBadge inline meta={statusMeta("automation_step", runStepStatus(step))} />
                    <span className="automation-run-step-meta">{attemptsLabel(step.attemptCount)}</span>
                  </span>
                  {step.lastError && <span className="automation-run-step-error">{oneSentence(step.lastError)}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <details className="disclosure">
        <summary><ChevronRightIcon className="disclosure-chevron" />Show Technical Details</summary>
        <div className="disclosure-body">
          <div className="field">
            <span className="field-label">Run Key</span>
            <OneLineCodeWell value={execution.idempotencyKey} name="Run Key" />
          </div>
        </div>
      </details>
    </Modal>
  );
}
