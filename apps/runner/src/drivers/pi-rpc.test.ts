import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { SessionEventPayload } from "@wollipog/protocol";
import {
  PI_SECURITY_REQUEST_NONCE_ENV,
  PI_SECURITY_REQUEST_PREFIX,
  PI_SECURITY_REQUEST_TITLE,
} from "../pi-agent-control-extension.js";
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

function securityRequest(nonce: string, id: string, payload: Record<string, unknown>) {
  return {
    type: "extension_ui_request",
    id,
    method: "confirm",
    title: PI_SECURITY_REQUEST_TITLE,
    message: `${PI_SECURITY_REQUEST_PREFIX}${nonce}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`,
  };
}

function trustRequest(nonce: string, id: string, cwd: string) {
  const encoded = Buffer.from(JSON.stringify({ kind: "project_trust", cwd })).toString("base64url");
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title: `${PI_SECURITY_REQUEST_TITLE}\n${PI_SECURITY_REQUEST_PREFIX}${nonce}.${encoded}`,
    options: ["Trust This Project", "Skip Project Resources"],
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

test("Pi RPC separates durable project trust from ordinary extension questions", () => {
  const events: SessionEventPayload[] = [];
  const sent: Record<string, unknown>[] = [];
  const nonce = "project-trust-nonce";
  const driverOptions = options();
  driverOptions.env[PI_SECURITY_REQUEST_NONCE_ENV] = nonce;
  const driver = new PiRpcDriver(driverOptions, callbacks(events));
  (driver as any).peer = {
    send: (message: Record<string, unknown>) => { sent.push(message); return true; },
    dispose: () => {},
  };
  (driver as any).onRpcEvent(trustRequest(nonce, "trust-1", "/workspace/project"));
  const request = events.find((event): event is Extract<SessionEventPayload, { kind: "permission_request" }> =>
    event.kind === "permission_request")!;
  assert.equal(request.title, "Trust Pi Project Resources?");
  assert.equal(request.context?.toolName, "pi.project_trust");
  assert.equal(request.context?.input, "/workspace/project");
  assert.deepEqual(request.options.map((option) => option.optionId), ["trust", "skip"]);
  assert.equal(driver.resolvePermission("trust-1", "trust"), true);
  assert.deepEqual(sent, [{ type: "extension_ui_response", id: "trust-1", value: "Trust This Project" }]);

  (driver as any).onRpcEvent(trustRequest(nonce, "trust-2", "/workspace/project"));
  assert.equal(driver.resolvePermission("trust-2", "skip"), true);
  assert.deepEqual(sent.pop(), {
    type: "extension_ui_response", id: "trust-2", value: "Skip Project Resources",
  });

  (driver as any).onRpcEvent(trustRequest(nonce, "trust-3", "/workspace/project"));
  assert.equal(driver.resolvePermission("trust-3", null), true);
  assert.deepEqual(sent.pop(), { type: "extension_ui_response", id: "trust-3", cancelled: true });

  (driver as any).onRpcEvent({
    type: "extension_ui_request",
    id: "ordinary-1",
    method: "confirm",
    title: PI_SECURITY_REQUEST_TITLE,
    message: "ordinary extension text",
  });
  assert.equal(events.some((event) => event.kind === "question_request" && event.requestId === "ordinary-1"), true);
  driver.dispose();
});

test("Pi RPC enforces live pre-execution permission modes before answering the extension", async () => {
  const events: SessionEventPayload[] = [];
  const sent: Record<string, unknown>[] = [];
  const nonce = "tool-policy-nonce";
  const driverOptions = options();
  driverOptions.env[PI_SECURITY_REQUEST_NONCE_ENV] = nonce;
  driverOptions.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE = "tool-policy-ready";
  driverOptions.config = { permissionMode: "default" };
  const driver = new PiRpcDriver(driverOptions, callbacks(events));
  (driver as any).peer = {
    send: (message: Record<string, unknown>) => { sent.push(message); return true; },
    dispose: () => {},
  };
  (driver as any).onRpcEvent(securityRequest(nonce, "tool-1", {
    kind: "tool_call",
    toolCallId: "provider-tool-1",
    toolName: "bash",
    input: JSON.stringify({ command: "git status" }),
  }));
  const request = events.find((event): event is Extract<SessionEventPayload, { kind: "permission_request" }> =>
    event.kind === "permission_request")!;
  assert.equal(request.title, "bash requires approval.");
  assert.equal(request.ownerToolUseId, "provider-tool-1");
  assert.match(request.context?.input ?? "", /git status/);
  assert.equal(driver.resolvePermission("tool-1", "deny"), true);
  assert.deepEqual(sent.pop(), { type: "extension_ui_response", id: "tool-1", confirmed: false });

  (driver as any).onRpcEvent(securityRequest(nonce, "tool-long", {
    kind: "tool_call", toolCallId: "provider-tool-long", toolName: "bash", input: "x".repeat(20_000),
  }));
  const longRequest = events.find((event): event is Extract<SessionEventPayload, { kind: "permission_request" }> =>
    event.kind === "permission_request" && event.requestId === "tool-long")!;
  assert.equal(longRequest.context?.input?.length, 16_000);
  assert.match(longRequest.context?.input ?? "", /… \[truncated by Wollipog\]$/);
  assert.equal(driver.resolvePermission("tool-long", "deny"), true);

  await driver.setConfig({ permissionMode: "bypassPermissions" });
  (driver as any).onRpcEvent(securityRequest(nonce, "tool-2", {
    kind: "tool_call", toolCallId: "provider-tool-2", toolName: "write", input: "{}",
  }));
  assert.deepEqual(sent.pop(), { type: "extension_ui_response", id: "tool-2", confirmed: true });

  await driver.setConfig({ permissionMode: "dontAsk" });
  (driver as any).onRpcEvent(securityRequest(nonce, "tool-3", {
    kind: "tool_call", toolCallId: "provider-tool-3", toolName: "write", input: "{}",
  }));
  assert.deepEqual(sent.pop(), { type: "extension_ui_response", id: "tool-3", confirmed: false });

  await driver.setConfig({ permissionMode: "" });
  (driver as any).onRpcEvent(securityRequest(nonce, "tool-4", {
    kind: "tool_call", toolCallId: "provider-tool-4", toolName: "write", input: "{}",
  }));
  assert.equal(events.some((event) => event.kind === "permission_request" && event.requestId === "tool-4"), true);
  driver.dispose();
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
  const ready = options("verified-launch");
  ready.env = {
    ...ready.env,
    WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE: "expected-ready-nonce",
    [PI_SECURITY_REQUEST_NONCE_ENV]: "expected-security-nonce",
  };
  const driver = new PiRpcDriver(ready, callbacks([]));
  t.after(() => driver.dispose());
  await driver.initialize();
  assert.equal(await driver.newSession(process.cwd()), "pi-session-1");
});

test("Pi RPC keeps project resources disabled unless both bridge nonces are present", async (t) => {
  const incomplete = options();
  incomplete.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE = "ready-without-security-bridge";
  const driver = new PiRpcDriver(incomplete, callbacks([]));
  t.after(() => driver.dispose());
  await driver.initialize();
  assert.equal(await driver.newSession(process.cwd()), "pi-session-1");
});

test("Pi RPC refuses safe permission modes when the Agent Control bridge is incomplete", async () => {
  for (const permissionMode of ["default", "dontAsk", ""] as const) {
    const incomplete = options();
    incomplete.config = { permissionMode };
    incomplete.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE = "ready-without-security-bridge";
    const driver = new PiRpcDriver(incomplete, callbacks([]));
    await assert.rejects(driver.initialize(), /requires the verified Agent Control bridge/);
    driver.dispose();
  }
  for (const permissionMode of [undefined, "bypassPermissions", "orchestrator"] as const) {
    const permitted = options(permissionMode === "orchestrator" ? "orchestrator-launch" : "normal");
    permitted.config = permissionMode === undefined ? {} : { permissionMode };
    const driver = new PiRpcDriver(permitted, callbacks([]));
    await driver.initialize();
    driver.dispose();
  }

  const legacy = new PiRpcDriver(options(), callbacks([]));
  await legacy.initialize();
  for (const permissionMode of ["default", "dontAsk", ""] as const) {
    await assert.rejects(
      legacy.setConfig({ permissionMode }),
      /requires the verified Agent Control bridge/,
      `a live switch to ${JSON.stringify(permissionMode)} must not claim protections the process lacks`,
    );
  }
  await legacy.setConfig({ permissionMode: "bypassPermissions" });
  legacy.dispose();
});

test("Pi RPC can resolve project trust while provider initialization is waiting", async (t) => {
  const events: SessionEventPayload[] = [];
  const startup = options("startup-trust");
  startup.env = {
    ...startup.env,
    WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE: "startup-ready-nonce",
    [PI_SECURITY_REQUEST_NONCE_ENV]: "startup-security-nonce",
  };
  let driver!: PiRpcDriver;
  driver = new PiRpcDriver(startup, callbacks(events, {
    onEvent: (event) => {
      events.push(event);
      if (event.kind === "permission_request") {
        setImmediate(() => driver.resolvePermission(event.requestId, "trust"));
      }
    },
  }));
  t.after(() => driver.dispose());
  await driver.initialize();
  assert.equal(await driver.newSession(process.cwd()), "pi-session-1");
  assert.equal(events.some((event) => event.kind === "permission_request" &&
    event.context?.toolName === "pi.project_trust"), true);
});

test("Pi RPC startup watchdog pauses only for a pending project-trust decision", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let disposedWith: string | undefined;
  let kills = 0;
  const driverOptions = options();
  driverOptions.env[PI_SECURITY_REQUEST_NONCE_ENV] = "watchdog-nonce";
  const driver = new PiRpcDriver(driverOptions, callbacks([]), undefined, (() => { kills++; }) as any);
  (driver as any).peer = {
    dispose: (reason: string) => { disposedWith = reason; },
    send: () => true,
  };
  (driver as any).child = {};
  try {
    (driver as any).beginStartupStateWatchdog();
    (driver as any).onRpcEvent(trustRequest("watchdog-nonce", "startup-trust", "/workspace/project"));
    t.mock.timers.tick(15_000);
    assert.equal(disposedWith, undefined, "a pending human trust decision is not timed out");
    assert.equal(driver.resolvePermission("startup-trust", "trust"), true);
    t.mock.timers.tick(15_000);
    assert.equal(disposedWith, "Pi RPC get_state response timed out");
    assert.equal(kills, 1);
  } finally {
    (driver as any).clearStartupStateWatchdog();
    t.mock.timers.reset();
  }
});

test("Pi RPC ignores user extension errors but fails startup for its exact Agent Control extension", async (t) => {
  const extension = "/tmp/session.pi-agent-control.mjs";
  const userError = options("user-extension-error");
  userError.args.push("--extension", extension);
  userError.env = {
    ...userError.env,
    WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE: "ready-after-user-error",
    [PI_SECURITY_REQUEST_NONCE_ENV]: "security-after-user-error",
  };
  const accepted = new PiRpcDriver(userError, callbacks([]));
  t.after(() => accepted.dispose());
  await accepted.initialize();

  const bridgeError = options("agent-control-extension-error");
  bridgeError.args.push("--extension", extension);
  bridgeError.env = {
    ...bridgeError.env,
    WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE: "never-ready",
    [PI_SECURITY_REQUEST_NONCE_ENV]: "security-never-ready",
  };
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

test("Pi RPC reports an acknowledged steer as uncertain when the run settled under it (#1433)", async (t) => {
  // The runner re-queues a definite stale_turn as an ordinary prompt. Once Pi has acknowledged
  // the steer it may already hold the text, so that re-queue would deliver the instruction twice.
  const driver = new PiRpcDriver(options(), callbacks([]));
  t.after(() => driver.dispose());
  const turn = new Promise((resolve) => { (driver as any).turnResolve = resolve; });
  (driver as any).promptBusy = true;
  (driver as any).turnId = "pi-turn-live";
  const requests: Record<string, unknown>[] = [];
  (driver as any).peer = {
    request: async (command: Record<string, unknown>) => {
      requests.push(command);
      // The run settles after Pi received the steer but before its acknowledgement is observed.
      (driver as any).settleTurn("end_turn");
      return { type: "response", command: "steer", success: true };
    },
    dispose: () => {},
  };

  const steered = await driver.steer({ submissionId: "steer-1", text: "change direction", deadlineAt: Date.now() + 2_000 });
  assert.equal(steered.outcome, "uncertain");
  assert.deepEqual(requests.map((command) => command.type), ["steer"]);
  assert.equal(await turn, "end_turn");

  // A steer that finds the run already settled never reaches Pi, so it stays a definite refusal.
  const late = await driver.steer({ submissionId: "steer-2", text: "too late", deadlineAt: Date.now() + 2_000 });
  assert.equal(late.outcome, "no_active_turn");
  assert.equal(requests.length, 1);
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

test("an additive Pi Orchestrator keeps the ordinary approval path and never auto-confirms", async () => {
  // The Orchestrator ROLE is carried by SessionLaunchSpec.orchestrator and the agent-environment
  // marker; the literal permissionMode "orchestrator" is the coupled PRESET. Every permission
  // branch in this driver keys on the preset literal, so an additive Orchestrator — which carries
  // an ordinary mode — must be indistinguishable here from a normal session of that mode.
  //
  // This matters: the preset's blanket auto-confirm is safe only because the preset also excludes
  // bash/edit/write. The additive launch keeps those tools, so carrying the auto-confirm across
  // would be a real privilege escalation.
  for (const permissionMode of ["default", "acceptEdits", "on-request"] as const) {
    const events: SessionEventPayload[] = [];
    const sent: Record<string, unknown>[] = [];
    const nonce = `additive-nonce-${permissionMode}`;
    const driverOptions = options();
    driverOptions.env[PI_SECURITY_REQUEST_NONCE_ENV] = nonce;
    driverOptions.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE = `additive-ready-${permissionMode}`;
    // The agent environment marks the role; it must not change any approval decision.
    driverOptions.env.WOLLIPOG_PERMISSION_PRESET = "orchestrator";
    driverOptions.config = { permissionMode };
    const driver = new PiRpcDriver(driverOptions, callbacks(events));
    (driver as any).peer = {
      send: (message: Record<string, unknown>) => { sent.push(message); return true; },
      dispose: () => {},
    };
    (driver as any).onRpcEvent(securityRequest(nonce, `write-${permissionMode}`, {
      kind: "tool_call", toolCallId: "provider-write", toolName: "write",
      input: JSON.stringify({ path: "/repo/src/index.ts" }),
    }));
    // Never silently confirmed: either a human approval is raised, or the mode blocks it.
    assert.equal(
      sent.some((message) => message.confirmed === true), false,
      `an additive Pi Orchestrator in ${permissionMode} must not auto-confirm an implementation tool`,
    );
    if (permissionMode === "default") {
      const request = events.find((event): event is Extract<SessionEventPayload, { kind: "permission_request" }> =>
        event.kind === "permission_request")!;
      assert.equal(request.title, "write requires approval.");
      assert.equal(driver.resolvePermission(`write-${permissionMode}`, "deny"), true);
      assert.deepEqual(sent.pop(), {
        type: "extension_ui_response", id: `write-${permissionMode}`, confirmed: false,
      });
    } else {
      // Unsupported-for-Pi modes fail closed rather than falling back to the preset's confirm.
      assert.deepEqual(sent.pop(), {
        type: "extension_ui_response", id: `write-${permissionMode}`, confirmed: false,
      });
    }
    driver.dispose();
  }

  // The coupled preset does auto-confirm — and is safe only because it also excludes those tools.
  const presetSent: Record<string, unknown>[] = [];
  const presetNonce = "preset-nonce";
  const presetOptions = options("orchestrator-launch");
  presetOptions.env[PI_SECURITY_REQUEST_NONCE_ENV] = presetNonce;
  presetOptions.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE = "preset-ready";
  presetOptions.config = { permissionMode: "orchestrator" };
  const presetDriver = new PiRpcDriver(presetOptions, callbacks([]));
  (presetDriver as any).peer = {
    send: (message: Record<string, unknown>) => { presetSent.push(message); return true; },
    dispose: () => {},
  };
  (presetDriver as any).onRpcEvent(securityRequest(presetNonce, "preset-write", {
    kind: "tool_call", toolCallId: "provider-write", toolName: "write", input: "{}",
  }));
  assert.deepEqual(presetSent.pop(), { type: "extension_ui_response", id: "preset-write", confirmed: true });
  presetDriver.dispose();
});

test("an additive Pi Orchestrator waits for project trust and is not launched with --no-approve", async (t) => {
  // The preset always passes --no-approve and skips the project-trust wait, because it must never
  // load repository-controlled Pi code. The additive launch keeps the user's extensions, skills,
  // and context files, so it must take the ordinary path: wait for trust, and receive --no-approve
  // only when a normal session of the same mode would.
  const spawned: string[][] = [];
  const additive = options("startup-trust");
  additive.env[PI_SECURITY_REQUEST_NONCE_ENV] = "additive-trust-security";
  additive.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE = "additive-trust-ready";
  additive.env.WOLLIPOG_PERMISSION_PRESET = "orchestrator";
  additive.config = { permissionMode: "default" };
  const events: SessionEventPayload[] = [];
  const driver = new PiRpcDriver(additive, callbacks(events));
  t.after(() => driver.dispose());
  const realSpawn = (driver as any).spawn.bind(driver);
  (driver as any).spawn = (opts: { args: string[] }) => { spawned.push([...opts.args]); return realSpawn(opts); };
  const started = driver.initialize();
  // The startup-trust scenario blocks until project trust is resolved, proving the wait happened.
  const trust = await new Promise<Extract<SessionEventPayload, { kind: "permission_request" }>>((resolve) => {
    const poll = setInterval(() => {
      const found = events.find((event): event is Extract<SessionEventPayload, { kind: "permission_request" }> =>
        event.kind === "permission_request" && event.context?.toolName === "pi.project_trust");
      if (found) { clearInterval(poll); resolve(found); }
    }, 5);
    poll.unref?.();
  });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.includes("--no-approve"), false,
    "an additive Pi Orchestrator with a verified bridge takes the ordinary project-trust path");
  driver.resolvePermission(trust.requestId, "trust");
  await started;
});
