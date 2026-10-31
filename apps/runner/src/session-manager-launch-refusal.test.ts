import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { PROVIDER_HOME_RECOVERY_CAUSES, PROVIDER_HOME_RECOVERY_CAUSE_CODES, type RunnerToControlPlane, type SessionSnapshot } from "@wollipog/protocol";
import { providerHomeLaunchRefusal, providerHomeLaunchRefusalCode } from "./provider-home-launch-refusal.js";
import { LEASE_WORKER_ERRORS, ProviderHomeLeaseError, type LeaseWorkerError } from "./provider-home-lease-worker-protocol.js";
import { SessionManager } from "./session-manager.js";
import { metaToSnapshot, SessionStore, type SessionMeta } from "./session-store.js";

test("each lease state a launch can meet maps to its launch refusal code; everything else stays text", () => {
  const expected: Record<LeaseWorkerError, string | undefined> = {
    busy: "busy", foreign_owner: "foreign_owner", foreign_host: "foreign_host", unavailable: "unavailable",
    refusal: "unverifiable", profile_not_granted: "profile_not_granted", profile_changed: "profile_changed",
    profile_unverifiable: "profile_unverifiable",
    holder_alive: "busy", boundary_survivor: "busy", process_survivor: "busy",
    boundary_unverifiable: "unverifiable", process_uninspectable: "unverifiable",
    process_uninspectable_not_delegated: "unverifiable", invalid_journal: "unverifiable",
    // Not a state of the HOME a person can act on from the session.
    cancelled: undefined, cancel_release_failed: undefined, expired: undefined,
    profile_unsupported_control_plane: "unverifiable", profile_grant_limit: "unverifiable",
    stale_tip_changed: undefined, no_reboot_proof: "unverifiable", recovery_unconfirmed: undefined,
    // Only an import (#3719) meets these, never a launch.
    import_source_missing: undefined, import_source_held: undefined, import_source_unsafe: undefined,
    import_source_foreign: undefined, import_source_unsupported: undefined, import_source_changed: undefined,
  };
  for (const [code, launch] of Object.entries(expected) as [LeaseWorkerError, string | undefined][]) {
    assert.equal(providerHomeLaunchRefusalCode(new ProviderHomeLeaseError(code)), launch, code);
  }
  // The text alone never carries a code: only the worker's typed error does.
  assert.equal(providerHomeLaunchRefusalCode(new Error(LEASE_WORKER_ERRORS.busy)), undefined);
});

test("a launch refusal names the bound account, or none for the runner's own HOME", () => {
  const error = new ProviderHomeLeaseError("foreign_owner");
  assert.deepEqual(providerHomeLaunchRefusal(error, { driver: "claude-code", providerAccountId: "work", providerAccountLabel: "Work" }, 5),
    { code: "foreign_owner", provider: "claude", providerAccountId: "work", providerAccountLabel: "Work", detectedAt: 5 });
  assert.deepEqual(providerHomeLaunchRefusal(error, { driver: "codex-app-server" }, 6),
    { code: "foreign_owner", provider: "codex", detectedAt: 6 });
  assert.equal(providerHomeLaunchRefusal(error, { driver: "acp" }), undefined, "a driver without a provider HOME has none");
});

const baseMeta = (root: string, overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId: "refused", agentId: "claude", workspaceId: "repo", repoPath: root, worktreePath: null,
  driver: "claude-code", command: "claude", args: [], env: { CLAUDE_CONFIG_DIR: join(root, "home") },
  context: { kind: "native" }, agentSessionId: null, status: "starting", title: "Refused", config: {},
  tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  providerAccountId: "work", providerAccountLabel: "Work", providerAccountProvider: "claude",
  providerCredentialHome: join(root, "home"), ...overrides,
});

test("session snapshots carry the launch refusal only to a v233 control plane", () => {
  const meta = baseMeta("/repo", { providerHomeRefusal: { code: "busy", provider: "claude", detectedAt: 1 } });
  assert.deepEqual(metaToSnapshot(meta, 233).providerHomeRefusal, { code: "busy", provider: "claude", detectedAt: 1 });
  assert.equal(metaToSnapshot(baseMeta("/repo"), 233).providerHomeRefusal, null, "no refusal is an explicit null");
  assert.equal("providerHomeRefusal" in metaToSnapshot(meta, 232), false, "an older control plane never receives it");
  assert.equal("providerHomeRefusal" in metaToSnapshot(meta, null), false);
});

interface LaunchHarness {
  store: SessionStore;
  messages: RunnerToControlPlane[];
  driversCreated: () => number;
  /** What the next driver acquisition does: refuse with a code, or grant. */
  driverLease: { refuse?: LeaseWorkerError };
  /** What the next launch preparation does: refuse with a code, or nothing. */
  preparation: { refuse?: LeaseWorkerError };
  launch(): Promise<boolean>;
}

function harness(t: TestContext): LaunchHarness {
  const root = mkdtempSync(join(tmpdir(), "wollipog-launch-refusal-"));
  const store = new SessionStore(join(root, "sessions"));
  store.create(baseMeta(root));
  const messages: RunnerToControlPlane[] = [];
  let created = 0;
  const driverLease: LaunchHarness["driverLease"] = {};
  const preparation: LaunchHarness["preparation"] = {};
  const prepareLaunch = async () => {
    if (preparation.refuse) throw new ProviderHomeLeaseError(preparation.refuse);
  };
  const manager = new SessionManager((message) => messages.push(message), () => {}, store, "runner", undefined,
    (() => { created++; throw new Error("provider construction reached"); }) as never,
    join(root, "runner-data"), 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, [], prepareLaunch);
  const reference = { first: true, release: async () => true, retain: async () => {} };
  (manager as unknown as { providerHomeLeases: unknown }).providerHomeLeases = {
    stopAcquisitions() {},
    async close() { return true; },
    async acquireHomeReference() { return reference; },
    async acquireReference() {
      if (driverLease.refuse) throw new ProviderHomeLeaseError(driverLease.refuse);
      return reference;
    },
    async acquire() {
      if (driverLease.refuse) throw new ProviderHomeLeaseError(driverLease.refuse);
      return true;
    },
  };
  t.after(() => { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); });
  const internals = manager as unknown as {
    acquireAdmission: (sessionId: string) => Promise<boolean>;
    launch: (meta: SessionMeta) => Promise<boolean>;
  };
  return {
    store, messages, driverLease, preparation, driversCreated: () => created,
    async launch() {
      store.patchMeta("refused", { status: "starting" });
      assert.equal(await internals.acquireAdmission("refused"), true);
      return internals.launch(store.readMeta("refused")!);
    },
  };
}

function lastRefusal(messages: RunnerToControlPlane[]): SessionSnapshot["providerHomeRefusal"] {
  const updates = messages.filter((message) => message.type === "session_runtime_updated");
  const last = updates.at(-1);
  return last?.type === "session_runtime_updated" ? last.snapshot.providerHomeRefusal : undefined;
}

function errorEvents(messages: RunnerToControlPlane[]): string[] {
  return messages.flatMap((message) => message.type === "session_event" && message.payload.kind === "error"
    ? [message.payload.message] : []);
}

test("a driver launch refused at its lease records the typed refusal, and the next launch clears it", async (t) => {
  const h = harness(t);
  h.driverLease.refuse = "foreign_owner";
  assert.equal(await h.launch(), false);
  assert.equal(h.driversCreated(), 0, "no provider starts");
  const refusal = h.store.readMeta("refused")?.providerHomeRefusal;
  assert.equal(refusal?.code, "foreign_owner");
  assert.equal(refusal?.provider, "claude");
  assert.equal(refusal?.providerAccountId, "work");
  assert.equal(refusal?.providerAccountLabel, "Work");
  assert.deepEqual(lastRefusal(h.messages), refusal, "the control plane receives it");
  assert.ok(h.messages.some((message) => message.type === "session_status" && message.status === "failed" &&
    message.detail === LEASE_WORKER_ERRORS.foreign_owner));
  assert.ok(!JSON.stringify(refusal).includes("home"), "the refusal names no path");

  // A granted lease clears the refusal before the provider is constructed.
  h.driverLease.refuse = undefined;
  h.messages.length = 0;
  await h.launch();
  assert.equal(h.driversCreated(), 1);
  assert.equal(h.store.readMeta("refused")?.providerHomeRefusal, undefined);
  const cleared = h.messages.find((message) => message.type === "session_runtime_updated");
  assert.equal(cleared?.type === "session_runtime_updated" ? cleared.snapshot.providerHomeRefusal : "missing", null);
});

test("a launch that fails for another reason records no refusal", async (t) => {
  const h = harness(t);
  await h.launch();
  assert.equal(h.driversCreated(), 1);
  assert.equal(h.store.readMeta("refused")?.providerHomeRefusal, undefined);
  assert.ok(!h.messages.some((message) => message.type === "session_runtime_updated" && message.snapshot.providerHomeRefusal));
});

test("surviving boundary work keeps ownership and reports the existing busy launch category", async (t) => {
  const h = harness(t);
  h.driverLease.refuse = "boundary_survivor";
  assert.equal(await h.launch(), false);
  assert.equal(h.driversCreated(), 0);
  assert.equal(h.store.readMeta("refused")?.providerHomeRefusal?.code, "busy");
  assert.equal(lastRefusal(h.messages)?.code, "busy");
  const guidance = LEASE_WORKER_ERRORS.boundary_survivor;
  assert.match(guidance, /earlier session is still using this account/u);
  assert.doesNotMatch(guidance, /kill|stop/iu);
  assert.ok(h.messages.some((message) => message.type === "session_status" && message.detail === guidance));
});

test("uninspectable fallback reports the existing unverifiable launch category without starting a provider", async (t) => {
  const h = harness(t);
  h.preparation.refuse = "process_uninspectable_not_delegated";
  assert.equal(await h.launch(), false);
  assert.equal(h.driversCreated(), 0);
  assert.equal(h.store.readMeta("refused")?.providerHomeRefusal?.code, "unverifiable");
  assert.equal(lastRefusal(h.messages)?.code, "unverifiable");
  assert.ok(errorEvents(h.messages).some((message) => message.includes("save your work and restart the machine")));
  for (const message of errorEvents(h.messages)) assert.doesNotMatch(message, /HOME|fallback|delegat|cgroup|journal/iu);
});

test("a launch preparation refused at the account's lease is reported as the account, not as isolation", async (t) => {
  const h = harness(t);
  h.preparation.refuse = "profile_not_granted";
  assert.equal(await h.launch(), false);
  assert.equal(h.driversCreated(), 0);
  assert.equal(h.store.readMeta("refused")?.providerHomeRefusal?.code, "profile_not_granted");
  const errors = errorEvents(h.messages);
  assert.ok(errors.some((message) => message.startsWith("provider account unavailable: ")), errors.join("\n"));
  assert.ok(!errors.some((message) => message.includes("execution isolation unavailable")), errors.join("\n"));
  assert.ok(h.messages.some((message) => message.type === "session_status" && message.status === "failed" &&
    message.detail === LEASE_WORKER_ERRORS.profile_not_granted));
});

test("specific ownership causes survive preparation and driver-lease launch boundaries", async (t) => {
  const h = harness(t);
  for (const stage of [h.preparation, h.driverLease]) {
    for (const cause of PROVIDER_HOME_RECOVERY_CAUSES) {
      stage.refuse = cause;
      h.messages.length = 0;
      assert.equal(await h.launch(), false, cause);
      const refusal = h.store.readMeta("refused")?.providerHomeRefusal;
      assert.equal(refusal?.cause, cause);
      assert.equal(refusal?.code, PROVIDER_HOME_RECOVERY_CAUSE_CODES[cause]);
      assert.equal(lastRefusal(h.messages)?.cause, cause);
      const errors = errorEvents(h.messages);
      assert.ok(!errors.some(message => message.includes("execution isolation")), cause);
      assert.ok(errors.some(message => message.startsWith("provider account unavailable: ")), `${cause}: both launch paths retain the transcript classifier's compatible prefix`);
      assert.ok(h.messages.some(message => message.type === "session_status" && message.detail === LEASE_WORKER_ERRORS[cause]), cause);
    }
    stage.refuse = undefined;
  }
  assert.equal(h.driversCreated(), 0);
});

test("v233-v234 peers keep the coarse refusal while v235 receives its specific cause", () => {
  const refusal = { code: "unverifiable" as const, provider: "claude" as const, detectedAt: 1, cause: "process_uninspectable_not_delegated" as const };
  const meta = baseMeta("/repo", { providerHomeRefusal: refusal });
  assert.deepEqual(metaToSnapshot(meta, 235).providerHomeRefusal, refusal);
  for (const version of [233, 234]) {
    const { cause: _cause, ...coarse } = refusal;
    assert.deepEqual(metaToSnapshot(meta, version).providerHomeRefusal, coarse);
  }
});

// Covers the actual user-visible transcript and status emitted before provider construction.
test("legacy recovery refuses safely with an actionable session error and its structured cause", async (t) => {
  const h = harness(t);
  h.preparation.refuse = "process_uninspectable";
  assert.equal(await h.launch(), false);
  assert.equal(h.driversCreated(), 0);
  const refusal = lastRefusal(h.messages);
  assert.equal(refusal?.cause, "process_uninspectable");
  assert.equal(refusal?.code, "unverifiable");
  const errors = errorEvents(h.messages);
  assert.ok(errors.some(message => /can't check whether another program is still using this account/.test(message)));
  assert.ok(errors.some(message => /Choose another account.*save your work and restart the machine/.test(message)));
  assert.ok(h.messages.some(message => message.type === "session_status" && message.status === "failed" && message.detail === LEASE_WORKER_ERRORS.process_uninspectable));
  for (const message of errors) assert.doesNotMatch(message, /HOME|fallback|boundary|delegat|cgroup|journal|inspectability/iu);
});
