import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionEvent } from "@wollipog/protocol";
import { TimelineBuilder } from "../timeline.js";
import { EventTimeline } from "../components/EventTimeline.js";
import { TURN_RETRY_FRESH_RESTART_REASON } from "../turn-retry.js";
import "../styles.css";

/** A settled turn, a stopped turn and a failed turn whose provider error arrives twice (#2169),
 * built from runner events so the transcript sees exactly what a session would. */
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
// `?runner=offline` and `?restart=fresh` show two of the reasons Retry Turn names when it cannot run.
const unavailableReason = params.get("runner") === "offline" ? "Runner is offline."
  : params.get("restart") === "fresh" ? TURN_RETRY_FRESH_RESTART_REASON
  : undefined;

const start = Date.UTC(2026, 9, 2, 0, 12, 0);
const minute = 60_000;
let seq = 0;
const event = (ts: number, payload: SessionEvent["payload"]): SessionEvent =>
  ({ id: ++seq, sessionId: "turn-outcomes", seq, ts, payload }) as SessionEvent;

const events: SessionEvent[] = [
  event(start, { kind: "user_message", text: "Find why the reader loses its place after a resize." }),
  event(start + 1_000, { kind: "checkpoint", turn: 1 } as SessionEvent["payload"]),
  event(start + 20_000, {
    kind: "agent_message",
    text: "The anchor was saved before the width changed, so the old row heights decided where the reader landed. It now re-reads the anchor after the rows remeasure.",
    final: true,
  }),
  event(start + 26_000, { kind: "conversation_checkpoint", turn: 1 } as SessionEvent["payload"]),
  event(start + 6 * minute, { kind: "user_message", text: "Now refactor the parser so tokens carry their source range." }),
  event(start + 6 * minute + 1_000, { kind: "checkpoint", turn: 2 } as SessionEvent["payload"]),
  event(start + 6 * minute + 9_000, { kind: "agent_message", text: "Starting with the lexer, which builds every token.", final: true }),
  event(start + 7 * minute, { kind: "turn_interrupted" }),
  event(start + 13 * minute, { kind: "user_message", text: "Summarize the release notes for 0.30." }),
  event(start + 13 * minute + 1_000, { kind: "checkpoint", turn: 3 } as SessionEvent["payload"]),
  event(start + 13 * minute + 6_000, { kind: "agent_message", text: "Reading the notes.", final: true }),
  event(start + 13 * minute + 9_000, { kind: "error", message: "prompt failed: Rate limit reached for claude-opus-5-5. Your limit resets at 1:00 AM." }),
  event(start + 13 * minute + 9_000, { kind: "error", message: "Rate limit reached for claude-opus-5-5. Your limit resets at 1:00 AM." }),
];

declare global {
  interface Window {
    turnOutcomesE2E: { retried: () => string[] };
  }
}
const retried: string[] = [];
window.turnOutcomesE2E = { retried: () => [...retried] };

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<number>();
  const items = useMemo(() => {
    const builder = new TimelineBuilder();
    for (const ev of events) builder.push(ev);
    return builder.snapshot();
  }, []);
  return (
    <main style={{ display: "flex", width: "100vw", height: "100vh", background: "var(--bg)" }}>
      <div className="detail-scroll measured-virtual-scroll" ref={scrollRef} data-testid="reader" style={{ flex: 1 }}>
        <EventTimeline
          items={items}
          sessionActive={false}
          scrollRef={scrollRef}
          historyKey="turn-outcomes-e2e"
          onFork={() => {}}
          turnRetry={{
            onRetry: (prompt) => {
              retried.push(prompt.text);
              setPending(prompt.id);
              setTimeout(() => setPending(undefined), 400);
            },
            ...(unavailableReason !== undefined ? { unavailableReason } : {}),
            ...(pending !== undefined ? { pendingPromptId: pending } : {}),
          }}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
