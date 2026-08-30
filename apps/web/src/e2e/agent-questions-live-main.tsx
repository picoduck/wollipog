import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { createBrowserApiTransport } from "../api-transport.js";
import { EventTimeline } from "../components/EventTimeline.js";
import { SessionApprovalRegion } from "../components/SessionApproval.js";
import type { TimelineItem } from "../timeline.js";
import "../styles.css";

const params = new URLSearchParams(window.location.hash.slice(1));
const origin = params.get("origin") ?? "";
const token = params.get("token") ?? "";
const sessionId = params.get("sessionId") ?? "";
const showQueuedPrompts = params.get("queued") === "1";

function LiveQuestionFixture() {
  const client = useMemo(() => createApiClient(createBrowserApiTransport({
    instanceId: "agent-question-live-e2e",
    origin,
    token: () => token,
  })), []);
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fallbackFocusRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const questionEventRef = useRef<Extract<TimelineItem, { kind: "question" }> | null>(null);
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
  if (pendingQuestion) {
    questionEventRef.current = {
      kind: "question",
      id: 1,
      requestId: pendingQuestion.requestId,
      questions: pendingQuestion.questions ?? [],
    };
  }
  const questionEvent = questionEventRef.current;
  const timelineItems: TimelineItem[] = questionEvent
    ? [{ ...questionEvent, answered: pendingQuestion ? undefined : true }]
    : [];

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
                questionInTimeline={false}
              />
              <div className="detail-main">
                <div className="detail-reader">
                  <div className="detail-scroll" ref={scrollRef} tabIndex={0}>
                    {timelineItems.length > 0 && (
                      <EventTimeline
                        items={timelineItems}
                        scrollRef={scrollRef}
                        historyKey="agent-question-live-e2e"
                        questionContext={{
                          sessionId: session.id,
                          pendingQuestion: null,
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
                <div className="composer-box">
                  <textarea ref={fallbackFocusRef} className="composer-input" placeholder="Do anything" />
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
