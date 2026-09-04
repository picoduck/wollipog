import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { SessionConfig, SessionEventPayload } from "@wollipog/protocol";
import {
  approvalContext,
  approvalResponse,
  codexAppServerArgs,
  buildCodexTurnParams,
  CodexAppServerDriver,
  CodexAppServerResumeError,
  DEFAULT_MODE_QUESTION_FEATURE,
  diagnosticValue,
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

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`condition was not met within ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function childItemId(threadId: string, itemId: string): string {
  return `codex-child:${JSON.stringify([threadId, itemId])}`;
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
  const stderr: string[] = [];
  let authenticationFailures = 0;
  const subscriptionUsage: unknown[] = [];
  const cb: DriverCallbacks = {
    onEvent: (p) => events.push(p),
    onStderr: (line) => stderr.push(line),
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
  return { driver, events, stderr, subscriptionUsage, onItem, authenticationFailures: () => authenticationFailures };
}

test("app-server launch enables Default-mode questions before the subcommand", () => {
  const base = ["/opt/codex.js", "-c", "model=default"];
  assert.deepEqual(codexAppServerArgs(base), [
    ...base,
    "--enable",
    DEFAULT_MODE_QUESTION_FEATURE,
    "app-server",
  ]);
  assert.deepEqual(codexAppServerArgs(base, false), [...base, "app-server"]);
  assert.deepEqual(base, ["/opt/codex.js", "-c", "model=default"], "configured arguments remain immutable");
});

test("unsupported Default-mode question feature retries the unchanged app-server launch", async () => {
  const launches: string[][] = [];
  const stderr: string[] = [];
  const exits: Array<number | null> = [];
  const driver = new CodexAppServerDriver({
    command: "codex",
    args: ["--config", "model=default"],
    cwd: "/tmp/work",
    env: {},
    config: {},
    context: { kind: "native" },
  }, {
    onEvent: () => {},
    onStderr: (line) => stderr.push(line),
    onExit: (code) => exits.push(code),
  }, undefined, {
    spawn: (opts) => {
      launches.push([...opts.args]);
      const child = fakeAgentProcess();
      if (launches.length === 1) {
        setImmediate(() => {
          child.stderr.write("Error: Unknown feature flag: default_mode_request_user_input\n");
          child.emit("close", 1);
        });
      } else {
        child.stdin.on("data", (chunk) => {
          for (const line of String(chunk).trim().split(/\r?\n/)) {
            if (!line) continue;
            const message = JSON.parse(line) as { id?: number; method?: string };
            if (message.method === "initialize") {
              child.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "old-codex" } }) + "\n");
            }
          }
        });
      }
      return child;
    },
    kill: () => {},
  });

  try {
    await driver.initialize();
    assert.deepEqual(launches, [
      ["--config", "model=default", "--enable", DEFAULT_MODE_QUESTION_FEATURE, "app-server"],
      ["--config", "model=default", "app-server"],
    ]);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0]!, /continuing without Default-mode structured questions/);
    assert.doesNotMatch(stderr[0]!, /Unknown feature flag/);
    assert.deepEqual(exits, [], "the rejected probe launch must not fail the managed session");
  } finally {
    driver.dispose();
  }
});

test("a late rejected-probe close cannot fail or tear down the healthy fallback", async () => {
  const children: AgentProcess[] = [];
  const exits: Array<number | null> = [];
  const killed: AgentProcess[] = [];
  const stderr: string[] = [];
  const driver = new CodexAppServerDriver({
    command: "codex",
    args: [],
    cwd: "/tmp/work",
    env: {},
    config: {},
    context: { kind: "native" },
  }, {
    onEvent: () => {},
    onStderr: (line) => stderr.push(line),
    onExit: (code) => exits.push(code),
  }, undefined, {
    spawn: () => {
      const child = fakeAgentProcess();
      children.push(child);
      child.stdin.on("data", (chunk) => {
        const message = JSON.parse(String(chunk).trim()) as { id?: number; method?: string };
        if (message.method !== "initialize") return;
        if (children.length === 1) {
          child.stderr.write("Error: Unknown feature flag: default_mode_request_user_input\n");
          child.stdin.emit("error", new Error("EPIPE"));
          return;
        }
        child.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "old-codex" } }) + "\n");
        children[0]!.stderr.write("Usage: codex [OPTIONS]\n");
        children[0]!.emit("close", 1);
      });
      return child;
    },
    kill: (child) => killed.push(child),
  });

  try {
    await driver.initialize();
    assert.equal(children.length, 2);
    assert.deepEqual(killed, [children[0]]);
    assert.deepEqual(exits, []);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0]!, /continuing without Default-mode structured questions/);
    assert.doesNotMatch(stderr[0]!, /Usage:/);
    assert.equal(driver.pid, children[1]!.pid, "the fallback remains the managed child");
  } finally {
    driver.dispose();
  }
});

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

test("dispose interrupts, cancels parked approvals, then closes transport without deleting the thread", () => {
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
  assert.deepEqual(order, ["turn/interrupt", "cancel", "dispose"]);
});

test("dispose records active subagents as unreachable without deleting their durable threads", () => {
  const h = makeHarness({ resumeId: "thread-1" });
  (h.driver as any).threadId = "thread-1";
  (h.driver as any).peer = { notify: () => {}, dispose: () => {} };
  const notifications = notificationHandlers(h.driver);
  notifications.get("item/completed")!({
    threadId: "thread-1",
    item: {
      type: "collabAgentToolCall",
      id: "spawn-child",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "thread-1",
      receiverThreadIds: ["child-thread"],
      agentsStates: { "child-thread": { status: "running" } },
    },
  });

  h.driver.dispose();

  assert.ok(h.events.some((event) => event.kind === "tool_call_update" &&
    event.toolCallId === "spawn-child" && event.subagentLifecycle === "unreachable"));
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
  notifications.get("item/agentMessage/delta")!({ itemId: "interrupted", delta: "partial" });
  notifications.get("turn/completed")!({ turn: { status: "interrupted" } });
  assert.equal(await reason, "cancelled");
  assert.equal(h.events.some((event) => event.kind === "agent_response_completed"), false);
});

test("unknown Codex terminal status cannot complete a streamed response", async () => {
  const h = makeHarness();
  const notifications = notificationHandlers(h.driver);
  const reason = new Promise<string>((resolve) => { (h.driver as any).turnResolve = resolve; });
  notifications.get("item/agentMessage/delta")!({ itemId: "unknown-status", delta: "partial" });
  notifications.get("turn/completed")!({ turn: { status: "aborted" } });

  assert.equal(await reason, "end_turn", "unknown statuses retain the existing tolerant settlement");
  assert.equal(
    h.events.some((event) => event.kind === "agent_response_completed"),
    false,
    "only the explicit completed status is authoritative completion evidence",
  );
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

test("real NDJSON transport keeps structured child output live after the parent turn settles", async () => {
  const events: SessionEventPayload[] = [];
  const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
  const driver = new CodexAppServerDriver(
    {
      command: process.execPath,
      args: [fixture, "subagents"],
      cwd: process.cwd(),
      env: {},
      config: {} as SessionConfig,
      context: { kind: "native" },
    },
    { onEvent: (event) => events.push(event), onStderr: () => {}, onExit: () => {} },
  );
  try {
    await driver.initialize();
    assert.equal(await driver.newSession(process.cwd()), "fixture-subagents");
    assert.equal(await driver.prompt("inspect"), "end_turn", "the foreground turn settles first");
    const messageId = childItemId("fixture-child", "fixture-child-message");
    await waitForCondition(() => events.some((event) => event.kind === "tool_call_update" &&
      event.toolCallId === "fixture-spawn" && event.subagentLifecycle === "completed"));
    assert.deepEqual(events.find((event) => event.kind === "agent_message" && event.messageId === messageId), {
      kind: "agent_message",
      text: "Background inspection complete.",
      messageId,
      final: true,
      parentToolUseId: "fixture-spawn",
    });
    assert.ok(events.some((event) => event.kind === "tool_call_update" &&
      event.toolCallId === "fixture-spawn" && event.subagentLifecycle === "completed"));
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

test("structured Codex collaboration items expose recursive live subagent output and lifecycle", () => {
  const h = makeHarness();
  (h.driver as any).threadId = "root-thread";
  const notifications = notificationHandlers(h.driver);

  notifications.get("item/started")!({
    threadId: "root-thread",
    item: {
      type: "collabAgentToolCall",
      id: "spawn-outer",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "root-thread",
      receiverThreadIds: ["child-thread"],
      prompt: "Inspect parser behavior",
      agentsStates: { "child-thread": { status: "pendingInit" } },
    },
  });
  notifications.get("item/completed")!({
    threadId: "child-thread",
    item: { type: "agentMessage", id: "child-message", text: "Inspecting parser events." },
  });
  notifications.get("item/reasoning/summaryTextDelta")!({
    threadId: "child-thread",
    turnId: "child-turn",
    itemId: "child-reasoning",
    summaryIndex: 0,
    delta: "Checking nested behavior.",
  });
  notifications.get("item/completed")!({
    threadId: "child-thread",
    item: {
      type: "collabAgentToolCall",
      id: "spawn-inner",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "child-thread",
      receiverThreadIds: ["grandchild-thread"],
      prompt: "Check nested attribution",
      agentsStates: { "grandchild-thread": { status: "running" } },
    },
  });
  notifications.get("item/started")!({
    threadId: "grandchild-thread",
    item: { type: "commandExecution", id: "grandchild-command", command: "pnpm test" },
  });
  notifications.get("item/completed")!({
    threadId: "grandchild-thread",
    item: {
      type: "commandExecution",
      id: "grandchild-command",
      command: "pnpm test",
      status: "completed",
      aggregatedOutput: "passed",
    },
  });
  notifications.get("thread/tokenUsage/updated")!({
    threadId: "grandchild-thread",
    tokenUsage: { last: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2 } },
  });
  notifications.get("thread/tokenUsage/updated")!({
    threadId: "grandchild-thread",
    tokenUsage: { last: { inputTokens: 11, outputTokens: 5, cachedInputTokens: 3 } },
  });
  notifications.get("turn/completed")!({
    threadId: "grandchild-thread",
    turn: { id: "grandchild-turn", status: "completed" },
  });
  notifications.get("item/completed")!({
    threadId: "root-thread",
    item: {
      type: "collabAgentToolCall",
      id: "wait-outer",
      tool: "wait",
      status: "completed",
      senderThreadId: "root-thread",
      receiverThreadIds: ["child-thread"],
      agentsStates: { "child-thread": { status: "completed", message: "Parser audit complete." } },
    },
  });
  notifications.get("item/completed")!({
    threadId: "unrelated-thread",
    item: { type: "agentMessage", id: "private-other-thread", text: "must not cross sessions" },
  });

  assert.deepEqual(h.events[0], {
    kind: "tool_call",
    toolCallId: "spawn-outer",
    title: "Agent: Inspect parser behavior",
    toolKind: "agent",
    status: "pending",
    subagentLifecycle: "starting",
  });
  const childMessageId = childItemId("child-thread", "child-message");
  const innerSpawnId = childItemId("child-thread", "spawn-inner");
  assert.deepEqual(h.events.find((event) => event.kind === "agent_message" && event.messageId === childMessageId), {
    kind: "agent_message",
    text: "Inspecting parser events.",
    messageId: childMessageId,
    final: true,
    parentToolUseId: "spawn-outer",
  });
  assert.deepEqual(h.events.find((event) => event.kind === "agent_thought"), {
    kind: "agent_thought",
    text: "Checking nested behavior.",
    messageId: childItemId("child-thread", "child-reasoning"),
    parentToolUseId: "spawn-outer",
  });
  assert.deepEqual(h.events.find((event) => event.kind === "tool_call" && event.toolCallId === innerSpawnId), {
    kind: "tool_call",
    toolCallId: innerSpawnId,
    title: "Agent: Check nested attribution",
    toolKind: "agent",
    status: "in_progress",
    parentToolUseId: "spawn-outer",
    subagentLifecycle: "running",
  });
  assert.deepEqual(h.events.find((event) => event.kind === "command_output"), {
    kind: "command_output",
    text: "passed",
    parentToolUseId: innerSpawnId,
  });
  assert.deepEqual(h.events.find((event) => event.kind === "token_usage"), {
    kind: "token_usage",
    inputTokens: 11,
    outputTokens: 5,
    cachedInputTokens: 3,
    parentToolUseId: innerSpawnId,
  });
  assert.ok(h.events.some((event) => event.kind === "tool_call_update" &&
    event.toolCallId === "spawn-outer" && event.subagentLifecycle === "completed"));
  assert.equal(h.events.filter((event) => event.kind === "token_usage").length, 1,
    "repeated cumulative child updates emit only the latest settled usage");
  assert.equal(h.events.some((event) => event.kind === "agent_message" && event.text.includes("must not cross")), false);
});

test("multiplexed child item ids cannot collide with root item ids", () => {
  const h = makeHarness();
  (h.driver as any).threadId = "root-thread";
  const notifications = notificationHandlers(h.driver);
  notifications.get("item/started")!({
    threadId: "root-thread",
    item: { type: "commandExecution", id: "shared-counter", command: "root command" },
  });
  notifications.get("item/completed")!({
    threadId: "root-thread",
    item: {
      type: "collabAgentToolCall",
      id: "spawn-child",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "root-thread",
      receiverThreadIds: ["child-thread"],
      agentsStates: { "child-thread": { status: "running" } },
    },
  });
  notifications.get("item/started")!({
    threadId: "child-thread",
    item: { type: "commandExecution", id: "shared-counter", command: "child command" },
  });

  const calls = h.events.filter((event) => event.kind === "tool_call" && event.toolKind === "execute");
  assert.deepEqual(calls.map((event) => ({ id: event.toolCallId, parent: event.parentToolUseId })), [
    { id: "shared-counter", parent: undefined },
    { id: childItemId("child-thread", "shared-counter"), parent: "spawn-child" },
  ]);
});

test("resume collaboration re-admits a durable child after driver restart", () => {
  const h = makeHarness();
  (h.driver as any).threadId = "root-thread";
  const notifications = notificationHandlers(h.driver);
  notifications.get("item/completed")!({
    threadId: "root-thread",
    item: {
      type: "collabAgentToolCall",
      id: "resume-child",
      tool: "resumeAgent",
      status: "completed",
      senderThreadId: "root-thread",
      receiverThreadIds: ["durable-child-thread"],
      agentsStates: { "durable-child-thread": { status: "running" } },
    },
  });
  notifications.get("item/completed")!({
    threadId: "durable-child-thread",
    item: { type: "agentMessage", id: "resumed-output", text: "Continued after restart." },
  });

  assert.deepEqual(h.events[0], {
    kind: "tool_call",
    toolCallId: "resume-child",
    title: "Resume Agent",
    toolKind: "agent",
    status: "in_progress",
    subagentLifecycle: "running",
  });
  assert.deepEqual(h.events[1], {
    kind: "agent_message",
    text: "Continued after restart.",
    messageId: childItemId("durable-child-thread", "resumed-output"),
    final: true,
    parentToolUseId: "resume-child",
  });
});

test("subagent turn notifications cannot replace or settle the parent turn", async () => {
  const h = makeHarness();
  (h.driver as any).threadId = "root-thread";
  (h.driver as any).turnId = "root-turn";
  const notifications = notificationHandlers(h.driver);
  notifications.get("item/completed")!({
    threadId: "root-thread",
    item: {
      type: "collabAgentToolCall",
      id: "spawn-child",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "root-thread",
      receiverThreadIds: ["child-thread"],
      agentsStates: { "child-thread": { status: "running" } },
    },
  });
  let settled = false;
  (h.driver as any).turnResolve = () => { settled = true; };
  notifications.get("turn/started")!({ threadId: "child-thread", turn: { id: "child-turn" } });
  notifications.get("turn/completed")!({ threadId: "child-thread", turn: { id: "child-turn", status: "completed" } });
  await nextTask();
  assert.equal((h.driver as any).turnId, "root-turn");
  assert.equal(settled, false);
});

test("an admitted child turn failure updates only that subagent lifecycle", async () => {
  const h = makeHarness();
  (h.driver as any).threadId = "root-thread";
  (h.driver as any).turnId = "root-turn";
  const notifications = notificationHandlers(h.driver);
  notifications.get("item/completed")!({
    threadId: "root-thread",
    item: {
      type: "collabAgentToolCall",
      id: "spawn-child",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "root-thread",
      receiverThreadIds: ["child-thread"],
      agentsStates: { "child-thread": { status: "running" } },
    },
  });
  let settled = false;
  (h.driver as any).turnResolve = () => { settled = true; };
  notifications.get("turn/failed")!({ threadId: "child-thread", error: { message: "child failed" } });
  await nextTask();

  assert.ok(h.events.some((event) => event.kind === "tool_call_update" &&
    event.toolCallId === "spawn-child" && event.subagentLifecycle === "failed"));
  assert.equal((h.driver as any).turnId, "root-turn");
  assert.equal(settled, false);
  assert.equal(h.events.some((event) => event.kind === "error"), false,
    "a child failure does not become the foreground turn error");
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

test("a newer provider request cancels the previous parked approval and keeps unique fallback ids", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });
  const approve = requests.get("item/commandExecution/requestApproval")!;

  const first = approve({ turnId: "turn-fallback", command: "one" });
  const second = approve({ turnId: "turn-fallback", command: "two" });
  assert.deepEqual(await first, { decision: "cancel" });
  assert.deepEqual(
    h.events.filter((event) => event.kind === "permission_request").map((event) => event.requestId),
    ["turn-fallback:1", "turn-fallback:2"],
  );

  assert.equal(h.driver.resolvePermission("turn-fallback:1", "allow"), false);
  assert.equal(h.driver.resolvePermission("turn-fallback:2", "allow"), true);
  assert.deepEqual(await second, { decision: "accept" });
});

test("a repeated provider approval id cancels the replaced parked RPC", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });
  const approve = requests.get("item/commandExecution/requestApproval")!;

  const replaced = approve({ approvalId: "duplicate", command: "old" });
  const current = approve({ approvalId: "duplicate", command: "new" });
  assert.deepEqual(await replaced, { decision: "cancel" });
  assert.equal(h.driver.resolvePermission("duplicate", "allow"), true);
  assert.deepEqual(await current, { decision: "accept" });
});

const cfg = (permissionMode: string, extra: Partial<SessionConfig> = {}): SessionConfig =>
  ({ permissionMode, ...extra }) as SessionConfig;

test("command approvals expose and deliver every stable provider decision", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any, requestId: number | string) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any, requestId: number | string) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });
  const pending = requests.get("item/commandExecution/requestApproval")!({ command: "pnpm test" }, "command-choice");
  const event = h.events.at(-1);
  assert.equal(event?.kind, "permission_request");
  if (event?.kind !== "permission_request") assert.fail("expected a permission request");
  assert.deepEqual(event.options, [
    { optionId: "accept", name: "Allow Once", kind: "allow_once" },
    { optionId: "acceptForSession", name: "Allow for Session", kind: "allow_always" },
    { optionId: "decline", name: "Reject", kind: "reject_once" },
    { optionId: "cancel", name: "Cancel", kind: "cancel" },
  ]);
  assert.equal(h.driver.resolvePermission("command-choice", "acceptForSession"), true);
  assert.deepEqual(await pending, { decision: "acceptForSession" });
});

test("Codex tool user input keeps the provider request id and returns native answers", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any, requestId: number | string) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any, requestId: number | string) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });

  const pending = requests.get("item/tool/requestUserInput")!({
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    isBlocking: true,
    questions: [
      {
        id: "framework",
        header: "Framework",
        question: "Which framework should I use?",
        isOther: true,
        options: [{ label: "React", description: "Use React" }],
      },
      {
        id: "token",
        header: "Token",
        question: "Enter the temporary token",
        isOther: true,
        isSecret: true,
        options: null,
      },
    ],
  }, 701);

  assert.deepEqual(h.events.at(-1), {
    kind: "question_request",
    requestId: "701",
    questions: [
      {
        id: "framework",
        header: "Framework",
        question: "Which framework should I use?",
        options: [{ label: "React", description: "Use React" }],
        allowOther: true,
        inputFormat: "text",
        maxLength: 4000,
      },
      {
        id: "token",
        header: "Token",
        question: "Enter the temporary token",
        options: [],
        allowOther: true,
        inputFormat: "text",
        maxLength: 4000,
        secret: true,
      },
    ],
  });
  assert.equal(h.driver.answerQuestion("provider-item-id", { framework: "React" }), false);
  assert.equal(h.driver.answerQuestion("701", { framework: "React", token: "secret" }), true);
  assert.deepEqual(await pending, {
    answers: {
      framework: { answers: ["React"] },
      token: { answers: ["secret"] },
    },
  });

  const freeText = requests.get("item/tool/requestUserInput")!({
    questions: [{
      id: "details",
      header: "Details",
      question: "Add details",
      isOther: true,
    }],
  }, "free-text-without-options");
  assert.equal(h.driver.answerQuestion("free-text-without-options", { details: "Ready" }), true);
  assert.deepEqual(await freeText, { answers: { details: { answers: ["Ready"] } } });

  const eventCount = h.events.length;
  assert.deepEqual(await requests.get("item/tool/requestUserInput")!({
    questions: [{
      id: "malformed",
      header: "Malformed",
      question: "Missing the schema-required option description",
      isOther: false,
      options: [{ label: "A" }],
    }],
  }, 702), { answers: {} });
  assert.equal(h.events.length, eventCount);

  assert.deepEqual(await requests.get("item/tool/requestUserInput")!({
    questions: [{
      id: "unsupported",
      header: "Features",
      question: "Choose features or add another",
      multiSelect: true,
      isOther: true,
      options: [{ label: "Audit", description: "Audit events" }],
    }],
  }, 703), { answers: {} });
  assert.equal(h.events.length, eventCount);
});

test("MCP form elicitation maps primitive controls and returns provider-native content", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any, requestId: number | string) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any, requestId: number | string) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });

  const pending = requests.get("mcpServer/elicitation/request")!({
    mode: "form",
    serverName: "Deploy MCP",
    threadId: "thread-2",
    turnId: "turn-2",
    message: "Choose deployment settings",
    requestedSchema: {
      type: "object",
      required: ["region", "confirm", "retries", "features"],
      properties: {
        region: { type: "string", title: "Region", enum: ["iad", "fra"], enumNames: ["US East", "Europe"] },
        confirm: { type: "boolean", title: "Confirm" },
        retries: { type: "integer", title: "Retries", minimum: 1, maximum: 5 },
        features: { type: "array", title: "Features", items: { anyOf: [{ const: "audit", title: "Audit Trail" }, { const: "alerts", title: "Alerts" }] }, minItems: 1, maxItems: 2 },
        note: { type: "string", title: "Note", maxLength: 120 },
      },
    },
  }, "mcp-form-9");

  const event = h.events.at(-1);
  assert.equal(event?.kind, "question_request");
  if (event?.kind !== "question_request") assert.fail("expected a structured question request");
  assert.equal(event.requestId, "mcp-form-9");
  assert.equal(event.questions[0]?.context, "Deploy MCP: Choose deployment settings");
  assert.deepEqual(event.questions.map((question) => ({
    id: question.id,
    options: question.options.map((option) => option.label),
    required: question.required,
    multiSelect: question.multiSelect,
    inputFormat: question.inputFormat,
  })), [
    { id: "region", options: ["US East", "Europe"], required: true, multiSelect: undefined, inputFormat: undefined },
    { id: "confirm", options: ["True", "False"], required: true, multiSelect: undefined, inputFormat: undefined },
    { id: "retries", options: [], required: true, multiSelect: undefined, inputFormat: "integer" },
    { id: "features", options: ["Audit Trail", "Alerts"], required: true, multiSelect: true, inputFormat: undefined },
    { id: "note", options: [], required: false, multiSelect: undefined, inputFormat: "text" },
  ]);

  assert.equal(h.driver.answerQuestion("mcp-form-9", {
    region: "US East",
    confirm: "True",
    retries: "3",
    features: ["Audit Trail", "Alerts"],
  }), true);
  assert.deepEqual(await pending, {
    action: "accept",
    content: { region: "iad", confirm: true, retries: 3, features: ["audit", "alerts"] },
    _meta: null,
  });
});

test("MCP all-optional forms distinguish accepting empty content from dismissal", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any, requestId: number | string) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any, requestId: number | string) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });
  const params = {
    mode: "form",
    serverName: "Optional MCP",
    threadId: "thread-optional",
    turnId: "turn-optional",
    message: "Optional settings",
    requestedSchema: {
      type: "object",
      properties: { note: { type: "string", title: "Note" } },
    },
  };

  const submitted = requests.get("mcpServer/elicitation/request")!(params, "mcp-empty-submit");
  assert.equal(h.driver.answerQuestion("mcp-empty-submit", {}, "submit"), true);
  assert.deepEqual(await submitted, { action: "accept", content: {}, _meta: null });

  const dismissed = requests.get("mcpServer/elicitation/request")!(params, "mcp-empty-dismiss");
  assert.equal(h.driver.answerQuestion("mcp-empty-dismiss", {}, "dismiss"), true);
  assert.deepEqual(await dismissed, { action: "cancel", content: null, _meta: null });
});

test("MCP required multi-select fields honor an explicit zero-item constraint", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any, requestId: number | string) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any, requestId: number | string) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });

  const pending = requests.get("mcpServer/elicitation/request")!({
    mode: "form",
    serverName: "Tags MCP",
    message: "Choose no tags",
    requestedSchema: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string", enum: ["A"] }, minItems: 0, maxItems: 0 },
      },
      required: ["tags"],
    },
  }, "mcp-zero-items");
  assert.equal(h.driver.answerQuestion("mcp-zero-items", { tags: [] }, "submit"), true);
  assert.deepEqual(await pending, { action: "accept", content: { tags: [] }, _meta: null });
});

test("MCP URL elicitation exposes Accept, Decline, and Cancel and uses the selected native action", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any, requestId: number | string) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any, requestId: number | string) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });

  const pending = requests.get("mcpServer/elicitation/request")!({
    mode: "url",
    serverName: "Payments MCP",
    threadId: "thread-3",
    message: "Authorize access in your browser",
    url: "https://example.test/authorize",
    elicitationId: "provider-elicitation",
  }, "mcp-url-5");
  assert.deepEqual(h.events.at(-1), {
    kind: "permission_request",
    requestId: "mcp-url-5",
    title: "Payments MCP requests a browser flow",
    options: [
      { optionId: "accept", name: "Accept", kind: "allow_once" },
      { optionId: "decline", name: "Decline", kind: "reject_once" },
      { optionId: "cancel", name: "Cancel", kind: "cancel" },
    ],
    context: {
      toolName: "Payments MCP",
      input: "Authorize access in your browser",
      network: "https://example.test/authorize",
    },
  });
  assert.equal(h.driver.resolvePermission("mcp-url-5", "decline"), true);
  assert.deepEqual(await pending, { action: "decline", content: null, _meta: null });
});

test("unsupported MCP modes cancel safely and provider resolution clears a parked question", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any, requestId: number | string) => Promise<any>>();
  const notifications = new Map<string, (params: any) => void>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any, requestId: number | string) => Promise<any>) => requests.set(method, handler),
    onNotification: (method: string, handler: (params: any) => void) => notifications.set(method, handler),
  });

  const parkedApproval = requests.get("item/commandExecution/requestApproval")!({ command: "pnpm test" }, "still-live");
  const eventsBeforeUnsupported = h.events.length;
  assert.deepEqual(await requests.get("mcpServer/elicitation/request")!({
    mode: "openai/form",
    serverName: "Unsupported MCP",
    message: "Extended schema",
    requestedSchema: { type: "object", properties: { value: { type: "string" } } },
  }, 800), { action: "cancel", content: null, _meta: null });
  assert.equal(h.events.length, eventsBeforeUnsupported, "invalid elicitation must not displace the parked approval");
  assert.equal(h.driver.resolvePermission("still-live", "accept"), true);
  assert.deepEqual(await parkedApproval, { decision: "accept" });

  const eventsBeforeMalformedEnum = h.events.length;
  assert.deepEqual(await requests.get("mcpServer/elicitation/request")!({
    mode: "form",
    serverName: "Oversized MCP",
    message: "Choose a region",
    requestedSchema: {
      type: "object",
      properties: { region: { type: "string", enum: Array.from({ length: 21 }, (_, index) => `region-${index}`) } },
      required: ["region"],
    },
  }, "malformed-enum"), { action: "cancel", content: null, _meta: null });
  assert.equal(h.events.length, eventsBeforeMalformedEnum, "malformed enum must not emit an unconstrained question");

  assert.deepEqual(await requests.get("mcpServer/elicitation/request")!({
    mode: "form",
    serverName: "Malformed MCP",
    message: "Invalid constraints",
    requestedSchema: {
      type: "object",
      properties: { retries: { type: "integer", minimum: "zero" } },
      required: ["retries"],
    },
  }, "malformed-constraints"), { action: "cancel", content: null, _meta: null });

  const pending = requests.get("item/tool/requestUserInput")!({
    questions: [{ id: "choice", header: "Choice", question: "Choose", isOther: false, options: [{ label: "A", description: "A" }] }],
  }, 801);
  notifications.get("serverRequest/resolved")!({ threadId: "thread-4", requestId: 801 });
  assert.deepEqual(await pending, { answers: {} });
  assert.equal(h.driver.answerQuestion("801", { choice: "A" }), false);
  assert.deepEqual(h.events.at(-1), {
    kind: "question_resolved",
    requestId: "801",
    answered: false,
    resolutionReason: "provider_resolved",
  });
});

test("a newer structured request settles and resolves the displaced request exactly once", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any, requestId: number | string) => Promise<any>>();
  const notifications = new Map<string, (params: any) => void>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any, requestId: number | string) => Promise<any>) => requests.set(method, handler),
    onNotification: (method: string, handler: (params: any) => void) => notifications.set(method, handler),
  });

  const oldQuestion = requests.get("item/tool/requestUserInput")!({
    questions: [{ id: "choice", header: "Choice", question: "Choose", isOther: false, options: [{ label: "A", description: "A" }] }],
  }, "old-question");
  const replacementApproval = requests.get("item/commandExecution/requestApproval")!({ command: "pnpm test" }, "replacement-approval");
  assert.deepEqual(await oldQuestion, { answers: {} });
  assert.deepEqual(h.events.filter((event) => event.kind === "question_resolved"), [{
    kind: "question_resolved",
    requestId: "old-question",
    answered: false,
    resolutionReason: "replaced",
  }]);

  const replacementQuestion = requests.get("item/tool/requestUserInput")!({
    questions: [{ id: "confirm", header: "Confirm", question: "Continue?", isOther: false, options: [{ label: "Yes", description: "Continue" }] }],
  }, "replacement-question");
  assert.deepEqual(await replacementApproval, { decision: "cancel" });
  assert.deepEqual(h.events.filter((event) => event.kind === "permission_resolved"), [{
    kind: "permission_resolved",
    requestId: "replacement-approval",
    optionId: null,
    resolutionReason: "replaced",
  }]);

  const resolutionCount = h.events.filter(
    (event) => event.kind === "question_resolved" || event.kind === "permission_resolved",
  ).length;
  notifications.get("serverRequest/resolved")!({ requestId: "old-question" });
  notifications.get("serverRequest/resolved")!({ requestId: "replacement-approval" });
  assert.equal(h.events.filter(
    (event) => event.kind === "question_resolved" || event.kind === "permission_resolved",
  ).length, resolutionCount, "late provider notifications must not duplicate replacement events");

  assert.equal(h.driver.answerQuestion("replacement-question", { confirm: "Yes" }, "submit"), true);
  assert.deepEqual(await replacementQuestion, { answers: { confirm: { answers: ["Yes"] } } });
});

test("re-entrant cancellation while resolving a replacement cannot strand the new provider request", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any, requestId: number | string) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any, requestId: number | string) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });
  const approve = requests.get("item/commandExecution/requestApproval")!;
  const first = approve({ command: "first" }, "first-approval");
  const originalOnEvent = (h.driver as any).cb.onEvent;
  (h.driver as any).cb.onEvent = (event: SessionEventPayload) => {
    originalOnEvent(event);
    if (event.kind === "permission_resolved") h.driver.cancel();
  };

  const second = approve({ command: "second" }, "second-approval");
  assert.deepEqual(await first, { decision: "cancel" });
  assert.deepEqual(await Promise.race([
    second,
    new Promise((resolve) => setImmediate(() => resolve("still-pending"))),
  ]), { decision: "cancel" });
  assert.equal((h.driver as any).pendingApprovals.size, 0);
});

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

test("streamed Codex response emits one content-free completion at successful turn settlement", async () => {
  const h = makeHarness();
  const notifications = notificationHandlers(h.driver);
  const reason = new Promise<string>((resolve) => { (h.driver as any).turnResolve = resolve; });
  notifications.get("item/agentMessage/delta")!({ itemId: "m-streamed", delta: "answer" });
  h.onItem({ type: "agentMessage", id: "m-streamed", text: "answer" }, true);
  assert.deepEqual(h.events, [
    { kind: "agent_message", text: "answer", messageId: "m-streamed" },
  ], "chunks remain the only transcript content before turn completion");

  notifications.get("turn/completed")!({ turn: { status: "completed" } });
  assert.equal(await reason, "end_turn");
  assert.deepEqual(h.events, [
    { kind: "agent_message", text: "answer", messageId: "m-streamed" },
    { kind: "agent_response_completed" },
  ]);

  notifications.get("turn/completed")!({ turn: { status: "completed" } });
  assert.equal(
    h.events.filter((event) => event.kind === "agent_response_completed").length,
    1,
    "duplicate or replayed terminal evidence cannot emit a second marker",
  );
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

test("provider-controlled diagnostics are bounded before reaching stderr", async () => {
  const h = makeHarness();
  const requests = new Map<string, (params: any, requestId: number | string) => Promise<any>>();
  (h.driver as any).registerHandlers({
    onRequest: (method: string, handler: (params: any, requestId: number | string) => Promise<any>) => requests.set(method, handler),
    onNotification: () => {},
  });

  const parkedApproval = requests.get("item/commandExecution/requestApproval")!({ command: "pnpm test" }, "parked");
  const eventsBeforeOversizedMode = h.events.length;
  assert.deepEqual(await requests.get("mcpServer/elicitation/request")!({
    mode: "z".repeat(50_000),
    serverName: "Oversized MCP",
    threadId: "thread-diagnostic",
    message: "Extended schema",
    requestedSchema: { type: "object", properties: { value: { type: "string" } } },
  }, "oversized-mode"), { action: "cancel", content: null, _meta: null });
  const oversized = h.stderr.at(-1)!;
  assert.match(oversized, /unsupported or malformed Codex MCP elicitation mode=z+…/);
  assert.ok(oversized.length < 200, `diagnostic must stay bounded, got ${oversized.length} characters`);
  assert.equal(h.events.length, eventsBeforeOversizedMode, "a malformed elicitation must not displace the parked approval");

  // A non-primitive mode is never stringified in full: the provider controls its size.
  assert.deepEqual(await requests.get("mcpServer/elicitation/request")!({
    mode: { nested: "x".repeat(50_000) },
    serverName: "Structured MCP",
    threadId: "thread-diagnostic",
    message: "Extended schema",
  }, "object-mode"), { action: "cancel", content: null, _meta: null });
  assert.equal(h.stderr.at(-1), "unsupported or malformed Codex MCP elicitation mode=[object] — cancelling it");

  assert.equal(h.driver.resolvePermission("parked", "accept"), true);
  assert.deepEqual(await parkedApproval, { decision: "accept" });
});

test("diagnosticValue bounds every provider-controlled shape", () => {
  assert.equal(diagnosticValue(undefined), "?");
  assert.equal(diagnosticValue(null), "?");
  assert.equal(diagnosticValue("form"), "form");
  assert.equal(diagnosticValue(7), "7");
  assert.equal(diagnosticValue(["a".repeat(50_000)]), "[object]");
  assert.equal(diagnosticValue("a".repeat(500)), `${"a".repeat(120)}…`);
});

test("usage carries the configured model and app-server's context window becomes the provider gauge", () => {
  const h = makeHarness({ config: { model: "gpt-5.5-codex" } as DriverOptions["config"] });
  const gauges: Array<{ contextTokensUsed: number; contextWindow: number }> = [];
  (h.driver as any).cb.onAcpUsage = (usage: { contextTokensUsed: number; contextWindow: number }) => gauges.push(usage);
  const notifications = new Map<string, (params: any) => void>();
  (h.driver as any).registerHandlers({
    onRequest: () => {},
    onNotification: (method: string, handler: (params: any) => void) => notifications.set(method, handler),
  });
  (h.driver as any).eventContext = () => ({ accepted: true });
  notifications.get("thread/tokenUsage/updated")!({
    threadId: "t1",
    tokenUsage: { last: { inputTokens: 11_000, outputTokens: 600, cachedInputTokens: 9_000, reasoningOutputTokens: 200 }, modelContextWindow: 258_400 },
  });
  assert.deepEqual(gauges, [{ contextTokensUsed: 11_600, contextWindow: 258_400 }], "the last request plus its output is what sits in the window");
  (h.driver as any).emitPendingTurnUsage();
  assert.deepEqual(h.events, [{
    kind: "token_usage", inputTokens: 11_000, outputTokens: 600, cachedInputTokens: 9_000, reasoningOutputTokens: 200, model: "gpt-5.5-codex",
  }]);

  const unpinned = makeHarness({ config: { model: "default" } as DriverOptions["config"] });
  (unpinned.driver as any).pendingTurnUsage = { input: 1, output: 1 };
  (unpinned.driver as any).emitPendingTurnUsage();
  assert.equal("model" in unpinned.events[0]!, false, "an unpinned model is not guessed");
});
