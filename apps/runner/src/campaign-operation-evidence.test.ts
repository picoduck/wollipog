import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, unlinkSync, rmSync, chmodSync, existsSync, linkSync, renameSync } from "node:fs";
import { createServer } from "node:net";
import { execFileSync, spawnSync } from "@wollipog/test-support/bounded-child-process";
import { campaignCodeOperationTargets } from "@wollipog/protocol";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { campaignOperationEvidence, campaignOperationEvidenceCurrent, mountPointsWithin } from "./campaign-operation-evidence.js";

test("worktree containment is attested only when every canonical target and the cwd lie inside the session root (#2940)", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "campaign-containment-")));
  try {
    const worktree = join(directory, "worktree"); mkdirSync(join(worktree, "src"), { recursive: true });
    mkdirSync(join(directory, "vault"));
    writeFileSync(join(worktree, "src/a.ts"), "a\n");
    writeFileSync(join(directory, "vault/provider-state.bin"), "secret\n");
    symlinkSync(join(directory, "vault/provider-state.bin"), join(worktree, "src/alias.ts"));
    const inside = campaignOperationEvidence("Bash", { kind: "command", input: "cat src/a.ts", cwd: worktree }, worktree);
    assert.deepEqual(inside.filesystem?.containment, { version: 1, root: worktree, sessionRoot: worktree });
    assert.equal(campaignOperationEvidenceCurrent("Bash", inside), true, "the recheck reproduces the attestation");
    // A symlink whose real path leaves the worktree, a cwd outside it, or no session root: no attestation.
    assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: "cat src/alias.ts", cwd: worktree }, worktree).filesystem?.containment, undefined);
    assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: `cat ${join(worktree, "src/a.ts")}`, cwd: directory }, worktree)
      .filesystem?.containment, undefined);
    assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: "cat src/a.ts", cwd: worktree }).filesystem?.containment, undefined);
    // A worktree reached through a symlinked path is canonicalized before comparison.
    symlinkSync(worktree, join(directory, "alias-worktree"));
    const viaAlias = campaignOperationEvidence("Read", { kind: "file", path: join(worktree, "src/a.ts") }, join(directory, "alias-worktree"));
    assert.deepEqual(viaAlias.filesystem?.containment, { version: 1, root: worktree, sessionRoot: join(directory, "alias-worktree") });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the path-aliasing sweep never attests a target whose identity can leave the worktree (#2940 CR-4)", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "campaign-aliasing-")));
  try {
    const worktree = join(directory, "worktree"); mkdirSync(join(worktree, "src"), { recursive: true });
    const vault = join(directory, "vault"); mkdirSync(join(vault, "inner"), { recursive: true });
    writeFileSync(join(vault, "provider-state.bin"), "secret\n");
    writeFileSync(join(worktree, "provider-state.bin"), "harmless decoy\n");
    writeFileSync(join(worktree, "src/a.ts"), "a\n");
    const attested = (input: string, tool = "Bash") => campaignOperationEvidence(tool, tool === "Bash"
      ? { kind: "command", input, cwd: worktree } : { kind: "file", path: input }, worktree).filesystem?.containment;
    // Sanity: an ordinary worktree file, and a harmless `.` segment, are attested.
    assert.ok(attested("cat src/a.ts"));
    assert.ok(attested("cat ./src/a.ts"));
    // `..` after a symlink: the kernel resolves `jump` first, so `jump/..` is the vault, not the worktree.
    symlinkSync(join(vault, "inner"), join(worktree, "jump"));
    assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: "cat jump/../provider-state.bin", cwd: worktree }, worktree).filesystem,
      undefined, "a `..` segment is never evidence, so the decoy is not attested");
    assert.equal(attested(`${worktree}/src/../src/a.ts`, "Read"), undefined, "a raw `..` path, never joined lexically");
    // A symlinked parent directory and a symlinked final target both resolve outside.
    symlinkSync(vault, join(worktree, "src/vault-dir"));
    assert.equal(attested("cat src/vault-dir/provider-state.bin"), undefined);
    symlinkSync(join(vault, "provider-state.bin"), join(worktree, "src/alias.ts"));
    assert.equal(attested("cat src/alias.ts"), undefined);
    // A hard link keeps its in-worktree name under realpath: any existing target with nlink > 1 is
    // refused, for reads and for every mutation tool (editing the alias edits the external inode).
    linkSync(join(vault, "provider-state.bin"), join(worktree, "src/hard.ts"));
    assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: "cat src/hard.ts", cwd: worktree }, worktree).filesystem, undefined);
    for (const tool of ["Read", "Edit", "Write", "MultiEdit"]) assert.equal(attested(join(worktree, "src/hard.ts"), tool), undefined, tool);
    // Devices and kernel magic links, directly or through a worktree symlink.
    symlinkSync("/dev/null", join(worktree, "src/null.ts"));
    assert.equal(attested("cat src/null.ts"), undefined);
    assert.equal(attested("/dev/null", "Read"), undefined);
    assert.equal(attested("/proc/self/environ", "Read"), undefined);
    assert.equal(attested("/dev/fd/0", "Read"), undefined);
    symlinkSync("/proc/self/root/etc/hostname", join(worktree, "src/proc.ts"));
    assert.equal(attested("cat src/proc.ts"), undefined);
    // A socket is not a regular file (FIFOs are covered below).
    const server = createServer(); await new Promise<void>((resolve) => server.listen(join(worktree, "src/sock.ts"), resolve));
    try { assert.equal(attested("cat src/sock.ts"), undefined); } finally { await new Promise((resolve) => server.close(resolve)); }
    // TOCTOU: the recheck re-resolves and compares the inode, so a same-path replacement fails.
    const evidence = campaignOperationEvidence("Bash", { kind: "command", input: "cat src/a.ts", cwd: worktree }, worktree);
    assert.equal(campaignOperationEvidenceCurrent("Bash", evidence), true);
    // The replacement exists before the original is released, so a file system that reuses freed
    // inode numbers at once cannot hand it the same identity.
    writeFileSync(join(worktree, "src/a.next"), "a\n"); renameSync(join(worktree, "src/a.next"), join(worktree, "src/a.ts"));
    assert.equal(campaignOperationEvidenceCurrent("Bash", evidence), false, "a swapped inode cannot reuse the old evidence");
    // A hard link created after the evidence also fails the recheck.
    const fresh = campaignOperationEvidence("Bash", { kind: "command", input: "cat src/a.ts", cwd: worktree }, worktree);
    linkSync(join(worktree, "src/a.ts"), join(vault, "later-link"));
    assert.equal(campaignOperationEvidenceCurrent("Bash", fresh), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("mount points inside a root are read from the mount table, so a same-device bind mount is never attested", { skip: process.platform !== "linux" }, () => {
  const mounts = mountPointsWithin("/");
  assert.ok(mounts, "the mount table is readable");
  assert.ok(mounts.includes("/proc"), "the kernel's own mounts below / are listed");
  assert.ok(!mounts.includes("/"), "the root itself is not a mount inside itself");
  // A file below a mount point inside the root is never attested, whatever its device number says.
  const target = join(realpathSync(tmpdir()), `campaign-mount-${process.pid}`);
  writeFileSync(target, "x\n");
  try {
    const below = mounts.some((mount) => target === mount || target.startsWith(`${mount}/`));
    const evidence = campaignOperationEvidence("Read", { kind: "file", path: target }, "/");
    if (below) assert.equal(evidence.filesystem?.containment, undefined, "a mounted filesystem inside the root");
  } finally { rmSync(target, { force: true }); }
});

test("canonical operation evidence rejects dangling links and catches a replaced target without reading contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-operation-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src/auth.ts"), "fixture\n");
    const link = join(directory, "src/link.ts");
    symlinkSync(join(directory, "src/auth.ts"), link);
    const evidence = campaignOperationEvidence("Read", { kind: "file", path: link });
    assert.equal(evidence.filesystem?.targets[0]?.resolvedPath, join(directory, "src/auth.ts"));
    assert.equal(campaignOperationEvidenceCurrent("Read", evidence), true);
    unlinkSync(link); symlinkSync(join(directory, "absent.ts"), link);
    assert.equal(campaignOperationEvidence("Read", { kind: "file", path: link }).filesystem, undefined);
    assert.equal(campaignOperationEvidenceCurrent("Read", evidence), false);
    assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: "cat src/auth.ts", cwd: join(directory, "missing") }).filesystem, undefined);
    assert.equal(campaignOperationEvidence("Write", { kind: "file", path: join(directory, "src/new.ts") }).filesystem?.targets[0]?.resolvedPath, join(directory, "src/new.ts"));
    assert.equal(campaignOperationEvidence("Unknown", { kind: "file", path: link, filesystem: { targets: [{ path: link, resolvedPath: link }] } }).filesystem, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("read evidence requires existing regular files while native writes retain missing-target support", () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-read-target-"));
  try {
    const missing = join(directory, "missing.ts"), folder = join(directory, "folder.ts");
    mkdirSync(folder);
    for (const path of [missing, folder]) {
      assert.equal(campaignOperationEvidence("Read", { kind: "file", path }).filesystem, undefined);
      assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: `cat ${basename(path)}`, cwd: directory }).filesystem, undefined);
    }
    assert.equal(campaignOperationEvidence("Write", { kind: "file", path: missing }).filesystem?.targets[0]?.resolvedPath, missing);
    writeFileSync(missing, "regular fixture\n");
    assert.equal(campaignOperationEvidence("Read", { kind: "file", path: missing }).filesystem?.targets[0]?.resolvedPath, missing);
    assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: `cat ${basename(missing)}`, cwd: directory }).filesystem?.targets[0]?.resolvedPath, missing);
    if (process.platform === "linux") {
      const fifo = join(directory, "pipe.ts"); execFileSync("mkfifo", [fifo], { timeout: 10_000 });
      assert.equal(campaignOperationEvidence("Read", { kind: "file", path: fifo }).filesystem, undefined);
      assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: `cat ${basename(fifo)}`, cwd: directory }).filesystem, undefined);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Git helper fixtures demonstrate why canonical inspection targets cannot authorize execution", {
  skip: process.platform !== "linux" ? "POSIX Git helper and util-linux PTY fixtures" : false,
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-git-effects-"));
  const { GIT_PAGER: _inheritedPager, ...fixtureEnvironment } = process.env;
  const env = { ...fixtureEnvironment, TERM: "xterm", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "empty-config"),
    WOLLIPOG_TEST_GIT_HELPER_MARKER: join(directory, "helper-ran") };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, env, encoding: "utf8", timeout: 10_000 });
  const helper = join(directory, "helper.sh");
  try {
    writeFileSync(env.GIT_CONFIG_GLOBAL, "");
    mkdirSync(join(directory, "empty-hooks"));
    git("init", "-q");
    git("config", "core.hooksPath", join(directory, "empty-hooks"));
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(directory, "sample.ts"), "original\n");
    git("add", "sample.ts"); git("commit", "-qm", "fixture");
    writeFileSync(join(directory, "sample.ts"), "modified\n");
    // Every executed helper is this local fixture, with no project hook or external effects.
    writeFileSync(helper, '#!/bin/sh\nmode="$1"; shift\nprintf %s "$mode" >> "$WOLLIPOG_TEST_GIT_HELPER_MARKER"\ncase "$mode" in\nfsmonitor) printf "fixture-token\\0" ;;\ntextconv) cat "$1" ;;\nclean) cat ;;\npager) cat > /dev/null ;;\nexternal) : ;;\nesac\n');
    chmodSync(helper, 0o700);
    const helperCommand = (mode: string) => `'${helper}' ${mode}`;
    const run = (command: string, args: string[], expectedHelper: string, pty = false) => {
      rmSync(env.WOLLIPOG_TEST_GIT_HELPER_MARKER, { force: true });
      const operation = { kind: "command" as const, input: command, cwd: directory };
      assert.equal(campaignCodeOperationTargets("commandExecution", operation), null, command);
      assert.equal(campaignOperationEvidence("commandExecution", operation).filesystem, undefined, command);
      assert.equal(existsSync(env.WOLLIPOG_TEST_GIT_HELPER_MARKER), false, "evidence collection executes no helper");
      if (pty) execFileSync("script", ["-q", "-c", command, "/dev/null"], { cwd: directory, env, timeout: 10_000 });
      else git(...args);
      assert.ok(existsSync(env.WOLLIPOG_TEST_GIT_HELPER_MARKER), `${expectedHelper} executes despite an in-repository target`);
      assert.equal(readFileSync(env.WOLLIPOG_TEST_GIT_HELPER_MARKER, "utf8").replaceAll(expectedHelper, ""), "", "only the configured fixture helper ran");
    };

    git("config", "core.fsmonitor", helperCommand("fsmonitor"));
    run("git status --short", ["status", "--short"], "fsmonitor");
    git("config", "--unset", "core.fsmonitor");

    writeFileSync(join(directory, ".gitattributes"), "sample.ts diff=fixture\n");
    git("config", "diff.fixture.textconv", helperCommand("textconv"));
    run("git diff -- sample.ts", ["diff", "--", "sample.ts"], "textconv");
    git("config", "--unset", "diff.fixture.textconv");

    writeFileSync(join(directory, ".gitattributes"), "sample.ts filter=fixture\n");
    git("config", "filter.fixture.clean", helperCommand("clean"));
    run("git -c core.fsmonitor=false --no-pager diff --no-ext-diff --no-textconv -- sample.ts",
      ["-c", "core.fsmonitor=false", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--", "sample.ts"], "clean");
    git("config", "--unset", "filter.fixture.clean");
    writeFileSync(join(directory, ".gitattributes"), "");

    // An included local config can hide execution behind an ordinary diff command too.
    const customConfig = join(directory, "custom-config");
    writeFileSync(customConfig, `[diff]\n\texternal = ${JSON.stringify(helperCommand("external"))}\n`);
    git("config", "include.path", customConfig);
    run("git diff -- sample.ts", ["diff", "--", "sample.ts"], "external");
    git("config", "--unset", "include.path");

    if (spawnSync("script", ["--version"], { env, timeout: 10_000 }).status === 0) {
      git("config", "core.pager", helperCommand("pager"));
      run("git --paginate diff -- sample.ts", [], "pager", true);
    } else t.diagnostic("PTY pager fixture unavailable; portable selector negatives still cover pager/custom config forms");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
