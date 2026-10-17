import assert from "node:assert/strict";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { after, afterEach, mock, test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import {
  PACKED_REFS_QUARANTINE_DIRECTORY, PackedRefsViolationError, recordBoundPackedRefs, relocatePackedRefs,
  RELOCATED_PACKED_REFS_DIRECTORY, resetPackedRefsRelocationsForTests, verifyBoundPackedRefs, verifyRelocatedPackedRefs,
} from "./packed-refs-relocation.js";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
afterEach(() => resetPackedRefsRelocationsForTests());

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stdout}${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

function repository(): { root: string; repoPath: string; common: string; worktreePath: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-packed-refs-")));
  roots.push(root);
  const repoPath = join(root, "repo");
  mkdirSync(repoPath);
  git(repoPath, ["init", "--quiet", "--initial-branch=main", "."]);
  git(repoPath, ["config", "user.email", "runner@example.invalid"]);
  git(repoPath, ["config", "user.name", "Runner"]);
  git(repoPath, ["commit", "--quiet", "--allow-empty", "-m", "base"]);
  const worktreePath = join(root, "worktrees", "s_packed");
  git(repoPath, ["worktree", "add", "--quiet", "-b", "agent/s_packed", worktreePath, "main"]);
  return { root, repoPath, common: join(repoPath, ".git"), worktreePath };
}

test("relocation moves packed refs behind the runner link without losing a ref", () => {
  const { repoPath, common, worktreePath } = repository();
  git(repoPath, ["branch", "packed-branch"]);
  git(repoPath, ["pack-refs", "--all"]);
  const before = readFileSync(join(common, "packed-refs"), "utf8");
  assert.match(before, /refs\/heads\/packed-branch/);

  const relocation = relocatePackedRefs(common);
  const directory = join(common, RELOCATED_PACKED_REFS_DIRECTORY);
  assert.deepEqual(relocation, { status: "relocated", directory });
  assert.equal(readlinkSync(join(common, "packed-refs")), `${RELOCATED_PACKED_REFS_DIRECTORY}/packed-refs`);
  assert.equal(readFileSync(join(directory, "packed-refs"), "utf8"), before);
  assert.equal(existsSync(join(common, "packed-refs.lock")), false);
  assert.equal(existsSync(join(directory, "packed-refs.lock")), false);
  assert.match(git(repoPath, ["for-each-ref", "refs/heads/packed-branch"]), /packed-branch/);
  assert.deepEqual(relocatePackedRefs(common), relocation, "a second launch verifies instead of migrating");

  // Host Git keeps the layout across its own packed-refs rewrites.
  git(repoPath, ["branch", "-D", "packed-branch"]);
  git(repoPath, ["branch", "another"]);
  git(repoPath, ["pack-refs", "--all"]);
  assert.ok(lstatSync(join(common, "packed-refs")).isSymbolicLink());
  assert.match(readFileSync(join(directory, "packed-refs"), "utf8"), /refs\/heads\/another/);
  git(repoPath, ["fsck", "--no-progress"]);
});

test("a repository without packed refs gets a link Git can create the file behind", () => {
  const { repoPath, common, worktreePath } = repository();
  assert.equal(existsSync(join(common, "packed-refs")), false);
  assert.equal(relocatePackedRefs(common).status, "relocated");
  const directory = join(common, RELOCATED_PACKED_REFS_DIRECTORY);
  assert.equal(existsSync(join(directory, "packed-refs")), false);
  // A read-only common root, as the sandbox sees it: deletion and packing take the relocated lock.
  git(repoPath, ["branch", "extra"]);
  chmodSync(common, 0o555);
  try {
    git(worktreePath, ["update-ref", "refs/heads/temporary", "HEAD"]);
    git(worktreePath, ["update-ref", "-d", "refs/heads/temporary"]);
    git(worktreePath, ["pack-refs", "--all"]);
    assert.match(readFileSync(join(directory, "packed-refs"), "utf8"), /refs\/heads\/extra/);
    git(worktreePath, ["update-ref", "-d", "refs/heads/extra"]);
  } finally {
    chmodSync(common, 0o755);
  }
  assert.ok(lstatSync(join(directory, "packed-refs")).isFile());
  assert.doesNotMatch(readFileSync(join(directory, "packed-refs"), "utf8"), /refs\/heads\/extra/);
  assert.equal(git(repoPath, ["for-each-ref", "refs/heads/extra"]), "");
});

test("a held Git lock or an unexpected layout leaves the repository untouched", () => {
  const { repoPath, common } = repository();
  git(repoPath, ["pack-refs", "--all"]);
  const original = readFileSync(join(common, "packed-refs"), "utf8");

  writeFileSync(join(common, "packed-refs.lock"), "");
  assert.deepEqual(relocatePackedRefs(common), { status: "unavailable", reason: "Git holds packed-refs.lock" });
  assert.ok(lstatSync(join(common, "packed-refs")).isFile());
  unlinkSync(join(common, "packed-refs.lock"));

  mkdirSync(join(common, RELOCATED_PACKED_REFS_DIRECTORY));
  writeFileSync(join(common, RELOCATED_PACKED_REFS_DIRECTORY, "packed-refs.lock"), "");
  assert.equal(relocatePackedRefs(common).status, "unavailable");
  assert.ok(lstatSync(join(common, "packed-refs")).isFile());
  assert.equal(existsSync(join(common, "packed-refs.lock")), false, "the root lock is always released");
  unlinkSync(join(common, RELOCATED_PACKED_REFS_DIRECTORY, "packed-refs.lock"));
  rmSync(join(common, RELOCATED_PACKED_REFS_DIRECTORY), { recursive: true });

  const elsewhere = join(repoPath, "elsewhere");
  writeFileSync(elsewhere, original);
  unlinkSync(join(common, "packed-refs"));
  symlinkSync(elsewhere, join(common, "packed-refs"));
  assert.equal(relocatePackedRefs(common).status, "unavailable");
  assert.equal(readlinkSync(join(common, "packed-refs")), elsewhere);
  assert.equal(readFileSync(elsewhere, "utf8"), original);
});

test("a symlink substituted for the relocated file is quarantined and refuses the launch", () => {
  const { root, repoPath, common } = repository();
  git(repoPath, ["pack-refs", "--all"]);
  assert.equal(relocatePackedRefs(common).status, "relocated");
  const relocated = join(common, RELOCATED_PACKED_REFS_DIRECTORY, "packed-refs");
  const base = git(repoPath, ["rev-parse", "HEAD"]).trim();
  const victim = join(root, "victim");
  writeFileSync(victim, "keep\n");
  unlinkSync(relocated);
  symlinkSync(victim, relocated);

  assert.throws(() => relocatePackedRefs(common), (error: unknown) =>
    error instanceof PackedRefsViolationError && !!error.quarantinedAt &&
    error.quarantinedAt.startsWith(join(common, PACKED_REFS_QUARANTINE_DIRECTORY)));
  assert.equal(existsSync(relocated), false, "nothing is left for host Git to follow");
  assert.equal(readFileSync(victim, "utf8"), "keep\n");
  const quarantined = readdirSync(join(common, PACKED_REFS_QUARANTINE_DIRECTORY));
  assert.equal(quarantined.length, 1);
  assert.ok(lstatSync(join(common, PACKED_REFS_QUARANTINE_DIRECTORY, quarantined[0]!)).isSymbolicLink());

  // The substitution itself discarded the packed refs; host Git now starts from none.
  git(repoPath, ["branch", "after-quarantine", base]);
  git(repoPath, ["pack-refs", "--all"]);
  assert.equal(readFileSync(victim, "utf8"), "keep\n");
  assert.equal(relocatePackedRefs(common).status, "relocated");
});

test("a hard link or directory in place of the relocated file is a violation", () => {
  const { root, common } = repository();
  assert.equal(relocatePackedRefs(common).status, "relocated");
  const relocated = join(common, RELOCATED_PACKED_REFS_DIRECTORY, "packed-refs");
  const outside = join(root, "outside");
  writeFileSync(outside, "keep\n");
  linkSync(outside, relocated);
  assert.throws(() => verifyRelocatedPackedRefs(common), PackedRefsViolationError);
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
  mkdirSync(relocated);
  assert.throws(() => verifyRelocatedPackedRefs(common), PackedRefsViolationError);
  assert.equal(existsSync(relocated), false);
});

test("relocation removes only its own lock, never one a later Git writer holds", () => {
  const { repoPath, common } = repository();
  git(repoPath, ["pack-refs", "--all"]);
  const directory = join(common, RELOCATED_PACKED_REFS_DIRECTORY);
  const lock = join(directory, "packed-refs.lock");
  // The relocated lock is held through publication, so a writer resolving the new link waits for
  // it instead of taking a lock the migration would later remove.
  const heldAtPublication: boolean[] = [];
  const rename = fs.renameSync;
  const spy = mock.method(fs, "renameSync", (from: string, to: string) => {
    rename(from, to);
    if (to === join(common, "packed-refs")) heldAtPublication.push(existsSync(lock));
  });
  syncBuiltinESMExports();
  try {
    assert.equal(relocatePackedRefs(common).status, "relocated");
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(heldAtPublication, [true]);
  assert.equal(existsSync(lock), false);
  assert.equal(readdirSync(directory).filter((name) => name !== "packed-refs").length, 0, "no staged copy is left");
  // A writer that took the lock after publication keeps it through a verifying relaunch.
  writeFileSync(lock, "");
  assert.equal(relocatePackedRefs(common).status, "relocated");
  assert.ok(existsSync(lock));
});


test("modes a sandbox changed are repaired without following a link", () => {
  const { repoPath, common } = repository();
  git(repoPath, ["pack-refs", "--all"]);
  assert.equal(relocatePackedRefs(common).status, "relocated");
  const directory = join(common, RELOCATED_PACKED_REFS_DIRECTORY);
  const file = join(directory, "packed-refs");
  chmodSync(file, 0o000);
  chmodSync(directory, 0o000);
  recordBoundPackedRefs(common);
  try {
    assert.deepEqual(verifyBoundPackedRefs(), []);
  } finally {
    chmodSync(directory, 0o755);
  }
  assert.equal(lstatSync(directory).mode & 0o777, 0o755);
  assert.equal(lstatSync(file).mode & 0o777, 0o644);
  assert.match(git(repoPath, ["for-each-ref", "refs/heads/main"]), /refs\/heads\/main/);
});

test("verification at provider exit quarantines and reports instead of throwing", () => {
  const { root, common } = repository();
  assert.equal(relocatePackedRefs(common).status, "relocated");
  recordBoundPackedRefs(common);
  const victim = join(root, "victim");
  symlinkSync(victim, join(common, RELOCATED_PACKED_REFS_DIRECTORY, "packed-refs"));
  const reports = verifyBoundPackedRefs();
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /not a plain runner-owned file/);
  assert.equal(existsSync(victim), false);
  assert.deepEqual(verifyBoundPackedRefs(), [], "the quarantined repository verifies cleanly afterwards");
});

test("a FIFO in place of the relocated file is quarantined without blocking", () => {
  const { common } = repository();
  assert.equal(relocatePackedRefs(common).status, "relocated");
  const relocated = join(common, RELOCATED_PACKED_REFS_DIRECTORY, "packed-refs");
  spawnSync("mkfifo", [relocated]);
  assert.throws(() => verifyRelocatedPackedRefs(common), PackedRefsViolationError);
  assert.equal(existsSync(relocated), false);
});
