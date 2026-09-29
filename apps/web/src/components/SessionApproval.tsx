import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH,
  isPolicyApproval,
  type AgentQuestion,
  type ApprovalContext,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useOptionalStoreSelector } from "../store.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import {
  clearQuestionDrafts,
  claimQuestionResponseOperation,
  isAnswerableAgentQuestion,
  questionDraftAnswers,
  questionDraftSelections,
  questionDraftText,
  storedQuestionDrafts,
  storeQuestionDrafts,
  type QuestionResponseDraft,
} from "../question-response.js";
import { useQuestionResponseStyle } from "../question-response-style.js";
import { useInstanceScope } from "../instance-scope.js";
import {
  clearEvidenceReviewDraft,
  loadEvidenceReviewDraft,
  saveEvidenceReviewDraft,
} from "../evidence-review-drafts.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { StructuredQuestionText } from "./StructuredQuestionText.js";
import { Checkbox } from "./ui/ChoiceControls.js";
import {
  EvidenceArtifactView,
  EvidenceSecureContextNotice,
  evidenceStatusBlocksReview,
  isArtifactBackedEvidence,
  isRenderableEvidence,
  UnrenderableEvidenceArtifact,
  type EvidenceArtifactStatus,
} from "./EvidenceArtifactView.js";
import { ProviderLoginCard } from "./ProviderLoginCard.js";
import { AuthenticationRecoveryPanel, authenticationRecoveryPanelApplies } from "./AuthenticationRecoveryPanel.js";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface QuestionSelectionState {
  requestId: string;
  picked: Record<string, string[]>;
}

export function questionSelectionForRequest(state: QuestionSelectionState, requestId: string): Record<string, string[]> {
  return state.requestId === requestId ? state.picked : {};
}

export function approvalFocusDestination(
  previousRequestId: string | null,
  nextRequestId: string | null,
  focusOwned: boolean,
): "request" | "fallback" | null {
  if (!focusOwned || previousRequestId === nextRequestId) return null;
  return nextRequestId ? "request" : "fallback";
}

export function approvalKeyHintForOption(
  options: readonly { optionId: string; kind?: string }[],
  optionId: string,
): "A" | "D" | null {
  const option = options.find((candidate) => candidate.optionId === optionId);
  if (option?.kind !== "allow_once" && option?.kind !== "reject_once") return null;
  if (options.filter((candidate) => candidate.kind === option.kind).length !== 1) return null;
  return option.kind === "allow_once" ? "A" : "D";
}

export function ApprovalSelectorContext({ context }: { context?: ApprovalContext }) {
  const selectors = [
    { key: "tool", label: "Tool", value: context?.toolName },
    { key: "path", label: "Path", value: context?.path },
    { key: "network", label: "Network", value: context?.network },
    { key: "branch", label: "Branch", value: context?.branch },
  ].filter((selector): selector is { key: string; label: string; value: string } =>
    typeof selector.value === "string" && selector.value.length > 0);
  if (!selectors.length) return null;

  return (
    <dl className="approval-selector-context" aria-label="Policy Match Context">
      {selectors.map((selector) => (
        <div className="approval-selector-card" data-selector={selector.key} key={selector.key}>
          <dt>{selector.label}</dt>
          <dd>{selector.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Why the signed-in person may not answer or decide this session's requests (#1857), from the
 * session's view in the store. Without a store or a view it is `fallback`: a caller that knows the
 * requester's verdict from another view passes it, and otherwise the server still decides. */
export function useSessionResponseRefusal(sessionId: string, fallback: string | null = null): string | null {
  const stored = useOptionalStoreSelector((state) => {
    const session = state.sessions.get(sessionId);
    return session ? sessionCommandRefusal(session, "respond") : undefined;
  });
  return stored === undefined ? fallback : stored;
}

/** Stable focus/live boundary across coalesced approval replacement and final resolution. */
export function SessionApprovalRegion({
  session,
  runnerOnline,
  fallbackFocusRef,
  alternateFallbackFocusRef,
  onFallbackFocus,
  onSessionUpdate,
  showKeyHints = true,
  questionInTimeline = false,
  standaloneInReviewSurface = false,
}: {
  session: SessionView;
  runnerOnline: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  alternateFallbackFocusRef?: RefObject<HTMLElement | null>;
  onFallbackFocus?: () => boolean;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
  /** Whether the pending question already has an authoritative transcript row. */
  questionInTimeline?: boolean;
  /** Whether the standalone approval is represented by its transcript trigger + request panel. */
  standaloneInReviewSurface?: boolean;
}) {
  const instanceScope = useInstanceScope();
  const approval = session.pendingApproval;
  const questionFallback = approval?.kind === "question" && !questionInTimeline;
  const standaloneApproval = standaloneApprovalForReview(approval);
  const reviewApproval = standaloneInReviewSurface ? standaloneApproval : null;
  const evidenceRequestId = reviewApproval?.requestId ?? null;
  const evidenceResourceDigest = reviewApproval?.workflowDecision?.resourceDigest ?? null;
  const evidenceIdentity = evidenceRequestId && evidenceResourceDigest ? {
    sessionId: session.id,
    requestId: evidenceRequestId,
    resourceDigest: evidenceResourceDigest,
  } : null;
  const previousEvidenceIdentityRef = useRef(evidenceIdentity);
  useEffect(() => {
    const previous = previousEvidenceIdentityRef.current;
    if (previous && (
      !evidenceIdentity ||
      previous.sessionId !== evidenceIdentity.sessionId ||
      previous.requestId !== evidenceIdentity.requestId ||
      previous.resourceDigest !== evidenceIdentity.resourceDigest
    )) {
      clearEvidenceReviewDraft(
        instanceScope,
        previous.sessionId,
        previous.requestId,
        previous.resourceDigest,
      );
    }
    previousEvidenceIdentityRef.current = evidenceIdentity;
  }, [evidenceRequestId, evidenceResourceDigest, instanceScope, session.id]);
  const requestPresentation = questionFallback ? "fallback" : approval?.kind === "question"
    ? "timeline" : reviewApproval ? "timeline" : standaloneApproval ? "standalone" : "none";
  return (
    <>
      <SessionRequestCoordinator
        sessionId={session.id}
        requestId={approval?.requestId ?? null}
        requestIsQuestion={approval?.kind === "question"}
        requestPresentation={requestPresentation}
        runnerOnline={runnerOnline}
        fallbackFocusRef={fallbackFocusRef}
        alternateFallbackFocusRef={alternateFallbackFocusRef}
        onFallbackFocus={onFallbackFocus}
      />
      {standaloneApproval && !reviewApproval && (
        <div data-session-request-id={standaloneApproval.requestId} data-session-request-session={session.id}>
          <SessionApprovalBanner
            key={standaloneApproval.requestId}
            session={session}
            runnerOnline={runnerOnline}
            onSessionUpdate={onSessionUpdate}
            showKeyHints={showKeyHints}
          />
        </div>
      )}
      {questionFallback && (
        <div data-session-request-id={approval.requestId} data-session-request-session={session.id}>
          <SessionQuestionBanner
            key={`${approval.requestId}:${approval.occurrenceId ?? ""}`}
            sessionId={session.id}
            requestId={approval.requestId}
            occurrenceId={approval.occurrenceId}
            questions={approval.questions ?? []}
            isAsync={approval.async}
            recoveryReason={approval.recoveryReason}
            recoveryAction={approval.recoveryAction}
            runnerOnline={runnerOnline}
            onSessionUpdate={onSessionUpdate}
            showKeyHints={showKeyHints}
          />
        </div>
      )}
    </>
  );
}

/** Questions and worker-owned requests already have authoritative interactive presentations. */
export function standaloneApprovalForReview(
  approval: SessionView["pendingApproval"],
): NonNullable<SessionView["pendingApproval"]> | null {
  return approval && approval.kind !== "question" && !approval.ownerToolUseId ? approval : null;
}

/** Keep one question representation at its event's timeline position while the request is live. */
export function SessionTimelineQuestionRegion({
  sessionId,
  pendingQuestion,
  eventRequestId,
  eventQuestions,
  eventResolved,
  runnerOnline,
  onSessionUpdate,
  showKeyHints = true,
  children,
}: {
  sessionId: string;
  pendingQuestion: {
    requestId: string;
    occurrenceId?: string;
    questions: AgentQuestion[];
    async?: boolean;
    recoveryReason?: "provider_restart";
    recoveryAction?: "resume_answer";
  } | null;
  eventRequestId: string;
  eventQuestions: AgentQuestion[];
  eventResolved: boolean;
  runnerOnline: boolean;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
  children: ReactNode;
}) {
  const approval = !eventResolved && pendingQuestion?.requestId === eventRequestId
    ? pendingQuestion
    : null;
  return (
    <div data-session-request-id={approval?.requestId} data-session-request-session={approval ? sessionId : undefined}>
      {approval ? (
        <SessionQuestionBanner
          sessionId={sessionId}
          requestId={approval.requestId}
          occurrenceId={approval.occurrenceId}
          questions={approval.questions.length > 0 ? approval.questions : eventQuestions}
          isAsync={approval.async}
          recoveryReason={approval.recoveryReason}
          recoveryAction={approval.recoveryAction}
          runnerOnline={runnerOnline}
          onSessionUpdate={onSessionUpdate}
          showKeyHints={showKeyHints}
        />
      ) : children}
    </div>
  );
}

function requestRegionFor(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>("[data-session-request-id]") ?? null;
}

/** Navigate to an existing request without making a response button the implicit Enter target. */
export function focusSessionRequest(sessionId: string, requestId: string): void {
  const region = [...document.querySelectorAll<HTMLElement>("[data-session-request-id]")]
    .find((candidate) => candidate.dataset.sessionRequestId === requestId &&
      candidate.dataset.sessionRequestSession === sessionId);
  if (!region) return;
  region.tabIndex = -1;
  region.scrollIntoView?.({ block: "nearest" });
  region.focus();
}

function enabledRequestControl(
  sessionId: string,
  requestId: string,
  preferredControl: string | null = null,
): HTMLElement | null {
  const regions = document.querySelectorAll<HTMLElement>("[data-session-request-id]");
  const region = [...regions].find((candidate) => candidate.dataset.sessionRequestId === requestId &&
    candidate.dataset.sessionRequestSession === sessionId);
  const controls = [...region?.querySelectorAll<HTMLElement>(
    'button:not(:disabled):not([aria-disabled="true"]), [role="radio"][tabindex="0"]:not(:disabled):not([aria-disabled="true"]), [role="checkbox"]:not(:disabled):not([aria-disabled="true"]), input:not(:disabled)',
  ) ?? []];
  // Composer Response owns entry outside this request region. On replacement, do not turn the
  // card's destructive Dismiss action into the implicit focus target for the user's next Enter.
  const eligible = region?.querySelector(".question-style-composer")
    ? controls.filter((control) => control.dataset.sessionRequestControl !== "dismiss")
    : controls;
  return eligible.find((control) => control.dataset.sessionRequestControl === preferredControl) ?? eligible[0] ?? null;
}

/** Persistent focus and live-announcement owner for approvals in either presentation. */
function SessionRequestCoordinator({
  sessionId,
  requestId,
  requestIsQuestion,
  requestPresentation,
  runnerOnline,
  fallbackFocusRef,
  alternateFallbackFocusRef,
  onFallbackFocus,
}: {
  sessionId: string;
  requestId: string | null;
  requestIsQuestion: boolean;
  requestPresentation: "fallback" | "timeline" | "standalone" | "none";
  runnerOnline: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  alternateFallbackFocusRef?: RefObject<HTMLElement | null>;
  onFallbackFocus?: () => boolean;
}) {
  const previousRequestRef = useRef<string | null>(null);
  const previousRequestWasQuestionRef = useRef(false);
  const announcedRequestRef = useRef<string | null>(null);
  const previousRunnerOnlineRef = useRef(runnerOnline);
  const [announcement, setAnnouncement] = useState("");
  const requestWasUnchangedBeforeRender = previousRequestRef.current === requestId;
  const focusedElementBeforeRender = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
    ? document.activeElement : null;
  const focusedRequestBeforeRender = requestRegionFor(focusedElementBeforeRender)?.dataset.sessionRequestId ?? null;
  const focusedRequestSessionBeforeRender = requestRegionFor(focusedElementBeforeRender)?.dataset.sessionRequestSession ?? null;
  const focusedControlBeforeRender = focusedElementBeforeRender?.dataset.sessionRequestControl ?? null;
  const ownedFocusBeforeRender = previousRequestRef.current !== null &&
    focusedRequestBeforeRender === previousRequestRef.current && focusedRequestSessionBeforeRender === sessionId;
  const focusFallback = () => {
    if (onFallbackFocus?.()) return;
    const primary = fallbackFocusRef.current;
    const target = primary && !primary.matches(":disabled") ? primary : alternateFallbackFocusRef?.current;
    target?.focus();
  };

  useIsomorphicLayoutEffect(() => {
    const requestChanged = previousRequestRef.current !== requestId;
    if (requestChanged && previousRequestWasQuestionRef.current && previousRequestRef.current) {
      clearQuestionDrafts(sessionId, previousRequestRef.current);
    }
    const focusDestination = approvalFocusDestination(previousRequestRef.current, requestId, ownedFocusBeforeRender);
    previousRequestRef.current = requestId;
    previousRequestWasQuestionRef.current = requestIsQuestion;
    const activeRegion = requestRegionFor(document.activeElement);
    const representationMoved = !requestChanged && ownedFocusBeforeRender &&
      (activeRegion?.dataset.sessionRequestId !== requestId || activeRegion?.dataset.sessionRequestSession !== sessionId);
    if (focusDestination === "request" || representationMoved) {
      const target = requestId ? enabledRequestControl(
        sessionId,
        requestId,
        representationMoved ? focusedControlBeforeRender : null,
      ) : null;
      if (target) target.focus();
      else focusFallback();
      return;
    }
    if (focusDestination === "fallback") focusFallback();
  }, [alternateFallbackFocusRef, fallbackFocusRef, onFallbackFocus, ownedFocusBeforeRender, requestId,
    requestIsQuestion, requestPresentation, sessionId]);

  useEffect(() => {
    if (announcedRequestRef.current === requestId) return;
    const hadRequest = announcedRequestRef.current !== null;
    announcedRequestRef.current = requestId;
    setAnnouncement(requestId ? (hadRequest ? "Agent request updated" : "Agent response required") : "Agent request resolved");
  }, [requestId]);

  useIsomorphicLayoutEffect(() => {
    const wentOffline = previousRunnerOnlineRef.current && !runnerOnline;
    previousRunnerOnlineRef.current = runnerOnline;
    if (!wentOffline || !requestWasUnchangedBeforeRender || !ownedFocusBeforeRender ||
      requestId === null || !focusedElementBeforeRender) return;
    if (!focusedElementBeforeRender.matches(":disabled")
      && focusedElementBeforeRender.getAttribute("aria-disabled") !== "true") return;
    focusFallback();
  }, [alternateFallbackFocusRef, fallbackFocusRef, focusedElementBeforeRender, onFallbackFocus,
    ownedFocusBeforeRender, requestId, requestWasUnchangedBeforeRender, runnerOnline]);

  return <span className="sr-only" role="status" aria-live="polite">{announcement}</span>;
}

export function SessionApprovalBanner({
  session,
  runnerOnline,
  onSessionUpdate,
  showKeyHints = true,
  presentation = "banner",
}: {
  session: SessionView;
  runnerOnline: boolean;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
  presentation?: "banner" | "review";
}) {
  const api = useApi();
  const instanceScope = useInstanceScope();
  const approval = session.pendingApproval!;
  const runner = useOptionalStoreSelector((state) => state.runners.get(session.runnerId));
  // A person the server refuses a decision (a Viewer) reads the request with every option disabled
  // and the reason beside them (#1857).
  const responseRefusal = sessionCommandRefusal(session, "respond");
  const responseRefusalId = useId();
  const providerLogin = runner?.providerLogins?.find(
    (login) => login.sessionId === session.id && login.status !== "succeeded" && login.status !== "cancelled",
  );
  const workflowDecision = approval.kind === "workflow_decision" ? approval.workflowDecision : undefined;
  const evidenceSnapshot = workflowDecision?.resourceSnapshot.category === "ui_evidence_approval"
    ? workflowDecision.resourceSnapshot : null;
  const evidenceDecision = evidenceSnapshot ? workflowDecision! : null;
  const evidence = evidenceSnapshot?.evidence ?? [];
  const evidenceIds = evidence.map((item) => item.evidenceId);
  const [busy, setBusy] = useState(false);
  const [showContext, setShowContext] = useState(evidence.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [reviewedEvidence, setReviewedEvidence] = useState<string[]>(() => evidenceDecision
    ? loadEvidenceReviewDraft(
        instanceScope,
        session.id,
        approval.requestId,
        evidenceDecision.resourceDigest,
        evidenceIds,
      )
    : []);
  const contextId = useId();
  const isPolicy = isPolicyApproval(approval);
  const decisionNeedsRunner = approval.kind !== "policy_hook" && approval.kind !== "workflow_decision";
  // An artifact-backed item counts as reviewed only once its verified image was actually shown. A
  // saved mark from an earlier visit does not survive the artifact turning out missing, mismatched,
  // or uncheckable in this browser. An artifact's `uri`, if any, never stands in for the checked
  // bytes, so an artifact of a media type the card cannot show stays blocked.
  const [artifactStatus, setArtifactStatus] = useState<Record<string, EvidenceArtifactStatus>>({});
  const evidenceBlocked = (item: (typeof evidence)[number]) => {
    if (!isRenderableEvidence(item)) return isArtifactBackedEvidence(item) || !item.uri;
    return evidenceStatusBlocksReview(artifactStatus[item.evidenceId] ?? "pending");
  };
  const evidenceComplete = evidence.every((item) =>
    reviewedEvidence.includes(item.evidenceId) && !evidenceBlocked(item));
  // The total counts what the checkboxes show, so a saved mark on an item this page cannot show
  // is not reported as reviewed.
  const reviewedCount = evidence.filter((item) =>
    reviewedEvidence.includes(item.evidenceId) && !evidenceBlocked(item)).length;
  const onArtifactStatus = (evidenceId: string, status: EvidenceArtifactStatus) =>
    setArtifactStatus((current) => current[evidenceId] === status ? current : { ...current, [evidenceId]: status });

  useEffect(() => {
    setReviewedEvidence(evidenceDecision
      ? loadEvidenceReviewDraft(
          instanceScope,
          session.id,
          approval.requestId,
          evidenceDecision.resourceDigest,
          evidenceIds,
        )
      : []);
    setShowContext(evidence.length === 0);
    setError(null);
    setBusy(false);
  // The ids and digest are the immutable identity of this exact review occurrence.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval.requestId, evidenceDecision?.resourceDigest, instanceScope, session.id]);

  const updateEvidence = (evidenceId: string, checked: boolean) => {
    if (!evidenceDecision) return;
    setReviewedEvidence((current) => {
      const next = checked
        ? [...new Set([...current, evidenceId])]
        : current.filter((candidate) => candidate !== evidenceId);
      saveEvidenceReviewDraft(
        instanceScope,
        session.id,
        approval.requestId,
        evidenceDecision.resourceDigest,
        next,
      );
      return next;
    });
  };

  const decide = async (optionId: string | null) => {
    if (responseRefusal !== null) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.approve(session.id, {
        requestId: approval.requestId,
        optionId,
        ...(evidence.length && optionId === "approve" ? { evidenceReviewed: reviewedEvidence } : {}),
        ...(evidenceDecision && optionId === "approve" && evidence.some((item) => item.uri === undefined)
          ? { evidenceReviewDigest: evidenceDecision.resourceDigest }
          : {}),
      });
      if (evidenceDecision) {
        clearEvidenceReviewDraft(
          instanceScope,
          session.id,
          approval.requestId,
          evidenceDecision.resourceDigest,
        );
      }
      onSessionUpdate?.(updated);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (approval.kind === "question") {
    return (
      <SessionQuestionBanner
        sessionId={session.id}
        requestId={approval.requestId}
        occurrenceId={approval.occurrenceId}
        questions={approval.questions ?? []}
        isAsync={approval.async}
        recoveryReason={approval.recoveryReason}
        recoveryAction={approval.recoveryAction}
        runnerOnline={runnerOnline}
        responseRefusal={responseRefusal}
        onSessionUpdate={onSessionUpdate}
        showKeyHints={showKeyHints}
      />
    );
  }

  const refusalNote = responseRefusal !== null && (
    <p className="muted approval-refusal" id={responseRefusalId}>{responseRefusal}</p>
  );
  const refusalDescription = responseRefusal !== null ? responseRefusalId : undefined;

  if (presentation === "review" && evidenceDecision) {
    return (
      <section className="evidence-review-surface" aria-label="UI Evidence Review" aria-busy={busy}>
        <div className="evidence-review-summary">
          <div>
            <h3>{approval.title}</h3>
            <p>Review every artifact before approving this request.</p>
            {evidenceDecision.humanFallback && <p className="muted">
              UI Evidence Approval is assigned to the Orchestrator, but this request needs a human. {evidenceDecision.humanFallback.reason}
            </p>}
          </div>
          <strong role="status" aria-live="polite">
            {reviewedCount} of {evidence.length} Reviewed
          </strong>
        </div>
        <div className="evidence-review-list" aria-label="Evidence Items">
          {/* In the list rather than the summary: it needs the full width, and in a short panel it
              scrolls with the items instead of crowding them out. */}
          <EvidenceSecureContextNotice evidence={evidence} />
          {evidence.map((item, index) => (
            <article className="evidence-review-item" key={item.evidenceId}>
              <div className="evidence-review-item-main">
                <span className="evidence-review-index" aria-hidden="true">{index + 1}</span>
                <div>
                  <strong>{item.evidenceId}</strong>
                  {!isArtifactBackedEvidence(item) && item.uri && (
                    <a
                      className="btn ghost sm"
                      href={item.uri}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`View External Evidence: ${item.evidenceId}`}
                    >
                      View External Evidence
                    </a>
                  )}
                  {!isArtifactBackedEvidence(item) && !item.uri && (
                    <p className="form-error" role="alert">This evidence has no viewable artifact or external link.</p>
                  )}
                </div>
              </div>
              {isRenderableEvidence(item)
                ? <EvidenceArtifactView item={item} onStatusChange={onArtifactStatus} />
                : isArtifactBackedEvidence(item) && <UnrenderableEvidenceArtifact item={item} />}
              <label className="evidence-reviewed-control">
                <Checkbox
                  label={`Mark ${item.evidenceId} as Reviewed`}
                  checked={reviewedEvidence.includes(item.evidenceId) && !evidenceBlocked(item)}
                  disabled={evidenceBlocked(item)}
                  onChange={(checked) => updateEvidence(item.evidenceId, checked)}
                />
                Reviewed
              </label>
            </article>
          ))}
          <details className="evidence-review-details">
            <summary>Advanced Details</summary>
            <dl>
              <div><dt>Resource Key</dt><dd>{evidenceDecision.resourceKey}</dd></div>
              <div><dt>Resource Digest</dt><dd>{evidenceDecision.resourceDigest}</dd></div>
            </dl>
          </details>
        </div>
        {error && <div className="form-error" role="alert">Approval failed: {error}</div>}
        {refusalNote}
        <div className="evidence-review-actions">
          {approval.options.map((option) => {
            const blocksApproval = option.optionId === "approve" && !evidenceComplete;
            const blocksProviderLogin = option.optionId === "auth:login" && runner?.canManage === false;
            return (
              <button
                key={option.optionId}
                type="button"
                className={`btn ${option.kind?.startsWith("allow") ? "primary" : "ghost danger"}`}
                disabled={busy || blocksApproval || blocksProviderLogin || responseRefusal !== null}
                aria-describedby={refusalDescription}
                onClick={() => void decide(option.optionId)}
              >
                {busy ? "Submitting…" : option.name}
              </button>
            );
          })}
        </div>
      </section>
    );
  }

  if (presentation === "review") {
    return (
      <section className="approval-review-surface" aria-label="Approval Review" aria-busy={busy}>
        <div className="approval-review-summary">
          <h3>{approval.title}</h3>
          <p>
            Review the request details before choosing an action.
            {!runnerOnline && decisionNeedsRunner && " The runner is offline."}
          </p>
        </div>
        <div className="approval-review-body">
          {authenticationRecoveryPanelApplies(session, approval) && (
            <AuthenticationRecoveryPanel session={session} approval={approval} runner={runner} runnerOnline={runnerOnline} />
          )}
          <ApprovalSelectorContext context={approval.context} />
          {approval.context?.input && (
            <details className="approval-review-details">
              <summary>Request Details</summary>
              <pre className="approval-context">{approval.context.input}</pre>
            </details>
          )}
        </div>
        {error && <div className="form-error" role="alert">Approval failed: {error}</div>}
        {refusalNote}
        <div className="approval-review-actions">
          {approval.options.map((option) => (
            <button
              key={option.optionId}
              type="button"
              title={option.optionId === "auth:login" && runner?.canManage === false
                ? "Machine owner or organization admin permission is required"
                : option.description}
              className={`btn ${option.kind?.startsWith("allow") ? "primary" : "ghost danger"}`}
              disabled={busy || (decisionNeedsRunner && !runnerOnline) ||
                (option.optionId === "auth:login" && runner?.canManage === false) || responseRefusal !== null}
              aria-describedby={refusalDescription}
              onClick={() => void decide(option.optionId)}
            >
              {busy ? "Submitting…" : option.name}
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section
      className={`approval-bar${isPolicy ? " cost-budget" : ""}`}
      aria-label={approval.kind === "authentication" ? approval.title
        : approval.kind === "workflow_decision" ? "Workflow Decision Required" : "Agent Approval Required"}
    >
      <div className="approval-main">
        <span className="approval-icon" aria-hidden="true">
          {approval.kind === "cost_budget" || approval.kind === "cost_checkpoint" ? "💰"
            : approval.kind === "daily_budget" ? "📅"
              : approval.kind === "cost_unpriced" ? "❓"
                : approval.kind === "max_tool_calls" ? "🧰" : approval.kind === "authentication" ? "🔑"
                  : approval.kind === "workflow_decision" ? "🛡️" : "🔐"}
        </span>
        <span className="approval-text">
          {approval.title}
          {!runnerOnline && decisionNeedsRunner && <span className="muted"> · Runner Offline</span>}
        </span>
        <div className="approval-actions">
          {approval.context?.input && (
            <button
              className="btn ghost sm"
              type="button"
              aria-expanded={showContext}
              aria-controls={contextId}
              onClick={() => setShowContext((value) => !value)}
            >
              {showContext ? "Hide Details" : "Details"}
            </button>
          )}
          {approval.options.map((option) => {
            const keyHint = showKeyHints ? approvalKeyHintForOption(approval.options, option.optionId) : null;
            const evidenceBlocksApproval = evidence.length > 0 && option.optionId === "approve" && !evidenceComplete;
            const providerLoginBlocked = option.optionId === "auth:login" && runner?.canManage === false;
            return (
              <button
                key={option.optionId}
                type="button"
                title={providerLoginBlocked
                  ? "Machine owner or organization admin permission is required"
                  : option.description}
                className={`btn sm ${option.kind?.startsWith("allow") ? "primary" : "ghost danger"}`}
                disabled={busy || evidenceBlocksApproval || providerLoginBlocked ||
                  (decisionNeedsRunner && !runnerOnline) || responseRefusal !== null}
                aria-describedby={refusalDescription}
                onClick={() => void decide(option.optionId)}
              >
                {option.name}
                {keyHint && <kbd>{keyHint}</kbd>}
              </button>
            );
          })}
        </div>
      </div>
      {refusalNote}
      {approval.kind === "authentication" && providerLogin && (
        <ProviderLoginCard runnerId={session.runnerId} login={providerLogin} />
      )}
      {authenticationRecoveryPanelApplies(session, approval) && (
        <AuthenticationRecoveryPanel session={session} approval={approval} runner={runner} runnerOnline={runnerOnline} />
      )}
      {evidence.length > 0 && (
        <div className="approval-evidence" aria-label="Evidence Review">
          <p>Open and inspect each evidence item, then mark it as reviewed.</p>
          <EvidenceSecureContextNotice evidence={evidence} />
          {evidence.map((item) => (
            <div className="approval-evidence-item" key={item.evidenceId}>
              {isRenderableEvidence(item)
                ? <>
                    <strong>{item.evidenceId}</strong>
                    <EvidenceArtifactView item={item} onStatusChange={onArtifactStatus} />
                  </>
                : isArtifactBackedEvidence(item)
                  ? <>
                      <strong>{item.evidenceId}</strong>
                      <UnrenderableEvidenceArtifact item={item} />
                    </>
                : item.uri
                  ? <a className="link" href={item.uri} target="_blank" rel="noreferrer">Open External Evidence: {item.evidenceId}</a>
                  : <p className="form-error" role="alert">This evidence has no viewable artifact or external link.</p>}
              <label>
                <Checkbox
                  label={`Mark ${item.evidenceId} as Reviewed`}
                  checked={reviewedEvidence.includes(item.evidenceId) && !evidenceBlocked(item)}
                  disabled={evidenceBlocked(item)}
                  onChange={(checked) => updateEvidence(item.evidenceId, checked)}
                />
                I reviewed this evidence.
              </label>
            </div>
          ))}
        </div>
      )}
      {approval.kind === "policy_hook" && (
        <ApprovalSelectorContext context={approval.context} />
      )}
      {showContext && approval.context?.input && (
        <pre className="approval-context" id={contextId}>{approval.context.input}</pre>
      )}
      {error && <div className="form-error" role="alert">Approval failed: {error}</div>}
    </section>
  );
}

/** Structured agent questions with two presentations over one request-keyed canonical draft. */
export function SessionQuestionBanner({
  sessionId,
  requestId,
  occurrenceId,
  questions,
  isAsync,
  recoveryReason,
  recoveryAction,
  runnerOnline,
  responseRefusal: responseRefusalOverride,
  onSessionUpdate,
  showKeyHints = true,
}: {
  sessionId: string;
  requestId: string;
  occurrenceId?: string;
  questions: AgentQuestion[];
  isAsync?: boolean;
  recoveryReason?: "provider_restart";
  recoveryAction?: "resume_answer";
  runnerOnline: boolean;
  /** Why the signed-in person may not answer (#1857); read from the session's view by default. */
  responseRefusal?: string | null;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
}) {
  const api = useApi();
  const storedRefusal = useSessionResponseRefusal(sessionId);
  const responseRefusal = responseRefusalOverride === undefined ? storedRefusal : responseRefusalOverride;
  // A refused person reads the question like one whose runner is offline: every response control
  // is unavailable and the availability line says why. Runner Offline itself stays the runner's.
  const responsesAvailable = runnerOnline && responseRefusal === null;
  const responseStyle = useQuestionResponseStyle();
  const answerKey = isAsync && occurrenceId ? `${requestId}:${occurrenceId}` : requestId;
  const [busy, setBusy] = useState<"submit" | "dismiss" | null>(null);
  const [drafts, setDrafts] = useState<{
    requestId: string;
    values: Record<string, QuestionResponseDraft>;
  }>(() => ({
    requestId: answerKey,
    values: storedQuestionDrafts(sessionId, answerKey),
  }));
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationPendingRef = useRef<object | null>(null);
  const liveRequestRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    // Retire callbacks at commit, including when the same request is later remounted.
    liveRequestRef.current = {};
    operationPendingRef.current = null;
    return () => { liveRequestRef.current = null; };
  }, [answerKey, sessionId]);
  const questionBlockRefs = useRef(new Map<string, HTMLDivElement | null>());
  const previousDraftRequestRef = useRef({ sessionId, requestId: answerKey });
  // React's opaque useId contains colons. They are valid in HTML ids but break the selector-based
  // HTMLInputElement.list lookup used by some DOM implementations, so keep this idref family plain.
  const labelPrefix = useId().replace(/:/g, "");
  const availabilityId = `${labelPrefix}-availability`;
  const recoveryId = `${labelPrefix}-recovery`;
  const recoveryRequired = recoveryReason === "provider_restart";
  const recoveryCanResume = recoveryRequired && recoveryAction === "resume_answer";
  const recoveryRequiresDismiss = recoveryRequired && !recoveryCanResume;

  useEffect(() => {
    const previous = previousDraftRequestRef.current;
    if (previous.sessionId !== sessionId || previous.requestId !== answerKey) {
      clearQuestionDrafts(previous.sessionId, previous.requestId);
      clearQuestionDrafts(sessionId, answerKey);
      previousDraftRequestRef.current = { sessionId, requestId: answerKey };
      setDrafts({ requestId: answerKey, values: {} });
    } else {
      setDrafts({ requestId: answerKey, values: storedQuestionDrafts(sessionId, answerKey) });
    }
    setValidationAttempted(false);
    setBusy(null);
    setError(null);
  }, [answerKey, sessionId]);

  useEffect(() => {
    setDrafts({ requestId: answerKey, values: storedQuestionDrafts(sessionId, answerKey) });
    setValidationAttempted(false);
  }, [answerKey, responseStyle, sessionId]);

  const draftValues = drafts.requestId === answerKey ? drafts.values : {};
  const draftValue = (questionId: string) => Object.hasOwn(draftValues, questionId) ? draftValues[questionId] : undefined;
  const resolved = questionDraftAnswers(questions, draftValues);
  const unsupportedQuestionFormat = questions.some((question) => !isAnswerableAgentQuestion(question));
  const controlsDisabled = busy !== null || !responsesAvailable || unsupportedQuestionFormat || recoveryRequiresDismiss;
  const fixedChoicesNativelyDisabled = busy !== null || unsupportedQuestionFormat || recoveryRequiresDismiss;

  const updateDraft = (question: AgentQuestion, value: QuestionResponseDraft) => {
    setDrafts((current) => {
      const values = { ...(current.requestId === answerKey ? current.values : {}), [question.id]: value };
      const cacheable: Record<string, QuestionResponseDraft> = {};
      for (const candidate of questions) {
        if (candidate.secret || !Object.hasOwn(values, candidate.id)) continue;
        Object.defineProperty(cacheable, candidate.id, {
          value: values[candidate.id],
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      storeQuestionDrafts(sessionId, answerKey, cacheable);
      return { requestId: answerKey, values };
    });
  };

  const toggle = (question: AgentQuestion, label: string) => {
    const selected = questionDraftSelections(question, draftValue(question.id));
    const labels = question.multiSelect
      ? selected.includes(label) ? selected.filter((candidate) => candidate !== label) : [...selected, label]
      : [label];
    updateDraft(question, { kind: "choice", labels });
  };

  const complete = !unsupportedQuestionFormat && Object.keys(resolved.errors).length === 0;

  const submit = async () => {
    if (operationPendingRef.current || busy !== null || !responsesAvailable || unsupportedQuestionFormat || recoveryRequiresDismiss) return;
    if (Object.keys(resolved.errors).length > 0) {
      setValidationAttempted(true);
      const validatingRequest = liveRequestRef.current;
      const firstInvalid = questions.find((question) => Object.hasOwn(resolved.errors, question.id));
      window.requestAnimationFrame(() => {
        if (liveRequestRef.current !== validatingRequest) return;
        questionBlockRefs.current.get(firstInvalid?.id ?? "")
          ?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled):not([aria-disabled=true])")
          ?.focus();
      });
      return;
    }
    const releaseOperation = claimQuestionResponseOperation(sessionId, answerKey);
    if (!releaseOperation) {
      setError("Another response is already being submitted for this question.");
      return;
    }
    const submittedRequest = liveRequestRef.current;
    const operation = {};
    operationPendingRef.current = operation;
    setBusy("submit");
    setError(null);
    try {
      const updated = await api.answerQuestion(sessionId, {
        requestId, ...(occurrenceId ? { occurrenceId } : {}), answers: resolved.answers, action: "submit",
      });
      if (liveRequestRef.current !== submittedRequest) return;
      clearQuestionDrafts(sessionId, answerKey);
      onSessionUpdate?.(updated);
    } catch (cause) {
      if (liveRequestRef.current === submittedRequest) setError((cause as Error).message);
    } finally {
      releaseOperation();
      if (operationPendingRef.current === operation) operationPendingRef.current = null;
      if (liveRequestRef.current === submittedRequest) setBusy(null);
    }
  };

  const dismiss = async () => {
    if (operationPendingRef.current || busy !== null || !responsesAvailable) return;
    const releaseOperation = claimQuestionResponseOperation(sessionId, answerKey);
    if (!releaseOperation) {
      setError("Another response is already being submitted for this question.");
      return;
    }
    const submittedRequest = liveRequestRef.current;
    const operation = {};
    operationPendingRef.current = operation;
    setBusy("dismiss");
    setError(null);
    try {
      const updated = await api.answerQuestion(sessionId, {
        requestId, ...(occurrenceId ? { occurrenceId } : {}), answers: {}, action: "dismiss",
      });
      if (liveRequestRef.current !== submittedRequest) return;
      clearQuestionDrafts(sessionId, answerKey);
      onSessionUpdate?.(updated);
    } catch (cause) {
      if (liveRequestRef.current === submittedRequest) setError((cause as Error).message);
    } finally {
      releaseOperation();
      if (operationPendingRef.current === operation) operationPendingRef.current = null;
      if (liveRequestRef.current === submittedRequest) setBusy(null);
    }
  };

  return (
    <section
      className={`approval-bar question-bar question-style-${responseStyle}`}
      aria-label="Agent Questions"
      aria-busy={busy !== null}
      onKeyDown={(event) => {
        if (responseStyle !== "interactive" || event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
        event.preventDefault();
        void submit();
      }}
    >
      <div className="approval-main">
        <span className="approval-icon" aria-hidden="true">❓</span>
        <span className="approval-text">
          {isAsync ? "Async Agent Question" : recoveryRequired
            ? "Agent Question Recovery Required"
            : `The agent has ${questions.length === 1 ? "a question" : `${questions.length} questions`}`}
          {!runnerOnline && <span className="muted"> · Runner Offline</span>}
        </span>
        <div className="approval-actions">
          <button
            className="btn ghost sm"
            type="button"
            data-session-request-control="dismiss"
            aria-describedby={!responsesAvailable ? availabilityId : undefined}
            disabled={busy !== null || !responsesAvailable}
            onClick={() => void dismiss()}
          >
            {busy === "dismiss" ? "Dismissing…" : recoveryRequired ? "Dismiss and Continue" : "Dismiss"} {showKeyHints && busy === null && <kbd>D</kbd>}
          </button>
          {responseStyle === "interactive" && questions.length > 0 && !recoveryRequiresDismiss && (
            <button
              className="btn sm primary"
              type="button"
              data-session-request-control="submit"
              aria-describedby={!responsesAvailable ? availabilityId : undefined}
              disabled={busy !== null || !responsesAvailable || !complete}
              onClick={() => void submit()}
            >
              {busy === "submit" ? "Submitting…" : "Submit"}
            </button>
          )}
        </div>
      </div>
      <div id={availabilityId} className="question-availability" role="status" aria-atomic="true">
        {responseRefusal ?? (runnerOnline ? "" : "Responses are unavailable until the runner reconnects.")}
      </div>
      {recoveryRequired && (
        <div className="question-recovery" id={recoveryId} role="status">
          {recoveryCanResume
            ? "The runner restarted after this question was asked. Submit the preserved form to resume the existing agent conversation and deliver these answers once. Prior tool calls will not be replayed."
            : "The runner restarted after this question was asked, so its original answer channel is no longer available. Review the preserved question, then dismiss it and send a new prompt to continue safely. No prior tool calls will be replayed."}
        </div>
      )}
      {responseStyle === "composer" && questions.length > 0 && !recoveryRequiresDismiss && (
        <div className="question-submit-hint">
          Respond through Answer Mode in the Session composer. Press R or use <code>/respond</code>.
        </div>
      )}
      {responseStyle === "interactive" && responsesAvailable && busy === null && questions.length > 0 && !complete && !recoveryRequiresDismiss && (
        <div className="question-submit-hint">
          {unsupportedQuestionFormat
            ? "This question format is unsupported. Dismiss the question to continue."
            : validationAttempted || Object.keys(resolved.errors).some((id) => questionDraftText(draftValue(id)).trim())
              ? "Correct the response errors before submitting."
              : "Complete all required responses before submitting."}
        </div>
      )}
      <div className="question-list">
        {questions.map((question, questionIndex) => {
          const questionLabelId = `${labelPrefix}-question-${questionIndex}`;
          const responseLabelId = `${labelPrefix}-response-${questionIndex}`;
          const contextId = `${labelPrefix}-context-${questionIndex}`;
          const requirementId = `${labelPrefix}-requirement-${questionIndex}`;
          const responseErrorId = `${labelPrefix}-response-error-${questionIndex}`;
          const offeredChoicesId = `${labelPrefix}-offered-choices-${questionIndex}`;
          const draft = draftValue(question.id);
          const rawValue = questionDraftText(draft);
          const selected = questionDraftSelections(question, draft);
          const responseError = Object.hasOwn(resolved.errors, question.id) ? resolved.errors[question.id] : undefined;
          const showResponseError = Boolean(responseError && (validationAttempted || rawValue.trim()));
          const controlDescriptionIds = [
            question.context ? contextId : null,
            requirementId,
            recoveryRequired ? recoveryId : null,
            !responsesAvailable ? availabilityId : null,
          ]
            .filter((value): value is string => value !== null);
          const inputDescriptionIds = [...controlDescriptionIds, showResponseError ? responseErrorId : null]
            .filter((value): value is string => value !== null)
            .join(" ");
          return (
            <div
              className="question-block"
              key={question.id}
              ref={(element) => { questionBlockRefs.current.set(question.id, element); }}
            >
              <div className="question-text" id={questionLabelId}>
                {question.header && <span className="question-chip">{question.header}</span>}
                <StructuredQuestionText>{question.question}</StructuredQuestionText>
                {question.multiSelect && <span className="muted sm"> (select all that apply)</span>}
              </div>
              <span className="sr-only" id={requirementId}>
                {question.required === false ? "This question is optional." : "An answer to this question is required."}
              </span>
              {question.context && (
                <div className="question-context" id={contextId}>
                  <StructuredQuestionText>{question.context}</StructuredQuestionText>
                </div>
              )}
              {responseStyle === "interactive" && question.options.length > 0 && (
                <div
                  className="question-options"
                  role={question.multiSelect ? "group" : "radiogroup"}
                  aria-labelledby={questionLabelId}
                  aria-describedby={inputDescriptionIds}
                  aria-required={question.multiSelect ? undefined : question.required !== false}
                  onKeyDown={question.multiSelect ? undefined : (event) => handleRovingChoiceKeyDown(
                    event,
                    "radio",
                    { includeAriaDisabled: !responsesAvailable, activate: responsesAvailable },
                  )}
                >
                  {question.options.map((option, optionIndex) => {
                    const on = selected.includes(option.label);
                    return (
                      <button
                        key={option.label}
                        type="button"
                        data-session-request-control={`question:${question.id}:option:${optionIndex}`}
                        role={question.multiSelect ? "checkbox" : "radio"}
                        aria-checked={on}
                        aria-disabled={controlsDisabled || undefined}
                        disabled={fixedChoicesNativelyDisabled}
                        tabIndex={fixedChoicesNativelyDisabled
                          ? -1
                          : question.multiSelect ? 0 : on || (selected.length === 0 && optionIndex === 0) ? 0 : -1}
                        className={`question-option${on ? " on" : ""}`}
                        title={option.description}
                        onClick={() => { if (!controlsDisabled) toggle(question, option.label); }}
                      >
                        <span className="question-mark" aria-hidden="true">{question.multiSelect ? (on ? "☑" : "☐") : on ? "●" : "○"}</span>
                        <span>
                          <span className="question-label">{option.label}</span>
                          {option.description && <span className="question-desc">{option.description}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {responseStyle === "interactive" && question.options.length > 0 && !question.allowOther && showResponseError && (
                <span className="form-error question-field-error" id={responseErrorId} role="alert">
                  {responseError}
                </span>
              )}
              {responseStyle === "interactive" && question.allowOther && !question.multiSelect && (
                <label className="question-input-label">
                  <span id={responseLabelId}>{question.options.length > 0 ? "Other Response" : "Response"}</span>
                  {question.required === false && <span className="muted sm"> (optional)</span>}
                  <input
                    className="input question-input"
                    data-session-request-control={`question:${question.id}:input`}
                    aria-labelledby={`${questionLabelId} ${responseLabelId}`}
                    aria-describedby={inputDescriptionIds}
                    aria-invalid={showResponseError ? true : undefined}
                    aria-required={question.options.length === 0 ? question.required !== false : undefined}
                    required={question.options.length === 0 && question.required !== false}
                    disabled={controlsDisabled}
                    type={question.secret
                      ? "password"
                      : question.inputFormat === "date-time"
                        ? "datetime-local"
                        : question.inputFormat === "integer" || question.inputFormat === "number"
                          ? "number"
                          : question.inputFormat ?? "text"}
                    inputMode={question.inputFormat === "integer" ? "numeric" : question.inputFormat === "number" ? "decimal" : undefined}
                    step={question.inputFormat === "integer" ? 1 : question.inputFormat === "number" ? "any" : undefined}
                    min={question.minimum}
                    max={question.maximum}
                    minLength={question.minLength}
                    maxLength={question.maxLength ?? DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH}
                    value={draft?.kind === "other" || (draft?.kind === "entry" && selected.length === 0) ? rawValue : ""}
                    autoComplete="off"
                    onChange={(event) => updateDraft(question, { kind: "other", value: event.target.value })}
                  />
                  {showResponseError && (
                    <span className="form-error question-field-error" id={responseErrorId} role="alert">
                      {responseError}
                    </span>
                  )}
                </label>
              )}
              {responseStyle === "composer" && question.options.length > 0 && (
                <>
                  <ol className="question-text-options" id={offeredChoicesId} aria-label="Offered Choices">
                    {question.options.map((option) => (
                      <li key={option.label}>
                        <span className="question-label">{option.label}</span>
                        {option.description && <span className="question-desc">{option.description}</span>}
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          );
        })}
      </div>
      {error && <div className="form-error" role="alert">Could not answer the question: {error}</div>}
    </section>
  );
}
