import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AgentDriverKind, RunnerToControlPlane, SessionConfig, SessionLaunchSpec } from "@wollipog/protocol";
import type { Driver, DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import { ClaudeCodeDriver } from "./drivers/claude-code.js";
import { CodexAppServerResumeError } from "./drivers/codex-app-server.js";
import { setGitRunnerForTests } from "./git-ops.js";
import {
  SessionManager,
  type DurableCommandLifecycle,
  type SessionLaunchPreparation,
} from "./session-manager.js";
import {
  DELETED_SESSION_MARKER_RETENTION_MS,
  SessionStore,
  type SessionMeta,
} from "./session-store.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const shortDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
const ACP_LIFECYCLE = {
  logout: true,
  loadSession: true,
  sessionList: true,
  sessionDelete: false,
  sessionResume: true,
  sessionClose: true,
};

function fakeClaudeProcess() {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 123;
  child.kill = () => true;
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  return child;
}

function stored(root: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "resume-session",
    agentId: "codex-native",
    workspaceId: "workspace",
    repoPath: root,
    worktreePath: null,
    driver: "codex-app-server",
    command: "codex",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: "thread-persisted",
    status: "idle",
    title: "resume",
    config: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function launchSpec(root: string): SessionLaunchSpec {
  return {
    sessionId: "resume-session",
    agentId: "codex-native",
    workspaceId: "workspace",
    workspacePath: root,
    driver: "codex-app-server",
    command: "codex",
    args: [],
    env: {},
    context: { kind: "native" },
    useWorktree: false,
  };
}

function harness(
  metaOverrides: Partial<SessionMeta> = {},
  initializeGate: Promise<void> | ((launchIndex: number) => Promise<void>) = Promise.resolve(),
  closeGate: Promise<void> = Promise.resolve(),
  setConfig: (config: SessionConfig) => void | Promise<void> = () => {},
  prepareLaunch?: (
    meta: SessionMeta,
  ) => void | SessionLaunchPreparation | Promise<void | SessionLaunchPreparation>,
  steer?: Driver["steer"],
  maxConcurrentSessions = 4,
  promptTurn?: (text: string) => void | Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-resume-"));
  const store = new SessionStore(root);
  store.create(stored(root, metaOverrides));
  const sent: RunnerToControlPlane[] = [];
  const launches: Array<{ kind: AgentDriverKind; options: DriverOptions }> = [];
  const prompts: string[] = [];
  const disposals: Array<Parameters<Driver["dispose"]>[0]> = [];
  let cancelCalls = 0;
  let closes = 0;
  const authStatuses: Array<[
    string,
    { status?: "authenticated" | "unauthenticated"; capabilities?: Record<string, boolean> },
  ]> = [];
  let latestCallbacks: DriverCallbacks | null = null;
  const factory = (kind: AgentDriverKind, options: DriverOptions, callbacks: DriverCallbacks): Driver => {
    const launchIndex = launches.length;
    launches.push({ kind, options });
    latestCallbacks = callbacks;
    let id = options.resumeId ?? "thread-new";
    const gate = typeof initializeGate === "function" ? initializeGate(launchIndex) : initializeGate;
    const preparedCommands = new WeakSet<object>();
    return {
      get pid() { return undefined; },
      initialize: async () => {
        await gate;
        if (kind === "acp") callbacks.onAcpCapabilities?.(ACP_LIFECYCLE);
      },
      newSession: async () => id,
      agentSessionId: () => id,
      prompt: async (text) => {
        prompts.push(text);
        await promptTurn?.(text);
        if (options.initialBackgroundTaskIds?.length || /consume queued background-task/i.test(text)) {
          callbacks.onBackgroundWork?.({ state: null, pendingTaskIds: [] });
        }
        return "end_turn";
      },
      prepareCommand: (input) => {
        const prepared = {
          commandName: input.commandName,
          argumentText: input.argumentText,
          executionMode: "passthrough" as const,
        } as ReturnType<NonNullable<Driver["prepareCommand"]>>;
        preparedCommands.add(prepared);
        return prepared;
      },
      invokeCommand: async (prepared) => {
        assert.equal(preparedCommands.delete(prepared), true);
        return "end_turn";
      },
      setConfig,
      cancel: () => { cancelCalls += 1; },
      resolvePermission: () => false,
      ...(steer ? { steer } : {}),
      ...(kind === "acp" ? { close: async () => { closes += 1; await closeGate; return true; } } : {}),
      dispose: (options) => { disposals.push(options); },
    };
  };
  const manager = new SessionManager(
    (message) => sent.push(message),
    () => {},
    store,
    "runner",
    undefined,
    factory,
    undefined,
    maxConcurrentSessions,
    (agentId, update) => authStatuses.push([agentId, update]),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    prepareLaunch,
  );
  return {
    root,
    store,
    sent,
    launches,
    prompts,
    disposals,
    cancelCalls: () => cancelCalls,
    closes: () => closes,
    authStatuses,
    manager,
    factory,
    callbacks: () => latestCallbacks!,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("provider auth failure stops the turn, parks exact recovery context, and holds FIFO until explicit retry", async () => {
  let h!: ReturnType<typeof harness>;
  let attempts = 0;
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "auth-blocked-command",
    queued: () => {}, started: () => {}, completed: () => {}, uncertain: () => {},
    failed: (error, code) => failures.push([error, code]),
  };
  h = harness({
    driver: "claude-code",
    agentId: "claude-native",
    command: "claude",
    context: { kind: "wsl", distro: "Ubuntu" },
    agentSessionId: "claude-session",
  }, Promise.resolve(), Promise.resolve(), () => {}, undefined, undefined, 4, async () => {
    attempts += 1;
    if (attempts === 1) {
      h.manager.prompt("resume-session", "queued before sign-in");
      h.callbacks().onAuthenticationFailure?.();
    }
  });
  try {
    h.manager.prompt("resume-session", "first attempt", [], undefined, undefined, durable);
    await tick();
    await tick();

    const blocked = h.store.readMeta("resume-session")!;
    assert.equal(h.cancelCalls(), 1, "the provider retry loop is cancelled immediately");
    assert.equal(blocked.status, "input_required");
    assert.equal(blocked.pendingApproval?.kind, "authentication");
    assert.deepEqual(blocked.pendingApproval?.options, []);
    assert.equal(blocked.pendingApproval?.title, "Authentication Required — Claude Code");
    assert.match(blocked.pendingApproval?.context?.input ?? "", /Provider: Claude Code/);
    assert.match(blocked.pendingApproval?.context?.input ?? "", /Machine: WSL distribution Ubuntu/);
    assert.match(blocked.pendingApproval?.context?.input ?? "", /Location:/);
    assert.match(blocked.pendingApproval?.context?.input ?? "", /Run `claude`/);
    assert.deepEqual(h.prompts, ["first attempt"], "known-unsubmitted FIFO work remains held");
    assert.deepEqual(h.authStatuses, [["claude-native", { status: "unauthenticated" }]]);
    assert.deepEqual(failures, [["provider authentication is required", "PROVIDER_AUTHENTICATION_REQUIRED"]]);

    h.manager.prompt("resume-session", "explicit retry after sign-in");
    await tick();
    await tick();
    assert.deepEqual(h.prompts, ["first attempt", "queued before sign-in", "explicit retry after sign-in"]);
    assert.equal(h.store.readMeta("resume-session")?.status, "idle");
    assert.equal(h.store.readMeta("resume-session")?.pendingApproval, null);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("resume refreshes and persists runner-local launch material before spawning", async () => {
  let prepared = 0;
  const h = harness({}, Promise.resolve(), Promise.resolve(), () => {}, (meta) => {
    prepared++;
    meta.args = [...meta.args, "--credential-refreshed"];
  });
  try {
    h.manager.prompt("resume-session", "continue", []);
    await tick();
    await tick();
    assert.equal(prepared, 1);
    assert.ok(h.launches[0]?.options.args.includes("--credential-refreshed"));
    assert.ok(h.store.readMeta("resume-session")?.args.includes("--credential-refreshed"));
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("resume authorizes only a freshly discovered live session command catalog", async () => {
  const prepared = deferred<void>();
  const h = harness({
    driver: "claude-code",
    agentId: "claude-native",
    command: "claude",
  }, Promise.resolve(), Promise.resolve(), () => {}, async (meta) => {
    await prepared.promise;
    meta.sessionSlashCommands = [{ name: "deploy", source: "project", argumentHint: "<environment>" }];
    return {
      sessionCommandCatalogFresh: true,
      sessionCommandCatalogProvenance: "native:project-root",
    };
  });
  try {
    h.manager.prompt("resume-session", "continue", []);
    await tick();
    assert.equal(h.launches.length, 0, "provider spawn waits for the session-root discovery result");
    prepared.resolve();
    await tick();
    await tick();
    assert.deepEqual(h.store.readMeta("resume-session")?.sessionSlashCommands, [
      { name: "deploy", source: "project", argumentHint: "<environment>" },
    ]);
    const runtime = h.sent.findLast((message) => message.type === "session_runtime_updated");
    const command = runtime?.snapshot.agentCapabilities?.slashCommands?.[0];
    assert.deepEqual({
      name: command?.name,
      source: command?.source,
      argumentHint: command?.argumentHint,
    }, { name: "deploy", source: "project", argumentHint: "<environment>" });
    assert.match(command?.invocation?.id ?? "", /^command_[0-9a-f-]{36}$/);
    assert.match(command?.invocation?.catalogRevision ?? "", /^catalog_[0-9a-f-]{36}$/);
    assert.equal(command?.invocation?.executionMode, "passthrough");
    assert.equal(h.launches.length, 1);
  } finally {
    h.cleanup();
  }
});

test("Restart superseding deferred resume preparation keeps the replacement admission and lock", async () => {
  const entered = [deferred<void>(), deferred<void>()];
  const gates = [deferred<void>(), deferred<void>()];
  let preparations = 0;
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "stale-resume",
    queued: () => {},
    started: () => {},
    completed: () => {},
    failed: (error, code) => failures.push([error, code]),
    uncertain: () => {},
  };
  const h = harness({}, Promise.resolve(), Promise.resolve(), () => {}, async () => {
    const index = preparations++;
    entered[index]?.resolve();
    await gates[index]?.promise;
  });
  try {
    assert.equal(h.manager.prompt("resume-session", "stale continuation", [], undefined, undefined, durable), true);
    await entered[0]!.promise;

    const restart = h.manager.start(launchSpec(h.root));
    await entered[1]!.promise;
    assert.deepEqual([...(h.manager as any).admitted], ["resume-session"]);

    gates[0]!.resolve();
    await tick();
    await tick();

    assert.deepEqual(
      [...(h.manager as any).admitted],
      ["resume-session"],
      "the stale resume cannot release the replacement-owned admission",
    );
    assert.equal(
      h.store.acquireLock("resume-session", "third-runner"),
      false,
      "the stale resume cannot release the replacement-owned same-owner lock",
    );
    assert.equal(h.launches.length, 0, "both generations are still before driver construction");
    assert.deepEqual(h.disposals, [], "the stale resume has no replacement cleanup authority");
    assert.deepEqual(failures, [["session resume was superseded by a replacement", "COMMAND_CANCELLED"]]);
    assert.equal(
      h.sent.some((message) => message.type === "session_event" && message.payload.kind === "error"),
      false,
      "the superseded resume does not publish a stale launch error",
    );

    gates[1]!.resolve();
    assert.equal(await restart, true);
  } finally {
    gates[0]!.resolve();
    gates[1]!.resolve();
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a finished replacement epoch protects its active turn from stale resume cleanup", async () => {
  const staleEntered = deferred<void>();
  const staleGate = deferred<void>();
  const replacementTurn = deferred<void>();
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "stale-after-finished-replacement",
    queued: () => {}, started: () => {}, completed: () => {}, uncertain: () => {},
    failed: (error, code) => failures.push([error, code]),
  };
  let preparations = 0;
  const h = harness(
    {},
    Promise.resolve(),
    Promise.resolve(),
    () => {},
    async () => {
      if (preparations++ !== 0) return;
      staleEntered.resolve();
      await staleGate.promise;
    },
    undefined,
    4,
    async () => replacementTurn.promise,
  );
  try {
    assert.equal(
      h.manager.prompt("resume-session", "stale continuation", [], undefined, undefined, durable),
      true,
    );
    await staleEntered.promise;

    assert.equal(await h.manager.start(launchSpec(h.root), "replacement turn"), true);
    await tick();
    assert.equal(
      (h.manager as any).launchGenerations.has("resume-session"),
      false,
      "the replacement has already finished its launch generation",
    );
    assert.deepEqual([...(h.manager as any).admitted], ["resume-session"]);

    staleGate.resolve();
    await tick();
    await tick();

    assert.deepEqual(
      failures,
      [["session resume was superseded by a replacement", "COMMAND_CANCELLED"]],
    );
    assert.deepEqual([...(h.manager as any).admitted], ["resume-session"]);
    assert.equal(
      h.store.acquireLock("resume-session", "third-runner"),
      false,
      "the persistent replacement epoch prevents stale same-owner lock release",
    );
    assert.equal((h.manager as any).active.has("resume-session"), true);
    assert.deepEqual(h.disposals, []);

    replacementTurn.resolve();
    await tick();
    await tick();
  } finally {
    staleGate.resolve();
    replacementTurn.resolve();
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("cancelling resume during deferred launch preparation releases its lock", async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "cancelled-prepared-resume",
    queued: () => {}, started: () => {}, completed: () => {}, uncertain: () => {},
    failed: (error, code) => failures.push([error, code]),
  };
  const h = harness({}, Promise.resolve(), Promise.resolve(), () => {}, async () => {
    entered.resolve();
    await gate.promise;
  });
  try {
    assert.equal(
      h.manager.prompt("resume-session", "cancel during preparation", [], undefined, undefined, durable),
      true,
    );
    await entered.promise;
    h.manager.cancel("resume-session");
    gate.resolve();
    await tick();
    await tick();

    assert.deepEqual(
      failures,
      [["session resume was cancelled before provider startup", "COMMAND_CANCELLED"]],
    );
    assert.equal((h.manager as any).admitted.size, 0);
    assert.equal(h.launches.length, 0);
    assert.equal(h.store.acquireLock("resume-session", "third-runner"), true);
    h.store.releaseLock("resume-session", "third-runner");
  } finally {
    gate.resolve();
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("cancelling Restart during deferred launch preparation releases its lock", async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "cancelled-prepared-restart",
    queued: () => {}, started: () => {}, completed: () => {}, uncertain: () => {},
    failed: (error, code) => failures.push([error, code]),
  };
  const h = harness({}, Promise.resolve(), Promise.resolve(), () => {}, async () => {
    entered.resolve();
    await gate.promise;
  });
  try {
    const restart = h.manager.start(launchSpec(h.root), undefined, undefined, durable);
    await entered.promise;
    h.manager.cancel("resume-session");
    gate.resolve();
    assert.equal(await restart, false);

    assert.deepEqual(
      failures,
      [["session launch was cancelled before provider startup", "COMMAND_CANCELLED"]],
    );
    assert.equal((h.manager as any).admitted.size, 0);
    assert.equal(h.launches.length, 0);
    assert.equal(h.store.acquireLock("resume-session", "third-runner"), true);
    h.store.releaseLock("resume-session", "third-runner");
  } finally {
    gate.resolve();
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("Restart superseding a capacity-queued resume keeps the replacement admission wait and lock", async () => {
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "capacity-queued-resume",
    queued: () => {},
    started: () => {},
    completed: () => {},
    failed: (error, code) => failures.push([error, code]),
    uncertain: () => {},
  };
  const h = harness({}, Promise.resolve(), Promise.resolve(), () => {}, undefined, undefined, 1);
  const internals = h.manager as any;
  try {
    h.store.create(stored(h.root, {
      sessionId: "capacity-blocker",
      agentSessionId: null,
      status: "running",
    }));
    assert.equal(await internals.acquireAdmission("capacity-blocker"), true);

    assert.equal(
      h.manager.prompt("resume-session", "stale queued continuation", [], undefined, undefined, durable),
      true,
    );
    await tick();
    assert.deepEqual(
      internals.admissionQueue.map((entry: { request: { sessionId: string } }) => entry.request.sessionId),
      ["resume-session"],
    );

    const restart = h.manager.start(launchSpec(h.root));
    await tick();
    await tick();

    assert.deepEqual(
      internals.admissionQueue.map((entry: { request: { sessionId: string } }) => entry.request.sessionId),
      ["resume-session"],
      "the replacement's capacity waiter survives the stale continuation",
    );
    assert.deepEqual([...internals.admitted], ["capacity-blocker"]);
    assert.equal(
      h.store.acquireLock("resume-session", "third-runner"),
      false,
      "the stale admission cancellation cannot release the replacement-owned same-owner lock",
    );
    assert.deepEqual(failures, [["session resume was superseded by a replacement", "COMMAND_CANCELLED"]]);
    assert.equal(h.launches.length, 0);
    assert.deepEqual(h.disposals, []);
    assert.equal(
      h.sent.some((message) => message.type === "session_event" && message.payload.kind === "error"),
      false,
      "the stale admission cancellation does not publish a launch error",
    );

    internals.releaseAdmission("capacity-blocker");
    assert.equal(await restart, true);
    assert.deepEqual([...internals.admitted], ["resume-session"]);
  } finally {
    internals.releaseAdmission("capacity-blocker");
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("cancelling a capacity-queued resume releases its lock and terminalizes its receipt", async () => {
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "cancelled-capacity-resume",
    queued: () => {}, started: () => {}, completed: () => {}, uncertain: () => {},
    failed: (error, code) => failures.push([error, code]),
  };
  const h = harness({}, Promise.resolve(), Promise.resolve(), () => {}, undefined, undefined, 1);
  const internals = h.manager as any;
  try {
    h.store.create(stored(h.root, {
      sessionId: "capacity-blocker", agentSessionId: null, status: "running",
    }));
    assert.equal(await internals.acquireAdmission("capacity-blocker"), true);
    assert.equal(
      h.manager.prompt("resume-session", "cancel while queued", [], undefined, undefined, durable),
      true,
    );
    await tick();
    assert.deepEqual(
      internals.admissionQueue.map((entry: { request: { sessionId: string } }) => entry.request.sessionId),
      ["resume-session"],
    );

    h.manager.cancel("resume-session");
    await tick();
    await tick();

    assert.deepEqual(
      failures,
      [["session resume was cancelled before runner admission", "COMMAND_CANCELLED"]],
    );
    assert.deepEqual([...internals.admitted], ["capacity-blocker"]);
    assert.equal(h.store.acquireLock("resume-session", "third-runner"), true);
    h.store.releaseLock("resume-session", "third-runner");
  } finally {
    internals.releaseAdmission("capacity-blocker");
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("cancelling an immediately admitted resume releases its pre-provider lock", async () => {
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "cancelled-admitted-resume",
    queued: () => {}, started: () => {}, completed: () => {}, uncertain: () => {},
    failed: (error, code) => failures.push([error, code]),
  };
  const h = harness();
  try {
    assert.equal(
      h.manager.prompt("resume-session", "cancel before provider", [], undefined, undefined, durable),
      true,
    );
    h.manager.cancel("resume-session");
    await tick();
    await tick();

    assert.deepEqual(
      failures,
      [["session resume was cancelled before provider startup", "COMMAND_CANCELLED"]],
    );
    assert.equal((h.manager as any).admitted.size, 0);
    assert.equal(h.launches.length, 0);
    assert.equal(h.store.acquireLock("resume-session", "third-runner"), true);
    h.store.releaseLock("resume-session", "third-runner");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a capacity-queued app-server Restart transfers its lock to a superseding Restart", async () => {
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "superseded-restart",
    queued: () => {},
    started: () => {},
    completed: () => {},
    failed: (error, code) => failures.push([error, code]),
    uncertain: () => {},
  };
  const h = harness({}, Promise.resolve(), Promise.resolve(), () => {}, undefined, undefined, 1);
  const internals = h.manager as any;
  try {
    h.store.create(stored(h.root, {
      sessionId: "capacity-blocker",
      agentSessionId: null,
      status: "running",
    }));
    assert.equal(await internals.acquireAdmission("capacity-blocker"), true);

    const staleRestart = h.manager.start(launchSpec(h.root), undefined, undefined, durable);
    await tick();
    assert.deepEqual(
      internals.admissionQueue.map((entry: { request: { sessionId: string } }) => entry.request.sessionId),
      ["resume-session"],
    );

    const replacement = h.manager.start(launchSpec(h.root));
    await tick();
    await tick();

    assert.equal(await staleRestart, false);
    assert.deepEqual(
      failures,
      [["session launch was superseded by a replacement", "COMMAND_CANCELLED"]],
    );
    assert.deepEqual(
      internals.admissionQueue.map((entry: { request: { sessionId: string } }) => entry.request.sessionId),
      ["resume-session"],
    );
    assert.equal(
      h.store.acquireLock("resume-session", "third-runner"),
      false,
      "the superseded Restart transfers its same-owner lock to the replacement",
    );

    internals.releaseAdmission("capacity-blocker");
    assert.equal(await replacement, true);
    assert.deepEqual([...internals.admitted], ["resume-session"]);
  } finally {
    internals.releaseAdmission("capacity-blocker");
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("cancelling a capacity-queued app-server Restart releases its resumable-thread lock", async () => {
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "cancelled-restart",
    queued: () => {},
    started: () => {},
    completed: () => {},
    failed: (error, code) => failures.push([error, code]),
    uncertain: () => {},
  };
  const h = harness({}, Promise.resolve(), Promise.resolve(), () => {}, undefined, undefined, 1);
  const internals = h.manager as any;
  try {
    h.store.create(stored(h.root, {
      sessionId: "capacity-blocker",
      agentSessionId: null,
      status: "running",
    }));
    assert.equal(await internals.acquireAdmission("capacity-blocker"), true);

    const restart = h.manager.start(launchSpec(h.root), undefined, undefined, durable);
    await tick();
    assert.deepEqual(
      internals.admissionQueue.map((entry: { request: { sessionId: string } }) => entry.request.sessionId),
      ["resume-session"],
    );

    h.manager.cancel("resume-session");
    assert.equal(await restart, false);
    assert.deepEqual(
      failures,
      [["session launch was cancelled before runner admission", "COMMAND_CANCELLED"]],
    );
    assert.deepEqual([...internals.admitted], ["capacity-blocker"]);
    assert.equal(
      h.store.acquireLock("resume-session", "third-runner"),
      true,
      "cancellation without a replacement releases the queued Restart's lock",
    );
    h.store.releaseLock("resume-session", "third-runner");
  } finally {
    internals.releaseAdmission("capacity-blocker");
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("cancelling an immediately admitted app-server Restart releases its pre-provider lock", async () => {
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "cancelled-admitted-restart",
    queued: () => {}, started: () => {}, completed: () => {}, uncertain: () => {},
    failed: (error, code) => failures.push([error, code]),
  };
  const h = harness();
  try {
    const restart = h.manager.start(launchSpec(h.root), undefined, undefined, durable);
    h.manager.cancel("resume-session");
    assert.equal(await restart, false);

    assert.deepEqual(
      failures,
      [["session launch was cancelled before provider startup", "COMMAND_CANCELLED"]],
    );
    assert.equal((h.manager as any).admitted.size, 0);
    assert.equal(h.launches.length, 0);
    assert.equal(h.store.acquireLock("resume-session", "third-runner"), true);
    h.store.releaseLock("resume-session", "third-runner");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("value-identical session command discovery does not publish a redundant runtime update", async () => {
  const prior = [{ name: "deploy", source: "project" as const, argumentHint: "<environment>" }];
  const h = harness({ sessionSlashCommands: prior }, Promise.resolve(), Promise.resolve(), () => {}, (meta) => {
    meta.sessionSlashCommands = prior.map((command) => ({ ...command }));
  });
  try {
    h.manager.prompt("resume-session", "continue", []);
    await tick();
    await tick();
    assert.equal(
      h.sent.filter((message) => message.type === "session_runtime_updated").length,
      0,
    );
    assert.deepEqual(h.store.readMeta("resume-session")?.sessionSlashCommands, prior);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("startup automatically resumes durable Claude orphan work without a user message", async () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    command: "claude",
    agentSessionId: "claude-session",
    backgroundWorkState: "orphaned",
    pendingBackgroundTaskIds: ["task-1"],
    orphanedWork: { pendingTaskIds: ["task-1"], markedAt: 10, reason: "process_exit" },
  });
  try {
    h.manager.reconcileStore();
    await shortDelay();
    await tick();
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0]?.options.resumeId, "claude-session");
    assert.equal(h.launches[0]?.options.sessionStateDir, h.store.sessionPath("resume-session"));
    assert.match(h.prompts[0] ?? "", /consume queued background-task notifications/i);
    assert.equal(
      h.store.readEvents("resume-session").some((event) => event.payload.kind === "user_message"),
      false,
      "the runner-owned continuation must not impersonate the user",
    );
    assert.ok(h.store.readEvents("resume-session").some((event) =>
      event.payload.kind === "stderr" && /resumed orphaned background work automatically/i.test(event.payload.text)));
    assert.equal(h.store.readMeta("resume-session")?.orphanedWork, undefined);
    assert.equal(h.store.readMeta("resume-session")?.backgroundWorkState, "resumed");
    assert.deepEqual(h.store.readMeta("resume-session")?.recoveredBackgroundTaskIds, ["task-1"]);
    const promptCount = h.prompts.length;
    h.manager.recoverAllOrphanedWork();
    h.manager.recoverOrphanedWork("resume-session");
    await shortDelay();
    assert.equal(h.prompts.length, promptCount, "handled recovery work must not become billable again");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("startup reconciliation mirrors legacy checkpoint refs for known sessions", async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-ref-reconcile-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "checkpoint\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  git(repo, ["update-ref", "refs/mam/resume-session/turn-1", tree]);
  git(repo, ["update-ref", "refs/mam/resume-session/fork-1", tree]);
  const h = harness({ repoPath: repo, worktreePath: repo, turnCount: 1 });
  try {
    h.manager.reconcileStore();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (git(repo, ["for-each-ref", "--format=%(refname)", "refs/wollipog/resume-session/"])) break;
      await shortDelay();
    }
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/resume-session/turn-1"]), tree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/resume-session/fork-1"]), tree);
    assert.equal(git(repo, ["rev-parse", "refs/mam/resume-session/turn-1"]), tree);
    assert.equal(git(repo, ["rev-parse", "refs/mam/resume-session/fork-1"]), tree);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("startup checkpoint maintenance has a deterministic fixed concurrency ceiling", async (t) => {
  const h = harness();
  const gate = deferred<void>();
  const sessionCount = 17;
  let active = 0;
  let highWater = 0;
  let started = 0;
  t.after(() => setGitRunnerForTests());
  try {
    h.store.patchMeta("resume-session", {
      repoPath: h.root,
      worktreePath: h.root,
      status: "stopped",
      indexReset: true,
    });
    for (let index = 1; index < sessionCount; index++) {
      h.store.create(stored(h.root, {
        sessionId: `sync-session-${index}`,
        repoPath: h.root,
        worktreePath: h.root,
        agentSessionId: null,
        status: "stopped",
        indexReset: true,
      }));
    }
    setGitRunnerForTests(async (_cwd, args) => {
      if (args[0] === "for-each-ref" && args[2]?.startsWith("refs/wollipog/")) {
        active++;
        started++;
        highWater = Math.max(highWater, active);
        await gate.promise;
        active--;
      }
      return "";
    });

    h.manager.reconcileStore();
    for (let attempt = 0; attempt < 100 && started < 4; attempt++) await shortDelay();
    assert.equal(started, 4, "only the fixed-cap first wave may enter Git before release");
    assert.equal(highWater, 4);
    await shortDelay();
    assert.equal(started, 4, "queued sessions cannot start while every slot is occupied");

    gate.resolve();
    for (let attempt = 0; attempt < 200; attempt++) {
      if (started === sessionCount && (h.manager as any).checkpointRefSyncs.size === 0) break;
      await shortDelay();
    }
    assert.equal(started, sessionCount);
    assert.equal(highWater, 4, "the high-water mark stays at the fixed process cap");
    assert.equal((h.manager as any).checkpointRefMaintenanceActive, 0);
    assert.equal((h.manager as any).checkpointRefMaintenanceQueue.length, 0);
  } finally {
    gate.resolve();
    for (let attempt = 0; attempt < 100 && (h.manager as any).checkpointRefSyncs.size > 0; attempt++) {
      await shortDelay();
    }
    setGitRunnerForTests();
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a pre-submission recovery launch failure remains retryable without duplicate provider work", async () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    command: "claude",
    agentSessionId: "claude-session",
    backgroundWorkState: "orphaned",
    pendingBackgroundTaskIds: ["retryable-task"],
    orphanedWork: { pendingTaskIds: ["retryable-task"], markedAt: 10, reason: "process_exit" },
  }, (launchIndex) => launchIndex === 0
    ? Promise.reject(new Error("transient launch failure"))
    : Promise.resolve());
  try {
    h.manager.recoverOrphanedWork("resume-session");
    await shortDelay();
    await tick();
    assert.equal(h.launches.length, 1);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.store.readMeta("resume-session")?.orphanedWork?.recoveryAttemptedAt, undefined);

    await (h.manager as any).runOrphanRecovery("resume-session");
    await tick();
    await tick();
    assert.equal(h.launches.length, 2);
    assert.equal(h.prompts.length, 1);
    assert.match(h.prompts[0] ?? "", /consume queued background-task notifications/i);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a live Claude orphan callback persists first and triggers recovery without human input", async () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    command: "claude",
    agentSessionId: "claude-session",
  });
  try {
    h.manager.prompt("resume-session", "ordinary user turn", []);
    await tick();
    await tick();
    assert.deepEqual(h.prompts, ["ordinary user turn"]);
    h.callbacks().onBackgroundWork?.({
      state: "orphaned",
      pendingTaskIds: ["task-2"],
      oldestPendingAt: 20,
      reason: "ceiling",
    });
    assert.equal(h.store.readMeta("resume-session")?.backgroundWorkState, "orphaned");
    assert.deepEqual(h.store.readMeta("resume-session")?.orphanedWork?.pendingTaskIds, ["task-2"]);
    await shortDelay();
    await tick();
    assert.equal(h.prompts.length, 2);
    assert.match(h.prompts[1] ?? "", /reconcile every orphaned task/i);
    assert.equal(h.store.readMeta("resume-session")?.backgroundWorkState, "resumed");
    assert.equal(h.store.readMeta("resume-session")?.orphanedWork, undefined);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("an explicitly stopped Claude session is not resurrected by startup recovery", async () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    command: "claude",
    agentSessionId: "claude-session",
  });
  let restarted: SessionManager | null = null;
  try {
    h.manager.prompt("resume-session", "start background work", []);
    await tick();
    await tick();
    h.callbacks().onBackgroundWork?.({
      state: "running",
      pendingTaskIds: ["task-stop"],
      observedTaskIds: ["task-stop"],
      oldestPendingAt: 1,
    });
    h.manager.stop("resume-session");
    assert.deepEqual(h.disposals.at(-1), { forceImmediate: true });
    const stopped = h.store.readMeta("resume-session");
    assert.equal(stopped?.status, "stopped");
    assert.equal(stopped?.backgroundWorkState, undefined);
    assert.deepEqual(stopped?.pendingBackgroundTaskIds, []);
    assert.equal(stopped?.orphanedWork, undefined);
    h.callbacks().onBackgroundWork?.({
      state: "orphaned",
      pendingTaskIds: ["task-stop"],
      oldestPendingAt: 1,
      reason: "shutdown",
    });
    assert.equal(h.store.readMeta("resume-session")?.orphanedWork, undefined,
      "the disposed driver's synchronous shutdown callback is fenced after Stop");

    h.manager.shutdownAll();
    restarted = new SessionManager(() => {}, () => {}, h.store, "runner-restarted", undefined, h.factory);
    restarted.reconcileStore();
    restarted.recoverAllOrphanedWork();
    await shortDelay();
    assert.equal(h.launches.length, 1);
    assert.deepEqual(h.prompts, ["start background work"]);
  } finally {
    restarted?.shutdownAll();
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a completed synthetic turn cannot clear a one-shot orphan that still has pending work", () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    command: "claude",
    agentSessionId: "claude-session",
    backgroundWorkState: "orphaned",
    pendingBackgroundTaskIds: ["still-running"],
    orphanedWork: {
      pendingTaskIds: ["still-running"],
      markedAt: 1,
      reason: "process_exit",
      recoveryAttemptedAt: 2,
      recoveryObservedTaskIds: ["still-running"],
    },
  });
  try {
    (h.manager as any).finishOrphanRecovery("resume-session");
    assert.equal(h.store.readMeta("resume-session")?.backgroundWorkState, "orphaned");
    assert.deepEqual(h.store.readMeta("resume-session")?.orphanedWork?.pendingTaskIds, ["still-running"]);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("shrinking or expanding an attempted orphan set preserves its durable at-most-once boundary", async () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    command: "claude",
    agentSessionId: "claude-session",
    backgroundWorkState: "orphaned",
    pendingBackgroundTaskIds: ["completed", "still-running"],
    orphanedWork: {
      pendingTaskIds: ["completed", "still-running"],
      markedAt: 1,
      reason: "process_exit",
      recoveryAttemptedAt: 2,
    },
  });
  try {
    (h.manager as any).onDriverBackgroundWork("resume-session", {
      state: "orphaned",
      pendingTaskIds: ["still-running"],
      observedTaskIds: [],
      oldestPendingAt: 1,
      reason: "process_exit",
    });
    const marker = h.store.readMeta("resume-session")?.orphanedWork;
    assert.deepEqual(marker?.pendingTaskIds, ["still-running"]);
    assert.equal(marker?.recoveryAttemptedAt, 2);
    assert.deepEqual(h.store.readMeta("resume-session")?.recoveredBackgroundTaskIds, ["completed"]);
    (h.manager as any).onDriverBackgroundWork("resume-session", {
      state: "orphaned",
      pendingTaskIds: ["still-running", "newly-observed"],
      observedTaskIds: ["newly-observed"],
      oldestPendingAt: 1,
      reason: "process_exit",
    });
    const expanded = h.store.readMeta("resume-session")?.orphanedWork;
    assert.deepEqual(expanded?.pendingTaskIds, ["still-running", "newly-observed"]);
    assert.equal(expanded?.recoveryAttemptedAt, 2);
    h.manager.recoverOrphanedWork("resume-session");
    await shortDelay();
    assert.equal(h.prompts.length, 0);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("startup converts a crashed running Claude task set into a durable orphan before recovery", async () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    command: "claude",
    agentSessionId: "claude-session",
    status: "running",
    backgroundWorkState: "running",
    pendingBackgroundTaskIds: ["task-3"],
  });
  try {
    h.manager.reconcileStore();
    const reconciled = h.store.readMeta("resume-session");
    assert.equal(reconciled?.backgroundWorkState, "orphaned");
    assert.deepEqual(reconciled?.orphanedWork?.pendingTaskIds, ["task-3"]);
    await shortDelay();
    await tick();
    assert.equal(h.prompts.length, 1);
    assert.equal(h.store.readMeta("resume-session")?.backgroundWorkState, "resumed");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("artifact-only task updates preserve the at-most-once recovery tombstone", async () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    command: "claude",
    agentSessionId: "claude-session",
    recoveredBackgroundTaskIds: ["artifact-only"],
  });
  try {
    (h.manager as any).onDriverBackgroundWork("resume-session", {
      state: "running",
      pendingTaskIds: ["artifact-only"],
      observedTaskIds: [],
      oldestPendingAt: 1,
    });
    assert.deepEqual(h.store.readMeta("resume-session")?.recoveredBackgroundTaskIds, ["artifact-only"]);
    h.manager.reconcileStore();
    await shortDelay();
    assert.equal(h.prompts.length, 0);
    assert.equal(h.store.readMeta("resume-session")?.backgroundWorkState, "resumed");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("startup discovers an incomplete Claude task directory even without a persisted marker", async () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    command: "claude",
    env: { HOME: "/provider/home", TMPDIR: "/provider/tmp" },
    agentSessionId: "claude-session",
  });
  try {
    Object.assign(h.manager as object, {
      discoverClaudeTasks: (_cwd: string, _sessionId: string, roots: { tempRoot?: string; claudeHome?: string }) => {
        assert.equal(roots.tempRoot, "/provider/tmp");
        assert.match(roots.claudeHome ?? "", /provider[\\/]home[\\/]\.claude$/);
        return [{ id: "task-from-disk", outputFile: "task-from-disk.output" }];
      },
    });
    h.manager.reconcileStore();
    assert.equal(h.store.readMeta("resume-session")?.backgroundWorkState, "orphaned");
    assert.deepEqual(h.store.readMeta("resume-session")?.orphanedWork?.pendingTaskIds, ["task-from-disk"]);
    await shortDelay();
    await tick();
    assert.equal(h.prompts.length, 1);
    assert.equal(h.store.readMeta("resume-session")?.backgroundWorkState, "resumed");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a reconnect scan discovers a later markerless task after prior recovery", () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    command: "claude",
    agentSessionId: "claude-session",
    backgroundWorkState: "resumed",
  });
  try {
    let scans = 0;
    Object.assign(h.manager as object, {
      discoverClaudeTasks: () => {
        scans++;
        return [{ id: "later-task", outputFile: "later-task.output" }];
      },
    });
    h.manager.recoverAllOrphanedWork();
    h.manager.recoverAllOrphanedWork();
    assert.equal(scans, 1, "flapping reconnects coalesce expensive provider-store scans");
    assert.equal(h.store.readMeta("resume-session")?.backgroundWorkState, "orphaned");
    assert.deepEqual(h.store.readMeta("resume-session")?.orphanedWork?.pendingTaskIds, ["later-task"]);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("read-only orphan recovery stays idle until an explicit reconnect can heal the launch", async () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    command: "",
    agentSessionId: "claude-session",
    backgroundWorkState: "orphaned",
    pendingBackgroundTaskIds: ["read-only-task"],
    orphanedWork: { pendingTaskIds: ["read-only-task"], markedAt: 1, reason: "process_exit" },
  });
  try {
    h.manager.reconcileStore();
    await shortDelay();
    assert.equal(h.launches.length, 0);
    assert.equal((h.manager as any).orphanRecoveryTimers.size, 0, "read-only history must not poll forever");

    Object.assign(h.manager as object, {
      resolveLaunch: () => ({ command: "claude", args: [], env: {} }),
    });
    h.manager.recoverAllOrphanedWork();
    await shortDelay();
    await tick();
    assert.equal(h.launches.length, 1);
    assert.equal(h.store.readMeta("resume-session")?.command, "claude");
    assert.equal(h.store.readMeta("resume-session")?.orphanedWork, undefined);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("WSL startup discovers markerless Claude tasks inside the selected distro", async () => {
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code-wsl-Ubuntu",
    command: "",
    context: { kind: "wsl", distro: "Ubuntu" },
    agentSessionId: "claude-session",
  });
  try {
    Object.assign(h.manager as object, {
      discoverClaudeTasksInContext: async (context: unknown) => {
        assert.deepEqual(context, { kind: "wsl", distro: "Ubuntu" });
        return [{ id: "wsl-task", outputFile: "/tmp/wsl-task.output" }];
      },
    });
    h.manager.reconcileStore();
    await tick();
    assert.equal(h.store.readMeta("resume-session")?.backgroundWorkState, "orphaned");
    assert.deepEqual(h.store.readMeta("resume-session")?.orphanedWork?.pendingTaskIds, ["wsl-task"]);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("adoption surfaces provider task artifacts but waits for explicit user ownership", async () => {
  const h = harness();
  try {
    Object.assign(h.manager as object, {
      discoverClaudeTasks: (_cwd: string, providerSessionId: string) =>
        providerSessionId === "adopted-claude" ? [{ id: "adopted-task", outputFile: "adopted-task.output" }] : [],
    });
    assert.equal(h.manager.adopt("adopted-session", {
      agentSessionId: "adopted-claude",
      agentId: "claude-code",
      driver: "claude-code",
      cwd: h.root,
      context: { kind: "native" },
      title: "Adopted Claude",
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
    }, { command: "claude", args: [], env: {} }), true);
    assert.deepEqual(h.store.readMeta("adopted-session")?.orphanedWork?.pendingTaskIds, ["adopted-task"]);
    await shortDelay();
    await tick();
    assert.equal(h.launches.length, 0);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.store.readMeta("adopted-session")?.backgroundWorkState, "orphaned");

    h.manager.prompt("adopted-session", "continue this adopted session", []);
    await shortDelay();
    await tick();
    assert.equal(h.launches.at(-1)?.options.resumeId, "adopted-claude");
    assert.equal(h.prompts.at(-1), "continue this adopted session");
    assert.equal(h.store.readMeta("adopted-session")?.adoptedBackgroundRecoveryAuthorized, true);
    assert.equal(h.store.readMeta("adopted-session")?.backgroundWorkState, "resumed");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("real Claude driver shutdown persists live work and a restarted manager resumes it end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-claude-lifetime-e2e-"));
  const store = new SessionStore(root);
  store.create(stored(root, {
    driver: "claude-code",
    agentId: "claude-code",
    command: "claude",
    agentSessionId: "claude-session",
  }));
  const firstChild = fakeClaudeProcess();
  const firstFactory = (_kind: AgentDriverKind, options: DriverOptions, callbacks: DriverCallbacks): Driver =>
    new ClaudeCodeDriver(options, callbacks, {
      spawn: () => firstChild,
      kill: () => {},
    } as any);
  const first = new SessionManager(() => {}, () => {}, store, "runner", undefined, firstFactory);
  try {
    first.prompt("resume-session", "delegate and wait", []);
    await tick();
    await tick();
    firstChild.stdout.write(JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "long-task",
      tool_use_id: "tool-long-task",
    }) + "\n");
    firstChild.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
    await shortDelay();
    assert.equal(store.readMeta("resume-session")?.backgroundWorkState, "running");

    first.shutdownAll();
    assert.equal(firstChild.stdin.writableEnded, true);
    assert.deepEqual(store.readMeta("resume-session")?.orphanedWork?.pendingTaskIds, ["long-task"]);

    const secondChild = fakeClaudeProcess();
    const submitted: string[] = [];
    secondChild.stdin.on("data", (chunk: Buffer) => submitted.push(chunk.toString("utf8")));
    const secondFactory = (_kind: AgentDriverKind, options: DriverOptions, callbacks: DriverCallbacks): Driver =>
      new ClaudeCodeDriver(options, callbacks, {
        spawn: () => secondChild,
        kill: () => {},
      } as any);
    const restarted = new SessionManager(() => {}, () => {}, store, "runner", undefined, secondFactory);
    try {
      restarted.reconcileStore();
      await shortDelay();
      await tick();
      assert.match(submitted.join(""), /consume queued background-task notifications/i);
      secondChild.stdout.write(JSON.stringify({
        type: "system",
        subtype: "task_notification",
        task_id: "long-task",
        tool_use_id: "tool-long-task",
        status: "completed",
      }) + "\n");
      secondChild.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
      await shortDelay();
      assert.equal(store.readMeta("resume-session")?.orphanedWork, undefined);
      assert.equal(store.readMeta("resume-session")?.backgroundWorkState, "resumed");
      assert.equal(
        store.readEvents("resume-session").some((event) => event.payload.kind === "user_message"),
        true,
        "only the original user prompt is durable; the recovery continuation is runner-owned",
      );
      assert.equal(
        store.readEvents("resume-session").filter((event) => event.payload.kind === "user_message").length,
        1,
      );
    } finally {
      restarted.shutdownAll();
    }
  } finally {
    first.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume publishes session-scoped capability changes made by launch provisioning", async () => {
  const capabilities = {
    models: [],
    effortLevels: [],
    slashCommands: [],
    supportsImages: true,
    supportsApprovals: true,
    permissionModes: ["acceptEdits"],
    elicitation: { acceptEdits: ["none" as const] },
  };
  const h = harness({ capabilities }, Promise.resolve(), Promise.resolve(), () => {}, (meta) => {
    meta.capabilities = {
      ...meta.capabilities!,
      elicitation: { acceptEdits: ["hook"] },
    };
  });
  try {
    h.manager.prompt("resume-session", "continue", []);
    await tick();
    await tick();
    assert.deepEqual(h.store.readMeta("resume-session")?.capabilities?.elicitation, {
      acceptEdits: ["hook"],
    });
    const update = h.sent.find((message) => message.type === "session_runtime_updated");
    assert.ok(update && update.type === "session_runtime_updated");
    assert.deepEqual(update.snapshot.agentCapabilities?.elicitation, { acceptEdits: ["hook"] });
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("an open policy transport circuit immediately removes the session hook capability", async () => {
  const capabilities = {
    models: [],
    effortLevels: [],
    slashCommands: [],
    supportsImages: true,
    supportsApprovals: true,
    permissionModes: ["acceptEdits"],
    elicitation: { acceptEdits: ["hook" as const] },
  };
  const h = harness({
    driver: "claude-code",
    agentId: "claude-code",
    agentSessionId: null,
    capabilities,
  });
  try {
    await h.manager.start({
      ...launchSpec(h.root),
      driver: "claude-code",
      agentId: "claude-code",
      command: "claude",
      capabilities,
    });
    h.callbacks().onEvent({ kind: "policy_transport", state: "open", openedAt: 123 });
    assert.deepEqual(h.store.readMeta("resume-session")?.capabilities?.elicitation, {
      acceptEdits: ["none"],
    });
    const updates = h.sent.filter((message) => message.type === "session_runtime_updated");
    assert.ok(updates.at(-1)?.type === "session_runtime_updated");
    assert.deepEqual(
      updates.at(-1)?.type === "session_runtime_updated"
        ? updates.at(-1).snapshot.agentCapabilities?.elicitation
        : undefined,
      { acceptEdits: ["none"] },
    );
    h.callbacks().onEvent({
      kind: "policy_transport",
      state: "recovered",
      openedAt: 123,
      restoresElicitation: true,
    });
    assert.deepEqual(h.store.readMeta("resume-session")?.capabilities?.elicitation, {
      acceptEdits: ["hook"],
    });
    const recovered = h.sent.filter((message) => message.type === "session_runtime_updated").at(-1);
    assert.deepEqual(
      recovered?.type === "session_runtime_updated"
        ? recovered.snapshot.agentCapabilities?.elicitation
        : undefined,
      { acceptEdits: ["hook"] },
    );
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a disabled retained conductor session cannot resume or spawn", async () => {
  const h = harness(
    { agentId: "conductor", driver: "claude-code", command: "claude", agentSessionId: "claude-session" },
    Promise.resolve(),
    Promise.resolve(),
    () => {},
    () => {
      throw new Error("Conductor is disabled on this runner; set WOLLIPOG_CONDUCTOR=1 and restart the runner to enable it");
    },
  );
  try {
    h.manager.prompt("resume-session", "continue", []);
    await tick();
    await tick();
    assert.equal(h.launches.length, 0);
    assert.equal(h.store.readMeta("resume-session")?.status, "failed");
    assert.ok(h.sent.some((message) =>
      message.type === "session_event" &&
      message.payload.kind === "error" &&
      message.payload.message.includes("WOLLIPOG_CONDUCTOR=1")));
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("provider readiness callbacks are attributed to the launched agent without identity data", async () => {
  const h = harness();
  try {
    await h.manager.start(launchSpec(h.root));
    h.callbacks().onAuthStatus?.("unauthenticated");
    const capabilities = {
      logout: true,
      loadSession: true,
      sessionList: true,
      sessionDelete: false,
      sessionResume: true,
      sessionClose: true,
    };
    h.callbacks().onAcpCapabilities?.(capabilities);
    assert.deepEqual(h.authStatuses, [
      ["codex-native", { status: "unauthenticated" }],
      ["codex-native", { capabilities }],
    ]);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("ACP persists negotiated lifecycle support and its session id before the first turn", async () => {
  const h = harness({ driver: "acp", agentId: "gemini", agentSessionId: null });
  try {
    await h.manager.start({ ...launchSpec(h.root), driver: "acp", agentId: "gemini", command: "gemini" });
    const meta = h.store.readMeta("resume-session")!;
    assert.deepEqual(meta.acpCapabilities, ACP_LIFECYCLE);
    assert.equal(meta.agentSessionId, "thread-new");
    h.manager.stop("resume-session");
    await tick();
    assert.equal(h.closes(), 1);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("ACP session controls persist per session and publish an authoritative runtime snapshot", async () => {
  const h = harness({ driver: "acp", agentId: "gemini", agentSessionId: null });
  const capabilities = {
    models: [{ id: "fast", displayName: "Fast", default: true }],
    effortLevels: ["low", "high"],
    slashCommands: [{ name: "review", source: "builtin" as const }],
    supportsImages: true,
    supportsApprovals: true,
    permissionModes: ["default", "plan"],
  };
  try {
    await h.manager.start({ ...launchSpec(h.root), driver: "acp", agentId: "gemini", command: "gemini" });
    h.callbacks().onAcpSessionState?.({
      capabilities,
      config: { model: "fast", effort: "high", permissionMode: "plan" },
    });
    const meta = h.store.readMeta("resume-session")!;
    assert.deepEqual(meta.capabilities, capabilities);
    assert.equal(
      meta.capabilities?.slashCommands[0]?.invocation,
      undefined,
      "opaque live authority is never persisted in the session store",
    );
    assert.deepEqual(meta.config, { model: "fast", effort: "high", permissionMode: "plan" });
    const update = h.sent.findLast((message) => message.type === "session_runtime_updated");
    assert.ok(update && update.type === "session_runtime_updated");
    assert.deepEqual(
      update.snapshot.agentCapabilities?.slashCommands[0] && {
        name: update.snapshot.agentCapabilities.slashCommands[0].name,
        source: update.snapshot.agentCapabilities.slashCommands[0].source,
      },
      { name: "review", source: "builtin" },
    );
    assert.match(
      update.snapshot.agentCapabilities?.slashCommands[0]?.invocation?.id ?? "",
      /^command_[0-9a-f-]{36}$/,
    );
    assert.match(
      update.snapshot.agentCapabilities?.slashCommands[0]?.invocation?.catalogRevision ?? "",
      /^catalog_[0-9a-f-]{36}$/,
    );
    assert.equal(
      update.snapshot.agentCapabilities?.slashCommands[0]?.invocation?.executionMode,
      "structured",
    );
    assert.deepEqual(update.snapshot.config, meta.config);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("ACP usage is a monotonic cumulative gauge and provider titles respect user ownership", async () => {
  const h = harness({
    driver: "acp",
    agentId: "gemini",
    agentSessionId: null,
    title: "Generated prompt",
    titleSource: "generated",
    costUsd: 0.5,
  });
  try {
    await h.manager.start({
      ...launchSpec(h.root),
      driver: "acp",
      agentId: "gemini",
      command: "gemini",
      title: "Generated prompt",
      titleSource: "generated",
    });
    h.callbacks().onAcpUsage?.({ contextTokensUsed: 80, contextWindow: 1_000, costUsd: 2 });
    h.callbacks().onAcpUsage?.({ contextTokensUsed: 40, contextWindow: 2_000, costUsd: 1 });
    h.callbacks().onAcpSessionInfo?.({ title: "Provider title", providerUpdatedAt: "2026-07-11T00:00:00.000Z" });
    let meta = h.store.readMeta("resume-session")!;
    assert.equal(meta.contextTokensUsed, 40);
    assert.equal(meta.contextWindow, 2_000);
    assert.equal(meta.costUsd, 2, "a stale lower cumulative cost cannot roll back accounting");
    assert.equal(meta.title, "Provider title");
    assert.equal(meta.titleSource, "provider");
    assert.equal(meta.providerUpdatedAt, "2026-07-11T00:00:00.000Z");

    h.callbacks().onAcpSessionInfo?.({ title: null });
    meta = h.store.readMeta("resume-session")!;
    assert.equal(meta.title, "Untitled session");
    assert.equal(meta.titleSource, "provider", "an explicit provider clear still owns the title");
    h.callbacks().onAcpSessionInfo?.({ title: "Provider title" });

    h.store.patchMeta("resume-session", { title: "My title", titleSource: "user" });
    h.callbacks().onAcpSessionInfo?.({ title: "Agent replacement", providerUpdatedAt: "2026-07-12T00:00:00.000Z" });
    meta = h.store.readMeta("resume-session")!;
    assert.equal(meta.title, "My title");
    assert.equal(meta.titleSource, "user");
    assert.equal(meta.providerUpdatedAt, "2026-07-12T00:00:00.000Z");

    const runtime = h.sent.filter((message) => message.type === "session_runtime_updated");
    assert.ok(runtime.length >= 3);
    assert.equal(runtime.at(-1)?.type === "session_runtime_updated" && runtime.at(-1).snapshot.costUsd, 2);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a rejected async ACP config change fails closed before the queued turn runs", async () => {
  const h = harness(
    { driver: "acp", agentId: "gemini", agentSessionId: null },
    Promise.resolve(),
    Promise.resolve(),
    async () => { throw new Error("ACP session configuration update failed"); },
  );
  try {
    await h.manager.start({ ...launchSpec(h.root), driver: "acp", agentId: "gemini", command: "gemini" });
    h.manager.prompt("resume-session", "must not run", [], undefined, { model: "rejected" });
    await tick();
    await tick();
    assert.deepEqual(h.prompts, []);
    assert.equal(h.store.readMeta("resume-session")!.status, "idle");
    assert.equal(h.sent.some((message) =>
      message.type === "session_event" && message.payload.kind === "error" &&
      /configuration update failed/.test(message.payload.message)), true);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("ACP resume is derived from persisted capabilities, never driver name alone", async () => {
  const resumable = harness({
    driver: "acp",
    agentId: "gemini",
    command: "gemini",
    agentSessionId: "acp-existing",
    acpCapabilities: ACP_LIFECYCLE,
  });
  try {
    resumable.manager.prompt("resume-session", "continue");
    await tick();
    await tick();
    assert.equal(resumable.launches[0]?.options.resumeId, "acp-existing");
  } finally {
    resumable.manager.shutdownAll();
    resumable.cleanup();
  }

  const readOnly = harness({
    driver: "acp",
    agentId: "gemini",
    command: "gemini",
    agentSessionId: "acp-existing",
    acpCapabilities: { ...ACP_LIFECYCLE, loadSession: false, sessionResume: false },
  });
  try {
    readOnly.manager.prompt("resume-session", "must not replace the conversation");
    await tick();
    assert.equal(readOnly.launches.length, 0);
    assert.equal(readOnly.store.readMeta("resume-session")?.status, "stopped");
  } finally {
    readOnly.manager.shutdownAll();
    readOnly.cleanup();
  }
});

test("legacy ACP history without a provider id cannot become a replacement conversation", async () => {
  const h = harness({
    driver: "acp",
    agentId: "gemini",
    command: "gemini",
    agentSessionId: null,
    seq: 2,
    acpCapabilities: ACP_LIFECYCLE,
  });
  try {
    h.manager.prompt("resume-session", "must not launch fresh");
    await tick();
    assert.equal(h.launches.length, 0);
    assert.equal(h.store.readMeta("resume-session")?.status, "stopped");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("ACP stop holds prompt, restart, lock, and admission through session close", async () => {
  let release!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({ driver: "acp", agentId: "gemini", agentSessionId: null }, Promise.resolve(), closeGate);
  try {
    const spec = { ...launchSpec(h.root), driver: "acp" as const, agentId: "gemini", command: "gemini" };
    await h.manager.start(spec);
    h.manager.stop("resume-session");
    h.manager.prompt("resume-session", "must wait for close");
    const errors = h.sent.filter(
      (message) => message.type === "session_event" && message.payload.kind === "error",
    );
    assert.equal(errors.some((message) =>
      message.type === "session_event" && message.payload.kind === "error" && /session close/.test(message.payload.message)), true);
    const restart = h.manager.start(spec);
    await tick();
    assert.equal(h.launches.length, 1, "replacement launch remains behind provider close");
    release();
    await restart;
    assert.equal(h.launches.length, 2);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("ACP delete fences prompt and restart through close and removes the row", async () => {
  let release!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({ driver: "acp", agentId: "gemini", agentSessionId: null }, Promise.resolve(), closeGate);
  try {
    const spec = { ...launchSpec(h.root), driver: "acp" as const, agentId: "gemini", command: "gemini" };
    await h.manager.start(spec);
    const deletion = h.manager.delete("resume-session");
    h.manager.prompt("resume-session", "must not relaunch during delete");
    await h.manager.start(spec);
    assert.equal(h.launches.length, 1);
    assert.equal(h.store.has("resume-session"), false, "the row is tombstoned before slow close settles");
    release();
    await deletion;
    assert.equal(h.store.has("resume-session"), false);
    assert.equal(h.launches.length, 1);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a markDeleted I/O failure releases the deletion guard and a retry converges", async () => {
  const h = harness();
  try {
    const mutableStore = h.store as unknown as { markDeleted(id: string): void };
    const markDeleted = h.store.markDeleted.bind(h.store);
    mutableStore.markDeleted = () => {
      throw new Error("injected markDeleted EIO");
    };
    await assert.rejects(h.manager.delete("resume-session"), /injected markDeleted EIO/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((h.manager as any).deleting.has("resume-session"), false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((h.manager as any).deleted.has("resume-session"), false);
    mutableStore.markDeleted = markDeleted;

    await h.manager.delete("resume-session");
    assert.equal(h.store.has("resume-session"), false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((h.manager as any).deleting.has("resume-session"), false);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a cleanup-journal I/O failure releases the deletion guard and preserves retry state", async () => {
  const h = harness({ worktreePath: join(tmpdir(), `wollipog-missing-worktree-${Date.now()}`) });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = h.manager as any;
    const add = internals.cleanupJournal.add.bind(internals.cleanupJournal);
    internals.cleanupJournal.add = () => {
      throw new Error("injected cleanup journal ENOSPC");
    };
    await assert.rejects(h.manager.delete("resume-session"), /injected cleanup journal ENOSPC/);
    assert.equal(internals.deleting.has("resume-session"), false);
    assert.equal(h.store.has("resume-session"), true, "the row survives until cleanup is journaled");
    internals.cleanupJournal.add = add;

    await h.manager.delete("resume-session");
    assert.equal(h.store.has("resume-session"), false);
    assert.equal(internals.deleting.has("resume-session"), false);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("delete during driver initialization cannot resurrect a process or leak its generation", async () => {
  let releaseInitialize!: () => void;
  const initializeGate = new Promise<void>((resolve) => { releaseInitialize = resolve; });
  const h = harness({}, initializeGate);
  try {
    const launch = h.manager.start(launchSpec(h.root));
    await tick();
    const deletion = h.manager.delete("resume-session");
    assert.equal(h.store.has("resume-session"), false, "delete removes the durable row synchronously");
    assert.equal(h.manager.sessionCanOpen("resume-session"), false);
    releaseInitialize();
    assert.equal(await launch, false);
    await deletion;
    // The in-memory tombstone intentionally outlives async cleanup; its expiry releases the
    // generation, while the durable exact-id fence continues rejecting delayed/replayed starts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = h.manager as any;
    assert.equal(internals.active.has("resume-session"), false);
    assert.equal(internals.launchGenerations.has("resume-session"), true);
    internals.expireDeletedTombstone("resume-session");
    assert.equal(internals.deleted.has("resume-session"), false);
    assert.equal(internals.launchGenerations.has("resume-session"), false);
    assert.equal(h.store.isDeleted("resume-session"), true);
    assert.equal(await h.manager.start(launchSpec(h.root)), false);
    assert.equal(h.launches.length, 1);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("startup reconciliation finishes cleanup from the durable-delete crash window", async () => {
  const h = harness();
  try {
    h.manager.shutdownAll();
    h.store.markDeleted("resume-session");
    const markerPath = join(h.root, ".deleted", readdirSync(join(h.root, ".deleted"))[0]!);
    const oldMarkerTime = Date.now() - DELETED_SESSION_MARKER_RETENTION_MS - 60_000;
    utimesSync(markerPath, new Date(oldMarkerTime), new Date(oldMarkerTime));
    assert.equal(h.store.has("resume-session"), true);
    assert.deepEqual(h.store.snapshots(), [], "the tombstoned row is never advertised");
    const restarted = new SessionManager(
      () => {}, () => {}, h.store, "runner-restarted", undefined, h.factory,
    );
    // A same-process tombstone cache hit must not mask a row left by a failed/concurrent removal.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (restarted as any).deleted.add("resume-session");
    restarted.reconcileStore();
    assert.equal(h.store.has("resume-session"), false);
    assert.equal(h.store.isDeleted("resume-session"), true, "reconciliation reaffirms the old marker before reaping");
    assert.ok(
      statSync(markerPath).mtimeMs > oldMarkerTime + 30_000,
      "an EEXIST retry refreshes the marker's replay-retention age",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    while ((restarted as any).deleting.has("resume-session")) await tick();
    restarted.shutdownAll();
  } finally {
    h.cleanup();
  }
});

test("cancel during driver initialization invalidates the launch without tombstoning restart", async () => {
  let releaseInitialize!: () => void;
  const initializeGate = new Promise<void>((resolve) => { releaseInitialize = resolve; });
  const h = harness({}, (launchIndex) => launchIndex === 0 ? initializeGate : Promise.resolve());
  try {
    const launch = h.manager.start(launchSpec(h.root));
    await tick();
    h.manager.cancel("resume-session");
    releaseInitialize();
    assert.equal(await launch, false);
    assert.equal(h.store.has("resume-session"), true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = h.manager as any;
    assert.equal(internals.active.has("resume-session"), false);
    assert.equal(internals.launchGenerations.has("resume-session"), false);
    assert.equal(await h.manager.start(launchSpec(h.root)), true, "a fresh explicit start gets a new generation");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("ACP restart re-checks deletion after both awaited an earlier provider close", async () => {
  let release!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({ driver: "acp", agentId: "gemini", agentSessionId: null }, Promise.resolve(), closeGate);
  try {
    const spec = { ...launchSpec(h.root), driver: "acp" as const, agentId: "gemini", command: "gemini" };
    await h.manager.start(spec);
    h.manager.stop("resume-session");
    const restart = h.manager.start(spec); // registers its close continuation before delete
    const deletion = h.manager.delete("resume-session");
    release();
    await Promise.all([restart, deletion]);
    assert.equal(h.launches.length, 1, "the stale restart never relaunches a row owned by delete");
    assert.equal(h.store.has("resume-session"), false);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("explicit app-server restart preserves and passes the durable thread id", async () => {
  const h = harness({ agentVersion: "0.144.1" });
  try {
    await h.manager.start(launchSpec(h.root));
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0]!.options.resumeId, "thread-persisted");
    assert.equal(h.store.readMeta("resume-session")!.agentSessionId, "thread-persisted");
    const telemetry = h.sent.filter((message) => message.type === "driver_telemetry");
    assert.deepEqual(
      telemetry.map((message) => message.type === "driver_telemetry" ? [message.metric, message.outcome, message.version] : []),
      [["launch", "success", "0.144.1"], ["resume", "success", "0.144.1"]],
    );
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("explicit restart clears uncertain steering identity before the replacement session", async () => {
  let steerCalls = 0;
  const h = harness(
    { status: "running" },
    Promise.resolve(),
    Promise.resolve(),
    () => {},
    undefined,
    async () => { steerCalls++; return { outcome: "uncertain", reason: "retained before restart" }; },
  );
  try {
    assert.equal(await h.manager.start(launchSpec(h.root)), true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstEntry = (h.manager as any).active.get("resume-session");
    firstEntry.running = true;
    firstEntry.activeTurnId = "turn-before-restart";
    firstEntry.activeTurnConfig = {};
    assert.equal((await h.manager.steerSession({
      submissionId: "restart-steering-id",
      sessionId: "resume-session",
      turnId: "turn-before-restart",
      text: "before restart",
    })).disposition, "uncertain");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((h.manager as any).steeringRegistry.has("resume-session"), true);

    assert.equal(await h.manager.start(launchSpec(h.root)), true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = h.manager as any;
    assert.equal(internals.steeringRegistry.has("resume-session"), false);
    assert.equal(internals.steeringLanes.has("resume-session"), false);
    assert.equal(internals.nextQueueOrdinalBySession.has("resume-session"), false);

    const replacement = internals.active.get("resume-session");
    replacement.running = true;
    replacement.activeTurnId = "turn-after-restart";
    replacement.activeTurnConfig = {};
    const fresh = await h.manager.steerSession({
      submissionId: "restart-steering-id",
      sessionId: "resume-session",
      turnId: "turn-after-restart",
      text: "after restart",
    });
    assert.equal(fresh.disposition, "uncertain", "the old submission identity no longer aliases the replacement");
    assert.equal(steerCalls, 2);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("an unexpected app-server exit records one content-free crash observation", async () => {
  const h = harness({ agentVersion: "0.144.1" });
  try {
    await h.manager.start(launchSpec(h.root));
    h.callbacks().onExit(17);
    const crashes = h.sent.filter(
      (message) => message.type === "driver_telemetry" && message.metric === "crash",
    );
    assert.equal(crashes.length, 1);
    assert.deepEqual(crashes[0], {
      type: "driver_telemetry",
      metric: "crash",
      driver: "codex-app-server",
      version: "0.144.1",
      context: "native",
      outcome: "failure",
      reason: "app_server_exit",
    });
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a code-zero app-server exit still counts as unexpected persistent-process loss", async () => {
  const h = harness({ agentVersion: "0.144.1" });
  try {
    await h.manager.start(launchSpec(h.root));
    h.callbacks().onExit(0);
    const crashes = h.sent.filter(
      (message) => message.type === "driver_telemetry" && message.metric === "crash",
    );
    assert.equal(crashes.length, 1);
    assert.equal((crashes[0] as { outcome: string }).outcome, "failure");
    assert.equal(h.store.readMeta("resume-session")!.status, "idle", "the durable thread remains recoverable");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("exec launches record fallback usage while failed initialization records launch failure", async () => {
  const h = harness(
    { driver: "codex", agentVersion: "0.63.0", agentSessionId: null },
    Promise.reject(new Error("init failed")),
  );
  try {
    const spec = {
      ...launchSpec(h.root),
      driver: "codex" as const,
      agentVersion: "0.63.0",
      codexExecFallbackReason: "explicit_exec" as const,
    };
    await h.manager.start(spec);
    const telemetry = h.sent.filter((message) => message.type === "driver_telemetry");
    assert.deepEqual(
      telemetry.map((message) => message.type === "driver_telemetry" ? [message.metric, message.outcome, message.reason] : []),
      [["fallback", "observed", "explicit_exec"], ["launch", "failure", "fresh"]],
    );
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a prompt after runner restart resumes the same app-server thread", async () => {
  const h = harness();
  try {
    h.manager.prompt("resume-session", "continue after restart");
    await tick();
    await tick();
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0]!.kind, "codex-app-server");
    assert.equal(h.launches[0]!.options.resumeId, "thread-persisted");
    assert.deepEqual(h.prompts, ["continue after restart"]);
    assert.equal(h.store.readMeta("resume-session")!.agentSessionId, "thread-persisted");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("app-server crash resumes queued-but-unsubmitted prompts and never replays the in-flight prompt", async () => {
  const h = harness({ status: "running" });
  try {
    const deadDriver = {
      resolvePermission: () => false,
      cancel: () => {},
      dispose: () => {},
      prompt: async () => "refusal" as const,
      setConfig: () => {},
      agentSessionId: () => "thread-persisted",
    };
    (h.manager as any).active.set("resume-session", {
      sessionId: "resume-session",
      client: deadDriver,
      repoPath: h.root,
      cwd: h.root,
      worktree: null,
      status: "running",
      running: true,
      queue: [{ id: "safe-queued", text: "not submitted", images: [] }],
    });
    (h.manager as any).onExit("resume-session", 1);
    await tick();
    await tick();
    await tick();
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0]!.options.resumeId, "thread-persisted");
    assert.deepEqual(h.prompts, ["not submitted"]);
    assert.equal(h.store.readMeta("resume-session")!.status, "idle");
    const userMessages = h.sent.filter(
      (message) => message.type === "session_event" && message.payload.kind === "user_message",
    );
    assert.equal(userMessages.length, 1, "only the known-unsubmitted queued prompt is emitted");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("existing exec Codex sessions retain their resume-by-id path", async () => {
  const h = harness({ driver: "codex", agentSessionId: "exec-thread" });
  try {
    h.manager.prompt("resume-session", "continue exec");
    await tick();
    await tick();
    assert.equal(h.launches[0]!.kind, "codex");
    assert.equal(h.launches[0]!.options.resumeId, "exec-thread");
    assert.deepEqual(h.prompts, ["continue exec"]);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("legacy app-server history without a thread id is never replaced with a fresh conversation", async () => {
  const h = harness({ agentSessionId: null, seq: 3 });
  try {
    h.manager.prompt("resume-session", "do not replace history");
    await tick();
    assert.equal(h.launches.length, 0);
    assert.equal(h.store.readMeta("resume-session")!.status, "stopped");
    const error = h.sent.find(
      (message) => message.type === "session_event" && message.payload.kind === "error",
    );
    assert.ok(error && error.type === "session_event" && error.payload.kind === "error");
    assert.match(error.payload.message, /no persisted Codex thread id/);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a cross-runner resume lease prevents a second app-server launch", async () => {
  const h = harness();
  try {
    assert.equal(h.store.acquireLock("resume-session", "other-runner"), true);
    h.manager.prompt("resume-session", "race");
    await tick();
    assert.equal(h.launches.length, 0);
    assert.equal(h.store.readMeta("resume-session")!.status, "idle");
    const error = h.sent.find(
      (message) => message.type === "session_event" && message.payload.kind === "error",
    );
    assert.ok(error && error.type === "session_event" && error.payload.kind === "error");
    assert.match(error.payload.message, /another runner/);
  } finally {
    h.store.releaseLock("resume-session", "other-runner");
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("explicit app-server restart takes the same cross-runner resume lease", async () => {
  const h = harness();
  try {
    assert.equal(h.store.acquireLock("resume-session", "other-runner"), true);
    await h.manager.start(launchSpec(h.root));
    assert.equal(h.launches.length, 0);
    assert.equal(h.store.readMeta("resume-session")!.status, "idle");
  } finally {
    h.store.releaseLock("resume-session", "other-runner");
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("explicit restart keeps legacy exec Codex fresh while its process-loss resume path stays unchanged", async () => {
  const h = harness({ driver: "codex", agentSessionId: "exec-thread", tokensIn: 40, tokensOut: 10 });
  try {
    await h.manager.start({ ...launchSpec(h.root), driver: "codex" });
    assert.equal(h.launches[0]!.kind, "codex");
    assert.equal(h.launches[0]!.options.resumeId, undefined);
    const meta = h.store.readMeta("resume-session")!;
    assert.equal(meta.agentSessionId, null);
    assert.equal(meta.tokensIn, 0);
    assert.equal(meta.tokensOut, 0);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a prompt arriving during crash recovery stays behind the older recovered queue", async () => {
  let releaseInitialize!: () => void;
  const gate = new Promise<void>((resolve) => { releaseInitialize = resolve; });
  const h = harness({ status: "running" }, gate);
  try {
    (h.manager as any).active.set("resume-session", {
      sessionId: "resume-session",
      client: { resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "thread-persisted" },
      repoPath: h.root,
      cwd: h.root,
      worktree: null,
      status: "running",
      running: true,
      queue: [{ id: "older", text: "older recovered", images: [] }],
    });
    (h.manager as any).onExit("resume-session", 1);
    await tick(); // recovery launch has installed an active entry and is awaiting initialize
    h.manager.prompt("resume-session", "new during recovery");
    const recovering = (h.manager as any).recoveryQueues.get("resume-session");
    assert.deepEqual(recovering.map((prompt: { text: string }) => prompt.text), [
      "older recovered",
      "new during recovery",
    ]);
    assert.ok(recovering[0].ordinal < recovering[1].ordinal);
    releaseInitialize();
    await tick();
    await tick();
    await tick();
    assert.deepEqual(h.prompts, ["older recovered", "new during recovery"]);
  } finally {
    releaseInitialize();
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("crash recovery carries a provider-started promotion fence and uncertain barrier", async () => {
  const provider = deferred<{ outcome: "uncertain"; reason: string }>();
  let steerCalls = 0;
  const h = harness(
    { status: "running" },
    Promise.resolve(),
    Promise.resolve(),
    () => {},
    undefined,
    async () => { steerCalls++; return provider.promise; },
  );
  try {
    assert.equal(await h.manager.start(launchSpec(h.root)), true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (h.manager as any).active.get("resume-session");
    original.running = true;
    original.activeTurnId = "turn-a";
    original.activeTurnConfig = {};
    h.manager.prompt("resume-session", "promoted across crash");
    h.manager.prompt("resume-session", "later recovered work");
    const sourceId = h.sent.filter((message) => message.type === "session_queue").at(-1)!.queue[0]!.id;
    const steering = h.manager.steerSession({
      submissionId: "crash-promotion",
      sessionId: "resume-session",
      turnId: "turn-a",
      promotePromptId: sourceId,
    });
    await tick();
    assert.equal(steerCalls, 1);

    h.callbacks().onExit(1);
    await tick();
    await tick();
    await tick();
    assert.deepEqual(h.prompts, [], "the replacement cannot drain past pending provider delivery");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replacement = (h.manager as any).active.get("resume-session");
    assert.equal(replacement.reservedPromotions.has(sourceId), true);
    assert.equal(replacement.steerFenceIds.has("crash-promotion"), true);

    provider.resolve({ outcome: "uncertain", reason: "connection died after provider write" });
    assert.equal((await steering).disposition, "uncertain");
    await tick();
    assert.equal(replacement.steerFenceIds.size, 0);
    assert.equal(replacement.reservedPromotions.has(sourceId), true);
    assert.deepEqual(h.prompts, [], "uncertain promoted work remains an ordinal barrier");
    const projected = h.sent.filter((message) => message.type === "session_queue").at(-1)!;
    assert.equal(projected.queue.find((prompt) => prompt.id === sourceId)?.steeringState, "uncertain");

    const resolution = h.manager.resolveSteeringAttempt({
      sessionId: "resume-session",
      submissionId: "crash-promotion",
      action: "dismiss",
    });
    assert.equal(resolution.applied, true);
    await tick();
    await tick();
    assert.deepEqual(h.prompts, ["later recovered work"]);
  } finally {
    provider.resolve({ outcome: "uncertain", reason: "test cleanup" });
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("a retryable recovery conflict retains unsubmitted prompts for a later retry", async () => {
  const h = harness({ status: "running" });
  try {
    (h.manager as any).createDriver = (_kind: AgentDriverKind, options: DriverOptions): Driver => ({
      get pid() { return undefined; },
      initialize: async () => { throw new CodexAppServerResumeError("busy", options.resumeId!, true); },
      newSession: async () => options.resumeId!,
      agentSessionId: () => options.resumeId ?? null,
      prompt: async () => "end_turn",
      setConfig: () => {},
      cancel: () => {},
      resolvePermission: () => false,
      dispose: () => {},
    });
    (h.manager as any).active.set("resume-session", {
      sessionId: "resume-session",
      client: { resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "thread-persisted" },
      repoPath: h.root,
      cwd: h.root,
      worktree: null,
      status: "running",
      running: true,
      queue: [{ id: "held", text: "keep me", images: [] }],
    });
    (h.manager as any).onExit("resume-session", 1);
    await tick();
    await tick();
    const held = (h.manager as any).recoveryQueues.get("resume-session");
    assert.deepEqual(held.map((prompt: { text: string }) => prompt.text), ["keep me"]);
    assert.equal(h.store.readMeta("resume-session")!.status, "idle");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("Stop before scheduled recovery prevents relaunch and clears held prompts", async () => {
  const h = harness({ status: "running" });
  try {
    (h.manager as any).active.set("resume-session", {
      sessionId: "resume-session",
      client: { resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "thread-persisted" },
      repoPath: h.root,
      cwd: h.root,
      worktree: null,
      status: "running",
      running: true,
      queue: [{ id: "held", text: "must not run", images: [] }],
    });
    (h.manager as any).onExit("resume-session", 1);
    h.manager.stop("resume-session");
    await tick();
    await tick();
    assert.equal(h.launches.length, 0);
    assert.deepEqual(h.prompts, []);
    assert.equal((h.manager as any).recoveryQueues.has("resume-session"), false);
    assert.equal(h.store.readMeta("resume-session")!.status, "stopped");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("Stop during recovery initialization cancels that launch without leaving a prompt black hole", async () => {
  let releaseInitialize!: () => void;
  const gate = new Promise<void>((resolve) => { releaseInitialize = resolve; });
  const h = harness({ status: "running" }, gate);
  try {
    (h.manager as any).active.set("resume-session", {
      sessionId: "resume-session",
      client: { resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "thread-persisted" },
      repoPath: h.root,
      cwd: h.root,
      worktree: null,
      status: "running",
      running: true,
      queue: [{ id: "held", text: "must not run", images: [] }],
    });
    (h.manager as any).onExit("resume-session", 1);
    await tick();
    h.manager.stop("resume-session");
    releaseInitialize();
    await tick();
    await tick();
    assert.deepEqual(h.prompts, []);
    assert.equal((h.manager as any).active.has("resume-session"), false);
    assert.equal((h.manager as any).recoveryQueues.has("resume-session"), false);

    // A later explicit continuation is handled normally instead of being swallowed by stale
    // recovery state. The gate is already open, so this second launch completes immediately.
    h.manager.prompt("resume-session", "after stop");
    await tick();
    await tick();
    assert.deepEqual(h.prompts, ["after stop"]);
  } finally {
    releaseInitialize();
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("explicit Restart clears a retained recovery queue after a retryable conflict", async () => {
  const h = harness({ status: "running" });
  try {
    (h.manager as any).createDriver = (_kind: AgentDriverKind, options: DriverOptions): Driver => ({
      get pid() { return undefined; },
      initialize: async () => { throw new CodexAppServerResumeError("busy", options.resumeId!, true); },
      newSession: async () => options.resumeId!,
      agentSessionId: () => options.resumeId ?? null,
      prompt: async () => "end_turn",
      setConfig: () => {}, cancel: () => {}, resolvePermission: () => false, dispose: () => {},
    });
    (h.manager as any).active.set("resume-session", {
      sessionId: "resume-session",
      client: { resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "thread-persisted" },
      repoPath: h.root, cwd: h.root, worktree: null, status: "running", running: true,
      queue: [{ id: "held", text: "discarded by restart", images: [] }],
    });
    (h.manager as any).onExit("resume-session", 1);
    await tick();
    await tick();
    assert.equal((h.manager as any).recoveryQueues.has("resume-session"), true);

    (h.manager as any).createDriver = h.factory;
    await h.manager.start(launchSpec(h.root), "restart prompt");
    await tick();
    await tick();
    assert.equal((h.manager as any).recoveryQueues.has("resume-session"), false);
    assert.deepEqual(h.prompts, ["restart prompt"]);
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("Restart superseding recovery initialization keeps the Restart lease", async () => {
  let releaseRecovery!: () => void;
  let releaseRestart!: () => void;
  const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  const restartGate = new Promise<void>((resolve) => { releaseRestart = resolve; });
  const h = harness({ status: "running" }, (index) => index === 0 ? recoveryGate : restartGate);
  try {
    (h.manager as any).active.set("resume-session", {
      sessionId: "resume-session",
      client: { resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "thread-persisted" },
      repoPath: h.root, cwd: h.root, worktree: null, status: "running", running: true,
      queue: [{ id: "held", text: "old held", images: [] }],
    });
    (h.manager as any).onExit("resume-session", 1);
    await tick();
    assert.equal(h.launches.length, 1, "recovery launch is waiting in initialize");

    const restart = h.manager.start(launchSpec(h.root));
    await tick();
    assert.equal(h.launches.length, 2, "Restart superseded recovery and owns the active entry");
    releaseRecovery();
    await tick();
    await tick();
    assert.equal(
      h.store.acquireLock("resume-session", "third-runner"),
      false,
      "stale recovery must not release the Restart entry's same-owner lease",
    );
    releaseRestart();
    await restart;
  } finally {
    releaseRecovery();
    releaseRestart();
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("Restart superseding deferred queued recovery keeps the replacement admission and lock", async () => {
  const entered = [deferred<void>(), deferred<void>()];
  const gates = [deferred<void>(), deferred<void>()];
  let preparations = 0;
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "held-recovery",
    queued: () => {},
    started: () => {},
    completed: () => {},
    failed: (error, code) => failures.push([error, code]),
    uncertain: () => {},
  };
  const h = harness({ status: "running" }, Promise.resolve(), Promise.resolve(), () => {}, async () => {
    const index = preparations++;
    entered[index]?.resolve();
    await gates[index]?.promise;
  });
  try {
    (h.manager as any).active.set("resume-session", {
      sessionId: "resume-session",
      client: { resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "thread-persisted" },
      repoPath: h.root, cwd: h.root, worktree: null, status: "running", running: true,
      queue: [{ id: "held", text: "discarded by restart", images: [], durable }],
    });
    (h.manager as any).onExit("resume-session", 1);
    await entered[0]!.promise;

    const restart = h.manager.start(launchSpec(h.root));
    await entered[1]!.promise;
    assert.deepEqual([...(h.manager as any).admitted], ["resume-session"]);

    gates[0]!.resolve();
    await tick();
    await tick();

    assert.deepEqual(
      [...(h.manager as any).admitted],
      ["resume-session"],
      "the stale recovery cannot release the replacement-owned admission",
    );
    assert.equal(
      h.store.acquireLock("resume-session", "third-runner"),
      false,
      "the stale recovery cannot release the replacement-owned same-owner lock",
    );
    assert.equal((h.manager as any).recoveryQueues.has("resume-session"), false);
    assert.equal(h.launches.length, 0, "both generations are still before driver construction");
    assert.deepEqual(h.disposals, [], "the stale recovery has no replacement cleanup authority");
    assert.deepEqual(
      failures,
      [["session lifecycle discarded the recovered command queue", "COMMAND_CANCELLED"]],
      "Restart rejects the recovered receipt exactly once; the stale recovery adds no duplicate",
    );
    assert.equal(
      h.sent.some((message) =>
        message.type === "session_event" && message.payload.kind === "error" &&
        /remain held|resume error|could not recover/i.test(message.payload.message)),
      false,
      "the superseded recovery does not publish a stale retry error",
    );

    gates[1]!.resolve();
    assert.equal(await restart, true);
  } finally {
    gates[0]!.resolve();
    gates[1]!.resolve();
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("Restart superseding capacity-queued recovery keeps the replacement admission wait and lock", async () => {
  const failures: Array<[string, string | undefined]> = [];
  const durable: DurableCommandLifecycle = {
    commandId: "capacity-queued-recovery",
    queued: () => {},
    started: () => {},
    completed: () => {},
    failed: (error, code) => failures.push([error, code]),
    uncertain: () => {},
  };
  const h = harness(
    { status: "running" },
    Promise.resolve(),
    Promise.resolve(),
    () => {},
    undefined,
    undefined,
    1,
  );
  const internals = h.manager as any;
  try {
    h.store.create(stored(h.root, {
      sessionId: "capacity-blocker",
      agentSessionId: null,
      status: "running",
    }));
    assert.equal(await internals.acquireAdmission("capacity-blocker"), true);
    internals.active.set("resume-session", {
      sessionId: "resume-session",
      client: { resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "thread-persisted" },
      repoPath: h.root, cwd: h.root, worktree: null, status: "running", running: true,
      queue: [{ id: "held", text: "discarded by restart", images: [], durable }],
    });
    internals.onExit("resume-session", 1);
    await tick();
    assert.deepEqual(
      internals.admissionQueue.map((entry: { request: { sessionId: string } }) => entry.request.sessionId),
      ["resume-session"],
    );

    const restart = h.manager.start(launchSpec(h.root));
    await tick();
    await tick();

    assert.deepEqual(
      internals.admissionQueue.map((entry: { request: { sessionId: string } }) => entry.request.sessionId),
      ["resume-session"],
      "the replacement's capacity waiter survives the stale recovery continuation",
    );
    assert.deepEqual([...internals.admitted], ["capacity-blocker"]);
    assert.equal(
      h.store.acquireLock("resume-session", "third-runner"),
      false,
      "the stale recovery admission cancellation cannot release the replacement-owned lock",
    );
    assert.deepEqual(
      failures,
      [["session lifecycle discarded the recovered command queue", "COMMAND_CANCELLED"]],
      "Restart rejects the recovered receipt once; the stale waiter adds no duplicate",
    );
    assert.equal(h.launches.length, 0);
    assert.deepEqual(h.disposals, []);
    assert.equal(
      h.sent.some((message) =>
        message.type === "session_event" && message.payload.kind === "error" &&
        /remain held|resume error|could not recover/i.test(message.payload.message)),
      false,
      "the stale admission cancellation does not publish a recovery error",
    );

    internals.releaseAdmission("capacity-blocker");
    assert.equal(await restart, true);
    assert.deepEqual([...internals.admitted], ["resume-session"]);
  } finally {
    internals.releaseAdmission("capacity-blocker");
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("cancelling capacity-queued recovery releases its lock while retaining the recovery queue", async () => {
  const h = harness(
    { status: "running" }, Promise.resolve(), Promise.resolve(), () => {}, undefined, undefined, 1,
  );
  const internals = h.manager as any;
  try {
    h.store.create(stored(h.root, {
      sessionId: "capacity-blocker", agentSessionId: null, status: "running",
    }));
    assert.equal(await internals.acquireAdmission("capacity-blocker"), true);
    internals.active.set("resume-session", {
      sessionId: "resume-session",
      client: { resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "thread-persisted" },
      repoPath: h.root, cwd: h.root, worktree: null, status: "running", running: true,
      queue: [{ id: "held", text: "retry later", images: [] }],
    });
    internals.onExit("resume-session", 1);
    await tick();
    assert.deepEqual(
      internals.admissionQueue.map((entry: { request: { sessionId: string } }) => entry.request.sessionId),
      ["resume-session"],
    );

    h.manager.cancel("resume-session");
    await tick();
    await tick();

    assert.equal(internals.recoveryQueues.has("resume-session"), true);
    assert.deepEqual([...internals.admitted], ["capacity-blocker"]);
    assert.equal(h.store.acquireLock("resume-session", "third-runner"), true);
    h.store.releaseLock("resume-session", "third-runner");
  } finally {
    internals.releaseAdmission("capacity-blocker");
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("cancelling recovery after immediate admission releases its pre-provider lock", async () => {
  const h = harness({ status: "running" });
  const internals = h.manager as any;
  const acquireAdmission = internals.acquireAdmission.bind(h.manager);
  internals.acquireAdmission = (sessionId: string) => {
    const admitted = acquireAdmission(sessionId);
    h.manager.cancel(sessionId);
    return admitted;
  };
  try {
    internals.active.set("resume-session", {
      sessionId: "resume-session",
      client: { resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "thread-persisted" },
      repoPath: h.root, cwd: h.root, worktree: null, status: "running", running: true,
      queue: [{ id: "held", text: "retry later", images: [] }],
    });
    internals.onExit("resume-session", 1);
    await tick();
    await tick();

    assert.equal(internals.recoveryQueues.has("resume-session"), true);
    assert.equal(internals.admitted.size, 0);
    assert.equal(h.launches.length, 0);
    assert.equal(h.store.acquireLock("resume-session", "third-runner"), true);
    h.store.releaseLock("resume-session", "third-runner");
  } finally {
    h.manager.shutdownAll();
    h.cleanup();
  }
});

test("cancelling recovery during deferred launch preparation releases its lock", async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  const h = harness({ status: "running" }, Promise.resolve(), Promise.resolve(), () => {}, async () => {
    entered.resolve();
    await gate.promise;
  });
  const internals = h.manager as any;
  try {
    internals.active.set("resume-session", {
      sessionId: "resume-session",
      client: { resolvePermission: () => false, cancel: () => {}, dispose: () => {}, setConfig: () => {}, agentSessionId: () => "thread-persisted" },
      repoPath: h.root, cwd: h.root, worktree: null, status: "running", running: true,
      queue: [{ id: "held", text: "retry later", images: [] }],
    });
    internals.onExit("resume-session", 1);
    await entered.promise;
    h.manager.cancel("resume-session");
    gate.resolve();
    await tick();
    await tick();

    assert.equal(internals.recoveryQueues.has("resume-session"), true);
    assert.equal(internals.admitted.size, 0);
    assert.equal(h.launches.length, 0);
    assert.equal(h.store.acquireLock("resume-session", "third-runner"), true);
    h.store.releaseLock("resume-session", "third-runner");
  } finally {
    gate.resolve();
    h.manager.shutdownAll();
    h.cleanup();
  }
});
