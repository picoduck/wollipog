/**
 * Codex App Server's own workspace sandbox in a session that owns a second managed worktree
 * (#3316). The runner's bwrap boundary binds that worktree writable; Codex then builds its inner
 * sandbox from the `sandboxPolicy` the driver sends with each `turn/start`. This test hands the
 * exact policy `buildCodexTurnParams` produces to a real `codex app-server` through `command/exec`,
 * which applies the same policy shape without a model, and shows a commit landing in the owned
 * worktree while another session's worktree and the owned worktree's `.git` link stay read-only.
 * The same commit is refused under the policy the driver sent before the owned worktrees joined it.
 *
 * Measured against codex-cli 0.162.1: for each writable root Codex binds the root writable, binds
 * its `.git` link read-only over it, and read-only binds a linked worktree's admin directory unless
 * that directory is itself a writable root. The workspace also always includes `/tmp`, so every
 * fixture here lives under HOME instead.
 *
 * Opt-in: it needs a Codex install that can create its Linux sandbox, and skips anywhere else.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import type { SessionConfig } from "@wollipog/protocol";
import { buildCodexTurnParams } from "./drivers/codex-app-server.js";

const CODEX = process.env.CODEX_BIN || "codex";
const COMMITTER = ["-c", "user.email=runner@example.invalid", "-c", "user.name=Runner"];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function adminOf(worktree: string): string {
  const pointer = readFileSync(join(worktree, ".git"), "utf8").replace(/^gitdir: /u, "").trim();
  return realpathSync(resolve(worktree, pointer));
}

interface ExecResult { exitCode: number; stdout: string; stderr: string }

/** A minimal JSON-RPC client for one `codex app-server` started in the selected worktree. */
class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  private next = 1;
  private stderr = "";

  constructor(cwd: string, codexHome: string) {
    mkdirSync(codexHome, { recursive: true });
    this.child = spawn(CODEX, ["app-server"], {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome, TMPDIR: "/tmp" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000); });
    this.child.on("exit", (code) => {
      for (const settle of this.pending.values()) settle({ error: `app-server exited with ${code}: ${this.stderr}` });
      this.pending.clear();
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: { id?: number; result?: unknown; error?: unknown };
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message.id !== "number") return;
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.next++;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`${method} timed out; stderr: ${this.stderr}`)), 60_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) fail(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
        else done(message.result);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async start(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "wollipog-test", version: "0" } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
  }

  async exec(cwd: string, sandboxPolicy: unknown, script: string): Promise<ExecResult> {
    return await this.request("command/exec", { command: ["/bin/sh", "-c", script], cwd, sandboxPolicy }) as ExecResult;
  }

  stop(): void {
    this.child.kill("SIGKILL");
  }
}

test("a Codex sandbox commits in the session's owned second worktree while another session's stays read-only (#3316)", async (t) => {
  if (process.platform !== "linux") return t.skip("the Codex Linux sandbox is Linux-specific");
  const version = spawnSync(CODEX, ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (version.error || version.status !== 0) return t.skip("codex is not installed");

  const base = join(homedir(), ".cache", "wollipog-codex-sandbox-fixtures");
  mkdirSync(base, { recursive: true });
  const root = realpathSync(mkdtempSync(join(base, "owned-")));
  let server: AppServer | undefined;
  try {
    const repoPath = join(root, "repo");
    mkdirSync(repoPath);
    git(repoPath, "init", "--quiet", "--initial-branch=main");
    git(repoPath, ...COMMITTER, "commit", "--quiet", "--allow-empty", "-m", "base");
    const selected = join(root, "worktrees", "s_managed");
    const owned = join(root, "worktrees", "s_managed.requested", "slot");
    const other = join(root, "worktrees", "s_other");
    for (const [branch, path] of [["agent/s_managed", selected], ["stacked", owned], ["agent/s_other", other]] as const) {
      git(repoPath, "worktree", "add", "--quiet", "-b", branch, path, "main");
    }
    const ownedWorktree = { path: owned, gitAdmin: adminOf(owned) };
    const otherAdmin = adminOf(other);
    // The guard list of an Orchestrator names every session's worktrees; the bound set does not.
    const protections = [selected, owned, other].map((worktreePath) => ({ worktreePath, repoPath }));
    const config = { permissionMode: "auto-review" } as SessionConfig;
    const policy = buildCodexTurnParams(config, "t", selected, [], undefined, protections, null, false, [ownedWorktree])
      .sandboxPolicy;
    const before = buildCodexTurnParams(config, "t", selected, [], undefined, protections, null, false).sandboxPolicy;
    assert.deepEqual(policy.writableRoots.slice(-2), [owned, ownedWorktree.gitAdmin]);
    assert.equal(JSON.stringify(policy).includes(other), false);

    server = new AppServer(selected, join(root, "codex-home"));
    await server.start();
    const smoke = await server.exec(selected, policy, "true");
    if (smoke.exitCode !== 0) return t.skip(`codex cannot start its sandbox here: ${smoke.stderr.trim().split("\n").at(-1)}`);

    const commitIn = (path: string, file: string) => [
      `cd ${JSON.stringify(path)}`,
      `printf ${file} > ${file}.txt`,
      `git add ${file}.txt`,
      `git ${COMMITTER.join(" ")} commit --quiet -m ${file}`,
    ].join(" && ");

    const refused = await server.exec(selected, before, commitIn(owned, "before"));
    assert.notEqual(refused.exitCode, 0, "the policy without the owned worktree refuses the commit");
    // A read-only worktree takes nothing, so there is nothing to clean before the real attempt. The
    // fixture's only commit is empty, which also rules out pathspec-based cleanup.
    assert.equal(git(owned, "status", "--porcelain", "--untracked-files=all"), "", "the refused attempt wrote nothing");

    const work = await server.exec(selected, policy, `${commitIn(owned, "owned")} && ${commitIn(selected, "selected")}`);
    assert.equal(work.exitCode, 0, work.stderr);
    assert.equal(git(owned, "log", "--format=%s", "-1"), "owned");
    assert.equal(git(selected, "log", "--format=%s", "-1"), "selected");

    const otherHead = readFileSync(join(otherAdmin, "HEAD"), "utf8");
    const ownedLink = readFileSync(join(owned, ".git"), "utf8");
    for (const script of [
      `printf x > ${JSON.stringify(join(other, "new.txt"))}`,
      `printf x >> ${JSON.stringify(join(otherAdmin, "HEAD"))}`,
      `cd ${JSON.stringify(other)} && git ${COMMITTER.join(" ")} commit --allow-empty --quiet -m escape`,
      `printf x > ${JSON.stringify(join(owned, ".git"))}`,
    ]) {
      const attempted = await server.exec(selected, policy, script);
      assert.notEqual(attempted.exitCode, 0, `${script}: ${attempted.stdout}${attempted.stderr}`);
    }
    assert.equal(existsSync(join(other, "new.txt")), false);
    assert.equal(readFileSync(join(otherAdmin, "HEAD"), "utf8"), otherHead);
    assert.equal(readFileSync(join(owned, ".git"), "utf8"), ownedLink);
    assert.equal(git(other, "log", "--format=%s", "-1"), "base");
  } finally {
    server?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
