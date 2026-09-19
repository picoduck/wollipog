/**
 * #1336 against a real kernel: the runner's hook state directory is hidden at the sandbox boundary,
 * and the managed-worktree guard still gets its verdict — from the runner, over the session's own
 * socket — because the sidecar inside the sandbox cannot read the list any more than the provider
 * can. Every assertion that something is hidden is paired with a control that shows it is visible
 * in the same sandbox without the mask, so no check can pass because the fixture was out of view.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
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
import { GUARD_STATE_REFUSAL, MANAGED_WORKTREE_REFUSAL } from "./managed-worktree-protection.js";
import { runnerReentryCommand } from "./runner-reentry.js";
import { buildBwrapArgs, type SpawnIsolation } from "./spawn.js";

const RUN = { stdio: ["ignore", "pipe", "pipe"] as const, encoding: "utf8" as const, timeout: 60_000 };

function run(command: string, args: string[], cwd: string, input?: string): { status: number | null; stdout: string; output: string } {
  const result = spawnSync(command, args, {
    ...RUN,
    ...(input !== undefined ? { input, stdio: ["pipe", "pipe", "pipe"] as const } : {}),
    cwd,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function bubblewrapUsable(): boolean {
  if (process.platform !== "linux") return false;
  return run("bwrap", [
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--unshare-pid", "--", "/bin/true",
  ], tmpdir()).status === 0;
}

const SKIP = bubblewrapUsable() ? false : "bubblewrap cannot create a user namespace on this host";
const MARKER = "hook-state-marker-1336";
const GUARD = runnerReentryCommand({
  isSea: false,
  execPath: process.execPath,
  execArgv: process.execArgv,
  scriptPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
}, "--managed-worktree-guard");

const roots: string[] = [];
const sockets: ManagedWorktreeGuardSockets[] = [];
after(async () => {
  for (const host of sockets) await host.closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

interface Fixture {
  root: string;
  dataDir: string;
  configDir: string;
  home: string;
  repoPath: string;
  sessions: Map<string, { worktreePath: string; protectionsFile: string; settings: string; socketPath: string }>;
  host: ManagedWorktreeGuardSockets;
}

/** A runner data directory laid out as the runner lays it out: worktrees and the hook state
 * directory are siblings, so the data directory is a strict ancestor of both. It lives OUTSIDE
 * /tmp, which the sandbox replaces with an empty tmpfs and would hide for the wrong reason. */
async function fixture(sessionIds: string[]): Promise<Fixture> {
  const root = mkdtempSync(join(homedir(), ".wollipog-guard-sandbox-"));
  roots.push(root);
  const dataDir = join(root, "state");
  const configDir = join(dataDir, "hooks", "k");
  const home = join(root, "home");
  const repoPath = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repoPath, { recursive: true });
  const host = new ManagedWorktreeGuardSockets(configDir);
  sockets.push(host);
  const sessions: Fixture["sessions"] = new Map();
  for (const sessionId of sessionIds) {
    const worktreePath = join(dataDir, "worktrees", sessionId);
    mkdirSync(worktreePath, { recursive: true });
    const settings = claudeHookSettingsPath(configDir, sessionId);
    const protectionsFile = claudeHookSessionProtectionsPath(configDir, sessionId);
    writeManagedWorktreeGuardProtections(protectionsFile, [{ worktreePath, repoPath }]);
    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    writeFileSync(claudeHookGuardPath(settings), JSON.stringify({ hooks: {} }));
    // A file the provider must never read, with contents a recursive search would find.
    writeFileSync(claudeHookTokenPath(settings), MARKER);
    const socketPath = await host.ensure(sessionId);
    sessions.set(sessionId, { worktreePath, protectionsFile, settings, socketPath });
  }
  return { root, dataDir, configDir, home, repoPath, sessions, host };
}

async function isolationFor(f: Fixture, sessionId: string, masked = true, exposeSocket = true) {
  const session = f.sessions.get(sessionId)!;
  const isolation = await resolveExecutionIsolation(
    { mode: "bwrap", network: "deny" },
    { kind: "native" },
    {},
    {
      driver: "claude-code",
      dataDir: f.dataDir,
      env: { HOME: f.home },
      sessionId,
      cwd: session.worktreePath,
      ...(masked
        ? {
          guardStateMask: {
            directory: f.configDir,
            readable: [
              session.settings,
              claudeHookGuardPath(session.settings),
              ...(exposeSocket ? [managedWorktreeGuardSocketDirectory(f.configDir, sessionId)] : []),
            ],
            socket: session.socketPath,
          },
        }
        : {}),
    },
  );
  assert.equal(isolation?.backend, "bwrap");
  return isolation as Extract<SpawnIsolation, { backend: "bwrap" }>;
}

function sandboxed(isolation: Extract<SpawnIsolation, { backend: "bwrap" }>, cwd: string, command: string, args: string[], input?: string) {
  return run(isolation.command, buildBwrapArgs({ command, args, cwd }, isolation), cwd, input);
}

/** The guard's verdict comes from a socket served by THIS process, so a guard call must not block
 * the event loop the way a synchronous spawn does. */
function askGuard(
  isolation: Extract<SpawnIsolation, { backend: "bwrap" }>,
  cwd: string,
  args: string[],
  command: string,
): Promise<{ status: number | null; stdout: string; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(isolation.command, buildBwrapArgs({ command: GUARD.command, args: [...GUARD.args, ...args], cwd }, isolation), {
      cwd, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, output: stdout + stderr });
    });
    child.stdin.end(JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd,
      tool_input: { command },
    }));
  });
}

function shell(isolation: Extract<SpawnIsolation, { backend: "bwrap" }>, cwd: string, script: string) {
  return sandboxed(isolation, cwd, "/bin/sh", ["-c", script]);
}

test("an interpreter cannot read the protection list at the OS level, and a nested child cannot either", { skip: SKIP }, async () => {
  const f = await fixture(["s_guarded"]);
  const session = f.sessions.get("s_guarded")!;
  const read = `require("fs").readFileSync(${JSON.stringify(session.protectionsFile)}, "utf8")`;
  const control = sandboxed(await isolationFor(f, "s_guarded", false), session.worktreePath, process.execPath, ["-e", `process.stdout.write(${read})`]);
  assert.equal(control.status, 0, `control: the list is visible without the mask: ${control.output}`);
  assert.match(control.stdout, /worktreePath/u);

  const masked = await isolationFor(f, "s_guarded");
  const direct = sandboxed(masked, session.worktreePath, process.execPath, ["-e", read]);
  assert.notEqual(direct.status, 0, "node cannot open the list");
  assert.match(direct.output, /ENOENT/u);
  if (run("python3", ["--version"], tmpdir()).status === 0) {
    const python = shell(masked, session.worktreePath, `python3 -c ${quote([`print(open(${JSON.stringify(session.protectionsFile)}).read())`])}`);
    assert.notEqual(python.status, 0, `python3 cannot open the list: ${python.output}`);
  }
  // An MCP server is a process the provider spawns; so is anything it spawns in turn. They share the
  // provider's mount namespace, so a grandchild that lists the directory sees only what is exposed.
  const listing = shell(masked, session.worktreePath, `/bin/sh -c ${quote([
    `${quote([process.execPath])} -e ${quote([`console.log(require("fs").readdirSync(${JSON.stringify(f.configDir)}).sort().join(","))`])}`,
  ])}`);
  assert.equal(listing.status, 0, listing.output);
  assert.equal(listing.stdout.trim(), [
    basename(managedWorktreeGuardSocketDirectory(f.configDir, "s_guarded")),
    basename(claudeHookGuardPath(session.settings)),
    basename(session.settings),
  ].sort().join(","));
  assert.doesNotMatch(listing.stdout, /protections|token/u);
  // What the provider must still read at start is still readable.
  const settings = shell(masked, session.worktreePath, `cat ${quote([session.settings])}`);
  assert.equal(settings.status, 0, settings.output);
});

test("recursive walks from a strict ancestor cannot read or enumerate the hook state directory", { skip: SKIP }, async () => {
  const f = await fixture(["s_guarded"]);
  const session = f.sessions.get("s_guarded")!;
  const walks = [
    "find -maxdepth 999",
    `grep -r ${MARKER} .`,
    "du -a",
    ...(run("rg", ["--version"], tmpdir()).status === 0 ? [`rg -uuu ${MARKER} .`, "rg -uuu --files ."] : []),
  ];
  const unmasked = await isolationFor(f, "s_guarded", false);
  const masked = await isolationFor(f, "s_guarded");
  for (const walk of walks) {
    const script = `cd ${quote([f.dataDir])} && ${walk}; true`;
    const control = shell(unmasked, session.worktreePath, script);
    assert.match(control.output, /protections|token|hook-state-marker/u, `control: ${walk} reaches the list without the mask`);
    const attempt = shell(masked, session.worktreePath, script);
    assert.doesNotMatch(attempt.output, /protections\.json|\.token|hook-state-marker/u, `${walk} must not read or enumerate the hook state: ${attempt.output}`);
  }
});

test("writes and git clean -dfx from an ancestor cannot touch the hook state directory", { skip: SKIP }, async () => {
  const f = await fixture(["s_guarded"]);
  const session = f.sessions.get("s_guarded")!;
  const git = (args: string[]) => assert.equal(run("git", args, f.root).status, 0, `git ${args.join(" ")}`);
  git(["init", "--quiet", "."]);
  writeFileSync(join(f.root, ".gitignore"), "state/\n");
  const before = readFileSync(session.protectionsFile, "utf8");
  const masked = await isolationFor(f, "s_guarded");
  for (const script of [
    `cd ${quote([f.root])} && git clean -dfx`,
    `rm -f ${quote([session.protectionsFile])}`,
    `printf tampered > ${quote([session.protectionsFile])}`,
    `rm -rf ${quote([f.configDir])}`,
    `touch ${quote([join(f.configDir, "planted")])}`,
  ]) {
    shell(masked, session.worktreePath, script);
    assert.equal(readFileSync(session.protectionsFile, "utf8"), before, `${script} must leave the list intact`);
    assert.equal(existsSync(join(f.configDir, "planted")), false);
  }
});

test("the guard sidecar gets its verdict from inside the sandbox, and a guard that cannot is a refusal", { skip: SKIP }, async () => {
  const f = await fixture(["s_guarded"]);
  const session = f.sessions.get("s_guarded")!;
  const masked = await isolationFor(f, "s_guarded");
  const probe = { launch: GUARD, protectionsFile: session.protectionsFile, socketPath: session.socketPath };
  assert.deepEqual(await verifyManagedWorktreeGuardInSandbox(probe, masked, session.worktreePath), { ok: true });

  const ask = (command: string, args = ["--protections", session.protectionsFile, "--guard-socket", session.socketPath]) =>
    askGuard(masked, session.worktreePath, args, command);
  const removal = await ask(quote(["git", "worktree", "remove", session.worktreePath]));
  assert.equal(removal.status, 0, removal.output);
  assert.match(removal.stdout, /"permissionDecision":"deny"/u);
  assert.ok(removal.stdout.includes(MANAGED_WORKTREE_REFUSAL));
  const routine = await ask("git status");
  assert.equal(routine.status, 0, routine.output);
  assert.equal(routine.stdout, "", "a routine command gets no opinion");
  // The guard-state veto still runs as defence in depth on top of the boundary.
  const stateRead = await ask(quote(["cat", session.protectionsFile]));
  assert.ok(stateRead.stdout.includes(GUARD_STATE_REFUSAL));

  // A file-mode sidecar inside the mask cannot load the list, and refuses: exactly why a sandboxed
  // launch is never provisioned in file mode.
  const fileMode = await ask("git status", ["--protections", session.protectionsFile]);
  assert.equal(fileMode.status, 2, fileMode.output);

  // A mask that hides the socket fails the in-sandbox probe, which fails the launch.
  const hidden = await isolationFor(f, "s_guarded", true, false);
  const blocked = await verifyManagedWorktreeGuardInSandbox(probe, hidden, session.worktreePath);
  assert.equal(blocked.ok, false);

  // A runner that stops answering is a refusal on every call, never a pass.
  // The server is gone but its directory is still bound into the sandbox, as it is for a provider
  // that outlives its runner's listener.
  await f.host.close("s_guarded");
  mkdirSync(managedWorktreeGuardSocketDirectory(f.configDir, "s_guarded"), { recursive: true, mode: 0o700 });
  const gone = await ask("git status");
  assert.equal(gone.status, 2, gone.output);
  assert.match(gone.output, /could not get a verdict from the runner/u);
});

test("each session's socket judges only its own list, and only its own socket is in view", { skip: SKIP }, async () => {
  const f = await fixture(["s_first", "s_second"]);
  const first = f.sessions.get("s_first")!;
  const second = f.sessions.get("s_second")!;
  const masked = await isolationFor(f, "s_first");
  const ask = (socketPath: string, worktreePath: string) =>
    askGuard(masked, first.worktreePath, ["--protections", first.protectionsFile, "--guard-socket", socketPath],
      quote(["git", "worktree", "remove", worktreePath]));
  assert.ok((await ask(first.socketPath, first.worktreePath)).stdout.includes(MANAGED_WORKTREE_REFUSAL));
  // The first session's list does not name the second session's worktree, so its socket holds no
  // opinion about it: the socket answers for its owner and no one else.
  assert.equal((await ask(first.socketPath, second.worktreePath)).stdout, "");
  // And the second session's socket is not even reachable from the first session's sandbox.
  const foreign = await ask(second.socketPath, second.worktreePath);
  assert.equal(foreign.status, 2, foreign.output);
});
