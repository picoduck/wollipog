import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION, DEFAULT_ORCHESTRATOR_DEFAULTS } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub, MAX_UI_BUFFERED_BYTES, serializeUiSnapshot, type Socket } from "./hub.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal, type AgentPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { withSessionCommandPermissions } from "./session-command-permissions.js";

export const sessionListPrincipal: HumanPrincipal = {
  kind: "human", actorId: LOCAL_OWNER_USER_ID, userId: LOCAL_OWNER_USER_ID, userName: "Synthetic Owner",
  organizationId: PERSONAL_ORGANIZATION_ID, organizationName: "Synthetic", role: "owner",
  deviceId: null, localBootstrap: true,
};

export function seedSessionList(db: ControlPlaneDb, count: number): void {
  db.registerRunner({ runnerId: "r", hostname: "synthetic", os: "linux", version: "test", workspaces: [], agents: [] },1,PROTOCOL_VERSION);
  for (let index=0; index<count; index++) db.createSession({
      id: `s-${index}`, runnerId: "r", workspaceId: null, agentId: null, title: `Synthetic Session ${index}`,
      useWorktree: false, driver: "codex-app-server", config: {}, now: index+1,
  });
}

test("summary SQL count stays constant and heavy fields remain on detail", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db,2000);
    db.raw().prepare("UPDATE sessions SET agent_capabilities=?, worktrees=? WHERE id='s-0'")
      .run(JSON.stringify({ slashCommands: [{ name: "large",description: "x".repeat(1_000_000) }] }),"[]");
    const source = db as unknown as { stmt(sql: string): unknown };
    const original = source.stmt.bind(db);
    let queries=0;
    source.stmt = (sql) => { queries++; return original(sql); };
    const summaries = db.listSessionSummaries(sessionListPrincipal);
    assert.equal(queries,7);
    assert.equal(summaries.length,2000);
    const row = summaries.find((session) => session.id === "s-0")!;
    assert.equal(row.projection,"summary");
    assert.equal(row.agentCapabilities,undefined);
    assert.equal(row.worktrees,undefined);
    assert.ok(JSON.stringify(row).length < 4000);
    assert.equal(db.getSession("s-0")!.agentCapabilities?.slashCommands?.[0]?.description?.length,1_000_000);
  } finally { db.close(); }
});

test("summary snapshots retain live hold and turn state while detail retains heavy queued prompts", async () => {
  const db=ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db,1);
    const hub=new Hub(db);
    const runner={ send() {} };
    hub.attachRunner("r",runner);
    hub.setSessionQueue("s-0",[{ id: "queued",text: "x".repeat(1_000_000) }],true,"turn-1");
    const read=async () => {
      const frames: string[]=[];
      let complete=false;
      hub.addUiClient({ send(data) { frames.push(data); if (JSON.parse(data).complete) complete=true; } },{
        principal: sessionListPrincipal,deviceId: null,uiProtocolVersion: PROTOCOL_VERSION,close() { assert.fail("closed"); },
      });
      while (!complete) await new Promise<void>((resolve) => setImmediate(resolve));
      return frames.flatMap((frame) => JSON.parse(frame).sessions)[0];
    };
    const summary=await read();
    assert.equal(summary.activeTurnId,"turn-1");
    assert.equal(summary.queueHeld,true);
    assert.equal(summary.queued,undefined,"prompt bodies remain detail-only");
    const detail=hub.withQueue(db.getSession("s-0")!);
    assert.equal(detail.activeTurnId,"turn-1");
    assert.equal(detail.queueHeld,true);
    assert.equal(detail.queued![0]!.text.length,1_000_000);
    hub.detachRunner("r",runner);
    const offline=await read();
    assert.equal(offline.queueHeld,false,"runner detach invalidates the cached live overlay");
    assert.equal(offline.activeTurnId,undefined);
  } finally { db.close(); }
});

test("team membership changes invalidate cached REST JSON, including other SQLite connections", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-summary-access-"));
  const path = join(directory, "sessions.db");
  const db = ControlPlaneDb.open(path);
  const external = new DatabaseSync(path);
  try {
    seedSessionList(db, 1);
    db.createIdentityTeam({ teamId: "team", organizationId: PERSONAL_ORGANIZATION_ID,
      name: "Synthetic Team", memberUserIds: [LOCAL_OWNER_USER_ID], now: 1 });
    db.raw().prepare("UPDATE session_ownership SET owner_kind='team',owner_id='team' WHERE session_id='s-0'").run();
    const member = { ...sessionListPrincipal, role: "operator" as const };
    assert.equal(JSON.parse(db.sessionListJsonForPrincipal(member)).sessions.length, 1);
    external.prepare("DELETE FROM identity_team_members WHERE team_id='team'").run();
    assert.equal(JSON.parse(db.sessionListJsonForPrincipal(member)).sessions.length, 0);
    db.updateIdentityTeamMembers({ teamId: "team", organizationId: PERSONAL_ORGANIZATION_ID,
      memberUserIds: [LOCAL_OWNER_USER_ID], now: 2 });
    assert.equal(JSON.parse(db.sessionListJsonForPrincipal(member)).sessions.length, 1);
    assert.equal(JSON.parse(db.sessionListJsonForPrincipal({ ...member, userId: "outsider" })).sessions.length, 0);
  } finally { external.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("access loss between snapshot pages closes the stream before sending private rows", async () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db, 2);
    const frames: string[] = [];
    let next: (() => void) | undefined;
    let closed: number | undefined;
    const hub = new Hub(db);
    hub.addUiClient({ asyncDelivery: true, send(data, done) { frames.push(data); next = done; } }, {
      principal: { ...sessionListPrincipal, role: "operator" }, deviceId: null,
      uiProtocolVersion: PROTOCOL_VERSION, close(code) { closed = code; },
    });
    while (!frames.length && closed === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(JSON.parse(frames[0]!).type, "snapshot");
    db.raw().prepare("UPDATE session_ownership SET owner_id='outsider' WHERE session_id='s-0'").run();
    next?.();
    assert.equal(closed, 1012);
    assert.equal(frames.length, 1, "no captured authorized page is sent after access loss");
  } finally { db.close(); }
});

test("ordinary session writes between snapshot pages do not interrupt a reconnect", async () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db,2);
    const frames: string[] = [];
    let next: (() => void) | undefined;
    const hub = new Hub(db);
    hub.addUiClient({ asyncDelivery: true,send(data,done) { frames.push(data); next=done; } }, {
      principal: sessionListPrincipal,deviceId: null,uiProtocolVersion: PROTOCOL_VERSION,
      close() { assert.fail("ordinary writes must not close a still-authorized inventory"); },
    });
    while (!frames.length) await new Promise<void>((resolve) => setImmediate(resolve));
    db.createSession({ id: "new",runnerId: "r",workspaceId: null,agentId: null,title: "New",
      useWorktree: false,driver: "codex-app-server",config: {},now: 3 });
    db.setSessionArchived("s-0",true,4);
    next?.();
    assert.equal(JSON.parse(frames.at(-1)!).complete,true);
    assert.equal(frames.flatMap((frame) => JSON.parse(frame).sessions).length,2);
  } finally { db.close(); }
});

test("live rows queued during snapshot preparation retain visibility for later removals", async () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db,2000);
    const frames: string[] = [];
    const hub = new Hub(db);
    let complete=false;
    hub.addUiClient({ send(data) { frames.push(data); if (JSON.parse(data).complete) complete=true; } }, {
      principal: sessionListPrincipal,deviceId: null,uiProtocolVersion: PROTOCOL_VERSION,
      close() { assert.fail("closed"); },
    });
    db.createSession({ id: "new",runnerId: "r",workspaceId: null,agentId: null,title: "New",
      useWorktree: false,driver: "codex-app-server",config: {},now: 3000 });
    hub.sessionChanged(db.getSession("new")!,false);
    while (!complete) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(frames.some((frame) => { const msg=JSON.parse(frame); return msg.type === "session_upsert" && msg.session.id === "new"; }));
    hub.sessionRemoved("new",false);
    assert.ok(frames.some((frame) => { const msg=JSON.parse(frame); return msg.type === "session_removed" && msg.sessionId === "new"; }));
  } finally { db.close(); }
});

test("reminder inventories use one authorized read and preserve archived and team boundaries", async () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db,2000);
    for (let index=0;index<2000;index++) db.setSessionReminder({ sessionId: `s-${index}`,userId: LOCAL_OWNER_USER_ID,
      scheduledFor: 10000,timeZone: "UTC",originalExpression: "Synthetic",wakePolicy: "regardless",now: 1 });
    db.createIdentityTeam({ teamId: "team",organizationId: PERSONAL_ORGANIZATION_ID,name: "Team",
      memberUserIds: [LOCAL_OWNER_USER_ID],now: 1 });
    db.raw().prepare("UPDATE session_ownership SET owner_kind='team',owner_id='team' WHERE session_id='s-0'").run();
    db.raw().prepare("UPDATE session_ownership SET owner_id='outsider' WHERE session_id='s-1'").run();
    db.setSessionArchived("s-0",true,2);
    const member = { ...sessionListPrincipal,role: "operator" as const };
    const source = db as unknown as { stmt(sql: string): unknown };
    const original = source.stmt.bind(db);
    let queries=0;
    source.stmt = (sql) => { queries++; return original(sql); };
    const reminders = db.listSessionRemindersForPrincipal(LOCAL_OWNER_USER_ID,member);
    assert.equal(queries,1);
    assert.equal(reminders.length,1999);
    assert.ok(reminders.some((reminder) => reminder.sessionId === "s-0"),"archiving does not discard a reminder");
    assert.ok(!reminders.some((reminder) => reminder.sessionId === "s-1"));
    db.canAccessSession = () => { assert.fail("connect must not check each reminder"); };
    let complete=false;
    new Hub(db).addUiClient({ send(data) { if (JSON.parse(data).complete) complete=true; } }, {
      principal: member,deviceId: null,uiProtocolVersion: PROTOCOL_VERSION,close() { assert.fail("closed"); },
    });
    while (!complete) await new Promise<void>((resolve) => setImmediate(resolve));
    db.updateIdentityTeamMembers({ teamId: "team",organizationId: PERSONAL_ORGANIZATION_ID,memberUserIds: [],now: 3 });
    assert.equal(db.listSessionRemindersForPrincipal(LOCAL_OWNER_USER_ID,member).length,1998);
  } finally { db.close(); }
});

test("summary holds retain owed decision resumes and live capacity matches detail", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db,3);
    db.raw().prepare("UPDATE sessions SET parent_session_id='s-0' WHERE id IN ('s-1','s-2')").run();
    db.raw().prepare("UPDATE sessions SET status='completed' WHERE id='s-2'").run();
    db.raw().prepare("UPDATE sessions SET queue_hold=? WHERE id='s-0'").run(JSON.stringify({
      kind: "provider_account_switch",holdId: "hold",since: 10,target: "Synthetic",queuedPrompts: 2,
      unfinishedBackgroundJobs: 1,
    }));
    db.raw().prepare(`INSERT INTO workflow_decisions(request_id,occurrence_id,session_id,controlling_session_id,
      category,resource_key,resource_snapshot,resource_digest,policy_revision,authority,status,created_at,
      resolved_at,resume_state,resume_updated_at)
      VALUES ('request','occurrence','s-0','s-0','implementation_question','key','{}','digest',1,'human','approved',1,2,'held',3)`).run();
    const summary = db.listSessionsForPrincipal(sessionListPrincipal).find((row) => row.id === "s-0")!;
    const detail = withSessionCommandPermissions(db,sessionListPrincipal,db.getSession("s-0")!);
    assert.deepEqual(summary.holds,detail.holds);
    assert.deepEqual(summary.liveChildCapacity,detail.liveChildCapacity);
    assert.equal(summary.holds?.[0]?.heldResumes?.[0]?.occurrenceId,"occurrence");
  } finally { db.close(); }
});

test("summary worktrees retain one active branch and PR identity without setup or other inventories", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db,1);
    db.raw().prepare("UPDATE sessions SET use_worktree=1,worktree_path='/active',worktrees=? WHERE id='s-0'").run(JSON.stringify([
      { id: "other",path: "/other",branch: "other",source: "created" },
      { id: "active",path: "/active",branch: "feature",source: "created",baseRef: "release",defaultBranch: "main",
        pullRequest: { url: "https://github.com/example/synthetic/pull/1",state: "merged" },
        setup: { status: "completed",output: "x".repeat(1_000_000) } },
    ]));
    const summary=db.listSessionSummaries(sessionListPrincipal)[0]!;
    assert.deepEqual(summary.worktrees,[{ id: "active",path: "/active",branch: "feature",source: "created",
      baseRef: "release",defaultBranch: "main",pullRequest: { url: "https://github.com/example/synthetic/pull/1",state: "merged" } }]);
    assert.equal(db.getSession("s-0")!.worktrees?.length,2);
    assert.ok(JSON.stringify(summary).length<4000);
  } finally { db.close(); }
});

test("summary child owners preserve ambiguous and duplicate request identity", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db, 1);
    for (const [now, parentToolUseId] of [[2, "parent-a"], [3, "parent-b"]] as const) {
      db.appendEvent("s-0", { kind: "tool_call", toolCallId: "duplicate", parentToolUseId,
        title: "Task", toolKind: "agent", status: "running", subagentName: "Unsafe" }, now);
    }
    db.setPendingApproval("s-0", { requestId: "first", ownerToolUseId: "duplicate", title: "Allow?", options: [],
      additionalRequests: [{ requestId: "second", ownerToolUseId: "duplicate", title: "Allow?", options: [] }] });
    assert.deepEqual(db.listSessionSummaries(sessionListPrincipal)[0]!.attentionOwners,
      db.getSession("s-0")!.attentionOwners);
  } finally { db.close(); }
});

test("background summary recovery and observation metadata match the detail's actionable deliveries", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db, 1);
    db.updateSessionFromSnapshot("s-0", { ...db.getSession("s-0")!, config: {}, seq: 0,
      backgroundWorkState: "running", backgroundJobs: [
        { id: "shell", parentTurnId: "turn", runnerId: "r", workspaceId: null, launchType: "shell",
          registeredAt: 100, terminalStatus: "completed", terminalObservedAt: 110, continuationRequired: true },
        { id: "monitor", parentTurnId: "turn", runnerId: "r", workspaceId: null, launchType: "monitor", registeredAt: 100 },
      ] }, 200);
    const summary = db.listSessionSummaries(sessionListPrincipal)[0]!;
    const detail = db.getSession("s-0")!;
    assert.deepEqual(summary.backgroundDeliveries, detail.backgroundDeliveries);
    assert.deepEqual(summary.attention?.humanActions, detail.attention?.humanActions);
    const legacyFrames: string[] = [];
    new Hub(db).addUiClient({ send(data) { legacyFrames.push(data); } }, {
      principal: sessionListPrincipal, deviceId: null, uiProtocolVersion: PROTOCOL_VERSION - 1, close() { assert.fail("legacy closed"); },
    });
    assert.equal(legacyFrames.length, 1);
    assert.equal(JSON.parse(legacyFrames[0]!).sessions[0].projection, undefined);
  } finally { db.close(); }
});

test("summary audiences, ownership verdicts, result acknowledgments and delegated requests match detail", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db,3);
    db.raw().prepare("INSERT INTO session_role_conversions(session_id,conversion_id,command,state,created_at) VALUES ('s-1','conversion',?,'preparing',1)")
      .run(JSON.stringify({ targetRole: "orchestrator" }));
    assert.deepEqual(db.listSessionSummaries(sessionListPrincipal).find((session) => session.id === "s-1")!.roleConversion,
      { targetRole: "orchestrator", phase: "preparing" });
    db.raw().prepare("UPDATE session_ownership SET owner_kind='user',owner_id='other' WHERE session_id='s-2'").run();
    const member = { ...sessionListPrincipal,role: "operator" as const };
    assert.deepEqual(db.listSessionsForPrincipal(member).map((s) => s.id),["s-1","s-0"]);
    for (const row of db.listSessionsForPrincipal(sessionListPrincipal)) {
      assert.deepEqual(row.commandPermissions,withSessionCommandPermissions(db,sessionListPrincipal,db.getSession(row.id)!).commandPermissions);
    }
    db.appendEvent("s-0",{ kind: "agent_message", text: "Result",final: true },10);
    db.appendEvent("s-0",{ kind: "agent_response_completed" },11);
    const revision = db.getSession("s-0")!.attention!.result!.revision;
    db.acknowledgeSessionResult("s-0",LOCAL_OWNER_USER_ID,revision,12);
    assert.deepEqual(db.listSessionsForPrincipal(member).find((s) => s.id === "s-0")!.attention,
      db.sessionAttentionForUser(db.getSession("s-0")!,LOCAL_OWNER_USER_ID).attention);
    db.createSession({ id: "parent", runnerId: "r", workspaceId: null, agentId: null,title: "Parent",useWorktree: false,
      driver: "codex-app-server",config: {},now: 13,role: "orchestrator",
      orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS,"system_default") });
    db.raw().prepare("UPDATE sessions SET parent_session_id='parent' WHERE id='s-0'").run();
    db.raw().prepare("UPDATE sessions SET parent_control='questions_and_approvals' WHERE id='parent'").run();
    db.setPendingApproval("s-0",{ requestId: "q",kind: "question", title: "Question",options: [],
      questions: [{ id: "q",question: "Which implementation?",options: [] }] });
    const summary = db.listSessionsForPrincipal(member).find((s) => s.id === "s-0")!;
    assert.deepEqual(summary.pendingRequestOwners,db.getSession("s-0")!.pendingRequestOwners);
    assert.equal(summary.pendingApproval?.requestId,"q");
    assert.equal(summary.pendingApproval?.questions,undefined);
    assert.equal(summary.attention?.result?.owner,"orchestrator");
    db.raw().prepare("UPDATE sessions SET parent_session_id='parent' WHERE id IN ('s-1','s-2')").run();
    db.setPendingApproval("s-2",{ requestId: "private",kind: "authentication",title: "Private sign-in",options: [] });
    db.raw().prepare(`INSERT INTO workflow_decisions(request_id,occurrence_id,session_id,controlling_session_id,
      category,resource_key,resource_snapshot,resource_digest,policy_revision,authority,status,created_at)
      VALUES ('gate','gate-occurrence','s-1','parent','implementation_question','key','{}','digest',1,'human','pending',14)`).run();
    const memberRequests=db.listSessionSummaries(member).find((row) => row.id === "parent")!.campaignRequests!;
    assert.deepEqual({ human: memberRequests.human,orchestrator: memberRequests.orchestrator },
      { human: 1,orchestrator: 1 },"campaign counts exclude private children but retain authorized typed/provider requests");
    const ownerRequests=db.listSessionSummaries(sessionListPrincipal).find((row) => row.id === "parent")!.campaignRequests!;
    assert.deepEqual({ human: ownerRequests.human,orchestrator: ownerRequests.orchestrator },
      { human: 2,orchestrator: 1 });
    assert.equal(memberRequests.humanRequestTokens!.length,1);
    assert.equal(ownerRequests.humanRequestTokens!.length,2);
    db.raw().prepare("UPDATE workflow_decisions SET occurrence_id='replacement' WHERE request_id='gate'").run();
    const replacement=db.listSessionSummaries(member).find((row) => row.id === "parent")!.campaignRequests!;
    assert.equal(replacement.human,memberRequests.human);
    assert.notDeepEqual(replacement.humanRequestTokens,memberRequests.humanRequestTokens);
    const agent: AgentPrincipal = { kind: "agent",actorId: "agent",organizationId: PERSONAL_ORGANIZATION_ID,
      credentialSessionId: "parent",orchestrator: true,delegatedScope: {
        organizationId: PERSONAL_ORGANIZATION_ID,owner: { kind: "user",userId: LOCAL_OWNER_USER_ID } } };
    for (const row of db.listSessionsForPrincipal(agent)) assert.deepEqual(row.commandPermissions,
      withSessionCommandPermissions(db,agent,db.getSession(row.id)!).commandPermissions);
    assert.equal(db.listSessionsForPrincipal({ ...agent,organizationId: "other-org" }).length,0);
  } finally { db.close(); }
});

test("dashboard frames are byte bounded, share a principal snapshot, and invalidate after writes", async () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedSessionList(db,2000);
    const hub = new Hub(db);
    let reads=0;
    const original = db.listSessionSummaries.bind(db);
    const originalAsync = db.listSessionSummariesAsync.bind(db);
    db.listSessionSummariesAsync = (...args) => { reads++; return originalAsync(...args); };
    const callbacks: Array<() => void> = [];
    const frames: string[][] = [];
    for (let index=0; index<4; index++) {
      frames.push([]);
      const socket: Socket = { asyncDelivery: true,send(data,done) { frames[index]!.push(data); if (done) callbacks.push(() => done()); } };
      assert.equal(hub.addUiClient(socket,{ principal: sessionListPrincipal,deviceId: null,uiProtocolVersion: PROTOCOL_VERSION,close: () => assert.fail("unexpected close") }),true);
    }
    while (!frames[0]!.length) await new Promise<void>((resolve) => setImmediate(resolve));
    while (callbacks.length) callbacks.shift()!();
    assert.equal(reads,1);
    for (const sent of frames) {
      assert.deepEqual(sent,frames[0]);
      assert.ok(sent.every((frame) => Buffer.byteLength(frame)<=MAX_UI_BUFFERED_BYTES));
      assert.equal(sent.flatMap((frame) => JSON.parse(frame).sessions ?? []).length,2000);
    }
    db.raw().prepare("UPDATE sessions SET title='Updated' WHERE id='s-0'").run();
    hub.addUiClient({ send() {} },{ principal: sessionListPrincipal,deviceId: null,uiProtocolVersion: PROTOCOL_VERSION,close() {} });
    assert.equal(reads,2);
    const huge = { type: "snapshot" as const,runners: [],boxes: [],sessions: [{ ...original()[0]!,title: "x".repeat(MAX_UI_BUFFERED_BYTES) }],runs: [] };
    assert.equal(serializeUiSnapshot(huge,true),null);
    assert.equal(serializeUiSnapshot(huge,false),null);
    db.raw().prepare("UPDATE sessions SET title=? WHERE id='s-0'").run("x".repeat(MAX_UI_BUFFERED_BYTES));
    for (const version of [PROTOCOL_VERSION-1,PROTOCOL_VERSION]) {
      let closed: number | undefined;
      new Hub(db).addUiClient({ send() { assert.fail("oversized inventory sent a frame"); } }, {
        principal: sessionListPrincipal,deviceId: null,uiProtocolVersion: version,close(code) { closed=code; },
      });
      while (closed === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closed,1009);
    }
  } finally { db.close(); }
});
