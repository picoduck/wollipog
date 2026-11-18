import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunView, SessionView } from "@wollipog/protocol";
import { runStatus } from "./run-status.js";

const run = (id: string, sessionIds: string[] = [], createdAt = 10): RunView => ({
  id, title: id, prompt: "", workspaceId: null, workspaceName: null, createdAt, updatedAt: createdAt, sessionIds,
});

const member = (id: string, over: Partial<SessionView> = {}): SessionView =>
  ({ id, status: "idle", pendingApproval: null, agentName: "Claude Code", driver: "claude-code", ...over }) as SessionView;

const sessions = (...members: SessionView[]) => new Map(members.map((session) => [session.id, session]));

test("a member waiting on an answer is Approval Required", () => {
  const asking = member("a", { status: "input_required" });
  assert.equal(runStatus(run("r", ["a", "b"]), sessions(asking, member("b", { status: "running" }))), "approval_required");
});

test("a comparison with one running member is Running; an idle finished one has no badge", () => {
  assert.equal(runStatus(run("r", ["a", "b"]), sessions(member("a"), member("b", { status: "running" }))), "running");
  assert.equal(runStatus(run("r", ["a", "b"]), sessions(member("a"), member("b", { status: "starting" }))), "running");
  assert.equal(runStatus(run("r", ["a", "b"]), sessions(member("a"), member("b", { status: "completed" }))), null);
  // A member the store does not hold is skipped, not guessed.
  assert.equal(runStatus(run("r", ["gone"]), sessions()), null);
});
