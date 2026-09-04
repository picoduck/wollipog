/**
 * SessionManager prompt-queue surfacing (protocol v23): prompts that arrive while a turn is in
 * flight are held in a FIFO queue, reported to the control plane via session_queue with a stable id
 * per entry, and removable one-at-a-time before they start (the running turn is untouched).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDriverKind, EditQueuedPromptMessage, RunnerToControlPlane, SessionQueueMessage } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "s_q",
    agentId: "claude-native",
    workspaceId: "repo",
    repoPath: "/home/me/repo",
    worktreePath: null,
    driver: "claude-code",
    command: "claude",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: null,
    status: "running",
    title: "queue test",
    config: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** A session already mid-turn (running:true) so drain() returns early and new prompts simply queue —
 * no real agent process is spawned, keeping the test deterministic and timer-free. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-queue-"));
  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  store.create(meta());
  const sm = new SessionManager((m) => sent.push(m), () => {}, store, "test-runner");
  const stub = {
    resolvePermission: () => false,
    cancel: () => {},
    dispose: () => {},
    prompt: () => new Promise<never>(() => {}), // the in-flight turn never settles during the test
    setConfig: () => {},
    agentSessionId: () => null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sm as any).active.set("s_q", {
    sessionId: "s_q",
    client: stub,
    repoPath: "/home/me/repo",
    cwd: "/home/me/repo",
    worktree: null,
    status: "running",
    running: true, // a turn is in flight → drain() returns early, prompts pile up in the queue
    queue: [],
  });
  const queues = () => sent.filter((m): m is SessionQueueMessage => m.type === "session_queue");
  return { sm, store, queues, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function waitFor(predicate: () => boolean, message = "condition should settle"): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true, message);
}

test("queued prompts are reported with ids and are individually cancelable", () => {
  const { sm, queues, cleanup } = harness();
  try {
    sm.prompt("s_q", "first");
    sm.prompt("s_q", "second");

    // Each enqueue emits the current queue; the latest reflects both, FIFO, with stable ids.
    const latest = queues().at(-1)!;
    assert.deepEqual(
      latest.queue.map((q) => q.text),
      ["first", "second"],
    );
    const [firstId, secondId] = latest.queue.map((q) => q.id);
    assert.ok(firstId && secondId && firstId !== secondId, "each queued prompt gets a distinct id");
    assert.equal(latest.queue[0]!.hasImages, false);

    // Cancel the first — it leaves the queue, the second stays and keeps its id.
    sm.removeQueuedPrompt("s_q", firstId!);
    const remainingRevision = queues().at(-1)!.queue[0]!.editRevision;
    assert.match(remainingRevision ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(queues().at(-1)!.queue, [{
      id: secondId,
      text: "second",
      hasImages: false,
      editable: true,
      editRevision: remainingRevision,
      steerable: false,
      steerDisabledReason: "This provider does not support steering.",
      liveQueueObserved: true,
    }]);

    // Cancelling an unknown id is a no-op (no new queue message).
    const count = queues().length;
    sm.removeQueuedPrompt("s_q", "nope");
    assert.equal(queues().length, count);
  } finally {
    cleanup();
  }
});

test("queued prompt edits preserve identity and FIFO, round-trip attachments, and fence stale writers", () => {
  const { sm, queues, cleanup } = harness();
  try {
    const originalImages = [{ mimeType: "image/png", data: "AAAA" }];
    sm.prompt("s_q", "first", originalImages);
    sm.prompt("s_q", "second");
    const before = queues().at(-1)!.queue;
    const firstId = before[0]!.id;
    const secondId = before[1]!.id;

    const read = sm.readQueuedPrompt({
      type: "read_queued_prompt", requestId: "read-1", sessionId: "s_q", promptId: firstId,
    });
    assert.equal(read.ok, true);
    assert.equal(read.prompt?.promptId, firstId);
    assert.equal(read.prompt?.text, "first");
    assert.deepEqual(read.prompt?.images, originalImages);
    assert.match(read.prompt?.editRevision ?? "", /^[a-f0-9]{64}$/);

    const request: EditQueuedPromptMessage = {
      type: "edit_queued_prompt",
      requestId: "edit-request-1",
      submissionId: "edit-submission-1",
      sessionId: "s_q",
      promptId: firstId,
      expectedRevision: read.prompt!.editRevision,
      text: "first revised",
      images: [{ mimeType: "image/webp", data: "BBBB" }],
    };
    const edited = sm.editQueuedPrompt(request);
    assert.equal(edited.applied, true);
    assert.match(edited.prompt?.editRevision ?? "", /^[a-f0-9]{64}$/);
    assert.notEqual(edited.prompt?.editRevision, read.prompt?.editRevision);
    assert.deepEqual(queues().at(-1)!.queue.map((prompt) => [prompt.id, prompt.text]), [
      [firstId, "first revised"],
      [secondId, "second"],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const live = (sm as any).active.get("s_q").queue;
    assert.deepEqual(live[0].images, [{ mimeType: "image/webp", data: "BBBB" }]);

    const stale = sm.editQueuedPrompt({
      ...request,
      requestId: "edit-request-stale",
      submissionId: "edit-submission-stale",
      text: "must not win",
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.reason, "queue_item_changed");
    assert.equal(queues().at(-1)!.queue[0]!.text, "first revised");

    sm.removeQueuedPrompt("s_q", firstId);
    const replay = sm.editQueuedPrompt({ ...request, requestId: "edit-request-retry" });
    assert.deepEqual(replay, edited, "an exact retry replays its receipt after the item leaves the queue");
    const conflict = sm.editQueuedPrompt({ ...request, requestId: "edit-request-conflict", text: "different" });
    assert.equal(conflict.applied, false);
    assert.equal(conflict.reason, "invalid_content");
  } finally {
    cleanup();
  }
});

test("queued edit reads and saves fail closed after dequeue or for command-owned entries", () => {
  const { sm, queues, cleanup } = harness();
  try {
    sm.prompt("s_q", "ordinary");
    const ordinaryId = queues().at(-1)!.queue[0]!.id;
    sm.removeQueuedPrompt("s_q", ordinaryId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).active.get("s_q").activeTurnId = ordinaryId;
    const started = sm.editQueuedPrompt({
      type: "edit_queued_prompt", requestId: "started", submissionId: "started-submission",
      sessionId: "s_q", promptId: ordinaryId, expectedRevision: "old-process-token", text: "late", images: [],
    });
    assert.equal(started.applied, false);
    assert.equal(started.reason, "queue_item_started");

    sm.prompt("s_q", "slash body", [], "review");
    const command = queues().at(-1)!.queue[0]!;
    assert.equal(command.editable, false);
    assert.match(command.editDisabledReason ?? "", /slash commands/i);
    const immutable = sm.readQueuedPrompt({
      type: "read_queued_prompt", requestId: "read-command", sessionId: "s_q", promptId: command.id,
    });
    assert.equal(immutable.ok, false);
    assert.equal(immutable.reason, "queue_item_immutable");
  } finally {
    cleanup();
  }
});

test("a failed queued edit receipt is re-evaluated when transient immutability clears", () => {
  const { sm, queues, cleanup } = harness();
  try {
    sm.prompt("s_q", "ordinary");
    const queued = queues().at(-1)!.queue[0]!;
    const read = sm.readQueuedPrompt({
      type: "read_queued_prompt", requestId: "read-transient", sessionId: "s_q", promptId: queued.id,
    });
    assert.equal(read.ok, true);
    // Model the same transient ownership exclusion used while another queue operation is reserved.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const livePrompt = (sm as any).active.get("s_q").queue[0];
    livePrompt.slashCommand = "review";
    const request: EditQueuedPromptMessage = {
      type: "edit_queued_prompt",
      requestId: "edit-transient-1",
      submissionId: "edit-transient-submission",
      sessionId: "s_q",
      promptId: queued.id,
      expectedRevision: read.prompt!.editRevision,
      text: "revised after transient state",
      images: [],
    };
    const blocked = sm.editQueuedPrompt(request);
    assert.equal(blocked.applied, false);
    assert.equal(blocked.reason, "queue_item_immutable");

    livePrompt.slashCommand = undefined;
    const retry = sm.editQueuedPrompt({ ...request, requestId: "edit-transient-2" });
    assert.equal(retry.applied, true, "negative receipts must not outlive a transient exclusion");
    assert.equal(queues().at(-1)!.queue[0]!.text, "revised after transient state");
  } finally {
    cleanup();
  }
});

test("an applied queued edit replays across equivalent externalized artifact IDs", () => {
  const { sm, queues, cleanup } = harness();
  try {
    sm.prompt("s_q", "ordinary");
    const queued = queues().at(-1)!.queue[0]!;
    const read = sm.readQueuedPrompt({
      type: "read_queued_prompt", requestId: "read-image-retry", sessionId: "s_q", promptId: queued.id,
    });
    assert.equal(read.ok, true);
    const integrity = { mimeType: "image/png", sizeBytes: 4, sha256: "a".repeat(64) };
    const request: EditQueuedPromptMessage = {
      type: "edit_queued_prompt",
      requestId: "edit-image-1",
      submissionId: "edit-image-submission",
      sessionId: "s_q",
      promptId: queued.id,
      expectedRevision: read.prompt!.editRevision,
      text: "same bytes, new artifact allocation",
      images: [{ artifactId: "art_first", ...integrity }],
    };
    const applied = sm.editQueuedPrompt(request);
    assert.equal(applied.applied, true);

    const replay = sm.editQueuedPrompt({
      ...request,
      requestId: "edit-image-2",
      images: [{ artifactId: "art_retry", ...integrity }],
    });
    assert.deepEqual(replay, applied, "artifact storage identity must not change the idempotency receipt");

    const conflict = sm.editQueuedPrompt({
      ...request,
      requestId: "edit-image-3",
      images: [{ artifactId: "art_different", ...integrity, sha256: "b".repeat(64) }],
    });
    assert.equal(conflict.applied, false);
    assert.equal(conflict.reason, "invalid_content", "different image bytes must still conflict");
  } finally {
    cleanup();
  }
});

test("unresolved durable-delivery queue entries stay immutable across retries and reconnect projection", () => {
  const { sm, queues, cleanup } = harness();
  try {
    const durable = {
      commandId: "prompt_durable_1",
      queued() {},
      started() {},
      completed() {},
      failed() {},
      uncertain() {},
    };
    assert.equal(sm.prompt("s_q", "durable original", [], undefined, undefined, durable), true);
    const projected = queues().at(-1)!.queue[0]!;
    assert.equal(projected.id, durable.commandId);
    assert.equal(projected.editable, false);
    assert.match(projected.editDisabledReason ?? "", /durable delivery/i);

    const read = sm.readQueuedPrompt({
      type: "read_queued_prompt",
      requestId: "durable-read",
      sessionId: "s_q",
      promptId: durable.commandId,
    });
    assert.equal(read.ok, false);
    assert.equal(read.reason, "queue_item_immutable");

    const edit = sm.editQueuedPrompt({
      type: "edit_queued_prompt",
      requestId: "durable-edit",
      submissionId: "durable-submission",
      sessionId: "s_q",
      promptId: durable.commandId,
      expectedRevision: projected.editRevision!,
      text: "must not replace durable content",
      images: [],
    });
    assert.equal(edit.applied, false);
    assert.equal(edit.reason, "queue_item_immutable");
    assert.equal(queues().at(-1)!.queue[0]!.text, "durable original");

    sm.reportQueues();
    const reconnected = queues().at(-1)!.queue[0]!;
    assert.equal(reconnected.text, "durable original");
    assert.equal(reconnected.editable, false);
    assert.equal(reconnected.editRevision, projected.editRevision);
  } finally {
    cleanup();
  }
});

test("queued edit revisions are fenced to one runner process generation", () => {
  const first = harness();
  const replacement = harness();
  try {
    first.sm.prompt("s_q", "reconstructed content");
    replacement.sm.prompt("s_q", "reconstructed content");
    const firstId = first.queues().at(-1)!.queue[0]!.id;
    const replacementId = replacement.queues().at(-1)!.queue[0]!.id;
    // Model durable reconstruction retaining the stable command identity.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (replacement.sm as any).active.get("s_q").queue[0].id = firstId;
    const old = first.sm.readQueuedPrompt({
      type: "read_queued_prompt", requestId: "old-read", sessionId: "s_q", promptId: firstId,
    }).prompt!;
    const current = replacement.sm.readQueuedPrompt({
      type: "read_queued_prompt", requestId: "new-read", sessionId: "s_q", promptId: firstId,
    }).prompt!;
    assert.notEqual(firstId, replacementId);
    assert.notEqual(old.editRevision, current.editRevision);
    const stale = replacement.sm.editQueuedPrompt({
      type: "edit_queued_prompt", requestId: "old-save", submissionId: "old-save",
      sessionId: "s_q", promptId: firstId, expectedRevision: old.editRevision,
      text: "must not cross restart", images: [],
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.reason, "queue_item_changed");
  } finally {
    first.cleanup();
    replacement.cleanup();
  }
});

test("a queued prompt cannot drain while authoritative structured input is pending", async () => {
  const { sm, store, queues, cleanup } = harness();
  let providerCalls = 0;
  try {
    const entry = (sm as unknown as {
      active: Map<string, { running: boolean; client: { prompt: () => Promise<string> } }>;
    }).active.get("s_q")!;
    entry.running = false;
    entry.client.prompt = async () => {
      providerCalls += 1;
      return "end_turn";
    };
    store.patchMeta("s_q", {
      status: "input_required",
      pendingApproval: {
        kind: "question",
        requestId: "question-6",
        title: "The agent has 2 questions",
        options: [],
      },
    });

    assert.equal(sm.prompt("s_q", "queued while the questions remain answerable"), true);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(providerCalls, 0);
    assert.equal(store.readMeta("s_q")?.pendingApproval?.requestId, "question-6");
    assert.deepEqual(queues().at(-1)!.queue.map((prompt) => prompt.text), [
      "queued while the questions remain answerable",
    ]);
  } finally {
    cleanup();
  }
});

test("a governance-tripped entry rejects turn interruption without holding or cancelling", () => {
  const { sm, queues, cleanup } = harness();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (sm as any).active.get("s_q");
    entry.governanceTripped = "cost_budget";
    entry.activeTurnId = "turn-policy";
    const before = queues().length;

    assert.equal(sm.interruptTurn("s_q", "turn-policy"), "turn_not_running");
    assert.equal(entry.interruptRequested, undefined);
    assert.equal(entry.holdQueuedPromptsAfterInterrupt, undefined);
    assert.equal(queues().length, before);
  } finally {
    cleanup();
  }
});

test("a synchronous provider cancel failure rolls back the interruption hold", () => {
  const { sm, queues, cleanup } = harness();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (sm as any).active.get("s_q");
    entry.activeTurnId = "turn-live";
    entry.client.cancel = () => { throw new Error("cancel failed"); };

    assert.equal(sm.interruptTurn("s_q", "turn-live"), "cancel_failed");
    assert.equal(entry.interruptRequested, false);
    assert.equal(entry.holdQueuedPromptsAfterInterrupt, false);
    assert.equal(queues().at(-1)?.held, undefined);
  } finally {
    cleanup();
  }
});

test("turn-only interruption is idempotent and preserves FIFO for every driver contract", async () => {
  for (const driver of ["codex-app-server", "codex", "claude-code", "acp"] as AgentDriverKind[]) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-sm-interrupt-${driver}-`));
    const sent: RunnerToControlPlane[] = [];
    const store = new SessionStore(root);
    store.create(meta({ driver, status: "idle" }));
    let settleFirst!: (value: "cancelled") => void;
    const firstTurn = new Promise<"cancelled">((resolve) => { settleFirst = resolve; });
    const ran: string[] = [];
    let cancelCalls = 0;
    const client = {
      resolvePermission: () => false,
      cancel: () => { cancelCalls += 1; },
      dispose: () => {},
      prompt: (text: string) => {
        ran.push(text);
        return text === "A" ? firstTurn : Promise.resolve("end_turn" as const);
      },
      setConfig: () => {},
      agentSessionId: () => "agent-1",
    };
    const manager = new SessionManager((message) => sent.push(message), () => {}, store, "test-runner");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).active.set("s_q", {
      sessionId: "s_q", client, repoPath: root, cwd: root, worktree: null,
      context: { kind: "native" }, status: "idle", running: false, queue: [],
    });
    try {
      manager.prompt("s_q", "A");
      await waitFor(() => ran.length === 1, `${driver} first turn starts`);
      const activeQueue = sent.filter((message): message is SessionQueueMessage =>
        message.type === "session_queue").at(-1)!;
      assert.ok(activeQueue.activeTurnId, `${driver} publishes the dequeued turn coordinate`);
      manager.prompt("s_q", "B");

      assert.equal(manager.interruptTurn("s_q"), "applied");
      assert.equal(manager.interruptTurn("s_q"), "already_requested");
      const heldQueue = sent.filter((message): message is SessionQueueMessage =>
        message.type === "session_queue").at(-1)!;
      assert.equal(heldQueue.held, true, `${driver} publishes the FIFO hold`);
      assert.deepEqual(heldQueue.queue.map((prompt) => prompt.text), ["B"], driver);
      manager.prompt("s_q", "C");
      const releasedQueue = sent.filter((message): message is SessionQueueMessage =>
        message.type === "session_queue").at(-1)!;
      assert.equal(releasedQueue.held, undefined, `${driver} publishes explicit resume`);
      assert.deepEqual(releasedQueue.queue.map((prompt) => prompt.text), ["B", "C"], driver);
      assert.equal(cancelCalls, 1, `${driver} receives one provider cancellation`);
      settleFirst("cancelled");
      await waitFor(() => ran.length === 3, `${driver} redirect prompt releases the held FIFO after settlement`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const interrupted = (manager as any).active.get("s_q");
      assert.deepEqual(interrupted.queue, [], driver);
      assert.equal(interrupted.holdQueuedPromptsAfterInterrupt, false, driver);
      assert.equal(store.readMeta("s_q")?.status, "idle", driver);
      assert.equal(store.readEvents("s_q").filter((event) => event.payload.kind === "turn_interrupted").length, 1, driver);
      assert.equal(store.readEvents("s_q").some((event) => event.payload.kind === "error"), false, driver);
      assert.deepEqual(ran, ["A", "B", "C"], driver);
      assert.equal(sent.filter((message): message is SessionQueueMessage =>
        message.type === "session_queue").at(-1)!.activeTurnId, undefined, `${driver} clears the turn coordinate`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("synthetic orphan recovery cannot resume a user-interrupted Claude queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-interrupt-orphan-"));
  const store = new SessionStore(root);
  store.create(meta({
    driver: "claude-code",
    status: "idle",
    agentSessionId: "claude-session",
    command: "claude",
    orphanedWork: { pendingTaskIds: ["task-1"], markedAt: Date.now(), reason: "process_exit" },
  }));
  const ran: string[] = [];
  const client = {
    resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {},
    agentSessionId: () => "claude-session",
    prompt: async (text: string) => { ran.push(text); return "end_turn" as const; },
  };
  const manager = new SessionManager(() => {}, () => {}, store, "test-runner");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).active.set("s_q", {
    sessionId: "s_q", client, repoPath: root, cwd: root, worktree: null,
    context: { kind: "native" }, status: "idle", running: false, queue: [{
      id: "held", text: "B", images: [], syntheticRecovery: false,
    }], holdQueuedPromptsAfterInterrupt: true,
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any).runOrphanRecovery("s_q");
    assert.deepEqual(ran, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (manager as any).active.get("s_q");
    assert.equal(entry.holdQueuedPromptsAfterInterrupt, true);
    assert.deepEqual(entry.queue.map((prompt: { text: string }) => prompt.text), ["B"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((manager as any).orphanRecoveryTimers.has("s_q"), true, "recovery remains deferred rather than abandoned");
  } finally {
    manager.stop("s_q");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a configuration rejection cannot skip an interruption hold", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-interrupt-config-reject-"));
  const store = new SessionStore(root);
  store.create(meta({ status: "idle" }));
  let rejectConfig!: (reason: Error) => void;
  const configGate = new Promise<void>((_resolve, reject) => { rejectConfig = reject; });
  let configStarted = false;
  const ran: string[] = [];
  const client = {
    resolvePermission: () => false, cancel: () => {}, dispose: () => {},
    agentSessionId: () => "agent-1",
    setConfig: async () => { configStarted = true; await configGate; },
    prompt: async (text: string) => { ran.push(text); return "end_turn" as const; },
  };
  const manager = new SessionManager(() => {}, () => {}, store, "test-runner");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).active.set("s_q", {
    sessionId: "s_q", client, repoPath: root, cwd: root, worktree: null,
    context: { kind: "native" }, status: "idle", running: false, queue: [],
  });
  try {
    manager.prompt("s_q", "B", [], undefined, { model: "rejected" });
    await waitFor(() => configStarted);
    manager.prompt("s_q", "C");
    manager.interruptTurn("s_q");
    rejectConfig(new Error("model unavailable"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await waitFor(() => !(manager as any).active.get("s_q").running);
    assert.deepEqual(ran, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (manager as any).active.get("s_q");
    assert.equal(entry.holdQueuedPromptsAfterInterrupt, true);
    assert.deepEqual(entry.queue.map((prompt: { text: string }) => prompt.text), ["C"]);
    assert.equal(store.readEvents("s_q").filter((event) => event.payload.kind === "turn_interrupted").length, 1);
    assert.equal(store.readEvents("s_q").some((event) => event.payload.kind === "error"), false);

    manager.prompt("s_q", "D");
    await waitFor(() => ran.length === 2);
    assert.deepEqual(ran, ["C", "D"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit governance Continue clears an interrupt hold and drains the queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-interrupt-governance-"));
  const store = new SessionStore(root);
  store.create(meta({ status: "idle", config: { costBudgetUsd: 1 } }));
  let settleFirst!: (value: "cancelled") => void;
  const firstTurn = new Promise<"cancelled">((resolve) => { settleFirst = resolve; });
  const ran: string[] = [];
  const client = {
    resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {},
    agentSessionId: () => "agent-1",
    prompt: (text: string) => {
      ran.push(text);
      return text === "A" ? firstTurn : Promise.resolve("end_turn" as const);
    },
  };
  const manager = new SessionManager(() => {}, () => {}, store, "test-runner");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).active.set("s_q", {
    sessionId: "s_q", client, repoPath: root, cwd: root, worktree: null,
    context: { kind: "native" }, status: "idle", running: false, queue: [],
  });
  try {
    manager.prompt("s_q", "A");
    await waitFor(() => ran.length === 1);
    manager.prompt("s_q", "B");
    manager.interruptTurn("s_q");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (manager as any).active.get("s_q");
    entry.governanceTripped = "cost_budget";
    manager.rearmGovernance("s_q", { costBudgetUsd: null });
    assert.equal(entry.interruptRequested, false);
    assert.equal(entry.holdQueuedPromptsAfterInterrupt, false);
    assert.equal(entry.governanceRearmPending, "resume");
    settleFirst("cancelled");
    await waitFor(() => ran.length === 2);
    assert.deepEqual(ran, ["A", "B"]);
    assert.equal(entry.governanceTripped, undefined);
    assert.equal(entry.governanceRearmPending, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("old-control-plane cancel_session semantics remain stopped and auto-drain on a v71 runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-legacy-cancel-"));
  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  store.create(meta({ status: "idle" }));
  let settleFirst!: (value: "cancelled") => void;
  const firstTurn = new Promise<"cancelled">((resolve) => { settleFirst = resolve; });
  const ran: string[] = [];
  const client = {
    resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {},
    agentSessionId: () => "agent-1",
    prompt: (text: string) => {
      ran.push(text);
      return text === "A" ? firstTurn : Promise.resolve("end_turn" as const);
    },
  };
  const manager = new SessionManager((message) => sent.push(message), () => {}, store, "test-runner");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).active.set("s_q", {
    sessionId: "s_q", client, repoPath: root, cwd: root, worktree: null,
    context: { kind: "native" }, status: "idle", running: false, queue: [],
  });
  try {
    manager.prompt("s_q", "A");
    await waitFor(() => ran.length === 1);
    manager.prompt("s_q", "B");
    manager.cancel("s_q");
    settleFirst("cancelled");
    await waitFor(() => ran.length === 2);
    assert.deepEqual(ran, ["A", "B"], "legacy cancellation does not install the v71 queue hold");
    assert.equal(store.readEvents("s_q").some((event) => event.payload.kind === "turn_interrupted"), false);
    const statuses = sent.filter((message) => message.type === "session_status").map((message) => message.status);
    assert.ok(statuses.includes("stopped"), "legacy completion still reports stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider completion winning the interrupt race does not fabricate Interrupted or hold the FIFO", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-interrupt-race-"));
  const store = new SessionStore(root);
  store.create(meta({ status: "idle" }));
  let settleFirst!: (value: "end_turn") => void;
  const firstTurn = new Promise<"end_turn">((resolve) => { settleFirst = resolve; });
  const ran: string[] = [];
  const client = {
    resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {},
    agentSessionId: () => "agent-1",
    prompt: (text: string) => {
      ran.push(text);
      return text === "A" ? firstTurn : Promise.resolve("end_turn" as const);
    },
  };
  const manager = new SessionManager(() => {}, () => {}, store, "test-runner");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).active.set("s_q", {
    sessionId: "s_q", client, repoPath: root, cwd: root, worktree: null,
    context: { kind: "native" }, status: "idle", running: false, queue: [],
  });
  try {
    manager.prompt("s_q", "A");
    await waitFor(() => ran.length === 1);
    manager.prompt("s_q", "B");
    manager.interruptTurn("s_q");
    settleFirst("end_turn");
    await waitFor(() => ran.length === 2);
    assert.deepEqual(ran, ["A", "B"]);
    assert.equal(store.readEvents("s_q").some((event) => event.payload.kind === "turn_interrupted"), false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((manager as any).active.get("s_q").holdQueuedPromptsAfterInterrupt, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-provider interruption survives awaited configuration and never submits the interrupted turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-interrupt-pre-provider-"));
  const store = new SessionStore(root);
  store.create(meta({ status: "idle" }));
  let releaseConfig!: () => void;
  const configGate = new Promise<void>((resolve) => { releaseConfig = resolve; });
  let configStarted = false;
  const ran: string[] = [];
  let cancels = 0;
  const client = {
    resolvePermission: () => false,
    cancel: () => { cancels += 1; },
    dispose: () => {},
    setConfig: async () => { configStarted = true; await configGate; },
    agentSessionId: () => "agent-1",
    prompt: async (text: string) => { ran.push(text); return "end_turn" as const; },
  };
  const manager = new SessionManager(() => {}, () => {}, store, "test-runner");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).active.set("s_q", {
    sessionId: "s_q", client, repoPath: root, cwd: root, worktree: null,
    context: { kind: "native" }, status: "idle", running: false, queue: [],
  });
  try {
    manager.prompt("s_q", "A", [], undefined, { model: "test" });
    await waitFor(() => configStarted);
    manager.prompt("s_q", "B");
    manager.interruptTurn("s_q");
    releaseConfig();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await waitFor(() => !(manager as any).active.get("s_q").running);
    assert.equal(cancels, 1);
    assert.deepEqual(ran, [], "provider prompt is never called for the interrupted prepared turn");
    assert.equal(store.readEvents("s_q").filter((event) => event.payload.kind === "turn_interrupted").length, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.deepEqual((manager as any).active.get("s_q").queue.map((prompt: { text: string }) => prompt.text), ["B"]);

    manager.prompt("s_q", "C");
    await waitFor(() => ran.length === 2);
    assert.deepEqual(ran, ["B", "C"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale coordinated interrupt cannot cancel the next turn before provider submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-stale-interrupt-"));
  const store = new SessionStore(root);
  store.create(meta({ status: "idle" }));
  let settleFirst!: (value: "end_turn") => void;
  const firstTurn = new Promise<"end_turn">((resolve) => { settleFirst = resolve; });
  let releaseConfig!: () => void;
  const configGate = new Promise<void>((resolve) => { releaseConfig = resolve; });
  let secondConfigStarted = false;
  let cancels = 0;
  const ran: string[] = [];
  const client = {
    resolvePermission: () => false,
    cancel: () => { cancels += 1; },
    dispose: () => {},
    setConfig: async () => { secondConfigStarted = true; await configGate; },
    agentSessionId: () => "agent-1",
    prompt: (text: string) => {
      ran.push(text);
      return text === "A" ? firstTurn : Promise.resolve("end_turn" as const);
    },
  };
  const manager = new SessionManager(() => {}, () => {}, store, "test-runner");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).active.set("s_q", {
    sessionId: "s_q", client, repoPath: root, cwd: root, worktree: null,
    context: { kind: "native" }, status: "idle", running: false, queue: [],
  });
  try {
    manager.prompt("s_q", "A");
    await waitFor(() => ran.length === 1);
    const firstUser = store.readEvents("s_q").find((event) => event.payload.kind === "user_message")!;
    assert.equal(firstUser.payload.kind, "user_message");
    const staleTurnId = firstUser.payload.turnId;
    assert.ok(staleTurnId, "the first turn publishes its runner coordinate");

    manager.prompt("s_q", "B", [], undefined, { model: "next" });
    settleFirst("end_turn");
    await waitFor(() => secondConfigStarted, "the next turn reaches its pre-provider config gate");

    manager.interruptTurn("s_q", staleTurnId);
    assert.equal(cancels, 0, "the delayed interrupt is a stale no-op");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((manager as any).active.get("s_q").holdQueuedPromptsAfterInterrupt, undefined);

    releaseConfig();
    await waitFor(() => ran.length === 2);
    assert.deepEqual(ran, ["A", "B"]);
    assert.equal(store.readEvents("s_q").some((event) => event.payload.kind === "turn_interrupted"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hasImages flags queued prompts that carry attachments", () => {
  const { sm, queues, cleanup } = harness();
  try {
    sm.prompt("s_q", "look", [{ mimeType: "image/png", data: "AAAA" }]);
    assert.equal(queues().at(-1)!.queue[0]!.hasImages, true);
  } finally {
    cleanup();
  }
});

test("referenced images stay metadata-only in durable events and materialize only for the provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-image-ref-"));
  const store = new SessionStore(root);
  store.create(meta({ status: "idle" }));
  const reference = {
    artifactId: "art_image",
    mimeType: "image/png",
    sizeBytes: 3,
    sha256: "a".repeat(64),
  };
  const providerImages: unknown[] = [];
  const manager = new SessionManager(() => {}, () => {}, store, "test-runner");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).resolvePromptImages = async (_sessionId: string, references: unknown[]) => {
    assert.deepEqual(references, [reference]);
    return [{ mimeType: "image/png", data: "AQID" }];
  };
  const client = {
    resolvePermission: () => false,
    cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "agent-1",
    prompt: async (_text: string, images: unknown[]) => { providerImages.push(...images); return "end_turn" as const; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).active.set("s_q", {
    sessionId: "s_q", client, repoPath: root, cwd: root, worktree: null,
    context: { kind: "native" }, status: "idle", running: false, queue: [],
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (manager as any).runPrompt("s_q", { id: "p", text: "inspect", images: [reference] });
    assert.deepEqual(providerImages, [{ mimeType: "image/png", data: "AQID" }]);
    const user = store.readEvents("s_q").find((event) => event.payload.kind === "user_message")!;
    assert.deepEqual((user.payload as { images?: unknown[] }).images, [reference]);
    assert.equal(JSON.stringify(user).includes("AQID"), false, "durable event must not retain provider bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reportQueues re-emits every non-empty, held, or active queue (reconnect re-sync)", () => {
  const { sm, queues, cleanup } = harness();
  try {
    sm.prompt("s_q", "held");
    const before = queues().length;
    sm.reportQueues(); // what index.ts calls after a fresh `registered` ack
    assert.equal(queues().length, before + 1);
    assert.deepEqual(
      queues().at(-1)!.queue.map((q) => q.text),
      ["held"],
    );

    // A hold is independently authoritative even when no prompt currently waits behind it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (sm as any).active.get("s_q");
    entry.queue = [];
    entry.holdQueuedPromptsAfterInterrupt = true;
    const heldBefore = queues().length;
    sm.reportQueues();
    assert.equal(queues().length, heldBefore + 1);
    assert.equal(queues().at(-1)!.held, true);
    assert.deepEqual(queues().at(-1)!.queue, []);

    entry.holdQueuedPromptsAfterInterrupt = false;
    entry.activeTurnId = "turn-live";
    const activeBefore = queues().length;
    sm.reportQueues();
    assert.equal(queues().length, activeBefore + 1);
    assert.equal(queues().at(-1)!.activeTurnId, "turn-live");
  } finally {
    cleanup();
  }
});

test("reportQueues emits one authoritative frame for every stored non-deleted session", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-queue-report-all-"));
  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  store.create(meta({ sessionId: "inactive", status: "idle", createdAt: 1 }));
  store.create(meta({ sessionId: "active-empty", createdAt: 2 }));
  store.create(meta({ sessionId: "active-nonempty", createdAt: 3 }));
  store.create(meta({ sessionId: "deleted", createdAt: 4 }));
  store.markDeleted("deleted");
  const manager = new SessionManager((message) => sent.push(message), () => {}, store, "test-runner");
  const client = {
    resolvePermission: () => false,
    cancel: () => {},
    dispose: () => {},
    prompt: async () => "end_turn" as const,
    setConfig: () => {},
    agentSessionId: () => null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const active = (manager as any).active;
  active.set("active-empty", {
    sessionId: "active-empty", client, repoPath: root, cwd: root, worktree: null,
    context: { kind: "native" }, status: "running", running: true, activeTurnId: "turn-live", queue: [],
  });
  active.set("active-nonempty", {
    sessionId: "active-nonempty", client, repoPath: root, cwd: root, worktree: null,
    context: { kind: "native" }, status: "running", running: true, queue: [{
      id: "preserved", ordinal: 1, text: "survives reconnect", images: [], config: {},
    }],
  });
  try {
    manager.reportQueues();
    const first = sent.filter((message): message is SessionQueueMessage => message.type === "session_queue");
    assert.equal(first.length, 3);
    assert.equal(new Set(first.map((message) => message.sessionId)).size, 3, "one frame per stored session");
    assert.deepEqual(first.find((message) => message.sessionId === "inactive")?.queue, []);
    const empty = first.find((message) => message.sessionId === "active-empty")!;
    assert.deepEqual(empty.queue, []);
    assert.equal(empty.activeTurnId, "turn-live");
    const preservedQueue = first.find((message) => message.sessionId === "active-nonempty")?.queue;
    assert.match(preservedQueue?.[0]?.editRevision ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(preservedQueue, [{
      id: "preserved", text: "survives reconnect", hasImages: false,
      editable: true, editRevision: preservedQueue?.[0]?.editRevision,
      steerable: false, steerDisabledReason: "This provider does not support steering.",
      liveQueueObserved: true,
    }]);
    assert.equal(first.some((message) => message.sessionId === "deleted"), false);

    manager.reportQueues();
    const second = sent.filter((message): message is SessionQueueMessage => message.type === "session_queue").slice(3);
    assert.equal(second.length, 3, "a later registration receives one fresh authoritative frame each");
    assert.equal(new Set(second.map((message) => message.sessionId)).size, 3);
    assert.deepEqual(second.find((message) => message.sessionId === "active-nonempty")?.queue, [{
      id: "preserved", text: "survives reconnect", hasImages: false,
      editable: true, editRevision: preservedQueue?.[0]?.editRevision,
      steerable: false, steerDisabledReason: "This provider does not support steering.",
      liveQueueObserved: true,
    }]);
  } finally {
    manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("process exit clears the queue overlay (queued prompts died with the entry)", () => {
  const { sm, queues, cleanup } = harness();
  try {
    sm.prompt("s_q", "doomed");
    assert.equal(queues().at(-1)!.queue.length, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).onExit("s_q", 1);
    assert.equal(queues().at(-1)!.queue.length, 0, "exit must report an empty queue");
  } finally {
    cleanup();
  }
});

test("queued text is relayed as a bounded preview, full text kept for the turn", () => {
  const { sm, queues, cleanup } = harness();
  try {
    const long = "x".repeat(2000);
    sm.prompt("s_q", long);
    const relayed = queues().at(-1)!.queue[0]!.text;
    assert.ok(relayed.length <= 501, `relayed preview is bounded (got ${relayed.length})`);
    assert.ok(relayed.endsWith("…"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const held = (sm as any).active.get("s_q").queue[0].text;
    assert.equal(held, long, "the runner-side queue keeps the FULL prompt for the actual turn");
  } finally {
    cleanup();
  }
});

test("the queue is capped: overflow drops the prompt with an error event", () => {
  const { sm, queues, cleanup } = harness();
  try {
    for (let i = 0; i < 100; i++) sm.prompt("s_q", `p${i}`);
    assert.equal(queues().at(-1)!.queue.length, 100);
    const countBefore = queues().length;
    sm.prompt("s_q", "one too many");
    assert.equal(queues().length, countBefore, "no queue update for a rejected prompt");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((sm as any).active.get("s_q").queue.length, 100);
  } finally {
    cleanup();
  }
});

test("each queued prompt runs under the config it was SENT with, in order", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-queue-cfg-"));
  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  store.create(meta({ config: { model: "opus" }, resolvedModel: "claude-opus-5[1m]" }));
  const sm = new SessionManager((m) => sent.push(m), () => {}, store, "test-runner");
  const applied: string[] = [];
  const ran: string[] = [];
  const stub = {
    resolvePermission: () => false,
    cancel: () => {},
    dispose: () => {},
    prompt: (text: string) => {
      ran.push(text);
      return Promise.resolve("end_turn" as const);
    },
    setConfig: (c: { model?: string }) => applied.push(c.model ?? "?"),
    agentSessionId: () => "agent-1",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sm as any).active.set("s_q", {
    sessionId: "s_q",
    client: stub,
    repoPath: "/home/me/repo",
    cwd: "/home/me/repo",
    worktree: null,
    status: "running",
    running: true, // hold the turn slot so both prompts queue first
    queue: [],
  });
  try {
    sm.prompt("s_q", "B", [], undefined, { model: "sonnet" });
    sm.prompt("s_q", "C", [], undefined, { model: "opus" });
    assert.deepEqual(applied, [], "config must NOT apply at enqueue time");
    // Release the turn slot and drain.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).active.get("s_q").running = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sm as any).drain("s_q");
    assert.deepEqual(ran, ["B", "C"]);
    assert.deepEqual(applied, ["sonnet", "opus"], "each turn applies ITS OWN config just before running");
    assert.equal(store.readMeta("s_q")?.resolvedModel, null, "changing aliases clears the previously resolved model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a superseded drain cannot release a same-owner replacement drain's lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-drain-lock-generation-"));
  const store = new SessionStore(root);
  store.create(meta());
  const sm = new SessionManager(() => {}, () => {}, store, "test-runner");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lockOwner = (sm as any).lockOwner as string;
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  let finishPrompt!: () => void;
  const pendingPrompt = new Promise<"end_turn">((resolve) => { finishPrompt = () => resolve("end_turn"); });
  const stub = {
    resolvePermission: () => false,
    cancel: () => {},
    dispose: () => {},
    prompt: () => {
      promptStarted();
      return pendingPrompt;
    },
    setConfig: () => {},
    agentSessionId: () => "agent-1",
  };
  const oldEntry = {
    sessionId: "s_q",
    client: stub,
    repoPath: "/home/me/repo",
    cwd: "/home/me/repo",
    worktree: null,
    status: "running",
    running: true,
    queue: [],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sm as any).active.set("s_q", oldEntry);
  let replacementRefresh: ReturnType<typeof setInterval> | undefined;
  try {
    sm.prompt("s_q", "old generation");
    oldEntry.running = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldDrain = (sm as any).drain("s_q") as Promise<void>;
    await started;

    // Restart replaces the active entry and re-acquires the process-wide owner's existing lock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).active.set("s_q", { ...oldEntry, running: true, queue: [] });
    assert.equal(store.acquireLock("s_q", lockOwner), true);
    replacementRefresh = setInterval(() => {}, 60_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).lockTimers.set("s_q", replacementRefresh);

    finishPrompt();
    await oldDrain;
    assert.equal(store.ownsLock("s_q", lockOwner), true, "the replacement must retain its lock");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((sm as any).lockTimers.get("s_q"), replacementRefresh,
      "the replacement must retain its refresh timer");
  } finally {
    finishPrompt();
    if (replacementRefresh) clearInterval(replacementRefresh);
    store.releaseLock("s_q", lockOwner);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the queue byte budget rejects an oversized prompt with an error event", () => {
  const { sm, queues, cleanup } = harness();
  try {
    sm.prompt("s_q", "x".repeat(65 * 1024 * 1024)); // > 64MB budget in one prompt
    assert.equal(queues().length, 0, "rejected prompt must not enter the queue");
  } finally {
    cleanup();
  }
});

test("a control-plane queue hold parks queued prompts without tripping governance", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-sm-cp-hold-"));
  const store = new SessionStore(root);
  store.create(meta({ status: "idle", config: { costBudgetUsd: 10 } }));
  let settleFirst!: (value: "end_turn") => void;
  const firstTurn = new Promise<"end_turn">((resolve) => { settleFirst = resolve; });
  const ran: string[] = [];
  const client = {
    resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {},
    agentSessionId: () => "agent-1",
    prompt: (text: string) => {
      ran.push(text);
      return text === "A" ? firstTurn : Promise.resolve("end_turn" as const);
    },
  };
  const manager = new SessionManager(() => {}, () => {}, store, "test-runner");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).active.set("s_q", {
    sessionId: "s_q", client, repoPath: root, cwd: root, worktree: null,
    context: { kind: "native" }, status: "idle", running: false, queue: [],
  });
  try {
    manager.prompt("s_q", "A");
    await waitFor(() => ran.length === 1);
    manager.prompt("s_q", "B", undefined, undefined, { costBudgetUsd: 5 });
    manager.prompt("s_q", "C", undefined, undefined, { costBudgetUsd: 10 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (manager as any).active.get("s_q");
    manager.interruptTurn("s_q");
    manager.rearmGovernance("s_q", {}, "control_plane");
    assert.equal(entry.controlPlaneHold, true, "the queue is held by the card, on its own flag");
    assert.equal(entry.governanceTripped, undefined, "but nothing tripped: a provider failure would still surface");
    assert.deepEqual(entry.queue.map((queued: { config?: { costBudgetUsd?: number } }) => queued.config?.costBudgetUsd), [5, 10],
      "a threshold-free hold leaves each queued prompt's own budget alone");
    settleFirst("end_turn");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(entry.holdQueuedPromptsAfterInterrupt, false, "the provider finished first, so the interrupt hold cleared");
    assert.deepEqual(ran, ["A"], "but B still waits on the control-plane card");
    manager.rearmGovernance("s_q", {});
    await waitFor(() => ran.length === 3);
    assert.deepEqual(ran, ["A", "B", "C"], "a threshold-free release drains the queue");
    assert.deepEqual(entry.queue, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
