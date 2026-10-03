import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  WORKFLOW_DECISION_CATEGORIES,
  type DelegatableWorkflowDecisionCategory,
  type OrchestratorCampaignProjection,
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

/** The second line of the + menu's Orchestrator Controls… row. A control plane without typed
 * gates has only the Child Session Requests choice to summarize. */
export function orchestratorControlsSummary(session: Pick<SessionView, "parentControl" | "parentControlPolicy">): string {
  return session.parentControlPolicy
    ? workflowDecisionsSummary(session.parentControlPolicy.decisions)
    : `Child session requests: ${childSessionRequestsLabel(session.parentControl)}.`;
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

type SaveKey = "parentControl" | DelegatableWorkflowDecisionCategory;

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
  // The choice shown while a change is unsaved, tagged with its request: a key changed again before
  // its first change settles keeps showing the newest choice until that one's own request settles.
  const [pending, setPending] = useState<Partial<Record<SaveKey, { value: string; request: number }>>>({});
  const requests = useRef(0);
  const latestRequest = useRef<Partial<Record<SaveKey, number>>>({});
  const [saved, setSaved] = useState<SaveKey | null>(null);
  const [failure, setFailure] = useState<{ message: string; detail: string } | null>(null);
  const savedTimer = useRef<number | null>(null);
  // Changes run one at a time, each against the newest revision: a second gate changed while the
  // first is still saving would otherwise send the revision the first is about to replace.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(session);
  if ((session.parentControlPolicy?.revision ?? -1) >= (latest.current.parentControlPolicy?.revision ?? -1)) {
    latest.current = session;
  }
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
    const request = ++requests.current;
    setPending((prior) => ({ ...prior, [key]: { value, request } }));
    setFailure(null);
    // A request a later change of the same key has replaced saves quietly: only the newest says Saved.
    const newest = () => latestRequest.current[key] === request;
    latestRequest.current[key] = request;
    queue.current = queue.current.then(async () => {
      try {
        const next = await write(latest.current);
        latest.current = next;
        onSessionChanged(next);
        if (mounted.current && newest()) showSaved(key);
      } catch (cause) {
        if (mounted.current) {
          setFailure({
            message: cause instanceof ApiError && cause.status === 409 ? ORCHESTRATOR_CONTROLS_CONFLICT : ORCHESTRATOR_CONTROLS_FAILED,
            detail: cause instanceof Error ? cause.message : String(cause),
          });
          setSaved(null);
        }
        // The stored value comes back with the session, so the choice shown returns to it.
        await api.session(session.id).then(({ session: fresh }) => {
          latest.current = fresh;
          onSessionChanged(fresh);
        }, () => undefined);
      } finally {
        if (mounted.current) {
          setPending((prior) => {
            if (prior[key]?.request !== request) return prior;
            const { [key]: _done, ...rest } = prior;
            return rest;
          });
        }
      }
    });
  };

  const parentControl = (pending.parentControl?.value as ParentControlMode | undefined) ?? session.parentControl ?? "off";
  const policy = session.parentControlPolicy;
  const savedStatus = saved === null
    ? ""
    : `${saved === "parentControl" ? "Child Session Requests" : WORKFLOW_DECISION_LABELS[saved]} saved`;

  return (
    <Modal
      title="Orchestrator Controls"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      className="orchestrator-controls"
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}
    >
      {refusal !== null && <Notice tone="neutral" compact>{refusal}</Notice>}

      <section className="section" aria-labelledby={`${ids}-requests`}>
        <div className="section-head">
          <h3 className="section-title" id={`${ids}-requests`}>Child Session Requests</h3>
          {saved === "parentControl" && <SavedCheck />}
        </div>
        <ChoiceRows<ParentControlMode>
          label="Child Session Requests"
          options={refusal === null
            ? CHILD_SESSION_REQUEST_OPTIONS
            : CHILD_SESSION_REQUEST_OPTIONS.map((option) => ({ ...option, disabled: true }))}
          value={parentControl}
          onChange={(mode) => {
            if (mode === parentControl) return;
            change("parentControl", mode, () => api.setParentControl(session.id, mode));
          }}
        />
      </section>

      {policy && (
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

/** The quiet "Saved" check (§8.6), announced by the dialog's polite region. */
function SavedCheck() {
  return <span className="ui-row-saved" aria-hidden="true"><CheckIcon size={14} />Saved</span>;
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
              source={`${campaign.followUps.duplicates} Duplicates Skipped`}
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
