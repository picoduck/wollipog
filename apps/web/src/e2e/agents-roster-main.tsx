import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION, type PodView, type RunView, type RunnerView, type SessionView,
  type UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { AgentsPanel } from "../components/AgentsPanel.js";
import type { TimelineItem } from "../timeline.js";
import "../styles.css";

/**
 * The Agents roster (#2857) in a 380px side-panel frame (full width on a phone), for one scene:
 * `pod` (a pod lead with subagents, a background job and pod members), `run` (a run member and its
 * run's other members), `nested` (subagents three deep, one asking), `offline` (the same, runner
 * offline), `empty` (nothing active, one finished) and `many` (120 workers).
 */
const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "pod";
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
const now = Date.now();
const minutes = (value: number) => now - value * 60_000;

const sessionBase = {
  runnerId: "runner", workspaceId: null, workspaceName: null, agentId: "claude", agentName: "Claude Code",
  column: "review", runId: null, useWorktree: false, worktreePath: "/repo", archived: false,
  createdAt: minutes(42), updatedAt: now, lastEventAt: now, messageCount: 24, preview: null,
  driver: "claude-code", model: "claude-opus", effort: "high", permissionMode: null,
  tokensIn: 41_200, tokensOut: 9_800, costUsd: 0, adopted: false, pendingApproval: null,
} satisfies Partial<SessionView>;
const member = (id: string, title: string, extra: Partial<SessionView>): SessionView =>
  ({ ...sessionBase, id, title, status: "running", ...extra }) as SessionView;

const agent = (toolCallId: string, index: number, title: string, extra: Partial<Extract<TimelineItem, { kind: "tool_call" }>> = {}): TimelineItem => ({
  kind: "tool_call", id: index, toolCallId, title: `Agent: ${title}`, text: "", toolKind: "agent",
  status: "in_progress", startedAt: minutes(12 - index / 4), ...extra,
});
const step = (toolCallId: string, index: number, parent: string, title: string, status = "in_progress"): TimelineItem => ({
  kind: "tool_call", id: index, toolCallId, parentToolUseId: parent, title, text: "", toolKind: "execute",
  status, startedAt: minutes(2),
});

const lead: SessionView = member("lead", "Rewrite the Parser", { status: "running" });
let session: SessionView = lead;
let items: TimelineItem[] = [];
let sessions: SessionView[] = [];
let runs: RunView[] = [];
let pods: PodView[] = [];

if (scene === "pod") {
  sessions = [
    member("grammar", "Grammar Worker", { status: "running", preview: "Rewriting the expression grammar so precedence climbing handles unary minus." }),
    member("tests", "Test Writer", { status: "idle", preview: "Added 14 parser tests for chained comparisons." }),
    member("review", "Parser Reviewer", { status: "input_required", pendingApproval: {
      requestId: "lint", title: "Bash: npm run lint -- --fix", options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] } }),
  ];
  pods = [{ id: "pod-1", title: "Parser Rewrite Pod", objective: "", status: "active", createdAt: minutes(50), updatedAt: now,
    members: [
      { sessionId: "lead", joinedAt: minutes(50), role: "lead", contextTokenBudget: null, lastContextSeq: 0 },
      { sessionId: "grammar", joinedAt: minutes(49), role: "worker", contextTokenBudget: null, lastContextSeq: 0 },
      { sessionId: "tests", joinedAt: minutes(49), role: "worker", contextTokenBudget: null, lastContextSeq: 0 },
      { sessionId: "review", joinedAt: minutes(48), role: "reviewer", contextTokenBudget: null, lastContextSeq: 0 },
    ] }];
  items = [
    agent("inspect", 1, "Inspect Parser Entry Points"), step("inspect-npm", 2, "inspect", "$ npm test -- parser"),
    agent("audit", 3, "Audit Storage Adapters", { status: "completed", completedAt: minutes(4) }),
    step("audit-read", 4, "audit", "Read: /repo/src/storage/adapter.ts", "completed"),
  ];
  session = { ...lead, backgroundWorkState: "running", backgroundWorkTracking: "managed", backgroundJobsAvailable: true,
    backgroundJobs: [{ id: "job-monitor", parentTurnId: "turn-1", launchType: "monitor", registeredAt: minutes(6),
      lastObservedAt: now, sourcePresent: true }] };
} else if (scene === "run") {
  const run = "Release Audit for Wollipog 2026.10";
  session = member("run-a", `${run} · Claude Code`, { runId: "run-1" });
  sessions = [
    member("run-b", `${run} · Codex`, { agentName: "Codex", runId: "run-1", status: "running",
      preview: "Checking the changelog against merged pull requests." }),
    member("run-c", `${run} · Gemini CLI`, { agentName: "Gemini CLI", runId: "run-1", status: "completed",
      preview: "No breaking protocol changes found." }),
  ];
  runs = [{ id: "run-1", title: run, prompt: "", workspaceId: null, workspaceName: null, createdAt: minutes(30),
    updatedAt: now, sessionIds: ["run-a", "run-b", "run-c"] }];
  items = [agent("notes", 1, "Draft Release Notes"), step("notes-edit", 2, "notes", "Edit: /repo/CHANGELOG.md")];
} else if (scene === "nested" || scene === "offline") {
  session = { ...lead, status: "input_required", pendingApproval: {
    requestId: "edit", ownerToolUseId: "tests", title: "Edit: /repo/src/auth/parser.ts",
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] } };
  items = [
    agent("plan", 1, "Plan the Parser Release"), step("plan-read", 2, "plan", "Read: /repo/docs/release.md"),
    agent("tests", 3, "Write Parser Regression Tests", { parentToolUseId: "plan" }),
    agent("bench", 4, "Benchmark the Tokenizer on a Very Large Input Corpus", { parentToolUseId: "tests" }),
    step("bench-run", 5, "bench", "$ npm run bench -- tokenizer"),
    agent("docs", 6, "Update the Parser Guide", { status: "completed", completedAt: minutes(1) }),
  ];
} else if (scene === "empty") {
  session = { ...lead, status: "idle" };
  items = [agent("done", 1, "Summarize the Parser Changes", { status: "completed", completedAt: minutes(3) })];
} else if (scene === "many") {
  items = Array.from({ length: 120 }, (_, index) => agent(`worker-${index + 1}`, index + 1, `Check Module ${index + 1}`));
}

const runner = (online: boolean) => ({ runnerId: "runner", hostname: "studio", os: "darwin", version: "1.0.0",
  status: online ? "online" : "offline", agents: [], workspaces: [], connectedAt: now, lastSeen: now }) as unknown as RunnerView;

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    window.setTimeout(() => {
      this.onopen?.();
      const snapshot: UiSnapshotMessage = { type: "snapshot", runners: [runner(scene !== "offline")], boxes: [],
        // The panel's own session stays out of the store, so the fixture's copy is the one shown.
        sessions, runs, pods } as unknown as UiSnapshotMessage;
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}
const connection: UiConnectionRuntime = {
  instanceId: "agents-roster-e2e", runtimeKey: "agents-roster-e2e", createSocket: () => new FixtureSocket(), close() {},
};
const client: ApiClient = { ...api,
  childSessions: async () => { throw new Error("The fixture has no child registry."); },
  workflowInstances: async () => [],
};

function Fixture() {
  const [selected, setSelected] = useState<string | null>(null);
  return <ApiProvider client={client}><FeedbackProvider><StoreProvider connection={connection}>
    <main className="agents-roster-fixture">
      <aside aria-label="Agents" className="agents-roster-fixture-panel">
        <AgentsPanel session={session} items={items} runnerOnline={scene !== "offline"}
          runnerProtocolVersion={PROTOCOL_VERSION} requestedId={selected} onSelect={setSelected}
          parentTurnEventIds={new Map()} onOpenParentTurn={() => {}} />
      </aside>
    </main>
    <style>{`
      body { margin: 0; background: var(--bg); }
      .agents-roster-fixture { display: flex; justify-content: flex-end; min-height: 100vh; }
      .agents-roster-fixture-panel { box-sizing: border-box; width: 380px; padding: var(--space-4);
        border-left: 1px solid var(--border); background: var(--bg-elev); }
      @media (max-width: 760px) { .agents-roster-fixture-panel { width: 100%; border-left: 0; } }
    `}</style>
  </StoreProvider></FeedbackProvider></ApiProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
