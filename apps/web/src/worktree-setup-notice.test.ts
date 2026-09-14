import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION, type RunnerView, type SessionView } from "@wollipog/protocol";
import { worktreeSetupNoticeSessionIds } from "./worktree-setup-notice.js";

const runner = (protocolVersion: number | null): RunnerView => ({
  runnerId: "r", hostname: "test", os: "linux", version: "test", status: "online",
  agents: [], workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion,
});

const session = (id: string, createdAt: number, status: "absent" | "valid" | "invalid" | "unknown" = "absent",
  source: "created" | "legacy" = "created"): SessionView => ({
  id, runnerId: "r", agentId: "a", agentName: "Agent", driver: "codex-app-server", workspaceId: "w",
  projectId: "p", status: "idle", title: id, createdAt, updatedAt: createdAt, archived: false,
  preview: null, pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0, seq: 0,
  worktreePath: `/repo/${id}`, worktrees: [{ id, path: `/repo/${id}`, branch: id, source,
    ...(status === "unknown" ? {} : status === "absent" ? { setupConfig: { status } }
      : status === "valid" ? { setupConfig: { status, hash: "a".repeat(64) } }
      : { setupConfig: { status, error: ".wollipog.json.setup[0].command is invalid" } }) }],
});

test("only the authoritative absent first worktree session is eligible", () => {
  const runners = new Map([["r", runner(PROTOCOL_VERSION)]]);
  assert.deepEqual([...worktreeSetupNoticeSessionIds([session("second", 2), session("first", 1)], runners, new Set())], ["first"]);
  assert.deepEqual([...worktreeSetupNoticeSessionIds([session("first", 1, "absent", "legacy")], runners, new Set())], ["first"]);
  assert.equal(worktreeSetupNoticeSessionIds([session("first", 1, "valid"), session("second", 2)], runners, new Set()).size, 0);
  assert.equal(worktreeSetupNoticeSessionIds([session("first", 1, "invalid"), session("second", 2)], runners, new Set()).size, 0);
  assert.equal(worktreeSetupNoticeSessionIds([session("first", 1, "unknown"), session("second", 2)], runners, new Set()).size, 0);
});

test("older peers and per-user dismissal fail closed", () => {
  assert.equal(worktreeSetupNoticeSessionIds([session("first", 1)], new Map([["r", runner(141)]]), new Set()).size, 0);
  assert.equal(worktreeSetupNoticeSessionIds([session("first", 1)], new Map([["r", runner(PROTOCOL_VERSION)]]), new Set(["p"])).size, 0);
});
