/**
 * Provider-history quarantine (protocol v128). When the provider rejects an item already stored in
 * its own conversation history, no local action repairs that thread: retrying, continuing, and
 * `/compact` all resend the same history and fail identically before inference runs. These tests
 * pin the whole loop — detect, quarantine durably, refuse further submissions while preserving the
 * attempted prompt, and recover into a usable conversation with the checkpoint's exact files.
 */

import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition, AgentDriverKind, RunnerToControlPlane } from "@wollipog/protocol";
import type { Driver, DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import {
  poisonedProviderHistoryMessage,
  type PoisonedProviderHistory,
} from "./drivers/poisoned-provider-history.js";
import { anchorForkRef, captureWorktreeTree } from "./git-ops.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { createWorkspaceReference } from "./session-files.js";
import { createWorktree } from "./worktree.js";

const REJECTION: PoisonedProviderHistory = {
  reason: "oversized_tool_call",
  itemIndex: 675,
  field: "arguments",
  limit: 1_048_576,
  length: 1_426_210,
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, message);
}

/** The refused turn still has to settle before the session can be forked; the quarantine is raised
 * from a provider notification mid-turn, exactly as the driver reports it. */
async function settled(store: SessionStore, sessionId: string): Promise<void> {
  await waitFor(() => store.readMeta(sessionId)?.status === "idle", "the refused turn settles");
  for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A session whose turn 2 recorded a conversation checkpoint, holding committed, staged, modified,
 * and untracked files. Turn 3 is the one the provider refused, so it deliberately has no
 * checkpoint: turn 2 is the newest provider state known to predate the invalid item.
 */
async function setup(sessionId = "s_poisoned") {
  const root = mkdtempSync(join(tmpdir(), "wollipog-quarantine-"));
  const repo = join(root, "repo");
  git(root, ["init", "-q", repo]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "committed.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const worktree = await createWorktree(repo, sessionId, { dataDir: root });
  writeFileSync(join(worktree.path, "committed.txt"), "checkpoint commit\n");
  git(worktree.path, ["add", "-A"]);
  git(worktree.path, ["commit", "-qm", "work through turn 2"]);
  writeFileSync(join(worktree.path, "staged.txt"), "staged at the checkpoint\n");
  git(worktree.path, ["add", "staged.txt"]);
  writeFileSync(join(worktree.path, "committed.txt"), "modified at the checkpoint\n");
  writeFileSync(join(worktree.path, "untracked.txt"), "untracked at the checkpoint\n");
  const tree = await captureWorktreeTree(worktree.path);
  const baseCommit = git(worktree.path, ["rev-parse", "HEAD"]);
  await anchorForkRef(worktree.path, sessionId, 2, tree);

  const store = new SessionStore(join(root, "sessions"));
  const meta: SessionMeta = {
    sessionId, agentId: "codex-native", workspaceId: "workspace", repoPath: repo,
    worktreePath: worktree.path, driver: "codex-app-server", command: "codex", args: [],
    env: {}, context: { kind: "native" }, agentSessionId: "thread-poisoned",
    status: "idle", title: "Poisoned", config: { model: "gpt-5.6-sol", effort: "high" },
    tokensIn: 10, tokensOut: 20, costUsd: 1, preview: null, pendingApproval: null,
    turnCount: 3, seq: 0, createdAt: 1, updatedAt: 1,
    forkPoints: { "2": { agentTurnId: "turn-2", tree, baseCommit, eventSeq: 3 } },
  };
  store.create(meta);
  store.appendEvent(sessionId, { kind: "user_message", text: "Do the safe work", final: true });
  store.appendEvent(sessionId, { kind: "agent_message", text: "Safe work done", final: true });
  store.appendEvent(sessionId, { kind: "conversation_checkpoint", turn: 2 });
  store.appendEvent(sessionId, { kind: "user_message", text: "Do the work that poisoned it", final: true });
  store.flush(sessionId);
  return { root, repo, worktree, store, tree, baseCommit, sessionId,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

interface StubState {
  callbacks: DriverCallbacks[];
  prompts: string[];
  launches: number;
  forks: Array<{ turnId: string; cwd: string }>;
}

function stubFactory(state: StubState) {
  return (_kind: AgentDriverKind, options: DriverOptions, callbacks: DriverCallbacks): Driver => {
    state.launches += 1;
    state.callbacks.push(callbacks);
    return {
      get pid() { return undefined; },
      initialize: async () => {},
      newSession: async () => options.resumeId ?? "thread-poisoned",
      agentSessionId: () => options.resumeId ?? "thread-poisoned",
      agentTurnId: () => "turn-3",
      forkSession: async (lastTurnId, cwd) => {
        state.forks.push({ turnId: lastTurnId, cwd });
        return "thread-recovered";
      },
      archiveSession: async () => {},
      prompt: async (text) => { state.prompts.push(text); return "refusal"; },
      setConfig: () => {},
      cancel: () => {},
      resolvePermission: () => false,
      dispose: () => {},
    };
  };
}

test("an oversized historical tool call quarantines the conversation and refuses every later submission", async () => {
  const fixture = await setup();
  const sent: RunnerToControlPlane[] = [];
  const state: StubState = { callbacks: [], prompts: [], launches: 0, forks: [] };
  const manager = new SessionManager(
    (message) => sent.push(message), () => {}, fixture.store, "runner", undefined,
    stubFactory(state), fixture.root,
  );
  try {
    manager.prompt(fixture.sessionId, "the turn that fails");
    await waitFor(() => state.prompts.length === 1, "the first turn reaches the provider");

    // The provider rejected its own stored history. Mirror the driver exactly: it puts its
    // constructed, content-free rejection in the transcript, then signals.
    state.callbacks[0]!.onEvent({ kind: "error", message: poisonedProviderHistoryMessage(REJECTION) });
    state.callbacks[0]!.onProviderHistoryUnrecoverable!(REJECTION);

    const blocked = fixture.store.readMeta(fixture.sessionId)!.providerHistoryBlock!;
    assert.equal(blocked.reason, "oversized_tool_call");
    assert.deepEqual(blocked.detail, { itemIndex: 675, field: "arguments", limit: 1_048_576, length: 1_426_210 });
    // Turn 3 refused, so turn 2's checkpoint is the newest state known to precede the bad item.
    assert.equal(blocked.recoveryTurn, 2);
    assert.equal(blocked.recovery, "fork");
    assert.equal(blocked.retry, undefined, "nothing is retained before a prompt is attempted");

    // The driver's constructed rejection marks the point in the transcript; the recovery coordinate
    // lives on the session's own durable state, which needs no wire sequence space of its own.
    const rejection = fixture.store.readEvents(fixture.sessionId).filter((event) =>
      event.payload.kind === "error" && /rejected this conversation's stored history/.test(event.payload.message));
    assert.equal(rejection.length, 1, "the transcript durably records why the conversation ended");

    // An ordinary retry, a Continue, and /compact are all rejected before the provider is touched,
    // and the first attempt survives as an unsent draft.
    assert.equal(manager.prompt(fixture.sessionId, "Continue."), false);
    assert.equal(manager.prompt(fixture.sessionId, "", [], "compact"), false);
    await waitFor(() => true, "settled");
    assert.deepEqual(state.prompts, ["the turn that fails"], "no further turn reaches the provider");

    const retained = fixture.store.readMeta(fixture.sessionId)!.providerHistoryBlock!.retry!;
    assert.equal(retained.text, "Continue.", "the first attempt after quarantine is kept unsent");
    assert.equal(retained.slashCommand, undefined);
    assert.equal(
      fixture.store.readEvents(fixture.sessionId).some((event) => event.payload.kind === "user_message" &&
        event.payload.text === "Continue."),
      false,
      "a refused prompt is never recorded as delivered",
    );
    const guidance = fixture.store.readEvents(fixture.sessionId)
      .filter((event) => event.payload.kind === "error" &&
        /retrying and \/compact cannot repair|Retrying and \/compact/i.test(event.payload.message));
    assert.equal(guidance.length, 2, "each refused submission explains why retrying cannot work");
  } finally {
    manager.shutdownAll();
    fixture.cleanup();
  }
});

test("a refused prompt leaves none of a delivered prompt's traces", async () => {
  const fixture = await setup();
  const state: StubState = { callbacks: [], prompts: [], launches: 0, forks: [] };
  const manager = new SessionManager(
    () => {}, () => {}, fixture.store, "runner", undefined, stubFactory(state), fixture.root,
  );
  try {
    manager.prompt(fixture.sessionId, "the turn that fails");
    await waitFor(() => state.prompts.length === 1, "the first turn reaches the provider");
    state.callbacks[0]!.onProviderHistoryUnrecoverable!(REJECTION);
    await settled(fixture.store, fixture.sessionId);
    // An untitled session is the case where a *delivered* prompt would rename it.
    fixture.store.patchMeta(fixture.sessionId, { title: "Untitled session", titleSource: "generated" });

    assert.equal(manager.prompt(fixture.sessionId, "Name this session after me"), false);
    assert.equal(
      fixture.store.readMeta(fixture.sessionId)!.title,
      "Untitled session",
      "a prompt that was never delivered must not rename the session",
    );
  } finally {
    manager.shutdownAll();
    fixture.cleanup();
  }
});

test("prompts already queued when the quarantine fires are settled, and the first is kept unsent", async () => {
  const fixture = await setup();
  const state: StubState = { callbacks: [], prompts: [], launches: 0, forks: [] };
  const manager = new SessionManager(
    () => {}, () => {}, fixture.store, "runner", undefined, stubFactory(state), fixture.root,
  );
  try {
    // Hold the turn open so the follow-ups pile into the FIFO instead of running.
    let releaseTurn: (() => void) | undefined;
    state.prompts.length = 0;
    const held = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const factoryState = state;
    manager.prompt(fixture.sessionId, "the turn that fails");
    await waitFor(() => factoryState.prompts.length === 1, "the first turn reaches the provider");
    manager.prompt(fixture.sessionId, "queued before the quarantine");
    manager.prompt(fixture.sessionId, "queued second");
    await waitFor(
      () => (manager as unknown as { active: Map<string, { queue: unknown[] }> })
        .active.get(fixture.sessionId)!.queue.length === 2,
      "both follow-ups are queued behind the running turn",
    );

    state.callbacks[0]!.onProviderHistoryUnrecoverable!(REJECTION);
    releaseTurn?.();
    await held;
    await settled(fixture.store, fixture.sessionId);

    const block = fixture.store.readMeta(fixture.sessionId)!.providerHistoryBlock!;
    assert.equal(block.retry?.text, "queued before the quarantine",
      "the oldest undelivered prompt is retained rather than discarded");
    assert.deepEqual(
      (manager as unknown as { active: Map<string, { queue: unknown[] }> })
        .active.get(fixture.sessionId)?.queue ?? [],
      [],
      "a FIFO that can never drain is not left parked",
    );
    assert.deepEqual(state.prompts, ["the turn that fails"], "no queued prompt reaches the provider");
  } finally {
    manager.shutdownAll();
    fixture.cleanup();
  }
});

test("the quarantine survives a runner restart, so a resumed session never re-submits", async () => {
  const fixture = await setup();
  const first: StubState = { callbacks: [], prompts: [], launches: 0, forks: [] };
  const manager = new SessionManager(
    () => {}, () => {}, fixture.store, "runner", undefined, stubFactory(first), fixture.root,
  );
  try {
    manager.prompt(fixture.sessionId, "the turn that fails");
    await waitFor(() => first.prompts.length === 1, "the first turn reaches the provider");
    first.callbacks[0]!.onProviderHistoryUnrecoverable!(REJECTION);
  } finally {
    manager.shutdownAll();
  }

  // A fresh process reads the same store, exactly as a runner restart would.
  const restarted: StubState = { callbacks: [], prompts: [], launches: 0, forks: [] };
  const store = new SessionStore(join(fixture.root, "sessions"));
  const resumed = new SessionManager(
    () => {}, () => {}, store, "runner", undefined, stubFactory(restarted), fixture.root,
  );
  try {
    assert.equal(store.readMeta(fixture.sessionId)?.providerHistoryBlock?.recoveryTurn, 2);
    assert.equal(resumed.prompt(fixture.sessionId, "still blocked?"), false);
    await waitFor(() => true, "settled");
    assert.deepEqual(restarted.prompts, [], "no provider turn is submitted after restart");
    assert.equal(restarted.launches, 0, "the poisoned thread is not even resumed to try");
  } finally {
    resumed.shutdownAll();
    fixture.cleanup();
  }
});

test("an explicit restart that keeps the Codex thread keeps its quarantine", async () => {
  const fixture = await setup();
  const state: StubState = { callbacks: [], prompts: [], launches: 0, forks: [] };
  const manager = new SessionManager(
    () => {}, () => {}, fixture.store, "runner", undefined, stubFactory(state), fixture.root,
  );
  try {
    manager.prompt(fixture.sessionId, "the turn that fails");
    await waitFor(() => state.prompts.length === 1, "the first turn reaches the provider");
    state.callbacks[0]!.onProviderHistoryUnrecoverable!(REJECTION);
    await settled(fixture.store, fixture.sessionId);
    await manager.stop(fixture.sessionId);

    // Restart rebuilds SessionMeta from the launch spec. For app-server it preserves the durable
    // thread, so it must preserve the block with it — otherwise Restart is a way back into the
    // poisoned conversation.
    state.prompts.length = 0;
    await manager.start({
      sessionId: fixture.sessionId, agentId: "codex-native", workspaceId: "workspace",
      workspacePath: fixture.repo, command: "codex", args: [], env: {},
      useWorktree: false, driver: "codex-app-server",
    });

    const restarted = fixture.store.readMeta(fixture.sessionId)!;
    assert.equal(restarted.agentSessionId, "thread-poisoned", "the same provider thread is resumed");
    assert.equal(restarted.providerHistoryBlock?.recoveryTurn, 2, "so the quarantine must survive");
    assert.equal(manager.prompt(fixture.sessionId, "after restart"), false);
    await waitFor(() => true, "settled");
    assert.deepEqual(state.prompts, [], "no turn reaches the poisoned thread after restart");
  } finally {
    manager.shutdownAll();
    fixture.cleanup();
  }
});

test("a quarantined session refuses a worktree switch that would strand its recovery", async () => {
  const fixture = await setup();
  const state: StubState = { callbacks: [], prompts: [], launches: 0, forks: [] };
  const manager = new SessionManager(
    () => {}, () => {}, fixture.store, "runner", undefined, stubFactory(state), fixture.root,
  );
  try {
    manager.prompt(fixture.sessionId, "the turn that fails");
    await waitFor(() => state.prompts.length === 1, "the first turn reaches the provider");
    state.callbacks[0]!.onProviderHistoryUnrecoverable!(REJECTION);
    await settled(fixture.store, fixture.sessionId);

    await assert.rejects(
      manager.selectWorktree(fixture.sessionId, fixture.worktree.path),
      /quarantined/,
    );
    // Select, create, and attach all funnel through activateWorktree, so the guard belongs there
    // rather than on one entry. Assert the choke point itself: the public create/attach paths hit
    // remote enumeration and Location validation before reaching it in this fixture.
    const meta = fixture.store.readMeta(fixture.sessionId)!;
    const activate = (manager as unknown as {
      activateWorktree: (m: typeof meta, w: { id: string; path: string; branch: string; source: string }) => Promise<unknown>;
    }).activateWorktree.bind(manager);
    await assert.rejects(
      activate(meta, { id: "other", path: fixture.worktree.path, branch: "other", source: "attached" }),
      /quarantined/,
    );
  } finally {
    manager.shutdownAll();
    fixture.cleanup();
  }
});

test("recovery forks the provider at the safe checkpoint and carries its exact files and unsent prompt", async () => {
  const fixture = await setup();
  const state: StubState = { callbacks: [], prompts: [], launches: 0, forks: [] };
  const manager = new SessionManager(
    () => {}, () => {}, fixture.store, "runner", undefined, stubFactory(state), fixture.root,
  );
  try {
    manager.prompt(fixture.sessionId, "the turn that fails");
    await waitFor(() => state.prompts.length === 1, "the first turn reaches the provider");
    state.callbacks[0]!.onProviderHistoryUnrecoverable!(REJECTION);
    await settled(fixture.store, fixture.sessionId);
    assert.equal(manager.prompt(fixture.sessionId, "keep this for me"), false);

    // An ordinary fork of a quarantined session is refused: recovery is the explicit action.
    const ordinary = await manager.forkConversation(fixture.sessionId, "s_ordinary", 2, "Ordinary");
    assert.equal(ordinary.ok, false);
    assert.match(ordinary.error!, /quarantined/);
    // Recovery may only start from the recorded safe checkpoint.
    const wrongTurn = await manager.forkConversation(fixture.sessionId, "s_wrong", 3, "Wrong", false, undefined, true);
    assert.equal(wrongTurn.ok, false);
    assert.match(wrongTurn.error!, /safe checkpoint/);

    const recovered = await manager.forkConversation(
      fixture.sessionId, "s_recovered", 2, "Recovered", false, undefined, true,
    );
    assert.equal(recovered.ok, true, recovered.error);
    assert.deepEqual(state.forks, [{ turnId: "turn-2", cwd: fixture.store.readMeta("s_recovered")!.worktreePath! }]);
    assert.deepEqual(recovered.retainedPrompt, { text: "keep this for me", images: [] });


    const child = fixture.store.readMeta("s_recovered")!;
    assert.equal(child.providerHistoryBlock, undefined, "the fork excludes the invalid item");
    assert.deepEqual(child.providerHistoryRecoveryOf, { fromSessionId: fixture.sessionId, mode: "fork" });
    assert.equal(child.agentSessionId, "thread-recovered");

    // An ordinary fork of the recovered session inherits its history, not its rescue: carrying the
    // provenance would make a later unrelated quarantine there skip the cheaper native fork.
    fixture.store.patchMeta("s_recovered", {
      forkPoints: { "2": { agentTurnId: "turn-2", tree: fixture.tree, baseCommit: fixture.baseCommit, eventSeq: 3 } },
    });
    const ordinaryChild = await manager.forkConversation("s_recovered", "s_grandchild", 2, "Grandchild");
    assert.equal(ordinaryChild.ok, true, ordinaryChild.error);
    assert.equal(fixture.store.readMeta("s_grandchild")!.providerHistoryRecoveryOf, undefined);

    // Committed, staged, modified, and untracked state all arrive in the recovered worktree.
    const childPath = child.worktreePath!;
    assert.equal(readFileSync(join(childPath, "committed.txt"), "utf8"), "modified at the checkpoint\n");
    assert.equal(readFileSync(join(childPath, "staged.txt"), "utf8"), "staged at the checkpoint\n");
    assert.equal(readFileSync(join(childPath, "untracked.txt"), "utf8"), "untracked at the checkpoint\n");
    assert.equal(git(childPath, ["rev-parse", "HEAD"]), fixture.baseCommit);

    // The quarantined original is left exactly as it was, for inspection.
    const source = fixture.store.readMeta(fixture.sessionId)!;
    assert.equal(source.agentSessionId, "thread-poisoned");
    assert.equal(source.providerHistoryBlock?.recoveryTurn, 2);
    assert.equal(source.worktreePath, fixture.worktree.path);
    assert.ok(fixture.store.readEvents(fixture.sessionId).length >= 5, "the original transcript is intact");
  } finally {
    manager.shutdownAll();
    fixture.cleanup();
  }
});

test("a fork that is poisoned again recovers through a fresh same-provider thread instead", async () => {
  const fixture = await setup("s_recovered_once");
  // This session was itself produced by a fork recovery, so the invalid item predates its
  // checkpoint and another fork would copy it forward.
  fixture.store.patchMeta(fixture.sessionId, {
    providerHistoryRecoveryOf: { fromSessionId: "s_original", mode: "fork" },
  });
  const state: StubState = { callbacks: [], prompts: [], launches: 0, forks: [] };
  const manager = new SessionManager(
    () => {}, () => {}, fixture.store, "runner", undefined, stubFactory(state), fixture.root,
  );
  const destination: AgentDefinition = {
    id: "codex-native", name: "Codex", command: "codex", args: [], env: {},
    driver: "codex-app-server", authStatus: "authenticated", available: true,
    capabilities: { models: [{ id: "gpt-5.6-sol" }], effortLevels: ["high"], permissionModes: [],
      slashCommands: [], supportsImages: true, supportsApprovals: true },
  };
  try {
    manager.prompt(fixture.sessionId, "the turn that fails");
    await waitFor(() => state.prompts.length === 1, "the first turn reaches the provider");
    state.callbacks[0]!.onProviderHistoryUnrecoverable!(REJECTION);
    await settled(fixture.store, fixture.sessionId);
    assert.equal(fixture.store.readMeta(fixture.sessionId)!.providerHistoryBlock!.recovery, "handoff");

    // The recorded mode is authoritative: a native fork is refused for this session.
    const asFork = await manager.forkConversation(fixture.sessionId, "s_bad", 2, "Fork", false, undefined, true);
    assert.equal(asFork.ok, false);
    assert.match(asFork.error!, /recovers by handoff/);

    const request = { agent: destination, config: { model: "gpt-5.6-sol", effort: "high" } };
    // The same-provider allowance exists only for recovery; an ordinary handoff still refuses it.
    const ordinary = await manager.forkConversation(fixture.sessionId, "s_same_provider", 2, "Handoff", false, request);
    assert.equal(ordinary.ok, false);
    assert.match(ordinary.error!, /quarantined/);

    const fresh = await manager.forkConversation(
      fixture.sessionId, "s_fresh", 2, "Fresh", false, request, true,
    );
    assert.equal(fresh.ok, true, fresh.error);
    assert.deepEqual(state.forks, [], "a fresh thread is never a provider fork of the poisoned one");
    const child = fixture.store.readMeta("s_fresh")!;
    assert.equal(child.agentSessionId, null, "the recovered session starts a new provider conversation");
    assert.equal(child.driver, "codex-app-server");
    assert.equal(child.providerHistoryBlock, undefined);
    assert.deepEqual(child.providerHistoryRecoveryOf, { fromSessionId: fixture.sessionId, mode: "handoff" });
    assert.equal(readFileSync(join(child.worktreePath!, "untracked.txt"), "utf8"), "untracked at the checkpoint\n");
    // The handoff is a bounded, redacted projection of the visible dialogue only.
    assert.match(fresh.handoffDraft!.text, /Do the safe work/);
    assert.doesNotMatch(fresh.handoffDraft!.text, /thread-poisoned|poisoned it/);
  } finally {
    manager.shutdownAll();
    fixture.cleanup();
  }
});

test("a retained workspace reference is dropped rather than handed to a different worktree", async () => {
  const fixture = await setup();
  const state: StubState = { callbacks: [], prompts: [], launches: 0, forks: [] };
  const manager = new SessionManager(
    () => {}, () => {}, fixture.store, "runner", undefined, stubFactory(state), fixture.root,
  );
  try {
    manager.prompt(fixture.sessionId, "the turn that fails");
    await waitFor(() => state.prompts.length === 1, "the first turn reaches the provider");
    state.callbacks[0]!.onProviderHistoryUnrecoverable!(REJECTION);
    await settled(fixture.store, fixture.sessionId);

    // A reference's rootFingerprint binds it to the source worktree's canonical path and inode;
    // recovery creates a different worktree, so sending it in the child would fail resolution.
    const reference = await createWorkspaceReference(
      { kind: "native" }, fixture.worktree.path, { path: "untracked.txt" },
    );
    const block = fixture.store.readMeta(fixture.sessionId)!.providerHistoryBlock!;
    fixture.store.patchMeta(fixture.sessionId, {
      providerHistoryBlock: { ...block, retry: { text: "explain @untracked.txt", images: [reference] } },
    });

    const recovered = await manager.forkConversation(
      fixture.sessionId, "s_recovered_ref", 2, "Recovered", false, undefined, true,
    );
    assert.equal(recovered.ok, true, recovered.error);
    assert.deepEqual(recovered.retainedPrompt!.images, [], "the untransferable reference is dropped");
    assert.match(recovered.retainedPrompt!.text, /explain @untracked\.txt/, "the user's own words survive");
    assert.match(recovered.retainedPrompt!.text, /Workspace file references were removed/,
      "and the draft says so rather than silently losing the attachment");
  } finally {
    manager.shutdownAll();
    fixture.cleanup();
  }
});

test("a healthy session cannot borrow the recovery path or its same-provider allowance", async () => {
  const fixture = await setup("s_healthy");
  const state: StubState = { callbacks: [], prompts: [], launches: 0, forks: [] };
  const manager = new SessionManager(
    () => {}, () => {}, fixture.store, "runner", undefined, stubFactory(state), fixture.root,
  );
  try {
    const recovery = await manager.forkConversation(fixture.sessionId, "s_no", 2, "No", false, undefined, true);
    assert.equal(recovery.ok, false);
    assert.match(recovery.error!, /not quarantined/);
    assert.equal(fixture.store.has("s_no"), false);
  } finally {
    manager.shutdownAll();
    fixture.cleanup();
  }
});
