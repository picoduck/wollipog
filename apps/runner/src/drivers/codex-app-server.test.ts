import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { SessionConfig, SessionEventPayload } from "@wollipog/protocol";
import {
  approvalContext,
  approvalResponse,
  buildCodexTurnParams,
  CodexAppServerDriver,
  CodexAppServerResumeError,
  parseReviewDecision,
  reviewSummary,
} from "./codex-app-server.js";
import type { DriverCallbacks, DriverOptions } from "./driver.js";
import type { StagedPromptImages } from "./prompt-images.js";
import type { AgentProcess } from "../spawn.js";

function fakeAgentProcess(): AgentProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
  }) as unknown as AgentProcess;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Unit tests for the app-server item -> SessionEventPayload mapping and the
 * approval decision wiring. No process spawn: we drive the private onItem mapper
 * and the resolvePermission/pendingApprovals path directly.
 */
function makeHarness(
  extra: Partial<DriverOptions> = {},
  imageStager?: (images: any[], context: any) => Promise<StagedPromptImages>,
) {
  const events: SessionEventPayload[] = [];
  let authenticationFailures = 0;
  const subscriptionUsage: unknown[] = [];
  const cb: DriverCallbacks = {
    onEvent: (p) => events.push(p),
    onStderr: () => {},
    onExit: () => {},
    onAuthenticationFailure: () => { authenticationFailures += 1; },
    onSubscriptionUsage: (update) => subscriptionUsage.push(update),
  };
  const opts: DriverOptions = {
    command: "codex",
    args: [],
    cwd: "/tmp/work",
    env: {},
    config: {} as DriverOptions["config"],
    context: {} as DriverOptions["context"],
    ...extra,
  };
  const driver = imageStager
    ? new CodexAppServerDriver(opts, cb, imageStager)
    : new CodexAppServerDriver(opts, cb);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onItem = (item: unknown, completed: boolean) => (driver as any).onItem(item, completed);
  return { driver, events, subscriptionUsage, onItem, authenticationFailures: () => authenticationFailures };
}

test("app-server auth errors emit a secret-free auth signal", () => {
  const h = makeHarness();
  const raw = "unexpected status 401 Unauthorized: bearer token secret-value";
  (h.driver as any).emitDriverError(raw);
  assert.equal(h.authenticationFailures(), 1);
  assert.deepEqual(h.events, []);
});

test("Codex app-server accepts a final JSON-RPC response delivered after exit", async () => {
  const child = fakeAgentProcess();
  const writes: string[] = [];
  const exits: Array<number | null> = [];
  child.stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
  const driver = new CodexAppServerDriver({
    command: "codex",
    args: [],
    cwd: "/tmp/work",
    env: {},
    config: {},
    context: { kind: "native" },
  }, {
    onEvent: () => {},
    onStderr: () => {},
    onExit: (code) => exits.push(code),
  }, undefined, {
    spawn: () => child,
    kill: () => {},
  });

  const initialized = driver.initialize();
  const request = JSON.parse(writes.join("").trim()) as { id: number };
  let settled = false;
  void initialized.then(() => { settled = true; }, () => { settled = true; });
  child.emit("exit", 0, null);
  await nextTask();
  assert.equal(settled, false, "exit must not dispose a response still buffered in stdout");
  assert.deepEqual(exits, []);
  child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\n");
  child.emit("close", 0, null);

  await initialized;
  assert.deepEqual(exits, [0]);
  driver.dispose();
});

function activateSteer(
  driver: CodexAppServerDriver,
  request: (method: string, params: any, deadlineAt?: number) => Promise<any>,
): void {
  (driver as any).threadId = "thread-steer";
  (driver as any).turnId = "provider-turn-steer";
  (driver as any).promptBusy = true;
  (driver as any).peer = { request, requestWithDeadline: request, notify: () => {} };
}

const futureDeadline = (): number => Date.now() + 10_000;

test("steer sends the exact fenced request, accepts the matching turn, and retains images until settlement", async () => {
  let cleaned = 0;
  const calls: Array<{ method: string; params: any; deadlineAt?: number }> = [];
  const h = makeHarness({}, async () => ({
    paths: ["/tmp/private/steer.png"],
    inputs: [{ type: "localImage", path: "/tmp/private/steer.png" }],
    cleanup: async () => { cleaned++; },
  }));
  activateSteer(h.driver, async (method, params, deadlineAt) => {
    calls.push({ method, params, deadlineAt });
    return { turnId: "provider-turn-steer" };
  });

  const deadlineAt = futureDeadline();
  assert.deepEqual(await h.driver.steer!({
    submissionId: "submission-steer-1",
    text: "change direction",
    images: [{ mimeType: "image/png", data: "cHg=" }],
    deadlineAt,
  }), { outcome: "accepted", providerTurnId: "provider-turn-steer" });
  assert.deepEqual(calls, [{
    method: "turn/steer",
    params: {
      threadId: "thread-steer",
      input: [
        { type: "text", text: "change direction" },
        { type: "localImage", path: "/tmp/private/steer.png" },
      ],
      expectedTurnId: "provider-turn-steer",
      clientUserMessageId: "submission-steer-1",
    },
    deadlineAt,
  }]);
  assert.equal(cleaned, 0);
  await (h.driver as any).cleanupStagedImages();
  assert.equal(cleaned, 1);
});

test("image-only steer omits an empty text item and never starts a second turn", async () => {
  const methods: string[] = [];
  let params: any;
  const h = makeHarness({}, async () => ({
    paths: ["/tmp/private/steer.png"],
    inputs: [{ type: "localImage", path: "/tmp/private/steer.png" }],
    cleanup: async () => {},
  }));
  activateSteer(h.driver, async (method, value) => {
    methods.push(method);
    params = value;
    return { turnId: "provider-turn-steer" };
  });
  assert.equal((await h.driver.steer!({
    submissionId: "submission-image-only",
    text: "",
    images: [{ mimeType: "image/png", data: "cHg=" }],
    deadlineAt: futureDeadline(),
  })).outcome, "accepted");
  assert.deepEqual(methods, ["turn/steer"]);
  assert.deepEqual(params.input, [{ type: "localImage", path: "/tmp/private/steer.png" }]);
});

test("steer rejects before staging when there is no active provider turn", async () => {
  let staged = 0;
  const h = makeHarness({}, async () => {
    staged++;
    return { paths: [], inputs: [], cleanup: async () => {} };
  });
  assert.deepEqual(await h.driver.steer!({ submissionId: "inactive", text: "hello", deadlineAt: futureDeadline() }), {
    outcome: "no_active_turn",
    reason: "Codex has no active provider turn to steer",
  });
  assert.equal(staged, 0);
});

test("turn completion during steer image staging closes admission, cleans, and never writes", async () => {
  let finishStage!: (staged: StagedPromptImages) => void;
  const staging = new Promise<StagedPromptImages>((resolve) => { finishStage = resolve; });
  let cleaned = 0;
  let requests = 0;
  const h = makeHarness({}, async () => staging);
  activateSteer(h.driver, async () => {
    requests++;
    return { turnId: "provider-turn-steer" };
  });
  (h.driver as any).turnResolve = () => {};

  const steering = h.driver.steer!({
    submissionId: "submission-completed-during-stage",
    text: "hello",
    images: [{ mimeType: "image/png", data: "cHg=" }],
    deadlineAt: futureDeadline(),
  });
  (h.driver as any).settleTurn("end_turn");
  finishStage({
    paths: ["/tmp/completed-during-stage.png"],
    inputs: [{ type: "localImage", path: "/tmp/completed-during-stage.png" }],
    cleanup: async () => { cleaned++; },
  });

  assert.deepEqual(await steering, {
    outcome: "no_active_turn",
    reason: "Codex provider turn closed before steering submission",
  });
  assert.equal(requests, 0);
  assert.equal(cleaned, 1);
  assert.equal((h.driver as any).stagedSteerImages.size, 0);
  assert.equal((h.driver as any).steerClientIds.size, 0);
});

test("turn replacement during steer image staging returns a typed stale-turn outcome", async () => {
  let finishStage!: (staged: StagedPromptImages) => void;
  const staged = new Promise<StagedPromptImages>((resolve) => { finishStage = resolve; });
  let requests = 0;
  const h = makeHarness({}, async () => staged);
  activateSteer(h.driver, async () => { requests++; return { turnId: "provider-turn-steer" }; });
  const steering = h.driver.steer!({
    submissionId: "changed-during-stage",
    text: "hello",
    images: [{ mimeType: "image/png", data: "YQ==" }],
    deadlineAt: futureDeadline(),
  });
  (h.driver as any).turnId = "replacement-turn";
  let cleaned = 0;
  finishStage({ paths: ["/tmp/stale.png"], inputs: [], cleanup: async () => { cleaned++; } });
  assert.deepEqual(await steering, {
    outcome: "stale_turn",
    reason: "Codex active turn changed before steering submission",
  });
  assert.equal(requests, 0);
  assert.equal(cleaned, 1);
});

test("steer uses the original submission deadline and cleans if it expires during staging", async () => {
  let cleaned = 0;
  let requests = 0;
  const h = makeHarness({}, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { paths: ["/tmp/expired.png"], inputs: [], cleanup: async () => { cleaned++; } };
  });
  activateSteer(h.driver, async () => {
    requests++;
    return { turnId: "provider-turn-steer" };
  });
  const result = await h.driver.steer!({
    submissionId: "submission-expired",
    text: "hello",
    deadlineAt: Date.now() + 1,
  });
  assert.equal(result.outcome, "rejected");
  assert.equal(requests, 0);
  assert.equal(cleaned, 1);
});

test("definite steer rejection cleans immediately while transport loss and mismatched acknowledgement remain uncertain", async () => {
  for (const scenario of ["provider", "transport", "mismatch"] as const) {
    let cleaned = 0;
    const h = makeHarness({}, async () => ({
      paths: ["/tmp/steer.png"], inputs: [], cleanup: async () => { cleaned++; },
    }));
    activateSteer(h.driver, async () => {
      if (scenario === "provider") throw { code: -32001, message: "server busy" };
      if (scenario === "transport") throw { code: -32000, message: "connection closed", transportFailure: true };
      return { turnId: "unexpected-turn" };
    });
    const result = await h.driver.steer!({
      submissionId: `submission-${scenario}`,
      text: "hello",
      deadlineAt: futureDeadline(),
    });
    assert.equal(result.outcome, scenario === "provider" ? "rejected" : "uncertain");
    assert.equal(cleaned, scenario === "provider" ? 1 : 0);
    await (h.driver as any).cleanupStagedImages();
    assert.equal(cleaned, 1);
  }
});

test("steer deadline resolves uncertain and keeps images held", async () => {
  let cleaned = 0;
  const h = makeHarness({}, async () => ({
    paths: ["/tmp/steer.png"], inputs: [], cleanup: async () => { cleaned++; },
  }));
  activateSteer(h.driver, async () => {
    throw { code: -32002, message: "request deadline exceeded", requestTimeout: true };
  });
  const result = await h.driver.steer!({
    submissionId: "submission-timeout",
    text: "hello",
    deadlineAt: futureDeadline(),
  });
  assert.equal(result.outcome, "uncertain");
  assert.equal(cleaned, 0);
  await (h.driver as any).cleanupStagedImages();
  assert.equal(cleaned, 1);
});

test("steer suppresses Codex userMessage echoes by client id", () => {
  const h = makeHarness();
  (h.driver as any).steerClientIds.add("submission-echo");
  h.onItem({ type: "userMessage", id: "user-1", clientId: "submission-echo", text: "hello" }, false);
  h.onItem({ type: "userMessage", id: "user-1", clientId: "submission-echo", text: "hello" }, true);
  assert.deepEqual(h.events, []);
  assert.equal((h.driver as any).steerClientIds.has("submission-echo"), false);
});

test("multiple accepted steers keep independent image cleanup handles", async () => {
  const cleaned: string[] = [];
  let stage = 0;
  const h = makeHarness({}, async () => {
    const id = String(++stage);
    return { paths: [`/tmp/${id}.png`], inputs: [], cleanup: async () => { cleaned.push(id); } };
  });
  activateSteer(h.driver, async () => ({ turnId: "provider-turn-steer" }));
  assert.equal((await h.driver.steer!({ submissionId: "one", text: "one", deadlineAt: futureDeadline() })).outcome, "accepted");
  assert.equal((await h.driver.steer!({ submissionId: "two", text: "two", deadlineAt: futureDeadline() })).outcome, "accepted");
  assert.deepEqual(cleaned, []);
  await (h.driver as any).cleanupStagedImages();
  assert.deepEqual(cleaned, ["1", "2"]);
});

function notificationHandlers(driver: CodexAppServerDriver): Map<string, (params: any) => void> {
  const notifications = new Map<string, (params: any) => void>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (driver as any).registerHandlers({
    onRequest: () => {},
    onNotification: (method: string, handler: (params: any) => void) => notifications.set(method, handler),
  });
  return notifications;
}

test("account/rateLimits/updated forwards sparse usage without creating transcript events", () => {
  const h = makeHarness();
  const notifications = notificationHandlers(h.driver);
  const payload = { rateLimitsByLimitId: { codex: { primary: { usedPercent: 42 } } } };
  notifications.get("account/rateLimits/updated")!(payload);
  assert.deepEqual(h.subscriptionUsage, [{ provider: "codex", kind: "sparse", payload }]);
  assert.deepEqual(h.events, []);
});

test("prompt stages localImage inputs in text/image order and cleans them after settlement", async () => {
  let cleaned = 0;
  let turnParams: any = null;
  const h = makeHarness({}, async () => ({
    paths: ["/tmp/private/image-1.png"],
    inputs: [{ type: "localImage", path: "/tmp/private/image-1.png" }],
    cleanup: async () => { cleaned++; },
  }));
  (h.driver as any).threadId = "thread-images";
  (h.driver as any).peer = {
    request: async (method: string, params: any) => {
      if (method === "turn/start") turnParams = params;
      return { turn: { id: "turn-images" } };
    },
  };
  const turn = h.driver.prompt("inspect", [{ mimeType: "image/png", data: "cHg=" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(turnParams.input, [
    { type: "text", text: "inspect" },
    { type: "localImage", path: "/tmp/private/image-1.png" },
  ]);
  assert.equal(cleaned, 0, "files remain available after turn/start accepts the request");
  (h.driver as any).settleTurn("end_turn");
  assert.equal(await turn, "end_turn");
  assert.equal(cleaned, 1);
});

test("image-only prompt omits an empty text block", async () => {
  let turnParams: any = null;
  const h = makeHarness({}, async () => ({
    paths: ["/tmp/private/image-1.png"],
    inputs: [{ type: "localImage", path: "/tmp/private/image-1.png" }],
    cleanup: async () => {},
  }));
  (h.driver as any).threadId = "thread-images";
  (h.driver as any).peer = { request: async (_method: string, params: any) => { turnParams = params; } };
  const turn = h.driver.prompt("", [{ mimeType: "image/png", data: "cHg=" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(turnParams.input, [{ type: "localImage", path: "/tmp/private/image-1.png" }]);
  (h.driver as any).settleTurn("end_turn");
  assert.equal(await turn, "end_turn");
});

test("turn/start failure cleans staged images and returns refusal", async () => {
  let cleaned = 0;
  const h = makeHarness({}, async () => ({
    paths: ["C:/temp/image.png"],
    inputs: [{ type: "localImage", path: "C:/temp/image.png" }],
    cleanup: async () => { cleaned++; },
  }));
  (h.driver as any).threadId = "thread-images";
  (h.driver as any).peer = { request: async () => { throw new Error("rejected"); } };
  assert.equal(await h.driver.prompt("inspect", [{ mimeType: "image/png", data: "cHg=" }]), "refusal");
  assert.equal(cleaned, 1);
});

test("cancel cleans staged images even while turn/start is still pending", async () => {
  let cleaned = 0;
  const h = makeHarness({}, async () => ({
    paths: ["/tmp/image.png"],
    inputs: [{ type: "localImage", path: "/tmp/image.png" }],
    cleanup: async () => { cleaned++; },
  }));
  (h.driver as any).threadId = "thread-images";
  (h.driver as any).peer = {
    request: async () => new Promise(() => {}),
    notify: () => {},
  };
  const turn = h.driver.prompt("inspect", [{ mimeType: "image/png", data: "cHg=" }]);
  await new Promise((resolve) => setImmediate(resolve));
  h.driver.cancel();
  assert.equal(await turn, "cancelled");
  assert.equal(cleaned, 1);
});

test("dispose racing asynchronous staging cleans the produced files and never calls turn/start", async () => {
  let finishStage!: (staged: StagedPromptImages) => void;
  const staged = new Promise<StagedPromptImages>((resolve) => { finishStage = resolve; });
  let cleaned = 0;
  const h = makeHarness({}, async () => staged);
  let requests = 0;
  (h.driver as any).peer = { request: async () => { requests++; }, dispose: () => {} };
  const turn = h.driver.prompt("inspect", [{ mimeType: "image/png", data: "cHg=" }]);
  h.driver.dispose();
  finishStage({
    paths: ["/tmp/image.png"],
    inputs: [{ type: "localImage", path: "/tmp/image.png" }],
    cleanup: async () => { cleaned++; },
  });
  assert.equal(await turn, "cancelled");
  assert.equal(cleaned, 1);
  assert.equal(requests, 0);
});

test("cancel racing asynchronous staging cleans the produced files and never starts a turn", async () => {
  let finishStage!: (staged: StagedPromptImages) => void;
  const staged = new Promise<StagedPromptImages>((resolve) => { finishStage = resolve; });
  let cleaned = 0;
  const h = makeHarness({}, async () => staged);
  let requests = 0;
  (h.driver as any).peer = { request: async () => { requests++; }, notify: () => {} };
  const turn = h.driver.prompt("inspect", [{ mimeType: "image/png", data: "cHg=" }]);
  h.driver.cancel();
  finishStage({
    paths: ["/tmp/image.png"],
    inputs: [{ type: "localImage", path: "/tmp/image.png" }],
    cleanup: async () => { cleaned++; },
  });
  assert.equal(await turn, "cancelled");
  assert.equal(cleaned, 1);
  assert.equal(requests, 0);
});

test("a concurrent prompt is refused before it can overwrite the active turn's cleanup handle", async () => {
  let finishStage!: (staged: StagedPromptImages) => void;
  const staged = new Promise<StagedPromptImages>((resolve) => { finishStage = resolve; });
  let stageCalls = 0;
  const h = makeHarness({}, async () => { stageCalls++; return staged; });
  (h.driver as any).threadId = "thread-images";
  (h.driver as any).peer = { request: async () => ({ turn: { id: "turn" } }) };
  const first = h.driver.prompt("first", [{ mimeType: "image/png", data: "cHg=" }]);
  assert.equal(await h.driver.prompt("second", [{ mimeType: "image/png", data: "cHg=" }]), "refusal");
  assert.equal(stageCalls, 1);
  finishStage({ paths: [], inputs: [], cleanup: async () => {} });
  await new Promise((resolve) => setImmediate(resolve));
  (h.driver as any).settleTurn("end_turn");
  assert.equal(await first, "end_turn");
});

test("unexpected-exit settlement cleans staged files before resolving the turn", async () => {
  const h = makeHarness();
  let cleaned = 0;
  (h.driver as any).stagedImages = {
    paths: ["/tmp/image.png"],
    inputs: [{ type: "localImage", path: "/tmp/image.png" }],
    cleanup: async () => { cleaned++; },
  };
  const reason = new Promise<string>((resolve) => { (h.driver as any).turnResolve = resolve; });
  (h.driver as any).settleTurn("refusal");
  assert.equal(await reason, "refusal");
  assert.equal(cleaned, 1);
});

test("image validation failure is readable and never calls turn/start", async () => {
  const h = makeHarness();
  let requests = 0;
  (h.driver as any).peer = { request: async () => { requests++; } };
  assert.equal(await h.driver.prompt("inspect", [{ mimeType: "image/gif", data: "cHg=" }]), "refusal");
  assert.equal(requests, 0);
  const error = h.events.find((event) => event.kind === "error");
  assert.ok(error && error.kind === "error");
  assert.match(error.message, /unsupported MIME.*image\/png.*image\/jpeg.*image\/webp/);
});

test("newSession starts a fresh thread and requires the server's actual id", async () => {
  const h = makeHarness();
  const calls: Array<{ method: string; params: unknown }> = [];
  (h.driver as any).peer = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { thread: { id: "fresh-1" } };
    },
  };
  assert.equal(await h.driver.newSession("/fresh"), "fresh-1");
  assert.deepEqual(calls, [{ method: "thread/start", params: { cwd: "/fresh" } }]);
  assert.equal(h.driver.agentSessionId(), "fresh-1");
});

test("newSession validates then resumes the exact persisted thread without replaying history", async () => {
  const h = makeHarness({ resumeId: "thread-7" });
  const calls: Array<{ method: string; params: unknown }> = [];
  (h.driver as any).peer = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "thread/read") {
        return { thread: { id: "thread-7", status: { type: "idle" }, turns: [{ id: "old-turn" }] } };
      }
      return { thread: { id: "thread-7", turns: [{ id: "old-turn" }] } };
    },
  };
  assert.equal(await h.driver.newSession("/resume"), "thread-7");
  assert.deepEqual(calls, [
    { method: "thread/read", params: { threadId: "thread-7", includeTurns: false } },
    { method: "thread/resume", params: { threadId: "thread-7" } },
  ]);
  assert.deepEqual(h.events, []); // provider history is never copied into the normalized log
});

test("active thread validation returns a typed retryable conflict and never starts a replacement", async () => {
  const h = makeHarness({ resumeId: "busy-1" });
  const calls: string[] = [];
  (h.driver as any).peer = {
    request: async (method: string) => {
      calls.push(method);
      return { thread: { id: "busy-1", status: { type: "active" } } };
    },
  };
  await assert.rejects(() => h.driver.newSession("/w"), (err: unknown) => {
    assert.ok(err instanceof CodexAppServerResumeError);
    assert.equal(err.threadId, "busy-1");
    assert.equal(err.retryable, true);
    return true;
  });
  assert.deepEqual(calls, ["thread/read"]);
});

test("resume id mismatch is non-retryable and never falls back to thread/start", async () => {
  const h = makeHarness({ resumeId: "wanted" });
  const calls: string[] = [];
  (h.driver as any).peer = {
    request: async (method: string) => {
      calls.push(method);
      return { thread: { id: "different", status: { type: "idle" } } };
    },
  };
  await assert.rejects(() => h.driver.newSession("/w"), (err: unknown) => {
    assert.ok(err instanceof CodexAppServerResumeError);
    assert.equal(err.retryable, false);
    return true;
  });
  assert.deepEqual(calls, ["thread/read"]);
});

test("dispose interrupts, declines parked approvals, then closes transport without deleting the thread", () => {
  const h = makeHarness({ resumeId: "thread-1" });
  const order: string[] = [];
  (h.driver as any).threadId = "thread-1";
  (h.driver as any).peer = {
    notify: (method: string) => order.push(method),
    dispose: () => order.push("dispose"),
  };
  (h.driver as any).pendingApprovals.set("approval", {
    method: "item/commandExecution/requestApproval",
    params: {},
    resolve: (result: { decision: string }) => order.push(result.decision),
  });
  h.driver.dispose();
  assert.deepEqual(order, ["turn/interrupt", "decline", "dispose"]);
});

test("cancel emits already-consumed per-turn usage once before settling", () => {
  const h = makeHarness();
  (h.driver as any).pendingTurnUsage = { input: 7, output: 4, cached: 2 };
  h.driver.cancel();
  assert.deepEqual(h.events, [{ kind: "token_usage", inputTokens: 7, outputTokens: 4, cachedInputTokens: 2 }]);
  h.driver.cancel();
  assert.equal(h.events.length, 1);
});

test("late usage and completion after cancel cannot double-count the settled turn", () => {
  const h = makeHarness();
  const notifications = new Map<string, (params: any) => void>();
  (h.driver as any).registerHandlers({
    onRequest: () => {},
    onNotification: (method: string, handler: (params: any) => void) => notifications.set(method, handler),
  });
  (h.driver as any).pendingTurnUsage = { input: 7, output: 4, cached: 2 };
  h.driver.cancel();
  notifications.get("thread/tokenUsage/updated")!({
    tokenUsage: { last: { inputTokens: 11, outputTokens: 6, cachedInputTokens: 3 } },
  });
  notifications.get("turn/completed")!({});
  assert.deepEqual(h.events, [{ kind: "token_usage", inputTokens: 7, outputTokens: 4, cachedInputTokens: 2 }]);
});

test("failed turn/completed maps to refusal and surfaces one nested error", async () => {
  const h = makeHarness();
  const notifications = new Map<string, (params: any) => void>();
  (h.driver as any).registerHandlers({
    onRequest: () => {},
    onNotification: (method: string, handler: (params: any) => void) => notifications.set(method, handler),
  });
  const reason = new Promise<string>((resolve) => { (h.driver as any).turnResolve = resolve; });
  const error = { message: "usage limit reached" };
  notifications.get("error")!({ error });
  notifications.get("turn/completed")!({ turn: { status: "failed", error } });
  assert.equal(await reason, "refusal");
  assert.deepEqual(h.events, [{ kind: "error", message: "usage limit reached" }]);
});

test("failed turn with a bare-string error remains user-readable", async () => {
  const h = makeHarness();
  const notifications = new Map<string, (params: any) => void>();
  (h.driver as any).registerHandlers({
    onRequest: () => {},
    onNotification: (method: string, handler: (params: any) => void) => notifications.set(method, handler),
  });
  const reason = new Promise<string>((resolve) => { (h.driver as any).turnResolve = resolve; });
  notifications.get("turn/completed")!({ turn: { status: "failed", error: "provider failed" } });
  assert.equal(await reason, "refusal");
  assert.deepEqual(h.events, [{ kind: "error", message: "provider failed" }]);
});

test("interrupted turn/completed maps to cancelled", async () => {
  const h = makeHarness();
  const notifications = new Map<string, (params: any) => void>();
  (h.driver as any).registerHandlers({
    onRequest: () => {},
    onNotification: (method: string, handler: (params: any) => void) => notifications.set(method, handler),
  });
  const reason = new Promise<string>((resolve) => { (h.driver as any).turnResolve = resolve; });
  notifications.get("turn/completed")!({ turn: { status: "interrupted" } });
  assert.equal(await reason, "cancelled");
});

test("turn settlement closes the active id but retains the provider turn used by conversation forks", () => {
  const h = makeHarness();
  const notifications = new Map<string, (params: any) => void>();
  (h.driver as any).registerHandlers({
    onRequest: () => {},
    onNotification: (method: string, handler: (params: any) => void) => notifications.set(method, handler),
  });
  notifications.get("turn/started")!({ turn: { id: "turn-provider-7" } });
  (h.driver as any).promptBusy = true;
  (h.driver as any).turnResolve = () => {};
  notifications.get("turn/completed")!({ turn: { status: "completed" } });
  assert.equal((h.driver as any).turnId, null);
  assert.equal((h.driver as any).promptBusy, false);
  assert.equal(h.driver.agentTurnId(), "turn-provider-7");
});

test("a second prompt missing turn/started cannot reuse the first completed turn id", async () => {
  const h = makeHarness();
  const notifications = notificationHandlers(h.driver);
  notifications.get("turn/started")!({ turn: { id: "first-completed-turn" } });
  (h.driver as any).promptBusy = true;
  (h.driver as any).turnResolve = () => {};
  notifications.get("turn/completed")!({ turn: { status: "completed" } });
  assert.equal(h.driver.agentTurnId(), "first-completed-turn", "the completed checkpoint remains available between turns");

  (h.driver as any).threadId = "thread-two-turns";
  (h.driver as any).peer = { request: async () => ({}) };
  const second = h.driver.prompt("second turn");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.driver.agentTurnId(), null, "missing turn/started fails closed instead of reusing the checkpoint");
  notifications.get("turn/completed")!({ turn: { status: "completed" } });
  assert.equal(await second, "end_turn");
  assert.equal(h.driver.agentTurnId(), null);
});

test("forkSession calls thread/fork with source thread and last turn", async () => {
  const h = makeHarness();
  (h.driver as any).threadId = "thread-source";
  let seen: unknown;
  (h.driver as any).peer = {
    request: async (method: string, params: unknown) => {
      seen = { method, params };
      return { thread: { id: "thread-forked" } };
    },
  };
  assert.equal(await h.driver.forkSession("turn-provider-7", "/tmp/fork"), "thread-forked");
  assert.deepEqual(seen, {
    method: "thread/fork",
    params: { threadId: "thread-source", lastTurnId: "turn-provider-7", cwd: "/tmp/fork" },
  });
});

test("archiveSession delegates failed-fork cleanup to thread/archive", async () => {
  const h = makeHarness();
  let seen: unknown;
  (h.driver as any).peer = {
    request: async (method: string, params: unknown) => { seen = { method, params }; return {}; },
  };
  await h.driver.archiveSession("thread-orphan");
  assert.deepEqual(seen, { method: "thread/archive", params: { threadId: "thread-orphan" } });
});

test("real NDJSON child resumes and continues without replaying history or cumulative usage", async () => {
  const events: SessionEventPayload[] = [];
  const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
  const driver = new CodexAppServerDriver(
    {
      command: process.execPath,
      args: [fixture, "resume"],
      cwd: process.cwd(),
      env: {},
      config: {} as SessionConfig,
      context: { kind: "native" },
      resumeId: "fixture-resume",
    },
    { onEvent: (event) => events.push(event), onStderr: () => {}, onExit: () => {} },
  );
  try {
    await driver.initialize();
    assert.equal(await driver.newSession(process.cwd()), "fixture-resume");
    assert.equal(await driver.prompt("next"), "end_turn");
    assert.deepEqual(
      events.filter((event) => event.kind === "agent_message").map((event) => event.text),
      ["continued"],
    );
    const usage = events.filter((event) => event.kind === "token_usage");
    assert.deepEqual(usage, [{ kind: "token_usage", inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 }]);
  } finally {
    driver.dispose();
  }
});

test("commandExecution: started -> tool_call, completed -> tool_call_update + command_output", () => {
  const h = makeHarness();
  h.onItem({ type: "commandExecution", id: "c1", command: "echo hi" }, false);
  h.onItem({ type: "commandExecution", id: "c1", command: "echo hi", exitCode: 0, aggregatedOutput: "hi\n" }, true);
  const kinds = h.events.map((e) => e.kind);
  assert.deepEqual(kinds, ["tool_call", "tool_call_update", "command_output"]);
  assert.equal((h.events[0] as { status: string }).status, "in_progress");
  assert.equal((h.events[1] as { status: string }).status, "completed");
});

test("fileChange -> a file_edit per change + a tool_call", () => {
  const h = makeHarness();
  h.onItem({ type: "fileChange", id: "f1", changes: [{ path: "a.ts", diff: "@@" }, { path: "b.ts" }] }, true);
  const kinds = h.events.map((e) => e.kind);
  assert.deepEqual(kinds, ["file_edit", "file_edit", "tool_call"]);
});

test("agentMessage completed -> agent_message; reasoning -> agent_thought; todoList -> plan", () => {
  const h = makeHarness();
  h.onItem({ type: "agentMessage", id: "m1", text: "done" }, true);
  h.onItem({ type: "reasoning", id: "r1", text: "thinking" }, true);
  h.onItem({ type: "todoList", id: "t1", items: [{ text: "step", status: "in_progress" }] }, true);
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ["agent_message", "agent_thought", "plan"],
  );
});

test("numeric app-server item identities normalize to safe distinct strings", () => {
  const h = makeHarness();
  h.onItem({ type: "agentMessage", id: 17, text: "answer" }, true);
  h.onItem({ type: "commandExecution", id: 18, command: "first" }, false);
  h.onItem({ type: "commandExecution", id: 19, command: "second" }, false);
  assert.deepEqual(h.events[0], {
    kind: "agent_message",
    text: "answer",
    messageId: "item-17",
    final: true,
  });
  assert.deepEqual(h.events.filter((event) => event.kind === "tool_call").map((event) => event.toolCallId), [
    "item-18",
    "item-19",
  ]);
});

test("resolvePermission writes accept on allow, decline on deny (command approval)", () => {
  const h = makeHarness();
  const seen: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending: Map<string, any> = (h.driver as any).pendingApprovals;
  const cmd = "item/commandExecution/requestApproval";
  pending.set("req-1", { method: cmd, params: { command: "ls" }, resolve: (d: unknown) => seen.push(d) });
  h.driver.resolvePermission("req-1", "allow");
  assert.deepEqual(seen, [{ decision: "accept" }]);
  assert.equal(pending.has("req-1"), false);

  pending.set("req-2", { method: cmd, params: { command: "ls" }, resolve: (d: unknown) => seen.push(d) });
  h.driver.resolvePermission("req-2", "deny");
  assert.deepEqual(seen[1], { decision: "decline" });
});

test("resolvePermission for an unknown id is a no-op", () => {
  const h = makeHarness();
  h.driver.resolvePermission("nope", "allow"); // must not throw
  assert.ok(true);
});

test("fallback approval ids remain unique after an earlier request is resolved", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });
  const approve = requests.get("item/commandExecution/requestApproval")!;

  const first = approve({ turnId: "turn-fallback", command: "one" });
  const second = approve({ turnId: "turn-fallback", command: "two" });
  assert.deepEqual(h.events.map((event) => event.kind === "permission_request" && event.requestId), [
    "turn-fallback:1",
    "turn-fallback:2",
  ]);

  assert.equal(h.driver.resolvePermission("turn-fallback:1", "allow"), true);
  const third = approve({ turnId: "turn-fallback", command: "three" });
  assert.equal(h.events.at(-1)?.kind === "permission_request" && h.events.at(-1)?.requestId, "turn-fallback:3");
  assert.equal(h.driver.resolvePermission("turn-fallback:2", "deny"), true);
  assert.equal(h.driver.resolvePermission("turn-fallback:3", "allow"), true);

  assert.deepEqual(await Promise.all([first, second, third]), [
    { decision: "accept" },
    { decision: "decline" },
    { decision: "accept" },
  ]);
});

test("a repeated provider approval id declines the replaced parked RPC", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });
  const approve = requests.get("item/commandExecution/requestApproval")!;

  const replaced = approve({ approvalId: "duplicate", command: "old" });
  const current = approve({ approvalId: "duplicate", command: "new" });
  assert.deepEqual(await replaced, { decision: "decline" });
  assert.equal(h.driver.resolvePermission("duplicate", "allow"), true);
  assert.deepEqual(await current, { decision: "accept" });
});

const cfg = (permissionMode: string, extra: Partial<SessionConfig> = {}): SessionConfig =>
  ({ permissionMode, ...extra }) as SessionConfig;

test("buildCodexTurnParams: default and 'auto-review' use Guardian with an escapable workspace sandbox", () => {
  const p = buildCodexTurnParams(cfg("auto-review"), "t1", "/w", [{ type: "text", text: "hi" }]);
  assert.equal(p.approvalPolicy, "on-request");
  assert.equal(p.approvalsReviewer, "auto_review");
  assert.deepEqual(p.sandboxPolicy, { type: "workspaceWrite" });
  assert.equal(p.threadId, "t1");
  assert.equal(p.cwd, "/w");
  const d = buildCodexTurnParams({} as SessionConfig, "t1", "/w", []);
  assert.equal(d.approvalPolicy, "on-request");
  assert.equal(d.approvalsReviewer, "auto_review");
  assert.deepEqual(d.sandboxPolicy, { type: "workspaceWrite" });
});

test("buildCodexTurnParams: 'untrusted' asks every tool (no auto reviewer)", () => {
  const p = buildCodexTurnParams(cfg("untrusted"), "t1", "/w", []);
  assert.equal(p.approvalPolicy, "untrusted");
  assert.equal(p.approvalsReviewer, undefined);
  assert.deepEqual(p.sandboxPolicy, { type: "workspaceWrite" });
});

test("buildCodexTurnParams: restricted modes can escalate; full access never asks", () => {
  assert.equal(buildCodexTurnParams(cfg("read-only"), "t", "/w", []).approvalPolicy, "on-request");
  assert.deepEqual(buildCodexTurnParams(cfg("read-only"), "t", "/w", []).sandboxPolicy, { type: "readOnly" });
  // Old persisted workspace-write selections now use Codex's normal sandbox-escape flow.
  assert.equal(buildCodexTurnParams(cfg("on-request"), "t", "/w", []).approvalPolicy, "on-request");
  assert.deepEqual(buildCodexTurnParams(cfg("on-request"), "t", "/w", []).sandboxPolicy, { type: "workspaceWrite" });
  assert.equal(buildCodexTurnParams(cfg("workspace-write"), "t", "/w", []).approvalPolicy, "on-request");
  assert.deepEqual(buildCodexTurnParams(cfg("workspace-write"), "t", "/w", []).sandboxPolicy, { type: "workspaceWrite" });
  assert.deepEqual(buildCodexTurnParams(cfg("danger-full-access"), "t", "/w", []).sandboxPolicy, {
    type: "dangerFullAccess",
  });
  assert.equal(buildCodexTurnParams(cfg("danger-full-access"), "t", "/w", []).approvalPolicy, "never");
  assert.equal(buildCodexTurnParams(cfg("danger-full-access"), "t", "/w", []).approvalsReviewer, undefined);
});

test("buildCodexTurnParams: passes model/effort through, skips the 'default' model sentinel", () => {
  const p = buildCodexTurnParams(cfg("workspace-write", { model: "gpt-5-codex", effort: "high" }), "t", "/w", []);
  assert.equal(p.model, "gpt-5-codex");
  assert.equal(p.effort, "high");
  const d = buildCodexTurnParams(cfg("workspace-write", { model: "default" }), "t", "/w", []);
  assert.equal(d.model, undefined);
});

test("reviewSummary: terminal verdict -> '[AI review] <verb> (<risk> risk): <why>'", () => {
  assert.equal(
    reviewSummary({ review: { id: "r1", status: "approved", riskLevel: "low", rationale: "reads only" } }),
    "[AI review] approved (low risk): reads only",
  );
  assert.equal(reviewSummary({ id: "r2", status: "denied", riskLevel: "high" }), "[AI review] denied (high risk)");
  // nested under .item is also accepted (defensive against the unstable shape)
  assert.equal(reviewSummary({ item: { id: "r3", status: "approved" } }), "[AI review] approved");
});

test("reviewSummary: in-progress / unknown / missing status -> null (no event)", () => {
  assert.equal(reviewSummary({ review: { status: "inProgress" } }), null);
  assert.equal(reviewSummary({ status: "bogus" }), null);
  assert.equal(reviewSummary({}), null);
  assert.equal(reviewSummary(null), null);
});

test("parseReviewDecision emits a reviewer-neutral bounded terminal decision", () => {
  const rationale = "x".repeat(250);
  assert.deepEqual(parseReviewDecision({
    review: { id: "review-1", approvalId: "approval-1", status: "timedOut", riskLevel: "high", rationale },
  }), {
    reviewId: "review-1",
    requestId: "approval-1",
    reviewer: { kind: "agent", id: "codex-guardian" },
    outcome: "timed_out",
    riskLevel: "high",
    rationale: `${"x".repeat(200)}...`,
  });
  assert.equal(parseReviewDecision({ id: "r", status: "approved", riskLevel: "critical" })?.riskLevel, undefined);
  assert.equal(parseReviewDecision({ status: "approved" }), null, "unidentified unstable payload fails closed");
});

test("Guardian notification emits a structured review_decision instead of untyped reasoning", () => {
  const h = makeHarness();
  const notifications = new Map<string, (params: any) => void>();
  (h.driver as any).registerHandlers({
    onRequest: () => {},
    onNotification: (method: string, handler: (params: any) => void) => notifications.set(method, handler),
  });
  notifications.get("item/autoApprovalReview/completed")!({
    review: { id: "review-7", status: "approved", riskLevel: "low", rationale: "read only" },
  });
  assert.deepEqual(h.events, [{
    kind: "review_decision",
    reviewId: "review-7",
    reviewer: { kind: "agent", id: "codex-guardian" },
    outcome: "allowed",
    riskLevel: "low",
    rationale: "read only",
  }]);
});

test("only auto-review approval requests carry Guardian escalation provenance", () => {
  for (const [mode, escalated] of [[undefined, true], ["on-request", false]] as const) {
    const h = makeHarness({ config: mode ? cfg(mode) : {} as SessionConfig });
    const requests = new Map<string, (params: any) => Promise<any>>();
    (h.driver as any).registerHandlers({
      onRequest: (method: string, handler: (params: any) => Promise<any>) => requests.set(method, handler),
      onNotification: () => {},
    });
    void requests.get("item/commandExecution/requestApproval")!({ approvalId: `a-${mode ?? "auto"}`, command: "deploy" });
    const event = h.events.at(-1);
    assert.equal(event?.kind, "permission_request");
    if (event?.kind === "permission_request") {
      assert.deepEqual(event.context?.escalatedBy, escalated ? { kind: "agent", id: "codex-guardian" } : undefined);
    }
  }
});

test("approvalContext exposes bounded Codex tool/path/network/branch selectors", () => {
  assert.deepEqual(approvalContext("item/fileChange/requestApproval", {
    changes: [{ path: "/repo/a.ts" }],
    permissions: { network: true },
    branchName: "feature/x",
    reason: "apply patch",
  }, true), {
    toolName: "fileChange",
    input: "apply patch",
    path: "/repo/a.ts",
    network: "requested",
    branch: "feature/x",
    escalatedBy: { kind: "agent", id: "codex-guardian" },
  });
  assert.equal(approvalContext("item/commandExecution/requestApproval", { command: "x".repeat(3000) }, false).input?.length, 2003);
  assert.equal(approvalContext("item/fileChange/requestApproval", {
    changes: [{ path: "/repo/a.ts" }, { path: "/outside/b.ts" }],
  }, false).path, undefined, "multi-file approvals cannot be authorized by only their first path");
});

test("approvalResponse: command/file approvals use {decision: accept|decline}", () => {
  for (const m of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
    assert.deepEqual(approvalResponse(m, { command: "ls" }, true), { decision: "accept" });
    assert.deepEqual(approvalResponse(m, { command: "ls" }, false), { decision: "decline" });
  }
});

test("approvalResponse: permissions approvals use {permissions, scope} — NOT a decision", () => {
  const params = { itemId: "p1", permissions: { fileSystem: { writableRoots: ["/x"] } } };
  // allow -> grant exactly what was requested, for the session
  assert.deepEqual(approvalResponse("item/permissions/requestApproval", params, true), {
    permissions: { fileSystem: { writableRoots: ["/x"] } },
    scope: "session",
  });
  // deny -> grant nothing
  assert.deepEqual(approvalResponse("item/permissions/requestApproval", params, false), {
    permissions: {},
    scope: "turn",
  });
  // a permissions response must never carry a `decision` key
  assert.equal("decision" in approvalResponse("item/permissions/requestApproval", params, true), false);
});

test("resolvePermission builds the permissions-grant shape for a permissions request", () => {
  const h = makeHarness();
  let sent: unknown = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending: Map<string, any> = (h.driver as any).pendingApprovals;
  pending.set("p1", { method: "item/permissions/requestApproval", params: { permissions: { network: true } }, resolve: (r: unknown) => (sent = r) });
  h.driver.resolvePermission("p1", "allow");
  assert.deepEqual(sent, { permissions: { network: true }, scope: "session" });
});

test("streamed text preserves provider ids and completion never adds an old-web duplicate", () => {
  const h = makeHarness();
  const notifications = notificationHandlers(h.driver);
  const messageDelta = notifications.get("item/agentMessage/delta")!;
  const thoughtDelta = notifications.get("item/reasoning/delta")!;
  messageDelta({ itemId: "m1", delta: "streamed " });
  messageDelta({ itemId: "m1", delta: "already" });
  messageDelta({ itemId: "m2", delta: "second" });
  thoughtDelta({ itemId: "r1", delta: "thought" });

  const beforeCompletion = [...h.events];
  // Exact and differing authoritative completions are both suppressed. This preserves the
  // pre-v70 event sequence for an older web client, which otherwise renders a duplicate bubble.
  h.onItem({ type: "agentMessage", id: "m1", text: "streamed already" }, true);
  h.onItem({ type: "agentMessage", id: "m2", text: "different authoritative text" }, true);
  h.onItem({ type: "reasoning", id: "r1", text: "different thought" }, true);
  assert.deepEqual(h.events, beforeCompletion);
  assert.deepEqual(h.events, [
    { kind: "agent_message", text: "streamed ", messageId: "m1" },
    { kind: "agent_message", text: "already", messageId: "m1" },
    { kind: "agent_message", text: "second", messageId: "m2" },
    { kind: "agent_thought", text: "thought", messageId: "r1" },
  ]);

  // A completion-only item remains one event for old clients and is explicitly whole for new ones.
  h.onItem({ type: "agentMessage", id: "m2", text: "never streamed" }, true);
  h.onItem({ type: "agentMessage", id: "m3", text: "never streamed" }, true);
  assert.deepEqual(h.events.at(-1), {
    kind: "agent_message",
    text: "never streamed",
    messageId: "m3",
    final: true,
  });
});

test("prompt() fails fast (refusal + error) when the app-server is not running", async () => {
  const h = makeHarness(); // constructed but never initialize()d -> peer is null
  const reason = await h.driver.prompt("do something");
  assert.equal(reason, "refusal");
  assert.equal(
    h.events.some((e) => (e as { kind: string }).kind === "error"),
    true,
  );
});
