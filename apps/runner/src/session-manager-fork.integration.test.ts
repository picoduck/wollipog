import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDriverKind, RunnerToControlPlane } from "@wollipog/protocol";
import type { Driver, DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import { anchorForkRef, captureWorktreeTree } from "./git-ops.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { createWorktree } from "./worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("provider fork preserves exact post-turn files, commit base, and target cwd", async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-fork-repo-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "wollipog-fork-store-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "a.txt"), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const sourceWorktree = await createWorktree(repo, "s_source");
    writeFileSync(join(sourceWorktree.path, "a.txt"), "after turn\n");
    writeFileSync(join(sourceWorktree.path, "new.txt"), "untracked state\n");
    const tree = await captureWorktreeTree(sourceWorktree.path);
    const baseCommit = git(sourceWorktree.path, ["rev-parse", "HEAD"]);
    await anchorForkRef(sourceWorktree.path, "s_source", 1, tree);
    // Move the source branch AFTER the fork point. The target must still use the historical base.
    git(sourceWorktree.path, ["add", "-A"]);
    git(sourceWorktree.path, ["commit", "-q", "-m", "later source commit"]);

    const store = new SessionStore(storeRoot);
    const source: SessionMeta = {
      sessionId: "s_source",
      agentId: "codex-native",
      workspaceId: "workspace",
      repoPath: repo,
      worktreePath: sourceWorktree.path,
      driver: "codex-app-server",
      command: "codex",
      args: [],
      env: {},
      context: { kind: "native" },
      agentSessionId: "thread-source",
      status: "idle",
      title: "source",
      config: {},
      tokensIn: 1,
      tokensOut: 2,
      costUsd: 0,
      preview: null,
      pendingApproval: null,
      turnCount: 1,
      forkPoints: { "1": { agentTurnId: "turn-1", tree, baseCommit, eventSeq: 3 } },
      seq: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    store.create(source);
    store.appendEvent("s_source", { kind: "user_message", text: "change it" });
    store.appendEvent("s_source", { kind: "token_usage", inputTokens: 1, outputTokens: 2 });
    store.appendEvent("s_source", { kind: "conversation_checkpoint", turn: 1 });
    store.flush("s_source");

    let forkCwd = "";
    const forkSources: string[] = [];
    const archivedForks: string[] = [];
    let racedPrompts = 0;
    let manager!: SessionManager;
    const factory = (_kind: AgentDriverKind, options: DriverOptions, _callbacks: DriverCallbacks): Driver => ({
      get pid() { return undefined; },
      initialize: async () => {},
      newSession: async () => options.resumeId ?? "",
      agentSessionId: () => options.resumeId ?? null,
      forkSession: async (_turn, cwd) => {
        forkCwd = cwd;
        forkSources.push(_turn);
        manager.prompt("s_source", "must not race the fork");
        return "thread-forked";
      },
      archiveSession: async (sessionId) => { archivedForks.push(sessionId); },
      prompt: async () => { racedPrompts++; return "end_turn"; },
      setConfig: () => {},
      cancel: () => {},
      resolvePermission: () => false,
      dispose: () => {},
    });
    const sent: RunnerToControlPlane[] = [];
    const stateTransfers: Array<{ source: string; target: string }> = [];
    const stateRemovals: string[] = [];
    const verifiedForks: string[] = [];
    let claudeCatalogPreparations = 0;
    manager = new SessionManager(
      (message) => sent.push(message), () => {}, store, "runner", undefined, factory,
      undefined, 4, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "inherit" }, async () => undefined,
      async (_policy, _context, _driver, _dataDir, source, target) => {
        stateTransfers.push({ source, target });
        if (target === "s_target") {
          // Force the hourly/startup reconciliation path into the exact window where the cleanup
          // journal exists but the target store row does not. It must not reap the in-flight fork.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (manager as any).reconcileProviderStateStorage();
        }
        if (target === "s_clone_fail") throw new Error("copy interrupted");
      },
      async (_policy, _context, _driver, _dataDir, sessionId) => { stateRemovals.push(sessionId); },
      async () => {},
      async (_policy, _context, _driver, _dataDir, _sourceSessionId, providerSessionId) => {
        verifiedForks.push(providerSessionId);
      },
      [],
      (launchMeta) => {
        if (launchMeta.driver !== "claude-code") return;
        claudeCatalogPreparations++;
        // Discovery returns fresh objects on every scan. Only the first semantic change should
        // publish a source-session runtime update; identical later refreshes stay quiet.
        launchMeta.sessionSlashCommands = [{
          name: "refreshed",
          source: "project",
          description: "Refreshed before provider fork",
        }];
      },
    );
    const result = await manager.forkConversation("s_source", "s_target", 1, "source (fork)", true);
    assert.equal(result.ok, true, result.error);
    const target = store.readMeta("s_target")!;
    assert.equal(target.agentSessionId, "thread-forked");
    assert.equal(target.preview, null);
    assert.equal(target.forkPoints?.["1"]?.eventSeq, 2, "fork point is re-based to the child's event seq space");
    assert.equal(racedPrompts, 0, "a prompt arriving during fork setup is fenced");
    assert.match(
      (store.readEvents("s_source").at(-1)?.payload as { message?: string }).message ?? "",
      /conversation fork is in progress/,
    );
    assert.equal(forkCwd, target.worktreePath);
    assert.equal(readFileSync(join(target.worktreePath!, "a.txt"), "utf8"), "after turn\n");
    assert.equal(readFileSync(join(target.worktreePath!, "new.txt"), "utf8"), "untracked state\n");
    assert.equal(git(target.worktreePath!, ["rev-parse", "HEAD"]), baseCommit);
    assert.notEqual(git(target.worktreePath!, ["rev-parse", "HEAD"]), git(sourceWorktree.path, ["rev-parse", "HEAD"]));
    assert.equal(result.events, undefined, "v54 deferHistory omits the potentially unbounded wire array");
    assert.deepEqual(store.readEvents("s_target").map((event) => event.payload.kind), [
      "user_message",
      "conversation_checkpoint",
      "conversation_forked",
    ]);
    assert.deepEqual(stateTransfers, [{ source: "s_source", target: "s_target" }]);
    assert.deepEqual(stateRemovals, [], "reconciliation cannot delete an in-flight fork partition");
    assert.deepEqual(verifiedForks, ["thread-forked"]);

    // Claude uses the same provider-neutral operation, but its CLI can fork only the current
    // transcript. Older checkpoint buttons remain files-only rewind targets.
    const claudeSource: SessionMeta = {
      ...source,
      sessionId: "s_claude_source",
      driver: "claude-code",
      agentId: "claude-code",
      agentSessionId: "claude-source-uuid",
      capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
        supportsConversationFork: true,
      },
      sessionSlashCommands: [{ name: "source-only", source: "project" }],
      sessionSlashCommandProvenance: {
        driver: "claude-code",
        context: "native",
        root: sourceWorktree.path,
        targetAdapter: "host",
        targetId: null,
        includeUserCommands: true,
        handoffManifestDigest: null,
      },
      providerCredentialScopeId: "scope-a",
      providerCredentialIdentityId: "account-a",
      providerAuthBlock: {
        version: 1,
        recoveryId: "source-recovery",
        credentialScopeId: "scope-a",
        detectedAt: 1,
        phase: "launch",
        delivery: "not_delivered",
        canStartLogin: false,
        configuredCredential: false,
        expectedIdentityId: "account-a",
        retry: { text: "must stay with source", images: [] },
      },
      providerAuthRetryAttemptedRecoveryId: "prior-recovery",
      turnCount: 2,
      forkPoints: {
        "1": { agentTurnId: "claude-source-uuid", tree, baseCommit, eventSeq: 2 },
        "2": { agentTurnId: "claude-source-uuid", tree, baseCommit, eventSeq: 4 },
      },
      seq: 0,
    };
    store.create(claudeSource);
    store.appendEvent("s_claude_source", { kind: "user_message", text: "first" });
    store.appendEvent("s_claude_source", { kind: "conversation_checkpoint", turn: 1 });
    store.appendEvent("s_claude_source", { kind: "user_message", text: "second" });
    store.appendEvent("s_claude_source", { kind: "conversation_checkpoint", turn: 2 });
    store.flush("s_claude_source");
    const historical = await manager.forkConversation("s_claude_source", "s_claude_old", 1, "old");
    assert.equal(historical.ok, false);
    assert.match(historical.error ?? "", /current transcript/);

    const claudeFork = await manager.forkConversation("s_claude_source", "s_claude_target", 2, "claude fork");
    assert.equal(claudeFork.ok, true, claudeFork.error);
    const claudeTarget = store.readMeta("s_claude_target")!;
    assert.equal(claudeTarget.driver, "claude-code");
    assert.equal(claudeTarget.agentSessionId, "thread-forked");
    assert.equal(claudeTarget.sessionSlashCommands, undefined);
    assert.equal(claudeTarget.sessionSlashCommandProvenance, undefined);
    assert.equal(claudeTarget.providerCredentialScopeId, undefined);
    assert.equal(claudeTarget.providerCredentialIdentityId, undefined);
    assert.equal(claudeTarget.providerAuthBlock, undefined);
    assert.equal(claudeTarget.providerAuthRetryAttemptedRecoveryId, undefined);
    assert.equal(forkSources.at(-1), "claude-source-uuid");
    assert.deepEqual(claudeFork.events?.map((event) => event.payload.kind), [
      "user_message",
      "user_message",
      "conversation_checkpoint",
      "conversation_forked",
    ]);
    assert.deepEqual(stateTransfers, [
      { source: "s_source", target: "s_target" },
      { source: "s_claude_source", target: "s_claude_target" },
    ]);
    assert.deepEqual(verifiedForks, ["thread-forked", "thread-forked"]);
    assert.deepEqual(store.readMeta("s_claude_source")?.sessionSlashCommands, [{
      name: "refreshed",
      source: "project",
      description: "Refreshed before provider fork",
    }]);
    assert.equal(
      sent.filter((message) => message.type === "session_runtime_updated" &&
        message.snapshot.id === "s_claude_source").length,
      1,
      "the changed source catalog is persisted and published once",
    );
    const failedTransfer = await manager.forkConversation("s_claude_source", "s_clone_fail", 2, "copy failure");
    assert.equal(failedTransfer.ok, false);
    assert.match(failedTransfer.error ?? "", /copy interrupted/);
    assert.equal(claudeCatalogPreparations, 2);
    assert.equal(
      sent.filter((message) => message.type === "session_runtime_updated" &&
        message.snapshot.id === "s_claude_source").length,
      1,
      "an equal rediscovered catalog does not publish a redundant runtime update",
    );
    assert.equal(store.has("s_clone_fail"), false);
    assert.deepEqual(archivedForks, ["thread-forked"]);
    assert.deepEqual(stateRemovals, ["s_clone_fail"]);

    // Fail after the target fork ref has been anchored. Cleanup must remove both namespace pins
    // even though the target store row and worktree are also rolled back.
    const appendEvent = store.appendEvent.bind(store);
    let postAnchorWorktree = "";
    store.appendEvent = ((sessionId, payload, ts) => {
      if (sessionId === "s_post_anchor_fail" && payload.kind === "conversation_checkpoint") {
        postAnchorWorktree = store.readMeta(sessionId)?.worktreePath ?? "";
        assert.equal(git(repo, ["rev-parse", "refs/mam/s_post_anchor_fail/fork-2"]), tree);
        assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_post_anchor_fail/fork-2"]), tree);
        throw new Error("post-anchor copy interrupted");
      }
      return appendEvent(sessionId, payload, ts);
    }) as SessionStore["appendEvent"];
    const failedAfterAnchor = await manager.forkConversation(
      "s_claude_source", "s_post_anchor_fail", 2, "post-anchor failure",
    );
    store.appendEvent = appendEvent;
    assert.equal(failedAfterAnchor.ok, false);
    assert.match(failedAfterAnchor.error ?? "", /post-anchor copy interrupted/);
    assert.equal(store.has("s_post_anchor_fail"), false);
    assert.equal(postAnchorWorktree ? existsSync(postAnchorWorktree) : true, false);
    assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", "refs/mam/s_post_anchor_fail/"]), "");
    assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", "refs/wollipog/s_post_anchor_fail/"]), "");
    assert.deepEqual(archivedForks, ["thread-forked", "thread-forked"]);
    assert.deepEqual(stateRemovals, ["s_clone_fail", "s_post_anchor_fail"]);
    // A later cancelled/refused turn advances Claude's current transcript without producing a
    // conversation checkpoint. The older file tree must not be paired with that newer transcript.
    store.patchMeta("s_claude_source", { turnCount: 3 });
    store.appendEvent("s_claude_source", { kind: "checkpoint", turn: 3 });
    const afterCancelled = await manager.forkConversation(
      "s_claude_source", "s_claude_after_cancel", 2, "after cancel",
    );
    assert.equal(afterCancelled.ok, false);
    assert.match(afterCancelled.error ?? "", /current transcript/);
    await manager.delete("s_target");
    await manager.delete("s_claude_target");
    assert.deepEqual(stateRemovals, ["s_clone_fail", "s_post_anchor_fail", "s_target", "s_claude_target"]);
    manager.shutdownAll();
    git(repo, ["worktree", "remove", "--force", sourceWorktree.path]);
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
