import { useId } from "react";
import type { WorkflowArtifactView, WorkflowInstanceDetail } from "@wollipog/protocol";
import { statusMeta } from "../status-meta.js";
import { formatFuture } from "../format.js";
import {
  artifactNoun,
  attemptFailureSentence,
  attemptsLabel,
  attemptStatusLabel,
  gateArtifact,
  gateInput,
  isRetry,
  rolesSentence,
  stepError,
  stepOutcomeLabel,
  stepsAfter,
  stepSubline,
  stepWaitLine,
  type WorkflowStep,
} from "../workflow-steps.js";
import { ArtifactRow } from "./ArtifactPreview.js";
import { Notice } from "./Notice.js";
import { StatusBadge, statusToneClass } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * A workflow run's side column (#2977, component-local `.wf-steps` per docs/design-system.md §19.4,
 * since `.steps` is the stepper): the numbered steps on a connecting rail, then the panel for the
 * selected step, which says what a decision approves, when a retry opens and what a waiting step
 * waits for.
 */

/** The steps in order. Each is its role, a sub-line and one badge; its marker takes the badge's tone,
 * so amber marks only a step awaiting a decision. The step shown in the panel is `aria-current`. */
export function WorkflowSteps({ steps, selectedId, agentOf, onSelect }: {
  steps: readonly WorkflowStep[];
  selectedId: string | null;
  /** An agent step's agent by its display name on this run's page. */
  agentOf: (step: WorkflowStep) => string | null;
  onSelect: (nodeId: string) => void;
}) {
  return (
    <ol className="wf-steps" aria-label="Steps">
      {steps.map((step) => {
        const meta = statusMeta("workflowNode", step.state.status);
        const selected = step.nodeId === selectedId;
        return (
          <li key={step.nodeId} className={`wf-step ${statusToneClass(meta.tone)}`}>
            <button
              type="button"
              className="wf-step-button"
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(step.nodeId)}
            >
              <span className="wf-step-marker" aria-hidden="true">{step.number}</span>
              <span className="wf-step-body">
                <span className="wf-step-role"><span className="sr-only">Step {step.number}: </span>{step.role}</span>
                <span className="wf-step-sub">{stepSubline(step, agentOf(step))}</span>
              </span>
              <StatusBadge meta={meta} className="wf-step-status" />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** "Build and Review, version 2. 3 of 24 transitions used." */
export function workflowSummary(workflow: WorkflowInstanceDetail): string {
  return `${workflow.definition.name}, version ${workflow.workflowVersion}. ${workflow.transitionCount} of ${workflow.definition.maxTransitions} transitions used.`;
}

export interface StepPanelActions {
  /** Start <Role> and Retry <Role>: `dispatchNode`. */
  dispatch: (step: WorkflowStep) => void;
  /** Continue: `resolveGate("success")`. */
  approve: (step: WorkflowStep) => void;
  /** Reject…: the confirmation, then `resolveGate("failure")`. */
  reject: (step: WorkflowStep, artifact: WorkflowArtifactView | null) => void;
  openArtifact: (artifact: WorkflowArtifactView) => void;
}

/**
 * The selected step's panel: its notice, if it needs the person, then its facts. A waiting gate names
 * the artifact it approves with Continue and Reject…; a ready agent step offers Start <Role>; a
 * delayed retry says when Retry opens; a waiting step says what it waits for. Each notice belongs to
 * its own step, never to a step downstream of it.
 */
export function WorkflowStepPanel({ step, steps, workflow, agent, artifacts, now, busy, actions }: {
  step: WorkflowStep;
  steps: readonly WorkflowStep[];
  workflow: WorkflowInstanceDetail;
  /** The step's agent by its display name, for an agent step whose member is known. */
  agent: string | null;
  artifacts: readonly WorkflowArtifactView[];
  /** The retry clock: a delayed retry's words and its button follow it. */
  now: number;
  /** The step whose dispatch or decision is in flight, if any. */
  busy: string | null;
  actions: StepPanelActions;
}) {
  const reasonId = `wf-retry-reason-${useId().replace(/:/g, "")}`;
  const { node, state } = step;
  const edges = workflow.definition.edges;
  const anyBusy = busy !== null;
  const mine = busy === step.nodeId;
  const outcome = stepOutcomeLabel(step);
  const latest = step.attempts.at(-1);
  const error = stepError(step);
  const details = error ? <p className="wf-panel-error">{error}</p> : undefined;

  let notice = null;
  if (node.kind !== "agent" && state.status === "waiting_gate") {
    const input = gateInput(node);
    const noun = input ? artifactNoun(input.kind) : null;
    const artifact = gateArtifact(step, steps, artifacts);
    const next = stepsAfter(step, steps, edges, "success");
    notice = (
      <Notice
        tone="warning"
        title="Your Decision Is Needed"
        actions={(
          <>
            <BusyButton className="btn primary sm" busy={mine} progress="Continuing the run…" disabled={anyBusy && !mine} onClick={() => actions.approve(step)}>
              Continue
            </BusyButton>
            <button type="button" className="btn sm" disabled={anyBusy} onClick={() => actions.reject(step, artifact)}>Reject…</button>
          </>
        )}
      >
        <p>
          {noun ? `Continue approves the ${noun}` : "Continue lets the run go on"}
          {next.length ? ` and starts ${rolesSentence(next)}.` : "."}
        </p>
        {artifact ? (
          <div className="surface wf-gate-artifact">
            <ArtifactRow artifact={artifact} now={now} showAuthor onOpen={() => actions.openArtifact(artifact)} />
          </div>
        ) : noun && <p className="wf-panel-line">The {noun} isn't among this run's artifacts yet.</p>}
      </Notice>
    );
  } else if (isRetry(step)) {
    const delayed = state.readyAt !== undefined && state.readyAt > now;
    notice = (
      <Notice
        tone="danger"
        title="Last Attempt Failed"
        details={details}
        actions={(
          <BusyButton
            className="btn sm"
            busy={mine}
            progress={`Retrying the ${step.role.toLowerCase()}…`}
            disabled={delayed || (anyBusy && !mine)}
            aria-describedby={delayed ? reasonId : undefined}
            onClick={() => actions.dispatch(step)}
          >
            Retry {step.role}
          </BusyButton>
        )}
      >
        <p>{attemptFailureSentence(step)}</p>
        {/* Why Retry is unavailable, as a visible line in the body it references (§13.2). */}
        {delayed && <p className="wf-panel-reason" id={reasonId}>Available at {formatFuture(state.readyAt!, now)}</p>}
      </Notice>
    );
  } else if (node.kind === "agent" && state.status === "ready") {
    notice = (
      <Notice
        tone="info"
        title={`${step.role} Is Ready`}
        actions={(
          <BusyButton className="btn primary sm" busy={mine} progress={`Starting the ${step.role.toLowerCase()}…`} disabled={anyBusy && !mine} onClick={() => actions.dispatch(step)}>
            Start {step.role}
          </BusyButton>
        )}
      >
        {stepSubline(step, agent)} once you start it.
      </Notice>
    );
  } else if (node.kind === "agent" && state.status === "failed") {
    // A rejected gate is a decision, not a failure: its Decision fact says Rejected.
    notice = (
      <Notice tone="danger" title={`${step.role} Failed`} details={details}>
        {attemptFailureSentence(step)}{workflow.status === "failed" ? " The run ended here." : ""}
      </Notice>
    );
  }

  return (
    <section className="wf-panel" aria-label={`${step.role} Step`}>
      <h2 className="wf-panel-head">{step.role}</h2>
      {state.status === "pending" && <p className="wf-panel-line">{stepWaitLine(step, steps, edges)}</p>}
      {notice}
      {node.kind === "agent" ? (
        <dl className="facts">
          <div><dt>Agent</dt><dd>{agent ?? "Not known yet"}</dd></div>
          <div><dt>Attempts</dt><dd>{attemptsLabel(step)}</dd></div>
          {latest && <div><dt>Last Attempt</dt><dd>{attemptStatusLabel(latest.status)}</dd></div>}
          {outcome && <div><dt>Outcome</dt><dd>{outcome}</dd></div>}
        </dl>
      ) : outcome && (
        <dl className="facts">
          <div><dt>Decision</dt><dd>{outcome}</dd></div>
        </dl>
      )}
    </section>
  );
}
