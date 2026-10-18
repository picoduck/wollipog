import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  FULL_CONTROL_EVIDENCE_EXCEPTIONS,
  FULL_CONTROL_HUMAN_REQUIRED_LABELS,
  FULL_CONTROL_STANDING_HUMAN_REQUIRED_REASON,
  WORKFLOW_DECISION_CATEGORIES,
  fullControlStandingHumanRequired,
  type CampaignAuthorityOperation,
  type CampaignControl,
  type DelegatableWorkflowDecisionCategory,
  type OrchestratorCampaignProjection,
  type OrchestratorDefaults,
  type ParentControlDecisionPolicy,
  type ParentControlMode,
  type SessionView,
  type WorkflowDecisionAuthority,
  usesOrchestratorPresetPermissions,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { ApiError } from "../api.js";
import { titleCaseLabel } from "../format.js";
import { agentHarnessIdentityLabel } from "../agent-presentation.js";
import { integrationIsolationDisclosure, ORCHESTRATOR_PRESET_INTEGRATION_DISCLOSURE } from "../session-preset-defaults.js";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE } from "../ui-evidence-disclosure.js";
import { FieldWarning } from "./FieldWarning.js";
import { CheckIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { ChoiceRows, SegmentedControl, type ChoiceRowOption } from "./ui/ChoiceControls.js";
import { SAVED_MS } from "./ui/SettingsRows.js";
import { FullControlEnableButton, FullControlEnablePanel, OrchestratorControlChoice, type FullControlEnableAction } from "./FullControlPreparation.js";

/** Who answers a descendant session's requests (§8.4 choice rows). The off choice is "Human",
 * matching each gate's Human | Orchestrator (#2192). */
export const CHILD_SESSION_REQUEST_OPTIONS: readonly ChoiceRowOption<ParentControlMode>[] = [
  { value: "off", title: "Human", description: "Keep descendant requests with a person." },
  { value: "questions", title: "Questions", description: "Delegate non-secret descendant questions." },
  { value: "questions_and_approvals", title: "Questions and Approvals", description: "Also delegate eligible one-time approvals." },
];

export const WORKFLOW_DECISION_LABELS: Record<DelegatableWorkflowDecisionCategory, string> = {
  implementation_question: "Implementation Questions",
  pr_merge: "PR Merge Approval",
  merged_branch_deletion: "Merged Branch Deletion",
  follow_up_issue_publication: "Follow-Up Issue Publication",
  ui_evidence_approval: "UI Evidence Approval",
};

const AUTHORITY_OPTIONS = [
  { value: "human", label: "Human", description: "Require a person's decision for this exact workflow gate." },
  { value: "orchestrator", label: "Orchestrator", description: "Let the controlling Orchestrator review this typed gate." },
] as const satisfies ReadonlyArray<{ value: WorkflowDecisionAuthority; label: string; description: string }>;

export const ORCHESTRATOR_CONTROLS_CONFLICT = "These controls changed elsewhere. Your change wasn't saved.";
export const ORCHESTRATOR_CONTROLS_FAILED = "Your change wasn't saved.";

/** The current Child Session Requests choice, as its option title. */
export function childSessionRequestsLabel(mode: ParentControlMode | null | undefined): string {
  return CHILD_SESSION_REQUEST_OPTIONS.find((option) => option.value === (mode ?? "off"))?.title ?? "Human";
}

/** How many workflow gates stay with a person: the + menu row's and the Pinned Summary's one line. */
export function workflowDecisionsSummary(decisions: ParentControlDecisionPolicy): string {
  const total = WORKFLOW_DECISION_CATEGORIES.length;
  const human = WORKFLOW_DECISION_CATEGORIES.filter((category) => decisions[category] !== "orchestrator").length;
  return `${human} of ${total} decisions ${human === 1 ? "stays" : "stay"} with a person.`;
}

type ControlView = Pick<SessionView, "parentSessionId" | "orchestratorPolicy" | "orchestratorCampaign">;

/** The root's control as this viewer may know it. The server projection is authoritative; a
 * descendant's copied policy is not, so a descendant without a projection has none. */
export function effectiveCampaignControl(session: ControlView): CampaignControl | undefined {
  const projected = session.orchestratorCampaign?.control !== undefined && Number.isSafeInteger(session.orchestratorCampaign.policyRevision)
    ? session.orchestratorCampaign.control : undefined;
  return projected ?? (session.parentSessionId ? undefined : session.orchestratorPolicy?.control);
}

/** The root's control mode, or "unknown" for a descendant the server has not told it to. Until it
 * is known nothing may be offered as editable: under Full Control the saved choices have no effect. */
export function campaignControlMode(session: ControlView): CampaignControl["mode"] | "unknown" {
  return effectiveCampaignControl(session)?.mode ?? (session.parentSessionId ? "unknown" : "custom");
}

export const ROOT_CONTROL_NOT_REPORTED = "The root campaign's control isn't reported.";

/** Summaries count the server's effective owners whenever it reports them: a saved choice can be
 * routed elsewhere (Full Control, or UI evidence this Orchestrator can't inspect). Without them,
 * Full Control says only "Full Control", and an unknown root never shows the copied choices. */
export function workflowDecisionsNote(session: ControlView & Pick<SessionView, "parentControlPolicy">): string | null {
  const mode = campaignControlMode(session);
  const owners = session.orchestratorCampaign?.decisionOwners;
  if (mode === "full_control") return owners ? `Full Control: ${workflowDecisionsSummary(owners)}` : "Full Control.";
  if (owners) return workflowDecisionsSummary(owners);
  if (!session.parentControlPolicy) return null;
  return mode === "unknown" ? ROOT_CONTROL_NOT_REPORTED : workflowDecisionsSummary(session.parentControlPolicy.decisions);
}

/** The Child Session Requests summary: "Full Control" while Full Control decides them, and "Not
 * Reported" while the root's control is unknown. */
export function childSessionRequestsNote(session: ControlView & Pick<SessionView, "parentControl">): string {
  const mode = campaignControlMode(session);
  return mode === "full_control" ? "Full Control" : mode === "unknown" ? "Not Reported" : childSessionRequestsLabel(session.parentControl);
}

/** The second line of the + menu's Orchestrator Controls… row. A control plane without typed
 * gates has only the Child Session Requests choice to summarize. */
export function orchestratorControlsSummary(session: ControlView & Pick<SessionView, "parentControl" | "parentControlPolicy">): string {
  return workflowDecisionsNote(session) ?? `Child session requests: ${childSessionRequestsNote(session)}.`;
}

/** A campaign's lifecycle in the status vocabulary (§11.2). */
function campaignStatusMeta(status: OrchestratorCampaignProjection["status"]): StatusMeta {
  switch (status) {
    case "waiting_human": return statusMeta("workflow", "awaiting_decision");
    case "active": return statusMeta("workflow", "running");
    case "blocked": return statusMeta("campaignWork", "blocked");
    case "verified_complete": return statusMeta("workflow", "succeeded");
  }
}

/** Where a policy value came from ("user_default"), in the faint source line under the value. */
function sourceLabel(source: string | undefined): string {
  return titleCaseLabel((source ?? "legacy_session").replaceAll("_", " "));
}

type SaveKey = "parentControl" | "control" | DelegatableWorkflowDecisionCategory;

type PendingChoices = Partial<Record<SaveKey, { value: string; request: number }>>;

interface SessionSaves {
  tail: Promise<void>;
  /** The newest copy of the session the queue has seen; each change is sent against its revision. */
  latest: SessionView;
  /** The choice each control shows while its change is unsaved, tagged with the newest request for
   * it: an older request settling leaves a newer choice in place. Replaced, never mutated. */
  pending: PendingChoices;
  requests: number;
}

/**
 * One save queue per session, shared by every Orchestrator Controls dialog opened on it, with the
 * choices still saving. Changes run one at a time against the newest revision: a second change sent
 * while the first is saving would carry the revision the first is about to replace. Shared, not per
 * dialog, so a dialog reopened while a change is saving shows that change and queues after it, and
 * the newest choice is the one stored. An entry is removed once its queue drains.
 */
const saveQueues = new Map<string, SessionSaves>();
const pendingListeners = new Set<() => void>();
const NO_PENDING: PendingChoices = {};

function setPendingChoice(saves: SessionSaves, key: SaveKey, choice: { value: string; request: number } | null) {
  if (choice) {
    saves.pending = { ...saves.pending, [key]: choice };
  } else {
    const { [key]: _done, ...rest } = saves.pending;
    saves.pending = rest;
  }
  pendingListeners.forEach((listener) => listener());
}

function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

function policyRevision(session: SessionView): number {
  return session.parentControlPolicy?.revision ?? -1;
}

/** How long a failed change waits for the session to reload before the next queued change runs. A
 * reload that never answers must not hold every later change on the session. */
export const ORCHESTRATOR_CONTROLS_RELOAD_TIMEOUT_MS = 10_000;

/** Keeps the newer of the queue's session and `session`, and says whether `session` was taken: a
 * reply or a reload that arrives after a newer revision was seen is neither sent on nor published. */
function observe(saves: SessionSaves, session: SessionView): boolean {
  if (policyRevision(session) < policyRevision(saves.latest)) return false;
  saves.latest = session;
  return true;
}

/** A newer copy of the session, rendered while changes are queued, becomes the one they are sent against. */
function noteSession(session: SessionView) {
  const entry = saveQueues.get(session.id);
  if (entry) observe(entry, session);
}

function sessionSaves(session: SessionView): SessionSaves {
  const entry = saveQueues.get(session.id);
  if (!entry) {
    const created: SessionSaves = { tail: Promise.resolve(), latest: session, pending: NO_PENDING, requests: 0 };
    saveQueues.set(session.id, created);
    return created;
  }
  observe(entry, session);
  return entry;
}

/** Settles with `promise`, or after `ms`, whichever is first. */
function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: number | undefined;
  return Promise.race([
    promise.then(() => undefined),
    new Promise<void>((resolve) => { timer = window.setTimeout(resolve, ms); }),
  ]).finally(() => window.clearTimeout(timer));
}

function enqueueSave(saves: SessionSaves, run: () => Promise<void>) {
  const tail = saves.tail.then(run);
  saves.tail = tail;
  void tail.then(() => {
    if (saves.tail === tail && saveQueues.get(saves.latest.id) === saves) saveQueues.delete(saves.latest.id);
  });
}

/**
 * Orchestrator Controls (#2192): an Orchestrator session's Child Session Requests choice, its five
 * workflow gates and its campaign's stored behavior, in a close-only dialog (§7.3). Each change
 * saves at once with a "Saved" check (§8.6); a failure shows a danger notice at the end of the body,
 * reloads the session and puts the stored choice back. Nothing is written to the composer.
 */
export function OrchestratorControlsDialog({
  session,
  onClose,
  onSessionChanged,
  refusal = null,
  returnFocusRef,
}: {
  session: SessionView;
  onClose: () => void;
  /** Takes a fresh copy of the session: the server's reply to a change, or a reload after one failed. */
  onSessionChanged: (session: SessionView) => void;
  /** Why the signed-in person may not change this session's configuration (#1857). */
  refusal?: string | null;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const api = useApi();
  const ids = useId();
  const [controlPreview, setControlPreview] = useState<"custom" | "full_control">(() =>
    session.orchestratorCampaign?.control !== undefined && Number.isSafeInteger(session.orchestratorCampaign.policyRevision)
      ? session.orchestratorCampaign.control.mode : session.parentSessionId ? "custom" : session.orchestratorPolicy?.control?.mode ?? "custom");
  // The choices still saving on this session, from this dialog or one closed before it.
  const pending = useSyncExternalStore(
    subscribePending,
    () => saveQueues.get(session.id)?.pending ?? NO_PENDING,
    () => NO_PENDING,
  );
  const [saved, setSaved] = useState<SaveKey | null>(null);
  // A failure belongs to the control that failed: that control saving later retires it.
  const [failure, setFailure] = useState<{ key: SaveKey; message: string; detail: string } | null>(null);
  const savedTimer = useRef<number | null>(null);
  noteSession(session);
  const mounted = useRef(true);
  // Set on every setup: StrictMode runs setup, cleanup and setup again on mount.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    };
  }, []);

  const showSaved = (key: SaveKey) => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    setSaved(key);
    savedTimer.current = window.setTimeout(() => {
      savedTimer.current = null;
      setSaved(null);
    }, SAVED_MS);
  };

  const change = (key: SaveKey, value: string, write: (current: SessionView) => Promise<SessionView>) => {
    if (refusal !== null) return;
    const saves = sessionSaves(session);
    const request = ++saves.requests;
    setPendingChoice(saves, key, { value, request });
    // The control shows an unsaved choice now, so neither its check nor its old failure stays.
    setSaved((prior) => (prior === key ? null : prior));
    setFailure((prior) => (prior?.key === key ? null : prior));
    // A request a later change of the same key has replaced saves quietly: only the newest says Saved.
    const newest = () => saves.pending[key]?.request === request;
    enqueueSave(saves, async () => {
      try {
        const next = await write(saves.latest);
        if (observe(saves, next)) onSessionChanged(next);
        if (mounted.current && newest()) {
          showSaved(key);
          setFailure((prior) => (prior?.key === key ? null : prior));
        }
      } catch (cause) {
        if (mounted.current) {
          setFailure({
            key,
            message: cause instanceof ApiError && cause.status === 409 ? ORCHESTRATOR_CONTROLS_CONFLICT : ORCHESTRATOR_CONTROLS_FAILED,
            detail: cause instanceof Error ? cause.message : String(cause),
          });
          setSaved(null);
        }
        // The stored value comes back with the session, so the choice shown returns to it. A late
        // reload still lands, but the queue does not wait for it past the timeout.
        await within(api.session(session.id).then(({ session: fresh }) => {
          if (observe(saves, fresh)) onSessionChanged(fresh);
        }, () => undefined), ORCHESTRATOR_CONTROLS_RELOAD_TIMEOUT_MS);
      } finally {
        if (newest()) setPendingChoice(saves, key, null);
      }
    });
  };

  const parentControl = (pending.parentControl?.value as ParentControlMode | undefined) ?? session.parentControl ?? "off";
  const policy = session.parentControlPolicy;
  const projectedControl = session.orchestratorCampaign?.control !== undefined && Number.isSafeInteger(session.orchestratorCampaign.policyRevision)
    ? session.orchestratorCampaign.control : undefined;
  const control = effectiveCampaignControl(session);
  const fullControl = control?.mode === "full_control";
  const canRevoke = fullControl && !session.parentSessionId && policy !== undefined && refusal === null;
  // A descendant's copied policy is not authoritative; only the projected root state is.
  const effectiveMode = campaignControlMode(session);
  // The choice follows the root whenever its effective mode changes (enabled, revoked, reloaded), so a
  // revoked campaign shows Custom instead of offering Full Control back with a fresh readiness check.
  const [choiceFollows, setChoiceFollows] = useState(effectiveMode);
  if (choiceFollows !== effectiveMode) {
    setChoiceFollows(effectiveMode);
    if (effectiveMode !== "unknown") setControlPreview(effectiveMode);
  }
  // The saved Full Control budget is proposed when enabling; Revoke never needs it.
  const [savedDefaults, setSavedDefaults] = useState<OrchestratorDefaults | null>(null);
  const canEnable = !fullControl && !session.parentSessionId && session.orchestratorPolicy !== undefined;
  // The panel's Enable action, shown in the footer so it stays in view below the long summary.
  const [enableAction, setEnableAction] = useState<FullControlEnableAction | null>(null);
  useEffect(() => {
    if (!canEnable || controlPreview !== "full_control") return;
    let live = true;
    api.orchestratorSettings().then((view) => { if (live) setSavedDefaults(view.defaults); }, () => undefined);
    return () => { live = false; };
  }, [api, canEnable, controlPreview]);
  const savedStatus = saved === null
    ? ""
    : `${saved === "parentControl" ? "Child Session Requests" : saved === "control" ? "Orchestrator Control" : WORKFLOW_DECISION_LABELS[saved]} saved`;

  return (
    <Modal
      title="Orchestrator Controls"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      className="orchestrator-controls"
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Done</button>
        {canEnable && controlPreview === "full_control" && enableAction && <FullControlEnableButton {...enableAction} />}
      </>}
    >
      {refusal !== null && <Notice tone="neutral" compact>{refusal}</Notice>}
      {session.orchestratorPolicy && <section className="section" aria-labelledby={`${ids}-control`}>
        <div className="section-head">
          <h3 className="section-title" id={`${ids}-control`}>Orchestrator Control</h3>
          {saved === "control" && <SavedCheck />}
        </div>
        <p className="section-note">Effective Mode: {effectiveMode === "full_control" ? "Full Control" : effectiveMode === "custom" ? "Custom" : "Current Root State Not Reported"}.</p>
        {canEnable && <>
          <OrchestratorControlChoice surface="campaign" embedded mode={controlPreview} onChange={setControlPreview} disabled={refusal !== null} />
          {controlPreview === "full_control" && <FullControlEnablePanel session={session} savedDefaults={savedDefaults}
            disabled={refusal !== null || Object.keys(pending).length > 0} onAction={setEnableAction}
            onEnabled={(next) => { onSessionChanged(next); showSaved("control"); }} />}
        </>}
        {fullControl && <>
          <p className="section-note">Revoking Full Control updates this root campaign and its descendants and invalidates unused approvals. Your saved defaults and selected session configuration stay unchanged.</p>
          <button type="button" className="btn" disabled={!canRevoke || Object.keys(pending).length > 0}
            onClick={() => change("control", "custom", (current) => api.revokeCampaignControl(current.id, current.parentControlPolicy!.revision))}>
            Revoke Full Control
          </button>
        </>}
        {session.parentSessionId && <p className="section-note">Change control on the root campaign.</p>}
      </section>}

      <section className="section" aria-labelledby={`${ids}-requests`}>
        <div className="section-head">
          <h3 className="section-title" id={`${ids}-requests`}>Child Session Requests</h3>
          {saved === "parentControl" && <SavedCheck />}
        </div>
        {control?.mode === "full_control" ? <FullControlRequests control={control} customChoice={childSessionRequestsLabel(parentControl)} />
          : effectiveMode === "unknown" ? <p className="section-note">
            {ROOT_CONTROL_NOT_REPORTED} Who answers these isn't known here, so they can't be changed until it is.
          </p>
          : <ChoiceRows<ParentControlMode>
            label="Child Session Requests"
            options={refusal === null
              ? CHILD_SESSION_REQUEST_OPTIONS
              : CHILD_SESSION_REQUEST_OPTIONS.map((option) => ({ ...option, disabled: true }))}
            value={parentControl}
            onChange={(mode) => {
              if (mode === parentControl) return;
              change("parentControl", mode, () => api.setParentControl(session.id, mode));
            }}
          />}
      </section>

      {policy && control?.mode === "full_control" && (
        <FullControlDecisions control={control} campaign={projectedControl ? session.orchestratorCampaign : undefined}
          driver={session.parentSessionId ? null : session.driver} titleId={`${ids}-decisions`} />
      )}

      {policy && effectiveMode === "unknown" && (
        <UnknownRootDecisions campaign={session.orchestratorCampaign} titleId={`${ids}-decisions`} />
      )}

      {policy && effectiveMode === "custom" && (
        <section className="section" aria-labelledby={`${ids}-decisions`}>
          <div className="section-head">
            <h3 className="section-title" id={`${ids}-decisions`}>Workflow Decisions</h3>
          </div>
          <p className="section-note">
            Only a signed-in person can change these, and a change revokes approvals that haven't been
            used yet. Secrets, sign-in, persistent grants, governance, budgets and guardrails always stay
            with a person.
          </p>
          <div className="orchestrator-gates">
            {WORKFLOW_DECISION_CATEGORIES.map((category) => {
              const label = WORKFLOW_DECISION_LABELS[category];
              const value = (pending[category]?.value as WorkflowDecisionAuthority | undefined) ?? policy.decisions[category];
              const evidence = category === "ui_evidence_approval";
              const routedReason = evidence && session.orchestratorCampaign?.uiEvidenceReview.status === "unavailable"
                ? session.orchestratorCampaign.uiEvidenceReview.reason ?? "This Orchestrator can't inspect the evidence images."
                : null;
              return (
                <div className="orchestrator-gate" key={category}>
                  <span className="orchestrator-gate-label" id={`${ids}-${category}`}>{label}</span>
                  {saved === category && <SavedCheck />}
                  <SegmentedControl<WorkflowDecisionAuthority>
                    label={label}
                    options={AUTHORITY_OPTIONS.map((option) => ({ ...option, disabled: refusal !== null || undefined }))}
                    value={value}
                    onChange={(authority) => {
                      if (authority === value) return;
                      change(category, authority, (current) => {
                        const currentPolicy = current.parentControlPolicy ?? policy;
                        return api.setParentControlPolicy(
                          session.id,
                          { ...currentPolicy.decisions, [category]: authority },
                          currentPolicy.revision,
                        );
                      });
                    }}
                  />
                  {evidence && <p className="orchestrator-gate-helper">{DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE}</p>}
                  {routedReason && <FieldWarning>Goes to a person here: {routedReason}</FieldWarning>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {session.orchestratorPolicy && <CampaignBehavior session={session} titleId={`${ids}-campaign`} />}

      <span className="sr-only" role="status">{savedStatus}</span>
      {failure && (
        <Notice tone="danger" role="alert" className="orchestrator-controls-failure" details={<p>{failure.detail}</p>}>
          {failure.message}
        </Notice>
      )}
    </Modal>
  );
}

const FULL_CONTROL_REQUEST_OPERATIONS: ReadonlyArray<{ operation: CampaignAuthorityOperation; label: string }> = [
  { operation: "question", label: "Questions" },
  { operation: "tool_approval", label: "One-Time Approvals" },
  { operation: "policy_ask", label: "Governance Policy Asks" },
];

/** Full Control decides descendant requests from its boundary, so the Custom choice is shown as
 * what returns after Revoke, never as a control that would have no effect now. */
function FullControlRequests({ control, customChoice }: { control: Extract<CampaignControl, { mode: "full_control" }>; customChoice: string }) {
  return <>
    <p className="section-note">
      Full Control decides these. Inside the authorized boundary the Orchestrator answers; protected requests, Human
      Required exceptions and anything outside the boundary come to you. Your Custom choice, {customChoice}, applies
      again only after you revoke Full Control.
    </p>
    <dl className="facts orchestrator-facts">
      {FULL_CONTROL_REQUEST_OPERATIONS.map(({ operation, label }) => <div key={operation}>
        <dt>{label}</dt>
        <dd>{control.boundary.operations.includes(operation) ? "Orchestrator" : "Human"}</dd>
      </div>)}
    </dl>
  </>;
}

/** Under Full Control each gate's owner is the server's effective owner for this campaign, read-only:
 * the saved per-gate choices have no effect until Revoke. */
function FullControlDecisions({ control, campaign, driver, titleId }: {
  control: Extract<CampaignControl, { mode: "full_control" }>; campaign: OrchestratorCampaignProjection | undefined;
  /** The root's driver; a descendant does not know it, so it sees every standing protection. */
  driver: string | null; titleId: string;
}) {
  const standing = fullControlStandingHumanRequired(driver ?? "claude-code");
  const reasonFor = (category: DelegatableWorkflowDecisionCategory) =>
    category === "ui_evidence_approval" && campaign?.uiEvidenceReview.status === "unavailable"
      ? campaign.uiEvidenceReview.reason ?? "This Orchestrator can't inspect the evidence images."
      : !control.boundary.operations.includes(category) ? "Not part of this campaign's authorization."
      : "This runner can't enforce Full Control for this gate.";
  return <>
    <section className="section" aria-labelledby={titleId}>
      <div className="section-head">
        <h3 className="section-title" id={titleId}>Workflow Decisions</h3>
      </div>
      <p className="section-note">
        Full Control decides these for this campaign. Your per-gate choices apply again only after you revoke to Custom.
      </p>
      <EffectiveOwnerFacts campaign={campaign} reasonFor={reasonFor} />
    </section>
    <section className="section" aria-labelledby={`${titleId}-human-required`}>
      <div className="section-head">
        <h3 className="section-title" id={`${titleId}-human-required`}>Human Required</h3>
      </div>
      <p className="section-note">These always come to you under Full Control.</p>
      <ul>
        {FULL_CONTROL_EVIDENCE_EXCEPTIONS.map((item) => <li key={item.id}><strong>{item.exception}:</strong> {item.reason}</li>)}
        {standing.map((id) => <li key={id}><strong>{FULL_CONTROL_HUMAN_REQUIRED_LABELS[id] ?? id}:</strong> {FULL_CONTROL_STANDING_HUMAN_REQUIRED_REASON}</li>)}
      </ul>
    </section>
  </>;
}

/** A descendant whose root's control isn't reported: the server's effective owners, read-only, since
 * a per-gate choice made here might have no effect. */
function UnknownRootDecisions({ campaign, titleId }: { campaign: OrchestratorCampaignProjection | undefined; titleId: string }) {
  const reasonFor = (category: DelegatableWorkflowDecisionCategory) =>
    category === "ui_evidence_approval" && campaign?.uiEvidenceReview.status === "unavailable"
      ? campaign.uiEvidenceReview.reason ?? "This Orchestrator can't inspect the evidence images."
      : "Set by the root campaign.";
  return <section className="section" aria-labelledby={titleId}>
    <div className="section-head">
      <h3 className="section-title" id={titleId}>Workflow Decisions</h3>
    </div>
    <p className="section-note">
      {ROOT_CONTROL_NOT_REPORTED} These are the owners Wollipog applies, and they can't be changed here until it is.
    </p>
    <EffectiveOwnerFacts campaign={campaign} reasonFor={reasonFor} />
  </section>;
}

/** Each gate's effective owner as the server reports it, with why a person decides it. */
function EffectiveOwnerFacts({ campaign, reasonFor }: {
  campaign: OrchestratorCampaignProjection | undefined; reasonFor: (category: DelegatableWorkflowDecisionCategory) => string;
}) {
  return <>
    <dl className="facts orchestrator-facts">
      {WORKFLOW_DECISION_CATEGORIES.map((category) => {
        const owner = campaign?.decisionOwners[category];
        return <div key={category}>
          <dt>{WORKFLOW_DECISION_LABELS[category]}</dt>
          <dd>
            {owner === undefined ? "Not Reported" : owner === "orchestrator" ? "Orchestrator" : "Human"}
            {owner === "human" && <small className="orchestrator-fact-source">{reasonFor(category)}</small>}
          </dd>
        </div>;
      })}
    </dl>
    {campaign?.decisionOwners.ui_evidence_approval === "orchestrator" &&
      <p className="orchestrator-gate-helper">{DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE}</p>}
  </>;
}

/** The quiet "Saved" check (§8.6), announced by the dialog's polite region. */
function SavedCheck() {
  return <span className="setting-row-saved" aria-hidden="true"><CheckIcon size={14} />Saved</span>;
}

function Fact({ label, value, source, title }: { label: string; value: ReactNode; source?: ReactNode; title?: string }) {
  return (
    <div title={title}>
      <dt>{label}</dt>
      <dd>
        {value}
        {source != null && <small className="orchestrator-fact-source">{source}</small>}
      </dd>
    </div>
  );
}

/** The campaign's stored behavior as facts (§5.4), each value with where it came from. */
function CampaignBehavior({ session, titleId }: { session: SessionView; titleId: string }) {
  const policy = session.orchestratorPolicy!;
  const campaign = session.orchestratorCampaign;
  const { behavior, sources } = policy;
  // A pre-v164 payload has no field. Derive it in the same order the control-plane migration does,
  // and for the same reason: EVERY coupled preset launch replaces the provider surface and so
  // carries no user integration, including the non-strict Claude and Codex preset shapes, where
  // `strictProjectIsolation` is false. Reading strictness first would report those as Disabled even
  // though they removed the integrations. An older control plane publishes no execution block.
  const integrationIsolation = policy.execution?.integrationIsolation ??
    (usesOrchestratorPresetPermissions(session) || (policy.execution?.strictProjectIsolation ?? true));
  // A preset launch is not the additive launch minus integrations, so it gets its own sentence
  // instead of the per-harness "kept" list.
  const copy = integrationIsolationDisclosure(session.driver);
  const isolationDisclosure = usesOrchestratorPresetPermissions(session)
    ? ORCHESTRATOR_PRESET_INTEGRATION_DISCLOSURE
    : `${copy.removed} ${copy.kept}`;
  return (
    <section className="section" aria-labelledby={titleId}>
      <div className="section-head">
        <h3 className="section-title" id={titleId}>Campaign Behavior</h3>
      </div>
      <p className="section-note">This campaign keeps its stored policy when account defaults change.</p>
      <dl className="facts orchestrator-facts">
        {campaign && (
          <Fact
            label="Campaign Status"
            value={<StatusBadge meta={campaignStatusMeta(campaign.status)} inline />}
            source={`Policy Revision ${campaign.policyRevision}`}
          />
        )}
        <Fact
          label="Child Harness"
          value={behavior.childHarness ? agentHarnessIdentityLabel(behavior.childHarness) : "Automatic"}
          source={sourceLabel(sources.behavior.childHarness)}
        />
        <Fact label="Child Model" value={behavior.childModel ?? "Automatic"} source={sourceLabel(sources.behavior.childModel)} />
        <Fact
          label="Child Effort"
          value={behavior.childEffort ? titleCaseLabel(behavior.childEffort) : "Automatic"}
          source={sourceLabel(sources.behavior.childEffort)}
        />
        <Fact
          label="Maximum Concurrent Children"
          value={behavior.maximumConcurrentChildren}
          source={sourceLabel(sources.behavior.maximumConcurrentChildren)}
        />
        <Fact
          label="Follow-Ups"
          value={titleCaseLabel(behavior.followUps.replaceAll("_", " "))}
          source={sourceLabel(sources.behavior.followUps)}
        />
        <Fact
          label="Completion"
          value={titleCaseLabel(behavior.completion.replaceAll("_", " "))}
          source={sourceLabel(sources.behavior.completion)}
        />
        <Fact
          label="Integration Isolation"
          value={integrationIsolation ? "Enabled" : "Disabled"}
          source={sourceLabel(sources.execution?.integrationIsolation)}
          title={integrationIsolation ? isolationDisclosure : undefined}
        />
        {campaign && (
          <>
            <Fact
              label="Children"
              value={campaign.children.total}
              source={`${campaign.children.verified} Verified · ${campaign.children.active} Active · ${campaign.children.waitingHuman} Waiting for Human · ${campaign.children.blocked} Blocked`}
            />
            <Fact
              label="Follow-Up Recommendations"
              value={campaign.followUps.unique}
              source={`${campaign.followUps.duplicates} ${campaign.followUps.duplicates === 1 ? "Duplicate" : "Duplicates"} Skipped`}
            />
          </>
        )}
      </dl>
      {campaign?.uiEvidenceReview.status === "available" && campaign.uiEvidenceReview.effectiveOwner === "orchestrator" && (
        <Notice tone="info" compact>
          The Orchestrator reviews image evidence attached as Session artifacts. Video normally goes to a
          person; one operator-enabled short-frame validation campaign may delegate it. Externally stored
          evidence goes to a person.
        </Notice>
      )}
    </section>
  );
}
