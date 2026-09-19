import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_SPAWN_OBSERVATION_CAP } from "@wollipog/protocol";
import { ControlPlaneDb, type NewSessionInput } from "./db.js";

test("session views compactly join current requests to exact structured child owners", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({ runnerId: "runner", hostname: "host", os: "linux", version: "test",
    agents: [], workspaces: [] }, 1);
  db.createSession({ id: "session", runnerId: "runner", workspaceId: null, agentId: null,
    title: "Session", useWorktree: false, driver: "claude-code", config: {}, now: 1 } satisfies NewSessionInput);
  db.appendEvent("session", { kind: "tool_call", toolCallId: "owner", title: "Task", toolKind: "agent",
    status: "pending" }, 2);
  db.appendEvent("session", { kind: "tool_call", toolCallId: "owner", title: "Task", toolKind: "agent",
    status: "in_progress", subagentRole: "reviewer" }, 3);
  db.setPendingApproval("session", { requestId: "known", ownerToolUseId: "owner", title: "Allow?", options: [],
    additionalRequests: [{ requestId: "unknown", ownerToolUseId: "missing", title: "Allow?", options: [] }] });

  assert.deepEqual(db.getSession("session")?.attentionOwners, [
    { requestId: "known", toolCallId: "owner", resolved: true, name: "Subagent", role: "reviewer" },
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
  for (const [ts, parentToolUseId] of [[2, "parent-a"], [3, "parent-b"]] as const) {
    db.appendEvent("session", { kind: "tool_call", toolCallId: "duplicate", parentToolUseId,
      title: "Task", toolKind: "agent", status: "running", subagentName: "Unsafe" }, ts);
  }
  db.setPendingApproval("session", { requestId: "ask", ownerToolUseId: "duplicate", title: "Allow?", options: [] });
  assert.deepEqual(db.getSession("session")?.attentionOwners,
    [{ requestId: "ask", toolCallId: "duplicate", resolved: false }]);
  db.close();
});

test("the owner join reads as far as the shared spawn-observation cap, so it cannot resolve an id the registry calls ambiguous", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({ runnerId: "runner", hostname: "host", os: "linux", version: "test",
    agents: [], workspaces: [] }, 1);
  db.createSession({ id: "session", runnerId: "runner", workspaceId: null, agentId: null,
    title: "Session", useWorktree: false, driver: "claude-code", config: {}, now: 1 } satisfies NewSessionInput);

  // A legitimate partial/full pair, then one reused-id statement that reaches the cap. The query
  // must read far enough to see that last one: a LIMIT below the cap would return only the clean
  // pair and report this owner resolved, while the registry projection calls it ambiguous.
  db.appendEvent("session", { kind: "tool_call", toolCallId: "owner", title: "Task", toolKind: "agent",
    status: "pending" }, 2);
  db.appendEvent("session", { kind: "tool_call", toolCallId: "owner", title: "Task", toolKind: "agent",
    status: "in_progress", subagentRole: "reviewer" }, 3);
  for (let extra = 0; extra < AGENT_SPAWN_OBSERVATION_CAP - 2; extra += 1) {
    db.appendEvent("session", { kind: "tool_call", toolCallId: "owner", title: "Task", toolKind: "agent",
      status: "in_progress", subagentName: "Reused" }, 4 + extra);
  }
  db.setPendingApproval("session", { requestId: "ask", ownerToolUseId: "owner", title: "Allow?", options: [] });

  assert.deepEqual(db.getSession("session")?.attentionOwners,
    [{ requestId: "ask", toolCallId: "owner", resolved: false }],
    "reaching the cap loses the identity in the owner join exactly as it does in the registry");
  db.close();
});
