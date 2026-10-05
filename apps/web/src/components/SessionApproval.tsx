import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AgentQuestion, PendingApproval, SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useOptionalStoreSelector } from "../store.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import {
  clearQuestionDrafts,
  claimQuestionResponseOperation,
  isAnswerableAgentQuestion,
  questionDraftAnswers,
  questionDraftSelections,
  storedQuestionDrafts,
  storedQuestionStep,
  storeQuestionDrafts,
  storeQuestionStep,
  type QuestionResponseDraft,
} from "../question-response.js";
import { useQuestionResponseStyle } from "../question-response-style.js";
import { useInstanceScope } from "../instance-scope.js";
import { clearEvidenceReviewDraft } from "../evidence-review-drafts.js";
import { sessionAgentLabel } from "./agent-options.js";
import { QuestionIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StructuredQuestionText } from "./StructuredQuestionText.js";
import { BusyButton } from "./ui/BusyButton.js";
import { RequestCardHead } from "./requests/RequestCard.js";
import {
  QUESTION_CARD_COPY,
  QuestionStep,
  questionEyebrowParts,
  questionOtherChosen,
  questionStepLabel,
  type QuestionChoice,
} from "./requests/QuestionStep.js";
import { revealDockedRequest } from "./requests/request-reveal.js";

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

/** Stable focus/live boundary across coalesced approval replacement and final resolution. The
 * session's own non-question requests are answered on the request dock above the composer (#2179);
 * this region keeps a pending question in its current place until #2205 docks questions too. */
export function SessionApprovalRegion({
  session,
  runnerOnline,
  fallbackFocusRef,
  alternateFallbackFocusRef,
  onFallbackFocus,
  onSessionUpdate,
  showKeyHints = true,
  questionInTimeline = false,
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
}) {
  const approval = session.pendingApproval;
  const questionFallback = approval?.kind === "question" && !questionInTimeline;
  const requestPresentation = questionFallback ? "fallback" : approval?.kind === "question"
    ? "timeline" : approval ? "dock" : "none";
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
            owner={sessionAgentLabel(session.agentName, session.driver, session.agentId)}
          />
        </div>
      )}
    </>
  );
}

/** Clears the saved review of a UI evidence decision once it is no longer pending, wherever it was
 * resolved: on this card, on another device, or replaced by a new occurrence (#1107). */
export function useEvidenceDraftRetirement(sessionId: string, requests: readonly PendingApproval[]): void {
  const instanceScope = useInstanceScope();
  const identities = requests.flatMap((request) => {
    const decision = request.kind === "workflow_decision" ? request.workflowDecision : undefined;
    return decision?.resourceSnapshot.category === "ui_evidence_approval"
      ? [JSON.stringify([sessionId, request.requestId, decision.resourceDigest])]
      : [];
  });
  const signature = identities.join("\n");
  const previousRef = useRef<string[]>(identities);
  useEffect(() => {
    for (const previous of previousRef.current) {
      if (identities.includes(previous)) continue;
      const [previousSession, requestId, resourceDigest] = JSON.parse(previous) as [string, string, string];
      clearEvidenceReviewDraft(instanceScope, previousSession, requestId, resourceDigest);
    }
    previousRef.current = identities;
  // The signature is the set of identities.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceScope, signature]);
}

/** Keep one question representation at its event's timeline position while the request is live. */
export function SessionTimelineQuestionRegion({
  sessionId,
  pendingQuestion,
  eventRequestId,
  eventQuestions,
  eventResolved,
  eventCreatedAt,
  runnerOnline,
  onSessionUpdate,
  showKeyHints = true,
  owner,
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
  /** When the question's event was recorded, for the card's head line. */
  eventCreatedAt?: number;
  runnerOnline: boolean;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
  /** Who asks, for the card's head line. */
  owner?: string;
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
          owner={owner}
          createdAt={eventCreatedAt}
        />
      ) : children}
    </div>
  );
}

function requestRegionFor(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>("[data-session-request-id]") ?? null;
}

/** Navigate to an existing request without making a response button the implicit Enter target.
 * False when no mounted surface renders the request, so the caller can route elsewhere. */
export function focusSessionRequest(sessionId: string, requestId: string): boolean {
  if (revealDockedRequest(sessionId, requestId)) return true;
  const region = [...document.querySelectorAll<HTMLElement>("[data-session-request-id]")]
    .find((candidate) => candidate.dataset.sessionRequestId === requestId &&
      candidate.dataset.sessionRequestSession === sessionId);
  if (!region) return false;
  region.tabIndex = -1;
  region.scrollIntoView?.({ block: "nearest" });
  region.focus();
  return true;
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
    // A question's choice rows are native inputs that stay reachable while they refuse a choice
    // (`aria-disabled`), so they are no landing place then.
    'button:not(:disabled):not([aria-disabled="true"]), input:not(:disabled):not([aria-disabled="true"])',
  ) ?? []];
  // Composer Response owns entry outside this request region. On replacement, do not turn the
  // card's destructive Dismiss action into the implicit focus target for the user's next Enter.
  const eligible = region?.querySelector(".question-style-composer")
    ? controls.filter((control) => control.dataset.sessionRequestControl !== "dismiss")
    : controls;
  // A Request Card names its heading as the landing place: a new request is read before it is
  // answered, and its first button is not the one to press by default.
  return eligible.find((control) => control.dataset.sessionRequestControl === preferredControl) ??
    region?.querySelector<HTMLElement>("[data-session-request-focus]") ?? eligible[0] ?? null;
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
  requestPresentation: "fallback" | "timeline" | "dock" | "none";
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

/**
 * An agent's questions on the Request Card (docs/design-system.md §13.2; #2196), one question per
 * step over one request-keyed draft that also keeps the step, so a remounted card returns to the
 * same question with the same answers.
 *
 * Top to bottom: the head line (kind, owner, time), the question's header with "Choose one" or
 * "Choose any", the question as the card's heading, the step's body, a failed submission's notice,
 * the reasons nobody can answer now, and a footer whose order is fixed (§3.2): Dismiss at the far
 * left, the step count, Back, then Next or Submit Answers as the one primary, last.
 *
 * Keys, while focus is in the card: 1–9 pick the current question's rows, Enter moves on (Next,
 * then Submit Answers), Ctrl/Cmd+Enter submits from any step and D dismisses. In Composer Response
 * the card is the question's context only, answered in the composer.
 */
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
  owner,
  createdAt,
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
  /** Plain text for the head line: who asks. */
  owner?: string;
  /** When the question was asked, when known. */
  createdAt?: number;
}) {
  const api = useApi();
  const storedRefusal = useSessionResponseRefusal(sessionId);
  const responseRefusal = responseRefusalOverride === undefined ? storedRefusal : responseRefusalOverride;
  // A refused person reads the question like one whose runner is offline: every response control
  // is unavailable and the foot-note says why.
  const responsesAvailable = runnerOnline && responseRefusal === null;
  const responseStyle = useQuestionResponseStyle();
  const answerKey = isAsync && occurrenceId ? `${requestId}:${occurrenceId}` : requestId;
  const [busy, setBusy] = useState<"submit" | "dismiss" | null>(null);
  const [drafts, setDrafts] = useState<{
    requestId: string;
    values: Record<string, QuestionResponseDraft>;
    step: number;
  }>(() => ({
    requestId: answerKey,
    values: storedQuestionDrafts(sessionId, answerKey),
    step: storedQuestionStep(sessionId, answerKey),
  }));
  // The questions whose errors show: each one the person tried to move past unanswered (§8.5).
  const [attempted, setAttempted] = useState<ReadonlySet<string>>(() => new Set());
  const [failure, setFailure] = useState<{ action: "submit" | "dismiss"; detail: string } | null>(null);
  const operationPendingRef = useRef<object | null>(null);
  const liveRequestRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    // Retire callbacks at commit, including when the same request is later remounted.
    liveRequestRef.current = {};
    operationPendingRef.current = null;
    return () => { liveRequestRef.current = null; };
  }, [answerKey, sessionId]);
  const titleRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const previousDraftRequestRef = useRef({ sessionId, requestId: answerKey });
  // React's opaque useId contains colons. They are valid in HTML ids but break the selector-based
  // HTMLInputElement.list lookup used by some DOM implementations, so keep this idref family plain.
  const labelPrefix = useId().replace(/:/g, "");
  const availabilityId = `${labelPrefix}-availability`;
  const unsupportedId = `${labelPrefix}-unsupported`;
  const recoveryId = `${labelPrefix}-recovery`;
  const titleId = `${labelPrefix}-title`;
  const recoveryRequired = recoveryReason === "provider_restart";
  const recoveryCanResume = recoveryRequired && recoveryAction === "resume_answer";
  const recoveryRequiresDismiss = recoveryRequired && !recoveryCanResume;

  useEffect(() => {
    const previous = previousDraftRequestRef.current;
    if (previous.sessionId !== sessionId || previous.requestId !== answerKey) {
      clearQuestionDrafts(previous.sessionId, previous.requestId);
      clearQuestionDrafts(sessionId, answerKey);
      previousDraftRequestRef.current = { sessionId, requestId: answerKey };
      setDrafts({ requestId: answerKey, values: {}, step: 0 });
    } else {
      setDrafts({
        requestId: answerKey,
        values: storedQuestionDrafts(sessionId, answerKey),
        step: storedQuestionStep(sessionId, answerKey),
      });
    }
    setAttempted(new Set());
    setBusy(null);
    setFailure(null);
  }, [answerKey, sessionId]);

  useEffect(() => {
    setDrafts({
      requestId: answerKey,
      values: storedQuestionDrafts(sessionId, answerKey),
      step: storedQuestionStep(sessionId, answerKey),
    });
    setAttempted(new Set());
  }, [answerKey, responseStyle, sessionId]);

  const ownDrafts = drafts.requestId === answerKey;
  const draftValues = ownDrafts ? drafts.values : {};
  const draftValue = (questionId: string) => Object.hasOwn(draftValues, questionId) ? draftValues[questionId] : undefined;
  const resolved = questionDraftAnswers(questions, draftValues);
  const errorFor = (question: AgentQuestion) => {
    const error = Object.hasOwn(resolved.errors, question.id) ? resolved.errors[question.id] : undefined;
    if (error === undefined || question.options.length === 0) return error;
    // Nothing chosen yet: the error names the choice, not a response to type.
    const draft = draftValue(question.id);
    return questionOtherChosen(question, draft) || questionDraftSelections(question, draft).length > 0 ? error
      : question.multiSelect ? QUESTION_CARD_COPY.chooseOptions : QUESTION_CARD_COPY.chooseOption;
  };
  const unsupportedQuestionFormat = questions.some((question) => !isAnswerableAgentQuestion(question));
  const interactive = responseStyle === "interactive";
  const controlsDisabled = busy !== null || !responsesAvailable || unsupportedQuestionFormat || recoveryRequiresDismiss;
  // The form can be answered here: Next checks the step and the last step submits.
  const answerable = interactive && questions.length > 0 && responsesAvailable && !unsupportedQuestionFormat &&
    !recoveryRequiresDismiss;
  const stepCount = questions.length;
  const step = Math.min(Math.max(ownDrafts ? drafts.step : 0, 0), Math.max(stepCount - 1, 0));
  const question = questions[step];
  const lastStep = step >= stepCount - 1;

  const updateDraft = (target: AgentQuestion, value: QuestionResponseDraft) => {
    setDrafts((current) => {
      const own = current.requestId === answerKey;
      const values = { ...(own ? current.values : {}), [target.id]: value };
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
      return { requestId: answerKey, values, step: own ? current.step : 0 };
    });
  };

  const choose = (target: AgentQuestion, choice: QuestionChoice) => {
    if (controlsDisabled) return;
    const draft = draftValue(target.id);
    const otherChosen = questionOtherChosen(target, draft);
    if (choice === "other") {
      if (otherChosen && target.multiSelect) updateDraft(target, { kind: "choice", labels: [] });
      else if (!otherChosen) updateDraft(target, { kind: "other", value: "" });
      return;
    }
    const label = target.options[choice]?.label;
    if (label === undefined) return;
    const selected = questionDraftSelections(target, draft);
    const labels = target.multiSelect
      ? selected.includes(label) ? selected.filter((candidate) => candidate !== label) : [...selected, label]
      : [label];
    updateDraft(target, { kind: "choice", labels });
  };

  /** After the next paint, unless the card has moved on to another request by then. */
  const afterRender = (action: () => void) => {
    const request = liveRequestRef.current;
    window.requestAnimationFrame(() => {
      if (liveRequestRef.current === request) action();
    });
  };
  const focusStepControl = (target: AgentQuestion | undefined) => afterRender(() => {
    if (!target) return;
    const body = stepRef.current;
    const field = body?.querySelector<HTMLElement>(".question-input:not(:disabled)");
    const choice = body?.querySelector<HTMLElement>("input[type=radio]:checked, input[type=checkbox]:checked") ??
      body?.querySelector<HTMLElement>("input[type=radio], input[type=checkbox]");
    // The text is the answer to fix when there is no choice to make or Something Else is chosen.
    const textFirst = target.options.length === 0 || questionOtherChosen(target, draftValue(target.id));
    (textFirst ? field ?? choice : choice ?? field)?.focus();
  });
  const goToStep = (next: number, focus: "title" | "control" = "title") => {
    const clamped = Math.min(Math.max(next, 0), Math.max(stepCount - 1, 0));
    storeQuestionStep(sessionId, answerKey, clamped);
    setDrafts((current) => current.requestId === answerKey ? { ...current, step: clamped } : current);
    if (focus === "title") afterRender(() => titleRef.current?.focus());
    else focusStepControl(questions[clamped]);
  };
  /** Reveal the errors of `invalid` and move to the first of them (§8.5). */
  const showErrors = (invalid: readonly AgentQuestion[]) => {
    setAttempted((current) => new Set([...current, ...invalid.map((candidate) => candidate.id)]));
    const first = invalid[0];
    const firstStep = first ? questions.indexOf(first) : -1;
    if (firstStep >= 0 && firstStep !== step) goToStep(firstStep, "control");
    else focusStepControl(first);
  };

  const submit = async () => {
    if (operationPendingRef.current || busy !== null || !answerable) return;
    const invalid = questions.filter((candidate) => errorFor(candidate) !== undefined);
    if (invalid.length > 0) {
      showErrors(invalid);
      return;
    }
    const releaseOperation = claimQuestionResponseOperation(sessionId, answerKey);
    if (!releaseOperation) {
      setFailure({ action: "submit", detail: QUESTION_CARD_COPY.alreadySending });
      return;
    }
    const submittedRequest = liveRequestRef.current;
    const operation = {};
    operationPendingRef.current = operation;
    setBusy("submit");
    setFailure(null);
    try {
      const updated = await api.answerQuestion(sessionId, {
        requestId, ...(occurrenceId ? { occurrenceId } : {}), answers: resolved.answers, action: "submit",
      });
      if (liveRequestRef.current !== submittedRequest) return;
      clearQuestionDrafts(sessionId, answerKey);
      onSessionUpdate?.(updated);
    } catch (cause) {
      if (liveRequestRef.current === submittedRequest) setFailure({ action: "submit", detail: (cause as Error).message });
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
      setFailure({ action: "dismiss", detail: QUESTION_CARD_COPY.alreadySending });
      return;
    }
    const submittedRequest = liveRequestRef.current;
    const operation = {};
    operationPendingRef.current = operation;
    setBusy("dismiss");
    setFailure(null);
    try {
      const updated = await api.answerQuestion(sessionId, {
        requestId, ...(occurrenceId ? { occurrenceId } : {}), answers: {}, action: "dismiss",
      });
      if (liveRequestRef.current !== submittedRequest) return;
      clearQuestionDrafts(sessionId, answerKey);
      onSessionUpdate?.(updated);
    } catch (cause) {
      if (liveRequestRef.current === submittedRequest) setFailure({ action: "dismiss", detail: (cause as Error).message });
    } finally {
      releaseOperation();
      if (operationPendingRef.current === operation) operationPendingRef.current = null;
      if (liveRequestRef.current === submittedRequest) setBusy(null);
    }
  };

  /** Next: an answerable step must be answered before the card moves on; reading moves freely. */
  const next = () => {
    if (lastStep || busy !== null) return;
    if (answerable && question && errorFor(question) !== undefined) {
      showErrors([question]);
      return;
    }
    goToStep(step + 1);
  };
  const back = () => {
    if (step > 0 && busy === null) goToStep(step - 1);
  };
  const advance = () => {
    if (lastStep) void submit();
    else next();
  };
  const pick = (index: number) => {
    if (!question || controlsDisabled || question.options.length === 0) return;
    if (index < question.options.length) {
      choose(question, index);
      const control = `question:${question.id}:option:${index}`;
      afterRender(() => [...stepRef.current?.querySelectorAll<HTMLElement>("[data-session-request-control]") ?? []]
        .find((candidate) => candidate.dataset.sessionRequestControl === control)?.focus());
    } else if (index === question.options.length) {
      choose(question, "other");
      afterRender(() => stepRef.current?.querySelector<HTMLElement>(".question-input:not(:disabled)")?.focus());
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    // A choice row's input takes the card's keys; a field being typed in keeps them.
    const typing = target.isContentEditable || target.matches("textarea, select") ||
      (target.tagName === "INPUT" && !["radio", "checkbox"].includes((target as HTMLInputElement).type));
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      if (!interactive) return;
      event.preventDefault();
      void submit();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Enter") {
      // A button, link or disclosure keeps its own Enter.
      if (!interactive || target.closest("button, a[href], summary")) return;
      event.preventDefault();
      if (!event.repeat) advance();
      return;
    }
    if (typing || event.repeat) return;
    if (/^[1-9]$/.test(event.key)) {
      if (!answerable) return;
      event.preventDefault();
      pick(Number(event.key) - 1);
      return;
    }
    if (event.key === "d" || event.key === "D") {
      event.preventDefault();
      void dismiss();
    }
  };

  const availability = responseRefusal ?? (runnerOnline ? null : QUESTION_CARD_COPY.runnerOffline);
  const sharedDescriptions = [
    recoveryRequired ? recoveryId : null,
    availability ? availabilityId : null,
    unsupportedQuestionFormat ? unsupportedId : null,
  ].filter((id): id is string => id !== null);
  const actionDescription = [availability ? availabilityId : null, unsupportedQuestionFormat ? unsupportedId : null]
    .filter(Boolean).join(" ") || undefined;
  const eyebrow = question ? questionEyebrowParts(question) : { header: null, hint: null };
  const headerId = `${labelPrefix}-header-${step}`;
  const keyHints = showKeyHints && interactive;
  const kindLabel = recoveryRequired ? QUESTION_CARD_COPY.recoveryRequired
    : isAsync ? QUESTION_CARD_COPY.asyncQuestion : QUESTION_CARD_COPY.question;
  const failureText = failure?.action === "dismiss" ? QUESTION_CARD_COPY.notDismissed : QUESTION_CARD_COPY.notSent;
  const submitLabel = failure?.action === "submit" ? QUESTION_CARD_COPY.tryAgain : QUESTION_CARD_COPY.submitAnswers;
  const navigateOnly = !answerable;

  return (
    <section
      className={`request-card question-card question-bar question-style-${responseStyle}`}
      data-request-kind="question"
      data-tone={recoveryRequired ? "danger" : undefined}
      aria-label={QUESTION_CARD_COPY.agentQuestions}
      aria-busy={busy !== null}
      onKeyDown={onKeyDown}
    >
      <RequestCardHead kind={<><QuestionIcon />{kindLabel}</>} owner={owner} time={createdAt} />
      {(eyebrow.header || eyebrow.hint) && (
        <p className="question-eyebrow">
          {eyebrow.header && <span id={headerId}>{eyebrow.header}</span>}
          {eyebrow.hint && <span>{eyebrow.hint}</span>}
        </p>
      )}
      <div
        ref={titleRef}
        className="request-card-title question-text"
        role="heading"
        aria-level={3}
        id={titleId}
        tabIndex={-1}
        // A card that can be answered here names its question as the landing place: it is read
        // before it is answered. Composer Response answers in the composer, and a card nobody can
        // answer now leaves focus to the next enabled control or the composer.
        data-session-request-focus={interactive && responsesAvailable ? "" : undefined}
      >
        {question ? <StructuredQuestionText>{question.question}</StructuredQuestionText> : QUESTION_CARD_COPY.noDetails}
      </div>
      <div className="request-card-body question-list" ref={stepRef}>
        {recoveryRequired && (
          <p className="question-recovery" id={recoveryId}>
            {recoveryCanResume ? QUESTION_CARD_COPY.recoveryResume : QUESTION_CARD_COPY.recoveryDismiss}
          </p>
        )}
        {question && (
          <QuestionStep
            key={`${answerKey}:${question.id}`}
            question={question}
            ids={{
              header: eyebrow.header ? headerId : undefined,
              title: titleId,
              context: `${labelPrefix}-context-${step}`,
              requirement: `${labelPrefix}-requirement-${step}`,
              error: `${labelPrefix}-error-${step}`,
              somethingElse: `${labelPrefix}-something-else-${step}`,
            }}
            responseStyle={responseStyle}
            draft={draftValue(question.id)}
            error={attempted.has(question.id) ? errorFor(question) : undefined}
            disabled={controlsDisabled}
            inputDisabled={controlsDisabled}
            describedBy={sharedDescriptions}
            showKeyHints={keyHints && answerable}
            onChoose={(choice) => choose(question, choice)}
            onText={(value) => updateDraft(question, { kind: "other", value })}
          />
        )}
      </div>
      {failure && (
        <Notice tone="danger" compact role="alert"
          details={failure.detail !== QUESTION_CARD_COPY.alreadySending ? failure.detail : undefined}>
          {failure.detail === QUESTION_CARD_COPY.alreadySending ? failure.detail : failureText}
        </Notice>
      )}
      {(availability || unsupportedQuestionFormat || !interactive) && (
        <div className="request-card-reasons">
          {/* The live line below announces it; this is the same words, for the eye. */}
          {availability && <p aria-hidden="true">{availability}</p>}
          {unsupportedQuestionFormat && <p id={unsupportedId}>{QUESTION_CARD_COPY.unsupported}</p>}
          {!interactive && questions.length > 0 && !recoveryRequiresDismiss && <p>{QUESTION_CARD_COPY.answerInComposer}</p>}
        </div>
      )}
      <span className="sr-only" id={availabilityId} role="status" aria-atomic="true">{availability ?? ""}</span>
      <div className="request-card-foot">
        {!recoveryRequiresDismiss && (
          <BusyButton
            className="btn ghost question-dismiss"
            busy={busy === "dismiss"}
            progress={QUESTION_CARD_COPY.dismissing}
            data-session-request-control="dismiss"
            aria-describedby={availability ? availabilityId : undefined}
            disabled={busy === "submit" || !responsesAvailable}
            onClick={() => void dismiss()}
          >
            {recoveryRequired ? QUESTION_CARD_COPY.dismissAndContinue : QUESTION_CARD_COPY.dismiss}
            {showKeyHints && <kbd aria-hidden="true">D</kbd>}
          </BusyButton>
        )}
        {stepCount > 1 && (
          <span className="question-step-note">
            {questionStepLabel(step, stepCount)}
            <span className="question-step-dots" aria-hidden="true">
              {questions.map((candidate, index) => (
                <span key={candidate.id} className={index === step ? "is-current" : undefined} />
              ))}
            </span>
          </span>
        )}
        {step > 0 && (
          <button type="button" className="btn" data-session-request-control="back" disabled={busy !== null} onClick={back}>
            {QUESTION_CARD_COPY.back}
          </button>
        )}
        {!lastStep && (
          <button
            type="button"
            className={navigateOnly ? "btn" : "btn primary"}
            data-session-request-control="next"
            disabled={busy !== null}
            onClick={next}
          >
            {QUESTION_CARD_COPY.next}
            {keyHints && answerable && <kbd aria-hidden="true">Enter</kbd>}
          </button>
        )}
        {lastStep && interactive && questions.length > 0 && !recoveryRequiresDismiss && (
          <BusyButton
            className="btn primary"
            busy={busy === "submit"}
            progress={QUESTION_CARD_COPY.sending}
            data-session-request-control="submit"
            aria-describedby={actionDescription}
            disabled={busy === "dismiss" || !answerable}
            onClick={() => void submit()}
          >
            {submitLabel}
            {keyHints && answerable && <kbd aria-hidden="true">Enter</kbd>}
          </BusyButton>
        )}
        {recoveryRequiresDismiss && (
          <BusyButton
            className="btn primary"
            busy={busy === "dismiss"}
            progress={QUESTION_CARD_COPY.dismissing}
            data-session-request-control="dismiss"
            aria-describedby={availability ? availabilityId : undefined}
            disabled={!responsesAvailable}
            onClick={() => void dismiss()}
          >
            {QUESTION_CARD_COPY.dismissAndContinue}
            {showKeyHints && <kbd aria-hidden="true">D</kbd>}
          </BusyButton>
        )}
      </div>
    </section>
  );
}
