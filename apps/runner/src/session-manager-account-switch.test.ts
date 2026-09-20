import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDriverKind, RunnerToControlPlane, SessionLaunchSpec } from "@wollipog/protocol";
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
      env: Record<string, string> }) => void;
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
