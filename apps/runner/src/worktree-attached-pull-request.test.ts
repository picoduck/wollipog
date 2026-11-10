import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { branchPullRequestForAttachedWorktree } from "./worktree.js";

// #4209: the pull request a worktree reused in place by a Location switch already has is linked on
// its row, from the forge's answer about that branch, in that repository, and nothing else.

const git = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
  "-C", cwd, ...args,
], { encoding: "utf8" }).trim();

function fixture(): { root: string; repo: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "wollipog-reused-pr-"));
  const repo = join(root, "docs");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "base");
  git(repo, "remote", "add", "origin", "git@github.com:acme/docs.git");
  git(repo, "switch", "--quiet", "-c", "fix/local");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "work");
  return { root, repo: realpathSync(repo), head: git(repo, "rev-parse", "HEAD") };
}

const item = (overrides: Record<string, unknown> = {}) => ({ url: "https://github.com/acme/docs/pull/12", state: "OPEN",
  headRefOid: "0".repeat(40), headRefName: "fix/local", isCrossRepository: false, ...overrides });

test("a reused branch's own pull request is linked: one open, or a merged one at exactly its tip", async () => {
  const { root, repo, head } = fixture();
  try {
    const calls: string[][] = [];
    const lookup = (listing: unknown, extra: Parameters<typeof branchPullRequestForAttachedWorktree>[2] = {}) =>
      branchPullRequestForAttachedWorktree(repo, "fix/local", {
        runForgeCommand: (async (_context: unknown, command: string, args: string[]) => {
          calls.push([command, ...args]);
          if (listing instanceof Error) throw listing;
          return { stdout: JSON.stringify(listing), stderr: "" };
        }) as never,
        ...extra,
      });

    assert.deepEqual(await lookup([item()]),
      { url: "https://github.com/acme/docs/pull/12", state: "open", provider: "github", kind: "pull_request" });
    // Asked of the remote's own repository, by the branch's name, never of gh's chosen default.
    assert.deepEqual(calls[0], ["gh", "pr", "list", "--repo", "github.com/acme/docs", "--head", "fix/local", "--state", "all",
      "--limit", "20", "--json", "url,state,headRefOid,headRefName,isCrossRepository"]);
    // A fork's, another branch's, or another repository's pull request is not this branch's.
    assert.equal(await lookup([item({ isCrossRepository: true })]), null);
    assert.equal(await lookup([item({ headRefName: "fix/other" })]), null);
    assert.equal(await lookup([item({ url: "https://github.com/acme/app/pull/12" })]), null);
    assert.equal(await lookup([item({ url: "https://example.com/acme/docs/pull/12" })]), null);
    // Two open ones say nothing about which this is.
    assert.equal(await lookup([item(), item({ url: "https://github.com/acme/docs/pull/13" })]), null);
    assert.equal(await lookup([item(), item({ url: "https://github.com/acme/docs/pull/13" }),
      item({ url: "https://github.com/acme/docs/pull/11", state: "MERGED", headRefOid: head })]), null,
    "nor does an older merged one then");
    // With none open, a merged one only at exactly the local tip; a closed one never.
    assert.deepEqual(await lookup([item({ state: "MERGED", headRefOid: head.toUpperCase() })]),
      { url: "https://github.com/acme/docs/pull/12", state: "merged", headOid: head, provider: "github", kind: "pull_request" });
    assert.equal(await lookup([item({ state: "MERGED" })]), null);
    assert.equal(await lookup([item({ state: "CLOSED", headRefOid: head })]), null);
    assert.deepEqual((await lookup([item({ state: "MERGED", headRefOid: head }), item({ url: "https://github.com/acme/docs/pull/14" })]))
      ?.state, "open", "an open pull request is the one the branch is on now");

    // A failure, or a reply that is not a listing, is unavailable, not an empty answer.
    let unavailable = 0;
    assert.equal(await lookup(new Error("gh: not logged in"), { onForgeUnavailable: () => { unavailable++; } }), null);
    assert.equal(await lookup({ message: "Not Found" }, { onForgeUnavailable: () => { unavailable++; } }), null);
    assert.equal(unavailable, 2);
    // The admission hook sees what is asked about and can hold the question back.
    const identities: string[] = [];
    const before = calls.length;
    assert.equal(await lookup([item()], { onForgeAttempt: (identity) => { identities.push(identity); return false; } }), null);
    assert.deepEqual(identities, [JSON.stringify(["acme/docs", "fix/local", head])]);
    assert.equal(calls.length, before, "held back before the forge is asked");

    // The upstream branch names the pull request's head when there is one.
    git(repo, "config", "branch.fix/local.remote", "origin");
    git(repo, "config", "branch.fix/local.merge", "refs/heads/feature/upstream");
    assert.deepEqual(await lookup([item({ headRefName: "feature/upstream" })])
      && calls.at(-1)?.slice(5, 7), ["--head", "feature/upstream"]);
    assert.equal(await lookup([item()]), null, "the local name is not the head branch then");
    // A local-only upstream, or a remote on no GitHub repository, asks nothing.
    const asked = calls.length;
    git(repo, "config", "branch.fix/local.remote", ".");
    assert.equal(await lookup([item()]), null);
    git(repo, "config", "--unset", "branch.fix/local.remote");
    git(repo, "config", "--unset", "branch.fix/local.merge");
    git(repo, "remote", "set-url", "origin", "https://gitlab.com/acme/docs.git");
    assert.equal(await lookup([item()]), null);
    assert.equal(calls.length, asked);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
