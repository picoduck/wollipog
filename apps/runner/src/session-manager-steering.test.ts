import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  PromptImage,
  PromptImageReference,
  ResolveSteeringAttemptResultMessage,
  RunnerToControlPlane,
  SessionQueueMessage,
  SteerSessionMessage,
  SteerSessionResultMessage,
} from "@wollipog/protocol";
import type { Driver, DriverSteerResult } from "./drivers/driver.js";
import {
  SessionManager,
  type DurableCommandLifecycle,
  type PromptImageResolver,
} from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { handleResolveSteeringAttemptMessage, handleSteerSessionMessage } from "./steering-handler.js";

function meta(root: string): SessionMeta {
  return {
    sessionId: "s_steer",
    agentId: "codex-app-server",
    workspaceId: "repo",
    repoPath: root,
    worktreePath: null,
    driver: "codex-app-server",
    command: "codex",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: "thread-1",
    status: "running",
    title: "steering test",
    config: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, message = "condition should settle"): Promise<void> {
  for (let attempt = 0; attempt < 300 && !predicate(); attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true, message);
}

function harness(
  overrides: Partial<Driver> = {},
  running = true,
  resolvePromptImages?: PromptImageResolver,
) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-steering-"));
  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  store.create(meta(root));
  const driver: Driver = {
    pid: undefined,
    initialize: async () => {},
    newSession: async () => "thread-1",
    agentSessionId: () => "thread-1",
    agentTurnId: () => "provider-turn-a",
    prompt: async () => "end_turn",
    setConfig: () => {},
    cancel: () => {},
    resolvePermission: () => false,
    dispose: () => {},
    ...overrides,
  };
  const manager = new SessionManager((message) => sent.push(message), () => {}, store, "runner-1");
  if (resolvePromptImages) {
    // Test seam for the pre-provider attachment materialization boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).resolvePromptImages = resolvePromptImages;
  }
  // Exercise the state machine without spawning a provider process.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).active.set("s_steer", {
    sessionId: "s_steer",
    client: driver,
    repoPath: root,
    cwd: root,
    worktree: null,
    context: { kind: "native" },
    status: running ? "running" : "idle",
    running,
    activeTurnId: running ? "turn-a" : undefined,
    activeTurnConfig: running ? {} : undefined,
    queue: [],
    steerFenceIds: new Set(),
    reservedPromotions: new Map(),
  });
  const queues = () => sent.filter((message): message is SessionQueueMessage => message.type === "session_queue");
  return { manager, store, driver, sent, queues, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function durable(commandId: string): DurableCommandLifecycle {
  return {
    commandId,
    queued: () => {},
    started: () => {},
    completed: () => {},
    failed: () => {},
    uncertain: () => {},
  };
}

test("runtime steering revocation narrows snapshots without overwriting discovery truth", () => {
  const h = harness();
  try {
    h.store.patchMeta("s_steer", {
      capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: true,
        supportsApprovals: true, supportsSteering: true,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const active = (h.manager as any).active.get("s_steer");
    active.steeringAvailable = false;
    assert.equal(h.manager.sessionSnapshots()[0]?.agentCapabilities?.supportsSteering, false);
    assert.equal(h.store.readMeta("s_steer")?.capabilities?.supportsSteering, true);

    delete active.steeringAvailable;
    assert.equal(
      h.manager.sessionSnapshots()[0]?.agentCapabilities?.supportsSteering,
      undefined,
      "a new process generation inherits current catalog discovery instead of a durable revocation",
    );
  } finally {
    h.cleanup();
  }
});

test("accepted steering is serialized, deduplicated, and authored once by the runner", async () => {
  const provider = deferred<DriverSteerResult>();
  let calls = 0;
  const h = harness({
    steer: async () => { calls++; return provider.promise; },
  });
  try {
    const request = {
      submissionId: "submission-1",
      sessionId: "s_steer",
      turnId: "turn-a",
      text: "change direction",
      images: [],
    };
    const first = h.manager.steerSession(request);
    const duplicate = h.manager.steerSession(request);
    await waitFor(() => calls === 1, "one provider submission starts");
    provider.resolve({ outcome: "accepted", providerTurnId: "provider-turn-a" });

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    assert.deepEqual(duplicateResult, firstResult);
    assert.equal(firstResult.disposition, "accepted");
    assert.equal(calls, 1);
    const accepted = h.store.readEvents("s_steer").filter((event) =>
      event.payload.kind === "user_message" && event.payload.submissionId === "submission-1");
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.payload.kind === "user_message" && accepted[0]!.payload.turnId, "turn-a");
    assert.equal(accepted[0]!.payload.kind === "user_message" && accepted[0]!.payload.deliveryIntent, "steer");

    const conflict = await h.manager.steerSession({ ...request, text: "different content" });
    assert.equal(conflict.disposition, "rejected");
    assert.match(conflict.message ?? "", /different steering content/);
    assert.equal(calls, 1);
  } finally {
    h.cleanup();
  }
});

test("pending agent input blocks direct steering and queued promotion authoritatively", async () => {
  let providerCalls = 0;
  const h = harness({
    steer: async () => {
      providerCalls += 1;
      return { outcome: "accepted", providerTurnId: "provider-turn-a" };
    },
  });
  try {
    h.store.patchMeta("s_steer", {
      status: "input_required",
      pendingApproval: {
        kind: "question",
        requestId: "question-6",
        title: "The agent has 2 questions",
        options: [],
      },
    });
    h.manager.prompt("s_steer", "wait behind the structured question");
    const queued = h.queues().at(-1)!.queue[0]!;
    assert.equal(queued.steerable, false);
    assert.match(queued.steerDisabledReason ?? "", /pending agent input/i);

    const direct = await h.manager.steerSession({
      submissionId: "pending-input-direct",
      sessionId: "s_steer",
      turnId: "turn-a",
      text: "interrupt the question",
    });
    assert.equal(direct.disposition, "rejected");
    assert.equal(direct.reason, "policy_blocked");
    assert.match(direct.message ?? "", /pending agent input/i);

    const promoted = await h.manager.steerSession({
      submissionId: "pending-input-promotion",
      sessionId: "s_steer",
      turnId: "turn-a",
      promotePromptId: queued.id,
    });
    assert.equal(promoted.disposition, "rejected");
    assert.equal(promoted.reason, "policy_blocked");
    assert.equal(providerCalls, 0);
    assert.deepEqual(h.queues().at(-1)!.queue.map((prompt) => prompt.text), [
      "wait behind the structured question",
    ]);
  } finally {
    h.cleanup();
  }
});

test("provider acceptance followed by history flush failure is uncertain", async () => {
  const h = harness({
    steer: async () => ({ outcome: "accepted", providerTurnId: "provider-turn-a" }),
  });
  try {
    const originalFlush = h.store.flush.bind(h.store);
    let failed = false;
    h.store.flush = ((sessionId: string) => {
      if (!failed) {
        failed = true;
        throw new Error("injected flush failure");
      }
      return originalFlush(sessionId);
    }) as typeof h.store.flush;
    const result = await h.manager.steerSession({
      submissionId: "flush-failure",
      sessionId: "s_steer",
      turnId: "turn-a",
      text: "accepted but not durable",
    });
    assert.equal(result.disposition, "uncertain");
    assert.equal(result.reason, "history_integrity_failure");
  } finally {
    h.cleanup();
  }
});

test("distinct steering submissions reach the provider in admission order", async () => {
  const firstProvider = deferred<DriverSteerResult>();
  const secondProvider = deferred<DriverSteerResult>();
  const thirdProvider = deferred<DriverSteerResult>();
  const seen: string[] = [];
  const h = harness({
    steer: async (input) => {
      seen.push(input.text);
      return seen.length === 1
        ? firstProvider.promise
        : seen.length === 2
          ? secondProvider.promise
          : thirdProvider.promise;
    },
  });
  try {
    const first = h.manager.steerSession({
      submissionId: "ordered-1", sessionId: "s_steer", turnId: "turn-a", text: "first",
    });
    const second = h.manager.steerSession({
      submissionId: "ordered-2", sessionId: "s_steer", turnId: "turn-a", text: "second",
    });
    const third = h.manager.steerSession({
      submissionId: "ordered-3", sessionId: "s_steer", turnId: "turn-a", text: "third",
    });
    await waitFor(() => seen.length === 1);
    assert.deepEqual(seen, ["first"]);
    firstProvider.resolve({ outcome: "accepted", providerTurnId: "provider-turn-a" });
    assert.equal((await first).disposition, "accepted");
    await waitFor(() => seen.length === 2);
    assert.deepEqual(seen, ["first", "second"]);
    secondProvider.resolve({ outcome: "accepted", providerTurnId: "provider-turn-a" });
    assert.equal((await second).disposition, "accepted");
    await waitFor(() => seen.length === 3);
    assert.deepEqual(seen, ["first", "second", "third"]);
    thirdProvider.resolve({ outcome: "accepted", providerTurnId: "provider-turn-a" });
    assert.equal((await third).disposition, "accepted");
  } finally {
    h.cleanup();
  }
});

test("direct definite fallback retains admission ordinal ahead of later queued prompts", async () => {
  const firstProvider = deferred<DriverSteerResult>();
  let calls = 0;
  const h = harness({
    steer: async () => {
      calls++;
      return firstProvider.promise;
    },
  });
  try {
    const first = h.manager.steerSession({
      submissionId: "fallback-blocker", sessionId: "s_steer", turnId: "turn-a", text: "blocker",
    });
    const fallback = h.manager.steerSession({
      submissionId: "fallback-direct", sessionId: "s_steer", turnId: "turn-a", text: "fallback",
    });
    h.manager.prompt("s_steer", "later queued prompt");
    await waitFor(() => calls === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.manager as any).active.get("s_steer").activeTurnId = "turn-b";
    firstProvider.resolve({ outcome: "accepted", providerTurnId: "provider-turn-a" });
    assert.equal((await first).disposition, "accepted");
    const result = await fallback;
    assert.equal(result.disposition, "converted_to_queue");
    assert.equal(calls, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queue = (h.manager as any).active.get("s_steer").queue;
    assert.deepEqual(queue.map((prompt: { text: string }) => prompt.text), ["fallback", "later queued prompt"]);
    assert.ok(queue[0].ordinal < queue[1].ordinal);
  } finally {
    h.cleanup();
  }
});

test("direct definite fallback fails closed when the queue fills during its lane wait", async () => {
  const firstProvider = deferred<DriverSteerResult>();
  let calls = 0;
  const h = harness({ steer: async () => { calls++; return firstProvider.promise; } });
  try {
    const first = h.manager.steerSession({
      submissionId: "capacity-blocker", sessionId: "s_steer", turnId: "turn-a", text: "blocker",
    });
    const overflow = h.manager.steerSession({
      submissionId: "capacity-overflow", sessionId: "s_steer", turnId: "turn-a", text: "overflow",
    });
    for (let index = 0; index < 100; index++) {
      assert.equal(h.manager.prompt("s_steer", `queued-${index}`), true);
    }
    await waitFor(() => calls === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.manager as any).active.get("s_steer").activeTurnId = "turn-b";
    firstProvider.resolve({ outcome: "accepted", providerTurnId: "provider-turn-a" });
    await first;
    const result = await overflow;
    assert.equal(result.disposition, "rejected");
    assert.equal(result.reason, "queue_capacity_exceeded");
    assert.equal(calls, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((h.manager as any).active.get("s_steer").queue.length, 100);
  } finally {
    h.cleanup();
  }
});

test("driver turn-closure outcomes convert direct input while generic rejection stays rejected", async () => {
  for (const driverOutcome of ["no_active_turn", "stale_turn"] as const) {
    const h = harness({
      steer: async () => ({ outcome: driverOutcome, reason: `typed ${driverOutcome}` }),
    });
    try {
      const images = [{ mimeType: "image/png", data: "YQ==" }];
      const result = await h.manager.steerSession({
        submissionId: `post-turn-${driverOutcome}`,
        sessionId: "s_steer",
        turnId: "turn-a",
        text: `exact ${driverOutcome} payload`,
        images,
      });
      assert.equal(result.disposition, "converted_to_queue");
      assert.equal(result.reason, driverOutcome === "no_active_turn" ? "no_active_provider_turn" : "stale_turn");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queue = (h.manager as any).active.get("s_steer").queue;
      assert.equal(queue.length, 1);
      assert.equal(queue[0].text, `exact ${driverOutcome} payload`);
      assert.deepEqual(queue[0].images, images);
      assert.equal(queue[0].id, result.queuedPromptId);
    } finally {
      h.cleanup();
    }
  }

  const rejected = harness({
    steer: async () => ({ outcome: "rejected", reason: "provider declined this content" }),
  });
  try {
    const result = await rejected.manager.steerSession({
      submissionId: "generic-provider-rejection",
      sessionId: "s_steer",
      turnId: "turn-a",
      text: "do not replay",
    });
    assert.equal(result.disposition, "rejected");
    assert.equal(result.reason, "provider_rejected");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.deepEqual((rejected.manager as any).active.get("s_steer").queue, []);
  } finally {
    rejected.cleanup();
  }
});

test("typed stale-turn outcome restores a promoted source by ordinal", async () => {
  const h = harness({
    steer: async () => ({ outcome: "stale_turn", reason: "provider turn changed during delivery" }),
  });
  try {
    h.manager.prompt("s_steer", "promoted source");
    h.manager.prompt("s_steer", "later source");
    const sourceId = h.queues().at(-1)!.queue[0]!.id;
    const result = await h.manager.steerSession({
      submissionId: "promotion-stale-driver",
      sessionId: "s_steer",
      turnId: "turn-a",
      promotePromptId: sourceId,
    });
    assert.equal(result.disposition, "rejected");
    assert.equal(result.reason, "stale_turn");
    await new Promise<void>((resolve) => setImmediate(resolve));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queue = (h.manager as any).active.get("s_steer").queue;
    assert.deepEqual(queue.map((prompt: { text: string }) => prompt.text), ["promoted source", "later source"]);
    assert.equal(queue[0].id, sourceId);
    assert.ok(queue[0].ordinal < queue[1].ordinal);
  } finally {
    h.cleanup();
  }
});

test("promotion reserves synchronously and restores by stable ordinal after later admissions", async () => {
  const provider = deferred<DriverSteerResult>();
  const h = harness({ steer: async () => provider.promise });
  try {
    h.manager.prompt("s_steer", "B");
    h.manager.prompt("s_steer", "C");
    const sourceId = h.queues().at(-1)!.queue[0]!.id;
    const resultPromise = h.manager.steerSession({
      submissionId: "promotion-1",
      sessionId: "s_steer",
      turnId: "turn-a",
      promotePromptId: sourceId,
    });
    assert.equal(h.queues().at(-1)!.queue[0]!.steeringState, "promoting");
    h.manager.prompt("s_steer", "D");
    provider.resolve({ outcome: "rejected", reason: "not accepted" });
    const result = await resultPromise;
    assert.equal(result.disposition, "rejected");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(h.queues().at(-1)!.queue.map((prompt) => prompt.text), ["B", "C", "D"]);
  } finally {
    h.cleanup();
  }
});

test("promotion config mismatch restores the source without reaching the provider", async () => {
  let calls = 0;
  const h = harness({ steer: async () => { calls++; return { outcome: "accepted" }; } });
  try {
    h.manager.prompt("s_steer", "different config", [], undefined, { model: "other-model" });
    const sourceId = h.queues().at(-1)!.queue[0]!.id;
    const result = await h.manager.steerSession({
      submissionId: "promotion-config", sessionId: "s_steer", turnId: "turn-a", promotePromptId: sourceId,
    });
    assert.equal(result.disposition, "rejected");
    assert.equal(result.reason, "configuration_mismatch");
    assert.equal(calls, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(h.queues().at(-1)!.queue.map((prompt) => prompt.text), ["different config"]);
    assert.equal(h.queues().at(-1)!.queue[0]!.steeringState, undefined);
  } finally {
    h.cleanup();
  }
});

test("queue projection reports runner-known steering eligibility fail closed", () => {
  const eligible = harness({ steer: async () => ({ outcome: "accepted" }) });
  try {
    eligible.manager.prompt("s_steer", "eligible source");
    const projected = eligible.queues().at(-1)!.queue[0]!;
    assert.equal(projected.steerable, true);
    assert.equal(projected.steerDisabledReason, undefined);
  } finally {
    eligible.cleanup();
  }

  const noActiveTurn = harness({ steer: async () => ({ outcome: "accepted" }) });
  try {
    noActiveTurn.manager.prompt("s_steer", "wait for a turn");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (noActiveTurn.manager as any).active.get("s_steer");
    entry.running = false;
    entry.activeTurnId = undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (noActiveTurn.manager as any).emitQueue("s_steer");
    const projected = noActiveTurn.queues().at(-1)!.queue[0]!;
    assert.equal(projected.steerable, false);
    assert.match(projected.steerDisabledReason ?? "", /active provider turn/i);
  } finally {
    noActiveTurn.cleanup();
  }

  const unsupported = harness();
  try {
    unsupported.manager.prompt("s_steer", "unsupported source");
    const projected = unsupported.queues().at(-1)!.queue[0]!;
    assert.equal(projected.steerable, false);
    assert.match(projected.steerDisabledReason ?? "", /does not support steering/i);
  } finally {
    unsupported.cleanup();
  }

  const mismatch = harness({ steer: async () => ({ outcome: "accepted" }) });
  try {
    mismatch.manager.prompt("s_steer", "different config", [], undefined, { model: "other-model" });
    const projected = mismatch.queues().at(-1)!.queue[0]!;
    assert.equal(projected.steerable, false);
    assert.match(projected.steerDisabledReason ?? "", /configuration differs/i);
  } finally {
    mismatch.cleanup();
  }
});

test("durable workflow and synthetic recovery queue items cannot be promoted", async () => {
  let calls = 0;
  const h = harness({ steer: async () => { calls++; return { outcome: "accepted" }; } });
  try {
    h.manager.prompt("s_steer", "workflow", [], undefined, undefined, durable("workflow-command"));
    h.manager.prompt("s_steer", "synthetic recovery", [], undefined, undefined, undefined, true);
    const projected = h.queues().at(-1)!.queue;
    assert.deepEqual(projected.map((prompt) => prompt.steerable), [false, false]);
    assert.match(projected[0]!.steerDisabledReason ?? "", /workflow, automation, provider-command, and recovery/i);
    assert.match(projected[1]!.steerDisabledReason ?? "", /workflow, automation, provider-command, and recovery/i);
    const [workflowId, syntheticId] = projected.map((prompt) => prompt.id);
    const workflow = await h.manager.steerSession({
      submissionId: "promotion-workflow", sessionId: "s_steer", turnId: "turn-a", promotePromptId: workflowId,
    });
    const synthetic = await h.manager.steerSession({
      submissionId: "promotion-synthetic", sessionId: "s_steer", turnId: "turn-a", promotePromptId: syntheticId,
    });
    assert.equal(workflow.disposition, "rejected");
    assert.equal(workflow.reason, "configuration_mismatch");
    assert.equal(synthetic.disposition, "rejected");
    assert.equal(synthetic.reason, "configuration_mismatch");
    assert.equal(calls, 0);
    assert.deepEqual(h.queues().at(-1)!.queue.map((prompt) => prompt.text), ["workflow", "synthetic recovery"]);
  } finally {
    h.cleanup();
  }
});

test("automation-owned active turns reject direct and promoted steering", async () => {
  let calls = 0;
  const h = harness({ steer: async () => { calls++; return { outcome: "accepted" }; } });
  try {
    h.manager.prompt("s_steer", "ordinary queued source");
    const sourceId = h.queues().at(-1)!.queue[0]!.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.manager as any).active.get("s_steer").currentDurable = durable("active-automation");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.manager as any).emitQueue("s_steer");
    assert.equal(h.queues().at(-1)!.queue[0]!.steerable, false);
    assert.match(h.queues().at(-1)!.queue[0]!.steerDisabledReason ?? "", /automation-owned/i);
    const direct = await h.manager.steerSession({
      submissionId: "automation-direct", sessionId: "s_steer", turnId: "turn-a", text: "manual steer",
    });
    const promoted = await h.manager.steerSession({
      submissionId: "automation-promotion", sessionId: "s_steer", turnId: "turn-a", promotePromptId: sourceId,
    });
    assert.equal(direct.disposition, "rejected");
    assert.equal(direct.reason, "policy_blocked");
    assert.equal(promoted.disposition, "rejected");
    assert.equal(promoted.reason, "policy_blocked");
    assert.equal(calls, 0);
    assert.deepEqual(h.queues().at(-1)!.queue.map((prompt) => prompt.text), ["ordinary queued source"]);
  } finally {
    h.cleanup();
  }
});

test("omitted and empty queue configs snapshot the same inherited effective config", async () => {
  const seen: string[] = [];
  const h = harness({
    steer: async (input) => { seen.push(input.text); return { outcome: "accepted" }; },
  });
  try {
    h.store.patchMeta("s_steer", { config: { model: "inherited-model", effort: "high" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.manager as any).active.get("s_steer").activeTurnConfig = { model: "inherited-model", effort: "high" };
    h.manager.prompt("s_steer", "omitted config");
    h.manager.prompt("s_steer", "empty config", [], undefined, {});
    const ids = h.queues().at(-1)!.queue.map((prompt) => prompt.id);
    const omitted = await h.manager.steerSession({
      submissionId: "config-omitted", sessionId: "s_steer", turnId: "turn-a", promotePromptId: ids[0],
    });
    const empty = await h.manager.steerSession({
      submissionId: "config-empty", sessionId: "s_steer", turnId: "turn-a", promotePromptId: ids[1],
    });
    assert.equal(omitted.disposition, "accepted");
    assert.equal(empty.disposition, "accepted");
    assert.deepEqual(seen, ["omitted config", "empty config"]);
  } finally {
    h.cleanup();
  }
});

test("later config changes cannot retroactively change an inherited queued promotion", async () => {
  let calls = 0;
  const h = harness({ steer: async () => { calls++; return { outcome: "accepted" }; } });
  try {
    h.store.patchMeta("s_steer", { config: { model: "base-model" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (h.manager as any).active.get("s_steer");
    entry.activeTurnConfig = { model: "base-model" };
    h.manager.prompt("s_steer", "earlier config change", [], undefined, { model: "next-model" });
    h.manager.prompt("s_steer", "inherited before change");
    const inheritedId = h.queues().at(-1)!.queue[1]!.id;

    // Model the earlier queued turn applying its config. The later source must retain base-model.
    entry.activeTurnConfig = { model: "next-model" };
    h.store.patchMeta("s_steer", { config: { model: "next-model" } });
    const result = await h.manager.steerSession({
      submissionId: "config-snapshot", sessionId: "s_steer", turnId: "turn-a", promotePromptId: inheritedId,
    });
    assert.equal(result.disposition, "rejected");
    assert.equal(result.reason, "configuration_mismatch");
    assert.equal(calls, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(h.queues().at(-1)!.queue.map((prompt) => prompt.text), [
      "earlier config change",
      "inherited before change",
    ]);
  } finally {
    h.cleanup();
  }
});

test("uncertain promotion remains non-runnable until dismissed and later prompts cannot overtake", async () => {
  const ran: string[] = [];
  const h = harness({
    steer: async () => ({ outcome: "uncertain", reason: "provider acknowledgement lost" }),
    prompt: async (text) => { ran.push(text); return "end_turn"; },
  });
  try {
    h.manager.prompt("s_steer", "reserved source");
    const sourceId = h.queues().at(-1)!.queue[0]!.id;
    const result = await h.manager.steerSession({
      submissionId: "promotion-uncertain", sessionId: "s_steer", turnId: "turn-a", promotePromptId: sourceId,
    });
    assert.equal(result.disposition, "uncertain");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.queues().at(-1)!.queue[0]!.steeringState, "uncertain");

    // Model the active turn settling, then admit later work. The uncertain ordinal is a barrier.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (h.manager as any).active.get("s_steer");
    entry.running = false;
    entry.activeTurnId = undefined;
    h.manager.prompt("s_steer", "later prompt");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(ran, []);
    assert.deepEqual(h.queues().at(-1)!.queue.map((prompt) => prompt.text), ["reserved source", "later prompt"]);

    h.manager.removeQueuedPrompt("s_steer", sourceId);
    await waitFor(() => ran.length === 1, "later work resumes only after uncertain source dismissal");
    assert.deepEqual(ran, ["later prompt"]);
  } finally {
    h.cleanup();
  }
});

test("queued cancellation during promotion wins only before provider acceptance", async () => {
  const provider = deferred<DriverSteerResult>();
  const h = harness({ steer: async () => provider.promise });
  try {
    h.manager.prompt("s_steer", "B");
    h.manager.prompt("s_steer", "C");
    const sourceId = h.queues().at(-1)!.queue[0]!.id;
    const resultPromise = h.manager.steerSession({
      submissionId: "promotion-cancel",
      sessionId: "s_steer",
      turnId: "turn-a",
      promotePromptId: sourceId,
    });
    h.manager.removeQueuedPrompt("s_steer", sourceId);
    provider.resolve({ outcome: "rejected", reason: "definite rejection" });
    assert.equal((await resultPromise).disposition, "rejected");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(h.queues().at(-1)!.queue.map((prompt) => prompt.text), ["C"]);
  } finally {
    h.cleanup();
  }
});

test("provider acceptance wins a racing queued cancellation without replaying the source", async () => {
  const provider = deferred<DriverSteerResult>();
  const h = harness({ steer: async () => provider.promise });
  try {
    h.manager.prompt("s_steer", "B");
    h.manager.prompt("s_steer", "C");
    const sourceId = h.queues().at(-1)!.queue[0]!.id;
    const resultPromise = h.manager.steerSession({
      submissionId: "promotion-accepted-cancel",
      sessionId: "s_steer",
      turnId: "turn-a",
      promotePromptId: sourceId,
    });
    h.manager.removeQueuedPrompt("s_steer", sourceId);
    provider.resolve({ outcome: "accepted", providerTurnId: "provider-turn-a" });
    const result = await resultPromise;
    assert.equal(result.disposition, "accepted");
    assert.match(result.message ?? "", /accepted before queued cancellation/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(h.queues().at(-1)!.queue.map((prompt) => prompt.text), ["C"]);
    assert.equal(h.store.readEvents("s_steer").filter((event) =>
      event.payload.kind === "user_message" && event.payload.submissionId === "promotion-accepted-cancel").length, 1);
  } finally {
    h.cleanup();
  }
});

test("a steering fence prevents the next turn from overtaking an unresolved acceptance", async () => {
  const turnA = deferred<"end_turn">();
  const steering = deferred<DriverSteerResult>();
  const ran: string[] = [];
  const h = harness({
    prompt: async (text) => {
      ran.push(text);
      return text === "A" ? turnA.promise : "end_turn";
    },
    steer: async () => steering.promise,
  }, false);
  try {
    h.manager.prompt("s_steer", "A");
    await waitFor(() => ran.length === 1, "turn A starts");
    const turnId = h.queues().at(-1)!.activeTurnId!;
    h.manager.prompt("s_steer", "C");
    const steer = h.manager.steerSession({
      submissionId: "fenced",
      sessionId: "s_steer",
      turnId,
      text: "B as steering",
    });
    turnA.resolve("end_turn");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(ran, ["A"], "C remains fenced after A completes");

    steering.resolve({ outcome: "accepted", providerTurnId: "provider-turn-a" });
    assert.equal((await steer).disposition, "accepted");
    await waitFor(() => ran.length === 2, "C runs after the terminal steer result");
    assert.deepEqual(ran, ["A", "C"]);
  } finally {
    h.cleanup();
  }
});

test("the whole-submission deadline includes lane wait and conversion preserves interrupt hold", async () => {
  const late = deferred<DriverSteerResult>();
  let calls = 0;
  const h = harness({ steer: async () => { calls++; return late.promise; } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.manager as any).steeringSubmissionTimeoutMs = 250;
    const first = h.manager.steerSession({
      submissionId: "deadline-1", sessionId: "s_steer", turnId: "turn-a", text: "first",
    });
    await waitFor(() => calls === 1, "the first submission crosses the provider boundary");
    // Give the lane waiter a strictly earlier deadline than the provider call ahead of it. Using
    // one shared timeout makes this assertion scheduler-sensitive because the second submission is
    // created a few milliseconds later and can reach the interrupt gate before its own deadline.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.manager as any).steeringSubmissionTimeoutMs = 25;
    const second = h.manager.steerSession({
      submissionId: "deadline-2", sessionId: "s_steer", turnId: "turn-a", text: "second",
    });
    assert.equal(h.manager.interruptTurn("s_steer", "turn-a"), "applied");

    assert.equal((await first).disposition, "uncertain");
    const secondResult = await second;
    assert.equal(secondResult.disposition, "converted_to_queue");
    assert.equal(calls, 1, "the expired lane waiter never reaches the provider");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (h.manager as any).active.get("s_steer");
    assert.equal(entry.holdQueuedPromptsAfterInterrupt, true);
    assert.deepEqual(entry.queue.map((prompt: { text: string }) => prompt.text), ["second"]);
    late.resolve({ outcome: "accepted", providerTurnId: "provider-turn-a" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.store.readEvents("s_steer").some((event) =>
      event.payload.kind === "user_message" && event.payload.submissionId === "deadline-1"), false,
    "a late accepted response cannot rewrite the terminal uncertain result");
  } finally {
    h.cleanup();
  }
});

test("interrupt before provider submission rejects, while provider acceptance during await wins", async () => {
  const materialized = deferred<PromptImage[]>();
  let preProviderCalls = 0;
  const reference: PromptImageReference = {
    artifactId: "steering-image",
    mimeType: "image/png",
    sizeBytes: 1,
    sha256: "a".repeat(64),
  };
  const before = harness(
    { steer: async () => { preProviderCalls++; return { outcome: "accepted" }; } },
    true,
    async () => materialized.promise,
  );
  try {
    const resultPromise = before.manager.steerSession({
      submissionId: "interrupt-before-provider",
      sessionId: "s_steer",
      turnId: "turn-a",
      text: "with attachment",
      images: [reference],
    });
    assert.equal(before.manager.interruptTurn("s_steer", "turn-a"), "applied");
    materialized.resolve([{ mimeType: "image/png", data: "YQ==" }]);
    const result = await resultPromise;
    assert.equal(result.disposition, "rejected");
    assert.equal(result.reason, "policy_blocked");
    assert.equal(preProviderCalls, 0);
  } finally {
    before.cleanup();
  }

  const provider = deferred<DriverSteerResult>();
  let duringCalls = 0;
  const during = harness({ steer: async () => { duringCalls++; return provider.promise; } });
  try {
    const resultPromise = during.manager.steerSession({
      submissionId: "interrupt-during-provider",
      sessionId: "s_steer",
      turnId: "turn-a",
      text: "already submitted",
    });
    await waitFor(() => duringCalls === 1);
    assert.equal(during.manager.interruptTurn("s_steer", "turn-a"), "applied");
    provider.resolve({ outcome: "accepted", providerTurnId: "provider-turn-a" });
    const result = await resultPromise;
    assert.equal(result.disposition, "accepted");
    assert.equal(during.store.readEvents("s_steer").filter((event) =>
      event.payload.kind === "user_message" && event.payload.submissionId === "interrupt-during-provider").length, 1);
  } finally {
    during.cleanup();
  }
});

test("direct uncertain attempts can queue again or dismiss with payload scrubbing", async () => {
  const queueAgain = harness({ steer: async () => ({ outcome: "uncertain", reason: "lost acknowledgement" }) });
  try {
    const result = await queueAgain.manager.steerSession({
      submissionId: "resolve-direct-queue", sessionId: "s_steer", turnId: "turn-a", text: "retry me",
      images: [{ mimeType: "image/png", data: "YQ==" }],
    });
    assert.equal(result.disposition, "uncertain");
    // Resolution is not an explicit user prompt and must not clear an existing interrupt hold.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (queueAgain.manager as any).active.get("s_steer");
    entry.holdQueuedPromptsAfterInterrupt = true;
    const resolution = queueAgain.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "resolve-direct-queue", action: "queue_again",
    });
    assert.equal(resolution.applied, true);
    assert.ok(resolution.queuedPromptId);
    assert.equal(entry.holdQueuedPromptsAfterInterrupt, true);
    assert.deepEqual(entry.queue.map((prompt: { text: string }) => prompt.text), ["retry me"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const operation = (queueAgain.manager as any).steeringRegistry.get("s_steer").get("resolve-direct-queue");
    assert.equal(operation.request.text, undefined);
    assert.equal(operation.request.images, undefined);
    assert.deepEqual(operation.effectiveConfig, {});
    const replayed = queueAgain.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "resolve-direct-queue", action: "queue_again",
    });
    assert.equal(replayed.applied, true);
    assert.equal(replayed.queuedPromptId, resolution.queuedPromptId);
    assert.equal(queueAgain.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "resolve-direct-queue", action: "dismiss",
    }).reason, "resolution_action_conflict");
  } finally {
    queueAgain.cleanup();
  }

  const dismiss = harness({ steer: async () => ({ outcome: "uncertain", reason: "lost acknowledgement" }) });
  try {
    await dismiss.manager.steerSession({
      submissionId: "resolve-direct-dismiss", sessionId: "s_steer", turnId: "turn-a", text: "discard me",
    });
    const resolution = dismiss.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "resolve-direct-dismiss", action: "dismiss",
    });
    assert.equal(resolution.applied, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (dismiss.manager as any).active.get("s_steer");
    assert.deepEqual(entry.queue, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const operation = (dismiss.manager as any).steeringRegistry.get("s_steer").get("resolve-direct-dismiss");
    assert.equal(operation.request.text, undefined);
  } finally {
    dismiss.cleanup();
  }
});

test("promoted uncertain attempts restore by ordinal on queue-again or drop on dismiss", async () => {
  const queueAgain = harness({ steer: async () => ({ outcome: "uncertain", reason: "lost acknowledgement" }) });
  try {
    queueAgain.manager.prompt("s_steer", "promoted source");
    queueAgain.manager.prompt("s_steer", "later source");
    const sourceId = queueAgain.queues().at(-1)!.queue[0]!.id;
    await queueAgain.manager.steerSession({
      submissionId: "resolve-promotion-queue", sessionId: "s_steer", turnId: "turn-a", promotePromptId: sourceId,
    });
    const resolution = queueAgain.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "resolve-promotion-queue", action: "queue_again",
    });
    assert.equal(resolution.applied, true);
    assert.equal(resolution.queuedPromptId, sourceId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (queueAgain.manager as any).active.get("s_steer");
    assert.deepEqual(entry.queue.map((prompt: { text: string }) => prompt.text), ["promoted source", "later source"]);
    assert.ok(entry.queue[0].ordinal < entry.queue[1].ordinal);
    assert.equal(entry.reservedPromotions.size, 0);
  } finally {
    queueAgain.cleanup();
  }

  const dismiss = harness({ steer: async () => ({ outcome: "uncertain", reason: "lost acknowledgement" }) });
  try {
    dismiss.manager.prompt("s_steer", "drop promoted source");
    dismiss.manager.prompt("s_steer", "keep later source");
    const sourceId = dismiss.queues().at(-1)!.queue[0]!.id;
    await dismiss.manager.steerSession({
      submissionId: "resolve-promotion-dismiss", sessionId: "s_steer", turnId: "turn-a", promotePromptId: sourceId,
    });
    dismiss.manager.removeQueuedPrompt("s_steer", sourceId);
    const racedQueueAgain = dismiss.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "resolve-promotion-dismiss", action: "queue_again",
    });
    assert.equal(racedQueueAgain.applied, false);
    assert.equal(racedQueueAgain.reason, "resolution_action_conflict");
    const repeatedDismiss = dismiss.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "resolve-promotion-dismiss", action: "dismiss",
    });
    assert.equal(repeatedDismiss.applied, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (dismiss.manager as any).active.get("s_steer");
    assert.deepEqual(entry.queue.map((prompt: { text: string }) => prompt.text), ["keep later source"]);
    assert.equal(entry.reservedPromotions.size, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const operation = (dismiss.manager as any).steeringRegistry.get("s_steer").get("resolve-promotion-dismiss");
    assert.equal(operation.resolved, true);
    assert.equal(operation.source, undefined);
    assert.equal(operation.request.promotePromptId, sourceId);
  } finally {
    dismiss.cleanup();
  }
});

test("promoted queue-again counts retained recovery reservations against capacity", async () => {
  const h = harness({ steer: async () => ({ outcome: "uncertain", reason: "lost acknowledgement" }) });
  try {
    h.manager.prompt("s_steer", "retained promotion");
    const sourceId = h.queues().at(-1)!.queue[0]!.id;
    await h.manager.steerSession({
      submissionId: "resolve-recovery-capacity",
      sessionId: "s_steer",
      turnId: "turn-a",
      promotePromptId: sourceId,
    });
    // Model a retained recovery queue produced by an older runner that did not count the
    // out-of-array reservation while admitting its final item.
    const recovery = Array.from({ length: 100 }, (_, index) => ({
      id: `recovered-${index}`,
      ordinal: index + 2,
      text: `recovered ${index}`,
      images: [],
      config: {},
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.manager as any).active.delete("s_steer");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.manager as any).recoveryQueues.set("s_steer", recovery);
    const saturated = h.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "resolve-recovery-capacity", action: "queue_again",
    });
    assert.equal(saturated.applied, false);
    assert.equal(saturated.reason, "queue_capacity_exceeded");
    assert.equal(recovery.length, 100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const operation = (h.manager as any).steeringRegistry.get("s_steer").get("resolve-recovery-capacity");
    assert.equal(operation.source.id, sourceId);
    assert.equal(operation.resolved, undefined);

    recovery.pop();
    const retried = h.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "resolve-recovery-capacity", action: "queue_again",
    });
    assert.equal(retried.applied, true);
    assert.equal(retried.queuedPromptId, sourceId);
    assert.equal(recovery.length, 100);
    assert.equal(recovery[0]!.id, sourceId, "the restored promotion keeps its earlier ordinal");
  } finally {
    h.cleanup();
  }
});

test("unresolved steering attempts are bounded to the recoverable projection size", async () => {
  let calls = 0;
  const h = harness({
    steer: async () => { calls++; return { outcome: "uncertain", reason: "lost acknowledgement" }; },
  });
  try {
    for (let index = 0; index < 50; index++) {
      const result = await h.manager.steerSession({
        submissionId: `bounded-uncertain-${index}`,
        sessionId: "s_steer",
        turnId: "turn-a",
        text: `uncertain ${index}`,
      });
      assert.equal(result.disposition, "uncertain");
    }
    const overflow = await h.manager.steerSession({
      submissionId: "bounded-overflow", sessionId: "s_steer", turnId: "turn-a", text: "must fail closed",
    });
    assert.equal(overflow.disposition, "rejected");
    assert.equal(overflow.reason, "queue_capacity_exceeded");
    assert.equal(calls, 50);

    assert.equal(h.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "bounded-uncertain-0", action: "dismiss",
    }).applied, true);
    const identicalRetry = await h.manager.steerSession({
      submissionId: "bounded-overflow", sessionId: "s_steer", turnId: "turn-a", text: "must fail closed",
    });
    assert.equal(identicalRetry.disposition, "rejected");
    assert.equal(identicalRetry.reason, "queue_capacity_exceeded");
    const conflictingRetry = await h.manager.steerSession({
      submissionId: "bounded-overflow", sessionId: "s_steer", turnId: "turn-a", text: "different reuse",
    });
    assert.equal(conflictingRetry.disposition, "rejected");
    assert.match(conflictingRetry.message ?? "", /different steering content/);
    assert.equal(calls, 50, "a recorded cap decision remains terminal after capacity reopens");
    const admitted = await h.manager.steerSession({
      submissionId: "bounded-after-resolution", sessionId: "s_steer", turnId: "turn-a", text: "one slot reopened",
    });
    assert.equal(admitted.disposition, "uncertain");
    assert.equal(calls, 51);
  } finally {
    h.cleanup();
  }
});

test("unresolved steering byte budget uses decoded inline and referenced image sizes", async () => {
  let calls = 0;
  const h = harness({
    steer: async () => { calls++; return { outcome: "uncertain", reason: "lost acknowledgement" }; },
  }, true, async (_sessionId, images) => images.map((image) => ({ mimeType: image.mimeType, data: "YQ==" })));
  const references = (prefix: string, sizes: number[]): PromptImageReference[] => sizes.map((sizeBytes, index) => ({
    artifactId: `${prefix}-${index}`,
    mimeType: "image/png",
    sizeBytes,
    sha256: String(index % 10).repeat(64),
  }));
  try {
    const inlineBase64 = "A".repeat(48 * 1024 * 1024); // 36 MiB decoded, not 48 MiB retained.
    assert.equal((await h.manager.steerSession({
      submissionId: "bytes-inline", sessionId: "s_steer", turnId: "turn-a", text: "inline",
      images: [{ mimeType: "image/png", data: inlineBase64 }],
    })).disposition, "uncertain");
    const referenced = await h.manager.steerSession({
      submissionId: "bytes-references", sessionId: "s_steer", turnId: "turn-a", text: "references",
      images: references("twenty", [8 * 1024 * 1024, 8 * 1024 * 1024, 4 * 1024 * 1024]),
    });
    assert.equal(referenced.disposition, "uncertain",
      `36 MiB decoded + 20 MiB referenced stays within 64 MiB: ${JSON.stringify(referenced)}`);
    const overflow = await h.manager.steerSession({
      submissionId: "bytes-overflow", sessionId: "s_steer", turnId: "turn-a", text: "overflow",
      images: references("ten", [5 * 1024 * 1024, 5 * 1024 * 1024]),
    });
    assert.equal(overflow.disposition, "rejected");
    assert.equal(overflow.reason, "queue_capacity_exceeded");
    assert.equal(calls, 2);

    assert.equal(h.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "bytes-inline", action: "dismiss",
    }).applied, true);
    const afterResolution = await h.manager.steerSession({
      submissionId: "bytes-after-resolution", sessionId: "s_steer", turnId: "turn-a", text: "after resolution",
      images: references("after", [5 * 1024 * 1024, 5 * 1024 * 1024]),
    });
    assert.equal(afterResolution.disposition, "uncertain");
    assert.equal(calls, 3, "scrubbing a resolved payload frees retained-byte capacity");
  } finally {
    h.cleanup();
  }
});

test("terminal registry pruning never evicts pending or uncertain submissions", async () => {
  const pendingProvider = deferred<DriverSteerResult>();
  const h = harness({
    steer: async (input) => input.text === "uncertain"
      ? { outcome: "uncertain", reason: "unknown provider boundary" }
      : pendingProvider.promise,
  });
  try {
    const uncertain = await h.manager.steerSession({
      submissionId: "registry-uncertain", sessionId: "s_steer", turnId: "turn-a", text: "uncertain",
    });
    assert.equal(uncertain.disposition, "uncertain");

    const terminals: Promise<unknown>[] = [];
    for (let index = 0; index < 1_024; index++) {
      terminals.push(h.manager.steerSession({
        submissionId: `registry-terminal-${index}`, sessionId: "s_steer", turnId: "turn-a",
      }));
    }
    await Promise.all(terminals);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Replay refreshes this oldest entry, so the next prune must evict terminal-1 instead.
    await h.manager.steerSession({
      submissionId: "registry-terminal-0", sessionId: "s_steer", turnId: "turn-a",
    });

    const pending = h.manager.steerSession({
      submissionId: "registry-pending", sessionId: "s_steer", turnId: "turn-a", text: "pending",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await h.manager.steerSession({
      submissionId: "registry-later-terminal", sessionId: "s_steer", turnId: "turn-a",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry: Map<string, unknown> = (h.manager as any).steeringRegistry.get("s_steer");
    assert.equal(registry.has("registry-uncertain"), true);
    assert.equal(registry.has("registry-pending"), true);
    assert.equal(registry.has("registry-terminal-0"), true, "recent duplicate replay refreshes LRU access");
    assert.equal(registry.has("registry-terminal-1"), false, "the least recently accessed terminal is evicted");
    assert.ok(registry.size <= 1_026, "only the bounded terminal replay window plus protected entries remains");
    pendingProvider.resolve({ outcome: "rejected", reason: "test cleanup" });
    assert.equal((await pending).disposition, "rejected");
  } finally {
    h.cleanup();
  }
});

test("runner steering handler preserves each transport requestId independently", async () => {
  const first = deferred<Omit<SteerSessionResultMessage, "type" | "requestId">>();
  const second = deferred<Omit<SteerSessionResultMessage, "type" | "requestId">>();
  const sent: SteerSessionResultMessage[] = [];
  const sessions = {
    steerSession: (request: Omit<SteerSessionMessage, "type" | "requestId">) =>
      request.submissionId === "handler-first" ? first.promise : second.promise,
  } as unknown as Pick<SessionManager, "steerSession">;
  const base = { type: "steer_session", sessionId: "s_steer", turnId: "turn-a", text: "steer" } as const;
  handleSteerSessionMessage({ ...base, requestId: "request-first", submissionId: "handler-first" }, sessions, (message) => sent.push(message));
  handleSteerSessionMessage({ ...base, requestId: "request-second", submissionId: "handler-second" }, sessions, (message) => sent.push(message));
  handleSteerSessionMessage({
    ...base,
    requestId: "request-malformed",
    submissionId: "handler-malformed",
    images: [{ mimeType: "text/plain", data: "not-an-image" }],
  } as SteerSessionMessage, sessions, (message) => sent.push(message));

  second.resolve({
    submissionId: "handler-second", sessionId: "s_steer", turnId: "turn-a",
    disposition: "accepted", reason: "accepted",
  });
  first.resolve({
    submissionId: "handler-first", sessionId: "s_steer", turnId: "turn-a",
    disposition: "accepted", reason: "accepted",
  });
  await waitFor(() => sent.length === 3);
  assert.deepEqual(new Map(sent.map((result) => [result.submissionId, result.requestId])), new Map([
    ["handler-first", "request-first"],
    ["handler-second", "request-second"],
    ["handler-malformed", "request-malformed"],
  ]));

  const resolutions: ResolveSteeringAttemptResultMessage[] = [];
  let resolutionCalls = 0;
  const resolutionSessions = {
    resolveSteeringAttempt: (request: { sessionId: string; submissionId: string; action: "queue_again" | "dismiss" }) => {
      resolutionCalls++;
      return { ...request, applied: true };
    },
  } as Pick<SessionManager, "resolveSteeringAttempt">;
  handleResolveSteeringAttemptMessage({
    type: "resolve_steering_attempt",
    requestId: "resolution-request",
    sessionId: "s_steer",
    submissionId: "handler-first",
    action: "dismiss",
  }, resolutionSessions, (message) => resolutions.push(message));
  assert.deepEqual(resolutions, [{
    type: "resolve_steering_attempt_result",
    requestId: "resolution-request",
    sessionId: "s_steer",
    submissionId: "handler-first",
    action: "dismiss",
    applied: true,
  }]);
  handleResolveSteeringAttemptMessage({
    type: "resolve_steering_attempt",
    requestId: "invalid-action-request",
    sessionId: "s_steer",
    submissionId: "must-not-dismiss",
    action: "archive" as "dismiss",
  }, resolutionSessions, (message) => resolutions.push(message));
  assert.equal(resolutions.at(-1)!.requestId, "invalid-action-request");
  assert.equal(resolutions.at(-1)!.applied, false);
  assert.equal(resolutions.at(-1)!.reason, "invalid_action");
  assert.equal(resolutionCalls, 1, "an unknown action never reaches SessionManager");

  handleResolveSteeringAttemptMessage({
    type: "resolve_steering_attempt",
    requestId: "",
    sessionId: "s_steer",
    submissionId: "invalid-envelope",
    action: "dismiss",
  }, resolutionSessions, (message) => resolutions.push(message));
  assert.equal(resolutions.at(-1)!.reason, "invalid_envelope");
  assert.equal(resolutionCalls, 1);
});

test("stop and delete clear retained steering state and settle in-flight promises", async () => {
  const stopped = harness({ steer: async () => ({ outcome: "uncertain", reason: "retained" }) });
  try {
    await stopped.manager.steerSession({
      submissionId: "stop-uncertain", sessionId: "s_steer", turnId: "turn-a", text: "held until stop",
    });
    stopped.manager.stop("s_steer");
    await new Promise<void>((resolve) => setImmediate(resolve));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = stopped.manager as any;
    assert.equal(internals.steeringRegistry.has("s_steer"), false);
    assert.equal(internals.steeringLanes.has("s_steer"), false);
    assert.equal(internals.steeringLaneRunning.has("s_steer"), false);
    assert.equal(internals.nextQueueOrdinalBySession.has("s_steer"), false);
    assert.equal(stopped.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "stop-uncertain", action: "dismiss",
    }).reason, "attempt_not_found");
  } finally {
    stopped.cleanup();
  }

  const provider = deferred<DriverSteerResult>();
  let calls = 0;
  const deleted = harness({
    steer: async (input) => {
      calls++;
      return input.text === "retained uncertain"
        ? { outcome: "uncertain", reason: "retained until delete" }
        : provider.promise;
    },
  });
  try {
    assert.equal((await deleted.manager.steerSession({
      submissionId: "delete-uncertain", sessionId: "s_steer", turnId: "turn-a", text: "retained uncertain",
    })).disposition, "uncertain");
    const steering = deleted.manager.steerSession({
      submissionId: "delete-pending", sessionId: "s_steer", turnId: "turn-a", text: "must settle",
    });
    await waitFor(() => calls === 2);
    const deletion = deleted.manager.delete("s_steer");
    const result = await steering;
    assert.equal(result.disposition, "rejected");
    assert.equal(result.reason, "policy_blocked");
    await deletion;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = deleted.manager as any;
    assert.equal(internals.steeringRegistry.has("s_steer"), false);
    assert.equal(internals.steeringLanes.has("s_steer"), false);
    assert.equal(internals.steeringLaneRunning.has("s_steer"), false);
    assert.equal(internals.nextQueueOrdinalBySession.has("s_steer"), false);
    assert.equal(deleted.manager.resolveSteeringAttempt({
      sessionId: "s_steer", submissionId: "delete-uncertain", action: "dismiss",
    }).reason, "attempt_not_found");
  } finally {
    provider.resolve({ outcome: "uncertain", reason: "late cleanup" });
    deleted.cleanup();
  }
});

test("steering result details are bounded while short provider messages remain exact", async () => {
  const longReason = "provider-detail-" + "x".repeat(5_000);
  const rejected = harness({ steer: async () => ({ outcome: "rejected", reason: longReason }) });
  try {
    const result = await rejected.manager.steerSession({
      submissionId: "long-rejection", sessionId: "s_steer", turnId: "turn-a", text: "reject",
    });
    assert.equal(result.disposition, "rejected");
    assert.equal(result.message?.length, 4_096);
    assert.equal(result.message, longReason.slice(0, 4_096));
  } finally {
    rejected.cleanup();
  }

  const failed = harness({ steer: async () => { throw new Error(longReason); } });
  try {
    const result = await failed.manager.steerSession({
      submissionId: "long-error", sessionId: "s_steer", turnId: "turn-a", text: "error",
    });
    assert.equal(result.disposition, "uncertain");
    assert.equal(result.message?.length, 4_096);
  } finally {
    failed.cleanup();
  }

  const short = harness({ steer: async () => ({ outcome: "rejected", reason: "short exact reason" }) });
  try {
    const result = await short.manager.steerSession({
      submissionId: "short-rejection", sessionId: "s_steer", turnId: "turn-a", text: "reject",
    });
    assert.equal(result.message, "short exact reason");
  } finally {
    short.cleanup();
  }
});
