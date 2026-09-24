import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDriverKind, RunnerToControlPlane, SessionLaunchSpec } from "@wollipog/protocol";
import type { Driver, DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import type { ProviderAuthObservation, ProviderAuthRecoveryController } from "./provider-auth-recovery.js";
import { SessionManager, type ProviderAccountResolver } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

const SESSION = "auth-account-session";
const WORK_EMAIL = "intruder@example.com";

const accounts = {
  "claude-work": { id: "claude-work", label: "Claude Work", provider: "claude" as const, credentialHome: "/claude/work" },
  "claude-personal": {
    id: "claude-personal",
    label: "Claude Personal",
    provider: "claude" as const,
    credentialHome: "/claude/personal",
  },
  "codex-work": { id: "codex-work", label: "Codex Work", provider: "codex" as const, credentialHome: "/codex/work" },
};

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

type HomeState = { observations: ProviderAuthObservation[]; email?: string | null };

/** Provider state keyed by credential home, as the real controller observes it through env. */
function fakeController(homes: Record<string, HomeState>) {
  const probes: string[] = [];
  const observe = (meta: SessionMeta): ProviderAuthObservation => {
    const home = meta.env.CLAUDE_CONFIG_DIR ?? "<none>";
    probes.push(home);
    const state = homes[home];
    if (!state) return { status: "unknown" };
    return state.observations.length > 1 ? state.observations.shift()! : state.observations[0]!;
  };
  const controller: ProviderAuthRecoveryController = {
    describe: (meta) => ({
      id: `scope:${meta.env.CLAUDE_CONFIG_DIR ?? "<none>"}`,
      provider: "claude",
      canStartLogin: false,
      configuredCredential: false,
    }),
    revalidate: async (meta) => observe(meta),
    inspect: async (meta) => {
      const observation = observe(meta);
      return {
        observation,
        emailSupported: true,
        email: homes[meta.env.CLAUDE_CONFIG_DIR ?? ""]?.email ?? null,
      };
    },
    startLogin: async () => "failed",
    cancel: () => false,
  };
  return { controller, probes };
}

function harness(
  homes: Record<string, HomeState>,
  failAuthenticationOn?: string,
  initializeGate: (home: string) => Promise<void> = async () => {},
) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-auth-account-"));
  const store = new SessionStore(join(root, "sessions"));
  store.create({
    sessionId: SESSION,
    agentId: "claude-native",
    workspaceId: "workspace",
    repoPath: root,
    worktreePath: null,
    driver: "claude-code",
    command: "claude",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: "claude-conversation",
    status: "idle",
    title: "auth account recovery",
    config: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
    providerAccountId: "claude-work",
    providerAccountLabel: "Claude Work",
    providerAccountProvider: "claude",
    providerCredentialHome: "/claude/work",
    providerCredentialIdentityId: "identity-work",
  });
  const sent: RunnerToControlPlane[] = [];
  const logs: string[] = [];
  const prompts: Array<{ home: string; text: string; resumeId?: string }> = [];
  const disposedHomes: string[] = [];
  const factory = (_kind: AgentDriverKind, options: DriverOptions, callbacks: DriverCallbacks): Driver => {
    const home = options.env.CLAUDE_CONFIG_DIR ?? "<none>";
    return {
      get pid() { return undefined; },
      initialize: () => initializeGate(home),
      newSession: async () => "claude-conversation",
      loadSession: async () => {},
      agentSessionId: () => "claude-conversation",
      prompt: async (text) => {
        prompts.push({ home, text, ...(options.resumeId ? { resumeId: options.resumeId } : {}) });
        callbacks.onPromptAccepted?.();
        if (text === failAuthenticationOn) callbacks.onAuthenticationFailure?.();
        return "end_turn";
      },
      setConfig: () => {},
      cancel: () => {},
      resolvePermission: () => false,
      dispose: () => { disposedHomes.push(home); },
    } as Driver;
  };
  const { controller, probes } = fakeController(homes);
  const manager = new SessionManager(
    (message) => sent.push(message),
    (message) => logs.push(message),
    store,
    "runner",
    undefined,
    factory,
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
      meta.env = meta.providerCredentialHome ? { CLAUDE_CONFIG_DIR: meta.providerCredentialHome } : {};
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    controller,
  );
  (manager as unknown as { resolveProviderAccount: ProviderAccountResolver }).resolveProviderAccount =
    (spec: SessionLaunchSpec) => accounts[spec.providerAccountId as keyof typeof accounts];
  return {
    root,
    store,
    sent,
    logs,
    prompts,
    disposedHomes,
    probes,
    manager,
    cleanup: () => {
      manager.shutdownAll();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Park the session on an account mismatch with "hello" retained, then return the card id. */
async function parkOnMismatch(h: ReturnType<typeof harness>): Promise<string> {
  h.manager.prompt(SESSION, "hello");
  await waitFor(() => h.store.readMeta(SESSION)?.pendingApproval?.kind === "authentication",
    "the account mismatch did not raise an Authentication Required card");
  const meta = h.store.readMeta(SESSION)!;
  assert.equal(meta.providerAuthBlock?.identityMismatch, true);
  assert.equal(meta.providerAuthBlock?.retry?.text, "hello");
  return meta.pendingApproval!.requestId;
}

test("recovery reports the fresh provider email only for the exact open card and never records it", async () => {
  const h = harness({
    "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }], email: WORK_EMAIL },
  });
  try {
    const requestId = await parkOnMismatch(h);

    assert.deepEqual(await h.manager.inspectProviderAuthentication(SESSION, `${requestId}:stale`), {
      ok: false,
      error: "this Authentication Required card is no longer current",
    });
    const inspected = await h.manager.inspectProviderAuthentication(SESSION, requestId);
    assert.equal(inspected.ok, true);
    assert.ok(inspected.ok);
    assert.equal(inspected.identity.status, "authenticated");
    assert.equal(inspected.identity.emailSupported, true);
    assert.equal(inspected.identity.email, WORK_EMAIL);

    const durable = JSON.stringify({
      meta: h.store.readMeta(SESSION),
      events: h.store.readEvents(SESSION),
      sent: h.sent,
      logs: h.logs,
    });
    assert.equal(durable.includes(WORK_EMAIL), false, "the email stays out of metadata, events, messages, and logs");
    assert.equal(h.store.readMeta(SESSION)?.pendingApproval?.requestId, requestId, "inspection resolves nothing");
  } finally {
    h.cleanup();
  }
});

test("recovery reports that the provider supplied no email instead of inferring one", async () => {
  const h = harness({
    "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }], email: null },
  });
  try {
    const requestId = await parkOnMismatch(h);
    const inspected = await h.manager.inspectProviderAuthentication(SESSION, requestId);
    assert.ok(inspected.ok);
    assert.equal(inspected.identity.email, null);
    assert.equal(inspected.identity.emailSupported, true);
  } finally {
    h.cleanup();
  }
});

test("choosing another account rechecks it, pins its identity, and replays the retained prompt there", async () => {
  const h = harness({
    "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] },
    "/claude/personal": { observations: [{ status: "authenticated", identityId: "identity-personal" }] },
  });
  try {
    const requestId = await parkOnMismatch(h);
    const probesBefore = h.probes.length;

    assert.deepEqual(
      await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", "claude-work"),
      { ok: true },
    );
    assert.equal(h.probes[probesBefore], "/claude/personal", "the chosen credential context is rechecked first");
    await h.manager.providerAuthSelections.get(SESSION);
    await waitFor(() => h.prompts.some((prompt) => prompt.text === "hello"), "the retained prompt was not replayed");

    assert.deepEqual(h.prompts, [{ home: "/claude/personal", text: "hello", resumeId: "claude-conversation" }]);
    const meta = h.store.readMeta(SESSION)!;
    assert.equal(meta.providerAccountId, "claude-personal");
    assert.equal(meta.providerCredentialHome, "/claude/personal");
    assert.equal(meta.providerCredentialIdentityId, "identity-personal");
    assert.equal(meta.providerCredentialScopeId, "scope:/claude/personal");
    assert.equal(meta.providerAuthBlock, undefined);
    const events = h.store.readEvents(SESSION).map((event) => event.payload);
    assert.ok(events.some((event) =>
      event.kind === "permission_resolved" && event.requestId === requestId &&
      event.optionId === "auth:select-account"));
    assert.ok(events.some((event) =>
      event.kind === "provider_account_switched" && event.providerAccountId === "claude-personal"));
    assert.equal(events.some((event) =>
      event.kind === "permission_resolved" && event.optionId === "auth:accept-current"), false,
    "the mismatched current identity was never accepted");
  } finally {
    h.cleanup();
  }
});

test("a signed-out, stale, or already-bound account selection fails closed without moving the session", async () => {
  const h = harness({
    "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] },
    "/claude/personal": { observations: [{ status: "unauthenticated" }] },
  });
  try {
    const requestId = await parkOnMismatch(h);
    const select = (card: string, account: string, expected: string) =>
      h.manager.selectProviderAuthenticationAccount(SESSION, card, account, expected);

    assert.equal((await select(requestId, "claude-personal", "claude-work")).code, "sign_in_required");
    assert.equal((await select(requestId, "claude-personal", "claude-personal")).code, "account_changed");
    assert.equal((await select(`${requestId}:stale`, "claude-personal", "claude-work")).code, "recovery_changed");
    assert.equal((await select(requestId, "claude-work", "claude-work")).code, "account_unavailable");
    assert.equal((await select(requestId, "codex-work", "claude-work")).code, "account_unavailable",
      "an account for another provider is never compatible");

    const meta = h.store.readMeta(SESSION)!;
    assert.equal(meta.providerAccountId, "claude-work");
    assert.equal(meta.providerCredentialHome, "/claude/work");
    assert.equal(meta.providerCredentialIdentityId, "identity-work");
    assert.equal(meta.pendingApproval?.requestId, requestId, "the card stays open for another choice");
    assert.equal(meta.providerAuthBlock?.retry?.text, "hello");
    assert.deepEqual(h.prompts, []);
  } finally {
    h.cleanup();
  }
});

test("a Claude account that reports no identity cannot be pinned and is refused", async () => {
  const h = harness({
    "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] },
    "/claude/personal": { observations: [{ status: "authenticated" }] },
  });
  try {
    const requestId = await parkOnMismatch(h);
    const refused = await h.manager.selectProviderAuthenticationAccount(
      SESSION, requestId, "claude-personal", "claude-work");
    assert.equal(refused.code, "status_unknown");
    const meta = h.store.readMeta(SESSION)!;
    assert.equal(meta.providerAccountId, "claude-work");
    assert.equal(meta.pendingApproval?.requestId, requestId);
    assert.deepEqual(h.prompts, []);
  } finally {
    h.cleanup();
  }
});

test("an identity that changes after selection re-raises the card for the chosen account", async () => {
  const h = harness({
    "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] },
    "/claude/personal": {
      observations: [
        { status: "authenticated", identityId: "identity-personal" },
        { status: "authenticated", identityId: "identity-swapped" },
      ],
    },
  });
  try {
    const requestId = await parkOnMismatch(h);
    assert.deepEqual(
      await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", "claude-work"),
      { ok: true },
    );
    await h.manager.providerAuthSelections.get(SESSION);
    await waitFor(() => {
      const meta = h.store.readMeta(SESSION);
      return meta?.pendingApproval?.kind === "authentication" && meta.providerAuthBlock?.identityMismatch === true;
    }, "the swapped identity did not re-raise a recovery card");

    const meta = h.store.readMeta(SESSION)!;
    assert.deepEqual(h.prompts, [], "no provider work ran under the swapped identity");
    assert.equal(meta.providerAccountId, "claude-personal");
    assert.equal(meta.providerAuthBlock?.credentialScopeId, "scope:/claude/personal");
    assert.equal(meta.providerAuthBlock?.expectedIdentityId, "identity-personal");
    assert.equal(meta.providerAuthBlock?.retry?.text, "hello", "the prompt stays retained for the new card");
    assert.ok(meta.pendingApproval?.options.some((option) => option.optionId === "auth:accept-current"));
  } finally {
    h.cleanup();
  }
});

test("a live provider process is replaced before selected-account work runs", async () => {
  const h = harness({
    "/claude/work": {
      observations: [
        { status: "authenticated", identityId: "identity-work" },
        { status: "unauthenticated" },
      ],
    },
    "/claude/personal": { observations: [{ status: "authenticated", identityId: "identity-personal" }] },
  }, "rejected mid-turn");
  try {
    h.manager.prompt(SESSION, "rejected mid-turn");
    await waitFor(() => h.store.readMeta(SESSION)?.pendingApproval?.kind === "authentication",
      "the mid-turn authentication failure did not raise a card");
    const requestId = h.store.readMeta(SESSION)!.pendingApproval!.requestId;
    assert.equal(h.disposedHomes.length, 0, "the original provider process is still live");

    assert.deepEqual(
      await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", "claude-work"),
      { ok: true },
    );
    await h.manager.providerAuthSelections.get(SESSION);
    await waitFor(() => h.store.readMeta(SESSION)?.pendingApproval === null, "the card was not resolved");
    assert.ok(h.disposedHomes.includes("/claude/work"), "the stale credential-home process was retired");

    assert.equal(h.manager.prompt(SESSION, "after the switch"), true);
    await waitFor(() => h.prompts.some((prompt) => prompt.text === "after the switch"), "new work did not run");
    assert.deepEqual(h.prompts.map((prompt) => [prompt.home, prompt.text]), [
      ["/claude/work", "rejected mid-turn"],
      ["/claude/personal", "after the switch"],
    ]);
  } finally {
    h.cleanup();
  }
});

test("a recheck during the selected-account handoff cannot start a second recovery", async () => {
  let releasePersonal!: () => void;
  const personalGate = new Promise<void>((resolve) => { releasePersonal = resolve; });
  const h = harness({
    "/claude/work": {
      observations: [
        { status: "authenticated", identityId: "identity-work" },
        { status: "unauthenticated" },
      ],
    },
    "/claude/personal": { observations: [{ status: "authenticated", identityId: "identity-personal" }] },
  }, "rejected mid-turn", (home) => home === "/claude/personal" ? personalGate : Promise.resolve());
  try {
    h.manager.prompt(SESSION, "rejected mid-turn");
    await waitFor(() => h.store.readMeta(SESSION)?.pendingApproval?.kind === "authentication",
      "the mid-turn authentication failure did not raise a card");
    const requestId = h.store.readMeta(SESSION)!.pendingApproval!.requestId;
    assert.deepEqual(
      await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", "claude-work"),
      { ok: true },
    );
    // The replacement provider is still initializing under the chosen account.
    h.manager.resolvePermission(SESSION, requestId, "auth:revalidate");
    await waitFor(() => h.store.readEvents(SESSION).some((event) =>
      event.payload.kind === "permission_request" &&
      /already in progress/.test(event.payload.context?.input ?? "")),
    "the concurrent recheck was not refused");
    assert.equal((await h.manager.selectProviderAuthenticationAccount(
      SESSION, requestId, "claude-work", "claude-personal")).code, "operation_in_progress");

    releasePersonal();
    await h.manager.providerAuthSelections.get(SESSION);
    await waitFor(() => h.store.readMeta(SESSION)?.pendingApproval === null, "the card was not resolved");
    assert.equal(h.store.readEvents(SESSION).filter((event) =>
      event.payload.kind === "permission_resolved" && event.payload.requestId === requestId).length, 1);
    assert.deepEqual(h.probes.filter((home) => home === "/claude/personal"), ["/claude/personal", "/claude/personal"],
      "only the selection check and the replacement preflight probed the chosen account");
  } finally {
    releasePersonal?.();
    h.cleanup();
  }
});
