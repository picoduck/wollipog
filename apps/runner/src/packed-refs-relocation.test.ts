import assert from "node:assert/strict";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { runContextCommand } from "./context-command.js";
import { managedWorktreeGitWritableRoots } from "./managed-worktree-sandbox.js";
import {
  PACKED_REFS_QUARANTINE_DIRECTORY, PackedRefsViolationError, registerRepositoryPackedRefs,
  relocatePackedRefs, RELOCATED_PACKED_REFS_DIRECTORY, resetPackedRefsRelocationsForTests, verifyRelocatedPackedRefs,
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
  assert.deepEqual(managedWorktreeGitWritableRoots(worktreePath, [{ worktreePath, repoPath }]).length, 4);

  const relocation = relocatePackedRefs(common);
  const directory = join(common, RELOCATED_PACKED_REFS_DIRECTORY);
  assert.deepEqual(relocation, { status: "relocated", directory });
  assert.equal(readlinkSync(join(common, "packed-refs")), `${RELOCATED_PACKED_REFS_DIRECTORY}/packed-refs`);
  assert.equal(readFileSync(join(directory, "packed-refs"), "utf8"), before);
  assert.equal(existsSync(join(common, "packed-refs.lock")), false);
  assert.equal(existsSync(join(directory, "packed-refs.lock")), false);
  assert.match(git(repoPath, ["for-each-ref", "refs/heads/packed-branch"]), /packed-branch/);
  assert.deepEqual(relocatePackedRefs(common), relocation, "a second launch verifies instead of migrating");
  assert.deepEqual(managedWorktreeGitWritableRoots(worktreePath, [{ worktreePath, repoPath }]).at(-1), directory);

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

test("host Git commands verify every registered relocation before they run", async () => {
  const { root, repoPath, common } = repository();
  assert.equal(relocatePackedRefs(common).status, "relocated");
  resetPackedRefsRelocationsForTests();
  // As at runner start: the relocation is discovered from a stored session's repository.
  registerRepositoryPackedRefs(repoPath);
  const relocated = join(common, RELOCATED_PACKED_REFS_DIRECTORY, "packed-refs");
  const victim = join(root, "victim");
  symlinkSync(victim, relocated);
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (message: string) => { logged.push(message); };
  try {
    await runContextCommand({ kind: "native" }, "git", ["status", "--short"], { cwd: repoPath });
  } finally {
    console.error = originalError;
  }
  assert.equal(existsSync(relocated), false);
  assert.match(logged.join("\n"), /not a plain runner-owned file/);
  git(repoPath, ["branch", "host-branch"]);
  git(repoPath, ["pack-refs", "--all"]);
  assert.equal(existsSync(victim), false, "host Git never followed the substituted link");
});
