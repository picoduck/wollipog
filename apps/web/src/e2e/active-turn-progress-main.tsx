import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PendingApproval, SessionEvent, SessionEventPayload } from "@wollipog/protocol";
import { WorkingIndicator } from "../components/WorkingIndicator.js";
import { EventTimeline, type TimelineRevealRequest } from "../components/EventTimeline.js";
import type { TimelineItem } from "../timeline.js";
import { deriveActiveTurnProgress } from "../turn-progress.js";
import "../styles.css";

/** `?scenario=` picks the turn: running, failing (the default), silent, approval, or agents (a running,
 * a completed and a nested agent, #2183). `?plan=` replaces the current plan step's text.
 * `?theme=light` switches theme. */
type Scenario = "running" | "failing" | "silent" | "approval" | "agents";
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
const requested = params.get("scenario");
const scenario: Scenario = requested === "running" || requested === "silent" || requested === "approval" ||
  requested === "agents"
  ? requested
  : "failing";

const fixtureNow = Date.now();
const turnStartedAt = fixtureNow - 420_000;
// A silent turn's last output is three minutes old; every other turn is still streaming.
const latestOutputAt = scenario === "silent" ? fixtureNow - 185_000 : fixtureNow - 4_000;
const retryError = "Release validation failed because the compatibility marker did not match the expected control-plane service identity in the packaged desktop application.";
const planEntries = [
  { content: "Inspect release metadata", status: "completed" as const },
  { content: params.get("plan") ?? "Validate compatibility release", status: "in_progress" as const },
  { content: "Publish verified artifacts", status: "pending" as const },
];

let nextSeq = 0;
function event(payload: SessionEventPayload, ts: number): SessionEvent {
  const seq = ++nextSeq;
  return { id: seq, seq, sessionId: "active-turn-progress-e2e", ts, payload };
}

const failures = scenario === "failing";
const events: SessionEvent[] = [
  event({ kind: "user_message", text: "Finish compatibility validation and prepare the release." }, turnStartedAt),
  event({ kind: "tool_call", toolCallId: "inspect", title: "Inspect Release Metadata", toolKind: "read", status: "completed" }, fixtureNow - 380_000),
  event({ kind: "tool_call", toolCallId: "release-audit-agent", title: "Coordinate Release Audit", toolKind: "agent", status: "running" }, fixtureNow - 360_000),
  ...(failures ? [
    event({ kind: "tool_call", toolCallId: "retry-1", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError }, fixtureNow - 300_000),
    event({ kind: "tool_call", toolCallId: "retry-2", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError }, fixtureNow - 240_000),
    event({ kind: "tool_call", toolCallId: "retry-3", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError }, fixtureNow - 180_000),
  ] : []),
  event({ kind: "plan", entries: planEntries }, latestOutputAt),
];

const approval: PendingApproval = {
  requestId: "release-approval",
  title: "Publish the compatibility release",
  options: [],
  kind: "permission",
};
if (scenario === "approval") {
  events.push(event({ kind: "permission_request", requestId: approval.requestId, title: approval.title, options: [] }, latestOutputAt));
}

const derivedProgress = deriveActiveTurnProgress({
  status: scenario === "approval" ? "input_required" : "running",
  pendingApproval: scenario === "approval" ? approval : null,
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

const permissionEventId = events.at(-1)!.seq;
const at = (secondsAgo: number) => fixtureNow - secondsAgo * 1_000;
/** One turn that spawned a running agent (which spawned a nested one) and a completed agent. */
const agentItems: TimelineItem[] = [
  { kind: "user_message", id: 1, text: "Finish compatibility validation and prepare the release.", createdAt: turnStartedAt },
  { kind: "tool_call", id: 2, toolCallId: "inspect", title: "Inspect Release Metadata", toolKind: "read", status: "completed", text: "Release metadata is present.", startedAt: at(400), lastActivityAt: at(398), completedAt: at(398) },
  { kind: "tool_call", id: 3, toolCallId: "release-audit-agent", title: "Coordinate Release Audit", toolKind: "agent", status: "in_progress", subagentLifecycle: "running", subagentRole: "explorer", text: "", startedAt: at(360), lastActivityAt: at(4) },
  { kind: "agent_message", id: 4, text: "Auditing compatibility gates and packaged artifacts.", parentToolUseId: "release-audit-agent", createdAt: at(350) },
  { kind: "tool_call", id: 5, toolCallId: "audit-read", title: "Read: release/manifest.json", toolKind: "read", status: "completed", text: "", parentToolUseId: "release-audit-agent", startedAt: at(340), lastActivityAt: at(339), completedAt: at(339) },
  { kind: "tool_call", id: 6, toolCallId: "gates-agent", title: "Check Compatibility Gates", toolKind: "agent", status: "completed", subagentLifecycle: "completed", text: "All four gates pass.", parentToolUseId: "release-audit-agent", startedAt: at(330), lastActivityAt: at(240), completedAt: at(240) },
  { kind: "tool_call", id: 7, toolCallId: "gates-read", title: "Read: release/gates.ts", toolKind: "read", status: "completed", text: "", parentToolUseId: "gates-agent", startedAt: at(320), lastActivityAt: at(319), completedAt: at(319) },
  { kind: "tool_call", id: 8, toolCallId: "gates-run", title: "Bash: pnpm check:gates", toolKind: "execute", status: "completed", text: "4 gates pass", parentToolUseId: "gates-agent", startedAt: at(300), lastActivityAt: at(250), completedAt: at(250) },
  { kind: "tool_call", id: 9, toolCallId: "notes-agent", title: "Draft Release Notes", toolKind: "agent", status: "completed", subagentLifecycle: "completed", subagentRole: "writer", text: "Drafted the v0.30 release notes.", startedAt: at(230), lastActivityAt: at(120), completedAt: at(120) },
  { kind: "tool_call", id: 10, toolCallId: "notes-read", title: "Read: CHANGELOG.md", toolKind: "read", status: "completed", text: "", parentToolUseId: "notes-agent", startedAt: at(220), lastActivityAt: at(219), completedAt: at(219) },
  { kind: "agent_message", id: 11, text: "Release notes drafted from the changelog.", parentToolUseId: "notes-agent", createdAt: at(125) },
  { kind: "plan", id: 12, entries: planEntries },
];
const items: TimelineItem[] = scenario === "agents" ? agentItems : [
  { kind: "user_message", id: 1, text: "Finish compatibility validation and prepare the release.", createdAt: turnStartedAt },
  { kind: "tool_call", id: 2, toolCallId: "inspect", title: "Inspect Release Metadata", toolKind: "read", status: "completed", text: "Release metadata is present." },
  { kind: "tool_call", id: 3, toolCallId: "release-audit-agent", title: "Coordinate Release Audit", toolKind: "agent", status: "running", text: "" },
  { kind: "agent_message", id: 8, text: "Auditing compatibility gates and packaged artifacts.", parentToolUseId: "release-audit-agent" },
  ...(failures ? [
    { kind: "tool_call", id: 4, toolCallId: "retry-1", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError },
    { kind: "tool_call", id: 5, toolCallId: "retry-2", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError },
    { kind: "tool_call", id: 6, toolCallId: "retry-3", title: "Run Compatibility Validation", toolKind: "execute", status: "failed", text: retryError },
  ] satisfies TimelineItem[] : []),
  { kind: "plan", id: 7, entries: planEntries },
  ...(scenario === "approval"
    ? [{ kind: "permission", id: permissionEventId, requestId: approval.requestId, title: approval.title, options: [] }] satisfies TimelineItem[]
    : []),
  ...filler,
];

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [revealRequest, setRevealRequest] = useState<TimelineRevealRequest | null>(null);
  const [openedSubagent, setOpenedSubagent] = useState("None");
  const nextReveal = useRef(0);
  const stableItems = useMemo(() => items, []);
  // Production reveals a request row the same way it reveals a step (SessionDetail).
  const reveal = (eventId: number) => {
    nextReveal.current += 1;
    setRevealRequest({
      eventId,
      requestId: nextReveal.current,
      historyKey: "active-turn-progress-e2e",
      align: "center",
      focus: true,
    });
  };

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
          onRevealCurrentOperation={reveal}
          onOpenSubagent={setOpenedSubagent}
          onReviewPendingRequest={() => reveal(permissionEventId)}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
