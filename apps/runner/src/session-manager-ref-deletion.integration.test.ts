import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { isolateFromAmbientIgnores } from "./git-test-repo.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import {
  refDeletionGitRunner,
  unconfinedGitRunnerForTests,
  type GitRunner,
  type WorktreeRefDeletionScope,
} from "./worktree-ref-deletion.js";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Wollipog Test", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stdout}${result.stderr}`);
  return String(result.stdout ?? "").trim();
}

function meta(store: SessionStore, sessionId: string, repo: string): void {
  store.create({
    sessionId, agentId: "codex", workspaceId: "repo", repoPath: repo,
    worktreePath: null, driver: "codex-app-server", command: process.execPath, args: [], env: {},
    context: { kind: "native" }, agentSessionId: null, status: "idle", title: "refs",
    config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
    seq: 0, createdAt: 1, updatedAt: 1,
  });
}

function adminDirectory(worktreePath: string): string {
  return realpathSync(resolve(worktreePath, readFileSync(join(worktreePath, ".git"), "utf8").trim().replace(/^gitdir: /u, "")));
}

test("the runner deletes only the calling session's refs and audits every call (#3316)", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-session-ref-deletion-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "--initial-branch=main", "."], repo);
  isolateFromAmbientIgnores(repo);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(["add", "tracked.txt"], repo);
  git(["commit", "-qm", "base"], repo);
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_owner", repo);
  meta(store, "s_other", repo);
  const sent: RunnerToControlPlane[] = [];
  const manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
    undefined as never, dataDir);
  t.after(() => manager.shutdownAll());
  // The real-bwrap confinement of the runner's Git is covered in managed-worktree-sandbox's
  // integration test; this host may not allow the user namespace it needs.
  const seam = manager as unknown as { worktreeRefDeletionGit: (scope: WorktreeRefDeletionScope) => Promise<GitRunner> };
  seam.worktreeRefDeletionGit = async () => unconfinedGitRunnerForTests;

  const first = await manager.requestWorktree("s_owner", { baseRef: "HEAD", branch: "fix/owner-first" });
  const second = await manager.requestWorktree("s_owner", { baseRef: "HEAD", branch: "fix/owner-second" });
  const foreign = await manager.requestWorktree("s_other", { baseRef: "HEAD", branch: "fix/other" });
  const head = git(["rev-parse", "HEAD"], repo);
  const secondAdmin = adminDirectory(second.worktree.path);
  const foreignAdmin = adminDirectory(foreign.worktree.path);
  for (const admin of [secondAdmin, foreignAdmin]) writeFileSync(join(admin, "CHERRY_PICK_HEAD"), `${head}\n`);
  // The first worktree moved off its recorded branch, so that branch is no longer checked out.
  git(["switch", "-q", "-c", "fix/owner-first-renamed"], first.worktree.path);
  const audits = () => sent.flatMap((message) => message.type === "session_event" && message.payload.kind === "worktree_refs_deleted"
    ? [{ sessionId: message.sessionId, payload: message.payload }] : []);

  const cleared = await manager.deleteWorktreeRefs("s_owner", second.worktree.path, [{ ref: "CHERRY_PICK_HEAD", oldOid: head }]);
  assert.deepEqual(cleared.refDeletion, { worktreePath: second.worktree.path, deleted: ["CHERRY_PICK_HEAD"], absent: [] });
  assert.equal(existsSync(join(secondAdmin, "CHERRY_PICK_HEAD")), false);
  const branch = await manager.deleteWorktreeRefs("s_owner", undefined, [{ ref: "refs/heads/fix/owner-first", oldOid: head }]);
  assert.deepEqual(branch.refDeletion.deleted, ["refs/heads/fix/owner-first"]);

  const refusals: Array<[string | undefined, string, RegExp]> = [
    [foreign.worktree.path, "CHERRY_PICK_HEAD", /not a runner-created worktree of this session/u],
    [undefined, "refs/heads/fix/other", /only this worktree's/u],
    [undefined, "refs/heads/fix/owner-second", /checked out/u],
    [join(root, "elsewhere"), "CHERRY_PICK_HEAD", /not a runner-created worktree of this session/u],
  ];
  for (const [path, ref, pattern] of refusals) {
    await assert.rejects(manager.deleteWorktreeRefs("s_owner", path, [{ ref, oldOid: head }]), pattern, ref);
  }
  await assert.rejects(manager.deleteWorktreeRefs("s_owner", undefined, [{ ref: "CHERRY_PICK_HEAD", oldOid: "short" }]),
    /expected full object id/u);
  assert.equal(readFileSync(join(foreignAdmin, "CHERRY_PICK_HEAD"), "utf8"), `${head}\n`, "another session's leftovers stay");
  assert.equal(git(["rev-parse", "fix/other"], repo), head);
  assert.equal(git(["rev-parse", "fix/owner-second"], repo), head);

  // A runner without an equivalent confinement, such as macOS, refuses before any Git runs, so a
  // swapped ref directory can never steer an unconfined host Git there.
  seam.worktreeRefDeletionGit = (scope) => refDeletionGitRunner(scope, { platform: "darwin" });
  await assert.rejects(manager.deleteWorktreeRefs("s_owner", undefined, [{ ref: "CHERRY_PICK_HEAD", oldOid: head }]),
    /only Linux runners provide/u);
  await assert.rejects(manager.deleteWorktreeRefs("s_owner", undefined, [{ ref: "refs/heads/fix/owner-second", oldOid: head }]),
    /only Linux runners provide/u);
  assert.equal(git(["rev-parse", "fix/owner-second"], repo), head);

  const recorded = audits();
  assert.equal(recorded.length, 2 + refusals.length + 1 + 2, "every call leaves one audit event");
  assert.ok(recorded.every((entry) => entry.sessionId === "s_owner"));
  assert.deepEqual(recorded.slice(0, 2).map((entry) => entry.payload.outcome), ["deleted", "deleted"]);
  for (const entry of recorded.slice(2)) {
    assert.equal(entry.payload.outcome, "refused");
    assert.deepEqual(entry.payload.deleted, []);
    assert.ok(entry.payload.reason, "a refusal names its fixed reason");
    assert.ok(!entry.payload.reason!.includes("elsewhere"), "a caller-supplied path is never echoed");
  }
});
