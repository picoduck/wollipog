/**
 * #1336 on macOS: the Seatbelt half of the hook state mask, against the real `sandbox-exec`.
 *
 * These rules cannot be exercised on the Linux machines this change was written on, so this test is
 * their only verification and the Platform Isolation macOS job refuses to let it skip. It mirrors
 * the bubblewrap test: every "hidden" assertion has a control showing the same thing visible without
 * the mask, and the guard sidecar must still get its verdict over the socket with the network denied.
 * Unlike bwrap, Seatbelt leaves the data directory WRITABLE, so the write denial is load-bearing here.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { quote } from "shell-quote";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import {
  claudeHookGuardPath,
  claudeHookSessionProtectionsPath,
  claudeHookSettingsPath,
  claudeHookTokenPath,
} from "./hook-settings.js";
import {
  ManagedWorktreeGuardSockets,
  managedWorktreeGuardSocketDirectory,
  verifyManagedWorktreeGuardInSandbox,
} from "./managed-worktree-guard-socket.js";
import { writeManagedWorktreeGuardProtections } from "./managed-worktree-guard.js";
import { MANAGED_WORKTREE_REFUSAL } from "./managed-worktree-protection.js";
import { runnerReentryCommand } from "./runner-reentry.js";
import type { SpawnIsolation } from "./spawn.js";

type Seatbelt = Extract<SpawnIsolation, { backend: "seatbelt" }>;

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60_000, cwd });
  return { status: result.status, stdout: String(result.stdout ?? ""), output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function seatbeltUsable(): boolean {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return false;
  return run("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], "/").status === 0;
}

const SKIP = seatbeltUsable() ? false : "Seatbelt (sandbox-exec) is only available on macOS";
const MARKER = "hook-state-marker-1336";
const GUARD = runnerReentryCommand({
  isSea: false,
  execPath: process.execPath,
  execArgv: process.execArgv,
  scriptPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
}, "--managed-worktree-guard");

const roots: string[] = [];
const hosts: ManagedWorktreeGuardSockets[] = [];
after(async () => {
  for (const host of hosts) await host.closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function fixture() {
  // `/tmp` rather than the long per-user TMPDIR, so the socket fits in `sun_path`; it is also a
  // symlink to /private/tmp, which exercises the profile's second spelling of every path.
  const root = mkdtempSync("/tmp/wgs-");
  roots.push(root);
  const dataDir = join(root, "state");
  const configDir = join(dataDir, "hooks", "k");
  const worktreePath = join(dataDir, "worktrees", "s_mac");
  mkdirSync(worktreePath, { recursive: true });
  const settings = claudeHookSettingsPath(configDir, "s_mac");
  const protectionsFile = claudeHookSessionProtectionsPath(configDir, "s_mac");
  writeManagedWorktreeGuardProtections(protectionsFile, [{ worktreePath, repoPath: join(root, "repo") }]);
  writeFileSync(settings, JSON.stringify({ hooks: {} }));
  writeFileSync(claudeHookGuardPath(settings), JSON.stringify({ hooks: {} }));
  writeFileSync(claudeHookTokenPath(settings), MARKER);
  const host = new ManagedWorktreeGuardSockets(configDir);
  hosts.push(host);
  const socketPath = await host.ensure("s_mac");
  return { root, dataDir, configDir, worktreePath, settings, protectionsFile, socketPath, host };
}

async function isolationFor(f: Awaited<ReturnType<typeof fixture>>, masked: boolean): Promise<Seatbelt> {
  const isolation = await resolveExecutionIsolation({ mode: "seatbelt", network: "deny" }, { kind: "native" }, {}, {
    driver: "claude-code",
    dataDir: f.dataDir,
    env: {},
    sessionId: "s_mac",
    cwd: f.worktreePath,
    ...(masked
      ? {
        guardStateMask: {
          directory: f.configDir,
          readable: [f.settings, claudeHookGuardPath(f.settings), managedWorktreeGuardSocketDirectory(f.configDir, "s_mac")],
          socket: f.socketPath,
        },
      }
      : {}),
  });
  assert.equal(isolation?.backend, "seatbelt");
  return isolation as Seatbelt;
}

function shell(isolation: Seatbelt, cwd: string, script: string) {
  return run(isolation.command, [...isolation.args, "-p", isolation.profile, "/bin/sh", "-c", script], cwd);
}

function askGuard(isolation: Seatbelt, cwd: string, socketPath: string, protectionsFile: string, command: string) {
  return new Promise<{ status: number | null; stdout: string; output: string }>((resolvePromise, reject) => {
    const child = spawn(isolation.command, [
      ...isolation.args, "-p", isolation.profile, GUARD.command, ...GUARD.args,
      "--protections", protectionsFile, "--guard-socket", socketPath,
    ], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); resolvePromise({ status, stdout, output: stdout + stderr }); });
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } }));
  });
}

test("Seatbelt hides the hook state directory from reads, walks, and writes", { skip: SKIP }, async () => {
  const f = await fixture();
  const unmasked = await isolationFor(f, false);
  const masked = await isolationFor(f, true);
  const read = `${quote([process.execPath])} -e ${quote([`process.stdout.write(require("fs").readFileSync(${JSON.stringify(f.protectionsFile)}, "utf8"))`])}`;
  assert.equal(shell(unmasked, f.worktreePath, read).status, 0, "control: readable without the mask");
  assert.notEqual(shell(masked, f.worktreePath, read).status, 0, "an interpreter cannot read the list");

  for (const walk of ["find . -maxdepth 999", `grep -r ${MARKER} .`, "du -a"]) {
    const script = `cd ${quote([f.dataDir])} && ${walk}; true`;
    assert.match(shell(unmasked, f.worktreePath, script).output, /protections|token|hook-state-marker/u, `control: ${walk}`);
    assert.doesNotMatch(shell(masked, f.worktreePath, script).output, /protections\.json|\.token|hook-state-marker/u, walk);
  }

  const before = readFileSync(f.protectionsFile, "utf8");
  shell(masked, f.worktreePath, `printf tampered > ${quote([f.protectionsFile])}; rm -f ${quote([f.protectionsFile])}`);
  assert.equal(readFileSync(f.protectionsFile, "utf8"), before, "the writable data root does not reach the hidden directory");
  assert.equal(shell(masked, f.worktreePath, `cat ${quote([f.settings])}`).status, 0, "the settings document stays readable");
});

test("the guard sidecar gets its verdict through Seatbelt with the network denied", { skip: SKIP }, async () => {
  const f = await fixture();
  const masked = await isolationFor(f, true);
  assert.deepEqual(await verifyManagedWorktreeGuardInSandbox(
    { launch: GUARD, protectionsFile: f.protectionsFile, socketPath: f.socketPath }, masked, f.worktreePath,
  ), { ok: true });
  const removal = await askGuard(masked, f.worktreePath, f.socketPath, f.protectionsFile, quote(["git", "worktree", "remove", f.worktreePath]));
  assert.equal(removal.status, 0, removal.output);
  assert.ok(removal.stdout.includes(MANAGED_WORKTREE_REFUSAL));
  await f.host.close("s_mac");
  const gone = await askGuard(masked, f.worktreePath, f.socketPath, f.protectionsFile, "git status");
  assert.equal(gone.status, 2, gone.output);
});
