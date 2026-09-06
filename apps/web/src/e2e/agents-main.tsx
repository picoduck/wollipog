import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION, removePendingRequest, type SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { InboxRow } from "../components/InboxRow.js";
import { Board } from "../components/Board.js";
import { viewPath } from "../navigation.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { AgentsPanel } from "../components/AgentsPanel.js";
import { SessionApprovalRegion, focusSessionRequest } from "../components/SessionApproval.js";
import type { TimelineItem } from "../timeline.js";
import "../styles.css";

const params = new URLSearchParams(location.search);
if (params.has("theme")) sessionStorage.setItem("agents-fixture-theme", params.get("theme")!);
document.documentElement.dataset.theme = (params.get("theme") ?? sessionStorage.getItem("agents-fixture-theme")) === "light" ? "light" : "dark";
const now = Date.now();
const navigationMode = params.has("navigation") || location.pathname.includes("/attention");
const initial: SessionView = {
  id: "agents-fixture", runnerId: "runner", workspaceId: null, workspaceName: null,
  agentId: null, agentName: null, title: "Unified Supervision", status: "input_required",
  column: "review", runId: null, useWorktree: false, worktreePath: null, archived: false,
  createdAt: now - 120_000, updatedAt: now, lastEventAt: now, messageCount: 2,
  preview: null, driver: "codex-app-server", model: null, effort: null, permissionMode: null,
  tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
  pendingApproval: {
    requestId: "permission-a", ownerToolUseId: "audit", title: "Read Test Fixtures?",
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
    additionalRequests: [{
      requestId: "permission-b", ownerToolUseId: "parser", title: "Run Parser Tests?",
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
    }],
  },
  backgroundWorkState: "running", backgroundWorkTracking: "managed", backgroundJobsAvailable: true,
  backgroundJobs: [{ id: "job-monitor", parentTurnId: "turn-1", launchType: "monitor", registeredAt: now - 60_000,
    lastObservedAt: now, sourcePresent: true }],
};
if (params.has("primary-question")) {
  initial.pendingApproval = { ...initial.pendingApproval!, kind: "question", options: [],
    title: "Choose Audit Scope", questions: [{ id: "scope", question: "Choose Audit Scope",
      options: [{ label: "Parser", description: "Inspect the parser." }] }] };
}
const items: TimelineItem[] = [
  { kind: "tool_call", id: 1, toolCallId: "audit", title: "Audit Storage", text: "",
    toolKind: "agent", status: "in_progress", startedAt: now - 120_000,
    subagentRollup: { inputTokens: 400, outputTokens: 200 } },
  { kind: "tool_call", id: 2, toolCallId: "parser", parentToolUseId: "audit", title: "Inspect Parser",
    text: "", toolKind: "agent", status: "in_progress", startedAt: now - 90_000 },
  { kind: "agent_message", id: 3, text: "The parser tests are ready to run.", parentToolUseId: "parser", createdAt: now - 10_000 },
  { kind: "tool_call", id: 4, toolCallId: "done", title: "Review Documentation", text: "",
    toolKind: "agent", status: "completed", startedAt: now - 120_000, completedAt: now - 30_000 },
];
const connection: UiConnectionRuntime = {
  instanceId: "agents-fixture", runtimeKey: "agents-fixture",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }), close() {},
};
function Fixture() {
  const [session, setSession] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const primaryRef = useRef<HTMLHeadingElement>(null);
  const client: ApiClient = { ...api, approve: async (_sessionId, { requestId }) => {
    const next = { ...session, pendingApproval: removePendingRequest(session.pendingApproval, requestId) };
    setSession(next);
    return next;
  } };
  return <ApiProvider client={client}><FeedbackProvider><StoreProvider connection={connection}>
    {navigationMode ? <NavigationFixture session={session} onSession={setSession} online={online} /> :
    <main style={{ maxWidth: 780, padding: 16, margin: "0 auto" }}>
      <h1 ref={primaryRef} tabIndex={-1}>Agents</h1>
      {params.has("primary-question") && <SessionApprovalRegion session={session} runnerOnline={online}
        fallbackFocusRef={primaryRef} showKeyHints={false} />}
      <button type="button" className="btn" style={{ marginBottom: 12 }} onClick={() => setOnline((value) => !value)}>{online ? "Disconnect Runner" : "Reconnect Runner"}</button>
      <AgentsPanel session={session} items={items} runnerOnline={online}
        onOpenPrimaryRequest={params.has("primary-question") ? (requestId) => focusSessionRequest(session.id, requestId) : undefined}
        runnerProtocolVersion={PROTOCOL_VERSION} requestedId={selected} onSelect={setSelected}
        parentTurnEventIds={new Map()} onOpenParentTurn={() => {}} />
    </main>}
  </StoreProvider></FeedbackProvider></ApiProvider>;
}

function NavigationFixture({ session, onSession, online }: {
  session: SessionView; onSession: (value: SessionView) => void; online: boolean;
}) {
  const view = useStoreSelector((state) => state.view);
  const { navigate } = useStoreActions();
  const [selected, setSelected] = useState<string | null>(null);
  const primaryRef = useRef<HTMLHeadingElement>(null);
  return <main style={{ padding: 16, maxWidth: 900, margin: "0 auto" }}>
    <h1 ref={primaryRef} tabIndex={-1}>Attention Navigation</h1>
    <output aria-label="Current Route" style={{ display: "block", overflowWrap: "anywhere" }}>{viewPath(view)}</output>
    {view.name !== "session" ? <>
      <h2>Inbox</h2>
      <div role="grid" aria-label="Fixture Inbox"><InboxRow session={session} projectName="Fixture"
        optionId="fixture-row" selected={false} unread={false} pinned={false} rowIndex={1}
        stalled={false} activityNow={now} onSelect={() => {}} onExpand={() => {}}
        onSessionMenu={() => {}} onNavigate={navigate} /></div>
      <h2>Board</h2>
      <Board sessions={[session]} searchActive={false} onShowAll={() => {}}
        onNewSession={() => {}} onSessionMenu={() => {}} />
    </> : <>
      <button className="btn" onClick={() => navigate({ name: "inbox" })}>Back to Inbox</button>
      <button className="btn" onClick={() => onSession({ ...session,
        pendingApproval: removePendingRequest(session.pendingApproval, "permission-b") })}>Resolve Linked Request</button>
      <button className="btn" onClick={() => onSession({ ...session, eventEpoch: (session.eventEpoch ?? 0) + 1 })}>Reprocess Session</button>
      <SessionApprovalRegion session={session} runnerOnline={online} fallbackFocusRef={primaryRef} showKeyHints={false} />
      <AgentsPanel key={`${session.id}:${session.eventEpoch ?? 0}`} session={session} items={items}
        runnerOnline={online} runnerProtocolVersion={PROTOCOL_VERSION} requestedId={selected} onSelect={setSelected}
        attentionTarget={view.attention}
        onOpenPrimaryRequest={(requestId) => focusSessionRequest(session.id, requestId)}
        parentTurnEventIds={new Map()} onOpenParentTurn={() => {}} />
    </>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
