import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { SessionEventPayload } from "@wollipog/protocol";
import { PiRpcDriver } from "./pi-rpc.js";
import type { DriverCallbacks, DriverOptions } from "./driver.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));

function options(scenario = "normal", resumeId?: string): DriverOptions {
  return {
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    env: { WOLLIPOG_FAKE_PI_SCENARIO: scenario },
    config: {},
    context: { kind: "native" },
    resumeId,
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: false,
      supportsConversationFork: true,
    },
  };
}

function callbacks(events: SessionEventPayload[], extra: Partial<DriverCallbacks> = {}): DriverCallbacks {
  return {
    onEvent: (event) => events.push(event),
    onStderr: () => {},
    onExit: () => {},
    ...extra,
  };
}

test("Pi RPC normalizes one multi-stage run without duplicate or empty messages", async (t) => {
  const events: SessionEventPayload[] = [];
  let accepted = 0;
  let context: { contextTokensUsed?: number; contextWindow: number } | undefined;
  const driver = new PiRpcDriver(options(), callbacks(events, {
    onPromptAccepted: () => { accepted++; },
    onAcpUsage: (usage) => { context = usage; },
  }));
  t.after(() => driver.dispose());
  await driver.initialize();
  assert.equal(await driver.newSession(process.cwd()), "pi-session-1");
  const stop = await driver.prompt("hello", [{ mimeType: "image/png", data: "aGVsbG8=" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stop, "end_turn");
  assert.equal(accepted, 1);
  assert.equal(driver.agentTurnId(), "pi-entry-1", "the durable Pi leaf becomes the fork checkpoint");
  assert.deepEqual(events.filter((event) => event.kind === "agent_message").map((event) => event.text), ["Hello from Pi"]);
  assert.deepEqual(events.filter((event) => event.kind === "agent_thought").map((event) => event.text), ["Reason\u2028carefully"]);
  assert.equal(events.filter((event) => event.kind === "agent_response_completed").length, 1);
  assert.equal(events.filter((event) => event.kind === "tool_call").length, 1);
  assert.equal(events.filter((event) => event.kind === "tool_call_update" && event.status === "completed").length, 1);
  assert.deepEqual(events.filter((event) => event.kind === "token_usage").map((event) => [event.inputTokens, event.outputTokens, event.costUsd]), [[12, 4, 0.02]]);
  assert.deepEqual(context, { contextTokensUsed: 16, contextWindow: 200000 });
});

test("Pi RPC clones the latest completed leaf into the target worktree without replacing the source", async (t) => {
  const driver = new PiRpcDriver(options(), callbacks([]));
  t.after(() => driver.dispose());
  await driver.initialize();
  await driver.newSession(process.cwd());
  await driver.prompt("hello");
  const forkedSessionId = await driver.forkSession("pi-entry-1", process.cwd());
  assert.match(forkedSessionId, /^[0-9a-f-]{36}$/u);
  assert.equal(driver.agentSessionId(), "pi-session-1", "the source RPC process keeps its session");
  await assert.rejects(
    driver.forkSession("historical-entry", process.cwd()),
    /latest completed conversation checkpoint/,
  );
});

test("Pi RPC rejects a mismatched fork leaf without initialization and removes its target file", async (t) => {
  const sessionRoot = mkdtempSync(join(tmpdir(), "wollipog-pi-fork-"));
  const driver = new PiRpcDriver({
    ...options("fork-leaf-mismatch", "persisted-pi-session"),
    env: {
      WOLLIPOG_FAKE_PI_SCENARIO: "fork-leaf-mismatch",
      WOLLIPOG_FAKE_PI_SESSION_ROOT: sessionRoot,
    },
  }, callbacks([]));
  t.after(() => {
    driver.dispose();
    rmSync(sessionRoot, { recursive: true, force: true });
  });
  await assert.rejects(
    driver.forkSession("expected-leaf", process.cwd()),
    /did not preserve the requested completed checkpoint/,
  );
  assert.equal(existsSync(sessionRoot), true);
  assert.deepEqual(readdirSync(sessionRoot), [], "a failed provider-mode fork leaves no orphaned Pi transcript");
});

test("Pi RPC removes the child transcript when a fork helper ignores the requested session id", async (t) => {
  const sessionRoot = mkdtempSync(join(tmpdir(), "wollipog-pi-fork-id-"));
  const driver = new PiRpcDriver({
    ...options("fork-ignores-session-id", "persisted-pi-session"),
    env: {
      WOLLIPOG_FAKE_PI_SCENARIO: "fork-ignores-session-id",
      WOLLIPOG_FAKE_PI_SESSION_ROOT: sessionRoot,
    },
  }, callbacks([]));
  t.after(() => {
    driver.dispose();
    rmSync(sessionRoot, { recursive: true, force: true });
  });
  await assert.rejects(
    driver.forkSession("pi-entry-1", process.cwd()),
    /did not establish an independent fork session/,
  );
  assert.deepEqual(readdirSync(sessionRoot), [], "the helper's independently minted transcript is removed");
});

test("Pi RPC drains an oversized optional entry response without killing the live session", async (t) => {
  const exits: Array<number | null> = [];
  const driver = new PiRpcDriver(options("oversized-entries"), callbacks([], {
    onExit: (code) => exits.push(code),
  }));
  t.after(() => driver.dispose());
  await driver.initialize();
  await driver.newSession(process.cwd());
  assert.equal(await driver.prompt("large transcript"), "end_turn");
  assert.equal(driver.agentTurnId(), null, "an oversized advisory response omits the fork checkpoint");
  assert.deepEqual(exits, [], "the oversized optional response does not close the Pi transport");
  assert.equal(await driver.prompt("still alive"), "end_turn", "later turns continue on the same process");
  assert.equal(driver.agentSessionId(), "pi-session-1");
});

test("Pi RPC skips entry refresh for capability-disabled older versions", async (t) => {
  const stderr: string[] = [];
  const legacy = options("legacy-hanging-entries");
  legacy.capabilities = { ...legacy.capabilities!, supportsConversationFork: false };
  const driver = new PiRpcDriver(legacy, callbacks([], { onStderr: (text) => stderr.push(text) }));
  t.after(() => driver.dispose());
  await driver.initialize();
  await driver.newSession(process.cwd());
  const startedAt = Date.now();
  assert.equal(await driver.prompt("legacy prompt"), "end_turn");
  assert.ok(Date.now() - startedAt < 1_000, "an unsupported optional command never delays turn settlement");
  assert.equal(driver.agentTurnId(), null);
  assert.deepEqual(stderr, []);
});

test("Pi RPC tool-only stages do not emit empty assistant messages", async (t) => {
  const events: SessionEventPayload[] = [];
  const driver = new PiRpcDriver(options("tool-only"), callbacks(events));
  t.after(() => driver.dispose());
  await driver.initialize();
  await driver.newSession(process.cwd());
  assert.equal(await driver.prompt("use a tool"), "end_turn");
  assert.equal(events.some((event) => event.kind === "agent_message"), false);
  assert.equal(events.some((event) => event.kind === "agent_response_completed"), false);
  assert.equal(events.some((event) => event.kind === "tool_call"), true);
});

test("Pi RPC correlates extension dialogs to durable Wollipog questions", async (t) => {
  const events: SessionEventPayload[] = [];
  let questionReady!: () => void;
  const question = new Promise<void>((resolve) => { questionReady = resolve; });
  const driver = new PiRpcDriver(options("dialog"), callbacks(events, {
    onEvent: (event) => {
      events.push(event);
      if (event.kind === "question_request") questionReady();
    },
  }));
  t.after(() => driver.dispose());
  await driver.initialize();
  await driver.newSession(process.cwd());
  const turn = driver.prompt("ask me");
  await question;
  const request = events.find((event): event is Extract<SessionEventPayload, { kind: "question_request" }> => event.kind === "question_request")!;
  assert.deepEqual(request.questions[0]?.options, [{ label: "Stable" }, { label: "Beta" }]);
  assert.equal(driver.answerQuestion?.(request.requestId, { [request.questions[0]!.id]: "Stable" }, "submit"), true);
  assert.equal(await turn, "end_turn");
  assert.equal(events.some((event) => event.kind === "agent_message" && event.text === "Selected Stable"), true);
});

test("Pi RPC accepts only the exact Agent Control readiness nonce and fails on extension errors", async () => {
  const extension = "/tmp/session.pi-agent-control.mjs";
  const driverOptions = options();
  driverOptions.args.push("--extension", extension);
  const driver = new PiRpcDriver(driverOptions, callbacks([]));
  let resolved = false;
  let rejected: Error | undefined;
  const timer = setTimeout(() => {}, 10_000);
  (driver as any).agentControlBridge = {
    nonce: "expected",
    promise: Promise.resolve(),
    resolve: () => { resolved = true; },
    reject: (error: Error) => { rejected = error; },
    timer,
  };
  (driver as any).onRpcEvent({ type: "extension_ui_request", method: "setStatus",
    statusKey: "wollipog-agent-control", statusText: "wrong" });
  assert.equal(resolved, false);
  (driver as any).onRpcEvent({ type: "extension_ui_request", method: "setStatus",
    statusKey: "wollipog-agent-control", statusText: "expected" });
  assert.equal(resolved, true);

  const secondTimer = setTimeout(() => {}, 10_000);
  (driver as any).agentControlBridge = {
    nonce: "another", promise: Promise.resolve(), resolve: () => {},
    reject: (error: Error) => { rejected = error; }, timer: secondTimer,
  };
  (driver as any).onRpcEvent({ type: "extension_error", extensionPath: "/home/user/broken.mjs",
    error: "secret provider detail" });
  assert.equal(rejected, undefined, "an unrelated user extension cannot fail Agent Control readiness");
  (driver as any).onRpcEvent({ type: "extension_error", extensionPath: extension,
    error: "secret provider detail" });
  assert.match(rejected?.message ?? "", /failed during startup/);
  assert.doesNotMatch(rejected?.message ?? "", /secret provider detail/);
});

test("Pi RPC initialization waits for the exact Agent Control extension readiness event", async (t) => {
  const ready = options();
  ready.env = { ...ready.env, WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE: "expected-ready-nonce" };
  const driver = new PiRpcDriver(ready, callbacks([]));
  t.after(() => driver.dispose());
  await driver.initialize();
  assert.equal(await driver.newSession(process.cwd()), "pi-session-1");
});

test("Pi RPC ignores user extension errors but fails startup for its exact Agent Control extension", async (t) => {
  const extension = "/tmp/session.pi-agent-control.mjs";
  const userError = options("user-extension-error");
  userError.args.push("--extension", extension);
  userError.env = { ...userError.env, WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE: "ready-after-user-error" };
  const accepted = new PiRpcDriver(userError, callbacks([]));
  t.after(() => accepted.dispose());
  await accepted.initialize();

  const bridgeError = options("agent-control-extension-error");
  bridgeError.args.push("--extension", extension);
  bridgeError.env = { ...bridgeError.env, WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE: "never-ready" };
  const rejected = new PiRpcDriver(bridgeError, callbacks([]));
  t.after(() => rejected.dispose());
  await assert.rejects(rejected.initialize(), /Agent Control extension failed during startup/);
});

test("Pi RPC caps pending extension dialogs and cancels excess requests", async (t) => {
  const events: SessionEventPayload[] = [];
  const sent: Record<string, unknown>[] = [];
  const driver = new PiRpcDriver(options(), callbacks(events));
  t.after(() => driver.dispose());
  await driver.initialize();
  (driver as any).peer = {
    send: (message: Record<string, unknown>) => {
      sent.push(message);
      return true;
    },
    dispose: () => {},
  };
  for (let index = 0; index <= 128; index += 1) {
    (driver as any).onExtensionUiRequest({
      type: "extension_ui_request",
      id: `dialog-${index}`,
      method: "select",
      title: "Choose",
      options: ["One"],
    });
  }
  assert.equal(events.filter((event) => event.kind === "question_request").length, 128);
  assert.deepEqual(sent, [{ type: "extension_ui_response", id: "dialog-128", cancelled: true }]);
});

test("Pi RPC receipts steering, cancels, and resumes the exact provider session", async (t) => {
  const events: SessionEventPayload[] = [];
  let acceptedReady!: () => void;
  const accepted = new Promise<void>((resolve) => { acceptedReady = resolve; });
  const driver = new PiRpcDriver(options("steer", "persisted-pi-session"), callbacks(events, {
    onPromptAccepted: acceptedReady,
  }));
  t.after(() => driver.dispose());
  await driver.initialize();
  assert.equal(await driver.newSession(process.cwd()), "persisted-pi-session");
  const turn = driver.prompt("start");
  await accepted;
  const deadlineAt = Date.now() + 2_000;
  const steered = await driver.steer({ submissionId: "steer-1", text: "change direction", deadlineAt });
  assert.equal(steered.outcome, "accepted");
  driver.cancel();
  assert.equal(await turn, "cancelled");
});

test("Pi RPC fails closed when the requested provider session does not exist", async (t) => {
  const driver = new PiRpcDriver(options("normal", "missing-pi-session"), callbacks([]));
  t.after(() => driver.dispose());
  await assert.rejects(driver.initialize());
});

test("Pi RPC reports process loss after a possibly accepted prompt", async (t) => {
  const events: SessionEventPayload[] = [];
  let exits = 0;
  const driver = new PiRpcDriver(options("uncertain"), callbacks(events, { onExit: () => { exits++; } }));
  t.after(() => driver.dispose());
  await driver.initialize();
  await driver.newSession(process.cwd());
  const result = await driver.prompt("possibly delivered").catch(() => "threw" as const);
  assert.ok(result === "refusal" || result === "threw");
  assert.ok(exits >= 1);
  assert.equal(driver.agentTurnId(), null);
});
