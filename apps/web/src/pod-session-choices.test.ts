import assert from "node:assert/strict";
import test from "node:test";
import type { BoxView, PodView, RunnerView, SessionView } from "@wollipog/protocol";
import { newPodBlockedReason, podEligibleSessions, podMachineNames, podSessionChoices, podSessionMatches } from "./pod-session-choices.js";

const runner = (runnerId: string, hostname: string, displayName?: string) =>
  ({ runnerId, hostname, ...(displayName ? { displayName } : {}) }) as RunnerView;

test("a Machine is named by its own name, its SSH host or its hostname, never by its runner id", () => {
  const names = podMachineNames([
    runner("runner-a", "studio.local", "Studio Mac"),
    runner("runner-b", "build-box"),
    runner("runner-c", "", undefined),
    runner("runner-d", "laptop"),
  ], (runnerId) => runnerId === "runner-d" ? { sshTarget: "dev@devbox.example:22", displayName: undefined } as unknown as BoxView : undefined);
  assert.deepEqual([...names], [
    ["runner-a", "Studio Mac"],
    ["runner-b", "build-box"],
    // Nothing to call it: it is left out, not named by its id.
    ["runner-d", "devbox.example"],
  ]);
});

test("two Machines that read alike add their hostname, and keep one name when that cannot tell them apart", () => {
  assert.deepEqual([...podMachineNames([
    runner("runner-a", "studio-1", "Studio"),
    runner("runner-b", "studio-2", "studio"),
    runner("runner-c", "same", "Lab"),
    runner("runner-d", "same", "Lab"),
  ])], [
    ["runner-a", "Studio · studio-1"],
    ["runner-b", "studio · studio-2"],
    ["runner-c", "Lab · same"],
    ["runner-d", "Lab · same"],
  ]);
});

function session(id: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id, runnerId: "runner-a", workspaceId: null, workspaceName: null, projectId: null, agentId: "claude",
    agentName: "Claude Code", driver: "claude-code", title: `Session ${id}`, status: "idle", useWorktree: true,
    worktreePath: `/w/${id}`, updatedAt: 1, ...overrides,
  } as SessionView;
}

const pod = (status: PodView["status"], sessionIds: string[]) =>
  ({ status, members: sessionIds.map((sessionId) => ({ sessionId })) }) as PodView;

test("a session can join with its own worktree, before it ends, outside every active pod, newest first", () => {
  const eligible = podEligibleSessions([
    session("old", { updatedAt: 1 }),
    session("new", { updatedAt: 3 }),
    session("chat", { useWorktree: false }),
    session("failed", { status: "failed" }),
    session("member", { updatedAt: 2 }),
    session("former", { updatedAt: 2 }),
  ], [pod("active", ["member"]), pod("closed", ["former"])]);
  assert.deepEqual(eligible.map((candidate) => candidate.id), ["new", "former", "old"]);
});

test("a row names its project from Projects, or a legacy workspace, and leaves out what it cannot name", () => {
  const choices = podSessionChoices([
    session("a", { projectId: "p1" }),
    session("b", { projectId: "p-missing", runnerId: "runner-gone" }),
    session("c", { workspaceId: "ws-1", workspaceName: "Docs Site", worktreePath: undefined, title: "  " }),
  ], {
    runners: new Map([["runner-a", runner("runner-a", "studio.local", "Studio Mac")]]),
    projects: new Map([["p1", { id: "p1", name: "Wollipog" } as never]]),
  });
  assert.deepEqual(choices.map(({ title, description, worktreeStarting }) => [title, description, worktreeStarting]), [
    ["Session a", "Claude Code · Wollipog · Studio Mac", false],
    ["Session b", "Claude Code", false],
    ["Untitled Session", "Claude Code · Docs Site · Studio Mac", true],
  ]);
});

test("Filter Sessions matches every word in the title or the agent, ignoring case", () => {
  const choice = { title: "Migrate the call sites", agent: "OpenCode" };
  assert.equal(podSessionMatches(choice, ""), true);
  assert.equal(podSessionMatches(choice, "  "), true);
  assert.equal(podSessionMatches(choice, "MIGRATE"), true);
  assert.equal(podSessionMatches(choice, "opencode call"), true);
  assert.equal(podSessionMatches(choice, "migrate codex"), false);
  assert.equal(podSessionMatches(choice, "Studio"), false, "not the project or the machine");
});

test("Create Pod waits for two to twelve sessions, then a name", () => {
  assert.equal(newPodBlockedReason("", 0), "Choose at least 2 sessions.");
  assert.equal(newPodBlockedReason("Pod", 1), "Choose at least 2 sessions.");
  assert.equal(newPodBlockedReason(" ", 2), "Enter a name.");
  assert.equal(newPodBlockedReason("Pod", 2), null);
  assert.equal(newPodBlockedReason("Pod", 12), null);
  assert.equal(newPodBlockedReason("", 13), "Choose at most 12 sessions.", "as the control plane refuses");
});
