import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RunnerToControlPlane, SessionSnapshot } from "@wollipog/protocol";
import { ProviderHomeLeaseError, type LeaseWorkerError } from "./provider-home-lease-worker-protocol.js";
import { SessionManager, type LaunchPreparationCancellation } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

// #3240 part 2b: a launch that asked to wait retries a busy provider HOME instead of failing.

const SESSION = "waiting";

const baseMeta = (root: string): SessionMeta => ({
  sessionId: SESSION, agentId: "claude", workspaceId: "repo", repoPath: root, worktreePath: null,
  driver: "claude-code", command: "claude", args: [], env: { CLAUDE_CONFIG_DIR: join(root, "home") },
  context: { kind: "native" }, agentSessionId: null, status: "starting", title: "Waiting", config: {},
  tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  providerAccountId: "work", providerAccountLabel: "Work", providerAccountProvider: "claude",
  providerCredentialHome: join(root, "home"),
});

interface WaitHarness {
  manager: SessionManager;
  store: SessionStore;
  messages: RunnerToControlPlane[];
  driversCreated: () => number;
  /** Refusals the driver's lease acquisitions meet, in order; a grant once they run out. */
  driverLease: LeaseWorkerError[];
  /** Refusals launch preparation's account-HOME acquisitions meet, in order. */
  preparationLease: LeaseWorkerError[];
  attempts: { driver: number; preparation: number };
  /** Launch once, as a start that asked to wait (or not). */
  launch(options?: { wait?: boolean }): Promise<boolean>;
}

function harness(t: TestContext): WaitHarness {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-home-wait-"));
  const store = new SessionStore(join(root, "sessions"));
  store.create(baseMeta(root));
  const messages: RunnerToControlPlane[] = [];
  let created = 0;
  const driverLease: LeaseWorkerError[] = [];
  const preparationLease: LeaseWorkerError[] = [];
  const attempts = { driver: 0, preparation: 0 };
  let manager: SessionManager;
  // Launch preparation takes the account HOME through the manager, as the runner's does.
  const prepareLaunch = async (meta: SessionMeta, cancellation?: LaunchPreparationCancellation) => {
    await manager.acquireLaunchProviderHome(join(root, "home"), cancellation, meta);
  };
  manager = new SessionManager((message) => messages.push(message), () => {}, store, "runner", undefined,
    (() => { created++; throw new Error("provider construction reached"); }) as never,
    join(root, "runner-data"), 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, [], prepareLaunch);
  manager.providerHomeWaitSchedule = { initialMs: 5, maxMs: 20, limitMs: 60_000, pollMs: 5 };
  const reference = { first: true, release: async () => true, retain: async () => {} };
  const driver = async () => {
    attempts.driver++;
    const refuse = driverLease.shift();
    if (refuse) throw new ProviderHomeLeaseError(refuse);
    return reference;
  };
  (manager as unknown as { providerHomeLeases: unknown }).providerHomeLeases = {
    stopAcquisitions() {},
    async close() { return true; },
    async acquireHomeReference() {
      attempts.preparation++;
      const refuse = preparationLease.shift();
      if (refuse) throw new ProviderHomeLeaseError(refuse);
      return reference;
    },
    acquireReference: driver,
    acquire: driver,
  };
  t.after(() => { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); });
  const internals = manager as unknown as {
    acquireAdmission: (sessionId: string) => Promise<boolean>;
    beginLaunchGeneration: (sessionId: string) => number;
    providerHomeWaitLaunches: Map<string, number>;
    launch: (meta: SessionMeta, resumeId: string | undefined, generation: number) => Promise<boolean>;
  };
  return {
    manager, store, messages, driverLease, preparationLease, attempts, driversCreated: () => created,
    async launch(options = {}) {
      store.patchMeta(SESSION, { status: "starting" });
      assert.equal(await internals.acquireAdmission(SESSION), true);
      const generation = internals.beginLaunchGeneration(SESSION);
      if (options.wait) internals.providerHomeWaitLaunches.set(SESSION, generation);
      return internals.launch(store.readMeta(SESSION)!, undefined, generation);
    },
  };
}

function waits(messages: RunnerToControlPlane[]): SessionSnapshot["providerHomeWait"][] {
  return messages.flatMap((message) => message.type === "session_runtime_updated" && "providerHomeWait" in message.snapshot
    ? [message.snapshot.providerHomeWait] : []);
}

async function until(condition: () => boolean, what = "condition"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} was not met in time`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a waiting launch retries a busy driver lease, shows the wait, and starts the provider only once granted", async (t) => {
  const h = harness(t);
  h.driverLease.push("busy", "busy");
  await h.launch({ wait: true });
  assert.equal(h.attempts.driver, 3, "two busy attempts, then the grant");
  assert.equal(h.driversCreated(), 1, "the provider started once, after the grant");
  const reported = waits(h.messages).filter((wait) => wait);
  assert.ok(reported.length >= 1, "the starting session reported its wait");
  const wait = reported[0]!;
  assert.equal(wait.provider, "claude");
  assert.equal(wait.providerAccountId, "work");
  assert.equal(wait.providerAccountLabel, "Work");
  assert.equal(wait.cause, undefined);
  assert.equal(wait.waitUntil - wait.waitingSince, 60_000);
  assert.ok(!JSON.stringify(wait).includes("home"), "the wait names no path");
  assert.equal(waits(h.messages).at(-1), null, "the wait clears once the lease is granted");
  assert.equal(h.store.readMeta(SESSION)?.providerHomeRefusal, undefined, "a wait is not a refusal");
  assert.ok(!h.messages.some((message) => message.type === "session_status" && message.status === "failed" &&
    message.detail?.includes("in use")), "the session never failed for the busy account");
});

test("a waiting launch also waits out its preparation's busy account HOME, keeping the specific cause", async (t) => {
  const h = harness(t);
  h.preparationLease.push("holder_alive");
  await h.launch({ wait: true });
  assert.equal(h.attempts.preparation, 2);
  assert.equal(h.driversCreated(), 1);
  assert.equal(waits(h.messages).find((wait) => wait)?.cause, "holder_alive");
  assert.equal(waits(h.messages).at(-1), null);
});

test("Stop cancels the wait: nothing starts and no refusal is recorded", async (t) => {
  const h = harness(t);
  h.driverLease.push(...Array<LeaseWorkerError>(1_000).fill("busy"));
  const launched = h.launch({ wait: true });
  await until(() => waits(h.messages).some((wait) => wait));
  h.manager.stop(SESSION);
  assert.equal(await launched, false);
  assert.equal(h.driversCreated(), 0);
  assert.equal(waits(h.messages).at(-1), null, "the wait clears");
  assert.equal(h.store.readMeta(SESSION)?.status, "stopped");
  assert.equal(h.store.readMeta(SESSION)?.providerHomeRefusal, undefined);
});

test("a superseded waiting launch's cleanup leaves its replacement's wait projected", async (t) => {
  const h = harness(t);
  const leases = (h.manager as unknown as { providerHomeLeases: { acquireReference: () => Promise<unknown> } }).providerHomeLeases;
  // Generation A's second attempt is still in flight when a restart that also waits replaces it.
  let attempts = 0;
  let releaseA!: () => void;
  const aInFlight = new Promise<void>((resolve) => { releaseA = resolve; });
  let aEntered!: () => void;
  const aWaiting = new Promise<void>((resolve) => { aEntered = resolve; });
  leases.acquireReference = async () => {
    attempts++;
    if (attempts === 2) { aEntered(); await aInFlight; }
    throw new ProviderHomeLeaseError("busy");
  };
  const first = h.launch({ wait: true });
  await aWaiting;
  const second = h.launch({ wait: true });
  await until(() => attempts >= 3, "the replacement met the busy account");
  const replacementWait = waits(h.messages).at(-1);
  assert.ok(replacementWait, "the replacement is waiting");
  // A's in-flight attempt now fails; A sees it was superseded and cleans up after itself only.
  releaseA();
  assert.equal(await first, false, "the superseded launch ends");
  const snapshot = (h.manager as unknown as { snapshot: (meta: SessionMeta) => SessionSnapshot })
    .snapshot(h.store.readMeta(SESSION)!);
  assert.deepEqual(snapshot.providerHomeWait, replacementWait, "the replacement is still shown waiting");
  assert.notEqual(waits(h.messages).at(-1), null, "no stale clear was published for the replacement");
  h.manager.stop(SESSION);
  assert.equal(await second, false);
  assert.equal(waits(h.messages).at(-1), null);
  assert.equal(h.driversCreated(), 0);
});

test("a waiting launch fails at once on a refusal that waiting can't clear", async (t) => {
  const h = harness(t);
  h.driverLease.push("foreign_owner");
  assert.equal(await h.launch({ wait: true }), false);
  assert.equal(h.attempts.driver, 1);
  assert.equal(h.driversCreated(), 0);
  assert.equal(h.store.readMeta(SESSION)?.providerHomeRefusal?.code, "foreign_owner");
  assert.ok(!waits(h.messages).some((wait) => wait), "no wait was reported");
});

test("a wait that reaches its limit fails the launch with the ordinary busy refusal", async (t) => {
  const h = harness(t);
  h.manager.providerHomeWaitSchedule = { initialMs: 5, maxMs: 5, limitMs: 30, pollMs: 5 };
  h.driverLease.push(...Array<LeaseWorkerError>(1_000).fill("busy"));
  assert.equal(await h.launch({ wait: true }), false);
  assert.ok(h.attempts.driver > 1, "it retried before giving up");
  assert.equal(h.driversCreated(), 0);
  assert.equal(h.store.readMeta(SESSION)?.providerHomeRefusal?.code, "busy");
  assert.equal(waits(h.messages).at(-1), null);
  assert.ok(h.messages.some((message) => message.type === "session_status" && message.status === "failed"));
});

test("a launch that did not ask to wait keeps failing on a busy account", async (t) => {
  const h = harness(t);
  h.driverLease.push("busy");
  assert.equal(await h.launch(), false);
  assert.equal(h.attempts.driver, 1);
  assert.equal(h.store.readMeta(SESSION)?.providerHomeRefusal?.code, "busy");
  assert.ok(!waits(h.messages).some((wait) => wait));
});

test("only a v248 control plane receives the wait", async (t) => {
  const h = harness(t);
  (h.manager as unknown as { controlPlaneProtocolVersion: () => number }).controlPlaneProtocolVersion = () => 247;
  h.driverLease.push("busy");
  await h.launch({ wait: true });
  assert.equal(h.driversCreated(), 1, "an older control plane can't ask to wait, but the runner honours the start it got");
  assert.ok(h.messages.some((message) => message.type === "session_runtime_updated"));
  assert.ok(!h.messages.some((message) => message.type === "session_runtime_updated" && "providerHomeWait" in message.snapshot));
});
