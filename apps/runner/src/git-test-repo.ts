/**
 * Throwaway-repository setup shared by the runner's real-git test suites. Test support only: no
 * production module imports it.
 */

import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * Cut a freshly initialized, non-bare repository at `repo` off from the machine's ignore rules.
 *
 * Production reads untracked files through `ls-files --others --exclude-standard` and `status`, so a
 * machine that happens to ignore a fixture name (*.dat, untracked.txt, say) would hide a file the
 * assertions depend on. Both standard sources are neutralised — the user's core.excludesFile is
 * replaced by an empty one of this repo's own, and info/exclude is truncated because
 * init.templateDir can seed it with rules core.excludesFile cannot disable. The excludes file lives
 * in the git dir, where it cannot itself show up as untracked, and is a real path rather than
 * /dev/null, which is not one on every platform. Linked worktrees share both through the common
 * git dir.
 */
export function isolateFromAmbientIgnores(repo: string): void {
  mkdirSync(join(repo, ".git", "info"), { recursive: true });
  const excludes = join(repo, ".git", "info", "wollipog-empty-excludes");
  writeFileSync(excludes, "");
  writeFileSync(join(repo, ".git", "info", "exclude"), "");
  git(repo, ["config", "core.excludesFile", excludes]);
}

/** Init a repo with a deterministic identity + config so diff output is stable across environments. */
export function initRepo(cwd: string): void {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  git(cwd, ["config", "core.autocrlf", "false"]);
  isolateFromAmbientIgnores(cwd);
}
