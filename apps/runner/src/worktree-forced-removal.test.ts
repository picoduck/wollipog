import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequestedWorktree, createWorktree, discardWorktreeIfSafe, releaseRecoveredWorktree, removeWorktree } from "./worktree.js";

// The forced removal paths left after #4395 (#4209 follow-ups): a removal never takes what it cannot
// prove holds nothing of a person's, and never drops another worktree's registration.

const git = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
  "-C", cwd, ...args,
], { encoding: "utf8" }).trim();

/** Every entry under `root`, byte for byte, including Git's own files and links. */
function bytes(root: string, prefix = ""): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(found, bytes(root, path));
    else if (entry.isSymbolicLink()) found[path] = `link:${readlinkSync(join(root, path))}`;
    else found[path] = readFileSync(join(root, path)).toString("base64");
  }
  return found;
}

function withRepository(name: string, body: (root: string, repo: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wollipog-forced-removal-${name}-`)));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "base");
  return body(root, repo).finally(() => rmSync(root, { recursive: true, force: true }));
}

const registered = (repo: string) => git(repo, "worktree", "list", "--porcelain").split("\n")
  .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));

/** Another worktree of the repository whose directory is away for now, as on an unmounted volume.
 * Returns where it went, its admin directory, and a way to put it back. */
function worktreeAway(root: string, repo: string): { path: string; admin: string; back: () => void } {
  const path = join(root, "on-a-volume");
  git(repo, "worktree", "add", "--quiet", "-b", "volume-work", path);
  writeFileSync(join(path, "notes.txt"), "work on a volume that is not mounted right now\n");
  git(path, "add", "notes.txt");
  const admin = git(path, "rev-parse", "--absolute-git-dir");
  renameSync(path, `${path}.unmounted`);
  return { path, admin, back: () => renameSync(`${path}.unmounted`, path) };
}

test("a registered session worktree that fails its health check is left byte for byte, and the refusal says what to do", async () => {
  if (process.platform === "win32") return;
  await withRepository("unhealthy", async (root, repo) => {
    const dataDir = join(root, "data");
    const handle = await createWorktree(repo, "s_unhealthy", { dataDir });
    writeFileSync(join(handle.path, "uncommitted.txt"), "a person's uncommitted work\n");
    // Its own configuration no longer parses, so Git cannot answer from inside it. Git's removal,
    // run from the repository, still would.
    git(repo, "config", "extensions.worktreeConfig", "true");
    const admin = git(handle.path, "rev-parse", "--absolute-git-dir");
    writeFileSync(join(admin, "config.worktree"), "[broken\n");
    const before = bytes(handle.path);
    const adminBefore = bytes(admin);

    await assert.rejects(createWorktree(repo, "s_unhealthy", { dataDir }), (error: Error) => {
      assert.match(error.message, /left as it is/u);
      assert.ok(error.message.includes(handle.path), "it names the worktree");
      return true;
    });
    assert.deepEqual(bytes(handle.path), before, "every file is still there");
    assert.deepEqual(bytes(admin), adminBefore, "and so is its registration");
    assert.ok(registered(repo).includes(handle.path));
  });
});

test("a registered session worktree whose directory has gone is made again, and drops only its own registration", async () => {
  if (process.platform === "win32") return;
  await withRepository("gone", async (root, repo) => {
    const dataDir = join(root, "data");
    const handle = await createWorktree(repo, "s_gone", { dataDir });
    const away = worktreeAway(root, repo);
    const awayAdmin = bytes(away.admin);
    rmSync(handle.path, { recursive: true, force: true });

    const remade = await createWorktree(repo, "s_gone", { dataDir });
    assert.equal(remade.path, handle.path);
    assert.equal(remade.created, true);
    assert.deepEqual(bytes(away.admin), awayAdmin, "the worktree that is only away keeps its registration");
    away.back();
    assert.equal(git(away.path, "status", "--porcelain"), "A  notes.txt", "and works again once it is back, index and all");
  });
});

test("a forced release refuses a worktree Git cannot answer from inside, and leaves it byte for byte", async () => {
  if (process.platform === "win32") return;
  await withRepository("unanswered", async (root, repo) => {
    const path = join(root, "worktree");
    git(repo, "branch", "kept");
    git(repo, "worktree", "add", "--quiet", path, "kept");
    writeFileSync(join(path, "uncommitted.txt"), "a person's uncommitted work\n");
    git(repo, "config", "extensions.worktreeConfig", "true");
    writeFileSync(join(git(path, "rev-parse", "--absolute-git-dir"), "config.worktree"), "[broken\n");
    const before = bytes(path);

    await assert.rejects(releaseRecoveredWorktree(repo, path, {}, { force: true }), /identity could not be revalidated/u);
    assert.deepEqual(bytes(path), before, "Git's forced removal would have taken all of it");
    assert.ok(registered(repo).includes(path));
  });
});

// The two below pass without the identity check too: the absence probe already refuses a link, and
// Git's own validation refuses a worktree whose `.git` does not point back. They guard that the check
// added in front of them keeps both refusals.
test("a forced release refuses a link at the worktree's path, and leaves the tree it leads to byte for byte", async () => {
  if (process.platform === "win32") return;
  await withRepository("link", async (root, repo) => {
    const path = join(root, "worktree");
    git(repo, "branch", "kept");
    git(repo, "worktree", "add", "--quiet", path, "kept");
    writeFileSync(join(path, "uncommitted.txt"), "a person's uncommitted work\n");
    // A person moved the worktree aside and left a link where it was.
    renameSync(path, `${path}.moved`);
    symlinkSync(`${path}.moved`, path);
    const before = bytes(`${path}.moved`);

    await assert.rejects(releaseRecoveredWorktree(repo, path, {}, { force: true }));
    assert.deepEqual(bytes(`${path}.moved`), before, "nothing behind the link is removed");
    assert.equal(git(repo, "rev-parse", "--verify", "refs/heads/kept").length, 40, "and the branch stays");
  });
});

test("a forced release refuses a different repository's worktree at its path, and leaves it byte for byte", async () => {
  if (process.platform === "win32") return;
  await withRepository("foreign", async (root, repo) => {
    const path = join(root, "worktree");
    git(repo, "branch", "kept");
    git(repo, "worktree", "add", "--quiet", path, "kept");
    renameSync(path, `${path}.original`);
    const other = join(root, "other");
    mkdirSync(other);
    git(other, "init", "--quiet", "--initial-branch=main");
    git(other, "commit", "--quiet", "--allow-empty", "-m", "other");
    git(other, "worktree", "add", "--quiet", "-b", "theirs", path);
    writeFileSync(join(path, "theirs.txt"), "another repository's work\n");
    const before = bytes(path);

    await assert.rejects(releaseRecoveredWorktree(repo, path, {}, { force: true }));
    assert.deepEqual(bytes(path), before);
  });
});

for (const how of ["a forced release", "a non-forced release", "a removal"] as const) {
  test(`${how} of a worktree whose directory has gone drops only its own registration`, async () => {
    if (process.platform === "win32") return;
    await withRepository(how.replaceAll(" ", "-"), async (root, repo) => {
      const path = join(root, "worktree");
      git(repo, "worktree", "add", "--quiet", "-b", "mine", path);
      const away = worktreeAway(root, repo);
      const awayAdmin = bytes(away.admin);
      rmSync(path, { recursive: true, force: true });

      if (how === "a removal") await removeWorktree(repo, { path, branch: "mine" });
      else await releaseRecoveredWorktree(repo, path, {}, { force: how === "a forced release" });
      assert.equal(registered(repo).includes(path), false, "its own registration goes");
      assert.ok(registered(repo).includes(away.path), "the other one is still listed");
      assert.deepEqual(bytes(away.admin), awayAdmin, "with everything Git keeps for it");
      away.back();
      assert.equal(git(away.path, "status", "--porcelain"), "A  notes.txt");
    });
  });
}

test("removing a worktree that is there leaves another one that is only away registered", async () => {
  if (process.platform === "win32") return;
  await withRepository("present", async (root, repo) => {
    const path = join(root, "worktree");
    git(repo, "worktree", "add", "--quiet", "-b", "mine", path);
    const away = worktreeAway(root, repo);
    const awayAdmin = bytes(away.admin);

    await removeWorktree(repo, { path, branch: "mine" });
    assert.equal(registered(repo).includes(path), false);
    assert.deepEqual(bytes(away.admin), awayAdmin, "Git's prune after the removal would have dropped it");
    away.back();
    assert.equal(git(away.path, "status", "--porcelain"), "A  notes.txt");
  });
});

test("a safe discard leaves another worktree that is only away registered", async () => {
  if (process.platform === "win32") return;
  await withRepository("safe-discard", async (root, repo) => {
    const origin = join(root, "origin.git");
    git(root, "init", "--quiet", "--bare", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "--quiet", "origin", "main");
    git(repo, "remote", "set-head", "origin", "main");
    const dataDir = join(root, "data");
    const mine = await createRequestedWorktree(repo, "s_safe_discard", { baseRef: "HEAD", branch: "fix/contained" }, { dataDir });
    const away = worktreeAway(root, repo);
    const awayAdmin = bytes(away.admin);

    assert.deepEqual(await discardWorktreeIfSafe(repo, "s_safe_discard", { ...mine, source: "created" }, { dataDir }), { removed: true });
    assert.equal(registered(repo).includes(mine.path), false);
    assert.deepEqual(bytes(away.admin), awayAdmin, "Git's prune after the discard would have dropped it");
    away.back();
    assert.equal(git(away.path, "status", "--porcelain"), "A  notes.txt");
  });
});

test("a removal Git cannot finish leaves another worktree that is only away registered", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  await withRepository("failed-removal", async (root, repo) => {
    const path = join(root, "worktree");
    git(repo, "worktree", "add", "--quiet", "-b", "mine", path);
    // A directory nobody may write into, so Git's own removal fails partway.
    const stuck = join(path, "stuck");
    mkdirSync(stuck);
    writeFileSync(join(stuck, "file.txt"), "cannot be removed\n");
    chmodSync(stuck, 0o500);
    const away = worktreeAway(root, repo);
    const awayAdmin = bytes(away.admin);
    try {
      await assert.rejects(removeWorktree(repo, { path, branch: "mine" }), /worktree cleanup incomplete/u);
    } finally {
      chmodSync(stuck, 0o700);
    }
    assert.deepEqual(bytes(away.admin), awayAdmin, "Git's prune after the failed removal would have dropped it");
    away.back();
    assert.equal(git(away.path, "status", "--porcelain"), "A  notes.txt");
  });
});

test("a locked registration whose directory has gone is not dropped", async () => {
  if (process.platform === "win32") return;
  await withRepository("locked", async (root, repo) => {
    const path = join(root, "worktree");
    git(repo, "worktree", "add", "--quiet", "-b", "mine", path);
    git(repo, "worktree", "lock", "--reason", "on a removable disk", path);
    rmSync(path, { recursive: true, force: true });
    await releaseRecoveredWorktree(repo, path, {}, { force: true }).catch(() => undefined);
    assert.ok(registered(repo).includes(path), "a person locked it so that it stays");
  });
});
