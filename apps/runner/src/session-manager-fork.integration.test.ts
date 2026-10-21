import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION, type AgentDefinition, type AgentDriverKind, type RunnerToControlPlane } from "@wollipog/protocol";
import type { Driver, DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import { anchorForkRef, captureWorktreeTree } from "./git-ops.js";
import { isolateFromAmbientIgnores } from "./git-test-repo.js";
import { type LaunchPreparationCancellation, SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { ShellManager } from "./shell-manager.js";
import { createWorktree } from "./worktree.js";
import { runFixtureCleanup, terminateOriginalProcess, waitForLiveProcessPidFile, waitForOriginalProcessToStop, type PosixProcessIdentity } from "../test-support/posix-process.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

for (const needsSetupTrust of [false, true]) {
  test(`an in-place handoff preserves current files and source history (setup trust: ${needsSetupTrust})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "wollipog-in-place-handoff-"));
    const repo = join(root, "repo");
    git(root, ["init", "-q", repo]);
    isolateFromAmbientIgnores(repo);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "tracked.txt"), "base");
    writeFileSync(join(repo, "deleted.txt"), "base");
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\nforced.txt\n");
    if (needsSetupTrust) writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
      version: 1, environment: { HANDOFF_TEST: "trusted" }, setup: [],
    }));
    git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]);
    const store = new SessionStore(join(root, "sessions"));
    const source: SessionMeta = {
      sessionId: "s_in_place", agentId: "codex", workspaceId: "source-workspace", repoPath: repo,
      worktreePath: null, driver: "codex-app-server", command: "source", args: [], env: {},
      context: { kind: "native" }, agentSessionId: "source-thread", status: "idle", title: "In Place",
      config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
      turnCount: 0, seq: 0, createdAt: 1, updatedAt: 1,
    };
    store.create(source);
    store.appendEvent(source.sessionId, { kind: "user_message", text: "Selected task", final: true });
    store.appendEvent(source.sessionId, { kind: "agent_message", text: "Preliminary answer", final: true });
    store.appendEvent(source.sessionId, { kind: "user_message", text: "Selected steer", final: true, deliveryIntent: "steer" });
    store.appendEvent(source.sessionId, { kind: "agent_message", text: "Selected answer", final: true });
    store.appendEvent(source.sessionId, { kind: "agent_response_completed" });
    store.appendEvent(source.sessionId, { kind: "user_message", text: "Later excluded dialogue", final: true });
    store.appendEvent(source.sessionId, { kind: "agent_message", text: "Later partial answer", final: true });
    store.appendEvent(source.sessionId, { kind: "turn_interrupted" });
    store.flush(source.sessionId);
    // Commits and file edits after the selected dialogue must travel, unlike a worktree checkpoint.
    writeFileSync(join(repo, "later-commit.txt"), "committed after selected turn");
    git(repo, ["add", "."]); git(repo, ["commit", "-qm", "later commit"]);
    writeFileSync(join(repo, "tracked.txt"), "staged"); git(repo, ["add", "tracked.txt"]);
    writeFileSync(join(repo, "tracked.txt"), "working copy");
    writeFileSync(join(repo, "untracked.txt"), "carry me");
    writeFileSync(join(repo, "ignored.txt"), "leave me");
    writeFileSync(join(repo, "forced.txt"), "tracked despite ignore"); git(repo, ["add", "-f", "forced.txt"]);
    rmSync(join(repo, "deleted.txt"));
    const head = git(repo, ["rev-parse", "HEAD"]);
    const branch = git(repo, ["symbolic-ref", "HEAD"]);
    const index = readFileSync(join(repo, ".git", "index"));
    const history = JSON.stringify(store.readEvents(source.sessionId));
    const destination: AgentDefinition = {
      id: "claude", name: "Claude", command: "destination", args: [], env: {},
      driver: "claude-code", authStatus: "authenticated", available: true,
      capabilities: { models: [{ id: "test" }], effortLevels: [], permissionModes: [], slashCommands: [],
        supportsImages: true, supportsApprovals: true },
    };
    let setupTrustRequests = 0;
    const manager = new SessionManager((message) => {
      if (message.type === "session_event" && message.sessionId === source.sessionId &&
          message.payload.kind === "permission_request" && message.payload.context?.toolName === "wollipog.worktree_setup") {
        setupTrustRequests++;
        setImmediate(() => manager.resolvePermission(source.sessionId, message.payload.requestId, "trust"));
      }
    }, () => {}, store, "runner", undefined,
      () => { throw new Error("handoff must not launch a provider"); }, root);
    try {
      const request = { agent: destination, config: { model: "test" } };
      const native = await manager.forkConversation(source.sessionId, "s_native", 1, "Native");
      assert.match(native.error!, /requires a worktree/);
      const missing = await manager.forkConversation(source.sessionId, "s_missing", 999, "Missing", false, request);
      assert.equal(missing.ok, false);
      store.patchMeta(source.sessionId, { status: "running" });
      const busy = await manager.forkConversation(source.sessionId, "s_busy", 1, "Busy", false, request);
      assert.match(busy.error!, /busy/);
      store.patchMeta(source.sessionId, { status: "idle" });
      const result = await manager.forkConversation(source.sessionId, "s_current_files", 1, "Current Files", false, request);
      assert.equal(result.ok, true, result.error);
      const target = store.readMeta("s_current_files")!;
      assert.equal(target.workspaceId, source.workspaceId);
      assert.equal(target.repoPath, repo);
      assert.notEqual(target.worktreePath, repo);
      assert.equal(git(target.worktreePath!, ["rev-parse", "HEAD"]), head);
      for (const [file, text] of Object.entries({ "tracked.txt": "working copy", "untracked.txt": "carry me",
        "forced.txt": "tracked despite ignore", "later-commit.txt": "committed after selected turn" })) {
        assert.equal(readFileSync(join(target.worktreePath!, file), "utf8"), text);
      }
      assert.equal(existsSync(join(target.worktreePath!, "ignored.txt")), false);
      assert.equal(existsSync(join(target.worktreePath!, "deleted.txt")), false);
      assert.match(result.handoffDraft!.text, /Selected task[\s\S]*Selected steer[\s\S]*Selected answer/);
      assert.doesNotMatch(result.handoffDraft!.text, /Later excluded|Later partial/);
      assert.match(result.handoffDraft!.disclosure, /Files reflect the repository at hand-off time, not the selected turn/);
      assert.match(result.handoffDraft!.disclosure, /ignored untracked files are left out/);
      assert.doesNotMatch(result.handoffDraft!.text, /Checkpoint handoff|checkpoint event/);
      assert.match(result.handoffDraft!.disclosure, /1 event or message omitted/);
      assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
      assert.equal(git(repo, ["symbolic-ref", "HEAD"]), branch);
      assert.deepEqual(readFileSync(join(repo, ".git", "index")), index);
      assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "working copy");
      assert.equal(readFileSync(join(repo, "ignored.txt"), "utf8"), "leave me");
      const sourceEvents = store.readEvents(source.sessionId);
      const originalEvents = JSON.parse(history) as typeof sourceEvents;
      assert.deepEqual(sourceEvents.slice(0, originalEvents.length), originalEvents,
        "source dialogue, turn boundaries and checkpoint history are never rewritten");
      const appended = sourceEvents.slice(originalEvents.length).map((event) => event.payload);
      assert.deepEqual(appended.map((payload) => payload.kind), needsSetupTrust
        ? ["permission_request", "permission_resolved"] : [],
      "only existing setup-trust audit events may be appended to the source");
      assert.equal(setupTrustRequests, needsSetupTrust ? 1 : 0);
      if (needsSetupTrust) {
        assert.equal(target.worktrees?.[0]?.setup?.status, "completed");
        assert.equal(appended[0]?.kind === "permission_request" && appended[0].context?.toolName, "wollipog.worktree_setup");
        assert.equal(appended[1]?.kind === "permission_resolved" && appended[1].optionId, "trust");
        assert.equal(store.readMeta(source.sessionId)?.status, "idle");
        const approvedHistory = JSON.stringify(sourceEvents);
        const trusted = await manager.forkConversation(source.sessionId, "s_already_trusted", 1, "Already Trusted", false, request);
        assert.equal(trusted.ok, true, trusted.error);
        assert.equal(setupTrustRequests, 1, "already trusted setup never requests trust again");
        assert.equal(JSON.stringify(store.readEvents(source.sessionId)), approvedHistory,
          "already trusted setup appends nothing to source history");
        await manager.delete("s_already_trusted");
      }
      assert.equal(store.readMeta(source.sessionId)?.forkPoints, undefined);
      store.patchMeta(source.sessionId, { status: "stopped" });
      const beforeStopped = JSON.stringify(store.readEvents(source.sessionId));
      const stopped = await manager.forkConversation(source.sessionId, "s_stopped_files", 2, "Stopped Files", false, request);
      assert.equal(stopped.ok, true, stopped.error);
      assert.match(stopped.handoffDraft!.text, /Later partial answer/);
      assert.equal(JSON.stringify(store.readEvents(source.sessionId)), beforeStopped);
      await manager.delete("s_stopped_files");
      store.appendEvent(source.sessionId, { kind: "user_message", text: "Guardrail task", final: true });
      store.appendEvent(source.sessionId, { kind: "agent_message", text: "Partial guardrail work", final: true });
      store.appendEvent(source.sessionId, { kind: "stderr", text: "Runner governance paused this turn at the cost threshold." });
      store.patchMeta(source.sessionId, { status: "idle" });
      const beforeGuardrail = JSON.stringify(store.readEvents(source.sessionId));
      const guardrail = await manager.forkConversation(source.sessionId, "s_guardrail_files", 3, "Guardrail Files", false, request);
      assert.equal(guardrail.ok, true, guardrail.error);
      assert.match(guardrail.handoffDraft!.text, /Partial guardrail work/);
      assert.equal(JSON.stringify(store.readEvents(source.sessionId)), beforeGuardrail);
      await manager.delete("s_guardrail_files");
      await manager.delete(target.sessionId);
    } finally { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); }
  });
}

for (const sourceDriver of ["codex-app-server", "claude-code"] as const) {
  test(`${sourceDriver} checkpoint hands exact files to a fresh opposite provider only after Send`, async () => {
    const root = mkdtempSync(join(tmpdir(), "wollipog-handoff-"));
    const repo = join(root, "repo");
    git(root, ["init", "-q", repo]);
    isolateFromAmbientIgnores(repo);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "file.txt"), "base");
    writeFileSync(join(repo, ".gitignore"), ".fork-setup\n");
    writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
      version: 1,
      environment: { FORK_SETUP_ENV: "from-checkpoint" },
      setup: [{
        name: "Prepare Fork",
        command: [process.execPath, "-e", "require('fs').writeFileSync('.fork-setup',process.env.FORK_SETUP_ENV)"],
        timeoutSeconds: 10,
      }],
    }));
    git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]);
    const worktree = await createWorktree(repo, "s_handoff_source", { dataDir: root });
    writeFileSync(join(worktree.path, "file.txt"), "checkpoint");
    const tree = await captureWorktreeTree(worktree.path);
    const baseCommit = git(worktree.path, ["rev-parse", "HEAD"]);
    writeFileSync(join(worktree.path, "file.txt"), "later source state");
    const store = new SessionStore(join(root, "sessions"));
    const source: SessionMeta = {
      sessionId: "s_handoff_source", agentId: sourceDriver, workspaceId: "workspace", repoPath: repo,
      worktreePath: worktree.path, driver: sourceDriver, command: "source", args: ["--private-source"],
      env: { SECRET: "source-private-value" }, context: { kind: "native" }, agentSessionId: "private-provider-id",
      status: "stopped", title: "Source", config: {}, tokensIn: 123, tokensOut: 456, costUsd: 9,
      preview: null, pendingApproval: null, turnCount: 3, seq: 0, createdAt: 1, updatedAt: 1,
      forkPoints: { "1": { tree, baseCommit, agentTurnId: "private-turn-id", eventSeq: 3 } },
      claudeUsageCheckpoint: { sessionId: "source-conversation", totalCostUsd: 0.5, models: {}, accountingScope: "process" },
      claudeUsageCheckpointSeq: 99,
    };
    store.create(source);
    store.appendEvent(source.sessionId, { kind: "user_message", text: "Keep the checkpoint", final: true });
    store.appendEvent(source.sessionId, { kind: "agent_message", text: "Kept the checkpoint", final: true });
    store.appendEvent(source.sessionId, { kind: "conversation_checkpoint", turn: 1 });
    store.appendEvent(source.sessionId, { kind: "user_message", text: "later excluded", final: true });
    store.flush(source.sessionId);
    const before = JSON.stringify(store.readMeta(source.sessionId));
    const destination: AgentDefinition = {
      id: "destination", name: "Destination", command: "destination", args: [], env: { OWN_AUTH: "independent" },
      driver: sourceDriver === "claude-code" ? "codex-app-server" : "claude-code", authStatus: "authenticated", available: true,
      capabilities: { models: [{ id: "test-model" }], effortLevels: ["high"], permissionModes: ["default"], slashCommands: [], supportsImages: true, supportsApprovals: true },
    };
    let launches = 0;
    let prompts = 0;
    let launchedOptions: DriverOptions | undefined;
    let establishedId: string | null = null;
    const factory = (_driver: AgentDriverKind, options: DriverOptions): Driver => {
      launches++; launchedOptions = options;
      return {
        initialize: async () => {}, newSession: async () => { establishedId = "destination-fresh-id"; return establishedId; },
        agentSessionId: () => establishedId, prompt: async () => { prompts++; return "end_turn"; },
        setConfig: () => {}, cancel: () => {}, resolvePermission: () => false, dispose: () => {},
      };
    };
    let manager!: SessionManager;
    let setupTrustRequests = 0;
    manager = new SessionManager((message) => {
      if (message.type === "session_event" && message.payload.kind === "permission_request" &&
          message.payload.context?.toolName === "wollipog.worktree_setup") {
        setupTrustRequests++;
        setImmediate(() => manager.resolvePermission(source.sessionId, message.payload.requestId, "trust"));
      }
    }, () => {}, store, "runner", undefined, factory, root);
    try {
      const request = { agent: destination, config: { model: "test-model", effort: "high", permissionMode: "default" } };
      const noPoint = await manager.forkConversation(source.sessionId, "s_no_stopped_point", 3, "No Checkpoint", false, request);
      assert.equal(noPoint.ok, false);
      assert.match(noPoint.error!, /no provider fork checkpoint/,
        "stopping a worktree session does not synthesize a checkpoint for a cancelled turn");
      const creating = manager.forkConversation(source.sessionId, "s_handoff_child", 1, "Handoff", false, request);
      const duplicate = await manager.forkConversation(source.sessionId, "s_duplicate", 1, "Duplicate", false, request);
      assert.equal(duplicate.ok, false); assert.match(duplicate.error!, /already in progress/);
      const result = await creating;
      assert.equal(result.ok, true, result.error);
      assert.equal(launches, 0); assert.equal(prompts, 0);
      const child = store.readMeta("s_handoff_child")!;
      assert.equal(child.worktrees?.[0]?.setup?.status, "completed");
      assert.equal(readFileSync(join(child.worktreePath!, ".fork-setup"), "utf8"), "from-checkpoint");
      assert.equal(setupTrustRequests, 1);
      assert.equal(child.driver, destination.driver); assert.equal(child.agentSessionId, null);
      assert.equal(child.turnCount, 0); assert.deepEqual(child.env, {}); assert.deepEqual(child.args, []);
      assert.equal(child.tokensIn, 0); assert.equal(child.costUsd, 0);
      assert.deepEqual([child.claudeUsageCheckpoint, child.claudeUsageCheckpointSeq], [undefined, undefined],
        "the fork renumbers its history, so a source accounting cursor would hide its first live requests");
      assert.equal(readFileSync(join(child.worktreePath!, "file.txt"), "utf8"), "checkpoint");
      assert.equal(git(child.worktreePath!, ["rev-parse", "HEAD"]), baseCommit);
      assert.equal(readFileSync(join(worktree.path, "file.txt"), "utf8"), "later source state");
      const after = store.readMeta(source.sessionId)!;
      const stableMeta = (value: typeof after) => JSON.parse(JSON.stringify({ ...value, seq: 0, updatedAt: 0,
        historyTurnAnchor: value.historyTurnAnchor ? { ...value.historyTurnAnchor, throughSeq: 0 } : undefined }));
      const sourcePage = store.readEventPageForProtocol(source.sessionId, { afterSeq: 0, limit: 1 }, PROTOCOL_VERSION);
      assert.ok(sourcePage.ok);
      assert.equal(after.historyTurnAnchor?.throughSeq, sourcePage.page.throughSeq,
        "derived anchor advances only through the source's actual append log");
      assert.deepEqual(stableMeta(after), stableMeta(JSON.parse(before)));
      assert.match(result.handoffDraft!.text, /Keep the checkpoint/);
      assert.doesNotMatch(result.handoffDraft!.text, /later excluded|private-provider-id|source-private-value/);
      assert.ok(result.events?.some((event) => event.payload.kind === "command_output" &&
        event.payload.text.includes("[Worktree Setup — Prepare Fork]")));
      const boundary = result.events!.find((event) => event.payload.kind === "conversation_forked")!.payload;
      assert.equal(boundary.kind, "conversation_forked");
      if (boundary.kind === "conversation_forked") assert.deepEqual([boundary.sourceSessionId, boundary.turn, boundary.handoff?.destinationAgent], [source.sessionId, 1, destination.id]);
      const unauthenticated = await manager.forkConversation(source.sessionId, "s_no_auth", 1, "No Auth", false,
        { ...request, agent: { ...destination, authStatus: "unauthenticated" } });
      assert.equal(unauthenticated.ok, false); assert.match(unauthenticated.error!, /authenticate/); assert.equal(store.has("s_no_auth"), false);
      store.patchMeta(source.sessionId, { status: "queued" });
      const queued = await manager.forkConversation(source.sessionId, "s_busy", 1, "Busy", false, request);
      assert.equal(queued.ok, false); assert.match(queued.error!, /busy|queued/);
      store.patchMeta(source.sessionId, { status: "idle" });
      const cancelled = manager.forkConversation(source.sessionId, "s_cancelled_handoff", 1, "Cancelled", false, request);
      await manager.delete("s_cancelled_handoff");
      const cancelledResult = await cancelled;
      assert.equal(cancelledResult.ok, false); assert.match(cancelledResult.error!, /canceled/);
      assert.equal(store.has("s_cancelled_handoff"), false);
      assert.doesNotMatch(git(repo, ["worktree", "list", "--porcelain"]), /s_cancelled_handoff/);
      assert.equal(launches, 0, "rejected and cancelled handoffs cannot initialize providers");
      manager.prompt(child.sessionId, result.handoffDraft!.text);
      for (let attempt = 0; attempt < 200 && !prompts; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(prompts, 1); assert.equal(launches, 1); assert.equal(launchedOptions?.resumeId, undefined);
      assert.equal(launchedOptions?.env.FORK_SETUP_ENV, "from-checkpoint");
      assert.equal(store.readMeta(child.sessionId)?.handoffPending, undefined);
      await manager.delete(child.sessionId);
    } finally { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("provider fork preserves exact post-turn files, commit base, and target cwd", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-fork-repo-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "wollipog-fork-store-"));
  try {
    git(repo, ["init", "-q"]);
    isolateFromAmbientIgnores(repo);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "a.txt"), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const sourceWorktree = await createWorktree(repo, "s_source", { dataDir: storeRoot });
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
      costReconciliationRevision: 1,
      costReconciliationDeltaUsd: -1,
      status: "idle",
      title: "source",
      config: {},
      tokensIn: 1,
      tokensOut: 2,
      costUsd: 0,
      ratePricedUsage: [{ inputTokens: 1, netInputTokens: 1, outputTokens: 2, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 }],
      preview: null,
      pendingApproval: null,
      worktreeHooks: {
        legacy: { configHash: "source-only-config", environment: {}, teardown: [] },
      },
      worktreeProcessMarkers: { legacy: "source-only-process-marker" },
      providerAccountId: "work",
      providerAccountLabel: "Work",
      providerAccountProvider: "codex",
      providerCredentialHome: "/accounts/work",
      pendingProviderAccountId: "personal",
      pendingProviderAccountLabel: "Personal",
      pendingProviderAccountProvider: "codex",
      pendingProviderCredentialHome: "/accounts/personal",
      providerAccountSwitchFailure: {
        providerAccountId: "personal",
        providerAccountLabel: "Personal",
        reason: "the provider could not resume this conversation with the selected account",
        detectedAt: 1,
      },
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
    let piInitializations = 0;
    let racedPrompts = 0;
    let constructions = 0;
    let preparationWait: (() => Promise<void>) | undefined;
    // Stands in for the `index.ts` adapter's account-HOME acquisition (#3238).
    let preparationHook: ((cancellation?: LaunchPreparationCancellation) => Promise<void>) | undefined;
    // What the fake Claude fork reports to forkSession's process observer (#3238): a tree proof,
    // or nothing at all, as a driver without the observer would.
    let claudeForkProcessReport: boolean | "none" = "none";
    const claudeForkObserverOffered: boolean[] = [];
    const claudeForkBoundaries: Array<{ sourceSessionId: string; cwd: string; protectedPath?: string }> = [];
    const claudeIsolationState: Array<{ sessionId: string; cwd: string; protectedPath?: string }> = [];
    let manager!: SessionManager;
    const factory = (kind: AgentDriverKind, options: DriverOptions, _callbacks: DriverCallbacks): Driver => {
      constructions++;
      return ({
      get pid() { return undefined; },
      initialize: async () => {
        if (kind === "pi") piInitializations++;
        if (kind === "codex-app-server") assert.deepEqual(options.args, ["-c", "plugins.review@local.enabled=true"],
          "temporary fork providers must receive the prepared plugin and guard argv");
      },
      newSession: async () => options.resumeId ?? "",
      agentSessionId: () => options.resumeId ?? null,
      forkSession: async (_turn, cwd, forkOptions) => {
        forkCwd = cwd;
        forkSources.push(_turn);
        if (kind === "claude-code") {
          claudeForkObserverOffered.push(typeof forkOptions?.onProcess === "function");
          if (claudeForkProcessReport !== "none") forkOptions?.onProcess?.(Promise.resolve(claudeForkProcessReport));
          assert.equal(forkOptions?.isolation?.backend, "bwrap");
          if (forkOptions?.isolation?.backend === "bwrap") {
            assert.equal(forkOptions.isolation.protectedWorktree?.path,
              process.platform === "linux" ? cwd : undefined);
            claudeForkBoundaries.push({
              sourceSessionId: options.resumeId ?? "",
              cwd,
              protectedPath: forkOptions.isolation.protectedWorktree?.path,
            });
          }
        }
        manager.prompt(options.resumeId === "pi-source-session" ? "s_pi_source" : "s_source", "must not race the fork");
        return "thread-forked";
      },
      archiveSession: async (sessionId) => { archivedForks.push(sessionId); },
      prompt: async () => { racedPrompts++; return "end_turn"; },
      setConfig: () => {},
      cancel: () => {},
      resolvePermission: () => false,
      dispose: () => {},
      });
    };
    const sent: RunnerToControlPlane[] = [];
    const stateTransfers: Array<{ source: string; target: string }> = [];
    const stateRemovals: string[] = [];
    const verifiedForks: string[] = [];
    let claudeCatalogPreparations = 0;
    manager = new SessionManager(
      (message) => sent.push(message), () => {}, store, "runner", undefined, factory,
      storeRoot, 4, undefined, undefined, { agentLimits: {}, agentWeights: {} },
      { mode: "bwrap", network: "inherit" }, async (_policy, _context, _deps, state) => {
        if (state?.driver !== "claude-code") return undefined;
        claudeIsolationState.push({
          sessionId: state.sessionId,
          cwd: state.cwd,
          protectedPath: state.protectedWorktree?.path,
        });
        return {
          backend: "bwrap" as const,
          command: "/usr/bin/bwrap", args: [], network: "inherit" as const,
          ...(state.protectedWorktree ? { protectedWorktree: {
            parent: dirname(state.protectedWorktree.path),
            path: state.protectedWorktree.path,
            gitWritableRoots: state.protectedWorktree.gitWritableRoots,
          } } : {}),
        };
      },
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
      async (launchMeta, cancellation) => {
        await preparationWait?.();
        await preparationHook?.(cancellation);
        if (launchMeta.driver === "codex-app-server") {
          return { codexLaunchArgs: ["-c", "plugins.review@local.enabled=true"] };
        }
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
    assert.equal(target.costReconciliationRevision, undefined, "a fork has its own accounting ledger");
    assert.equal(target.costReconciliationDeltaUsd, undefined);
    assert.deepEqual(target.ratePricedUsage, [], "a fork counts its own rate-priced usage from zero, never its source's");
    manager.syncPricedSessionCost("s_target", 0.01);
    assert.equal(store.readMeta("s_target")!.costUsd, 0.01, "ordinary priced acknowledgements are accepted by the fork");
    assert.equal(store.readMeta("s_target")!.acknowledgedCostUsd, 0.01, "the acknowledged price travels with rate-priced entries");
    assert.equal(target.preview, null);
    assert.equal(target.pendingProviderAccountId, undefined,
      "a fork never inherits the source's account-switch request");
    assert.equal(target.pendingProviderAccountLabel, undefined);
    assert.equal(target.pendingProviderAccountProvider, undefined);
    assert.equal(target.pendingProviderCredentialHome, undefined);
    assert.equal(target.providerAccountSwitchFailure, undefined,
      "a fork never inherits the source's account-switch failure");
    assert.equal(target.worktreeHooks, undefined, "a fork never inherits the source worktree's teardown identity");
    assert.ok(target.worktreeProcessMarkers?.legacy, "fork setup stamps its own process boundary");
    assert.notEqual(
      target.worktreeProcessMarkers.legacy,
      source.worktreeProcessMarkers?.legacy,
      "a fork never inherits the source process boundary",
    );
    assert.equal(target.worktrees, undefined, "a no-config fork keeps its canonical legacy attribution implicit");
    if (process.platform !== "win32") {
      const shellManager = new ShellManager({ onOutput: () => {}, onExit: () => {} });
      const pidFile = join(storeRoot, "fork-shell-descendant.pid");
      let detachedIdentity: PosixProcessIdentity | undefined;
      let shellBodyCompleted = false;
      try {
        const childSource = [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
          "writeFileSync(process.argv[1], String(child.pid) + '\\n');",
          "child.unref();",
          "setInterval(() => {}, 1000);",
        ].join(" ");
        const cleanupBoundary = manager.worktreeShellCleanupBoundary(target.sessionId, target.worktreePath);
        assert.equal(cleanupBoundary.cleanupOwnsDescendants, true,
          "implicit legacy attribution owns shell descendants");
        assert.ok(cleanupBoundary.cleanupDescendantMarker);
        shellManager.open("fork-shell", target.sessionId, target.worktreePath!, { kind: "native" }, undefined, {
          kind: "shell",
          launch: { command: process.execPath, args: ["-e", childSource, pidFile] },
          ...cleanupBoundary,
        });
        detachedIdentity = await waitForLiveProcessPidFile(pidFile);
        assert.ok(detachedIdentity, "fork shell did not publish a live descendant PID");
        assert.equal(shellManager.snapshots().find((shell) => shell.shellId === "fork-shell")?.status, "running",
          "the fork shell remains active until worktree cleanup");
        assert.ok(await waitForOriginalProcessToStop(detachedIdentity, 0),
          "the detached descendant runs before worktree cleanup");
        await shellManager.closeForWorktree(target.sessionId, { kind: "native" }, target.worktreePath!);
        assert.equal(await waitForOriginalProcessToStop(detachedIdentity), undefined,
          "worktree cleanup stopped the no-config fork shell descendant");
        shellBodyCompleted = true;
      } finally {
        await runFixtureCleanup([
          ["shell disposal", () => shellManager.dispose()],
          ["detached process termination", () => terminateOriginalProcess(detachedIdentity)],
        ], (message) => t.diagnostic(message), !shellBodyCompleted);
      }
    }
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
      // Reusing one worktree for a second session id is a fixture shortcut, so record the branch
      // the tree actually carries: a real session always persists its own worktreeBranch, and fork
      // re-proves that recorded identity before it constructs a provider.
      worktreeBranch: sourceWorktree.branch,
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
      providerCredentialIdentityEvidence: {
        version: 1,
        fields: { email: "email-a", orgId: "org-a" },
      },
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
    assert.equal(claudeTarget.providerCredentialIdentityEvidence, undefined);
    assert.equal(claudeTarget.providerAuthBlock, undefined);
    assert.equal(claudeTarget.providerAuthRetryAttemptedRecoveryId, undefined);
    assert.equal(forkSources.at(-1), "claude-source-uuid");
    assert.deepEqual(claudeForkBoundaries, [{
      sourceSessionId: "claude-source-uuid",
      cwd: claudeTarget.worktreePath,
      protectedPath: process.platform === "linux" ? claudeTarget.worktreePath : undefined,
    }]);
    assert.deepEqual(claudeIsolationState.at(-1), {
      sessionId: "s_claude_source",
      cwd: claudeTarget.worktreePath,
      protectedPath: process.platform === "linux" ? claudeTarget.worktreePath : undefined,
    }, "Claude's target cwd uses the source partition until the fork transcript is cloned");
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
        assert.equal(git(repo, ["rev-parse", "refs/mam/s_post_anchor_fail/worktrees/legacy/fork-2"]), tree);
        assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_post_anchor_fail/worktrees/legacy/fork-2"]), tree);
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

    // Pi never mutates the live source RPC process. Its temporary clone helper runs from a copy of
    // the source provider state that already belongs to the target session, making rollback
    // partition-local and preserving the authoritative Pi leaf as the checkpoint coordinate.
    const piSource: SessionMeta = {
      ...source,
      sessionId: "s_pi_source",
      worktreeBranch: sourceWorktree.branch,
      driver: "pi",
      agentId: "pi",
      agentSessionId: "pi-source-session",
      capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: false,
        supportsConversationFork: true,
      },
      providerStateVersion: 2,
      turnCount: 2,
      forkPoints: {
        "1": { agentTurnId: "pi-leaf-1", tree, baseCommit, eventSeq: 2 },
        "2": { agentTurnId: "pi-leaf-2", tree, baseCommit, eventSeq: 4 },
      },
      seq: 0,
    };
    store.create(piSource);
    store.appendEvent(piSource.sessionId, { kind: "user_message", text: "Pi prompt" });
    store.appendEvent(piSource.sessionId, { kind: "conversation_checkpoint", turn: 1 });
    store.appendEvent(piSource.sessionId, { kind: "user_message", text: "Pi follow-up" });
    store.appendEvent(piSource.sessionId, { kind: "conversation_checkpoint", turn: 2 });
    store.flush(piSource.sessionId);
    const historicalPi = await manager.forkConversation(piSource.sessionId, "s_pi_historical", 1, "Old Pi fork");
    assert.equal(historicalPi.ok, false);
    assert.match(historicalPi.error ?? "", /current transcript/);
    assert.equal(store.has("s_pi_historical"), false);
    const adoptedPiSource: SessionMeta = {
      ...piSource,
      sessionId: "s_pi_adopted",
      adoptedProviderState: {
        driver: "pi",
        sessionDir: join(storeRoot, "s_pi_adopted", "pi-adopted-sessions"),
      },
    };
    store.create(adoptedPiSource);
    const adoptedPiFork = await manager.forkConversation(
      adoptedPiSource.sessionId,
      "s_pi_adopted_target",
      2,
      "Unsafe adopted Pi fork",
    );
    assert.equal(adoptedPiFork.ok, false);
    assert.match(adoptedPiFork.error ?? "", /unavailable for an adopted Pi session/u);
    assert.equal(store.has("s_pi_adopted_target"), false);
    assert.equal(
      stateTransfers.some((transfer) => transfer.target === "s_pi_adopted_target"),
      false,
      "the refusal happens before provider-state cloning",
    );
    const piFork = await manager.forkConversation(piSource.sessionId, "s_pi_target", 2, "Pi fork");
    assert.equal(piFork.ok, true, piFork.error);
    assert.equal(store.readMeta("s_pi_target")?.driver, "pi");
    assert.equal(store.readMeta("s_pi_target")?.agentSessionId, "thread-forked");
    assert.equal(forkSources.at(-1), "pi-leaf-2");
    assert.equal(piInitializations, 0, "Pi forks do not open the copied source session in a competing process");
    assert.deepEqual(stateTransfers.at(-1), { source: "s_pi_source", target: "s_pi_target" });
    assert.equal(
      stateTransfers.filter((transfer) => transfer.target === "s_pi_target").length,
      1,
      "Pi provider state is copied before the helper and not duplicated afterward",
    );
    assert.equal(verifiedForks.at(-1), "thread-forked");
    assert.match(
      (store.readEvents(piSource.sessionId).at(-1)?.payload as { message?: string }).message ?? "",
      /conversation fork is in progress/,
    );
    // Both preparation paths must retain the exact source and target reservation while their
    // plugin ownership wait is pending. Exercise cancellation before any helper is constructed.
    store.patchMeta("s_claude_source", { turnCount: 2 });
    const internals = manager as unknown as { deleted: Set<string>; latestLaunchGenerations: Map<string, number> };
    const removalsBeforeCancelledPreparation = stateRemovals.length;
    const cancelledTargets: string[] = [];
    for (const sourceId of ["s_claude_source", "s_pi_source"]) {
      for (const change of ["target-deleted", "source-deleted", "epoch", "credential"] as const) {
        await t.test(`${sourceId} preparation refuses ${change}`, async () => {
          let entered!: () => void, release!: () => void;
          const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
          const gate = new Promise<void>(resolve => { release = resolve; });
          preparationWait = () => { entered(); return gate; };
          const targetId = `s_wait_${sourceId}_${change}`;
          cancelledTargets.push(targetId);
          const prior = store.readMeta(sourceId)!;
          const home = prior.providerCredentialHome;
          const epoch = internals.latestLaunchGenerations.get(sourceId);
          const beforeConstructions = constructions, beforeForks = forkSources.length;
          const preparing = manager.forkConversation(sourceId, targetId, 2, "Deferred Fork");
          await enteredPromise;
          assert.equal(constructions, beforeConstructions);
          if (change === "target-deleted") internals.deleted.add(targetId);
          if (change === "source-deleted") internals.deleted.add(sourceId);
          if (change === "epoch") internals.latestLaunchGenerations.set(sourceId, 999);
          if (change === "credential") store.patchMeta(sourceId, { providerCredentialHome: join(storeRoot, "changed-home") });
          release();
          try {
            const result = await preparing;
            assert.equal(result.ok, false);
            assert.match(result.error ?? "", /preparation was canceled/);
            assert.equal(constructions, beforeConstructions);
            assert.equal(forkSources.length, beforeForks);
            assert.equal(store.has(targetId), false);
          } finally {
            preparationWait = undefined;
            internals.deleted.delete(sourceId); internals.deleted.delete(targetId);
            if (epoch === undefined) internals.latestLaunchGenerations.delete(sourceId);
            else internals.latestLaunchGenerations.set(sourceId, epoch);
            store.patchMeta(sourceId, { providerCredentialHome: home });
          }
        });
      }
    }
    // Every refused fork retires only its own target partition, exactly once.
    assert.deepEqual(stateRemovals.slice(removalsBeforeCancelledPreparation), cancelledTargets);
    stateRemovals.splice(removalsBeforeCancelledPreparation);
    await manager.delete("s_target");
    await manager.delete("s_claude_target");
    await manager.delete("s_pi_target");
    assert.deepEqual(stateRemovals, ["s_clone_fail", "s_post_anchor_fail", "s_target", "s_claude_target", "s_pi_target"]);
    type LeaseReference = { first: boolean; release(): Promise<boolean>; retain(): Promise<void> };
    const leaseInternals = manager as unknown as {
      providerHomeLeases?: {
        acquire(request: unknown, cancellation?: { isCurrent?: () => boolean }): Promise<void>;
        acquireReference(request: unknown, cancellation?: { isCurrent?: () => boolean }): Promise<LeaseReference | null>;
      };
    };
    const originalLeases = leaseInternals.providerHomeLeases;
    const forksBeforeLeaseFailure = forkSources.length;
    const protectedLeasePath = (request: unknown) =>
      (request as { isolation?: { protectedWorktree?: { path: string } } }).isolation?.protectedWorktree?.path;
    // The temporary source driver and the Claude target fork each take an exact-entry handle
    // (#3238). Both draw from one acquisition sequence.
    type LeaseStub = (request: unknown, cancellation?: { isCurrent?: () => boolean }) => Promise<void>;
    const leaseMethods: string[] = [];
    const leaseStub = (acquire: LeaseStub) => ({
      acquire: async (request: unknown, cancellation?: { isCurrent?: () => boolean }) => {
        leaseMethods.push("acquire");
        await acquire(request, cancellation);
      },
      acquireReference: async (request: unknown, cancellation?: { isCurrent?: () => boolean }) => {
        leaseMethods.push("acquireReference");
        await acquire(request, cancellation);
        return null;
      },
    });
    try {
      const rejectedLeasePaths: Array<string | undefined> = [];
      leaseInternals.providerHomeLeases = leaseStub(async (request, cancellation) => {
          assert.equal(cancellation?.isCurrent?.(), true);
          const path = protectedLeasePath(request);
          if (process.platform === "linux") assert.ok(path);
          else assert.equal(path, undefined, "protected worktree boundaries are Linux-only");
          rejectedLeasePaths.push(path);
          if (rejectedLeasePaths.length === 1) {
            if (process.platform === "linux") {
              assert.equal(path, sourceWorktree.path, "the temporary source driver acquires first");
            }
            return;
          }
          if (process.platform === "linux") {
            assert.notEqual(path, sourceWorktree.path, "the regression must reach the target fork lease");
          }
          throw new Error("lease refused");
      });
      const refusedLease = await manager.forkConversation(
        "s_claude_source", "s_claude_lease_refused", 2, "Lease Refused",
      );
      assert.equal(refusedLease.ok, false);
      assert.match(refusedLease.error ?? "", /lease refused/);
      assert.equal(rejectedLeasePaths.length, 2);
      assert.deepEqual(leaseMethods, ["acquireReference", "acquireReference"],
        "the Claude target fork takes an exact-entry reference, never a plain one");
      assert.equal(store.has("s_claude_lease_refused"), false);
      assert.equal(forkSources.length, forksBeforeLeaseFailure,
        "a rejected provider-home lease must stop before Claude forks its transcript");

      let entered!: () => void;
      let release!: () => void;
      const enteredLease = new Promise<void>((resolve) => { entered = resolve; });
      const leaseGate = new Promise<void>((resolve) => { release = resolve; });
      const delayedLeasePaths: Array<string | undefined> = [];
      leaseInternals.providerHomeLeases = leaseStub(async (request, cancellation) => {
          assert.equal(cancellation?.isCurrent?.(), true);
          const path = protectedLeasePath(request);
          if (process.platform === "linux") assert.ok(path);
          else assert.equal(path, undefined, "protected worktree boundaries are Linux-only");
          delayedLeasePaths.push(path);
          if (delayedLeasePaths.length === 1) {
            return;
          }
          if (process.platform === "linux") {
            assert.notEqual(path, sourceWorktree.path, "the delay must hold the target fork lease");
          }
          entered();
          await leaseGate;
      });
      const cancelledTarget = "s_claude_lease_cancelled";
      const pendingFork = manager.forkConversation("s_claude_source", cancelledTarget, 2, "Lease Cancelled");
      await enteredLease;
      assert.equal(delayedLeasePaths.length, 2);
      assert.equal(forkSources.length, forksBeforeLeaseFailure,
        "Claude must wait for the target lease before calling forkSession");
      internals.deleted.add(cancelledTarget);
      release();
      try {
        const cancelledLease = await pendingFork;
        assert.equal(cancelledLease.ok, false);
        assert.match(cancelledLease.error ?? "", /source session changed during provider-home acquisition/);
        assert.equal(store.has(cancelledTarget), false);
        assert.equal(forkSources.length, forksBeforeLeaseFailure,
          "a cancelled lease wait must stop before Claude forks its transcript");
      } finally {
        internals.deleted.delete(cancelledTarget);
      }

      // The Claude target fork's reference settles on the fork bootstrap's own tree proof once
      // forkSession returns: released only for a reported true proof (#3238).
      for (const [report, released] of [[true, true], [false, false], ["none", false]] as const) {
        const outcomes: Array<{ path: string | undefined; outcome?: "released" | "retained" }> = [];
        leaseInternals.providerHomeLeases = {
          acquire: async () => { throw new Error("no plain reference below the handle budget"); },
          acquireReference: async (request: unknown) => {
            const entry: { path: string | undefined; outcome?: "released" | "retained" } = { path: protectedLeasePath(request) };
            outcomes.push(entry);
            return {
              first: true,
              release: async () => { entry.outcome ??= "released"; return true; },
              retain: async () => { entry.outcome ??= "retained"; },
            };
          },
        };
        claudeForkProcessReport = report;
        const offeredBefore = claudeForkObserverOffered.length;
        const targetId = `s_claude_fork_proof_${String(report)}`;
        try {
          const forked = await manager.forkConversation("s_claude_source", targetId, 2, "Fork Proof");
          assert.equal(forked.ok, true, forked.error);
          assert.deepEqual(claudeForkObserverOffered.slice(offeredBefore), [true],
            "the fork is offered a process observer whenever it holds a reference handle");
          assert.equal(outcomes.length, 2, "the temporary source driver and the target fork each hold one handle");
          if (process.platform === "linux") {
            assert.equal(outcomes[1]!.path, store.readMeta(targetId)?.worktreePath,
              "the second handle is the target fork's, bound to the new worktree");
          }
          assert.equal(outcomes[1]!.outcome, released ? "released" : "retained",
            `a fork reporting ${String(report)} ${released ? "releases" : "keeps"} its reference`);
        } finally {
          claudeForkProcessReport = "none";
          if (store.has(targetId)) await manager.delete(targetId);
        }
      }

      // The temporary source driver's launch preparation reference settles once that driver's own
      // reference holds the HOME, on what ran under it (#3238).
      for (const unprovable of [false, true]) {
        const sequence: string[] = [];
        const handle = (name: string) => ({
          first: true,
          release: async () => { sequence.push(`${name} released`); return true; },
          retain: async () => { sequence.push(`${name} retained`); },
        });
        let driverHandles = 0;
        leaseInternals.providerHomeLeases = {
          acquire: async () => { throw new Error("no plain reference below the handle budget"); },
          acquireReference: async () => {
            const name = ++driverHandles === 1 ? "temporary driver" : "target fork";
            sequence.push(`${name} acquired`);
            return handle(name);
          },
          acquireHomeReference: async () => {
            sequence.push("preparation acquired");
            return handle("preparation");
          },
        } as typeof leaseInternals.providerHomeLeases;
        preparationHook = async (cancellation) => {
          await manager.acquireLaunchProviderHome("/accounts/work", cancellation);
          if (unprovable) cancellation?.providerHome?.markUnprovable();
        };
        const targetId = `s_claude_fork_preparation_${String(unprovable)}`;
        try {
          const forked = await manager.forkConversation("s_claude_source", targetId, 2, "Fork Preparation");
          assert.equal(forked.ok, true, forked.error);
          assert.deepEqual(sequence.slice(0, 3), [
            "preparation acquired",
            "temporary driver acquired",
            `preparation ${unprovable ? "retained" : "released"}`,
          ], `the preparation settles after the temporary driver's reference is held: ${sequence.join(", ")}`);
        } finally {
          preparationHook = undefined;
          if (store.has(targetId)) await manager.delete(targetId);
        }
      }
      // A fork that goes stale while the preparation settles constructs no temporary driver, and the
      // temporary driver's unused reference is released.
      {
        const sequence: string[] = [];
        let open!: () => void;
        const gate = new Promise<void>((resolve) => { open = resolve; });
        let gateStarted = false;
        const targetId = "s_claude_fork_settlement_race";
        const handle = (name: string) => ({
          first: true,
          release: async () => {
            if (name === "preparation") {
              gateStarted = true;
              await gate;
            }
            sequence.push(`${name} released`);
            return true;
          },
          retain: async () => { sequence.push(`${name} retained`); },
        });
        leaseInternals.providerHomeLeases = {
          acquire: async () => { throw new Error("no plain reference below the handle budget"); },
          acquireReference: async () => { sequence.push("temporary driver acquired"); return handle("temporary driver"); },
          acquireHomeReference: async () => { sequence.push("preparation acquired"); return handle("preparation"); },
        } as typeof leaseInternals.providerHomeLeases;
        preparationHook = async (cancellation) => {
          await manager.acquireLaunchProviderHome("/accounts/work", cancellation);
        };
        try {
          const forking = manager.forkConversation("s_claude_source", targetId, 2, "Fork Settlement Race");
          for (let i = 0; i < 400 && !gateStarted; i++) await new Promise((resolve) => setTimeout(resolve, 5));
          assert.ok(gateStarted, "the preparation settlement waits on the lease worker");
          // The fork's target is withdrawn while the settlement waits.
          (manager as unknown as { forkingTargets: Set<string> }).forkingTargets.delete(targetId);
          open();
          const forked = await forking;
          assert.equal(forked.ok, false, "a stale fork does not proceed");
          assert.deepEqual(sequence, [
            "preparation acquired",
            "temporary driver acquired",
            "preparation released",
            "temporary driver released",
          ], `no temporary driver is constructed after a stale settlement: ${sequence.join(", ")}`);
        } finally {
          open();
          preparationHook = undefined;
          if (store.has(targetId)) await manager.delete(targetId);
        }
      }
    } finally {
      leaseInternals.providerHomeLeases = originalLeases;
    }
    manager.shutdownAll();
    git(repo, ["worktree", "remove", "--force", sourceWorktree.path]);
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
