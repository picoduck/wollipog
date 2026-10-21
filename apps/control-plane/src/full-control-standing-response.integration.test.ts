import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  type ControlPlaneToRunner, type RunnerMetadata, type RunnerToControlPlane,
} from "@wollipog/protocol";
import type { Driver, DriverCallbacks } from "../../runner/src/drivers/driver.js";
import type { ProviderAuthRecoveryController } from "../../runner/src/provider-auth-recovery.js";
import { SessionManager } from "../../runner/src/session-manager.js";
import { SessionStore } from "../../runner/src/session-store.js";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService } from "./sessions.js";

/** Standing Full Control responses (#2940) delivered to the real runner request handlers: the
 * control plane's own decline travels to `SessionManager.resolvePermission` and the runner's
 * events come back through `onSessionEvent`, exactly as over the runner socket. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** `turnEnd` delays the end of the interrupted provider turn: a delay in ms, or a gate the test opens. */
function bridge(providerAuthRecovery?: ProviderAuthRecoveryController, turnEnd: number | Promise<unknown> = 0, runnerProtocol = PROTOCOL_VERSION) {
  const directory = mkdtempSync(join(tmpdir(), "full-control-standing-"));
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: directory }],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" }, available: true }] };
  db.registerRunner(metadata, 1, runnerProtocol);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [2940], revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [2940];
  for (const [id, parentSessionId] of [["root", undefined], ["child", "root"]] as const) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "claude", title: id, useWorktree: false, driver: "claude-code",
      now: 1, config: {}, parentSessionId, ...(!parentSessionId ? { role: "orchestrator", orchestratorPolicy: policy,
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } } : {}) });
    db.updateSessionStatus(id, "running", 2);
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sessionChangedById = () => {};
  const toRunner: ControlPlaneToRunner[] = [];
  let svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  /** The control plane restarts on the same durable database; its in-memory state is gone. */
  const restartControlPlane = () => { svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }); };

  // The real runner, with a fake provider whose first turn fails authentication.
  let store = new SessionStore(directory);
  store.create({ sessionId: "child", agentId: "claude", workspaceId: "w", repoPath: directory, worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" }, agentSessionId: "thread",
    status: "idle", title: "child", config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
    seq: 0, createdAt: 1, updatedAt: 1 });
  const fromRunner: RunnerToControlPlane[] = [];
  let callbacks: DriverCallbacks | null = null;
  const factory = (_kind: unknown, _options: unknown, cb: DriverCallbacks): Driver => {
    callbacks = cb;
    return {
      get pid() { return undefined; },
      initialize: async () => {},
      newSession: async () => "thread",
      agentSessionId: () => "thread",
      prompt: async () => {
        cb.onPromptAccepted?.(); cb.onAuthenticationFailure?.();
        // A provider can take a while to end its interrupted turn after the failure.
        if (typeof turnEnd === "number") { if (turnEnd) await new Promise((resolve) => setTimeout(resolve, turnEnd)); }
        else await turnEnd;
        return "end_turn";
      },
      setConfig: () => {},
      cancel: () => {},
      resolvePermission: () => false,
      dispose: () => {},
    } as unknown as Driver;
  };
  const makeManager = (sessionStore: SessionStore) => new SessionManager(
    (message) => {
      fromRunner.push(message);
      if (message.type === "session_event" && message.sessionId === "child") svc.onSessionEvent("child", message.payload);
    },
    () => {}, sessionStore, "r", undefined, factory as never, undefined, 4, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, providerAuthRecovery,
  );
  let manager = makeManager(store);
  /** The runner process ends (its in-memory waits die with it) and a new one starts on the same
   * durable store, rebuilding cards the way startup does. */
  const restart = () => {
    manager.shutdownAll();
    store = new SessionStore(directory);
    manager = makeManager(store);
    manager.reconcileStore();
  };
  const delivery = { held: false };
  hub.sendToRunner = (_runnerId, message) => {
    toRunner.push(message);
    // Held: the socket accepted the message, but this runner process never acts on it.
    if (message.type === "resolve_permission" && !delivery.held) {
      manager.resolvePermission(message.sessionId, message.requestId, message.optionId, message.resolvedByParentSessionId, message.resolvedBy);
    }
    return true;
  };
  const enable = () => svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #2940",
    operations: ["implementation_question", "question", "tool_approval", "policy_ask", "pr_merge"], delegatablePolicyIds: [] }, 1, principal);
  const authCards = () => fromRunner.filter((message) => message.type === "session_event" &&
    message.payload.kind === "permission_request" && message.payload.purpose === "authentication").length;
  const declinesSent = () => toRunner.filter((message) => message.type === "resolve_permission") as Array<Extract<ControlPlaneToRunner, { type: "resolve_permission" }>>;
  return { db, get svc() { return svc; }, get manager() { return manager; }, get store() { return store; }, restart, restartControlPlane, delivery, enable, authCards, declinesSent, fromRunner,
    callbacks: () => callbacks,
    close: () => { manager.shutdownAll(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const scoped of [false, true]) {
  test(`a ${scoped ? "scoped" : "scope-less"} sign-in card is dismissed once through the runner's own action, with no loop`, async () => {
    const controller: ProviderAuthRecoveryController | undefined = scoped ? {
      describe: () => ({ id: "scope-a", provider: "claude", canStartLogin: true, configuredCredential: false }),
      revalidate: async () => ({ status: "unauthenticated" }),
      startLogin: async () => "failed",
      cancel: () => true,
    } : undefined;
    const h = bridge(controller);
    try {
      assert.ok(h.enable().ok);
      h.manager.prompt("child", "work");
      // The runner settles the interrupted provider turn (25 ms polls) before it dismisses.
      const resolvedCount = () => h.fromRunner.filter((message) => message.type === "session_event" && message.payload.kind === "permission_resolved").length;
      for (let waited = 0; waited < 3_000 && !resolvedCount(); waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
      for (let index = 0; index < 12; index += 1) await tick();
      // The runner raised one card; the control plane dismissed it with Dismiss Recovery, which
      // the runner settles terminally instead of re-emitting the card as a cancel would.
      assert.equal(h.authCards(), 1, "the card is never re-emitted");
      assert.deepEqual(h.declinesSent().map((message) => message.optionId), ["auth:dismiss"]);
      const resolved = h.fromRunner.filter((message) => message.type === "session_event" && message.payload.kind === "permission_resolved");
      assert.equal(resolved.length, 1, "one terminal resolution");
      assert.equal(h.store.readMeta("child")?.pendingApproval, null);
      assert.equal(h.store.readMeta("child")?.providerAuthBlock, undefined);
      assert.equal(h.db.getSession("child")!.pendingApproval, null);
      const blocked = h.db.campaignProjection("root")!.recovery!.records.filter((record) => record.reason === "request_declined");
      assert.equal(blocked.length, 1, "one blocked-work record");
      assert.equal(blocked[0]!.resource.sessionId, "child");
      assert.equal(h.db.campaignProjection("root")!.recovery!.waitingHuman, 0);
    } finally { h.close(); }
  });
}

test("an accepted dismissal completes on its own once a slow provider turn settles, sent exactly once (CR-3.3)", { timeout: 20_000 }, async () => {
  // A scope-less card is raised while the interrupted turn is still running, so the dismissal
  // arrives before the turn settles: exactly the window the runner used to refuse.
  const h = bridge(undefined, 3_500);
  try {
    assert.ok(h.enable().ok);
    h.manager.prompt("child", "work");
    const resolvedCount = () => h.fromRunner.filter((message) => message.type === "session_event" && message.payload.kind === "permission_resolved").length;
    // The runner's own settle window is about 2.5 s; the turn ends after 3.5 s.
    for (let waited = 0; waited < 10_000 && !resolvedCount(); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(resolvedCount(), 1, "the card clears without any human action");
    assert.deepEqual(h.declinesSent().map((message) => message.optionId), ["auth:dismiss"], "exactly one dismissal");
    assert.equal(h.authCards(), 1);
    assert.equal(h.store.readMeta("child")?.pendingApproval, null);
    assert.equal(h.db.getSession("child")!.pendingApproval, null);
  } finally { h.close(); }
});

/** A gate the test opens to end the provider turn at a moment it controls. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
const resolutions = (h: ReturnType<typeof bridge>) => h.fromRunner.filter((message) =>
  message.type === "session_event" && message.payload.kind === "permission_resolved").length;
const waitUntil = async (condition: () => boolean, ms: number) => {
  for (let waited = 0; waited < ms && !condition(); waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
};

test("an accepted dismissal never expires: it waits past every former window and completes once when the turn settles (CR-4.4)", { timeout: 30_000 }, async () => {
  const turn = gate();
  const h = bridge(undefined, turn.promise);
  try {
    assert.ok(h.enable().ok);
    h.manager.authDismissalPollMs = 5;
    h.manager.prompt("child", "work");
    await waitUntil(() => h.declinesSent().length > 0, 2_000);
    assert.deepEqual(h.declinesSent().map((message) => message.optionId), ["auth:dismiss"]);
    // Well past the former 2.5 s refusal and the old bounded wait (thousands of 5 ms polls).
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    assert.equal(resolutions(h), 0, "still waiting for the turn, not refused");
    assert.ok(h.store.readMeta("child")?.pendingProviderAuthDismissal, "the accepted intent is durable");
    assert.ok(!h.fromRunner.some((message) => message.type === "session_event" && message.payload.kind === "stderr" &&
      message.payload.text.includes("again in a moment")), "never asks for another Dismiss Recovery");
    turn.open();
    await waitUntil(() => resolutions(h) > 0, 5_000);
    assert.equal(resolutions(h), 1, "completes automatically, exactly once");
    assert.equal(h.declinesSent().length, 1);
    assert.equal(h.store.readMeta("child")?.pendingApproval, null);
    assert.equal(h.store.readMeta("child")?.pendingProviderAuthDismissal, undefined);
    assert.equal(h.db.getSession("child")!.pendingApproval, null);
  } finally { turn.open(); h.close(); }
});

test("an accepted dismissal survives a runner crash inside its first settlement wait and completes once (CR-4.3, CR-5.1)", { timeout: 30_000 }, async () => {
  // A scoped card: startup rebuilds it from the durable auth block, which is what parked before.
  const h = bridge({
    describe: () => ({ id: "scope-restart", provider: "claude", canStartLogin: false, configuredCredential: false }),
    revalidate: async () => ({ status: "unauthenticated" }),
    startLogin: async () => "failed",
    cancel: () => true,
  });
  try {
    assert.ok(h.enable().ok);
    // The server's real dismissal reaches the runner while a provider launch is still in flight, so
    // the runner accepts it and starts its first settlement wait; the process dies inside that wait.
    h.delivery.held = true;
    h.manager.prompt("child", "work");
    await waitUntil(() => h.declinesSent().length > 0, 5_000);
    const [dismissal] = h.declinesSent();
    assert.equal(dismissal?.optionId, "auth:dismiss");
    (h.manager as unknown as { launchGenerations: Map<string, number> }).launchGenerations.set("child", 1);
    h.manager.resolvePermission(dismissal!.sessionId, dismissal!.requestId, dismissal!.optionId, dismissal!.resolvedByParentSessionId);
    assert.ok(h.store.readMeta("child")?.pendingProviderAuthDismissal, "the intent is durable before any wait");
    assert.equal(resolutions(h), 0);
    // The runner process ends; the next process starts on the same store and rebuilds the card.
    h.delivery.held = false;
    h.restart();
    await waitUntil(() => resolutions(h) > 0, 5_000);
    assert.equal(resolutions(h), 1, "the restarted runner completes it, exactly once");
    assert.equal(h.declinesSent().length, 1, "the server never sends a second dismissal");
    assert.equal(h.store.readMeta("child")?.pendingApproval, null);
    assert.equal(h.store.readMeta("child")?.pendingProviderAuthDismissal, undefined);
    assert.equal(h.db.getSession("child")!.pendingApproval, null);
  } finally { h.close(); }
});

/** A v229 runner's Dismiss Recovery, as on main before durable dismissal: it waits at most 100 ×
 * 25 ms for the provider turn, and otherwise asks for the action again and keeps the same card,
 * persisting nothing. A settled turn is dismissed exactly as the current runner does. */
function legacyDismissal(h: ReturnType<typeof bridge>): { refusals: () => number } {
  type Internal = {
    active: Map<string, { running?: boolean }>; launchGenerations: Map<string, number>;
    resolveProviderAuthentication(sessionId: string, requestId: string, optionId: string | null, decidedBy?: unknown): Promise<void>;
    emitEvent(sessionId: string, payload: { kind: "stderr"; text: string }): void;
    emitStatus(sessionId: string, status: string, detail: string): void;
  };
  const internal = h.manager as unknown as Internal;
  const current = internal.resolveProviderAuthentication.bind(h.manager);
  let refusals = 0;
  internal.resolveProviderAuthentication = async (sessionId, requestId, optionId, decidedBy) => {
    if (optionId === "auth:dismiss") {
      const settled = () => !internal.active.get(sessionId)?.running && !internal.launchGenerations.has(sessionId);
      for (let attempt = 0; attempt < 100 && !settled(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      if (!settled()) {
        refusals += 1;
        internal.emitEvent(sessionId, { kind: "stderr", text: "The provider turn is still settling. Dismiss Recovery again in a moment." });
        internal.emitStatus(sessionId, "input_required", "Provider authentication recovery is still settling");
        return;
      }
    }
    return current(sessionId, requestId, optionId, decidedBy);
  };
  return { refusals: () => refusals };
}

/** The campaign's view of a v229 sign-in that the runner kept: blocked work, nothing for a person. */
function assertBlockedNotPrompted(h: ReturnType<typeof bridge>) {
  const recovery = h.db.campaignProjection("root")!.recovery!;
  const blocked = recovery.records.filter((record) => record.reason === "request_declined");
  assert.equal(blocked.length, 1, "one content-safe blocked-work record");
  assert.equal(blocked[0]!.resource.sessionId, "child");
  assert.equal(recovery.waitingHuman, 0, "nothing waits on a person");
  assert.equal((h.db.raw().prepare("SELECT COUNT(*) AS n FROM workflow_decisions").get() as { n: number }).n, 0, "no decision for anyone to answer");
}

test("a v229 runner that refuses Dismiss Recovery gets exactly one dismissal and the sign-in becomes blocked work (CR-9.1)", { timeout: 30_000 }, async () => {
  const turn = gate();
  const h = bridge(undefined, turn.promise, 229);
  try {
    assert.ok(h.enable().ok);
    const legacy = legacyDismissal(h);
    h.manager.prompt("child", "work");
    await waitUntil(() => legacy.refusals() > 0, 5_000);
    assert.equal(legacy.refusals(), 1, "the old runner refused after its bounded wait");
    // Long past any former retry window, nothing is re-sent and the card is not resolved.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    assert.deepEqual(h.declinesSent().map((message) => message.optionId), ["auth:dismiss"], "exactly one send");
    assert.equal(resolutions(h), 0);
    assertBlockedNotPrompted(h);
  } finally { turn.open(); h.close(); }
});

test("a control-plane restart right after the one dismissal to a v229 runner sends no second one (CR-9.1)", { timeout: 30_000 }, async () => {
  const turn = gate();
  const h = bridge(undefined, turn.promise, 229);
  try {
    assert.ok(h.enable().ok);
    const legacy = legacyDismissal(h);
    h.manager.prompt("child", "work");
    await waitUntil(() => h.declinesSent().length > 0, 5_000);
    // The control plane restarts while the old runner is still settling, then sees the card again
    // as a reconnect replays it, with a fresh occurrence id as runner startup would give it.
    h.restartControlPlane();
    const card = [...h.fromRunner].reverse().find((message) => message.type === "session_event" &&
      message.payload.kind === "permission_request" && message.payload.purpose === "authentication");
    assert.ok(card && card.type === "session_event" && card.payload.kind === "permission_request");
    h.svc.onSessionEvent("child", { ...card.payload, occurrenceId: "rebuilt-after-restart" });
    await waitUntil(() => legacy.refusals() > 0, 5_000);
    h.svc.onSessionEvent("child", { ...card.payload, occurrenceId: "rebuilt-after-refusal" });
    for (let index = 0; index < 12; index += 1) await tick();
    assert.equal(h.declinesSent().length, 1, "the durable fence holds across the restart");
    assert.equal(legacy.refusals(), 1);
    assertBlockedNotPrompted(h);
  } finally { turn.open(); h.close(); }
});

test("an async credential question is dismissed at once and recorded as blocked work, with no Orchestrator request", () => {
  const h = bridge();
  try {
    assert.ok(h.enable().ok);
    const toRunner: ControlPlaneToRunner[] = [];
    const deliver = (h.svc as unknown as { hub: Hub }).hub.sendToRunner;
    (h.svc as unknown as { hub: Hub }).hub.sendToRunner = (runnerId, message) => { toRunner.push(message); return deliver.call(null, runnerId, message); };
    h.svc.onSessionEvent("child", { kind: "question_request", requestId: "async-secret", occurrenceId: "async-secret",
      requestSource: "provider_question", async: true,
      questions: [{ id: "value", question: "Which password should I use?", options: [{ label: "A" }, { label: "B" }] }] });
    const answers = toRunner.filter((message) => message.type === "answer_question") as Array<Extract<ControlPlaneToRunner, { type: "answer_question" }>>;
    assert.deepEqual(answers.map((message) => [message.requestId, message.action]), [["async-secret", "dismiss"]], "one automatic dismissal");
    assert.ok(!(h.db.getSession("child")!.pendingApproval && JSON.stringify(h.db.getSession("child")!.pendingApproval).includes("async-secret")),
      "the exact pending occurrence is removed");
    const records = h.db.campaignProjection("root")!.recovery!.records;
    assert.deepEqual(records.filter((record) => record.reason === "request_declined").map((record) => [record.resource.sessionId, record.state]),
      [["child", "blocked"]], "one request_declined record");
    assert.equal(records.filter((record) => record.action === "answer_request").length, 0, "no Orchestrator recovery request");
    assert.equal(h.svc.descendantRequests("root", () => true).data!.requests.length, 0);
  } finally { h.close(); }
});

test("a queued ordinary hook ask promoted after a person resolves the gate ahead of it gets the standing decline", () => {
  const h = bridge();
  try {
    assert.ok(h.enable().ok);
    const now = Date.now();
    h.db.upsertGovernancePolicy({ policyId: "person-gate", name: "Person Gate", effect: "ask", priority: 100, enabled: true,
      scope: { toolName: "Gate" }, conditions: { humanRequired: true } }, now);
    h.db.upsertGovernancePolicy({ policyId: "ordinary-ask", name: "Ordinary Ask", effect: "ask", priority: 100, enabled: true,
      scope: { toolName: "Write" } }, now);
    const hook = (toolUseId: string, toolName: string, approvalRequestId?: string) => h.svc.evaluatePolicyHook("root", {
      hookEventName: "PreToolUse", providerSessionId: "root-provider", permissionMode: "plan", toolUseId,
      context: { toolName }, ...(approvalRequestId ? { approvalRequestId } : {}) }, true).data!;
    const gate = hook("gate-1", "Gate");
    assert.equal(gate.decision, "ask");
    assert.equal(h.db.getPolicyHookApproval("root", gate.approvalRequestId!)?.status, "pending", "a Human Required rule stays with the person");
    const ordinary = hook("write-1", "Write");
    assert.equal(h.db.getPolicyHookApproval("root", ordinary.approvalRequestId!)?.status, "queued");

    // The person resolves the gate ahead; promotion settles the queued ask from standing authority.
    assert.ok(h.svc.approve("root", gate.approvalRequestId!, "allow").ok);
    assert.equal(h.db.getPolicyHookApproval("root", ordinary.approvalRequestId!)?.status, "denied");
    const polled = hook("write-1", "Write", ordinary.approvalRequestId);
    assert.equal(polled.decision, "deny", "polling returns the standing decline");
    assert.equal(h.db.getSession("root")!.pendingApproval, null);
    const resolution = h.db.listGovernanceAudit("root").filter((entry) => entry.requestId === ordinary.approvalRequestId && entry.stage === "resolution");
    assert.deepEqual(resolution.map((entry) => [entry.outcome, entry.actor.kind, entry.actor.id]), [["denied", "system", "campaign-standing-decline"]],
      "no human response settled it");
    assert.ok(!h.declinesSent().length, "a hook ask is settled server-side, with no runner round trip");
    assert.ok(!h.fromRunner.some((message) => message.type === "session_event" && message.payload.kind === "user_message"), "no root model turn");
  } finally { h.close(); }
});
