/**
 * A Codex TUI passes no `-s` and runs under Codex's implicit `:workspace` default whatever the
 * session's structured-driver mode is. The #1336 profile must therefore always be `:workspace`
 * there: selecting `:read-only` for a read-only session would silently take away write access the
 * TUI has always had (review finding CR-1.5).
 *
 * That implicit default is also approval-capable, so a TUI now carries no profile at all: a deny
 * entry would leave an approved escalation without network access (#1464). What this file asserts
 * is that the TUI's argv is unchanged by the hook state directory, and that the decision is still
 * consulted for a Codex TUI and never for another provider's.
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

test("a Codex TUI is asked about the profile as an implicit launch, and carries none", async () => {
  // The implicit kind is what pins the TUI to `:workspace` rather than the session's mode, and
  // it is also what the escalation gate withholds. Both facts are asserted here, so a future
  // re-enable keeps the first one. Neither base's override reaches the argv.
  const args = await tuiArgs(meta({ config: { permissionMode: "read-only" } }), HOOK_DIR);
  assert.ok(args.includes("mode:implicit"), "the TUI is decided as an implicit launch");
  for (const base of [":workspace", ":read-only"] as const) {
    assert.ok(!args.includes(codexPermissionProfileOverrides(base, HOOK_DIR)[0]), base);
  }
  assert.ok(!args.some((arg) => arg.startsWith("default_permissions=")));
});

test("a Codex TUI's argv is unchanged by the hook state directory", async () => {
  const withDir = await tuiArgs(meta({ config: { permissionMode: "read-only" } }), HOOK_DIR);
  const withoutDir = await tuiArgs(meta({ config: { permissionMode: "read-only" } }));
  assert.deepEqual(withDir, withoutDir);
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
