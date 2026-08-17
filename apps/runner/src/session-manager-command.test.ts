import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  AgentSlashCommand,
  InvokeSessionCommandMessage,
  RunnerToControlPlane,
  SessionCommandInvocationErrorCode,
  SessionQueueMessage,
} from "@wollipog/protocol";
import type {
  Driver,
  DriverCommandInput,
  DriverCallbacks,
  PreparedDriverCommand,
} from "./drivers/driver.js";
import {
  SessionManager,
  type SessionCommandInvocationLifecycle,
} from "./session-manager.js";
import { setGitRunnerForTests } from "./git-ops.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function cleanupGitFixture(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY") || attempt === 19) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function applyRefTransaction(
  input: string | undefined,
  refs: Map<string, string>,
  beforeUpdate?: (name: string, oid: string) => Promise<void>,
): Promise<void> {
  const next = new Map(refs);
  for (const line of input?.trim().split("\n") ?? []) {
    if (!line) continue;
    const [command, name, oid] = line.split(" ");
    if (!name) throw new Error(`invalid ref transaction command: ${line}`);
    if (command === "update") {
      if (!oid) throw new Error(`invalid ref update command: ${line}`);
      await beforeUpdate?.(name, oid);
      next.set(name, oid);
    } else if (command === "delete") {
      next.delete(name);
    } else if (command === "verify") {
      if (next.get(name) !== oid) throw new Error(`ref verification failed: ${name}`);
    } else if (command === "create") {
      if (!oid || next.has(name)) throw new Error(`ref creation failed: ${name}`);
      next.set(name, oid);
    } else {
      throw new Error(`unsupported ref transaction command: ${line}`);
    }
  }
  refs.clear();
  for (const [name, oid] of next) refs.set(name, oid);
}

async function waitFor(predicate: () => boolean, message = "condition should settle"): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, message);
}

type Receipt = {
  state: "queued" | "started" | "completed" | "rejected" | "uncertain";
  code?: SessionCommandInvocationErrorCode;
  error?: string;
  userEventSeq?: number;
};

function receiptLifecycle(
  invocationId: string,
  receipts: Receipt[],
  onStarted?: (seq: number | undefined) => void,
): SessionCommandInvocationLifecycle {
  return {
    invocationId,
    queued: () => receipts.push({ state: "queued" }),
    started: (userEventSeq) => {
      onStarted?.(userEventSeq);
      receipts.push({ state: "started", userEventSeq });
    },
    completed: () => receipts.push({ state: "completed" }),
    failed: (error, code) => receipts.push({ state: "rejected", error, code }),
    uncertain: (error) => receipts.push({ state: "uncertain", error }),
  };
}

function message(
  invocation: NonNullable<AgentSlashCommand["invocation"]>,
  overrides: Partial<InvokeSessionCommandMessage> = {},
): InvokeSessionCommandMessage {
  return {
    type: "invoke_session_command",
    requestId: `request-${overrides.invocationId ?? "one"}`,
    invocationId: "invocation-one",
    submissionId: "submission-one",
    payloadDigest: "runner-manager-test-does-not-claim-the-journal",
    expiresAt: Date.now() + 60_000,
    sessionId: "command-session",
    providerCommandId: invocation.id,
    catalogRevision: invocation.catalogRevision,
    expectedExecutionMode: invocation.executionMode,
    argumentText: "production",
    ...overrides,
  };
}

function harness(options: {
  fresh?: boolean;
  commands?: AgentSlashCommand[];
  invokeGate?: Promise<"end_turn">;
  driverKind?: "claude-code" | "acp";
  newSessionGate?: Promise<string>;
  agentTurnId?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-session-command-"));
  const store = new SessionStore(root);
  const sent: RunnerToControlPlane[] = [];
  const boundary: string[] = [];
  const preparedInputs: DriverCommandInput[] = [];
  const invoked: PreparedDriverCommand[] = [];
  const prepared = new WeakSet<object>();
  let callbacks: DriverCallbacks | undefined;
  const commands = options.commands ?? [{
    name: "deploy",
    source: "project" as const,
    description: "Deploy the application",
    argumentHint: "<environment>",
  }];

  const driver: Driver = {
    get pid() { return undefined; },
    initialize: async () => {},
    newSession: async () => {
      if (options.driverKind === "acp") {
        callbacks?.onAcpSessionState?.({ capabilities: { slashCommands: commands }, config: {} });
      }
      return options.newSessionGate ?? "provider-session";
    },
    agentSessionId: () => "provider-session",
    agentTurnId: () => options.agentTurnId ?? null,
    prompt: async () => "end_turn",
    prepareCommand: (input) => {
      boundary.push("prepare");
      preparedInputs.push(input);
      const value = {
        commandName: input.commandName,
        argumentText: input.argumentText,
        executionMode: "passthrough" as const,
      } as PreparedDriverCommand;
      prepared.add(value);
      return value;
    },
    invokeCommand: (value) => {
      boundary.push("invoke");
      assert.equal(prepared.delete(value), true, "invoke receives the exact single-use prepared token");
      invoked.push(value);
      return options.invokeGate ?? Promise.resolve("end_turn");
    },
    setConfig: () => {},
    cancel: () => {},
    resolvePermission: () => false,
    dispose: () => {},
  };

  const manager = new SessionManager(
    (event) => sent.push(event),
    () => {},
    store,
    "command-runner",
    undefined,
    (_kind, _opts, cb) => {
      callbacks = cb;
      return driver;
    },
    undefined,
    4,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    (meta: SessionMeta) => {
      if (options.driverKind === "acp") return undefined;
      meta.sessionSlashCommands = commands;
      return options.fresh === false
        ? undefined
        : {
            sessionCommandCatalogFresh: true,
            sessionCommandCatalogProvenance: "claude-code:test-project-root",
          };
    },
  );

  const start = () => manager.start({
    sessionId: "command-session",
    workspaceId: "workspace",
    workspacePath: root,
    agentId: options.driverKind === "acp" ? "acp-test" : "claude-native",
    driver: options.driverKind ?? "claude-code",
    command: options.driverKind === "acp" ? "acp-agent" : "claude",
    args: [],
    env: {},
    useWorktree: false,
    title: "",
    titleSource: "generated",
  });

  return {
    root,
    store,
    sent,
    boundary,
    preparedInputs,
    invoked,
    callbacks: () => callbacks!,
    manager,
    start,
    cleanup: () => {
      manager.shutdownAll();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

function liveCommand(manager: SessionManager): AgentSlashCommand & {
  invocation: NonNullable<AgentSlashCommand["invocation"]>;
} {
  const command = manager.sessionSnapshots()[0]?.agentCapabilities?.slashCommands?.[0];
  assert.ok(command?.invocation, "a v75 snapshot exposes authority only for the fresh live catalog");
  assert.match(command.invocation.id, /^command_[0-9a-f-]{36}$/);
  assert.match(command.invocation.catalogRevision, /^catalog_[0-9a-f-]{36}$/);
  return command as AgentSlashCommand & { invocation: NonNullable<AgentSlashCommand["invocation"]> };
}

test("fresh v75 commands use a durable, provenance-preserving provider boundary and reject a rotated catalog", async () => {
  const provider = deferred<"end_turn">();
  const h = harness({ invokeGate: provider.promise });
  try {
    assert.equal(await h.start(), true);
    const command = liveCommand(h.manager);
    const firstReceipts: Receipt[] = [];
    const first = message(command.invocation);
    assert.equal(h.manager.canRecoverSessionCommand(first), true,
      "fresh ready authority and queue capacity permit journal recovery");
    const firstLifecycle = receiptLifecycle(first.invocationId, firstReceipts, (userEventSeq) => {
      assert.ok(userEventSeq, "started carries the already-durable user event sequence");
      const durable = h.store.readEvents(first.sessionId).find((event) => event.seq === userEventSeq);
      assert.equal(durable?.payload.kind, "user_message");
      h.boundary.push("started");
    });

    assert.equal(h.manager.invokeSessionCommand(first, firstLifecycle), true);
    assert.equal(firstReceipts[0]?.state, "queued");
    await waitFor(() => h.invoked.length === 1, "the first provider command should start");
    assert.deepEqual(h.boundary, ["prepare", "started", "invoke"]);
    assert.deepEqual(h.preparedInputs, [{
      commandName: "deploy",
      argumentText: "production",
      executionMode: "passthrough",
    }]);
    assert.deepEqual(firstReceipts.map((receipt) => receipt.state), ["queued", "started"]);

    const structuredReceipts: Receipt[] = [];
    assert.equal(h.manager.invokeSessionCommand(message(command.invocation, {
      invocationId: "invocation-structured",
      submissionId: "submission-structured",
      expectedExecutionMode: "structured",
    }), receiptLifecycle("invocation-structured", structuredReceipts)), false);
    assert.equal(structuredReceipts[0]?.state, "rejected");
    assert.equal(structuredReceipts[0]?.code, "COMMAND_MODE_UNSUPPORTED");

    const racedReceipts: Receipt[] = [];
    assert.equal(h.manager.invokeSessionCommand(message(command.invocation, {
      invocationId: "invocation-raced",
      submissionId: "submission-raced",
      argumentText: "staging",
    }), receiptLifecycle("invocation-raced", racedReceipts)), true);
    assert.deepEqual(racedReceipts, [{ state: "queued" }]);

    // Narrow race seam: rotate live authority after queue admission but before provider dispatch.
    (h.manager as unknown as {
      sessionCommandAuthority: {
        refresh(sessionId: string, commands: AgentSlashCommand[], provenance: string): AgentSlashCommand[];
      };
    }).sessionCommandAuthority.refresh("command-session", [{
      name: "deploy",
      source: "project",
      description: "Rotated deployment command",
    }], "claude-code:rotated-project-root");
    assert.equal(h.manager.canRecoverSessionCommand(message(command.invocation, {
      invocationId: "invocation-stale-recovery",
      submissionId: "submission-stale-recovery",
    })), true, "stale recovered authority is claimed so it can be rejected explicitly");

    provider.resolve("end_turn");
    await waitFor(() => firstReceipts.at(-1)?.state === "completed");
    await waitFor(() => racedReceipts.at(-1)?.state === "rejected");
    assert.deepEqual(firstReceipts.map((receipt) => receipt.state), ["queued", "started", "completed"]);
    assert.equal(racedReceipts.at(-1)?.code, "COMMAND_CATALOG_STALE");
    assert.equal(h.invoked.length, 1, "rotated queued authority is rejected before another provider call");
    assert.equal(h.preparedInputs.length, 1, "rotated queued authority is rejected before prepareCommand");

    const userEvent = h.store.readEvents("command-session").find((event) =>
      event.payload.kind === "user_message" && event.payload.commandInvocation?.invocationId === first.invocationId);
    assert.deepEqual(userEvent?.payload, {
      kind: "user_message",
      text: "/deploy production",
      turnId: userEvent && "turnId" in userEvent.payload ? userEvent.payload.turnId : undefined,
      commandInvocation: {
        invocationId: "invocation-one",
        submissionId: "submission-one",
        providerCommandId: command.invocation.id,
        catalogRevision: command.invocation.catalogRevision,
        commandName: "deploy",
        executionMode: "passthrough",
      },
    });
    assert.equal(h.store.readMeta("command-session")?.title, "");
    assert.equal(h.store.readMeta("command-session")?.titleSource, "generated");
  } finally {
    h.cleanup();
  }
});

test("provider authentication blocks manual commands with a distinct receipt", async () => {
  const provider = deferred<"end_turn">();
  const h = harness({ invokeGate: provider.promise });
  try {
    assert.equal(await h.start(), true);
    const command = liveCommand(h.manager);
    const receipts: Receipt[] = [];
    assert.equal(h.manager.invokeSessionCommand(
      message(command.invocation),
      receiptLifecycle("invocation-one", receipts),
    ), true);
    await waitFor(() => h.invoked.length === 1);

    h.callbacks().onAuthenticationFailure?.();
    provider.resolve("end_turn");
    await waitFor(() => receipts.at(-1)?.state === "rejected");
    assert.equal(receipts.at(-1)?.code, "PROVIDER_AUTHENTICATION_REQUIRED");
    assert.equal(h.store.readMeta("command-session")?.status, "input_required");
    assert.equal(h.store.readMeta("command-session")?.pendingApproval?.kind, "authentication");

    const blockedReceipts: Receipt[] = [];
    assert.equal(h.manager.invokeSessionCommand(
      message(command.invocation, {
        invocationId: "invocation-blocked",
        submissionId: "submission-blocked",
      }),
      receiptLifecycle("invocation-blocked", blockedReceipts),
    ), false);
    assert.equal(blockedReceipts[0]?.code, "PROVIDER_AUTHENTICATION_REQUIRED");
  } finally {
    h.cleanup();
  }
});

test("persisted display-only catalogs cannot authorize a provider command", async () => {
  const h = harness({ fresh: false });
  try {
    assert.equal(await h.start(), true);
    const displayed = h.manager.sessionSnapshots()[0]?.agentCapabilities?.slashCommands?.[0];
    assert.equal(displayed?.name, "deploy");
    assert.equal(displayed?.invocation, undefined);

    const receipts: Receipt[] = [];
    assert.equal(h.manager.invokeSessionCommand(message({
      id: "client-invented-command",
      catalogRevision: "client-invented-catalog",
      executionMode: "passthrough",
    }), receiptLifecycle("invocation-display-only", receipts)), false);
    assert.equal(receipts[0]?.state, "rejected");
    assert.equal(receipts[0]?.code, "COMMAND_UNAVAILABLE");
    assert.deepEqual(h.preparedInputs, []);
    assert.deepEqual(h.invoked, []);
  } finally {
    h.cleanup();
  }
});

test("ACP catalogs remain display-only until session launch and config restoration finish", async () => {
  const launch = deferred<string>();
  const h = harness({ driverKind: "acp", newSessionGate: launch.promise });
  try {
    const starting = h.start();
    await waitFor(() => h.sent.some((event) => event.type === "session_runtime_updated"),
      "the early ACP catalog should be published for display");
    const early = h.manager.sessionSnapshots()[0]?.agentCapabilities?.slashCommands?.[0];
    assert.equal(early?.name, "deploy");
    assert.equal(early?.invocation, undefined, "launch-time ACP updates must not expose authority");

    const receipts: Receipt[] = [];
    assert.equal(h.manager.invokeSessionCommand(message({
      id: "early-command",
      catalogRevision: "early-catalog",
      executionMode: "structured",
    }), receiptLifecycle("invocation-before-ready", receipts)), false);
    assert.equal(receipts[0]?.code, "COMMAND_UNAVAILABLE");
    assert.match(receipts[0]?.error ?? "", /launch completes/);

    launch.resolve("provider-session");
    assert.equal(await starting, true);
    const ready = liveCommand(h.manager);
    assert.equal(ready.invocation.executionMode, "structured");
  } finally {
    h.cleanup();
  }
});

test("a command checkpoint history failure aborts before provider submission", async () => {
  const h = harness();
  try {
    assert.equal(await h.start(), true);
    const command = liveCommand(h.manager);
    setGitRunnerForTests(async (_cwd, args) => args[0] === "write-tree" ? "tree-checkpoint" : "");
    const entry = (h.manager as any).active.get("command-session");
    entry.worktree = { path: h.root, branch: "test/checkpoint" };
    const appendEvent = h.store.appendEvent.bind(h.store);
    (h.store as any).appendEvent = (sessionId: string, payload: { kind: string }, ts?: number) => {
      if (payload.kind === "checkpoint") throw new Error("checkpoint append failed");
      return appendEvent(sessionId, payload as any, ts);
    };
    const receipts: Receipt[] = [];
    const request = message(command.invocation, {
      invocationId: "invocation-checkpoint-failure",
      submissionId: "submission-checkpoint-failure",
    });
    assert.equal(h.manager.invokeSessionCommand(
      request,
      receiptLifecycle(request.invocationId, receipts),
    ), true);
    await waitFor(() => receipts.at(-1)?.state === "rejected");
    await waitFor(() => !(h.manager as any).active.get("command-session")?.running,
      "the rejected command drain should release its store and git resources");
    assert.deepEqual(receipts.map((receipt) => receipt.state), ["queued", "rejected"]);
    assert.equal(h.invoked.length, 0, "checkpoint failure must abort before invokeCommand");
  } finally {
    setGitRunnerForTests();
    h.cleanup();
  }
});

test("unreadable checkpoint refs do not block provider commands or create a checkpoint", async () => {
  const h = harness();
  try {
    assert.equal(await h.start(), true);
    const command = liveCommand(h.manager);
    const entry = (h.manager as any).active.get("command-session");
    entry.worktree = { path: h.root, branch: "test/unreadable-checkpoint" };
    setGitRunnerForTests(async (_cwd, args) => {
      if (args[0] === "write-tree" || args[0] === "for-each-ref") {
        throw new Error("checkpoint repository is unreadable");
      }
      return "";
    });

    const receipts: Receipt[] = [];
    const request = message(command.invocation, {
      invocationId: "invocation-unreadable-checkpoint",
      submissionId: "submission-unreadable-checkpoint",
    });
    assert.equal(h.manager.invokeSessionCommand(
      request,
      receiptLifecycle(request.invocationId, receipts),
    ), true);
    await waitFor(() => receipts.at(-1)?.state === "completed");

    assert.equal(h.invoked.length, 1, "the command still reaches the provider");
    assert.equal(h.store.readMeta("command-session")?.turnCount, 1);
    assert.equal(
      h.store.readEvents("command-session").some((event) => event.payload.kind === "checkpoint"),
      false,
      "an unreadable snapshot/ref store cannot advertise a rewind checkpoint",
    );
  } finally {
    setGitRunnerForTests();
    h.cleanup();
  }
});

test("divergent checkpoint refs reject only that command and preserve the queued session", async () => {
  const h = harness();
  let refReads = 0;
  try {
    assert.equal(await h.start(), true);
    const command = liveCommand(h.manager);
    const entry = (h.manager as any).active.get("command-session");
    entry.worktree = { path: h.root, branch: "test/divergent-checkpoint" };
    setGitRunnerForTests(async (_cwd, args) => {
      if (args[0] === "write-tree") return "command-checkpoint-tree";
      if (args[0] === "for-each-ref") {
        refReads += 1;
        if (refReads <= 2) {
          return [
            "refs/wollipog/command-session/turn-1\tcurrent-tree",
            "refs/mam/command-session/turn-1\tlegacy-tree",
          ].join("\n");
        }
        return "";
      }
      return "";
    });

    const rejected: Receipt[] = [];
    const first = message(command.invocation, {
      invocationId: "invocation-divergent-checkpoint",
      submissionId: "submission-divergent-checkpoint",
    });
    const surviving: Receipt[] = [];
    const second = message(command.invocation, {
      invocationId: "invocation-after-divergence",
      submissionId: "submission-after-divergence",
    });
    assert.equal(h.manager.invokeSessionCommand(first, receiptLifecycle(first.invocationId, rejected)), true);
    assert.equal(h.manager.invokeSessionCommand(second, receiptLifecycle(second.invocationId, surviving)), true);

    await waitFor(() => rejected.at(-1)?.state === "rejected");
    await waitFor(() => surviving.at(-1)?.state === "completed");
    assert.equal(rejected.at(-1)?.code, "INVALID_COMMAND");
    assert.match(rejected.at(-1)?.error ?? "", /checkpoint refs.*diverged/i);
    assert.deepEqual(surviving.map((receipt) => receipt.state), ["queued", "started", "completed"]);
    assert.equal(h.invoked.length, 1, "the later queued command still reaches the provider");
    assert.notEqual(h.store.readMeta("command-session")?.status, "failed",
      "a repairable ref divergence does not fail the provider session");
  } finally {
    setGitRunnerForTests();
    h.cleanup();
  }
});

test("catalog rotation during command checkpoint anchoring restores prior turn accounting and ref", async () => {
  const anchorGate = deferred<void>();
  const h = harness();
  const turnRefs = new Map<string, string>([
    ["refs/mam/command-session/turn-5", "prior-turn-tree"],
    ["refs/wollipog/command-session/turn-5", "prior-turn-tree"],
  ]);
  let anchoring = false;
  try {
    assert.equal(await h.start(), true);
    const command = liveCommand(h.manager);
    h.store.patchMeta("command-session", { turnCount: 4, lastTurnBaseTree: "prior-base-tree" });
    const entry = (h.manager as any).active.get("command-session");
    entry.worktree = { path: h.root, branch: "test/checkpoint-race" };
    setGitRunnerForTests(async (_cwd, args, opts) => {
      if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") return "";
      if (args[0] === "for-each-ref") {
        const patterns = args.slice(2);
        return [...turnRefs]
          .filter(([name]) => patterns.some((pattern) => name === pattern || name.startsWith(pattern)))
          .map(([name, oid]) => `${name}\t${oid}`)
          .join("\n");
      }
      if (args[0] === "write-tree") return "prepared-turn-tree";
      if (args[0] === "update-ref" && args[1] === "--stdin") {
        await applyRefTransaction(opts?.stdin, turnRefs, async (_name, oid) => {
          if (oid === "prepared-turn-tree" && !anchoring) {
            anchoring = true;
            await anchorGate.promise;
          }
        });
        return "";
      }
      return "";
    });

    const receipts: Receipt[] = [];
    const request = message(command.invocation, {
      invocationId: "invocation-anchor-race",
      submissionId: "submission-anchor-race",
    });
    assert.equal(h.manager.invokeSessionCommand(
      request,
      receiptLifecycle(request.invocationId, receipts),
    ), true);
    await waitFor(() => anchoring, "command should suspend while its checkpoint ref is prepared");
    (h.manager as any).sessionCommandAuthority.refresh("command-session", [{
      name: "deploy",
      source: "project",
      description: "Rotated while anchoring",
    }], "claude-code:anchor-race");
    anchorGate.resolve();

    await waitFor(() => receipts.at(-1)?.state === "rejected");
    assert.equal(receipts.at(-1)?.code, "COMMAND_CATALOG_STALE");
    assert.equal(h.invoked.length, 0);
    assert.equal(h.store.readMeta("command-session")?.turnCount, 4);
    assert.equal(h.store.readMeta("command-session")?.lastTurnBaseTree, "prior-base-tree");
    assert.equal(turnRefs.get("refs/mam/command-session/turn-5"), "prior-turn-tree");
    assert.equal(turnRefs.get("refs/wollipog/command-session/turn-5"), "prior-turn-tree");
    assert.equal(h.store.readEvents("command-session").some((event) => event.payload.kind === "checkpoint"), false);
  } finally {
    setGitRunnerForTests();
    h.cleanup();
  }
});

test("cancellation during command snapshot capture leaves no turn accounting or orphan ref", async () => {
  const snapshotGate = deferred<void>();
  const h = harness();
  const turnRefs = new Map<string, string>();
  let capturing = false;
  try {
    assert.equal(await h.start(), true);
    const command = liveCommand(h.manager);
    h.store.patchMeta("command-session", { turnCount: 2, lastTurnBaseTree: "prior-base-tree" });
    const entry = (h.manager as any).active.get("command-session");
    entry.worktree = { path: h.root, branch: "test/checkpoint-cancel" };
    setGitRunnerForTests(async (_cwd, args, opts) => {
      if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") return "";
      if (args[0] === "rev-parse" && args[1] === "--verify") return turnRefs.get(args.at(-1) ?? "") ?? "";
      if (args[0] === "write-tree") {
        capturing = true;
        await snapshotGate.promise;
        return "cancelled-turn-tree";
      }
      if (args[0] === "update-ref" && args[1] === "--stdin") await applyRefTransaction(opts?.stdin, turnRefs);
      return "";
    });

    const receipts: Receipt[] = [];
    const request = message(command.invocation, {
      invocationId: "invocation-snapshot-cancel",
      submissionId: "submission-snapshot-cancel",
    });
    assert.equal(h.manager.invokeSessionCommand(
      request,
      receiptLifecycle(request.invocationId, receipts),
    ), true);
    await waitFor(() => capturing, "command should suspend while its snapshot is captured");
    h.manager.cancel("command-session");
    snapshotGate.resolve();

    await waitFor(() => receipts.at(-1)?.state === "rejected");
    assert.equal(receipts.at(-1)?.code, "COMMAND_CANCELLED");
    assert.equal(h.invoked.length, 0);
    assert.equal(h.store.readMeta("command-session")?.turnCount, 2);
    assert.equal(h.store.readMeta("command-session")?.lastTurnBaseTree, "prior-base-tree");
    assert.equal(turnRefs.size, 0);
    assert.equal(h.store.readEvents("command-session").some((event) => event.payload.kind === "checkpoint"), false);
  } finally {
    snapshotGate.resolve();
    setGitRunnerForTests();
    h.cleanup();
  }
});

test("successful fork-capable command turns persist the pre-turn checkpoint and post-turn fork point", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "wollipog-session-command-fork-"));
  const repo = join(fixture, "worktree");
  const h = harness({ agentTurnId: "provider-turn-command" });
  const anchoredRefs = new Map<string, string>();
  try {
    git(fixture, ["init", "-q", "--separate-git-dir", join(fixture, "git-data"), repo]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "tracked.txt"), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const baseCommit = git(repo, ["rev-parse", "HEAD"]);

    assert.equal(await h.start(), true);
    const command = liveCommand(h.manager);
    const entry = (h.manager as any).active.get("command-session");
    entry.worktree = { path: repo, branch: "test/fork-command" };
    const meta = h.store.readMeta("command-session")!;
    h.store.patchMeta("command-session", {
      capabilities: { ...meta.capabilities, supportsConversationFork: true },
    });
    setGitRunnerForTests(async (cwd, args, opts) => {
      if (args[0] === "update-ref" && args[1] === "--stdin") {
        await applyRefTransaction(opts?.stdin, anchoredRefs);
        return "";
      }
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: opts?.env ? { ...process.env, ...opts.env } : undefined,
        input: opts?.stdin,
        timeout: opts?.timeoutMs,
      });
    });

    const receipts: Receipt[] = [];
    const request = message(command.invocation, {
      invocationId: "invocation-fork-point",
      submissionId: "submission-fork-point",
    });
    assert.equal(h.manager.invokeSessionCommand(
      request,
      receiptLifecycle(request.invocationId, receipts),
    ), true);
    await waitFor(() => receipts.at(-1)?.state === "completed");

    const updated = h.store.readMeta("command-session")!;
    assert.equal(updated.turnCount, 1);
    assert.ok(updated.lastTurnBaseTree);
    assert.equal(anchoredRefs.get("refs/mam/command-session/turn-1"), updated.lastTurnBaseTree);
    assert.equal(anchoredRefs.get("refs/wollipog/command-session/turn-1"), updated.lastTurnBaseTree);
    const forkPoint = updated.forkPoints?.["1"];
    assert.equal(forkPoint?.agentTurnId, "provider-turn-command");
    assert.equal(forkPoint?.baseCommit, baseCommit);
    assert.ok(forkPoint?.tree);
    assert.equal(anchoredRefs.get("refs/mam/command-session/fork-1"), forkPoint?.tree);
    assert.equal(anchoredRefs.get("refs/wollipog/command-session/fork-1"), forkPoint?.tree);
    const events = h.store.readEvents("command-session");
    assert.equal(events.some((event) => event.payload.kind === "checkpoint" && event.payload.turn === 1), true);
    assert.equal(events.some((event) => event.payload.kind === "conversation_checkpoint" && event.payload.turn === 1), true);
  } finally {
    setGitRunnerForTests();
    h.cleanup();
    await cleanupGitFixture(fixture);
  }
});

test("authority revocation contains publication failures", async () => {
  const h = harness();
  try {
    assert.equal(await h.start(), true);
    liveCommand(h.manager);
    h.manager.setSend(() => { throw new Error("socket closed"); });
    assert.doesNotThrow(() => (h.manager as any).revokeSessionCommandAuthority("command-session"));
  } finally {
    h.cleanup();
  }
});

test("provider failure after submission remains delivery-uncertain", async () => {
  const provider = deferred<"end_turn">();
  const h = harness({ invokeGate: provider.promise });
  try {
    assert.equal(await h.start(), true);
    const command = liveCommand(h.manager);
    const receipts: Receipt[] = [];
    assert.equal(h.manager.invokeSessionCommand(message(command.invocation, {
      invocationId: "invocation-transport-loss",
      submissionId: "submission-transport-loss",
    }), receiptLifecycle("invocation-transport-loss", receipts)), true);
    await waitFor(() => h.invoked.length === 1);
    provider.reject(new Error("connection lost after request write"));
    await waitFor(() => receipts.at(-1)?.state === "uncertain");
    assert.deepEqual(receipts.map((receipt) => receipt.state), ["queued", "started", "uncertain"]);
    assert.match(receipts.at(-1)?.error ?? "", /delivery or completion is uncertain/);
  } finally {
    h.cleanup();
  }
});

test("a governance-cancelled provider command rejection settles idle and completed without an error", async () => {
  const provider = deferred<"end_turn">();
  const h = harness({ invokeGate: provider.promise });
  try {
    assert.equal(await h.start(), true);
    const command = liveCommand(h.manager);
    const receipts: Receipt[] = [];
    const request = message(command.invocation, {
      invocationId: "invocation-governance-trip",
      submissionId: "submission-governance-trip",
    });
    assert.equal(h.manager.invokeSessionCommand(
      request,
      receiptLifecycle(request.invocationId, receipts),
    ), true);
    await waitFor(() => h.invoked.length === 1);

    const entry = (h.manager as any).active.get("command-session");
    h.store.patchMeta("command-session", { config: { maxToolCalls: 1 } });
    entry.toolCallIds = new Set<string>();
    (h.manager as any).onDriverEvent("command-session", {
      kind: "tool_call",
      toolCallId: "governed-tool",
      title: "Governed Tool",
      status: "pending",
    });
    assert.equal(entry.governanceTripped, "max_tool_calls");

    provider.reject(new Error("provider rejected after governance cancellation"));
    await waitFor(() => receipts.at(-1)?.state === "completed");
    assert.deepEqual(receipts.map((receipt) => receipt.state), ["queued", "started", "completed"]);
    assert.equal(h.store.readMeta("command-session")?.status, "idle");
    assert.equal(h.sent.some((event) =>
      event.type === "session_event" && event.payload.kind === "error"), false);
  } finally {
    h.cleanup();
  }
});

test("cancelling or stopping queued commands settles them as rejected without provider delivery", async () => {
  const provider = deferred<"end_turn">();
  const h = harness({ invokeGate: provider.promise });
  try {
    assert.equal(await h.start(), true);
    const command = liveCommand(h.manager);
    const runningReceipts: Receipt[] = [];
    assert.equal(h.manager.invokeSessionCommand(message(command.invocation, {
      invocationId: "invocation-running",
      submissionId: "submission-running",
      argumentText: "running",
    }), receiptLifecycle("invocation-running", runningReceipts)), true);
    await waitFor(() => h.invoked.length === 1);

    const cancelledReceipts: Receipt[] = [];
    assert.equal(h.manager.invokeSessionCommand(message(command.invocation, {
      invocationId: "invocation-cancelled",
      submissionId: "submission-cancelled",
      argumentText: "cancel me",
    }), receiptLifecycle("invocation-cancelled", cancelledReceipts)), true);
    const queue = h.sent.filter((event): event is SessionQueueMessage =>
      event.type === "session_queue").at(-1);
    const queuedId = queue?.queue.find((entry) => entry.text === "cancel me")?.id;
    assert.ok(queuedId);
    h.manager.removeQueuedPrompt("command-session", queuedId);
    assert.equal(cancelledReceipts.at(-1)?.state, "rejected");
    assert.equal(cancelledReceipts.at(-1)?.code, "COMMAND_CANCELLED");

    const stoppedReceipts: Receipt[] = [];
    assert.equal(h.manager.invokeSessionCommand(message(command.invocation, {
      invocationId: "invocation-stopped",
      submissionId: "submission-stopped",
      argumentText: "stop me",
    }), receiptLifecycle("invocation-stopped", stoppedReceipts)), true);
    h.manager.stop("command-session");
    assert.equal(h.manager.canRecoverSessionCommand(message(command.invocation, {
      invocationId: "inactive-recovery",
      submissionId: "inactive-recovery",
    })), true, "inactive persisted sessions are claimed so recovery can reject them explicitly");
    assert.equal(stoppedReceipts.at(-1)?.state, "rejected");
    assert.equal(stoppedReceipts.at(-1)?.code, "COMMAND_CANCELLED");
    const revoked = h.sent.filter((event) => event.type === "session_runtime_updated").at(-1);
    assert.equal(
      revoked?.type === "session_runtime_updated"
        ? revoked.snapshot.agentCapabilities?.slashCommands?.[0]?.invocation
        : "missing",
      undefined,
      "stopping the provider immediately republishes a display-only catalog",
    );
    assert.equal(h.invoked.length, 1, "neither rejected queued command reached the provider");

    provider.resolve("end_turn");
    await waitFor(() => runningReceipts.at(-1)?.state === "uncertain");
  } finally {
    h.cleanup();
  }
});
