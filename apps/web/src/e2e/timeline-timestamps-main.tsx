import { Profiler, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TimelineItem } from "../timeline.js";
import { EventTimeline } from "../components/EventTimeline.js";
import "../styles.css";

const now = Date.now();
const items: TimelineItem[] = [
  {
    kind: "agent_message",
    id: 1,
    text: "A streamed message with stable timestamp metadata.",
    createdAt: now - 120_000,
    lastActivityAt: now - 20_000,
  },
  {
    kind: "agent_thought",
    id: 2,
    text: "A completed thought remains recorded.",
    createdAt: now - 95_000,
    lastActivityAt: now - 95_000,
    completedAt: now - 95_000,
  },
  {
    kind: "tool_call",
    id: 3,
    toolCallId: "bare",
    title: "Active Bare Tool",
    status: "running",
    text: "",
    startedAt: now - 90_000,
    lastActivityAt: now - 15_000,
  },
  {
    kind: "tool_call",
    id: 4,
    toolCallId: "details",
    title: "Completed Details Tool",
    status: "completed",
    text: "Completed output",
    startedAt: now - 80_000,
    lastActivityAt: now - 40_000,
    completedAt: now - 40_000,
  },
  ...Array.from({ length: 40 }, (_, index): TimelineItem => ({
    kind: "user_message",
    id: 100 + index,
    text: `Historical prompt ${index + 1}`,
    createdAt: now - (180_000 + index * 30_000),
  })),
];

let updateCommits = 0;
let timestampMutations = 0;
let layoutShift = 0;

new MutationObserver((records) => {
  timestampMutations += records.filter((record) =>
    record.type === "characterData" && record.target.parentElement?.closest(".tl-timestamp-meta")).length;
}).observe(document.documentElement, { subtree: true, characterData: true });

if ("PerformanceObserver" in window) {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) {
      if (!entry.hadRecentInput) layoutShift += entry.value ?? 0;
    }
  });
  try { observer.observe({ type: "layout-shift", buffered: true }); } catch { /* unsupported browser */ }
}

declare global {
  interface Window {
    timelineTimestampE2E: {
      metrics: () => { updateCommits: number; timestampMutations: number; layoutShift: number };
      resetMetrics: () => void;
    };
  }
}

window.timelineTimestampE2E = {
  metrics: () => ({ updateCommits, timestampMutations, layoutShift }),
  resetMetrics: () => {
    updateCommits = 0;
    timestampMutations = 0;
    layoutShift = 0;
  },
};

function Fixture() {
  const [sessionActive, setSessionActive] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <main style={{ width: 720, margin: "24px auto" }}>
      <button type="button" data-testid="complete-session" onClick={() => setSessionActive(false)}>Complete Session</button>
      <div ref={scrollRef} style={{ height: 520, overflow: "auto" }}>
        <Profiler id="timeline" onRender={(_id, phase) => { if (phase === "update") updateCommits += 1; }}>
          <EventTimeline items={items} sessionActive={sessionActive} scrollRef={scrollRef} historyKey="timestamp-e2e" />
        </Profiler>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
