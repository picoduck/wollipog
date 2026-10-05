import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { summarizeQuestionAnswers, type AgentQuestion, type PendingApproval, type SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { focusSessionRequest } from "../components/SessionApproval.js";
import { ComposerQuestionResponse } from "../components/ComposerQuestionResponse.js";
import { EventTimeline, type TimelineRevealRequest } from "../components/EventTimeline.js";
import { SessionNoticeSlot } from "../components/SessionNoticeSlot.js";
import { RequestDock } from "../components/requests/RequestDock.js";
import { RequestKindIcon, pendingRequestsTitle } from "../components/requests/request-meta.js";
import { useQuestionWhereAsked } from "../components/requests/where-asked.js";
import type { TimelineItem } from "../timeline.js";
import { QuestionRowGallery } from "./question-row-gallery.js";
import { ResolverGallery } from "./resolver-gallery.js";
import { setQuestionResponseStyle, useQuestionResponseStyle } from "../question-response-style.js";
import { useFollowTail } from "../useFollowTail.js";
import "../styles.css";

interface AnswerCall {
  sessionId: string;
  requestId: string;
  answers: Record<string, string | string[]>;
  action?: "submit" | "dismiss";
}

declare global {
  interface Window {
    agentQuestionCalls: AnswerCall[];
    replaceAgentQuestion(): void;
    clearAgentQuestion(): void;
    releaseAgentQuestion(): void;
    setAgentQuestionOnline(online: boolean): void;
  }
}

const params = new URLSearchParams(window.location.search);
if (params.has("theme")) document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
setQuestionResponseStyle(["composer", "text"].includes(params.get("style") ?? "") ? "composer" : "interactive");
const initialOnline = params.get("offline") !== "1";
const shouldFail = params.get("failure") === "1";
// The session around the question, as SessionDetail lays it out (#2205): the transcript with the
// question's marker after `before` rows and before `after` rows, and the request dock above the
// composer. `keyboard=1` simulates the software keyboard open; `unloaded=1` leaves the question's
// event out of a fully loaded transcript, so Show Where Asked can't find it.
const rowsBefore = Number(params.get("before") ?? 12);
const rowsAfter = Number(params.get("after") ?? 2);
const keyboardOpen = params.get("keyboard") === "1";
const questionUnloaded = params.get("unloaded") === "1";
const recoveryRequired = params.get("recovery") === "1";
const recoveryCanResume = recoveryRequired && params.get("resume") === "1";
// Keycaps are a fine pointer's hints; the session shows them where a keyboard is likely (#2196).
const showKeyHints = params.get("keys") === "1";
let shouldHold = params.get("hold") === "1";
let releasePending: (() => void) | null = null;

const shortQuestions: AgentQuestion[] = [{
  id: "language",
  header: "Language",
  question: "Which language should the example use?",
  multiSelect: false,
  options: [
    { label: "TypeScript", description: "Use the existing Node.js toolchain." },
    { label: "Python", description: "Use a standalone script." },
  ],
}];

const signedEvidenceUrl = "https://evidence.example/private/mobile-capture.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=temporary-access-key&X-Amz-Signature=very-long-private-signature#full-resolution";
const richQuestions: AgentQuestion[] = [
  {
    id: "target",
    allowOther: false,
    header: "Target",
    question: `Choose **one** deployment target.\n\n- \`staging\` for verification\n- production after approval`,
    context: `Review the [release guide](https://docs.example/release) and evidence at ${signedEvidenceUrl}`,
    options: [{ label: "Staging" }, { label: "Production" }],
  },
  {
    id: "checks",
    header: "Checks",
    question: "Select the required checks:\n\n1. **Unit tests**\n2. Browser tests",
    context: `Keep ${signedEvidenceUrl} available for comparison.`,
    multiSelect: true,
    options: [{ label: "Unit Tests" }, { label: "Browser Tests" }],
  },
];

const longDescription = "A deliberately long description that wraps across several lines on a narrow phone while remaining understandable and tappable.";
const longQuestions: AgentQuestion[] = [
  {
    id: "strategy",
    header: "Strategy",
    question: "Choose the release strategy after reviewing all of these deliberately detailed options.",
    multiSelect: false,
    options: [
      { label: "Canary", description: longDescription },
      { label: "Blue-Green", description: longDescription },
      { label: "Rolling", description: longDescription },
      { label: "Regional", description: longDescription },
    ],
  },
  {
    id: "checks",
    header: "Checks",
    question: "Select every validation that should run before the release is promoted.",
    multiSelect: true,
    options: [
      { label: "Unit Tests", description: longDescription },
      { label: "Browser Tests", description: longDescription },
      { label: "Accessibility Audit", description: longDescription },
      { label: "Smoke Test", description: longDescription },
    ],
  },
  {
    id: "window",
    header: "Window",
    question: "Choose the final deployment window after considering the detailed operational tradeoffs.",
    multiSelect: false,
    options: [
      { label: "Morning", description: longDescription },
      { label: "Afternoon", description: longDescription },
      { label: "Evening", description: longDescription },
      { label: "Overnight", description: longDescription },
    ],
  },
];

// A question whose text alone is taller than the card's cap above the transcript (#2196).
const longTextQuestions: AgentQuestion[] = [{
  id: "plan",
  header: "Plan",
  question: Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} explains one more part of the plan.`).join("\n\n"),
  options: [{ label: "Proceed" }, { label: "Hold" }],
}];

// Provider labels can hold one long identifier with nowhere to break (#2196).
const longLabelQuestions: AgentQuestion[] = [{
  id: "destination",
  question: "Choose the live destination.",
  options: [{ label: "Destination transcript_overflow_identifier_" + "x".repeat(120), description: "y".repeat(160) }, { label: "Staging" }],
}];

// Two text questions whose context pushes the field below a capped card's fold (#2205).
const noteContext = Array.from({ length: 6 }, (_, index) => `Context line ${index + 1} keeps the field further down the card.`).join("\n\n");
const noteQuestions: AgentQuestion[] = [
  { id: "summary", header: "Summary", question: "Summarize the release.", context: noteContext, options: [], allowOther: true },
  { id: "followUp", header: "Follow-Up", question: "Name one follow-up.", context: noteContext, options: [], allowOther: true },
];

const replacementQuestions: AgentQuestion[] = [{
  id: "replacement",
  header: "Replacement",
  question: "This is a new request. Choose its answer.",
  multiSelect: false,
  options: [
    { label: "Fresh Answer", description: "Belongs only to the replacement request." },
    { label: "Another Fresh Answer", description: "Also belongs only to the replacement request." },
  ],
}];

const formQuestions: AgentQuestion[] = [
  {
    id: "target",
    allowOther: false,
    header: "Target",
    question: "Choose a deployment target.",
    options: [{ label: "Staging" }, { label: "Production" }],
  },
  {
    id: "checks",
    header: "Checks",
    question: "Choose exactly two checks.",
    multiSelect: true,
    minSelections: 2,
    maxSelections: 2,
    options: [{ label: "Unit Tests" }, { label: "Browser Tests" }, { label: "Smoke Test" }],
  },
  {
    id: "note",
    header: "Note",
    question: "Add an optional note.",
    options: [],
    allowOther: true,
    required: false,
    maxLength: 40,
  },
  {
    id: "token",
    header: "Token",
    question: "Enter the temporary token.",
    options: [],
    allowOther: true,
    secret: true,
    minLength: 3,
    maxLength: 12,
  },
  {
    id: "retries",
    header: "Retries",
    question: "Choose the retry count.",
    options: [],
    allowOther: true,
    inputFormat: "integer",
    minimum: 1,
    maximum: 5,
  },
];

window.agentQuestionCalls = [];
const askedAt = Date.UTC(2026, 9, 3, 7, 30, 0);
const SESSION_ID = "agent-question-session";
const QUESTION_EVENT_ID = 1_000;

function transcriptRow(id: number, index: number, label: string): TimelineItem {
  return index % 2 === 0
    ? { kind: "user_message", id, text: `${label} message ${index / 2 + 1}` }
    : { kind: "agent_message", id, text: `${label} reply ${(index + 1) / 2}: the agent explains what it did and why.` };
}

function Fixture() {
  const responseStyle = useQuestionResponseStyle();
  const [requestId, setRequestId] = useState("ask-1");
  const [questions, setQuestions] = useState(
    params.get("set") === "long"
      ? longQuestions
      : params.get("set") === "long-text"
        ? longTextQuestions
        : params.get("set") === "long-label"
          ? longLabelQuestions
      : params.get("set") === "forms"
        ? formQuestions
        : params.get("set") === "notes"
          ? noteQuestions
        : params.get("set") === "rich"
          ? richQuestions
          : params.get("set") === "rich-single" ? richQuestions.slice(0, 1) : shortQuestions,
  );
  const [runnerOnline, setRunnerOnline] = useState(initialOnline);
  const [resolved, setResolved] = useState(false);
  const [answerActive, setAnswerActive] = useState(responseStyle === "composer");
  const answerInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!resolved && responseStyle === "composer") setAnswerActive(true);
  }, [requestId, resolved, responseStyle]);

  window.replaceAgentQuestion = () => {
    setRequestId("ask-2");
    setQuestions(replacementQuestions);
    setResolved(false);
  };
  window.releaseAgentQuestion = () => releasePending?.();
  window.clearAgentQuestion = () => setResolved(true);
  window.setAgentQuestionOnline = (online) => setRunnerOnline(online);

  const client = useMemo(() => ({
    ...api,
    answerQuestion: async (
      sessionId: string,
      body: { requestId: string; answers: Record<string, string | string[]> },
    ) => {
      window.agentQuestionCalls.push({
        sessionId,
        requestId: body.requestId,
        answers: body.answers,
        action: (body as { action?: "submit" | "dismiss" }).action,
      });
      if (shouldHold) {
        shouldHold = false;
        await new Promise<void>((resolve) => { releasePending = resolve; });
      }
      if (shouldFail) throw new Error("The runner rejected this answer. Try again.");
      return { id: sessionId, pendingApproval: null, status: "running" } as SessionView;
    },
  }), []) as ApiClient;

  // The control plane stores a summary of what was submitted (#2188); a dismissal stores none.
  const lastCall = resolved ? [...window.agentQuestionCalls].reverse().find((call) => call.requestId === requestId) : undefined;
  const dismissed = lastCall?.action === "dismiss";
  const items = useMemo<TimelineItem[]>(() => [
    ...Array.from({ length: rowsBefore }, (_, index) => transcriptRow(index + 1, index, "Earlier")),
    ...(questionUnloaded ? [] : [{
      kind: "question" as const,
      id: QUESTION_EVENT_ID,
      requestId,
      questions,
      createdAt: askedAt,
      ...(resolved ? {
        answered: !dismissed,
        resolvedAt: askedAt + 60_000,
        ...(lastCall && !dismissed ? { answers: summarizeQuestionAnswers(questions, lastCall.answers) } : {}),
      } : {}),
    }]),
    ...Array.from({ length: rowsAfter }, (_, index) => transcriptRow(QUESTION_EVENT_ID + 1 + index, index, "Later")),
  ], [dismissed, lastCall, questions, requestId, resolved]);
  const request = useMemo<PendingApproval | null>(() => resolved ? null : {
    kind: "question",
    requestId,
    title: questions[0]?.header ?? "Agent Question",
    options: [],
    questions,
    ...(recoveryRequired ? { recoveryReason: "provider_restart" as const } : {}),
    ...(recoveryCanResume ? { recoveryAction: "resume_answer" as const } : {}),
  }, [questions, requestId, resolved]);
  const session = useMemo(() => ({
    id: SESSION_ID, runnerId: "runner-1", title: "Agent Questions", status: "input_required",
    pendingApproval: request ?? undefined,
  }) as SessionView, [request]);

  // Reading back and Show Where Asked work as in a session: the reader follows its tail, and a reveal
  // pauses it, so the dock takes its strip.
  const followTail = useFollowTail({ scrollRef, contentRevision: items, sessionId: SESSION_ID, persistenceScope: "agent-questions-e2e" });
  const [revealRequest, setRevealRequest] = useState<TimelineRevealRequest | null>(null);
  const revealSerial = useRef(0);
  const reveal = useCallback((eventId: number) => {
    followTail.pause();
    revealSerial.current += 1;
    setRevealRequest({ eventId, requestId: revealSerial.current, historyKey: SESSION_ID, align: "upper-third", focus: true });
  }, [followTail.pause]);
  const handleRevealed = useCallback((serial: number) => {
    setRevealRequest((current) => current?.requestId === serial ? null : current);
  }, []);
  const pendingRequestIds = useMemo(() => request ? [request.requestId] : [], [request]);
  const { whereAsked, selectedRequestId } = useQuestionWhereAsked({
    items,
    history: { hasOlder: false, loadingOlder: false, complete: true },
    loadOlder: () => false,
    pendingRequestIds,
    reveal,
    readerRef: scrollRef,
    following: followTail.state === "following",
    resetKey: SESSION_ID,
  });
  const questionContext = useMemo(() => ({
    pendingRequestIds,
    onJumpToQuestion: (id: string) => { focusSessionRequest(SESSION_ID, id); },
    selectedRequestId,
  }), [pendingRequestIds, selectedRequestId]);

  const composerContent = !resolved && responseStyle === "composer" && (!recoveryRequired || recoveryCanResume) ? (
    <div className={`composer-box${answerActive ? " answer-mode" : ""}`}>
      <ComposerQuestionResponse
        sessionId={SESSION_ID}
        requestId={requestId}
        questions={questions}
        runnerOnline={runnerOnline}
        active={answerActive}
        showWaiting
        inputRef={answerInputRef}
        onEnter={() => setAnswerActive(true)}
        onExit={() => setAnswerActive(false)}
        onSessionUpdate={() => setResolved(true)}
      />
    </div>
  ) : (
    <div className="composer-box"><textarea className="composer-input" aria-label="Composer" placeholder="Do anything" /></div>
  );

  return (
    <ApiProvider client={client}>
      <main id="question-frame" className="app" style={{ display: "block", height: "100dvh" }}>
        <section className="session-detail expanded" style={{ height: "100%" }}>
          <div className="detail-columns">
            <div className="detail-chat">
              <div className="chat-reading">
                <div className="detail-main">
                  <div className="detail-reader">
                    <div
                      className="detail-scroll measured-virtual-scroll"
                      role="region"
                      aria-label="Session Activity"
                      ref={scrollRef}
                      tabIndex={0}
                      data-follow-tail-state={followTail.state}
                      onScroll={followTail.onScroll}
                      onWheel={followTail.onWheel}
                      onPointerMove={followTail.onPointerMove}
                      onTouchStart={(event) => followTail.onTouchStart(event.nativeEvent)}
                      onKeyDown={(event) => {
                        if (!followTail.onKeyDown(event)) return;
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      <EventTimeline
                        items={items}
                        scrollRef={scrollRef}
                        historyKey={SESSION_ID}
                        getInitialAnchor={followTail.getInitialAnchor}
                        preserveAnchor={!followTail.isFollowing}
                        onVisibleAnchorChange={followTail.onVisibleAnchorChange}
                        onAnchorLost={followTail.onAnchorLost}
                        revealRequest={revealRequest}
                        onRevealHandled={handleRevealed}
                        questionContext={questionContext}
                      />
                      {resolved && <p role="status">Question Answered</p>}
                    </div>
                  </div>
                </div>
                {request && (
                  <SessionNoticeSlot sessionId={SESSION_ID} entries={[]} lead={{
                    key: "request-dock",
                    title: pendingRequestsTitle(1),
                    icon: <RequestKindIcon request={request} />,
                    requestIds: [request.requestId],
                    render: ({ trailing, revealRequestId, concealTrailing }) => (
                      <RequestDock
                        session={session}
                        requests={[request]}
                        runnerOnline={runnerOnline}
                        owner="Claude Code"
                        createdAt={() => askedAt}
                        headTrailing={trailing}
                        onSessionUpdate={() => setResolved(true)}
                        showKeyHints={showKeyHints}
                        keyboardOpen={keyboardOpen}
                        revealRequestId={revealRequestId}
                        followTailState={followTail.state}
                        readerRef={scrollRef}
                        onConceal={concealTrailing}
                        whereAsked={whereAsked}
                      />
                    ),
                  }} />
                )}
              </div>
              <div className="composer">{composerContent}</div>
            </div>
          </div>
        </section>
      </main>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(params.get("set") === "gallery"
  ? <main id="question-frame" className="timeline"><QuestionRowGallery /></main>
  : params.get("set") === "resolvers"
    ? <main id="question-frame" className="timeline"><ResolverGallery solo={params.get("viewer") === "solo"} /></main>
    : <Fixture />);
