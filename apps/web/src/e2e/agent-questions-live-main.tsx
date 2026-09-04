import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { createBrowserApiTransport } from "../api-transport.js";
import { EventTimeline } from "../components/EventTimeline.js";
import { SessionApprovalRegion } from "../components/SessionApproval.js";
import { ComposerQuestionResponse } from "../components/ComposerQuestionResponse.js";
import type { TimelineItem } from "../timeline.js";
import { useQuestionResponseStyle } from "../question-response-style.js";
import "../styles.css";

const params = new URLSearchParams(window.location.hash.slice(1));
const origin = params.get("origin") ?? "";
const token = params.get("token") ?? "";
const sessionId = params.get("sessionId") ?? "";
const showQueuedPrompts = params.get("queued") === "1";

function LiveQuestionFixture() {
  const responseStyle = useQuestionResponseStyle();
  const client = useMemo(() => createApiClient(createBrowserApiTransport({
    instanceId: "agent-question-live-e2e",
    origin,
    token: () => token,
  })), []);
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inlineQuestionRequestId, setInlineQuestionRequestId] = useState<string | null>(null);
  const fallbackFocusRef = useRef<HTMLTextAreaElement>(null);
  const answerInputRef = useRef<HTMLInputElement>(null);
  const [answerActive, setAnswerActive] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const questionEventRef = useRef<Extract<TimelineItem, { kind: "question" }> | null>(null);
  const transcriptContext = useMemo<TimelineItem[]>(() => Array.from({ length: 48 }, (_, index) => (
    index % 2 === 0
      ? { kind: "user_message", id: index + 1, text: `Earlier question ${index / 2 + 1}` }
      : { kind: "agent_message", id: index + 1, text: `Earlier answer ${(index + 1) / 2}` }
  )), []);
  const queuedPrompts = [
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

  const pendingQuestion = session?.pendingApproval?.kind === "question" ? session.pendingApproval : null;
  useEffect(() => {
    if (pendingQuestion && responseStyle === "composer") setAnswerActive(true);
    else if (!pendingQuestion) setAnswerActive(false);
  }, [pendingQuestion?.requestId, responseStyle]);
  const handleQuestionAvailabilityChange = useCallback((requestId: string, available: boolean) => {
    setInlineQuestionRequestId((current) => available
      ? current === requestId ? current : requestId
      : current === requestId ? null : current);
  }, []);
  if (pendingQuestion) {
    questionEventRef.current = {
      kind: "question",
      id: 10_000,
      requestId: pendingQuestion.requestId,
      questions: pendingQuestion.questions ?? [],
    };
  }
  const questionEvent = questionEventRef.current;
  const timelineItems: TimelineItem[] = questionEvent
    ? [...transcriptContext, { ...questionEvent, answered: pendingQuestion ? undefined : true }]
    : transcriptContext;
  const questionInTimeline = pendingQuestion != null && inlineQuestionRequestId === pendingQuestion.requestId;

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
                onSessionUpdate={setSession}
                showKeyHints={false}
                questionInTimeline={questionInTimeline}
              />
              <div className="detail-main">
                <div className="detail-reader">
                  <div className="detail-scroll measured-virtual-scroll" ref={scrollRef} tabIndex={0}>
                    {timelineItems.length > 0 && (
                      <EventTimeline
                        items={timelineItems}
                        scrollRef={scrollRef}
                        historyKey="agent-question-live-e2e"
                        questionContext={{
                          sessionId: session.id,
                          pendingQuestion: pendingQuestion ? {
                            requestId: pendingQuestion.requestId,
                            questions: pendingQuestion.questions ?? [],
                          } : null,
                          questionInTimeline,
                          onPendingQuestionAvailabilityChange: handleQuestionAvailabilityChange,
                          runnerOnline: true,
                          onSessionUpdate: setSession,
                          showKeyHints: false,
                        }}
                      />
                    )}
                    {!session.pendingApproval && <p role="status">Question Answered</p>}
                  </div>
                </div>
              </div>
              <div className="composer">
                {showQueuedPrompts && queuedPrompts.length > 0 && (
                  <div className="queued-list" aria-label="Queued Messages">
                    {queuedPrompts.map((prompt) => (
                      <div className="queued-item" key={prompt.id}>
                        <span className="queued-badge">Queued</span>
                        <span className="queued-text">{prompt.text}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className={`composer-box${answerActive ? " answer-mode" : ""}`}>
                  {pendingQuestion && (
                    <ComposerQuestionResponse
                      sessionId={session.id}
                      requestId={pendingQuestion.requestId}
                      questions={pendingQuestion.questions ?? []}
                      runnerOnline
                      active={answerActive}
                      showWaiting={responseStyle === "composer"}
                      inputRef={answerInputRef}
                      onEnter={() => setAnswerActive(true)}
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
