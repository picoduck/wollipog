import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
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
import { KEYBOARD_EDITABLE, TOUCH_PHONE_MEDIA } from "../mobile-viewport.js";
import { LocateIcon, QuestionIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StructuredQuestionText } from "./StructuredQuestionText.js";
import { BusyButton } from "./ui/BusyButton.js";
import { RequestCardHead, type RequestIntentHandler } from "./requests/RequestCard.js";
import {
  QUESTION_CARD_COPY,
  QuestionStep,
  questionEyebrowParts,
  questionOtherChosen,
  questionStepLabel,
  type QuestionChoice,
} from "./requests/QuestionStep.js";
import { revealDockedRequest } from "./requests/request-reveal.js";
import { useClipEdges } from "./requests/clip-edges.js";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
/** Below this much room for its body, a capped question card scrolls as a whole (#2683): about a row. */
const CRAMPED_BODY_PX = 72;

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
 * session's own requests, questions included, are answered on the request dock above the composer
 * (#2179, #2205); this region owns where focus goes as they come and go, and announces them. */
export function SessionApprovalRegion({
  session,
  runnerOnline,
  fallbackFocusRef,
  alternateFallbackFocusRef,
  onFallbackFocus,
}: {
  session: SessionView;
  runnerOnline: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  alternateFallbackFocusRef?: RefObject<HTMLElement | null>;
  onFallbackFocus?: () => boolean;
}) {
  const approval = session.pendingApproval;
  return (
    <SessionRequestCoordinator
      sessionId={session.id}
      requestId={approval?.requestId ?? null}
      requestIsQuestion={approval?.kind === "question"}
      runnerOnline={runnerOnline}
      fallbackFocusRef={fallbackFocusRef}
      alternateFallbackFocusRef={alternateFallbackFocusRef}
      onFallbackFocus={onFallbackFocus}
    />
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
  // card's destructive Dismiss action, or Answer, into the implicit focus target for the user's next
  // Enter: focus falls back to the composer.
  const eligible = region?.querySelector(".question-style-composer")
    ? controls.filter((control) => !["dismiss", "answer"].includes(control.dataset.sessionRequestControl ?? ""))
    : controls;
  // A Request Card names its heading as the landing place: a new request is read before it is
  // answered, and its first button is not the one to press by default.
  return eligible.find((control) => control.dataset.sessionRequestControl === preferredControl) ??
    region?.querySelector<HTMLElement>("[data-session-request-focus]") ?? eligible[0] ?? null;
}

/** Persistent focus and live-announcement owner for the session's requests. */
function SessionRequestCoordinator({
  sessionId,
  requestId,
  requestIsQuestion,
  runnerOnline,
  fallbackFocusRef,
  alternateFallbackFocusRef,
  onFallbackFocus,
}: {
  sessionId: string;
  requestId: string | null;
  requestIsQuestion: boolean;
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
    requestIsQuestion, sessionId]);

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

/** Show Where Asked on the docked question card (#2205): back to the question's marker in the
 * transcript, which the transcript may first have to load back to. */
export interface QuestionWhereAsked {
  onShow: () => void;
  /** Why the marker can't be shown: the button is disabled and this is its visible foot-note. */
  unavailableReason: string | null;
  /** The transcript is loading back to the marker. */
  loading: boolean;
}

/** Where the question card puts focus after it renders: its heading, a question's answer (the field
 * to fix, else the chosen or first row), one named control, or the Something Else field. */
type CardFocus =
  | { kind: "title" }
  | { kind: "answer"; questionId: string }
  | { kind: "control"; name: string }
  | { kind: "field" };

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
 * then Submit Answers), Ctrl/Cmd+Enter submits from any step and D dismisses.
 *
 * In Composer Response, where the composer can answer the question (`onAnswer`), the card is
 * compact (#2212): the head line, the question as the title, "Your message draft is kept while you
 * answer." and a footer of Dismiss and Answer, which opens Answer Mode (R, too). The question is then
 * shown in the composer alone. A person who may not answer reads why instead, and Answer is off.
 * Without a composer to answer in (a worker's or a child's question in a panel) the card is the form.
 *
 * On the request dock (#2205) the head line ends with Show Where Asked, and while the software
 * keyboard is open the card keeps only the question and its answer: no head line, a one-line title,
 * and Back and Next or Submit Answers in the footer. A field that takes focus is scrolled into view
 * within the card's body, never the page.
 *
 * A question longer than the card's few clamped lines ends on a whole line and offers Show Full
 * Question (#2683); expanded, the question is shown whole and, on the dock, the card scrolls under
 * its footer within the dock's cap.
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
  headingRef,
  headTrailing,
  keyboardOpen = false,
  whereAsked,
  intentRef,
  topRequest = true,
  presentation,
  onAnswer,
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
  /** Receives the card's heading, which the request dock focuses when it brings the question up. */
  headingRef?: RefObject<HTMLElement | null>;
  /** Controls at the end of the head line: the notice slot's "+N More" while the dock holds it. */
  headTrailing?: ReactNode;
  /** The software keyboard is open (§13.2). */
  keyboardOpen?: boolean;
  whereAsked?: QuestionWhereAsked;
  /** Receives the session's A and D while the dock shows this card (#2179): D dismisses it. */
  intentRef?: MutableRefObject<RequestIntentHandler | null>;
  /** The session's top request, whose A keeps its meaning on the session's other surfaces. */
  topRequest?: boolean;
  /** As the Request Card's: the Requests panel's detail draws it flush with a sticky footer (#2206). */
  presentation?: "dock" | "panel";
  /** Opens Answer Mode for this question, where the composer can answer it (#2212). In Composer
   * Response the card is then compact; without it the card is always the form. */
  onAnswer?: () => void;
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
  // Once a submission failed, the primary reads Try Again until the answers are sent, including
  // while the retry is pending and the failure notice is gone (BusyButton keeps its label).
  const [retrying, setRetrying] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ target: CardFocus; serial: number } | null>(null);
  const operationPendingRef = useRef<object | null>(null);
  const liveRequestRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    // Retire callbacks at commit, including when the same request is later remounted.
    liveRequestRef.current = {};
    operationPendingRef.current = null;
    return () => { liveRequestRef.current = null; };
  }, [answerKey, sessionId]);
  const titleRef = useRef<HTMLDivElement>(null);
  const setTitle = useCallback((node: HTMLDivElement | null) => {
    titleRef.current = node;
    if (headingRef) headingRef.current = node;
  }, [headingRef]);
  const stepRef = useRef<HTMLDivElement>(null);
  // The question whose whole text is shown (#2683); each question starts clamped.
  const [expandedQuestion, setExpandedQuestion] = useState<string | null>(null);
  const [titleTruncates, setTitleTruncates] = useState(false);
  const titleToggleRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const [cardCramped, setCardCramped] = useState(false);
  const previousDraftRequestRef = useRef({ sessionId, requestId: answerKey });
  // React's opaque useId contains colons. They are valid in HTML ids but break the selector-based
  // HTMLInputElement.list lookup used by some DOM implementations, so keep this idref family plain.
  const labelPrefix = useId().replace(/:/g, "");
  const availabilityId = `${labelPrefix}-availability`;
  const unsupportedId = `${labelPrefix}-unsupported`;
  const recoveryId = `${labelPrefix}-recovery`;
  const titleId = `${labelPrefix}-title`;
  const whereAskedId = `${labelPrefix}-where-asked`;
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
    setRetrying(false);
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
  // Composer Response answers in the composer, so the card is compact there; where no composer can
  // answer this question, the card is the form whatever the style.
  const compact = responseStyle === "composer" && onAnswer !== undefined;
  const interactive = !compact;
  const cardStyle: typeof responseStyle = compact ? "composer" : "interactive";
  const controlsDisabled = busy !== null || !responsesAvailable || unsupportedQuestionFormat || recoveryRequiresDismiss;
  // The form can be answered here: Next checks the step and the last step submits.
  const answerable = interactive && questions.length > 0 && responsesAvailable && !unsupportedQuestionFormat &&
    !recoveryRequiresDismiss;
  const stepCount = questions.length;
  const step = Math.min(Math.max(ownDrafts ? drafts.step : 0, 0), Math.max(stepCount - 1, 0));
  const question = questions[step];
  const lastStep = step >= stepCount - 1;
  const titleExpanded = question !== undefined && expandedQuestion === question.id;

  // Whether the clamp hides any of the question is measured, never guessed from its length: against
  // the clamp every time, expanded or not, and again whenever the title or the card is resized. The
  // clamp is put on for the measurement and taken off inside the same layout pass, so nothing paints
  // between. Where no clamp applies (the Requests panel, styles.css) nothing is hidden and no toggle
  // shows.
  //
  // In a capped card (the dock, the Agents panel) the title keeps whole lines and the body scrolls in
  // what is left. Where that would leave the body less than about a row (a phone with "+N More", a
  // long question on a short window), the card scrolls as a whole under its footer instead, as it
  // does expanded. The room is read the same way in either layout: the card's height less everything
  // in it but the body. An uncapped card (the Requests panel) always has room.
  // The compact Composer Response card (#2212) has no body: its title is still measured, and it is
  // never cramped.
  const hasBody = !compact || recoveryRequired;
  useIsomorphicLayoutEffect(() => {
    const title = titleRef.current;
    const card = cardRef.current;
    const body = stepRef.current;
    if (!title || !card) return;
    const measure = () => {
      title.classList.add("is-clamped");
      const hidden = title.scrollHeight > title.clientHeight + 1;
      if (titleExpanded) title.classList.remove("is-clamped");
      // A toggle that is about to disappear hands its focus to the question it controlled (§16.1).
      const toggle = titleToggleRef.current;
      if (!hidden && toggle && toggle === toggle.ownerDocument.activeElement) title.focus({ preventScroll: true });
      setTitleTruncates(hidden);
      if (!body) {
        setCardCramped(false);
        return;
      }
      const room = card.clientHeight - (card.scrollHeight - body.offsetHeight);
      setCardCramped(room < Math.min(body.scrollHeight, CRAMPED_BODY_PX));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // The body is observed too: a notice or a reason that appears above the footer squeezes it without
    // resizing the title or a capped card. Switching layouts resizes the body once, and the room it
    // then reads is the same less the scrolling footer's padding, so the choice holds.
    const observer = new ResizeObserver(measure);
    observer.observe(title);
    observer.observe(card);
    if (body) observer.observe(body);
    return () => observer.disconnect();
  }, [question?.question, titleExpanded, step, hasBody]);
  const cardScrolls = (titleExpanded && titleTruncates) || cardCramped;
  // The whole question is read from its first line: a card scrolled down to reach Show Full Question
  // brings the question's start back into view, within the card alone.
  useIsomorphicLayoutEffect(() => {
    const title = titleRef.current;
    const card = cardRef.current;
    if (!titleExpanded || !title || !card) return;
    const padding = parseFloat(card.ownerDocument.defaultView?.getComputedStyle(card).paddingTop ?? "") || 0;
    const above = card.getBoundingClientRect().top + padding - title.getBoundingClientRect().top;
    if (above > 0) card.scrollTop -= above;
  }, [titleExpanded]);

  // While the card itself scrolls (expanded, cramped, or a short column's container rule), the edges
  // it can still scroll past show a line (#2698); while only its body scrolls, the body's edges do,
  // as every Request Card's body does (#2715).
  useClipEdges(cardRef);
  useClipEdges(stepRef);

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

  // Focus moves in the commit that renders its target, before the next key is read: a step change
  // unmounts the focused row, and a key typed in between would otherwise land on the page.
  const requestFocus = (target: CardFocus) => setFocusRequest((current) => ({ target, serial: (current?.serial ?? 0) + 1 }));
  useIsomorphicLayoutEffect(() => {
    const target = focusRequest?.target;
    if (!target) return;
    const body = stepRef.current;
    const field = body?.querySelector<HTMLElement>(".question-input:not(:disabled)");
    if (target.kind === "title") {
      // A new step is read from its start, wherever the last one's field had scrolled the body.
      if (body) body.scrollTop = 0;
      titleRef.current?.focus();
    } else if (target.kind === "field") {
      field?.focus();
    } else if (target.kind === "control") {
      [...body?.querySelectorAll<HTMLElement>("[data-session-request-control]") ?? []]
        .find((candidate) => candidate.dataset.sessionRequestControl === target.name)?.focus();
    } else {
      const question = questions.find((candidate) => candidate.id === target.questionId);
      const choice = body?.querySelector<HTMLElement>("input[type=radio]:checked, input[type=checkbox]:checked") ??
        body?.querySelector<HTMLElement>("input[type=radio], input[type=checkbox]");
      // The text is the answer to fix when there is no choice to make or Something Else is chosen.
      const textFirst = !question || question.options.length === 0 || questionOtherChosen(question, draftValue(question.id));
      (textFirst ? field ?? choice : choice ?? field)?.focus();
    }
  // Only a new request moves focus; the draft it reads is the one this commit rendered.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);
  const goToStep = (next: number, focus: "title" | "answer" = "title") => {
    const clamped = Math.min(Math.max(next, 0), Math.max(stepCount - 1, 0));
    storeQuestionStep(sessionId, answerKey, clamped);
    setDrafts((current) => current.requestId === answerKey ? { ...current, step: clamped } : current);
    const target = questions[clamped];
    requestFocus(focus === "title" || !target ? { kind: "title" } : { kind: "answer", questionId: target.id });
  };
  /** Reveal the errors of `invalid` and move to the first of them (§8.5). */
  const showErrors = (invalid: readonly AgentQuestion[]) => {
    setAttempted((current) => new Set([...current, ...invalid.map((candidate) => candidate.id)]));
    const first = invalid[0];
    const firstStep = first ? questions.indexOf(first) : -1;
    if (firstStep >= 0 && firstStep !== step) goToStep(firstStep, "answer");
    else if (first) requestFocus({ kind: "answer", questionId: first.id });
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
      if (liveRequestRef.current === submittedRequest) {
        setFailure({ action: "submit", detail: (cause as Error).message });
        setRetrying(true);
      }
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

  // The session's A and D act on the card the dock shows, never on a request behind it: D dismisses
  // the question, as the card's own D does. A answers nothing without the card, so on the top request
  // it keeps its meaning elsewhere (the Sessions list opens the question in its session); on another
  // it brings this card's question up.
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const topRequestRef = useRef(topRequest);
  topRequestRef.current = topRequest;
  useEffect(() => {
    if (!intentRef) return;
    const handler: RequestIntentHandler = (intent) => {
      if (intent === "deny") {
        void dismissRef.current();
        return true;
      }
      if (topRequestRef.current) return false;
      requestFocus({ kind: "title" });
      return true;
    };
    intentRef.current = handler;
    return () => {
      if (intentRef.current === handler) intentRef.current = null;
    };
  }, [intentRef]);

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
      requestFocus({ kind: "control", name: `question:${question.id}:option:${index}` });
    } else if (index === question.options.length) {
      choose(question, "other");
      requestFocus({ kind: "field" });
    }
  };

  // A field is scrolled into view within the card's own scrollers alone, the nearest edge first: its
  // body, and in a column too short for the body to scroll, the dock and its slot. Scrolling every
  // ancestor would move the transcript or the page under a software keyboard.
  const revealField = (focused: Element | null) => {
    const body = stepRef.current;
    if (!body || !(focused instanceof HTMLElement) || !body.contains(focused)) return;
    // A text field, or a choice row reached from the keyboard. A tapped row is left where it is: a
    // scroll between the press and the click would move it out from under the finger.
    const choice = focused.matches("input[type=radio], input[type=checkbox]");
    if (!choice && !focused.matches("input, textarea")) return;
    if (choice && !focused.matches(":focus-visible")) return;
    const field = choice ? focused.closest<HTMLElement>(".choice-row") ?? focused : focused;
    const card = body.parentElement;
    const dock = body.closest<HTMLElement>(".request-dock");
    for (const scroller of [body, card, dock, dock?.parentElement?.closest<HTMLElement>(".session-notice-slot")]) {
      if (!scroller) continue;
      const bounds = scroller.getBoundingClientRect();
      // The card scrolls under its footer in a short column (styles.css): the field must clear it.
      const foot = scroller === card ? card.querySelector<HTMLElement>(":scope > .request-card-foot") : null;
      const bottom = foot && getComputedStyle(foot).position === "sticky"
        ? Math.min(bounds.bottom, foot.getBoundingClientRect().top) : bounds.bottom;
      const rect = field.getBoundingClientRect();
      if (rect.top < bounds.top) scroller.scrollTop -= bounds.top - rect.top;
      else if (rect.bottom > bottom) scroller.scrollTop += Math.min(rect.bottom - bottom, rect.top - bounds.top);
    }
  };
  // The keyboard opens after the field took focus and lowers the dock's cap, which can hide it again.
  useIsomorphicLayoutEffect(() => {
    if (keyboardOpen) revealField(stepRef.current?.ownerDocument.activeElement ?? null);
  // Only the keyboard opening moves the body.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardOpen]);

  // On a touch phone a focused field is the software keyboard: the dock caps lower and the rail hides
  // (styles.css). Pressing a row or a button while typing keeps the field focused until the click
  // lands, since its blur would restore that layout between the press and the click and move the
  // control out from under the finger. Choosing or moving on then takes focus as usual.
  const holdFieldFocus = (event: React.MouseEvent<HTMLElement>) => {
    const active = event.currentTarget.ownerDocument.activeElement;
    const target = event.target as HTMLElement;
    if (!(active instanceof HTMLElement) || !event.currentTarget.contains(active) || !active.matches(KEYBOARD_EDITABLE) ||
        target.closest(KEYBOARD_EDITABLE) || !target.closest("button, label, input") ||
        !event.currentTarget.ownerDocument.defaultView?.matchMedia(TOUCH_PHONE_MEDIA).matches) return;
    event.preventDefault();
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
  const submitLabel = retrying ? QUESTION_CARD_COPY.tryAgain : QUESTION_CARD_COPY.submitAnswers;
  const navigateOnly = !answerable;
  // The compact card's foot-note; a person who may not answer reads the refusal in its place.
  const draftKept = compact && questions.length > 0 && !recoveryRequiresDismiss && responseRefusal === null;

  return (
    <section
      className={`request-card question-card question-bar question-style-${cardStyle}`}
      data-request-kind="question"
      data-presentation={presentation}
      data-tone={recoveryRequired ? "danger" : undefined}
      aria-label={QUESTION_CARD_COPY.agentQuestions}
      aria-busy={busy !== null}
      data-keyboard-open={keyboardOpen ? "" : undefined}
      data-card-scrolls={cardScrolls ? "" : undefined}
      ref={cardRef}
      onKeyDown={onKeyDown}
      onMouseDown={holdFieldFocus}
    >
      <RequestCardHead
        kind={<><QuestionIcon />{kindLabel}</>}
        owner={owner}
        time={createdAt}
        trailing={whereAsked || headTrailing ? <>
          {whereAsked && (
            // Icon-only below 760px, under the same name (§15.1).
            <BusyButton
              className="btn sm ghost question-where-asked"
              busy={whereAsked.loading}
              progress={QUESTION_CARD_COPY.findingWhereAsked}
              icon={<LocateIcon size={14} />}
              aria-label={QUESTION_CARD_COPY.showWhereAsked}
              aria-describedby={whereAsked.unavailableReason ? whereAskedId : undefined}
              disabled={whereAsked.unavailableReason !== null}
              onClick={whereAsked.onShow}
            >
              <span className="question-where-asked-label">{QUESTION_CARD_COPY.showWhereAsked}</span>
            </BusyButton>
          )}
          {headTrailing}
        </> : undefined}
      />
      {!compact && (eyebrow.header || eyebrow.hint) && (
        <p className="question-eyebrow">
          {eyebrow.header && <span id={headerId}>{eyebrow.header}</span>}
          {eyebrow.hint && <span>{eyebrow.hint}</span>}
        </p>
      )}
      <div
        ref={setTitle}
        className={`request-card-title question-text${titleExpanded ? "" : " is-clamped"}`}
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
      {question && titleTruncates && (
        <button
          ref={titleToggleRef}
          type="button"
          className="link question-text-toggle"
          aria-expanded={titleExpanded}
          aria-controls={titleId}
          onClick={() => setExpandedQuestion(titleExpanded ? null : question.id)}
        >
          {titleExpanded ? QUESTION_CARD_COPY.showLess : QUESTION_CARD_COPY.showFullQuestion}
        </button>
      )}
      {(!compact || recoveryRequired) && <div className="request-card-body" ref={stepRef} onFocus={(event) => revealField(event.target)}>
        {recoveryRequired && (
          <p className="question-recovery" id={recoveryId}>
            {recoveryCanResume ? QUESTION_CARD_COPY.recoveryResume : QUESTION_CARD_COPY.recoveryDismiss}
          </p>
        )}
        {question && !compact && (
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
      </div>}
      {failure && (
        <Notice tone="danger" compact role="alert"
          details={failure.detail !== QUESTION_CARD_COPY.alreadySending ? failure.detail : undefined}>
          {failure.detail === QUESTION_CARD_COPY.alreadySending ? failure.detail : failureText}
        </Notice>
      )}
      {(unsupportedQuestionFormat || draftKept || whereAsked?.unavailableReason) && (
        <div className="request-card-reasons">
          {unsupportedQuestionFormat && <p id={unsupportedId}>{QUESTION_CARD_COPY.unsupported}</p>}
          {draftKept && <p>{QUESTION_CARD_COPY.draftKept}</p>}
          {whereAsked?.unavailableReason && <p id={whereAskedId}>{whereAsked.unavailableReason}</p>}
        </div>
      )}
      {/* Why nobody can answer now. Always mounted, so going offline is announced; empty, it takes
          no room (styles.css). */}
      <p className="request-card-reasons question-reason" id={availabilityId} role="status" aria-atomic="true">
        {availability ?? ""}
      </p>
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
        {!compact && stepCount > 1 && (
          <span className="question-step-note">
            {questionStepLabel(step, stepCount)}
            <span className="question-step-dots" aria-hidden="true">
              {questions.map((candidate, index) => (
                <span key={candidate.id} className={index === step ? "is-current" : undefined} />
              ))}
            </span>
          </span>
        )}
        {!compact && step > 0 && (
          <button type="button" className="btn" data-session-request-control="back" disabled={busy !== null} onClick={back}>
            {QUESTION_CARD_COPY.back}
          </button>
        )}
        {!compact && !lastStep && (
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
        {compact && questions.length > 0 && !recoveryRequiresDismiss && (
          // R opens Answer Mode too (the session's Reply key); its keycap shows on fine pointers only.
          <button
            type="button"
            className="btn primary"
            data-session-request-control="answer"
            aria-describedby={responseRefusal !== null ? availabilityId : undefined}
            disabled={busy !== null || responseRefusal !== null}
            onClick={onAnswer}
          >
            {QUESTION_CARD_COPY.answer}
            {showKeyHints && <kbd aria-hidden="true">R</kbd>}
          </button>
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
