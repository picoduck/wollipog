import { useEffect, useId, useState } from "react";
import type { CampaignDecisionsResponse, DecisionErrorClass, DecisionKind } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

type CampaignDecision = CampaignDecisionsResponse["decisions"][number];

/** The checks shown here (#4104): the question screen, follow-up relatedness, closure-reason choice
 * and a Custom campaign's epic seed. Other kinds, such as Full Control's scope grant, have their own
 * place in Campaign Status. */
const SHOWN_KINDS: ReadonlySet<DecisionKind> = new Set<DecisionKind>(["credential_screen", "follow_up_relatedness", "closure_reason"]);
const shown = (decision: CampaignDecision) => SHOWN_KINDS.has(decision.kind) ||
  decision.kind === "scope_grant" && decision.subject?.surface === "issue_scope_seed";

const SURFACE_LABELS: Record<NonNullable<CampaignDecision["subject"]>["surface"], string> = {
  implementation_question: "Implementation Question",
  provider_question: "Provider Question",
  tool_request: "Tool Request",
  owner_decision: "Owner Decision",
  follow_up_publication: "Follow-Up Publication",
  issue_closure: "Issue Closure",
  issue_scope_seed: "Epic Seed",
};

const VERDICT_LABELS: Record<string, string> = {
  ask: "Asks for Access",
  discusses: "Only Discusses",
  related: "Related",
  unrelated: "Unrelated",
  fits: "Reason Fits",
  does_not_fit: "Reason Doesn't Fit",
  grant: "Message Read",
  uncertain: "Uncertain",
};

export const DECISION_FAILURE_LABELS: Record<DecisionErrorClass, string> = {
  timed_out: "Timed Out",
  transport: "Runner Unreachable",
  rate_limited: "Rate Limited",
  provider_overloaded: "Provider Overloaded",
  invalid_output: "Invalid Output",
  provider_failed: "Provider Failed",
  authentication: "Sign-In Required",
  configuration: "Configuration Error",
  model_unavailable: "Model Unavailable",
  harness_unavailable: "Harness Unavailable",
  runner_incapable: "Runner Can't Run It",
  refused: "Refused",
};

/** What a follow-up relatedness or closure-reason check did to its request. Either can only
 * refuse what the floor admitted; when it can't tell, the request is the owner's decision. */
function checkOutcomeText(decision: CampaignDecision): string {
  const closure = decision.kind === "closure_reason";
  if (decision.state === "pending") return "It waits until the check finishes.";
  if (decision.state === "decided") {
    return decision.verdict === "unrelated" || decision.verdict === "does_not_fit"
      ? "Refused back to the Orchestrator." : closure ? "The Orchestrator may close it." : "The Orchestrator may publish it.";
  }
  return closure ? "Waiting for you to decide the closure." : "Waiting for you to decide the publication.";
}

/** What a Custom campaign's epic seed did: a named epic seeds the scope the owner approves, and a
 * reading that could not settle it leaves that scope to them with no seed. */
function seedOutcomeText(decision: CampaignDecision): string {
  if (decision.subject?.classification === "orchestrator") return "You let the Orchestrator delegate without an epic.";
  switch (decision.subject?.seed) {
    case "seeded": return "It seeded the epic's issues; approve the issue scope before work is delegated.";
    case "none": return "It named no epic, so nothing waits.";
    case "owner": return "Waiting for you: approve the campaign's issue scope, or continue without an epic.";
    case "scoped": return "You approved the campaign's issue scope, so nothing waits.";
    default: return decision.state === "pending" ? "Work waits to be delegated until the check finishes." : "A later reading replaced it.";
  }
}

/** What the screen's outcome did to the request it affected, in the order it happened. */
function outcomeText(decision: CampaignDecision): string {
  if (decision.kind === "scope_grant") return seedOutcomeText(decision);
  if (decision.kind !== "credential_screen") return checkOutcomeText(decision);
  const classification = decision.subject?.classification;
  const ownerDecision = decision.subject?.surface === "owner_decision";
  if (classification === "decline") return "You declined it.";
  if (classification === "orchestrator") return ownerDecision ? "You chose to answer it yourself." : "You let the Orchestrator answer it.";
  if (decision.state === "pending") return "Nobody can answer it until the check finishes.";
  if (decision.state === "decided") {
    if (decision.verdict === "ask") return ownerDecision ? "Refused; nobody was asked." : "Declined and recorded as blocked work.";
    return ownerDecision ? "It went to you as an owner decision." : "The Orchestrator decides it.";
  }
  return "Waiting for you to classify it.";
}

/**
 * The campaign's Decision Model checks (#4104): each verdict, its reason and any failure, beside
 * the request it affected. A question the model could not screen waits for its owner, who only
 * classifies it here: Decline, or Let the Orchestrator Answer. A follow-up or closure it could not
 * check becomes the owner's own decision, which they make on its request. Nobody is asked for a value.
 */
export function CampaignDecisionModelChecks({ sessionId, canClassify, refreshKey, onOpenSession }: {
  sessionId: string;
  /** The campaign's own session offers the classification; the server checks the person. */
  canClassify: boolean;
  /** Any value that changes when the campaign does, so the list reloads with it. */
  refreshKey: unknown;
  onOpenSession: (sessionId: string) => void;
}) {
  const api = useApi();
  const headingId = useId();
  const [decisions, setDecisions] = useState<CampaignDecision[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.campaignDecisions(sessionId, controller.signal).then((response) => {
      setDecisions(response.decisions.filter(shown));
      setLoadError(null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(cause instanceof Error ? cause.message : "Could not load the Decision Model checks.");
    });
    return () => controller.abort();
  }, [api, sessionId, refreshKey, reload]);

  const classify = async (occurrenceId: string, classification: "decline" | "orchestrator") => {
    if (busy) return;
    setBusy(`${occurrenceId}:${classification}`);
    setActionError(null);
    try {
      await api.classifyCampaignDecision(sessionId, occurrenceId, classification);
      setReload((value) => value + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not classify the question.");
    } finally {
      setBusy(null);
    }
  };

  if (!decisions?.length && !loadError) return null;
  return (
    <section className="campaign-status-handoffs" aria-labelledby={headingId}>
      <h3 id={headingId} className="section-title">Decision Model Checks</h3>
      <p className="section-note">
        The Decision Model checks whether a question asks for a credential, sign-in or access, whether a follow-up
        belongs to the work you asked for, whether a closure's reason fits its issue, and which epic a campaign's
        first message names. When it can't tell, the request waits for you; nobody asks you for a value.
      </p>
      {loadError && <Notice tone="danger" compact role="alert" title="Couldn't Load Decision Model Checks">{loadError}</Notice>}
      {actionError && <Notice tone="danger" compact role="alert" title="Couldn't Classify the Question">{actionError}</Notice>}
      <ul className="campaign-screen-list">
        {(decisions ?? []).map((decision) => {
          const subject = decision.subject;
          // Only a question the screen could not decide is classified here; a follow-up or closure
          // the model could not check is decided on its own request.
          const awaiting = decision.kind === "credential_screen" && (decision.state === "uncertain" || decision.state === "failed") &&
            !subject?.classification;
          // An epic seed the model could not settle waits for the owner, who may continue without one.
          const seedAwaiting = decision.kind === "scope_grant" && subject?.seed === "owner" && !subject.classification;
          // An owner decision stays the owner's: classifying it only lets them choose an option.
          const ownerDecision = subject?.surface === "owner_decision";
          const label = subject ? SURFACE_LABELS[subject.surface] : "Request";
          return (
            <li key={decision.occurrenceId} className="campaign-screen-item">
              <dl className="facts">
                <div>
                  <dt>{label}</dt>
                  <dd>{outcomeText(decision)}</dd>
                </div>
                <div>
                  <dt>Verdict</dt>
                  <dd>{decision.verdict ? VERDICT_LABELS[decision.verdict] ?? decision.verdict : decision.state === "pending" ? "Checking" : "None"}</dd>
                </div>
                {decision.reason && (
                  <div>
                    <dt>Reason</dt>
                    <dd>{decision.reason}</dd>
                  </div>
                )}
                {decision.failureClass && (
                  <div>
                    <dt>Failure</dt>
                    <dd>{DECISION_FAILURE_LABELS[decision.failureClass]}</dd>
                  </div>
                )}
              </dl>
              {(subject || (awaiting && canClassify)) && (
                <div className="campaign-screen-actions" role="group" aria-label={`${label} Actions`}>
                  {seedAwaiting && canClassify && (
                    <BusyButton className="btn sm" busy={busy === `${decision.occurrenceId}:orchestrator`}
                      progress="Letting the Orchestrator delegate…" disabled={busy !== null}
                      onClick={() => void classify(decision.occurrenceId, "orchestrator")}>Continue Without an Epic</BusyButton>
                  )}
                  {awaiting && canClassify && <>
                    <BusyButton className="btn sm" busy={busy === `${decision.occurrenceId}:decline`} progress="Declining the question…" disabled={busy !== null}
                      onClick={() => void classify(decision.occurrenceId, "decline")}>Decline</BusyButton>
                    <BusyButton className="btn primary sm" busy={busy === `${decision.occurrenceId}:orchestrator`}
                      progress={ownerDecision ? "Opening the decision to you…" : "Handing the question to the Orchestrator…"} disabled={busy !== null}
                      onClick={() => void classify(decision.occurrenceId, "orchestrator")}>
                      {ownerDecision ? "Let Me Answer" : "Let the Orchestrator Answer"}
                    </BusyButton>
                  </>}
                  {subject && (
                    <button type="button" className="btn sm" onClick={() => onOpenSession(subject.sessionId)}>Open Session</button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
