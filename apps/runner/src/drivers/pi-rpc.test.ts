import assert from "node:assert/strict";
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
  assert.deepEqual(events.filter((event) => event.kind === "agent_message").map((event) => event.text), ["Hello from Pi"]);
  assert.deepEqual(events.filter((event) => event.kind === "agent_thought").map((event) => event.text), ["Reason\u2028carefully"]);
  assert.equal(events.filter((event) => event.kind === "agent_response_completed").length, 1);
  assert.equal(events.filter((event) => event.kind === "tool_call").length, 1);
  assert.equal(events.filter((event) => event.kind === "tool_call_update" && event.status === "completed").length, 1);
  assert.deepEqual(events.filter((event) => event.kind === "token_usage").map((event) => [event.inputTokens, event.outputTokens, event.costUsd]), [[12, 4, 0.02]]);
  assert.deepEqual(context, { contextTokensUsed: 16, contextWindow: 200000 });
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
