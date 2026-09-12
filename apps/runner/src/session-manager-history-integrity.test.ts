import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import {
  SessionManager,
  type DurableCommandLifecycle,
  type SessionCommandInvocationLifecycle,
} from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

function meta(sessionId = "s_integrity"): SessionMeta {
  return {
    sessionId,
    agentId: "claude-native",
    workspaceId: "repo",
    repoPath: "/repo",
    worktreePath: null,
    driver: "claude-code",
    command: "claude",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: "provider-1",
    status: "idle",
    title: "integrity test",
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

function lifecycle(commandId: string) {
  const transitions: string[] = [];
  const durable: DurableCommandLifecycle = {
    commandId,
    queued: () => transitions.push("queued"),
    started: () => transitions.push("started"),
    completed: () => transitions.push("completed"),
    failed: (error) => transitions.push(`failed:${error}`),
    uncertain: (error) => transitions.push(`uncertain:${error}`),
  };
  return { durable, transitions };
}

function sessionCommandLifecycle(invocationId: string) {
  const transitions: string[] = [];
  const lifecycle: SessionCommandInvocationLifecycle = {
    invocationId,
    queued: () => transitions.push("queued"),
    started: () => transitions.push("started"),
    completed: () => transitions.push("completed"),
    failed: (error) => transitions.push(`failed:${error}`),
    uncertain: (error) => transitions.push(`uncertain:${error}`),
  };
  return { lifecycle, transitions };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for asynchronous containment");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function historyHarness(corrupt = true) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-history-integrity-"));
  const writer = new SessionStore(root);
  writer.create(meta());
  writer.create(meta("s_healthy"));
  writer.appendEvent("s_integrity", { kind: "agent_message", text: "one" }, 1);
  writer.flush("s_integrity");
  const eventsPath = join(root, "s_integrity", "events.ndjson");
  if (corrupt) {
    appendFileSync(eventsPath, '{"seq":3,"ts":3,"payload":{"kind":"agent_message","text":"gap"}}\n');
  }

  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  const manager = new SessionManager((message) => sent.push(message), () => {}, store, "test-runner");
  let promptCalls = 0;
  let cancelCalls = 0;
  const client = {
    resolvePermission: () => false,
    cancel: () => { cancelCalls += 1; },
    dispose: () => {},
    prompt: async () => { promptCalls += 1; return "end_turn" as const; },
    setConfig: () => {},
    agentSessionId: () => "provider-1",
  };
  const entry = {
    sessionId: "s_integrity",
    client,
    repoPath: "/repo",
    cwd: "/repo",
    worktree: null,
    context: { kind: "native" as const },
    status: "idle" as const,
    running: false,
    queue: [],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).active.set("s_integrity", entry);
  return {
    root,
    store,
    manager,
    entry,
    client,
    sent,
    eventsPath,
    promptCalls: () => promptCalls,
    cancelCalls: () => cancelCalls,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("initial user-event integrity failure blocks provider submission and fails only that session", async () => {
  const h = historyHarness();
  const current = lifecycle("cmd-current");
  const queued = lifecycle("cmd-queued");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h.entry.queue.push(
    { id: "current", text: "must not reach provider", images: [], durable: current.durable } as any,
    { id: "queued", text: "later", images: [], durable: queued.durable } as any,
  );
  const before = readFileSync(h.eventsPath);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assert.doesNotReject((h.manager as any).drain("s_integrity"));
    assert.equal(h.promptCalls(), 0);
    assert.equal(h.cancelCalls(), 1);
    assert.deepEqual(readFileSync(h.eventsPath), before, "no user/error event is appended after integrity failure");
    assert.equal(h.store.readMeta("s_integrity")?.status, "failed");
    assert.equal(h.store.readMeta("s_healthy")?.status, "idle");
    assert.match(current.transitions.at(-1) ?? "", /^failed:session history integrity failure:/);
    assert.match(queued.transitions.at(-1) ?? "", /^failed:session history integrity failure:/);
    assert.equal(h.entry.queue.length, 0);

    const retry = lifecycle("cmd-retry");
    assert.equal(h.manager.prompt("s_integrity", "retry", [], undefined, undefined, retry.durable), false);
    assert.match(retry.transitions.at(-1) ?? "", /^failed:session history integrity failure:/);
    assert.deepEqual(readFileSync(h.eventsPath), before);
  } finally {
    h.cleanup();
  }
});

test("driver event and stderr integrity failures are contained and exit preserves failed status", () => {
  const h = historyHarness();
  const current = lifecycle("cmd-callback");
  h.entry.currentDurable = current.durable;
  const before = readFileSync(h.eventsPath);
  try {
    assert.doesNotThrow(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.manager as any).onDriverEvent("s_integrity", { kind: "agent_message", text: "callback" });
    });
    assert.equal(h.cancelCalls(), 1);
    assert.equal(h.store.readMeta("s_integrity")?.status, "failed");
    assert.match(current.transitions.at(-1) ?? "", /^failed:session history integrity failure:/);
    assert.doesNotThrow(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.manager as any).onDriverStderr("s_integrity", "late stderr");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.manager as any).onExit("s_integrity", 1, h.client);
    });
    assert.equal(h.store.readMeta("s_integrity")?.status, "failed");
    assert.deepEqual(readFileSync(h.eventsPath), before, "callbacks and exit never append after the latch");
    assert.equal(h.sent.some((message) => message.type === "session_event"), false);
  } finally {
    h.cleanup();
  }
});

test("history integrity failure makes a started provider command uncertain", () => {
  const h = historyHarness();
  const transitions: string[] = [];
  h.entry.currentSessionCommand = {
    invocationId: "provider-command",
    queued: () => transitions.push("queued"),
    started: () => transitions.push("started"),
    completed: () => transitions.push("completed"),
    failed: (error) => transitions.push(`failed:${error}`),
    uncertain: (error) => transitions.push(`uncertain:${error}`),
  };
  h.entry.sessionCommandProviderStarted = true;
  try {
    assert.doesNotThrow(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.manager as any).onDriverEvent("s_integrity", { kind: "agent_message", text: "callback" });
    });
    assert.equal(transitions.filter((value) => value.startsWith("failed:")).length, 0);
    assert.equal(transitions.filter((value) => value.startsWith("uncertain:")).length, 1);
    assert.match(transitions[0] ?? "", /history integrity failure.*uncertain/i);
  } finally {
    h.cleanup();
  }
});

test("config-error history failure cannot reject drain and fails current and queued durable work once", async () => {
  const h = historyHarness();
  const current = lifecycle("cmd-config");
  const queued = lifecycle("cmd-later");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.client as any).setConfig = async () => { throw new Error("config rejected"); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h.entry.queue.push(
    { id: "config", text: "configured", images: [], config: { model: "x" }, durable: current.durable } as any,
    { id: "later", text: "later", images: [], durable: queued.durable } as any,
  );
  const before = readFileSync(h.eventsPath);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assert.doesNotReject((h.manager as any).drain("s_integrity"));
    assert.equal(h.promptCalls(), 0);
    assert.equal(h.cancelCalls(), 1);
    assert.equal(h.store.readMeta("s_integrity")?.status, "failed");
    assert.equal(current.transitions.filter((value) => value.startsWith("failed:")).length, 1);
    assert.equal(queued.transitions.filter((value) => value.startsWith("failed:")).length, 1);
    assert.match(current.transitions.at(-1) ?? "", /^failed:session history integrity failure:/);
    assert.match(queued.transitions.at(-1) ?? "", /^failed:session history integrity failure:/);
    assert.deepEqual(readFileSync(h.eventsPath), before);
  } finally {
    h.cleanup();
  }
});

test("config-error history failure settles the dequeued and queued provider-command lanes once", async () => {
  const h = historyHarness();
  const current = sessionCommandLifecycle("invocation-config-current");
  const queued = sessionCommandLifecycle("invocation-config-queued");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.client as any).setConfig = async () => { throw new Error("config rejected"); };
  // These are deliberately shaped at the queue seam: configuration fails before runSessionCommand
  // can validate authority, and the corrupt log makes recording that failure trip containment.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h.entry.queue.push(
    {
      id: "config-command",
      text: "configured",
      images: [],
      config: { model: "x" },
      sessionCommand: { lifecycle: current.lifecycle },
    } as any,
    {
      id: "later-command",
      text: "later",
      images: [],
      sessionCommand: { lifecycle: queued.lifecycle },
    } as any,
  );
  const before = readFileSync(h.eventsPath);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assert.doesNotReject((h.manager as any).drain("s_integrity"));
    assert.equal(h.promptCalls(), 0);
    assert.equal(h.cancelCalls(), 1);
    assert.equal(h.store.readMeta("s_integrity")?.status, "failed");
    assert.equal(current.transitions.filter((value) => value.startsWith("failed:")).length, 1);
    assert.equal(queued.transitions.filter((value) => value.startsWith("failed:")).length, 1);
    assert.match(current.transitions.at(-1) ?? "", /^failed:session history integrity failure:/);
    assert.match(queued.transitions.at(-1) ?? "", /^failed:session history integrity failure:/);
    assert.equal(h.entry.queue.length, 0);
    assert.deepEqual(readFileSync(h.eventsPath), before);
  } finally {
    h.cleanup();
  }
});

test("first exit append failure is contained before active ownership is removed", () => {
  const h = historyHarness();
  const current = lifecycle("cmd-exit-current");
  const queued = lifecycle("cmd-exit-queued");
  h.entry.currentDurable = current.durable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h.entry.queue.push({ id: "queued", text: "later", images: [], durable: queued.durable } as any);
  const before = readFileSync(h.eventsPath);
  try {
    assert.doesNotThrow(() => {
      // Exercise the actual driver callback boundary, not only the exit implementation.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.manager as any).onDriverExit("s_integrity", 1, h.client);
    });
    assert.equal(h.cancelCalls(), 1);
    assert.equal(h.store.readMeta("s_integrity")?.status, "failed");
    assert.equal(current.transitions.filter((value) => value.startsWith("failed:")).length, 1);
    assert.equal(queued.transitions.filter((value) => value.startsWith("failed:")).length, 1);
    assert.deepEqual(readFileSync(h.eventsPath), before);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((h.manager as any).active.has("s_integrity"), false);
  } finally {
    h.cleanup();
  }
});

test("provider retirement cleanup failure never escapes the driver exit callback", () => {
  const h = historyHarness(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = h.manager as any;
  const retirement = {
    client: h.client,
    entry: h.entry,
    promise: Promise.resolve(),
    preserveAdmission: false,
    preserveLock: true,
    acceptPromptsDuringHandoff: false,
  };
  internals.closing.set("s_integrity", retirement);
  internals.admitted.add("s_integrity");
  internals.drainAdmissionQueue = () => { throw new Error("unrelated queued session is corrupt"); };
  try {
    assert.doesNotThrow(() => internals.onDriverExit("s_integrity", 1, h.client));
    assert.equal(internals.closing.has("s_integrity"), false);
    assert.equal(internals.admitted.has("s_integrity"), false);
  } finally {
    h.cleanup();
  }
});

test("governance secondary-event failure latches once and never escapes the driver callback", () => {
  const h = historyHarness(false);
  const current = lifecycle("cmd-governance-current");
  const queued = lifecycle("cmd-governance-queued");
  h.entry.running = true;
  h.entry.currentDurable = current.durable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h.entry.queue.push({ id: "queued", text: "later", images: [], durable: queued.durable } as any);
  h.store.patchMeta("s_integrity", { config: { maxToolCalls: 1 } });
  const originalAppend = h.store.appendEvent.bind(h.store);
  let appends = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.store as any).appendEvent = (...args: any[]) => {
    appends += 1;
    if (appends === 2) throw new Error("secondary history write failed");
    return originalAppend(...args as Parameters<SessionStore["appendEvent"]>);
  };
  try {
    assert.doesNotThrow(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.manager as any).onDriverEvent("s_integrity", {
        kind: "tool_call",
        toolCallId: "tool-1",
        name: "shell",
        input: {},
      });
    });
    assert.equal(appends, 2);
    assert.equal(h.cancelCalls(), 1, "the latch owns cancellation; governance must not cancel twice");
    assert.equal(h.store.readMeta("s_integrity")?.status, "failed");
    assert.equal(current.transitions.filter((value) => value.startsWith("failed:")).length, 1);
    assert.equal(queued.transitions.filter((value) => value.startsWith("failed:")).length, 1);
    assert.equal(h.store.readEvents("s_integrity").at(-1)?.payload.kind, "tool_call");
  } finally {
    h.cleanup();
  }
});

test("unexpected drain failure terminalizes the dequeued durable before clearing ownership", async () => {
  const h = historyHarness(false);
  const current = lifecycle("cmd-drain-fallback");
  // The correlated user event is appended, but its no-replay flush fails before provider submit.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.store as any).flush = () => { throw new Error("flush failed"); };
  try {
    assert.equal(h.manager.prompt("s_integrity", "never submit", [], undefined, undefined, current.durable), true);
    await waitFor(() => h.store.readMeta("s_integrity")?.status === "failed");
    assert.equal(h.promptCalls(), 0);
    assert.equal(h.cancelCalls(), 1);
    assert.deepEqual(current.transitions.map((value) => value.split(":", 1)[0]), ["queued", "failed"]);
    assert.match(current.transitions.at(-1) ?? "", /^failed:session queue drain failed: flush failed$/);
  } finally {
    h.cleanup();
  }
});

test("generic exit cleanup leaves the in-flight durable solely to runPrompt", async () => {
  const h = historyHarness(false);
  const current = lifecycle("cmd-exit-fallback");
  let resolvePrompt!: (stop: "end_turn") => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h.client as any).prompt = () => new Promise<"end_turn">((resolve) => { resolvePrompt = resolve; });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h.entry.queue.push({ id: "current", text: "in flight", images: [], durable: current.durable } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const draining = (h.manager as any).drain("s_integrity") as Promise<void>;
  try {
    await waitFor(() => current.transitions.includes("started"));
    // Force the generic callback guard rather than the history-specific onExit branch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.manager as any).onExit = () => { throw new Error("exit cleanup failed"); };
    assert.doesNotThrow(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h.manager as any).onDriverExit("s_integrity", 1, h.client);
    });
    assert.deepEqual(current.transitions, ["started"], "exit cleanup must not pre-settle runPrompt ownership");
    resolvePrompt("end_turn");
    await draining;
    assert.equal(current.transitions.filter((value) => value.startsWith("failed:")).length, 0);
    assert.equal(current.transitions.filter((value) => value.startsWith("uncertain:")).length, 1);
    assert.match(current.transitions.at(-1) ?? "", /^uncertain:session stopped while provider execution was in progress$/);
  } finally {
    h.cleanup();
  }
});
