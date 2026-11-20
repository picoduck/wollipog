import assert from "node:assert/strict";
import test from "node:test";
import type { PendingApproval, SessionView } from "@wollipog/protocol";
import {
  groupLaunchedWork,
  launchedSessionsToggleLabel,
  launchedWorkGroup,
  launchedWorkIds,
} from "./assistant-launched-work.js";

type Source = Pick<SessionView, "status" | "archived" | "pendingApproval">;

const request: PendingApproval = {
  requestId: "req-1",
  kind: "approval",
  title: "Run pnpm install",
  options: [],
} as unknown as PendingApproval;

const session = (status: SessionView["status"], extra: Partial<Source> = {}): Source =>
  ({ status, archived: false, pendingApproval: null, ...extra }) as Source;

test("a launched session waiting on the owner needs you, whatever its status (#4776)", () => {
  assert.equal(launchedWorkGroup(session("running", { pendingApproval: request })), "needsYou");
  assert.equal(launchedWorkGroup(session("input_required", { pendingApproval: request })), "needsYou");
  // An archived session's leftover request is not waiting on anyone.
  assert.equal(launchedWorkGroup(session("idle", { pendingApproval: request, archived: true })), "finished");
});

test("working sessions are active; idle, ended and archived ones are finished (#4776)", () => {
  for (const status of ["queued", "starting", "running", "input_required"] as const) {
    assert.equal(launchedWorkGroup(session(status)), "active", status);
  }
  for (const status of ["idle", "completed", "failed", "stopped"] as const) {
    assert.equal(launchedWorkGroup(session(status)), "finished", status);
  }
  assert.equal(launchedWorkGroup(session("running", { archived: true })), "finished");
});

test("a session this browser has not loaded yet is active, never tucked among the finished (#4776)", () => {
  assert.equal(launchedWorkGroup(undefined), "active");
});

test("launched ids list sessions then campaigns, once each", () => {
  assert.deepEqual(launchedWorkIds({ sessionIds: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(launchedWorkIds({ sessionIds: ["a", "b"], campaignIds: ["c", "a"] }), ["a", "b", "c"]);
});

test("each group lists the newest launch first (#4776)", () => {
  const groups: Record<string, ReturnType<typeof launchedWorkGroup>> = {
    s1: "finished", s2: "active", s3: "needsYou", s4: "finished", s5: "active",
  };
  assert.deepEqual(groupLaunchedWork(["s1", "s2", "s3", "s4", "s5"], (id) => groups[id]!), {
    needsYou: ["s3"],
    active: ["s5", "s2"],
    finished: ["s4", "s1"],
  });
});

test("the header toggle names the sessions, and those needing you only while there are some (#4776)", () => {
  assert.equal(launchedSessionsToggleLabel({ total: 1, needsYou: 0 }), "1 Session");
  assert.equal(launchedSessionsToggleLabel({ total: 3, needsYou: 0 }), "3 Sessions");
  assert.equal(launchedSessionsToggleLabel({ total: 3, needsYou: 1 }), "3 Sessions · 1 Needs You");
});
