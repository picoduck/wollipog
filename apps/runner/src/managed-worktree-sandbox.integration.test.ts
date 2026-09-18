import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { managedWorktreeReadOnlyPaths } from "./managed-worktree-sandbox.js";
import { buildBwrapArgs } from "./spawn.js";

/** Never inherit this process's stdin: a sandboxed child that reads it blocks the whole suite
 * instead of failing, and the timeout below only helps once the child is actually running. */
const RUN = { stdio: ["ignore", "pipe", "pipe"] as const, encoding: "utf8" as const, timeout: 60_000 };

function run(command: string, args: string[], cwd: string): { status: number | null; output: string } {
  const result = spawnSync(command, args, { ...RUN, cwd });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** bubblewrap is packaged everywhere but is not always permitted to run — a host AppArmor profile
 * can deny unprivileged user namespaces outright. Probe the exact capability rather than inferring
 * it from the binary being on PATH, so a denied host skips instead of reporting a false failure. */
function bubblewrapUsable(): boolean {
  if (process.platform !== "linux") return false;
  return run("bwrap", [
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--unshare-pid", "--", "/bin/true",
  ], tmpdir()).status === 0;
}

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

function managedWorktreeFixture(): { root: string; repoPath: string; worktreePath: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "wollipog-managed-worktree-sandbox-"));
  roots.push(root);
  const repoPath = join(root, "repo");
  const worktreePath = join(root, "worktrees", "s_managed");
  const home = join(root, "home");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(home, { recursive: true });
  const git = (args: string[], cwd = repoPath) => {
    const result = run("git", args, cwd);
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.output}`);
  };
  git(["init", "--quiet", "--initial-branch=main", "."]);
  git(["config", "user.email", "runner@example.invalid"]);
  git(["config", "user.name", "Runner"]);
  writeFileSync(join(repoPath, "tracked.txt"), "base\n");
  git(["add", "tracked.txt"]);
  git(["commit", "--quiet", "-m", "base"]);
  git(["worktree", "add", "--quiet", "-b", "agent/s_managed", worktreePath, "main"]);
  return { root, repoPath, worktreePath, home };
}

test("a real bwrap launch refuses provider writes to the managed worktree's Git link", {
  skip: bubblewrapUsable() ? false : "bubblewrap cannot create a user namespace on this host",
}, async () => {
  const { root, repoPath, worktreePath, home } = managedWorktreeFixture();
  const readOnlyPaths = managedWorktreeReadOnlyPaths([{ worktreePath, repoPath }]);
  assert.deepEqual(readOnlyPaths, [join(worktreePath, ".git")]);
  const link = readFileSync(join(worktreePath, ".git"), "utf8");

  const isolation = await resolveExecutionIsolation(
    { mode: "bwrap", network: "inherit" },
    { kind: "native" },
    {},
    {
      driver: "claude-code",
      dataDir: join(root, "state"),
      env: { HOME: home },
      sessionId: "s_managed",
      cwd: worktreePath,
      // The repository holds every worktree's real administrative directory; a session that can
      // commit must have it writable, which is exactly the surface this rule narrows.
      additionalWritableRoots: [repoPath],
      readOnlyPaths,
    },
  );
  assert.equal(isolation?.backend, "bwrap");
  assert.deepEqual(isolation?.backend === "bwrap" ? isolation.readOnlyBinds : undefined, readOnlyPaths);

  const sandboxed = (script: string) => {
    const args = buildBwrapArgs(
      { command: "/bin/sh", args: ["-c", script], cwd: worktreePath },
      isolation as Extract<typeof isolation, { backend: "bwrap" }>,
    );
    return run(isolation!.command, args, worktreePath);
  };

  for (const [label, script] of [
    ["truncating the link", "printf corrupt > .git"],
    ["appending to the link", "printf corrupt >> .git"],
    ["deleting the link", "rm -f .git"],
    ["renaming the link", "mv .git .git.stolen"],
    ["replacing the link via a temp file", "printf corrupt > .git.tmp && mv .git.tmp .git"],
  ] as const) {
    const attempt = sandboxed(script);
    assert.notEqual(attempt.status, 0, `${label} must fail at the filesystem boundary: ${attempt.output}`);
    assert.equal(readFileSync(join(worktreePath, ".git"), "utf8"), link, `${label} must leave the link intact`);
  }

  // Reading it still works, and so does every ordinary provider operation the criteria protect.
  const allowed = sandboxed([
    "cat .git",
    "echo edited > tracked.txt",
    "echo new > added.txt",
    "git add tracked.txt added.txt",
    "git commit --quiet -m sandboxed",
    "git checkout --quiet -b agent/s_managed-next",
    "git status --porcelain",
    "git log --oneline -1",
  ].join(" && "));
  assert.equal(allowed.status, 0, `ordinary worktree work must keep working: ${allowed.output}`);
  assert.match(allowed.output, /gitdir:/);
  assert.match(allowed.output, /sandboxed/);
});

test("an unmanaged worktree keeps a fully writable Git link", {
  skip: bubblewrapUsable() ? false : "bubblewrap cannot create a user namespace on this host",
}, async () => {
  const { root, repoPath, worktreePath, home } = managedWorktreeFixture();
  const isolation = await resolveExecutionIsolation(
    { mode: "bwrap", network: "inherit" },
    { kind: "native" },
    {},
    {
      driver: "claude-code",
      dataDir: join(root, "state"),
      env: { HOME: home },
      sessionId: "s_attached",
      cwd: worktreePath,
      additionalWritableRoots: [repoPath],
      // An attached operator worktree contributes no protections, so the resolver is asked for no
      // read-only rules at all and the sandbox must be byte-for-byte what it is today.
    },
  );
  assert.equal(isolation?.backend, "bwrap");
  assert.equal(isolation?.backend === "bwrap" ? isolation.readOnlyBinds : "absent", undefined);
  const args = buildBwrapArgs(
    { command: "/bin/sh", args: ["-c", "printf rewritten > .git"], cwd: worktreePath },
    isolation as Extract<typeof isolation, { backend: "bwrap" }>,
  );
  // The host root is still read-only bound, so assert on the operand rather than on the flag: no
  // argument anywhere in the launch may name this worktree's link file.
  assert.equal(args.includes(join(worktreePath, ".git")), false, args.join(" "));
  const attempt = run(isolation!.command, args, worktreePath);
  assert.equal(attempt.status, 0, `an unmanaged worktree stays writable: ${attempt.output}`);
  assert.equal(readFileSync(join(worktreePath, ".git"), "utf8"), "rewritten");
});
