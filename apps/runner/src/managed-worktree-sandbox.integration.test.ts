import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { managedWorktreeGitWritableRoots, managedWorktreeReadOnlyPaths } from "./managed-worktree-sandbox.js";
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
  const link = readFileSync(join(worktreePath, ".git"), "utf8");
  const adminDir = realpathSync(resolve(worktreePath, link.trim().replace(/^gitdir: /u, "")));
  const registrations = [join(adminDir, "gitdir"), join(adminDir, "commondir")];
  assert.deepEqual(readOnlyPaths, [join(worktreePath, ".git"), ...registrations]);
  const registrationContents = registrations.map((path) => readFileSync(path, "utf8"));

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
  for (const [index, path] of registrations.entries()) {
    for (const [label, script] of [
      ["truncating", `printf corrupt > ${JSON.stringify(path)}`],
      ["deleting", `rm -f ${JSON.stringify(path)}`],
      ["renaming", `mv ${JSON.stringify(path)} ${JSON.stringify(`${path}.stolen`)}`],
      ["replacing", `printf corrupt > ${JSON.stringify(`${path}.tmp`)} && mv ${JSON.stringify(`${path}.tmp`)} ${JSON.stringify(path)}`],
    ] as const) {
      const attempt = sandboxed(script);
      assert.notEqual(attempt.status, 0, `${label} ${path} must fail at the filesystem boundary: ${attempt.output}`);
      assert.equal(readFileSync(path, "utf8"), registrationContents[index]);
      rmSync(`${path}.tmp`, { force: true });
    }
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

test("a real bwrap launch pins a disposable managed worktree root while ordinary Git work succeeds", {
  skip: bubblewrapUsable() ? false : "bubblewrap cannot create a user namespace on this host",
}, async () => {
  const probes = [
    (path: string) => `rmdir -- ${JSON.stringify(path)}`,
    (path: string) => `mv -- ${JSON.stringify(path)} ${JSON.stringify(`${path}.moved`)}`,
    (path: string) => `rm -rf -- ${JSON.stringify(path)}`,
    (path: string) => `cd ${JSON.stringify(dirname(path))} && mv -- ${JSON.stringify(path)} ${JSON.stringify(`${path}.renamed`)}`,
    (path: string) => `python3 -c 'import os,sys; os.rename(sys.argv[1],sys.argv[2])' ${JSON.stringify(path)} ${JSON.stringify(`${path}.python`)}`,
    (path: string) => `find ${JSON.stringify(path)} -maxdepth 0 -exec rm -rf -- {} +`,
  ];
  for (const provider of [
    { driver: "claude-code" as const, directory: ".claude", transcriptDirectory: "projects", credentialFile: ".credentials.json" },
    { driver: "codex-app-server" as const, directory: ".codex", transcriptDirectory: "sessions", credentialFile: "auth.json" },
  ]) for (const probe of probes) {
    const { root, repoPath, worktreePath, home } = managedWorktreeFixture();
    const parent = dirname(worktreePath);
    const requested = join(parent, "s_managed.requested");
    mkdirSync(requested);
    const providerHome = join(home, provider.directory);
    const transcript = join(providerHome, provider.transcriptDirectory, "existing-session.jsonl");
    const credential = join(providerHome, provider.credentialFile);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, "existing provider session\n");
    writeFileSync(credential, "old credential\n");
    const sentinel = join(parent, "fixture-parent-sentinel");
    writeFileSync(sentinel, "keep\n");
    assert.ok(root.startsWith(join(tmpdir(), "wollipog-managed-worktree-sandbox-")));
    assert.equal(realpathSync(worktreePath), worktreePath);
    assert.equal(realpathSync(parent), parent);
    assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
    const link = readFileSync(join(worktreePath, ".git"), "utf8");
    const adminDir = realpathSync(resolve(worktreePath, link.trim().replace(/^gitdir: /u, "")));
    const registrations = [join(adminDir, "gitdir"), join(adminDir, "commondir")];
    const registrationContents = registrations.map((path) => readFileSync(path, "utf8"));
    const isolation = await resolveExecutionIsolation(
      { mode: "bwrap", network: "inherit" }, { kind: "native" }, {}, {
        driver: provider.driver, dataDir: join(root, "state"),
        env: { HOME: home, ...(provider.driver === "codex-app-server" ? { CODEX_HOME: providerHome } : {}) },
        sessionId: "s_managed", cwd: worktreePath,
        additionalWritableRoots: [requested],
        readOnlyPaths: managedWorktreeReadOnlyPaths([{ worktreePath, repoPath }], true),
        protectedWorktree: { path: worktreePath,
          gitWritableRoots: managedWorktreeGitWritableRoots(worktreePath, [{ worktreePath, repoPath }]),
          requiredReadOnlyPaths: managedWorktreeReadOnlyPaths([{ worktreePath, repoPath }], true) },
        preserveProviderHome: true,
      },
    );
    assert.equal(isolation?.backend, "bwrap");
    const sandboxed = (script: string) => run(isolation!.command, buildBwrapArgs(
      { command: "/bin/sh", args: ["-c", script], cwd: worktreePath },
      isolation as Extract<typeof isolation, { backend: "bwrap" }>,
    ), worktreePath);
    for (const relativeCache of [
      ".cache", ".npm", ".cargo/registry", ".cargo/git", ".local/share/pnpm/store", "go/pkg/mod",
    ]) {
      const cache = join(home, relativeCache);
      assert.ok(lstatSync(cache).isDirectory());
      assert.ok(isolation?.backend === "bwrap" && isolation.writableBinds?.some((bind) =>
        bind.source === realpathSync(cache) && bind.target === bind.source));
    }
    assert.equal(isolation?.backend === "bwrap" && isolation.writableBinds?.some((bind) => bind.target === home), false);
    const allowed = sandboxed(`HOME=${JSON.stringify(home)}; export HOME; cat ${JSON.stringify(transcript)} >/dev/null && printf rotated > ${JSON.stringify(`${credential}.tmp`)} && mv ${JSON.stringify(`${credential}.tmp`)} ${JSON.stringify(credential)} && printf edited > tracked.txt && printf new > new.txt && git add tracked.txt new.txt && git -c user.email=runner@example.invalid -c user.name=Runner commit -qm sandboxed && printf 'all:\n\tprintf build > build.txt\n\tmkdir -p $$HOME/.cache/go-build\n\tprintf cached > $$HOME/.cache/go-build/artifact\n' | make -f - && printf redirect > redirect.txt && printf pipeline | cat > pipeline.txt && printf requested > ${JSON.stringify(join(requested, "new.txt"))}`);
    assert.equal(allowed.status, 0, allowed.output);
    assert.equal(readFileSync(join(worktreePath, "build.txt"), "utf8"), "build");
    assert.equal(readFileSync(join(home, ".cache", "go-build", "artifact"), "utf8"), "cached");
    assert.equal(readFileSync(join(requested, "new.txt"), "utf8"), "requested");
    assert.equal(readFileSync(transcript, "utf8"), "existing provider session\n");
    assert.equal(readFileSync(credential, "utf8"), "rotated");
    const attempt = sandboxed(probe(worktreePath));
    assert.notEqual(attempt.status, 0, attempt.output);
    assert.ok(lstatSync(worktreePath).isDirectory(), "the worktree root remains a directory");
    assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
    assert.equal(readFileSync(join(worktreePath, ".git"), "utf8"), link);
    registrations.forEach((path, index) => assert.equal(readFileSync(path, "utf8"), registrationContents[index]));
  }
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

test("a selected requested worktree keeps its root while sibling edits wait for relaunch", {
  skip: bubblewrapUsable() ? false : "bubblewrap cannot create a user namespace on this host",
}, async () => {
  const { root, repoPath, home } = managedWorktreeFixture();
  const boundary = join(root, "worktrees", "s_managed.requested");
  const first = join(boundary, "slot-one");
  const second = join(boundary, "slot-two");
  mkdirSync(boundary);
  const addFirst = run("git", ["worktree", "add", "--quiet", "-b", "agent/requested-one", first, "main"], repoPath);
  assert.equal(addFirst.status, 0, addFirst.output);
  const sentinel = join(root, "requested-parent-sentinel");
  writeFileSync(sentinel, "keep\n");
  assert.ok(root.startsWith(join(tmpdir(), "wollipog-managed-worktree-sandbox-")));
  assert.equal(realpathSync(boundary), boundary);
  assert.equal(realpathSync(first), first);
  assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
  const link = readFileSync(join(first, ".git"), "utf8");
  const adminDir = realpathSync(resolve(first, link.trim().replace(/^gitdir: /u, "")));
  const registrations = [join(adminDir, "gitdir"), join(adminDir, "commondir")];
  const registrationContents = registrations.map((path) => readFileSync(path, "utf8"));
  const isolate = (path: string) => {
    const requiredReadOnlyPaths = managedWorktreeReadOnlyPaths([{ worktreePath: path, repoPath }], true);
    return resolveExecutionIsolation({ mode: "bwrap", network: "inherit" }, { kind: "native" }, {}, {
      driver: "claude-code", dataDir: join(root, "state"), env: { HOME: home },
      sessionId: "s_managed", cwd: path, additionalWritableRoots: [boundary],
      readOnlyPaths: requiredReadOnlyPaths,
      protectedWorktree: {
        path,
        gitWritableRoots: managedWorktreeGitWritableRoots(path, [{ worktreePath: path, repoPath }]),
        requiredReadOnlyPaths,
      },
      preserveProviderHome: true,
    });
  };
  const firstIsolation = await isolate(first);
  assert.equal(firstIsolation?.backend, "bwrap");
  // The provider's mount plan is already fixed when the runner creates the next slot. It cannot
  // acquire a new writable bind until selection and relaunch.
  const addSecond = run("git", ["worktree", "add", "--quiet", "-b", "agent/requested-two", second, "main"], repoPath);
  assert.equal(addSecond.status, 0, addSecond.output);
  const sandboxed = (path: string, isolation: NonNullable<typeof firstIsolation>, script: string) => run(
    isolation.command,
    buildBwrapArgs({ command: "/bin/sh", args: ["-c", script], cwd: path },
      isolation as Extract<typeof firstIsolation, { backend: "bwrap" }>),
    path,
  );
  const blocked = sandboxed(first, firstIsolation!, `printf sibling > ${JSON.stringify(join(second, "new.txt"))}`);
  assert.notEqual(blocked.status, 0, blocked.output);
  assert.match(blocked.output, /Read-only file system/);
  for (const script of [
    `mv -- ${JSON.stringify(first)} ${JSON.stringify(`${first}.moved`)}`,
    `rm -rf -- ${JSON.stringify(first)}`,
  ]) {
    const attempted = sandboxed(first, firstIsolation!, script);
    assert.notEqual(attempted.status, 0, attempted.output);
    assert.ok(lstatSync(first).isDirectory());
    assert.equal(readFileSync(join(first, ".git"), "utf8"), link);
    registrations.forEach((path, index) => assert.equal(readFileSync(path, "utf8"), registrationContents[index]));
    assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
  }
  const secondIsolation = await isolate(second);
  assert.equal(secondIsolation?.backend, "bwrap");
  const writable = sandboxed(second, secondIsolation!, "printf after-relaunch > new.txt && git add new.txt && " +
    "git -c user.email=runner@example.invalid -c user.name=Runner commit -qm after-relaunch");
  assert.equal(writable.status, 0, writable.output);
  assert.equal(readFileSync(join(second, "new.txt"), "utf8"), "after-relaunch");
});

test("an ACP managed launch fails closed when its credential and transcript root is unknown", async () => {
  const { root, repoPath, worktreePath, home } = managedWorktreeFixture();
  const requiredReadOnlyPaths = managedWorktreeReadOnlyPaths([{ worktreePath, repoPath }], true);
  await assert.rejects(resolveExecutionIsolation(
    { mode: "bwrap", network: "inherit" }, { kind: "native" }, {
      platform: "linux", uid: () => 1000,
      resolveNative: async () => ({ path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] } }),
    }, {
      driver: "acp", dataDir: join(root, "state"), env: { HOME: home },
      sessionId: "s_managed", cwd: worktreePath,
      readOnlyPaths: requiredReadOnlyPaths,
      protectedWorktree: {
        path: worktreePath,
        gitWritableRoots: managedWorktreeGitWritableRoots(worktreePath, [{ worktreePath, repoPath }]),
        requiredReadOnlyPaths,
      },
      preserveProviderHome: true,
    },
  ), /provider state cannot be preserved/);
});

test("symlinked worktree paths and uncommon Git layouts fail closed instead of widening mounts", async () => {
  const { root, repoPath, worktreePath, home } = managedWorktreeFixture();
  const sentinel = join(root, "fixture-sentinel");
  writeFileSync(sentinel, "keep\n");
  assert.ok(root.startsWith(join(tmpdir(), "wollipog-managed-worktree-sandbox-")));
  assert.equal(realpathSync(worktreePath), worktreePath);
  assert.equal(readFileSync(sentinel, "utf8"), "keep\n");

  const aliasParent = join(root, "worktrees-alias");
  symlinkSync(dirname(worktreePath), aliasParent);
  const aliasWorktree = join(aliasParent, "s_managed");
  await assert.rejects(resolveExecutionIsolation(
    { mode: "bwrap", network: "inherit" }, { kind: "native" }, {
      platform: "linux", uid: () => 1000,
      resolveNative: async () => ({ path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] } }),
    }, {
      driver: "claude-code", dataDir: join(root, "state"), env: { HOME: home },
      sessionId: "s_managed", cwd: aliasWorktree,
      protectedWorktree: { path: aliasWorktree, gitWritableRoots: [], requiredReadOnlyPaths: [] },
    },
  ), /canonical existing child/);

  const secondWorktree = join(root, "worktrees", "s_second");
  const add = run("git", ["worktree", "add", "--quiet", "-b", "agent/s_second", secondWorktree, "main"], repoPath);
  assert.equal(add.status, 0, add.output);
  assert.deepEqual(managedWorktreeGitWritableRoots(secondWorktree, [{
    worktreePath: secondWorktree, repoPath: worktreePath,
  }]), [], "a linked Project Location cannot supply canonical Git roots");

  const logs = join(repoPath, ".git", "logs");
  assert.ok(realpathSync(logs).startsWith(join(root, "repo", ".git")));
  assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
  rmSync(logs, { recursive: true });
  assert.deepEqual(managedWorktreeGitWritableRoots(worktreePath, [{ worktreePath, repoPath }]), [],
    "missing Git logs must not widen the writable Git mount set");
  assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
});

test("cache roots cannot alias the managed parent, child, or Git administration", async () => {
  for (const targetOf of [
    (worktreePath: string, _adminDir: string) => dirname(worktreePath),
    (worktreePath: string, _adminDir: string) => worktreePath,
    (_worktreePath: string, adminDir: string) => adminDir,
  ]) {
    const { root, repoPath, worktreePath, home } = managedWorktreeFixture();
    const sentinel = join(root, "cache-alias-sentinel");
    writeFileSync(sentinel, "keep\n");
    assert.ok(root.startsWith(join(tmpdir(), "wollipog-managed-worktree-sandbox-")));
    assert.equal(realpathSync(worktreePath), worktreePath);
    assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
    const link = readFileSync(join(worktreePath, ".git"), "utf8");
    const adminDir = realpathSync(resolve(worktreePath, link.trim().replace(/^gitdir: /u, "")));
    const requiredReadOnlyPaths = managedWorktreeReadOnlyPaths([{ worktreePath, repoPath }], true);
    symlinkSync(targetOf(worktreePath, adminDir), join(home, ".cache"));
    await assert.rejects(resolveExecutionIsolation(
      { mode: "bwrap", network: "inherit" }, { kind: "native" }, {
        platform: "linux", uid: () => 1000,
        resolveNative: async () => ({ path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] } }),
      }, {
        driver: "claude-code", dataDir: join(root, "state"), env: { HOME: home },
        sessionId: "s_managed", cwd: worktreePath,
        readOnlyPaths: requiredReadOnlyPaths,
        protectedWorktree: {
          path: worktreePath,
          gitWritableRoots: managedWorktreeGitWritableRoots(worktreePath, [{ worktreePath, repoPath }]),
          requiredReadOnlyPaths,
        },
        preserveProviderHome: true,
      },
    ), /cache directory writable mount overlaps protected worktree roots or Git administration/);
    assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
    assert.equal(readFileSync(join(worktreePath, ".git"), "utf8"), link);
  }
});

test("a provider transcript alias cannot reopen common Git administration or install a host hook", async () => {
  const { root, repoPath, worktreePath, home } = managedWorktreeFixture();
  const providerHome = join(home, ".claude");
  const commonGit = realpathSync(join(repoPath, ".git"));
  const hook = join(commonGit, "hooks", "post-checkout");
  mkdirSync(providerHome);
  symlinkSync(commonGit, join(providerHome, "projects"));
  const requiredReadOnlyPaths = managedWorktreeReadOnlyPaths([{ worktreePath, repoPath }], true);
  await assert.rejects(resolveExecutionIsolation(
    { mode: "bwrap", network: "inherit" }, { kind: "native" }, {}, {
      driver: "claude-code", dataDir: join(root, "state"), env: { HOME: home },
      sessionId: "s_managed", cwd: worktreePath, readOnlyPaths: requiredReadOnlyPaths,
      protectedWorktree: {
        path: worktreePath,
        gitWritableRoots: managedWorktreeGitWritableRoots(worktreePath, [{ worktreePath, repoPath }]),
        requiredReadOnlyPaths,
      },
      preserveProviderHome: true,
    },
  ), /writable.*Git administration/);
  assert.equal(lstatSync(join(providerHome, "projects")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(commonGit, "hooks")).isDirectory(), true);
  assert.equal(existsSync(hook), false);
});

test("a missing worktree config cannot install a hook for a later host Git operation", {
  skip: bubblewrapUsable() ? false : "bubblewrap cannot create a user namespace on this host",
}, async () => {
  const { root, repoPath, worktreePath, home } = managedWorktreeFixture();
  assert.equal(run("git", ["config", "core.repositoryformatversion", "1"], repoPath).status, 0);
  assert.equal(run("git", ["config", "extensions.worktreeConfig", "true"], repoPath).status, 0);
  const link = readFileSync(join(worktreePath, ".git"), "utf8");
  const adminDir = realpathSync(resolve(worktreePath, link.trim().replace(/^gitdir: /u, "")));
  const worktreeConfig = join(adminDir, "config.worktree");
  assert.equal(existsSync(worktreeConfig), false);
  const marker = join(root, "host-hook-marker");
  const hooks = join(worktreePath, "provider-hooks");
  mkdirSync(hooks);
  const hook = join(hooks, "post-checkout");
  writeFileSync(hook, `#!/bin/sh\nprintf escaped > ${JSON.stringify(marker)}\n`);
  chmodSync(hook, 0o755);
  const requiredReadOnlyPaths = managedWorktreeReadOnlyPaths([{ worktreePath, repoPath }], true);
  const isolation = await resolveExecutionIsolation(
    { mode: "bwrap", network: "inherit" }, { kind: "native" }, {}, {
      driver: "claude-code", dataDir: join(root, "state"), env: { HOME: home },
      sessionId: "s_managed", cwd: worktreePath, readOnlyPaths: requiredReadOnlyPaths,
      protectedWorktree: {
        path: worktreePath,
        gitWritableRoots: managedWorktreeGitWritableRoots(worktreePath, [{ worktreePath, repoPath }]),
        requiredReadOnlyPaths,
      },
      preserveProviderHome: true,
    },
  );
  assert.equal(isolation?.backend, "bwrap");
  const script = `printf '[core]\\n\\thooksPath = ${hooks}\\n' > ${JSON.stringify(worktreeConfig)}`;
  const attempted = run(isolation!.command, buildBwrapArgs({ command: "/bin/sh", args: ["-c", script], cwd: worktreePath },
    isolation as Extract<typeof isolation, { backend: "bwrap" }>), worktreePath);
  const hostCheckout = run("git", ["checkout", "--quiet", "-b", "agent/host-checkout"], worktreePath);
  assert.equal(hostCheckout.status, 0, hostCheckout.output);
  assert.equal(existsSync(marker), false, "host Git must not execute a provider-selected hook");
  assert.notEqual(attempted.status, 0, "the provider must not create config.worktree through its Git admin bind");
});

test("a symlinked worktree config fails closed before constructing a writable Git mount", async () => {
  const { root, repoPath, worktreePath, home } = managedWorktreeFixture();
  const link = readFileSync(join(worktreePath, ".git"), "utf8");
  const adminDir = realpathSync(resolve(worktreePath, link.trim().replace(/^gitdir: /u, "")));
  symlinkSync(join(repoPath, ".git", "config"), join(adminDir, "config.worktree"));
  const requiredReadOnlyPaths = managedWorktreeReadOnlyPaths([{ worktreePath, repoPath }], true);
  assert.equal(requiredReadOnlyPaths.includes(join(adminDir, "config.worktree")), false);
  await assert.rejects(resolveExecutionIsolation(
    { mode: "bwrap", network: "inherit" }, { kind: "native" }, {}, {
      driver: "claude-code", dataDir: join(root, "state"), env: { HOME: home },
      sessionId: "s_managed", cwd: worktreePath, readOnlyPaths: requiredReadOnlyPaths,
      protectedWorktree: {
        path: worktreePath,
        gitWritableRoots: managedWorktreeGitWritableRoots(worktreePath, [{ worktreePath, repoPath }]),
        requiredReadOnlyPaths,
      },
      preserveProviderHome: true,
    },
  ), /config cannot be protected/);
});

test("every managed writable mount rejects aliases into Git administration or the selected worktree", async () => {
  for (const role of ["credentials", "cache", "requested", "provider state", "requested child"] as const) {
    const { root, repoPath, worktreePath, home } = managedWorktreeFixture();
    const commonGit = realpathSync(join(repoPath, ".git"));
    const providerHome = join(home, ".claude");
    const requested = join(root, "worktrees", "s_managed.requested");
    const dataDir = join(root, "state-alias");
    if (role === "credentials") symlinkSync(commonGit, providerHome);
    if (role === "cache") symlinkSync(commonGit, join(home, ".cache"));
    if (role === "requested" || role === "requested child") {
      symlinkSync(role === "requested" ? commonGit : worktreePath, requested);
    }
    if (role === "provider state") symlinkSync(commonGit, dataDir);
    const requiredReadOnlyPaths = managedWorktreeReadOnlyPaths([{ worktreePath, repoPath }], true);
    await assert.rejects(resolveExecutionIsolation(
      { mode: "bwrap", network: "inherit" }, { kind: "native" }, {}, {
        driver: "claude-code", dataDir, env: { HOME: home },
        sessionId: "s_managed", cwd: worktreePath, readOnlyPaths: requiredReadOnlyPaths,
        additionalWritableRoots: role.startsWith("requested") ? [requested] : [],
        protectedWorktree: {
          path: worktreePath,
          gitWritableRoots: managedWorktreeGitWritableRoots(worktreePath, [{ worktreePath, repoPath }]),
          requiredReadOnlyPaths,
        },
        preserveProviderHome: role !== "provider state",
      },
    ), /writable mount overlaps protected worktree roots or Git administration/, role);
    assert.equal(existsSync(join(commonGit, "hooks", "post-checkout")), false, role);
    assert.equal(existsSync(join(commonGit, "provider-state")), false, role);
    assert.ok(lstatSync(worktreePath).isDirectory(), role);
  }
});

test("a cache symlink to a separate disk remains writable without widening Git access", async () => {
  const { root, repoPath, worktreePath, home } = managedWorktreeFixture();
  const externalCache = join(root, "external-cache");
  mkdirSync(externalCache);
  symlinkSync(externalCache, join(home, ".cache"));
  const requiredReadOnlyPaths = managedWorktreeReadOnlyPaths([{ worktreePath, repoPath }], true);
  const isolation = await resolveExecutionIsolation(
    { mode: "bwrap", network: "inherit" }, { kind: "native" }, {}, {
      driver: "claude-code", dataDir: join(root, "state"), env: { HOME: home },
      sessionId: "s_managed", cwd: worktreePath, readOnlyPaths: requiredReadOnlyPaths,
      protectedWorktree: {
        path: worktreePath,
        gitWritableRoots: managedWorktreeGitWritableRoots(worktreePath, [{ worktreePath, repoPath }]),
        requiredReadOnlyPaths,
      },
      preserveProviderHome: true,
    },
  );
  assert.equal(isolation?.backend, "bwrap");
  assert.ok(isolation?.backend === "bwrap" && isolation.writableBinds?.some((bind) =>
    bind.source === externalCache && bind.target === externalCache));
  assert.equal(isolation?.backend === "bwrap" && isolation.writableBinds?.some((bind) =>
    bind.target === realpathSync(join(repoPath, ".git"))), false);
});
