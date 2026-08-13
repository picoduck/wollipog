import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PendingApproval, SessionEvent, SessionEventPayload } from "@wollipog/protocol";
import { WorkingIndicator } from "../components/WorkingIndicator.js";
import { EventTimeline, type TimelineRevealRequest } from "../components/EventTimeline.js";
import type { TimelineItem } from "../timeline.js";
import { deriveActiveTurnProgress } from "../turn-progress.js";
import "../styles.css";

const fixtureNow = Date.now();
const turnStartedAt = fixtureNow - 420_000;
const retryError = "Release validation failed because the compatibility marker did not match the expected control-plane service identity in the packaged desktop application.";

let nextSeq = 0;
function event(payload: SessionEventPayload, ts: number): SessionEvent {
  const seq = ++nextSeq;
  return { id: seq, seq, sessionId: "active-turn-progress-e2e", ts, payload };
}

nextSeq = 0;
const events: SessionEvent[] = [
  event({ kind: "user_message", text: "Finish compatibility validation and prepare the release." }, turnStartedAt),
  event({ kind: "tool_call", toolCallId: "inspect", title: "Inspect Release Metadata", toolKind: "read", status: "completed" }, fixtureNow - 380_000),
  event({ kind: "tool_call", toolCallId: "release-audit-agent", title: "Coordinate Release Audit", toolKind: "agent", status: "running" }, fixtureNow - 360_000),
  event({ kind: "tool_call", toolCallId: "retry-1", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError }, fixtureNow - 300_000),
  event({ kind: "tool_call", toolCallId: "retry-2", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError }, fixtureNow - 240_000),
  event({ kind: "tool_call", toolCallId: "retry-3", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError }, fixtureNow - 180_000),
  event({ kind: "plan", entries: [
    { content: "Inspect release metadata", status: "completed" },
    { content: "Validate compatibility release", status: "in_progress" },
    { content: "Publish verified artifacts", status: "pending" },
  ] }, fixtureNow - 60_000),
];

const approval: PendingApproval = {
  requestId: "release-approval",
  title: "Publish the compatibility release",
  options: [],
  kind: "permission",
};

const derivedProgress = deriveActiveTurnProgress({
  status: "input_required",
  pendingApproval: approval,
  events,
});

if (!derivedProgress) throw new Error("The active-turn fixture did not derive progress.");
const progress = derivedProgress;

const filler = Array.from({ length: 20 }, (_, index): TimelineItem => ({
  kind: "agent_message",
  id: 20 + index,
  text: `Later transcript evidence ${index + 1}. ${"Verification output remains observable. ".repeat(4)}`,
  createdAt: fixtureNow - 59_000 + index * 1_000,
}));

const items: TimelineItem[] = [
  { kind: "user_message", id: 1, text: "Finish compatibility validation and prepare the release.", createdAt: turnStartedAt },
  { kind: "tool_call", id: 2, toolCallId: "inspect", title: "Inspect Release Metadata", toolKind: "read", status: "completed", text: "Release metadata is present." },
  { kind: "tool_call", id: 3, toolCallId: "release-audit-agent", title: "Coordinate Release Audit", toolKind: "agent", status: "running", text: "" },
  { kind: "agent_message", id: 8, text: "Auditing compatibility gates and packaged artifacts.", parentToolUseId: "release-audit-agent" },
  { kind: "tool_call", id: 4, toolCallId: "retry-1", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError },
  { kind: "tool_call", id: 5, toolCallId: "retry-2", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError },
  { kind: "tool_call", id: 6, toolCallId: "retry-3", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError },
  { kind: "plan", id: 7, entries: [
    { content: "Inspect release metadata", status: "completed" },
    { content: "Validate compatibility release", status: "in_progress" },
    { content: "Publish verified artifacts", status: "pending" },
  ] },
  ...filler,
];

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [revealRequest, setRevealRequest] = useState<TimelineRevealRequest | null>(null);
  const [openedSubagent, setOpenedSubagent] = useState("None");
  const nextReveal = useRef(0);
  const stableItems = useMemo(() => items, []);

  return (
    <main style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", width: "100vw", height: "100vh", padding: 12, background: "var(--bg)", overflow: "hidden" }}>
      <output
        data-testid="opened-subagent"
        aria-label="Opened Subagent"
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}
      >
        {openedSubagent}
      </output>
      <div className="detail-scroll" ref={scrollRef} data-testid="reader" style={{ overflowX: "hidden" }} tabIndex={0}>
        <EventTimeline
          items={stableItems}
          scrollRef={scrollRef}
          historyKey="active-turn-progress-e2e"
          revealRequest={revealRequest}
          onRevealHandled={() => setRevealRequest(null)}
          sessionActive
          onOpenSubagent={setOpenedSubagent}
        />
        {/* Production placement: the merged progress row trails the transcript content. */}
        <WorkingIndicator
          progress={progress}
          now={fixtureNow}
          onRevealCurrentOperation={(eventId) => {
            nextReveal.current += 1;
            setRevealRequest({
              eventId,
              requestId: nextReveal.current,
              historyKey: "active-turn-progress-e2e",
              align: "center",
              focus: true,
            });
          }}
          onOpenSubagent={setOpenedSubagent}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
