import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    prepareLaunch: (meta: { providerAccountProvider?: string; providerCredentialHome?: string;
      env: Record<string, string> }) => void | Promise<void>;
  };
  internals.resolveProviderAccount = accountResolver;
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

    assert.equal(manager.prompt(spec.sessionId, "continue"), true);
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
