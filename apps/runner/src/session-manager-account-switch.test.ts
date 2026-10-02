import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type {
  AgentDriverKind,
  ProviderAccountDefinition,
  RunnerToControlPlane,
  SessionLaunchSpec,
  SubscriptionUsageSnapshot,
} from "@wollipog/protocol";
import { SessionManager, type ProviderAccountResolver } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

const accounts = {
  work: { id: "work", label: "Work", provider: "codex" as const, credentialHome: "/accounts/work" },
  personal: { id: "personal", label: "Personal", provider: "codex" as const, credentialHome: "/accounts/personal" },
  backup: { id: "backup", label: "Backup", provider: "codex" as const, credentialHome: "/accounts/backup" },
  claudeWork: { id: "claude-work", label: "Claude Work", provider: "claude" as const, credentialHome: "/claude/work" },
  claudePersonal: { id: "claude-personal", label: "Claude Personal", provider: "claude" as const, credentialHome: "/claude/personal" },
};

function accountResolver(spec: SessionLaunchSpec) {
  return Object.values(accounts).find((account) => account.id === spec.providerAccountId);
}

function makeManager(
  root: string,
  driverFactory: (...args: never[]) => unknown,
  messages: RunnerToControlPlane[],
  useRealTranscripts = false,
): { manager: SessionManager; store: SessionStore } {
  const store = new SessionStore(join(root, "data", "sessions"));
  const manager = new SessionManager(
    (message) => messages.push(message),
    () => {},
    store,
    "runner",
    undefined,
    driverFactory as never,
    join(root, "data"),
    1,
  );
  const internals = manager as unknown as {
    resolveProviderAccount: ProviderAccountResolver;
    transferAccountTranscript: () => Promise<void>;
    prepareLaunch: (meta: { providerAccountProvider?: string; providerCredentialHome?: string;
      env: Record<string, string> }) => void | Promise<void>;
  };
  internals.resolveProviderAccount = accountResolver;
  // Fake providers in the lifecycle tests do not write provider history. The filesystem-backed
  // regression below keeps the real transfer so it catches missing history at the resume seam.
  if (!useRealTranscripts) internals.transferAccountTranscript = async () => {};
  internals.prepareLaunch = (meta) => {
    if (!meta.providerCredentialHome) return;
    meta.env = meta.providerAccountProvider === "claude"
      ? { CLAUDE_CONFIG_DIR: meta.providerCredentialHome }
      : { CODEX_HOME: meta.providerCredentialHome };
  };
  return { manager, store };
}

function launchSpec(root: string, driver: AgentDriverKind, providerAccountId: string): SessionLaunchSpec {
  return {
    sessionId: `session-${driver}`,
    workspaceId: "repo",
    workspacePath: root,
    agentId: driver === "claude-code" ? "claude" : "codex",
    providerAccountId,
    command: driver === "claude-code" ? "claude" : "codex",
    args: [],
    env: {},
    useWorktree: false,
    driver,
    context: { kind: "native" },
  };
}

test("an idle Codex session switches credential homes, resumes the same thread, and can switch back", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-codex-"));
  const messages: RunnerToControlPlane[] = [];
  const launches: Array<{ home?: string; resumed?: string }> = [];
  let manager: SessionManager | undefined;
  try {
    const made = makeManager(root, (_driver: unknown, launch: {
      env: Record<string, string>; resumeId?: string;
    }) => {
      const record: { home?: string; resumed?: string } = {
        home: launch.env.CODEX_HOME,
        ...(launch.resumeId ? { resumed: launch.resumeId } : {}),
      };
      launches.push(record);
      return {
        pid: launches.length,
        initialize: async () => {},
        newSession: async () => {},
        prompt: async () => "end_turn" as const,
        cancel: () => {},
        dispose: () => {},
        setConfig: async () => {},
        resolvePermission: () => false,
        agentSessionId: () => "codex-thread",
      };
    }, messages);
    manager = made.manager;
    const spec = launchSpec(root, "codex-app-server", "work");
    assert.equal(await manager.start(spec), true);
    made.store.patchMeta(spec.sessionId, {
      agentSessionId: "codex-thread",
      // This lifecycle fixture represents an already persisted thread. Dedicated filesystem
      // cases below distinguish an unused allocation from attempted or imported history.
      providerUnstartedThreadId: undefined,
      providerCredentialScopeId: "scope-work",
      providerCredentialIdentityId: "identity-work",
      providerCredentialIdentityEvidence: { version: 2, fields: { email: "digest-work" } },
    });

    assert.deepEqual(await manager.switchProviderAccount(spec.sessionId, "personal"), {
      ok: true,
      scheduled: false,
    });
    assert.equal(launches[0]?.home, "/accounts/work");
    assert.deepEqual(launches[1], { home: "/accounts/personal", resumed: "codex-thread" });
    assert.equal(made.store.readMeta(spec.sessionId)?.providerAccountId, "personal");
    assert.equal(made.store.readMeta(spec.sessionId)?.providerCredentialIdentityId, undefined,
      "an intentional account switch starts a fresh provider identity pin");

    assert.deepEqual(await manager.switchProviderAccount(spec.sessionId, "work"), {
      ok: true,
      scheduled: false,
    });
    assert.deepEqual(launches[2], { home: "/accounts/work", resumed: "codex-thread" });
    assert.equal(made.store.readMeta(spec.sessionId)?.providerAccountId, "work");
    assert.equal(made.store.readEvents(spec.sessionId).filter((event) =>
      event.payload.kind === "provider_account_switched").length, 2);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a running Claude turn finishes before the account switch and queued work uses the new account", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-claude-"));
  const messages: RunnerToControlPlane[] = [];
  const launches: string[] = [];
  const prompts: Array<{ home: string; text: string }> = [];
  let finishFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  let manager: SessionManager | undefined;
  try {
    const made = makeManager(root, (_driver: unknown, launch: { env: Record<string, string> }) => {
      const home = launch.env.CLAUDE_CONFIG_DIR!;
      launches.push(home);
      return {
        pid: launches.length,
        initialize: async () => {},
        newSession: async () => {},
        loadSession: async () => {},
        prompt: async (text: string) => {
          prompts.push({ home, text });
          if (text === "first") {
            firstStarted();
            await firstGate;
          }
          return "end_turn" as const;
        },
        cancel: () => {},
        dispose: () => {},
        setConfig: async () => {},
        resolvePermission: () => false,
        agentSessionId: () => "claude-session",
      };
    }, messages);
    manager = made.manager;
    const spec = launchSpec(root, "claude-code", "claude-work");
    assert.equal(await manager.start(spec), true);
    made.store.patchMeta(spec.sessionId, { agentSessionId: "claude-session" });
    assert.equal(manager.prompt(spec.sessionId, "first"), true);
    await started;

    assert.deepEqual(await manager.switchProviderAccount(spec.sessionId, "claude-personal"), {
      ok: true,
      scheduled: true,
    });
    assert.equal(manager.prompt(spec.sessionId, "second"), true);
    assert.deepEqual(launches, ["/claude/work"], "the active turn keeps its original credential home");
    finishFirst();
    await waitFor(() => prompts.some((prompt) => prompt.text === "second"), "queued prompt did not resume");
    assert.deepEqual(prompts, [
      { home: "/claude/work", text: "first" },
      { home: "/claude/personal", text: "second" },
    ]);
  } finally {
    finishFirst?.();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed account resume parks the session with the selected account and a bounded reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-failure-"));
  const messages: RunnerToControlPlane[] = [];
  let launchCount = 0;
  let manager: SessionManager | undefined;
  try {
    const made = makeManager(root, () => {
      launchCount += 1;
      return {
        pid: launchCount,
        initialize: async () => {},
        newSession: async () => {
          if (launchCount > 1) throw new Error("resume refused");
        },
        prompt: async () => "end_turn" as const,
        cancel: () => {},
        dispose: () => {},
        setConfig: async () => {},
        resolvePermission: () => false,
        agentSessionId: () => "codex-thread",
      };
    }, messages);
    manager = made.manager;
    const spec = launchSpec(root, "codex-app-server", "work");
    assert.equal(await manager.start(spec), true);
    made.store.patchMeta(spec.sessionId, { agentSessionId: "codex-thread" });
    assert.deepEqual(await manager.switchProviderAccount(spec.sessionId, "personal"), {
      ok: true,
      scheduled: false,
    });
    const meta = made.store.readMeta(spec.sessionId);
    assert.equal(meta?.status, "input_required");
    assert.equal(meta?.providerAccountId, "personal");
    assert.equal(meta?.providerAccountSwitchFailure?.providerAccountLabel, "Personal");
    assert.match(meta?.providerAccountSwitchFailure?.reason ?? "", /could not resume/);
    assert.equal(meta?.providerCredentialIdentityId, undefined);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const stop of ["end_turn", "refusal"] as const) {
  test(`a later ${stop} turn ${stop === "end_turn" ? "clears" : "keeps"} a stale account switch failure`, async () => {
    const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-later-turn-"));
    const messages: RunnerToControlPlane[] = [];
    let manager: SessionManager | undefined;
    try {
      const made = makeManager(root, () => ({
        pid: 1,
        initialize: async () => {},
        newSession: async () => {},
        prompt: async () => stop,
        cancel: () => {},
        dispose: () => {},
        setConfig: async () => {},
        resolvePermission: () => false,
        agentSessionId: () => "claude-session",
      }), messages);
      manager = made.manager;
      const spec = launchSpec(root, "claude-code", "claude-work");
      assert.equal(await manager.start(spec), true);
      (manager as unknown as {
        parkProviderAccountSwitchFailure: (sessionId: string, target: typeof accounts.claudePersonal,
          reason: string) => void;
      }).parkProviderAccountSwitchFailure(spec.sessionId, accounts.claudePersonal, "the provider conversation cannot be resumed under another account");
      assert.equal(made.store.readMeta(spec.sessionId)?.status, "input_required");
      assert.equal(manager.prompt(spec.sessionId, "Continue the campaign"), true);
      await waitFor(() => made.store.readMeta(spec.sessionId)?.status === "idle", "later turn did not settle");
      assert.equal(Boolean(made.store.readMeta(spec.sessionId)?.providerAccountSwitchFailure), stop === "refusal");
      assert.equal(messages.some((message) => message.type === "session_runtime_updated" &&
        message.snapshot.providerAccountSwitchFailure === null), stop === "end_turn");
    } finally {
      manager?.shutdownAll();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Stop remains terminal while an account-switch replacement is preparing", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-stop-"));
  const messages: RunnerToControlPlane[] = [];
  const launches: string[] = [];
  let releaseRetirement = () => {};
  let manager: SessionManager | undefined;
  try {
    let retirementStartedResolve!: () => void;
    const retirementStarted = new Promise<void>((resolve) => { retirementStartedResolve = resolve; });
    const retirementGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    const made = makeManager(root, (_driver: unknown, launch: { env: Record<string, string> }) => {
      launches.push(launch.env.CODEX_HOME!);
      return {
        pid: launches.length,
        initialize: async () => {},
        newSession: async () => {},
        prompt: async () => "end_turn" as const,
        cancel: () => {},
        dispose: () => {},
        close: async () => {
          retirementStartedResolve();
          await retirementGate;
          return true;
        },
        setConfig: async () => {},
        resolvePermission: () => false,
        agentSessionId: () => "codex-thread",
      };
    }, messages);
    manager = made.manager;
    const internals = manager as unknown as {
      providerAccountSwitches: Map<string, unknown>;
    };
    const spec = launchSpec(root, "codex-app-server", "work");
    assert.equal(await manager.start(spec), true);
    made.store.patchMeta(spec.sessionId, { agentSessionId: "codex-thread" });

    const switching = manager.switchProviderAccount(spec.sessionId, "personal");
    await retirementStarted;
    manager.stop(spec.sessionId);
    releaseRetirement();
    await switching;
    await waitFor(() => !internals.providerAccountSwitches.has(spec.sessionId), "stopped handoff did not settle");

    assert.deepEqual(launches, [accounts.work.credentialHome]);
    assert.equal(made.store.readMeta(spec.sessionId)?.status, "stopped");
    const stopped = made.store.readMeta(spec.sessionId);
    assert.equal(stopped?.providerAccountId, "work", "a superseded handoff cannot silently commit its target account");
    assert.equal(stopped?.pendingProviderAccountId, "personal", "the uncommitted selection stays available after Stop");
    assert.equal(stopped?.providerAccountSwitchFailure, undefined);
  } finally {
    releaseRetirement();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan recovery crosses a pending account-switch barrier before the handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-orphan-"));
  const messages: RunnerToControlPlane[] = [];
  const launches: string[] = [];
  const prompts: Array<{ home: string; text: string }> = [];
  let manager: SessionManager | undefined;
  try {
    const made = makeManager(root, (_driver: unknown, launch: { env: Record<string, string> }) => {
      const home = launch.env.CODEX_HOME!;
      launches.push(home);
      return {
        pid: launches.length,
        initialize: async () => {},
        newSession: async () => {},
        prompt: async (text: string) => { prompts.push({ home, text }); return "end_turn" as const; },
        cancel: () => {},
        dispose: () => {},
        setConfig: async () => {},
        resolvePermission: () => false,
        agentSessionId: () => "codex-thread",
      };
    }, messages);
    manager = made.manager;
    const spec = launchSpec(root, "codex-app-server", "work");
    assert.equal(await manager.start(spec), true);
    made.store.patchMeta(spec.sessionId, {
      agentSessionId: "codex-thread",
      backgroundWorkState: "orphaned",
      pendingBackgroundTaskIds: ["task-1"],
      orphanedWork: { pendingTaskIds: ["task-1"], markedAt: 1, reason: "process_exit" },
    });

    assert.deepEqual(await manager.switchProviderAccount(spec.sessionId, "personal"), {
      ok: true,
      scheduled: true,
    });
    assert.equal(manager.prompt(spec.sessionId, "recover orphaned work", [], undefined, undefined, undefined, true), true);
    await waitFor(() => launches.length === 2, "account switch did not resume after orphan recovery");

    assert.deepEqual(prompts, [{ home: accounts.work.credentialHome, text: "recover orphaned work" }]);
    assert.deepEqual(launches, [accounts.work.credentialHome, accounts.personal.credentialHome]);
    assert.equal(made.store.readMeta(spec.sessionId)?.providerAccountId, "personal");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deferred account switch resumes as soon as background ownership clears", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-background-settled-"));
  const messages: RunnerToControlPlane[] = [];
  const launches: string[] = [];
  let manager: SessionManager | undefined;
  try {
    const made = makeManager(root, (_driver: unknown, launch: { env: Record<string, string> }) => {
      launches.push(launch.env.CODEX_HOME!);
      return {
        pid: launches.length,
        initialize: async () => {},
        newSession: async () => {},
        prompt: async () => "end_turn" as const,
        cancel: () => {},
        dispose: () => {},
        setConfig: async () => {},
        resolvePermission: () => false,
        agentSessionId: () => "codex-thread",
      };
    }, messages);
    manager = made.manager;
    const spec = launchSpec(root, "codex-app-server", "work");
    assert.equal(await manager.start(spec), true);
    made.store.patchMeta(spec.sessionId, {
      agentSessionId: "codex-thread",
      backgroundWorkState: "running",
      pendingBackgroundTaskIds: ["task-1"],
    });

    assert.deepEqual(await manager.switchProviderAccount(spec.sessionId, "personal"), {
      ok: true,
      scheduled: true,
    });
    made.store.patchMeta(spec.sessionId, {
      backgroundWorkState: undefined,
      pendingBackgroundTaskIds: [],
    });
    (manager as unknown as { resumeDeferredHandoff: (sessionId: string) => void })
      .resumeDeferredHandoff(spec.sessionId);
    await waitFor(() => launches.length === 2, "settled background work did not resume the account switch");

    assert.deepEqual(launches, [accounts.work.credentialHome, accounts.personal.credentialHome]);
    assert.equal(made.store.readMeta(spec.sessionId)?.providerAccountId, "personal");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crash-recovered account switch crosses the previous credential's authentication block", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-auth-recovery-"));
  const messages: RunnerToControlPlane[] = [];
  const launches: string[] = [];
  const prompts: Array<{ home: string; text: string }> = [];
  let manager: SessionManager | undefined;
  try {
    const driverFactory = (_driver: unknown, launch: { env: Record<string, string> }) => {
      const home = launch.env.CODEX_HOME!;
      launches.push(home);
      return {
        pid: launches.length,
        initialize: async () => {},
        newSession: async () => {},
        prompt: async (text: string) => { prompts.push({ home, text }); return "end_turn" as const; },
        cancel: () => {},
        dispose: () => {},
        setConfig: async () => {},
        resolvePermission: () => false,
        agentSessionId: () => "codex-thread",
      };
    };
    const first = makeManager(root, driverFactory, messages);
    manager = first.manager;
    const spec = launchSpec(root, "codex-app-server", "work");
    assert.equal(await manager.start(spec), true);
    first.store.patchMeta(spec.sessionId, {
      agentSessionId: "codex-thread",
      pendingProviderAccountId: accounts.personal.id,
      pendingProviderAccountLabel: accounts.personal.label,
      pendingProviderAccountProvider: accounts.personal.provider,
      pendingProviderCredentialHome: accounts.personal.credentialHome,
      providerAuthBlock: {
        version: 1,
        recoveryId: "recovery-work",
        credentialScopeId: "scope-work",
        detectedAt: 1,
        phase: "turn",
        delivery: "uncertain",
        canStartLogin: true,
        configuredCredential: true,
      },
      pendingApproval: {
        requestId: "provider-auth:recovery-work",
        title: "Authentication Required — Codex",
        options: [{ optionId: "auth:cancel", name: "Cancel", kind: "reject_once" }],
      },
    });
    manager.shutdownAll();

    const recovered = makeManager(root, driverFactory, messages);
    manager = recovered.manager;
    assert.equal(await manager.start(spec), true);
    assert.equal(manager.prompt(spec.sessionId, "continue after recovery"), true);
    await waitFor(() => prompts.length === 1, "recovered account switch remained behind the old auth block");

    assert.deepEqual(prompts, [{ home: accounts.personal.credentialHome, text: "continue after recovery" }]);
    assert.equal(recovered.store.readMeta(spec.sessionId)?.providerAuthBlock, undefined);
    assert.equal(recovered.store.readMeta(spec.sessionId)?.providerAccountId, "personal");
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newer account selection made mid-handoff is preserved as a follow-up switch", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-overlap-"));
  const messages: RunnerToControlPlane[] = [];
  const launches: string[] = [];
  let releaseFirstClose = () => {};
  let manager: SessionManager | undefined;
  try {
    let launchCount = 0;
    let firstCloseStartedResolve!: () => void;
    const firstCloseStarted = new Promise<void>((resolve) => { firstCloseStartedResolve = resolve; });
    const firstCloseGate = new Promise<void>((resolve) => { releaseFirstClose = resolve; });
    const made = makeManager(root, (_driver: unknown, launch: { env: Record<string, string> }) => {
      const launchNumber = ++launchCount;
      launches.push(launch.env.CODEX_HOME!);
      return {
        pid: launchNumber,
        initialize: async () => {},
        newSession: async () => {},
        close: async () => {
          if (launchNumber === 1) {
            firstCloseStartedResolve();
            await firstCloseGate;
          }
        },
        prompt: async () => "end_turn" as const,
        cancel: () => {},
        dispose: () => {},
        setConfig: async () => {},
        resolvePermission: () => false,
        agentSessionId: () => "codex-thread",
      };
    }, messages);
    manager = made.manager;
    const spec = launchSpec(root, "codex-app-server", "work");
    assert.equal(await manager.start(spec), true);
    made.store.patchMeta(spec.sessionId, { agentSessionId: "codex-thread" });

    const first = manager.switchProviderAccount(spec.sessionId, "personal");
    await firstCloseStarted;
    assert.deepEqual(await manager.switchProviderAccount(spec.sessionId, "backup"), {
      ok: true,
      scheduled: true,
    });
    releaseFirstClose();
    await first;
    await waitFor(() => launches.length === 3, "newer account selection was not applied");

    assert.deepEqual(launches, [
      accounts.work.credentialHome,
      accounts.personal.credentialHome,
      accounts.backup.credentialHome,
    ]);
    assert.equal(made.store.readMeta(spec.sessionId)?.providerAccountId, "backup");
    assert.equal(made.store.readEvents(spec.sessionId).filter((event) =>
      event.payload.kind === "provider_account_switched").length, 2);
  } finally {
    releaseFirstClose();
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("account-switch failure reasons are bounded and control-free", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-reason-"));
  const messages: RunnerToControlPlane[] = [];
  let manager: SessionManager | undefined;
  try {
    const made = makeManager(root, () => ({
      pid: 1,
      initialize: async () => {},
      newSession: async () => {},
      prompt: async () => "end_turn" as const,
      cancel: () => {},
      dispose: () => {},
      setConfig: async () => {},
      resolvePermission: () => false,
      agentSessionId: () => "codex-thread",
    }), messages);
    manager = made.manager;
    const spec = launchSpec(root, "codex-app-server", "work");
    assert.equal(await manager.start(spec), true);
    (manager as unknown as {
      parkProviderAccountSwitchFailure: (sessionId: string, target: typeof accounts.personal,
        reason: string) => void;
    }).parkProviderAccountSwitchFailure(spec.sessionId, accounts.personal, `\u0000${"x".repeat(1_000)}\nsecret`);
    const reason = made.store.readMeta(spec.sessionId)?.providerAccountSwitchFailure?.reason ?? "";
    assert.equal(reason.length, 500);
    assert.doesNotMatch(reason, /[\p{Cc}\p{Cf}]/u);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exhausted structured window schedules an automatic switch only after the turn settles", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-automatic-"));
  const messages: RunnerToControlPlane[] = [];
  const launches: string[] = [];
  let usageCallback: ((update: { provider: "codex"; kind: "sparse"; payload: unknown }) => void) | undefined;
  let manager: SessionManager | undefined;
  try {
    const made = makeManager(root, (_driver: unknown, launch: { env: Record<string, string> }, callbacks: {
      onSubscriptionUsage?: typeof usageCallback;
    }) => {
      launches.push(launch.env.CODEX_HOME!);
      usageCallback = callbacks.onSubscriptionUsage;
      return {
        pid: launches.length,
        initialize: async () => {},
        newSession: async () => {},
        prompt: async () => {
          usageCallback?.({ provider: "codex", kind: "sparse", payload: {} });
          return "refusal" as const;
        },
        lastTurnError: () => "usage limit reached",
        cancel: () => {},
        dispose: () => {},
        setConfig: async () => {},
        resolvePermission: () => false,
        agentSessionId: () => "codex-thread",
      };
    }, messages);
    manager = made.manager;
    const now = Date.now();
    const current: SubscriptionUsageSnapshot = {
      sourceId: "work", runnerId: "runner", agentId: "codex", provider: "codex",
      providerAccountId: "work", state: "available", fetchedAt: now,
      buckets: [{ id: "five_hour", label: "Five Hour", remainingPercent: 0, usedPercent: 100,
        status: "exhausted", resetsAt: now + 60_000 }],
    };
    const backup: SubscriptionUsageSnapshot = {
      sourceId: "backup", runnerId: "runner", agentId: "codex", provider: "codex",
      providerAccountId: "backup", state: "available", fetchedAt: now,
      buckets: [{ id: "five_hour", label: "Five Hour", remainingPercent: 70, usedPercent: 30,
        status: "available", resetsAt: now + 60_000 }],
    };
    const definitions: ProviderAccountDefinition[] = [
      { id: "work", label: "Work", provider: "codex", authStatus: "authenticated" },
      { id: "backup", label: "Backup", provider: "codex", authStatus: "authenticated" },
    ];
    const internals = manager as unknown as {
      onSubscriptionUsageUpdate: () => SubscriptionUsageSnapshot;
      providerAccounts: () => ProviderAccountDefinition[];
      subscriptionUsageInventory: () => SubscriptionUsageSnapshot[];
    };
    internals.onSubscriptionUsageUpdate = () => current;
    internals.providerAccounts = () => definitions;
    internals.subscriptionUsageInventory = () => [current, backup];
    assert.equal(manager.configureAutomaticAccountSwitch({ enabled: true, revision: 1 }), true);
    const spec = launchSpec(root, "codex-app-server", "work");
    assert.equal(await manager.start(spec), true);
    made.store.patchMeta(spec.sessionId, { agentSessionId: "codex-thread" });

    const idleBefore = messages.filter((message) => message.type === "session_status" &&
      message.sessionId === spec.sessionId && message.status === "idle").length;
    assert.equal(manager.prompt(spec.sessionId, "continue"), true);
    await waitFor(() => messages.filter((message) => message.type === "session_status" &&
      message.sessionId === spec.sessionId && message.status === "idle").length > idleBefore,
    "the rejected turn did not settle while installation selection was unknown");
    assert.deepEqual(launches, [accounts.work.credentialHome]);
    assert.equal(made.store.readMeta(spec.sessionId)?.providerAccountId, "work");

    manager.setAutomaticAccountSwitchAuthorityReady(true);
    assert.equal(manager.prompt(spec.sessionId, "retry after choices synchronize"), true);
    await waitFor(() => launches.length === 2, "automatic account switch did not resume the conversation");

    assert.deepEqual(launches, [accounts.work.credentialHome, accounts.backup.credentialHome]);
    assert.equal(made.store.readMeta(spec.sessionId)?.providerAccountId, "backup");
    assert.equal(made.store.readMeta(spec.sessionId)?.providerAccountAutomaticallySelected, true);
    assert.equal(made.store.readEvents(spec.sessionId).some((event) =>
      event.payload.kind === "provider_account_switched" && event.payload.automatic === true), true);
  } finally {
    manager?.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const driver of ["claude-code", "codex", "codex-app-server"] as const) {
  for (const scenario of ["idle", "dormant", "interrupted transfer", "before first turn", "legacy missing history"] as const) {
    test(`${driver} account switching preserves the transcript for resume and switching back (${scenario})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "wollipog-account-switch-transcript-"));
      const messages: RunnerToControlPlane[] = [];
      const sessionId = "11111111-2222-4333-8444-555555555555";
      const homes = { work: join(root, "work"), personal: join(root, "personal") };
      for (const home of Object.values(homes)) mkdirSync(home, { recursive: true });
      const project = root.replace(/[^a-zA-Z0-9]/g, "-");
      const transcript = (home: string) => driver === "claude-code"
        ? join(home, "projects", project, `${sessionId}.jsonl`)
        : join(home, "sessions", "2026", "09", "30", `rollout-2026-09-30T12-00-00-${sessionId}.jsonl`);
      const failures: string[] = [];
      let completed = 0;
      let manager: SessionManager | undefined;
      try {
        const factory = (_driver: unknown, launch: { env: Record<string, string>; resumeId?: string }) => {
          const home = (driver === "claude-code" ? launch.env.CLAUDE_CONFIG_DIR : launch.env.CODEX_HOME)!;
          let established = Boolean(launch.resumeId);
          return {
            initialize: async () => {},
            newSession: async () => sessionId,
            prompt: async (text: string) => {
              if (launch.resumeId && !existsSync(transcript(home))) {
                failures.push("No conversation found with session ID");
                return "refusal" as const;
              }
              mkdirSync(dirname(transcript(home)), { recursive: true });
              const prior = existsSync(transcript(home)) ? readFileSync(transcript(home), "utf8") : "";
              writeFileSync(transcript(home), prior + JSON.stringify({ type: "user", message: text, sessionId }) + "\n");
              established = true;
              completed++;
              return "end_turn" as const;
            },
            cancel: () => {}, dispose: () => {}, setConfig: async () => {}, resolvePermission: () => false,
            agentSessionId: () => established ? sessionId : null,
          };
        };
        let made = makeManager(root, factory, messages, true);
        manager = made.manager;
        const resolveAccount: ProviderAccountResolver = (spec) => ({
          id: spec.providerAccountId!, label: spec.providerAccountId!, provider: driver === "claude-code" ? "claude" : "codex", credentialHome: homes[spec.providerAccountId as keyof typeof homes],
        });
        (manager as unknown as { resolveProviderAccount: ProviderAccountResolver }).resolveProviderAccount = resolveAccount;
        const spec = launchSpec(root, driver, "work");
        assert.equal(await manager.start(spec), true);
        if (scenario === "before first turn") {
          assert.equal(made.store.readMeta(spec.sessionId)?.agentSessionId, null);
          assert.equal(made.store.readMeta(spec.sessionId)?.seq, 0);
          await manager.switchProviderAccount(spec.sessionId, "personal");
        }
        manager.prompt(spec.sessionId, "first turn");
        await waitFor(() => made.store.readMeta(spec.sessionId)?.status === "idle" && completed === 1, "first turn did not settle");
        if (scenario === "before first turn") {
          await manager.switchProviderAccount(spec.sessionId, "work");
          manager.prompt(spec.sessionId, "Continue, please.");
          await waitFor(() => failures.length > 0 || (completed === 2 && made.store.readMeta(spec.sessionId)?.status === "idle"), "continued turn did not settle");
          assert.deepEqual(failures, [], "a switch before the first turn must remember where that turn saved history");
          return;
        }
        if (scenario === "legacy missing history") {
          // An old runner changed the credential binding without copying history or persisting a
          // source marker. Recovering by selecting the original account must still work.
          manager.shutdownAll();
          made.store.patchMeta(spec.sessionId, {
            providerAccountId: "personal", providerAccountLabel: "personal", providerAccountProvider: driver === "claude-code" ? "claude" : "codex",
            providerCredentialHome: homes.personal, providerConversationHome: undefined,
          });
          made.store.flush(spec.sessionId);
          made = makeManager(root, factory, messages, true);
          manager = made.manager;
          (manager as unknown as { resolveProviderAccount: ProviderAccountResolver }).resolveProviderAccount = resolveAccount;
          await manager.switchProviderAccount(spec.sessionId, "work");
          manager.prompt(spec.sessionId, "Continue, please.");
          await waitFor(() => failures.length > 0 || (completed === 2 && made.store.readMeta(spec.sessionId)?.status === "idle"), "legacy recovery did not settle");
          assert.deepEqual(failures, []);
          assert.equal(completed, 2);
          return;
        }
        if (scenario === "dormant") {
          manager.shutdownAll();
          made = makeManager(root, factory, messages, true);
          manager = made.manager;
          (manager as unknown as { resolveProviderAccount: ProviderAccountResolver }).resolveProviderAccount = resolveAccount;
        }
        if (scenario === "interrupted transfer") renameSync(transcript(homes.work), `${transcript(homes.work)}.retained`);
        await manager.switchProviderAccount(spec.sessionId, "personal");
        if (scenario === "interrupted transfer") {
          assert.ok(made.store.readMeta(spec.sessionId)?.providerAccountSwitchFailure);
          assert.equal(made.store.readMeta(spec.sessionId)?.providerConversationHome, homes.work);
          manager.shutdownAll();
          renameSync(`${transcript(homes.work)}.retained`, transcript(homes.work));
          made = makeManager(root, factory, messages, true);
          manager = made.manager;
          (manager as unknown as { resolveProviderAccount: ProviderAccountResolver }).resolveProviderAccount = resolveAccount;
        }
        manager.prompt(spec.sessionId, "Continue, please.");
        await waitFor(() => failures.length > 0 || (completed === 2 && made.store.readMeta(spec.sessionId)?.status === "idle"), "continued turn did not settle");
        assert.deepEqual(failures, [], "the selected account must find the same conversation on resume");
        await manager.switchProviderAccount(spec.sessionId, "work");
        manager.prompt(spec.sessionId, "continue back on work");
        await waitFor(() => completed === 3 && made.store.readMeta(spec.sessionId)?.status === "idle", "switch-back turn did not settle");
        assert.match(readFileSync(transcript(homes.work), "utf8"), /Continue, please/);
      } finally {
        manager?.shutdownAll();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const state of ["unused", "attempted", "imported"] as const) {
  test(`Codex's unpersisted initial thread handles ${state} history without discarding a conversation`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-empty-account-switch-"));
    let manager: SessionManager | undefined;
    try {
      const homes = { work: join(root, "work"), personal: join(root, "personal") };
      for (const home of Object.values(homes)) mkdirSync(home);
      const launches: Array<{ home: string; resumeId?: string; id: string }> = [];
      let completed = 0;
      const transcript = (home: string, id: string) => join(home, "sessions", "2026", "09", "30", `rollout-2026-09-30T12-00-00-${id}.jsonl`);
      const made = makeManager(root, (_driver: unknown, launch: { env: Record<string, string>; resumeId?: string }) => {
        const current = { home: launch.env.CODEX_HOME!, resumeId: launch.resumeId,
          id: launch.resumeId ?? `11111111-2222-4333-8444-55555555555${launches.length}` };
        launches.push(current);
        return {
          initialize: async () => {},
          newSession: async () => {
            if (current.resumeId && !existsSync(transcript(current.home, current.id))) throw new Error("no rollout found");
          },
          prompt: async (text: string) => {
            const file = transcript(current.home, current.id);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, text + "\n"); completed++;
            return "end_turn" as const;
          },
          cancel: () => {}, dispose: () => {}, setConfig: async () => {}, resolvePermission: () => false,
          agentSessionId: () => current.id,
        };
      }, [], true);
      manager = made.manager;
      (manager as unknown as { resolveProviderAccount: ProviderAccountResolver }).resolveProviderAccount = (spec) => ({
        id: spec.providerAccountId!, label: spec.providerAccountId!, provider: "codex",
        credentialHome: homes[spec.providerAccountId as keyof typeof homes],
      });
      const spec = launchSpec(root, "codex-app-server", "work");
      assert.equal(await manager.start(spec), true);
      const originalId = made.store.readMeta(spec.sessionId)!.agentSessionId!;
      assert.equal(existsSync(transcript(homes.work, originalId)), false);
      if (state === "attempted") {
        manager.prompt(spec.sessionId, "first user prompt");
        await waitFor(() => completed === 1 && made.store.readMeta(spec.sessionId)?.status === "idle", "first prompt did not finish");
        rmSync(transcript(homes.work, originalId));
      }
      if (state === "imported") {
        // Imported/forked history has no unused-allocation marker, even if its local event log
        // is empty. Missing provider history must preserve that coordinate for recovery.
        made.store.patchMeta(spec.sessionId, { providerUnstartedThreadId: undefined });
      }
      if (state === "unused") {
        made.store.appendEvent(spec.sessionId, { kind: "stderr", text: "startup diagnostic" });
      }
      await manager.switchProviderAccount(spec.sessionId, "personal");
      if (state !== "unused") {
        assert.ok(made.store.readMeta(spec.sessionId)?.providerAccountSwitchFailure);
        assert.equal(made.store.readMeta(spec.sessionId)?.agentSessionId, originalId);
        assert.equal(launches.length, 1, "missing attempted history must not launch a fresh thread");
      } else {
        assert.equal(launches.length, 2);
        assert.equal(launches[1]!.resumeId, undefined);
        assert.notEqual(made.store.readMeta(spec.sessionId)?.agentSessionId, originalId);
        manager.prompt(spec.sessionId, "first turn on the selected account");
        await waitFor(() => completed === 1 && made.store.readMeta(spec.sessionId)?.status === "idle", "selected account was not usable");
        await manager.switchProviderAccount(spec.sessionId, "work");
        assert.equal(launches[2]!.resumeId, launches[1]!.id, "a persisted conversation keeps its exact thread id");
        assert.match(readFileSync(transcript(homes.work, launches[1]!.id), "utf8"), /selected account/);
      }
    } finally { manager?.shutdownAll(); rmSync(root, { recursive: true, force: true }); }
  });
}


test("a running turn retains its memory policy; the queued turn resumes the same conversation with the changed policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-memory-runtime-"));
  const launches: Array<{ directory?: string; resumeId?: string }> = [];
  const prompts: Array<{ text: string; directory?: string }> = [];
  let finishFirst!: () => void;
  const gate = new Promise<void>((resolve) => { finishFirst = resolve; });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let manager: SessionManager | undefined;
  try {
    const made = makeManager(root, (_driver: unknown, launch: { projectMemoryDirectory?: string; resumeId?: string }) => {
      const directory = launch.projectMemoryDirectory;
      launches.push({ directory, resumeId: launch.resumeId });
      return { pid: launches.length, initialize: async () => {}, newSession: async () => {}, loadSession: async () => {},
        prompt: async (text: string) => {
          prompts.push({ text, directory });
          if (text === "first") { started(); await gate; }
          return "end_turn" as const;
        }, cancel: () => {}, dispose: () => {}, setConfig: async () => {}, resolvePermission: () => false,
        agentSessionId: () => "memory-conversation" };
    }, []);
    manager = made.manager;
    const spec = { ...launchSpec(root, "claude-code", "claude-work"), agentVersion: "2.1.284",
      projectMemory: { projectId: "project", sharing: "separate" as const } };
    assert.equal(await manager.start(spec), true);
    made.store.patchMeta(spec.sessionId, { agentSessionId: "memory-conversation" });
    assert.equal(manager.prompt(spec.sessionId, "first"), true); await ready;
    manager.setProjectMemory(spec.sessionId, { projectId: "project", sharing: "shared" });
    assert.equal(manager.prompt(spec.sessionId, "second"), true);
    assert.equal(launches.length, 1); finishFirst();
    await waitFor(() => prompts.length === 2, "new policy did not reach queued turn");
    assert.notEqual(prompts[0]?.directory, prompts[1]?.directory);
    assert.equal(launches[1]?.resumeId, "memory-conversation");
    await waitFor(() => made.store.readMeta(spec.sessionId)?.status === "idle", "turn did not settle");
    await manager.switchProviderAccount(spec.sessionId, "claude-personal");
    assert.equal(launches.at(-1)?.directory, prompts[1]?.directory, "shared memory follows the Project across accounts");
    manager.setProjectMemory(spec.sessionId, { projectId: "project", sharing: "separate" });
    await waitFor(() => launches.length === 4, "separation did not relaunch");
    assert.notEqual(launches.at(-1)?.directory, prompts[1]?.directory);
    assert.notEqual(launches.at(-1)?.directory, prompts[0]?.directory, "each account retains a separate partition");
    await manager.switchProviderAccount(spec.sessionId, "claude-work");
    assert.equal(launches.at(-1)?.directory, prompts[0]?.directory);
    assert.deepEqual(made.store.readMeta(spec.sessionId)?.projectMemory, { projectId: "project", sharing: "separate" });
  } finally { finishFirst?.(); manager?.shutdownAll(); rmSync(root, { recursive: true, force: true }); }
});


for (const failure of ["not_resumable", "lock_unavailable"] as const) test(`memory replacement ${failure} rejects queued work once and requires restart`, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-memory-failure-"));
  const messages: RunnerToControlPlane[] = [];
  let prompts = 0; let replacements = 0;
  const made = makeManager(root, () => ({ pid: 1, initialize: async () => {}, newSession: async () => {},
    prompt: async () => { prompts++; return "end_turn" as const; }, cancel: () => {}, dispose: () => {},
    setConfig: async () => {}, resolvePermission: () => false, agentSessionId: () => "conversation" }), messages);
  try {
    const spec = { ...launchSpec(root, "claude-code", "claude-work"), agentVersion: "2.1.284",
      projectMemory: { projectId: "project", sharing: "separate" as const } };
    assert.equal(await made.manager.start(spec), true);
    const internals = made.manager as unknown as { replaceProviderProcess: () => Promise<{ status: string }> };
    internals.replaceProviderProcess = async () => { replacements++; return { status: failure }; };
    made.manager.setProjectMemory(spec.sessionId, { projectId: "project", sharing: "shared" });
    assert.equal(made.manager.prompt(spec.sessionId, "queued"), true);
    await waitFor(() => made.store.readMeta(spec.sessionId)?.status === "failed", "failed policy did not surface");
    assert.equal(prompts, 0); assert.equal(replacements, 1);
    assert.equal(made.manager.prompt(spec.sessionId, "later"), true);
    await waitFor(() => made.store.readMeta(spec.sessionId)?.status === "failed", "later work not rejected");
    assert.equal(prompts, 0); assert.equal(replacements, 1);
    assert.equal(messages.filter(m => m.type === "session_event" && m.payload.kind === "error" && m.payload.message === "Could not apply the project memory policy. Restart this session to retry.").length, 1);
  } finally { made.manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); }
});

test("live launch preparation replaces a stale creation version for the memory gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-memory-live-version-"));
  let selected: string | undefined;
  const made = makeManager(root, (_driver: unknown, launch: { projectMemoryDirectory?: string }) => {
    selected = launch.projectMemoryDirectory;
    return { pid: 1, initialize: async () => {}, newSession: async () => {}, prompt: async () => "end_turn" as const,
      cancel: () => {}, dispose: () => {}, setConfig: async () => {}, resolvePermission: () => false, agentSessionId: () => "conversation" };
  }, []);
  try {
    const internals = made.manager as unknown as { prepareLaunch: (meta: { agentVersion?: string }) => void };
    internals.prepareLaunch = meta => { meta.agentVersion = "2.1.284"; };
    const spec = { ...launchSpec(root, "claude-code", "claude-work"), agentVersion: "2.1.283",
      projectMemory: { projectId: "project", sharing: "shared" as const } };
    assert.equal(await made.manager.start(spec), true); assert.ok(selected);
    assert.equal(made.store.readMeta(spec.sessionId)?.agentVersion, "2.1.284");
  } finally { made.manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); }
});
