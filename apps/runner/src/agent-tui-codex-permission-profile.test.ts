/**
 * A Codex TUI passes no `-s` and runs under Codex's implicit `:workspace` default whatever the
 * session's structured-driver mode is. The #1336 profile must therefore always be `:workspace`
 * there: selecting `:read-only` for a read-only session would silently take away write access the
 * TUI has always had (review finding CR-1.5).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionMeta } from "./session-store.js";
import { prepareAgentTuiLaunch } from "./agent-tui.js";
import {
  codexPermissionProfileOverrides,
  decideCodexPermissionProfile,
} from "./codex-permission-profile.js";

const HOOK_DIR = "/data/hooks/abc123";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "codex-session", agentId: "agent", workspaceId: "workspace",
    repoPath: "/repo", worktreePath: null, driver: "codex", command: "codex", args: [],
    env: {}, context: { kind: "native" }, agentSessionId: "thread-1", status: "idle",
    title: "Test", config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null,
    pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

async function tuiArgs(source: SessionMeta, hookStateDir?: string): Promise<string[]> {
  const seen: string[] = [];
  const launch = await prepareAgentTuiLaunch(source, {
    controlPlaneProtocolVersion: 58,
    provision: () => assert.fail("ordinary TUI must not reprovision"),
    prepareScratch: async () => assert.fail("ordinary TUI must not prepare scratch"),
    assertSessionNotDeleted: () => {},
    provisionManagedWorktreeGuard: (spec) => ({ protections: [], args: spec.args, guardActive: false }),
    hookStateDir,
    // The CLI proof is stubbed; the mode mapping and argv handling are real.
    permissionProfile: (launch) => {
      seen.push(launch.legacy.kind);
      return decideCodexPermissionProfile({ ...launch, platform: "linux" }, async () => ({ ok: true }));
    },
  });
  assert.ok(launch);
  return [...launch.args, ...seen.map((mode) => `mode:${mode}`)];
}

test("a read-only session's Codex TUI keeps its implicit :workspace sandbox and gains only the deny", async () => {
  const args = await tuiArgs(meta({ config: { permissionMode: "read-only" } }), HOOK_DIR);
  assert.ok(args.includes(codexPermissionProfileOverrides(":workspace", HOOK_DIR)[0]));
  assert.ok(!args.includes(codexPermissionProfileOverrides(":read-only", HOOK_DIR)[0]));
});

test("a Codex TUI with no hook state directory launches exactly as before", async () => {
  const args = await tuiArgs(meta());
  assert.ok(!args.some((arg) => arg.startsWith("default_permissions=")));
});

test("a TUI that is not a Codex one is untouched", async () => {
  const args = await tuiArgs(meta({ driver: "claude-code", command: "claude" }), HOOK_DIR);
  assert.ok(!args.some((arg) => arg.startsWith("default_permissions=")));
  assert.ok(!args.some((arg) => arg.startsWith("mode:")), "the profile decision is not even consulted");
});
