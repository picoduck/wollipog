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

/** Three settled turns in a full-width reader, as the session page lays them out. */
const turnStart = now - 30 * 60_000;
const turnItems: TimelineItem[] = [1, 2, 3].flatMap((turn): TimelineItem[] => {
  const base = turn * 100;
  const startedAt = turnStart + (turn - 1) * 6 * 60_000;
  return [
    {
      kind: "user_message",
      id: base,
      text: [
        "Find why the reader loses its place after a resize, and fix it.",
        "Now add a regression test for the phone layout.",
        "Thanks. Summarise what changed.",
      ][turn - 1]!,
      createdAt: startedAt,
      durationMs: 26_000,
      durationSource: "provider",
      turnUsage: { inputTokens: 9_800 * turn, outputTokens: 1_200, cachedInputTokens: 0, cacheCreationTokens: 0, costUsd: 0.04 * turn },
    },
    { kind: "checkpoint", id: base + 1, turn },
    { kind: "agent_message", id: base + 2, text: "Let me look at how the reader measures its rows first.", createdAt: startedAt + 2_000, lastActivityAt: startedAt + 3_000 },
    {
      kind: "tool_call", id: base + 3, toolCallId: `read-${turn}`, title: "Read MeasuredVirtualList.tsx", toolKind: "read",
      status: "completed", text: "", startedAt: startedAt + 4_000, lastActivityAt: startedAt + 9_000, completedAt: startedAt + 9_000,
    },
    {
      kind: "agent_message",
      id: base + 4,
      text: [
        "The anchor was saved before the width changed, so the **old row heights** decided where the reader landed. It now re-reads the anchor after the rows remeasure.",
        "Added a phone test that resizes the reader mid-scroll and checks the same row stays at the top.",
        "The reader keeps its row across resizes, and a phone test covers it. Nothing else changed.",
      ][turn - 1]!,
      createdAt: startedAt + 12_000,
      lastActivityAt: startedAt + 26_000,
      completedAt: startedAt + 26_000,
    },
    { kind: "conversation_checkpoint", id: base + 5, turn },
  ];
});

function TurnsFixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const theme = new URLSearchParams(location.search).get("theme") ?? "dark";
  document.documentElement.dataset.theme = theme;
  return (
    <main style={{ display: "flex", width: "100vw", height: "100vh", background: "var(--bg)" }}>
      <div className="detail-scroll measured-virtual-scroll" ref={scrollRef} data-testid="reader" style={{ flex: 1 }}>
        <EventTimeline
          items={turnItems}
          sessionActive={false}
          scrollRef={scrollRef}
          historyKey="turns-e2e"
          onRewind={() => {}}
          onFork={() => {}}
          handoff={{ open: () => {} }}
          onEditAndResend={() => {}}
          forkAvailabilityByTurn={new Map([1, 2, 3].map((turn) => [turn, { available: true as const, forkTurn: turn }]))}
        />
      </div>
    </main>
  );
}

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

createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).get("scenario") === "turns" ? <TurnsFixture /> : <Fixture />,
);
