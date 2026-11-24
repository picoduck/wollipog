import assert from "node:assert/strict";
import { test } from "node:test";
import { managedWorktreeUnsupportedReason, type ManagedWorktreeAgentInput } from "./managed-worktree-agents.js";

const codexAcp: ManagedWorktreeAgentInput = {
  os: "linux", isolationMode: "provider", driver: "acp", agentId: "codex", agentName: "Codex", contextKind: "native",
};

test("a generic ACP agent cannot use a managed worktree on a Linux provider-isolation runner (#4901)", () => {
  assert.equal(managedWorktreeUnsupportedReason(codexAcp),
    "Codex can't run in a managed worktree on this machine: its sandbox would make the agent's own settings and " +
    "conversations read-only. Start the session In Place instead.");
  assert.match(managedWorktreeUnsupportedReason({ ...codexAcp, agentName: undefined, targetAdapter: "host" }) ?? "",
    /^This agent can't run/u, "without a display name the sentence still reads as one");
});

test("every launch whose state the runner can preserve, or that is not sandboxed this way, is allowed", () => {
  for (const allowed of [
    { ...codexAcp, agentId: "google-antigravity" },
    { ...codexAcp, driver: "claude-code" },
    { ...codexAcp, driver: "codex-app-server" },
    { ...codexAcp, driver: "pi" },
    { ...codexAcp, isolationMode: "bwrap" as const },
    { ...codexAcp, isolationMode: undefined },
    { ...codexAcp, os: "macos" as const },
    { ...codexAcp, os: undefined },
    { ...codexAcp, contextKind: "wsl" },
    { ...codexAcp, targetAdapter: "container" },
    { ...codexAcp, targetAdapter: "cloud" },
  ]) {
    assert.equal(managedWorktreeUnsupportedReason(allowed), null, JSON.stringify(allowed));
  }
});
