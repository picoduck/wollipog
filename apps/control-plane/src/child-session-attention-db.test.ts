import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDb, type NewSessionInput } from "./db.js";

test("session views compactly join current requests to exact structured child owners", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({ runnerId: "runner", hostname: "host", os: "linux", version: "test",
    agents: [], workspaces: [] }, 1);
  db.createSession({ id: "session", runnerId: "runner", workspaceId: null, agentId: null,
    title: "Session", useWorktree: false, driver: "claude-code", config: {}, now: 1 } satisfies NewSessionInput);
  db.appendEvent("session", { kind: "tool_call", toolCallId: "owner", title: "Task", toolKind: "agent",
    status: "running", subagentName: "Audit Child", subagentRole: "reviewer" }, 2);
  db.setPendingApproval("session", { requestId: "known", ownerToolUseId: "owner", title: "Allow?", options: [],
    additionalRequests: [{ requestId: "unknown", ownerToolUseId: "missing", title: "Allow?", options: [] }] });

  assert.deepEqual(db.getSession("session")?.attentionOwners, [
    { requestId: "known", toolCallId: "owner", resolved: true, name: "Audit Child", role: "reviewer" },
    { requestId: "unknown", toolCallId: "missing", resolved: false },
  ]);
  const plan = db.raw().prepare(
    `EXPLAIN QUERY PLAN SELECT payload FROM session_events
     WHERE session_id=? AND kind='tool_call' AND json_extract(payload,'$.toolCallId')=?
     ORDER BY seq LIMIT 2`,
  ).all("session", "owner") as unknown as Array<{ detail: string }>;
  assert.ok(plan.some((row) => /idx_session_events_tool_call_id/.test(row.detail)));
  db.close();
});

test("duplicate spawning ids fail closed in compact owner joins", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({ runnerId: "runner", hostname: "host", os: "linux", version: "test",
    agents: [], workspaces: [] }, 1);
  db.createSession({ id: "session", runnerId: "runner", workspaceId: null, agentId: null,
    title: "Session", useWorktree: false, driver: "claude-code", config: {}, now: 1 } satisfies NewSessionInput);
  for (const ts of [2, 3]) db.appendEvent("session", { kind: "tool_call", toolCallId: "duplicate",
    title: "Task", toolKind: "agent", status: "running", subagentName: "Unsafe" }, ts);
  db.setPendingApproval("session", { requestId: "ask", ownerToolUseId: "duplicate", title: "Allow?", options: [] });
  assert.deepEqual(db.getSession("session")?.attentionOwners,
    [{ requestId: "ask", toolCallId: "duplicate", resolved: false }]);
  db.close();
});
