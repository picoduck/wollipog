import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { prioritizedPendingRequests, type SessionView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { createBrowserApiTransport } from "../api-transport.js";
import { EventTimeline } from "../components/EventTimeline.js";
import { SessionApprovalRegion, focusSessionRequest } from "../components/SessionApproval.js";
import { SessionNoticeSlot } from "../components/SessionNoticeSlot.js";
import { RequestDock, dockRequests } from "../components/requests/RequestDock.js";
import { RequestKindIcon, pendingRequestsTitle } from "../components/requests/request-meta.js";
import { ComposerQuestionResponse } from "../components/ComposerQuestionResponse.js";
import { ChevronRightIcon } from "../components/Icons.js";
import type { TimelineItem } from "../timeline.js";
import { useQuestionResponseStyle } from "../question-response-style.js";
import "../styles.css";

const params = new URLSearchParams(window.location.hash.slice(1));
const origin = params.get("origin") ?? "";
const token = params.get("token") ?? "";
const sessionId = params.get("sessionId") ?? "";
const showQueuedPrompts = params.get("queued") === "1";
const showLiveQueue = params.get("liveQueue") === "1";
const showActualAsyncMessage = params.get("actualAsyncMessage") === "1";

function LiveQuestionFixture() {
  const responseStyle = useQuestionResponseStyle();
  const client = useMemo(() => createApiClient(createBrowserApiTransport({
    instanceId: "agent-question-live-e2e",
    origin,
    token: () => token,
  })), []);
  const [session, setSession] = useState<SessionView | null>(null);
  const [actualAsyncMessage, setActualAsyncMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fallbackFocusRef = useRef<HTMLTextAreaElement>(null);
  const answerInputRef = useRef<HTMLInputElement>(null);
  const [answerActive, setAnswerActive] = useState(false);
  // The composer's queue tray starts as one collapsed summary line, as QueuedMessages does (#2788).
  const [queueExpanded, setQueueExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const questionEventRef = useRef<Extract<TimelineItem, { kind: "question" }> | null>(null);
  const transcriptContext = useMemo<TimelineItem[]>(() => Array.from({ length: 48 }, (_, index) => (
    index % 2 === 0
      ? { kind: "user_message", id: index + 1, text: `Earlier question ${index / 2 + 1}` }
      : { kind: "agent_message", id: index + 1, text: `Earlier answer ${(index + 1) / 2}` }
  )), []);
  const queuedPrompts = showLiveQueue ? session?.queued ?? [] : [
    { id: "queued-1", text: "Keep this long message queued until both structured questions are answered." },
    { id: "queued-2", text: "The complete two-question form must remain visible and reachable above the composer." },
  ];

  useEffect(() => {
    let active = true;
    void client.session(sessionId).then(({ session: loaded }) => {
      if (active) setSession(loaded);
    }).catch((cause) => {
      if (active) setError((cause as Error).message);
    });
    return () => { active = false; };
  }, [client]);
  useEffect(() => {
    if (!showActualAsyncMessage) return;
    let active = true;
    void fetch(`${origin}/api/sessions/${sessionId}/events`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Transcript request failed: ${response.status}`);
      return response.json() as Promise<{ events: Array<{ payload: { kind: string; text?: string } }> }>;
    }).then(({ events }) => {
      const text = events.find((event) => event.payload.kind === "agent_message")?.payload.text;
      if (active && text) setActualAsyncMessage(text);
    }).catch((cause) => { if (active) setError((cause as Error).message); });
    return () => { active = false; };
  }, []);

  const pendingQuestion = session?.pendingApproval?.kind === "question" ? session.pendingApproval : null;
  useEffect(() => {
    if (pendingQuestion && responseStyle === "composer") setAnswerActive(true);
    else if (!pendingQuestion) setAnswerActive(false);
  }, [pendingQuestion?.requestId, responseStyle]);
  if (pendingQuestion) {
    questionEventRef.current = {
      kind: "question",
      id: 10_000,
      requestId: pendingQuestion.requestId,
      questions: pendingQuestion.questions ?? [],
    };
  }
  const questionEvent = questionEventRef.current;
  const context: TimelineItem[] = showActualAsyncMessage
    ? actualAsyncMessage ? [{ kind: "agent_message", id: 1, text: actualAsyncMessage }] : []
    : transcriptContext;
  const timelineItems: TimelineItem[] = questionEvent
    ? [...context, { ...questionEvent, answered: pendingQuestion ? undefined : true }]
    : context;
  // As SessionDetail: the question waits on the request dock above the composer and its transcript row
  // is a marker (#2205).
  // While Answer Mode is open the question is shown in the composer alone (#2212).
  const composerAnswers = pendingQuestion !== null && responseStyle === "composer" &&
    (pendingQuestion.recoveryReason !== "provider_restart" || pendingQuestion.recoveryAction === "resume_answer");
  const docked = session ? dockRequests(prioritizedPendingRequests(session.pendingApproval))
    .filter((request) => !(composerAnswers && answerActive && request.requestId === pendingQuestion?.requestId)) : [];

  return (
    <ApiProvider client={client}>
      <main id="question-frame" className="session-detail">
        {error ? (
          <p role="alert">{error}</p>
        ) : !session ? (
          <p role="status">Loading Agent Questions…</p>
        ) : (
          <div className="detail-columns">
            <div className="detail-chat">
              <SessionApprovalRegion
                session={session}
                runnerOnline
                fallbackFocusRef={fallbackFocusRef}
                alternateFallbackFocusRef={scrollRef}
              />
              <div className="chat-reading">
              <div className="detail-main">
                <div className="detail-reader">
                  <div className="detail-scroll measured-virtual-scroll" ref={scrollRef} tabIndex={0}>
                    {timelineItems.length > 0 && (
                      <EventTimeline
                        items={timelineItems}
                        scrollRef={scrollRef}
                        historyKey="agent-question-live-e2e"
                        questionContext={{
                          pendingRequestIds: docked.flatMap((request) => request.kind === "question" ? [request.requestId] : []),
                          onJumpToQuestion: (requestId) => focusSessionRequest(session.id, requestId),
                        }}
                      />
                    )}
                    {!session.pendingApproval && <p role="status">Question Answered</p>}
                  </div>
                </div>
              </div>
              {docked.length > 0 && (
                <SessionNoticeSlot sessionId={session.id} entries={[]} lead={{
                  key: "request-dock",
                  title: pendingRequestsTitle(docked.length),
                  icon: <RequestKindIcon request={docked[0]!} />,
                  requestIds: docked.map((request) => request.requestId),
                  render: ({ trailing, revealRequestId, concealTrailing }) => (
                    <RequestDock session={session} requests={docked} runnerOnline onSessionUpdate={setSession}
                      headTrailing={trailing} revealRequestId={revealRequestId} onConceal={concealTrailing}
                      composerAnswer={composerAnswers && pendingQuestion
                        ? { requestId: pendingQuestion.requestId, onAnswer: () => setAnswerActive(true) } : undefined} />
                  ),
                }} />
              )}
              </div>
              <div className="composer">
                {showQueuedPrompts && queuedPrompts.length > 0 && (
                  <section className="queue" aria-label="Queued Messages">
                    <button type="button" className="disclosure-trigger queue-summary" aria-expanded={queueExpanded}
                      aria-controls="live-queue-rows" onClick={() => setQueueExpanded((open) => !open)}>
                      <ChevronRightIcon className="disclosure-chevron" />
                      <span className="queue-count">
                        {queuedPrompts.length} {queuedPrompts.length === 1 ? "Queued Message" : "Queued Messages"}
                      </span>
                    </button>
                    <ul id="live-queue-rows" className="queue-rows" hidden={!queueExpanded}>
                      {queuedPrompts.map((prompt) => (
                        <li className="queue-row" key={prompt.id}>
                          <span className="queue-text">{prompt.text}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <div className={`composer-box${answerActive ? " answer-mode" : ""}`}>
                  {pendingQuestion &&
                    (pendingQuestion.recoveryReason !== "provider_restart" ||
                      pendingQuestion.recoveryAction === "resume_answer") && (
                    <ComposerQuestionResponse
                      sessionId={session.id}
                      requestId={pendingQuestion.requestId}
                      occurrenceId={pendingQuestion.occurrenceId}
                      questions={pendingQuestion.questions ?? []}
                      runnerOnline
                      active={answerActive}
                      recovery={pendingQuestion.recoveryReason === "provider_restart"}
                      inputRef={answerInputRef}
                      onExit={() => setAnswerActive(false)}
                      onSessionUpdate={setSession}
                    />
                  )}
                  {!answerActive && <textarea ref={fallbackFocusRef} className="composer-input" placeholder="Do anything" />}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<LiveQuestionFixture />);
