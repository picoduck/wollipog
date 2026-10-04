import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionEvent, SessionEventPayload } from "@wollipog/protocol";
import { EventTimeline } from "../components/EventTimeline.js";
import { deriveTimeline } from "../timeline.js";
import "../styles.css";

/** Two turns of real events through the timeline builder (#2187): turn 1 revises its plan three
 * times, reads, deletes and moves files, runs a command, and writes a new file and edits another;
 * turn 2 revises the plan once more.
 * `?theme=light` switches theme. */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const workspaceRoot = "/home/dev/wollipog";
const fixtureNow = Date.now();
const at = (secondsAgo: number) => fixtureNow - secondsAgo * 1_000;

let nextSeq = 0;
function event(payload: SessionEventPayload, ts: number): SessionEvent {
  const seq = ++nextSeq;
  return { id: seq, seq, sessionId: "plan-diffs-e2e", ts, payload };
}

const newFileDiff = [
  "diff --git a/apps/web/src/release-notes.ts b/apps/web/src/release-notes.ts",
  "new file mode 100644",
  "index 0000000..3b18e51",
  "--- /dev/null",
  `+++ b/apps/web/src/release-notes.ts`,
  "@@ -0,0 +1,12 @@",
  "+/** One release's notes, newest first. */",
  "+export interface ReleaseNote {",
  "+  version: string;",
  "+  date: string;",
  "+  items: string[];",
  "+}",
  "+",
  "+export function latestNote(notes: readonly ReleaseNote[]): ReleaseNote | null {",
  "+  if (notes.length === 0) return null;",
  "+  return [...notes].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;",
  "+}",
  "+",
].join("\n");

const editDiff = [
  "diff --git a/apps/web/src/components/Header.tsx b/apps/web/src/components/Header.tsx",
  "index 9f2c1aa..4e0b7d2 100644",
  "--- a/apps/web/src/components/Header.tsx",
  "+++ b/apps/web/src/components/Header.tsx",
  "@@ -12,7 +12,8 @@ export function Header({ title }: { title: string }) {",
  "   const version = useVersion();",
  "-  const label = title.toUpperCase();",
  "+  const label = title;",
  "+  const note = latestNote(notes);",
  "   return (",
  "     <header className=\"page-header\">",
  "       <h1>{label}</h1>",
  "-      <span className=\"version\">{version}</span>",
  "+      <span className=\"version\">{note?.version ?? version}</span>",
  "     </header>",
].join("\n");

const plan = (statuses: ("pending" | "in_progress" | "completed")[]) => ({
  kind: "plan" as const,
  entries: [
    { content: "Read the release metadata and the current header", status: statuses[0]! },
    { content: "Add a release notes module with the latest note", status: statuses[1]! },
    { content: "Show the latest version in the page header", status: statuses[2]! },
  ],
});

const events: SessionEvent[] = [
  event({ kind: "user_message", text: "Show the latest release note's version in the page header." }, at(600)),
  event(plan(["pending", "pending", "pending"]), at(590)),
  event({ kind: "tool_call", toolCallId: "read-header", title: "Read: apps/web/src/components/Header.tsx", toolKind: "read", status: "completed" }, at(580)),
  event({ kind: "tool_call", toolCallId: "delete-banner", title: `Delete: ${workspaceRoot}/apps/web/src/components/legacy/ReleaseBanner.tsx`, toolKind: "delete", status: "completed" }, at(578)),
  event({ kind: "tool_call", toolCallId: "move-version", title: "Move: apps/web/src/version.ts → apps/web/src/release/version.ts", toolKind: "move", status: "completed" }, at(576)),
  event({ kind: "tool_call", toolCallId: "run-header-test", title: "$ pnpm --filter @wollipog/web exec node --test src/components/Header.dom.test.tsx", toolKind: "execute", status: "completed" }, at(574)),
  event(plan(["completed", "in_progress", "pending"]), at(570)),
  event({ kind: "file_edit", path: `${workspaceRoot}/apps/web/src/release-notes.ts`, diff: newFileDiff }, at(560)),
  event(plan(["completed", "completed", "in_progress"]), at(550)),
  event({ kind: "file_edit", path: `${workspaceRoot}/apps/web/src/components/Header.tsx`, diff: editDiff }, at(540)),
  event({ kind: "agent_message", text: "The header now shows the latest release note's version.", final: true }, at(530)),
  event({ kind: "user_message", text: "Also add a test for the empty case." }, at(300)),
  event({
    kind: "plan",
    entries: [
      { content: "Read the release metadata and the current header", status: "completed" },
      { content: "Add a release notes module with the latest note", status: "completed" },
      { content: "Show the latest version in the page header", status: "completed" },
      { content: "Test that no notes yield no latest note", status: "in_progress" },
    ],
  }, at(290)),
  event({ kind: "agent_message", text: "Adding the empty-case test now.", final: true }, at(280)),
];

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState("None");
  const items = useMemo(() => deriveTimeline(events), []);
  return (
    <main style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", width: "100vw", height: "100vh", padding: 12, background: "var(--bg)", overflow: "hidden" }}>
      <output
        data-testid="opened-location"
        aria-label="Opened Location"
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}
      >
        {opened}
      </output>
      <div className="detail-scroll" ref={scrollRef} data-testid="reader" style={{ overflowX: "hidden" }} tabIndex={0}>
        <EventTimeline
          items={items}
          scrollRef={scrollRef}
          historyKey="plan-diffs-e2e"
          workspaceRoot={workspaceRoot}
          onOpenSourceLocation={(location) => setOpened(`File: ${location.path}`)}
          onOpenInReview={(path) => setOpened(`Review: ${path}`)}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
