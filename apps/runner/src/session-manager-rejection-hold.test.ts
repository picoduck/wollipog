import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionQueueMessage } from "@wollipog/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DriverCallbacks } from "./drivers/driver.js";
import { SessionManager, type DurableCommandLifecycle } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

// #3100: a provider that provably rejects every submission for the same reason must not keep
// receiving automatic turns. Two identical rejections hold automatic turns behind a visible blocker
// until a person sends a message or restarts the session, and the held turns are never lost.

const PROVIDER_ERROR = "turn/start failed: Invalid request: invalid type: null, expected a string";

/** How the fake provider settles the next submission. `uncertain` models a transport failure after
 * the request was written: the provider error is known, but delivery is not proven either way. */
type Outcome = "accept" | "reject" | "uncertain";

async function waitFor(predicate: () => boolean, message: string, attempts = 800): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

/** Let any drain the last action scheduled run to completion. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

function haveGit(): boolean {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function fakeProvider(options: { reportsDelivery?: boolean } = {}) {
  const reportsDelivery = options.reportsDelivery ?? true;
  const prompts: Array<{ provider: number; text: string }> = [];
  const callbacks: DriverCallbacks[] = [];
  let providers = 0;
  let next: Outcome = "reject";
  const factory = (_driver: unknown, _launch: unknown, cb: DriverCallbacks) => {
    const provider = providers++;
    callbacks.push(cb);
    let turnError: string | null = null;
    let undelivered = false;
    return {
      pid: provider + 1,
      initialize: async () => {},
      newSession: async () => `thread-${provider}`,
      close: async () => {},
      prompt: async (text: string) => {
        prompts.push({ provider, text });
        turnError = next === "accept" ? null : PROVIDER_ERROR;
        undelivered = next === "reject";
        if (next !== "accept") return "refusal" as const;
        cb.onPromptAccepted?.();
        cb.onEvent({ kind: "agent_message", text: `answer to: ${text}`, final: true });
        return "end_turn" as const;
      },
      lastTurnError: () => turnError,
      ...(reportsDelivery ? { lastPromptUndelivered: () => undelivered } : {}),
      cancel: () => {},
      dispose: () => {},
      setConfig: () => {},
      resolvePermission: () => false,
      agentSessionId: () => `thread-${provider}`,
    };
  };
  return {
    factory,
    prompts,
    callbacks,
    texts: () => prompts.map((prompt) => prompt.text),
    setOutcome: (outcome: Outcome) => { next = outcome; },
  };
}

function recordingLifecycle(commandId: string, log: string[]): DurableCommandLifecycle {
  return {
    commandId,
    queued: () => { log.push(`${commandId}:queued`); },
    started: () => { log.push(`${commandId}:started`); },
    completed: () => { log.push(`${commandId}:completed`); },
    failed: (error) => { log.push(`${commandId}:failed:${error}`); },
    uncertain: (error) => { log.push(`${commandId}:uncertain:${error}`); },
  };
}

function setup(name: string, provider: ReturnType<typeof fakeProvider>, driver: "claude-code" | "codex-app-server" = "claude-code") {
  const root = mkdtempSync(join(tmpdir(), `wollipog-rejection-hold-${name}-`));
  const repo = join(root, "repo");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "base"]);
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const sent: RunnerToControlPlane[] = [];
  const manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
    provider.factory as never, dataDir, 1);
  const spec: SessionLaunchSpec = {
    sessionId: `s_${name}`, workspaceId: "repo", workspacePath: repo, agentId: driver === "claude-code" ? "claude" : "codex",
    command: driver === "claude-code" ? "claude" : "codex", args: [], env: {}, useWorktree: false, driver,
    context: { kind: "native" },
  };
  const log: string[] = [];
  /** A control-plane campaign continuation: an automatic turn with its own durable receipt. */
  const continuation = (commandId: string) => manager.prompt(spec.sessionId, `continue ${commandId}`, [], undefined,
    undefined, recordingLifecycle(commandId, log), false, undefined, false, undefined, undefined, undefined, true);
  /** A person's message, sent through the same durable lane. */
  const message = (commandId: string) => manager.prompt(spec.sessionId, `message ${commandId}`, [], undefined,
    undefined, recordingLifecycle(commandId, log));
  const settled = (commandId: string) => log.some((step) =>
    step.startsWith(`${commandId}:completed`) || step.startsWith(`${commandId}:failed`) ||
    step.startsWith(`${commandId}:uncertain`));
  const statuses = () => sent.filter((sentMessage): sentMessage is Extract<RunnerToControlPlane, { type: "session_status" }> =>
    sentMessage.type === "session_status" && sentMessage.sessionId === spec.sessionId);
  const latestQueue = () => sent.filter((sentMessage): sentMessage is SessionQueueMessage =>
    sentMessage.type === "session_queue" && sentMessage.sessionId === spec.sessionId).at(-1);
  const userEventFor = (commandId: string) => store.readEvents(spec.sessionId).some((event) =>
    event.payload.kind === "user_message" && event.payload.commandId === commandId);
  const cleanup = () => {
    manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  };
  return { manager, store, sent, spec, log, continuation, message, settled, statuses, latestQueue, userEventFor, cleanup };
}

/** Two automatic turns the provider provably rejects with the same error engage the hold. */
async function engageHold(h: ReturnType<typeof setup>): Promise<void> {
  h.continuation("first");
  await waitFor(() => h.settled("first"), "the first continuation did not settle");
  assert.equal(h.statuses().at(-1)?.status, "idle", "one rejection is not yet a pattern");
  h.continuation("second");
  await waitFor(() => h.settled("second"), "the second continuation did not settle");
}

test("two identical provable rejections hold the next automatic turn behind a blocker naming the provider error (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("hold", provider);
  try {
    await h.manager.start(h.spec);
    await engageHold(h);
    assert.deepEqual(h.log, [
      "first:queued", "first:started", `first:failed:provider refusal: ${PROVIDER_ERROR}`,
      "second:queued", "second:started", `second:failed:provider refusal: ${PROVIDER_ERROR}`,
    ]);
    const blocker = h.statuses().at(-1)!;
    assert.equal(blocker.status, "input_required");
    assert.equal(blocker.detail,
      `Claude Code rejected two turns in a row with the same error: ${PROVIDER_ERROR}. ` +
      "Automatic turns are held until you send a message or restart the session.");
    assert.equal(h.store.readEvents(h.spec.sessionId).some((event) =>
      event.payload.kind === "error" && event.payload.message === blocker.detail), true,
    "the blocker is recorded on the session timeline");

    h.continuation("third");
    await settle();
    assert.deepEqual(provider.texts(), ["continue first", "continue second"], "the third continuation is not dispatched");
    assert.equal(h.log.at(-1), "third:queued");
    assert.equal(h.latestQueue()?.held, true);
    assert.deepEqual(h.latestQueue()?.queue.map((item) => item.text), ["continue third"]);
    const restored = h.statuses().at(-1)!;
    assert.equal(restored.status, "input_required", "admitting a held turn keeps the blocker");
    assert.equal(restored.detail, blocker.detail);
  } finally {
    h.cleanup();
  }
});

test("a person's message clears the hold and runs ahead of the held automatic turns, which then run in order (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("human", provider);
  try {
    await h.manager.start(h.spec);
    await engageHold(h);
    h.continuation("third");
    h.continuation("fourth");
    await settle();
    assert.equal(provider.prompts.length, 2);

    provider.setOutcome("accept");
    h.message("person");
    await waitFor(() => h.settled("fourth"), "the held continuations did not run after the hold cleared");
    assert.deepEqual(provider.texts(), [
      "continue first", "continue second", "message person", "continue third", "continue fourth",
    ]);
    for (const commandId of ["person", "third", "fourth"]) {
      assert.deepEqual(h.log.filter((step) => step.startsWith(`${commandId}:`)),
        [`${commandId}:queued`, `${commandId}:started`, `${commandId}:completed`]);
    }
    assert.equal(h.latestQueue()?.held, undefined);
    assert.equal(h.statuses().at(-1)?.status, "idle");
  } finally {
    h.cleanup();
  }
});

test("a person's message the provider rejects the same way lets one held turn through before the hold returns (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("human_rejected", provider);
  try {
    await h.manager.start(h.spec);
    await engageHold(h);
    h.continuation("third");
    h.continuation("fourth");
    await settle();

    // The message clears the hold, but the provider still rejects; the next automatic turn repeats
    // that rejection and holds what remains, so the message never waits behind held turns.
    h.message("person");
    await waitFor(() => h.settled("third"), "the first held continuation did not run");
    await settle();
    assert.deepEqual(provider.texts(), [
      "continue first", "continue second", "message person", "continue third",
    ]);
    assert.deepEqual(h.log.filter((step) => step.startsWith("fourth:")), ["fourth:queued"]);
    assert.equal(h.latestQueue()?.held, true);
    assert.equal(h.statuses().at(-1)?.status, "input_required");
  } finally {
    h.cleanup();
  }
});

test("a successful turn resets the identical-rejection tracking (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("reset", provider);
  try {
    await h.manager.start(h.spec);
    h.continuation("first");
    await waitFor(() => h.settled("first"), "the first continuation did not settle");
    provider.setOutcome("accept");
    h.message("person");
    await waitFor(() => h.settled("person"), "the message did not settle");
    provider.setOutcome("reject");
    h.continuation("second");
    await waitFor(() => h.settled("second"), "the second continuation did not settle");
    assert.equal(h.statuses().at(-1)?.status, "idle", "the rejection before the success is forgotten");
    h.continuation("third");
    await waitFor(() => h.settled("third"), "the third continuation was held after a success intervened");
    assert.equal(provider.prompts.length, 4);

    // The streak that began after the success is counted from its own first rejection.
    assert.equal(h.statuses().at(-1)?.status, "input_required");
    h.continuation("fourth");
    await settle();
    assert.equal(provider.prompts.length, 4);
    assert.equal(h.log.at(-1), "fourth:queued");
  } finally {
    h.cleanup();
  }
});

test("an uncertain failure is never counted as an identical rejection (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("uncertain", provider);
  try {
    await h.manager.start(h.spec);
    // A transport failure after the request was written separates two provable rejections.
    h.continuation("first");
    await waitFor(() => h.settled("first"), "the first continuation did not settle");
    provider.setOutcome("uncertain");
    h.continuation("second");
    await waitFor(() => h.settled("second"), "the second continuation did not settle");
    provider.setOutcome("reject");
    h.continuation("third");
    await waitFor(() => h.settled("third"), "the third continuation did not settle");
    provider.setOutcome("uncertain");
    h.continuation("fourth");
    await waitFor(() => h.settled("fourth"), "an uncertain failure was counted toward the hold");
    provider.setOutcome("reject");
    h.continuation("fifth");
    await waitFor(() => h.settled("fifth"), "an uncertain failure was counted toward the hold");
    assert.equal(provider.prompts.length, 5);
    assert.equal(h.latestQueue()?.held, undefined);
    assert.equal(h.statuses().some((status) => status.status === "input_required"), false);
  } finally {
    h.cleanup();
  }
});

test("a refusal from a driver that cannot prove non-delivery never holds automatic turns (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider({ reportsDelivery: false });
  const h = setup("no_delivery_signal", provider);
  try {
    await h.manager.start(h.spec);
    for (const commandId of ["first", "second", "third"]) {
      h.continuation(commandId);
      await waitFor(() => h.settled(commandId), `${commandId} was not dispatched`);
    }
    assert.equal(provider.prompts.length, 3);
    assert.equal(h.statuses().some((status) => status.status === "input_required"), false);
  } finally {
    h.cleanup();
  }
});

test("a restart clears the hold and settles the held automatic turns as never sent (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("restart", provider);
  try {
    await h.manager.start(h.spec);
    await engageHold(h);
    h.continuation("third");
    h.continuation("fourth");
    await settle();

    provider.setOutcome("accept");
    assert.equal(await h.manager.start(h.spec), true);
    const neverSent = "session restart cleared the provider rejection hold before this automatic turn was sent";
    for (const commandId of ["third", "fourth"]) {
      assert.deepEqual(h.log.filter((step) => step.startsWith(`${commandId}:`)),
        [`${commandId}:queued`, `${commandId}:failed:${neverSent}`]);
      assert.equal(h.userEventFor(commandId), false, `${commandId} has no correlated user event`);
    }
    assert.deepEqual(h.latestQueue()?.queue, []);

    // The replacement conversation takes automatic turns again.
    h.continuation("fifth");
    await waitFor(() => h.settled("fifth"), "an automatic turn after the restart was held");
    assert.deepEqual(provider.prompts.at(-1), { provider: 1, text: "continue fifth" });
    assert.equal(h.log.at(-1), "fifth:completed");
  } finally {
    h.cleanup();
  }
});

test("a stop settles the held automatic turns as never sent (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("stop", provider);
  try {
    await h.manager.start(h.spec);
    await engageHold(h);
    h.continuation("third");
    await settle();

    h.manager.stop(h.spec.sessionId);
    assert.deepEqual(h.log.filter((step) => step.startsWith("third:")),
      ["third:queued", "third:failed:session stopped before queued command started"]);
    assert.equal(h.userEventFor("third"), false);
    assert.equal(provider.prompts.length, 2);
    assert.deepEqual(h.latestQueue()?.queue, []);
  } finally {
    h.cleanup();
  }
});

test("a provider exit and its automatic recovery keep the hold (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("provider_exit", provider, "codex-app-server");
  try {
    await h.manager.start(h.spec);
    await engageHold(h);
    h.continuation("third");
    await settle();

    // The app-server exits; its unsent queue is recovered into a fresh process automatically.
    provider.callbacks[0]!.onExit(1);
    await waitFor(() => provider.callbacks.length === 2, "the provider was not relaunched for the recovered queue");
    await settle();
    assert.deepEqual(provider.texts(), ["continue first", "continue second"], "recovery does not release the hold");
    assert.deepEqual(h.log.filter((step) => step.startsWith("third:")), ["third:queued"]);
    const blocker = h.statuses().at(-1)!;
    assert.equal(blocker.status, "input_required");
    assert.match(blocker.detail ?? "", /^Codex rejected two turns in a row with the same error: turn\/start failed/u);

    provider.setOutcome("accept");
    h.message("person");
    await waitFor(() => h.settled("third"), "the held continuation did not run after a person's message");
    assert.deepEqual(provider.prompts.slice(2), [
      { provider: 1, text: "message person" }, { provider: 1, text: "continue third" },
    ]);
  } finally {
    h.cleanup();
  }
});

test("a threshold edit while held keeps the blocker instead of reporting the session idle (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("threshold", provider);
  try {
    await h.manager.start(h.spec);
    await engageHold(h);
    const blocker = h.statuses().at(-1)!;
    h.manager.rearmGovernance(h.spec.sessionId, { costBudgetUsd: 5 });
    const after = h.statuses().at(-1)!;
    assert.equal(after.status, "input_required");
    assert.equal(after.detail, blocker.detail);
  } finally {
    h.cleanup();
  }
});

test("a provider command between two rejections means they were not consecutive (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("command", provider);
  try {
    await h.manager.start(h.spec);
    h.continuation("first");
    await waitFor(() => h.settled("first"), "the first continuation did not settle");
    // Run a provider command turn through the prompt path; its own execution is not under test.
    const internals = h.manager as unknown as {
      runSessionCommand: () => Promise<void>;
      runPrompt: (sessionId: string, prompt: unknown) => Promise<void>;
    };
    internals.runSessionCommand = async () => {};
    await internals.runPrompt(h.spec.sessionId, { id: "command", text: "", images: [], sessionCommand: {} });
    h.continuation("second");
    await waitFor(() => h.settled("second"), "the second continuation did not settle");
    h.continuation("third");
    await waitFor(() => h.settled("third"), "the command did not end the rejection streak");
    assert.equal(provider.prompts.length, 3);
  } finally {
    h.cleanup();
  }
});

test("a provider exit between two rejections does not hide that they repeat (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("exit_between", provider, "codex-app-server");
  try {
    await h.manager.start(h.spec);
    h.continuation("first");
    await waitFor(() => h.settled("first"), "the first continuation did not settle");
    provider.callbacks[0]!.onExit(1);
    await settle();

    // The next continuation resumes the conversation in a fresh provider process.
    h.continuation("second");
    await waitFor(() => h.settled("second"), "the second continuation did not settle");
    assert.equal(provider.prompts.at(-1)?.provider, 1);
    assert.equal(h.statuses().at(-1)?.status, "input_required");
    h.continuation("third");
    await settle();
    assert.equal(provider.prompts.length, 2, "the third continuation is held");
    assert.deepEqual(h.log.filter((step) => step.startsWith("third:")), ["third:queued"]);
  } finally {
    h.cleanup();
  }
});

test("an idle provider under a rejection hold can still be parked for capacity (#3100)", { skip: !haveGit() }, async () => {
  const provider = fakeProvider();
  const h = setup("park", provider, "codex-app-server");
  try {
    await h.manager.start(h.spec);
    await engageHold(h);
    const internals = h.manager as unknown as {
      active: Map<string, unknown>;
      idleProviderCanPark: (sessionId: string, entry: unknown) => boolean;
    };
    const canPark = () => internals.idleProviderCanPark(h.spec.sessionId, internals.active.get(h.spec.sessionId));
    assert.equal(h.statuses().at(-1)?.status, "input_required");
    assert.equal(canPark(), true, "no provider work is running, so the process is reclaimable");
    h.continuation("third");
    await settle();
    assert.equal(canPark(), false, "a held turn in the FIFO keeps the process, as any queued work does");
  } finally {
    h.cleanup();
  }
});
