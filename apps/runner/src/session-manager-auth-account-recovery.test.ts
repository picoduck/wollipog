import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDriverKind, RunnerToControlPlane, SessionLaunchSpec } from "@wollipog/protocol";
import type { Driver, DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import type { ProviderAuthObservation, ProviderAuthRecoveryController } from "./provider-auth-recovery.js";
import { transferClaudeAccountTranscript } from "./claude-account-transcript.js";
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
    const home = meta.env.CLAUDE_CONFIG_DIR ?? (meta.env.HOME ? join(meta.env.HOME, ".claude") : "<none>");
    probes.push(home);
    const state = homes[home];
    if (!state) return { status: "unknown" };
    return state.observations.length > 1 ? state.observations.shift()! : state.observations[0]!;
  };
  const controller: ProviderAuthRecoveryController = {
    describe: (meta) => ({
      id: `scope:${meta.env.CLAUDE_CONFIG_DIR ?? (meta.env.HOME ? join(meta.env.HOME, ".claude") : "<none>")}`,
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
  failAuthenticationOn?: string | ((text: string) => boolean),
  initializeGate: (home: string) => Promise<void> = async () => {},
  onPrompt: (text: string) => void = () => {},
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
  let latestCallbacks!: DriverCallbacks;
  const factory = (_kind: AgentDriverKind, options: DriverOptions, callbacks: DriverCallbacks): Driver => {
    latestCallbacks = callbacks;
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
        onPrompt(text);
        if (typeof failAuthenticationOn === "function" ? failAuthenticationOn(text) : text === failAuthenticationOn) callbacks.onAuthenticationFailure?.();
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
      meta.env = meta.providerCredentialHome ? { CLAUDE_CONFIG_DIR: meta.providerCredentialHome, HOME: root } : { HOME: root };
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
  // These fake providers model identity checks and lifecycle; they do not create CLI transcripts.
  const transfers: Array<{ source: string; target: string }> = [];
  (manager as unknown as { transferAccountTranscript: (context: unknown, id: string, source: string, target: string) => Promise<void> }).transferAccountTranscript =
    async (_context, _id, source, target) => { transfers.push({ source, target }); };
  return {
    root,
    store,
    sent,
    logs,
    prompts,
    disposedHomes,
    callbacks: () => latestCallbacks,
    probes,
    manager,
    controller,
    homes,
    transfers,
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

for (const [name, resolvedBy, expected] of [
  ["names the member who chose it", { kind: "user", userId: "usr_grace" }, { kind: "user", userId: "usr_grace" }],
  ["drops a malformed decider", { kind: "user", userId: 7 }, undefined],
  ["from an older control plane names nobody", undefined, undefined],
] as const) {
  test(`choosing another account ${name} on that session's resolution only (#2783)`, async () => {
    const h = harness({
      "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] },
      "/claude/personal": { observations: [{ status: "authenticated", identityId: "identity-personal" }] },
    });
    try {
      const requestId = await parkOnMismatch(h);
      assert.deepEqual(
        await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", "claude-work", resolvedBy),
        { ok: true },
      );
      await h.manager.providerAuthSelections.get(SESSION);
      const resolutions = h.store.listSessions().flatMap((meta) => h.store.readEvents(meta.sessionId)
        .map((event) => ({ sessionId: meta.sessionId, payload: event.payload }))
        .filter(({ payload }) => payload.kind === "permission_resolved"));
      assert.deepEqual(resolutions, [{
        sessionId: SESSION,
        payload: {
          kind: "permission_resolved",
          requestId,
          optionId: "auth:select-account",
          ...(expected ? { resolvedBy: expected } : {}),
        },
      }]);
    } finally {
      h.cleanup();
    }
  });
}

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
    // The retained prompt's relaunch runs asynchronously after the selection settles: the card is
    // re-raised by its preflight, and the prompt returns to the card once that launch has failed.
    await waitFor(() => {
      const meta = h.store.readMeta(SESSION);
      return meta?.pendingApproval?.kind === "authentication" && meta.providerAuthBlock?.identityMismatch === true &&
        meta.providerAuthBlock.retry !== undefined;
    }, "the swapped identity did not re-raise a recovery card that retains the prompt");

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


test("a policy change during an auth-failed turn preserves the provider and queued recovery work", async () => {
  const h = harness({ "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-work" }, { status: "unauthenticated" }] } },
    "first", async () => {}, text => {
      if (text !== "first") return;
      h.manager.setProjectMemory(SESSION, { projectId: "project", sharing: "shared" });
      assert.equal(h.manager.prompt(SESSION, "queued after first"), true);
    });
  try {
    h.store.patchMeta(SESSION, { agentVersion: "2.1.284", projectMemory: { projectId: "project", sharing: "separate" } });
    assert.equal(h.manager.prompt(SESSION, "first"), true);
    await waitFor(() => h.store.readMeta(SESSION)?.pendingApproval?.kind === "authentication", "auth card missing");
    const internals = h.manager as unknown as { active: Map<string, { running: boolean; queue: Array<{ text: string }> }> };
    await waitFor(() => !internals.active.get(SESSION)?.running, "turn did not settle");
    assert.deepEqual(h.disposedHomes, []);
    assert.deepEqual(internals.active.get(SESSION)?.queue.map(item => item.text), ["queued after first"]);
    assert.deepEqual(h.prompts.map(item => item.text), ["first"]);
    assert.ok(h.store.readMeta(SESSION)?.providerAuthBlock);
  } finally { h.cleanup(); }
});


test("mid-turn authentication recovery continues automatically after the same account is verified", async () => {
  const h = harness({ "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-work" }] } }, "original task");
  try {
    h.manager.prompt(SESSION, "original task");
    await waitFor(() => h.prompts.length === 2, "authentication recovery left the interrupted session idle");
    assert.match(h.prompts[1]!.text, /Continue/);
    assert.equal(h.store.readEvents(SESSION).filter((event) => event.payload.kind === "user_message").length, 1);
    assert.equal(h.prompts.filter((prompt) => prompt.text === "original task").length, 1);
  } finally { h.cleanup(); }
});


test("manual Retry continues a mid-turn authentication failure once credentials recover", async () => {
  const state: HomeState = { observations: [
    { status: "authenticated", identityId: "identity-work" },
    { status: "unauthenticated" },
  ] };
  const h = harness({ "/claude/work": state }, "original task");
  try {
    h.manager.prompt(SESSION, "original task");
    await waitFor(() => h.store.readMeta(SESSION)?.pendingApproval?.kind === "authentication", "no recovery card");
    const card = h.store.readMeta(SESSION)!.pendingApproval!;
    assert.equal(card.options.find((option) => option.optionId === "auth:revalidate")?.name, "Retry");
    state.observations = [{ status: "authenticated", identityId: "identity-work" }];
    h.manager.resolvePermission(SESSION, card.requestId, "auth:revalidate");
    await waitFor(() => h.prompts.length === 2, "manual Retry did not continue");
    assert.match(h.prompts[1]!.text, /Continue/);
    assert.equal(h.store.readEvents(SESSION).filter((event) => event.payload.kind === "user_message").length, 1);
  } finally { h.cleanup(); }
});

test("repeated mid-turn authentication failure stops automatic retries and offers Retry", async () => {
  const h = harness({ "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-work" }] } },
    () => true);
  try {
    h.manager.prompt(SESSION, "original task");
    await waitFor(() => h.store.readMeta(SESSION)?.pendingApproval?.kind === "authentication", "repeated failure did not surface recovery");
    assert.equal(h.prompts.length, 2, "only one automatic continuation is allowed without a healthy turn");
  } finally { h.cleanup(); }
});

for (const lane of ["idle", "provider", "command"]) test(`authentication recovery never invents a prompt for the ${lane} lane`, async () => {
  const h = harness({ "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-work" }] } });
  try {
    h.manager.prompt(SESSION, "finished task");
    await waitFor(() => h.prompts.length === 1 && !(h.manager as any).active.get(SESSION)?.running, "initial task did not finish");
    const entry = (h.manager as any).active.get(SESSION);
    if (lane === "provider") entry.providerInitiatedTurnActive = true;
    if (lane === "command") entry.currentSessionCommand = { commandId: "manual-command" };
    h.callbacks().onAuthenticationFailure?.();
    if (lane === "provider") entry.providerInitiatedTurnActive = false;
    if (lane === "command") entry.currentSessionCommand = undefined;
    await waitFor(() => !h.store.readMeta(SESSION)?.providerAuthBlock, "authentication did not recover");
    assert.equal(h.prompts.length, 1, "no runner prompt was interrupted");
    assert.equal(h.store.readEvents(SESSION).filter((event) => event.payload.kind === "user_message").length, 1);
  } finally { h.cleanup(); }
});

test(" a post-completion auth diagnostic never starts another task", async () => {
  const h = harness({ "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-work" }] } });
  let first = true;
  (h.manager as any).captureDiff = async () => {
    if (first) { first = false; h.callbacks().onAuthenticationFailure?.(); }
    return null;
  };
  try {
    h.manager.prompt(SESSION, "task that already completed");
    await waitFor(() => h.prompts.length > 1 || (!first && !h.store.readMeta(SESSION)?.providerAuthBlock), "recovery did not settle");
    assert.equal(h.prompts.length, 1, "a healthy provider turn had already completed before auth failed");
  } finally { h.cleanup(); }
});

for (const race of [false, true]) test(`authentication continuation respects a background-blocked worktree change ${race ? "queued concurrently" : "already pending"}`, async () => {
  const state: HomeState = { observations: [
    { status: "authenticated", identityId: "identity-work" }, { status: "unauthenticated" },
  ] };
  const h = harness({ "/claude/work": state }, "original task");
  try {
    h.manager.prompt(SESSION, "original task");
    await waitFor(() => h.store.readMeta(SESSION)?.pendingApproval?.kind === "authentication", "no recovery card");
    const card = h.store.readMeta(SESSION)!.pendingApproval!;
    const hold = () => {
      const entry = (h.manager as any).active.get(SESSION);
      entry.pendingWorktreeRebind = "/workspace/selected";
      h.store.patchMeta(SESSION, { backgroundWorkState: "running", pendingBackgroundTaskIds: ["running-job"] });
    };
    if (race) {
      const schedule = (h.manager as any).scheduleDrain.bind(h.manager);
      (h.manager as any).scheduleDrain = (id: string) => {
        if ((h.manager as any).active.get(id)?.queue.some((prompt: any) => prompt.providerRecovery)) hold();
        schedule(id);
      };
    } else hold();
    state.observations = [{ status: "authenticated", identityId: "identity-work" }];
    h.manager.resolvePermission(SESSION, card.requestId, "auth:revalidate");
    await waitFor(() => !h.store.readMeta(SESSION)?.providerAuthBlock, "authentication did not recover");
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.prompts.length, 1, "no continuation may run in the old worktree before the selected handoff");
    const entry = (h.manager as any).active.get(SESSION);
    assert.equal(entry.pendingWorktreeRebind, "/workspace/selected");
    if (race) {
      assert.equal(entry.queue.length, 1, "the raced continuation stays queued behind the handoff");
      assert.equal(h.manager.sessionSnapshots()[0]!.queueHold?.kind, "worktree_rebind");
    }
  } finally { h.cleanup(); }
});


function unbind(h: ReturnType<typeof harness>) {
  // This is a fake credential context throughout: no real provider home is read or probed.
  h.homes[join(h.root, ".claude")] = h.homes["/claude/work"]!;
  h.store.patchMeta(SESSION, { providerAccountId: undefined, providerAccountLabel: undefined,
    providerAccountProvider: undefined, providerCredentialHome: undefined, providerConversationHome: undefined,
    env: { HOME: h.root, CLAUDE_CONFIG_DIR: join(h.root, ".claude") } });
}

test("default-sign-in recovery rechecks, pins, and resumes the chosen Machine account", async () => {
  const h = harness({
    "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] },
    "/claude/personal": { observations: [{ status: "authenticated", identityId: "identity-personal" }] },
  });
  try {
    unbind(h);
    const requestId = await parkOnMismatch(h);
    const before = h.probes.length;
    assert.deepEqual(await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", null), { ok: true });
    assert.equal(h.probes[before], "/claude/personal");
    await h.manager.providerAuthSelections.get(SESSION);
    await waitFor(() => h.prompts.length === 1, "retained work did not resume");
    assert.deepEqual(h.prompts, [{ home: "/claude/personal", text: "hello", resumeId: "claude-conversation" }]);
    const meta = h.store.readMeta(SESSION)!;
    assert.equal(meta.providerAccountId, "claude-personal");
    assert.equal(meta.providerCredentialIdentityId, "identity-personal");
    assert.equal(meta.providerAuthBlock, undefined);
    assert.deepEqual(h.transfers, [{ source: join(h.root, ".claude"), target: "/claude/personal" }],
      "the default transcript store must be transferred before resuming under the new account");
  } finally { h.cleanup(); }
});

for (const phase of ["before", "during"] as const) {
  for (const initiallyBound of [false, true]) {
    test(`selection rejects ${initiallyBound ? "bound to unbound" : "unbound to bound"} changes ${phase} the probe`, async () => {
      const h = harness({
        "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] },
        "/claude/personal": { observations: [{ status: "authenticated", identityId: "identity-personal" }] },
      });
      try {
        if (!initiallyBound) unbind(h);
        const requestId = await parkOnMismatch(h);
        const change = () => initiallyBound ? unbind(h) : h.store.patchMeta(SESSION, { providerAccountId: "claude-work" });
        if (phase === "before") change();
        else {
          const revalidate = h.controller.revalidate;
          h.controller.revalidate = async (...args) => { const result = await revalidate(...args); change(); return result; };
        }
        const response = await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", initiallyBound ? "claude-work" : null);
        assert.equal(response.code, "account_changed");
        assert.deepEqual(h.prompts, []);
        assert.equal(h.store.readMeta(SESSION)?.pendingApproval?.requestId, requestId);
      } finally { h.cleanup(); }
    });
  }
}

test("unbound selection never treats missing or empty expectations as permission to skip checks", async () => {
  const h = harness({ "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] } });
  try {
    unbind(h);
    const requestId = await parkOnMismatch(h);
    const before = h.probes.length;
    for (const expected of [undefined, "", false]) {
      const response = await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", expected as unknown as null);
      assert.equal(response.code, "account_changed");
    }
    for (const account of ["unknown-other-machine", "codex-work"]) {
      assert.equal((await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, account, null)).code, "account_unavailable");
    }
    assert.equal((await h.manager.selectProviderAuthenticationAccount(SESSION, `${requestId}:stale`, "claude-personal", null)).code, "recovery_changed");
    assert.equal(h.probes.length, before);
    assert.deepEqual(h.prompts, []);
  } finally { h.cleanup(); }
});


for (const [observation, code] of [
  [{ status: "unauthenticated" }, "sign_in_required"],
  [{ status: "unknown" }, "status_unknown"],
  [{ status: "authenticated" }, "status_unknown"],
] as const) {
  test(`unbound recovery refuses an unverified target: ${observation.status} without identity`, async () => {
    const h = harness({
      "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] },
      "/claude/personal": { observations: [observation] },
    });
    try {
      unbind(h);
      const requestId = await parkOnMismatch(h);
      assert.equal((await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", null)).code, code);
      assert.equal(h.store.readMeta(SESSION)?.providerAccountId, undefined);
      assert.deepEqual(h.prompts, []);
    } finally { h.cleanup(); }
  });
}

test("unbound recovery refuses a card replaced during the target probe", async () => {
  const h = harness({
    "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] },
    "/claude/personal": { observations: [{ status: "authenticated", identityId: "identity-personal" }] },
  });
  try {
    unbind(h);
    const requestId = await parkOnMismatch(h);
    const revalidate = h.controller.revalidate;
    h.controller.revalidate = async (...args) => {
      const result = await revalidate(...args);
      h.store.patchMeta(SESSION, { pendingApproval: null, providerAuthBlock: undefined });
      return result;
    };
    assert.equal((await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", null)).code, "recovery_changed");
    assert.equal(h.store.readMeta(SESSION)?.providerAccountId, undefined);
    assert.deepEqual(h.prompts, []);
  } finally { h.cleanup(); }
});


test("default-sign-in selection copies only the real saved conversation before its retained work resumes", async () => {
  const h = harness({ "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] } });
  try {
    unbind(h);
    const source = join(h.root, ".claude");
    const target = join(h.root, "added-account");
    const project = join(source, "projects", "workspace");
    mkdirSync(project, { recursive: true });
    mkdirSync(target);
    writeFileSync(join(project, "claude-conversation.jsonl"), "saved conversation\n");
    writeFileSync(join(project, "unrelated.jsonl"), "another conversation\n");
    writeFileSync(join(source, ".credentials.json"), "synthetic credential sentinel\n");
    h.homes[target] = { observations: [{ status: "authenticated", identityId: "identity-personal" }] };
    const internals = h.manager as unknown as {
      resolveProviderAccount: ProviderAccountResolver;
      transferAccountTranscript: typeof transferClaudeAccountTranscript;
    };
    internals.resolveProviderAccount = () => ({ ...accounts["claude-personal"], credentialHome: target });
    internals.transferAccountTranscript = transferClaudeAccountTranscript;
    const requestId = await parkOnMismatch(h);
    assert.deepEqual(await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", null), { ok: true });
    await h.manager.providerAuthSelections.get(SESSION);
    await waitFor(() => h.prompts.length === 1, "the saved conversation did not resume");
    assert.equal(readFileSync(join(target, "projects", "workspace", "claude-conversation.jsonl"), "utf8"), "saved conversation\n");
    assert.equal(existsSync(join(target, "projects", "workspace", "unrelated.jsonl")), false);
    assert.equal(existsSync(join(target, ".credentials.json")), false);
    assert.equal(readFileSync(join(project, "claude-conversation.jsonl"), "utf8"), "saved conversation\n");
    assert.equal(h.prompts[0]?.home, target);
    assert.equal(h.store.readMeta(SESSION)?.providerConversationHome, target);
  } finally { h.cleanup(); }
});


test("default-sign-in recovery refuses an ambiguous original transcript home before changing the binding", async () => {
  const h = harness({
    "/claude/work": { observations: [{ status: "authenticated", identityId: "identity-intruder" }] },
    "/claude/personal": { observations: [{ status: "authenticated", identityId: "identity-personal" }] },
  });
  try {
    unbind(h);
    const requestId = await parkOnMismatch(h);
    h.store.patchMeta(SESSION, { env: { CLAUDE_CONFIG_DIR: "relative-home" } });
    assert.equal((await h.manager.selectProviderAuthenticationAccount(SESSION, requestId, "claude-personal", null)).code, "not_resumable");
    assert.equal(h.store.readMeta(SESSION)?.providerAccountId, undefined);
    assert.deepEqual(h.transfers, []);
    assert.deepEqual(h.prompts, []);
  } finally { h.cleanup(); }
});
