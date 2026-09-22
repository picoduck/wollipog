/**
 * The #1336 slice 2 contract at each Codex launch path: a migrated mode sends the permission
 * profile and NO legacy sandbox policy, an unmigrated one is byte-for-byte what it is today, and
 * the two never travel together (Codex silently ignores the profile when they do).
 *
 * No mode migrates on codex-cli 0.155.1, because a deny entry costs a launch every
 * APPROVED network escalation. The launch-path tests below therefore assert the byte-for-byte
 * legacy argv for every mode, and the turn-params tests keep exercising the migrated shape with an
 * explicitly supplied base — that code stays live for a build whose escalation survives a deny.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CodexDriver } from "./codex.js";
import { buildCodexTurnParams } from "./codex-app-server.js";
import {
  codexPermissionProfileOverrides,
  decideCodexPermissionProfile,
  type CodexPermissionProfileBase,
} from "../codex-permission-profile.js";
import type { AgentProcess } from "../spawn.js";

const HOOK_DIR = "/data/hooks/abc123";

function fakeAgentProcess(): AgentProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1234,
  }) as unknown as AgentProcess;
}

const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Capture the argv one `codex exec` turn would launch with. */
async function execArgs(
  permissionMode: string | undefined,
  extra: { hookStateDir?: string; args?: string[]; resumeThread?: string } = {},
): Promise<string[]> {
  const child = fakeAgentProcess();
  let captured: string[] = [];
  const driver = new CodexDriver({
    command: "codex", args: extra.args ?? [], cwd: "/repo", env: {},
    config: permissionMode ? { permissionMode } : {}, context: { kind: "native" },
    hookStateDir: extra.hookStateDir,
  }, { onEvent() {}, onStderr() {}, onExit() {} }, {
    spawn(spec: { args: string[] }) { captured = spec.args; return child; },
    kill() {},
    // The Orchestrator preset probes for MCP isolation arguments before spawning; stub it so the
    // preset reaches the spawn like every other mode.
    orchestratorMcpArgs: () => Promise.resolve([]),
    // The CLI proof is stubbed to "proven": these tests are about the argv, and the proof itself
    // is covered in codex-permission-profile.test.ts. Everything else about the decision — the
    // mode mapping, the defeating flags, the missing directory — is the real implementation.
    permissionProfile: (launch: Parameters<typeof decideCodexPermissionProfile>[0]) =>
      decideCodexPermissionProfile({ ...launch, platform: "linux" }, async () => ({ ok: true })),
  } as never);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (extra.resumeThread) (driver as any).threadId = extra.resumeThread;
    const turn = driver.prompt("hello");
    for (let i = 0; i < 5 && captured.length === 0; i++) await nextTask();
    child.stdout.emit("data", JSON.stringify({ type: "turn.completed" }) + "\n");
    child.emit("close", 0);
    await turn;
  } finally { driver.dispose(); }
  return captured;
}

/* ------------------------------------------------------------------------------------------
 * Native `codex exec`.
 * --------------------------------------------------------------------------------------- */

test("with no runner hook state directory, every Codex exec launch is exactly what it is today", async () => {
  const args = await execArgs("workspace-write");
  assert.ok(args.includes("-s"), "the legacy sandbox mode is still sent");
  assert.ok(!args.some((a) => a.startsWith("default_permissions=")), "and no profile is selected");
});

test("an unmigrated mode keeps its legacy sandbox mode even with a hook state directory", async () => {
  for (const mode of ["danger-full-access", "orchestrator"]) {
    const args = await execArgs(mode, { hookStateDir: HOOK_DIR });
    assert.ok(args.includes("-s"), `${mode} still sends -s`);
    assert.ok(
      !args.some((a) => a.startsWith("default_permissions=")),
      `${mode} selects no profile`,
    );
  }
});

test("an approval-capable mode keeps its legacy sandbox mode, hook state directory or not", async () => {
  // Every mode that could migrate routes to an approval-capable policy, so every one of them
  // would lose an approved escalation's network under a deny entry (#1464). All stay on `-s`, and
  // their argv is byte-for-byte the argv they had with no hook state directory at all.
  for (const mode of ["auto-review", "on-request", "untrusted", "on-failure", "workspace-write", "read-only"]) {
    const args = await execArgs(mode, { hookStateDir: HOOK_DIR });
    assert.deepEqual(args, await execArgs(mode), `${mode} launches exactly as it did`);
    assert.ok(args.includes("-s"), `${mode} still sends -s`);
    assert.ok(!args.some((a) => a.startsWith("default_permissions=")), `${mode} selects no profile`);
    assert.ok(!args.some((a) => a.startsWith("permissions.")), `${mode} defines no profile either`);
  }
});

test("a resumed turn is byte-for-byte what it was before the profile existed", async () => {
  // Review finding CR-2.3: a resumed non-Orchestrator `codex exec` has never passed `-s`, so it ran
  // under Codex's own approval-capable default — which is withheld like every other one.
  const withDir = await execArgs("read-only", { hookStateDir: HOOK_DIR, resumeThread: "thread-1" });
  assert.deepEqual(withDir, await execArgs("read-only", { resumeThread: "thread-1" }));
  assert.ok(withDir.includes("resume"));
});

test("a resumed Orchestrator turn still pins its explicit legacy mode", async () => {
  const args = await execArgs("orchestrator", { hookStateDir: HOOK_DIR, resumeThread: "thread-1" });
  assert.ok(args.includes("-s"));
  assert.ok(!args.some((a) => a.startsWith("default_permissions=")));
});

test("a launch that already carries -s is left on its legacy policy, not silently stripped", async () => {
  const args = await execArgs("workspace-write", { hookStateDir: HOOK_DIR, args: ["-s", "read-only"] });
  assert.ok(args.includes("-s"));
  assert.ok(!args.some((a) => a.startsWith("default_permissions=")));
});

/* ------------------------------------------------------------------------------------------
 * The app-server turn params, and the projection equality the migration rests on.
 * --------------------------------------------------------------------------------------- */

const MIGRATED: Array<[string, CodexPermissionProfileBase, string]> = [
  ["auto-review", ":workspace", "workspaceWrite"],
  ["on-request", ":workspace", "workspaceWrite"],
  ["untrusted", ":workspace", "workspaceWrite"],
  ["on-failure", ":workspace", "workspaceWrite"],
  ["workspace-write", ":workspace", "workspaceWrite"],
  ["read-only", ":read-only", "readOnly"],
];

test("a migrated mode's params are today's params MINUS the sandbox policy, and nothing else", () => {
  for (const [mode, base, sandboxType] of MIGRATED) {
    const legacy = buildCodexTurnParams({ permissionMode: mode }, "t1", "/repo", [], undefined, []);
    const profiled = buildCodexTurnParams({ permissionMode: mode }, "t1", "/repo", [], undefined, [], base);
    // The policy that is dropped is exactly the built-in's projection, measured from thread/start.
    assert.deepEqual(legacy.sandboxPolicy, { type: sandboxType }, mode);
    const { sandboxPolicy, ...withoutPolicy } = legacy;
    assert.deepEqual(profiled, withoutPolicy, `${mode}: only the sandbox policy changes`);
    assert.equal(profiled.sandboxPolicy, undefined, mode);
  }
});

test("a turn whose mode the running profile does not express keeps its legacy policy", () => {
  // The base is bound when the app-server starts; a mid-session switch to the other base, or to an
  // unmigrated mode, must NOT ride on a profile that expresses something different.
  const readOnlyTurn = buildCodexTurnParams({ permissionMode: "read-only" }, "t1", "/repo", [], undefined, [], ":workspace");
  assert.deepEqual(readOnlyTurn.sandboxPolicy, { type: "readOnly" });

  const workspaceTurn = buildCodexTurnParams({ permissionMode: "auto-review" }, "t1", "/repo", [], undefined, [], ":read-only");
  assert.deepEqual(workspaceTurn.sandboxPolicy, { type: "workspaceWrite" });

  const fullAccess = buildCodexTurnParams({ permissionMode: "danger-full-access" }, "t1", "/repo", [], undefined, [], ":workspace");
  assert.deepEqual(fullAccess.sandboxPolicy, { type: "dangerFullAccess" });
});

test("the Orchestrator preset keeps its own policy, profile or not", () => {
  const params = buildCodexTurnParams({ permissionMode: "orchestrator" }, "t1", "/repo", [], undefined, [], ":workspace");
  assert.deepEqual(params.sandboxPolicy, {
    type: "workspaceWrite", writableRoots: ["/repo"], networkAccess: true,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true,
  });
});

test("a managed-worktree Git grant keeps the explicit policy instead of losing roots to a profile", (t) => {
  // The running profile expresses only the plain built-in workspace. A linked-worktree turn needs
  // a non-default writable root, so sending no policy would recreate #1569 even though Full Access
  // is correctly narrowed to on-request first.
  const root = mkdtempSync(join(tmpdir(), "wollipog-codex-profile-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoPath = join(root, "primary");
  const worktreePath = join(root, "worktree");
  const commonGitDir = join(repoPath, ".git");
  const worktreeGitDir = join(commonGitDir, "worktrees", "worktree");
  const gitRoots = [worktreeGitDir, ...["objects", "refs", "logs"].map((name) => join(commonGitDir, name))];
  for (const path of [worktreePath, ...gitRoots]) mkdirSync(path, { recursive: true });
  writeFileSync(join(worktreePath, ".git"), `gitdir: ${worktreeGitDir}\n`);
  const params = buildCodexTurnParams(
    { permissionMode: "danger-full-access" }, "t1", worktreePath, [], undefined,
    [{ worktreePath, repoPath }], ":workspace",
  );
  assert.deepEqual(params.sandboxPolicy, {
    type: "workspaceWrite", writableRoots: [worktreePath, ...gitRoots],
  });
  assert.equal(params.approvalPolicy, "on-request");
});

test("the profile override text is stable for both bases", () => {
  assert.equal(
    codexPermissionProfileOverrides(":read-only", HOOK_DIR)[0],
    `permissions.wollipog-runner-guard={extends=":read-only",filesystem={"${HOOK_DIR}"="deny"}}`,
  );
});
