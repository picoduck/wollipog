import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION, type RunnerToControlPlane, type SessionLaunchSpec } from "@wollipog/protocol";
import { bindSessionProviderAccount, type BoundProviderAccount } from "./provider-accounts.js";
import { LEASE_WORKER_ERRORS } from "./provider-home-lease-worker-protocol.js";
import { writeProviderProfileMarker } from "./provider-profile.js";
import { SessionManager, sessionProviderProfileBinding, type ProviderAccountResolver } from "./session-manager.js";
import { metaToSnapshot, SessionStore, type SessionMeta } from "./session-store.js";

const PROFILE = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const OTHER_PROFILE = "7f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const INSTANCE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";

const spec = (overrides: Partial<SessionLaunchSpec> = {}): SessionLaunchSpec => ({
  sessionId: "profiled", workspaceId: "repo", workspacePath: "/repo", agentId: "codex", command: "codex", args: [],
  env: {}, useWorktree: false, driver: "codex-app-server", context: { kind: "native" }, ...overrides,
});

const baseMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId: "profiled", agentId: "codex", workspaceId: "repo", repoPath: "/repo", worktreePath: null,
  driver: "codex-app-server", command: "codex", args: [], env: {}, context: { kind: "native" }, agentSessionId: null,
  status: "idle", title: "Profiled", config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null,
  pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1, ...overrides,
});

test("only a new binding records the account's profile id; a prior binding keeps its homes without one", () => {
  const profiled: BoundProviderAccount = { id: "work", label: "Work", provider: "codex", credentialHome: "/accounts/work", profileId: PROFILE };
  assert.deepEqual(bindSessionProviderAccount(null, spec(), () => profiled), profiled, "a new binding records the profile");

  const legacy = baseMeta({ providerAccountId: "work", providerAccountLabel: "Work", providerAccountProvider: "codex",
    providerCredentialHome: "/accounts/old-work" });
  assert.deepEqual(bindSessionProviderAccount(legacy, spec(), () => profiled),
    { id: "work", label: "Work", provider: "codex", credentialHome: "/accounts/old-work" },
    "a binding made before adoption keeps its recorded home and gains no profile id");

  const recorded = baseMeta({ ...legacy, providerCredentialHome: "/accounts/work", providerProfileId: PROFILE });
  assert.equal(bindSessionProviderAccount(recorded, spec(), () => ({ ...profiled, profileId: OTHER_PROFILE }))?.profileId, PROFILE,
    "a restart keeps the recorded profile id, not the account's current one");
  assert.equal(bindSessionProviderAccount(baseMeta(), spec(), () => profiled), undefined, "a legacy-HOME session stays unbound");
});

test("the recorded profile id binds only the session's own credential HOME", () => {
  assert.deepEqual(sessionProviderProfileBinding({ providerProfileId: PROFILE, providerCredentialHome: "/accounts/work" }, "/accounts/work"),
    { expectedProfileId: PROFILE });
  assert.deepEqual(sessionProviderProfileBinding({ providerProfileId: PROFILE, providerCredentialHome: "/accounts/work" }, "/elsewhere"), {});
  assert.deepEqual(sessionProviderProfileBinding({ providerCredentialHome: "/accounts/work" }, "/accounts/work"), {});
});

test("session snapshots carry the recorded profile id only to a v225 control plane", () => {
  const meta = baseMeta({ providerAccountId: "work", providerProfileId: PROFILE });
  assert.equal(metaToSnapshot(meta, PROTOCOL_VERSION).providerProfileId, PROFILE);
  assert.equal(metaToSnapshot(baseMeta({ providerAccountId: "work" }), PROTOCOL_VERSION).providerProfileId, null,
    "a binding without a profile is an explicit null");
  assert.equal("providerProfileId" in metaToSnapshot(meta, 224), false, "an older control plane never receives it");
  assert.equal("providerProfileId" in metaToSnapshot(meta, null), false, "nor does a pre-negotiation registration snapshot");
});

function makeSwitchManager(root: string, accounts: Record<string, BoundProviderAccount>) {
  const store = new SessionStore(join(root, "sessions"));
  const messages: RunnerToControlPlane[] = [];
  const manager = new SessionManager((message) => messages.push(message), () => {}, store, "runner", undefined,
    (() => { throw new Error("no provider starts in this test"); }) as never, join(root, "data"), 1);
  (manager as unknown as { resolveProviderAccount: ProviderAccountResolver }).resolveProviderAccount =
    (launch) => Object.values(accounts).find((account) => account.id === launch.providerAccountId);
  return { manager, store, messages };
}

test("an account-switch handoff records the target's profile id as pending, and the new binding takes it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-profile-switch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const accounts = {
    work: { id: "work", label: "Work", provider: "codex" as const, credentialHome: "/accounts/work" },
    personal: { id: "personal", label: "Personal", provider: "codex" as const, credentialHome: "/accounts/personal", profileId: PROFILE },
    backup: { id: "backup", label: "Backup", provider: "codex" as const, credentialHome: "/accounts/backup" },
  };
  const { manager, store } = makeSwitchManager(root, accounts);
  t.after(() => manager.shutdownAll());
  store.create(baseMeta({ repoPath: root, providerAccountId: "work", providerAccountLabel: "Work", providerAccountProvider: "codex",
    providerCredentialHome: "/accounts/work" }));

  assert.deepEqual(await manager.switchProviderAccount("profiled", "personal"), { ok: true, scheduled: true });
  const scheduled = store.readMeta("profiled")!;
  assert.equal(scheduled.pendingProviderCredentialHome, "/accounts/personal");
  assert.equal(scheduled.pendingProviderProfileId, PROFILE);
  assert.equal(scheduled.providerProfileId, undefined, "the current binding is unchanged until the handoff");

  const internals = manager as unknown as {
    pendingProviderAccount(meta: SessionMeta): BoundProviderAccount | undefined;
    providerAccountBindingPatch(meta: SessionMeta, target: BoundProviderAccount): Partial<SessionMeta>;
  };
  const pending = internals.pendingProviderAccount(scheduled);
  assert.equal(pending?.profileId, PROFILE, "a crash-recovered handoff keeps the target's profile id");
  const rebound = internals.providerAccountBindingPatch(scheduled, pending!);
  assert.equal(rebound.providerProfileId, PROFILE);
  assert.equal(rebound.pendingProviderProfileId, undefined);

  // A newer selection made mid-handoff to an unprofiled account becomes the follow-up and
  // carries no profile id; the binding the handoff makes still records the profiled target's.
  const followUp = internals.providerAccountBindingPatch({ ...scheduled, pendingProviderAccountId: "backup",
    pendingProviderAccountLabel: "Backup", pendingProviderCredentialHome: "/accounts/backup", pendingProviderProfileId: undefined },
  accounts.personal);
  assert.equal(followUp.providerProfileId, PROFILE);
  assert.equal(followUp.pendingProviderAccountId, "backup");
  assert.equal(followUp.pendingProviderProfileId, undefined);

  // Switching back to an unprofiled account clears the recorded id.
  assert.equal(internals.providerAccountBindingPatch({ ...scheduled, ...rebound } as SessionMeta, accounts.work).providerProfileId, undefined);
});

/** A real SessionManager and lease worker: the session's recorded profile id is the expected id of
 * its launch acquisition, ahead of the (here absent) id the configured account records for the path. */
async function launchAgainstHome(t: { after(fn: () => unknown): void }, marker: string | null, recorded: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-profile-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  if (marker) {
    writeProviderProfileMarker(home, { version: 1, kind: "wollipog-provider-profile", profileId: marker, provider: "claude",
      createdAt: "2026-10-16T00:00:00.000Z",
      grants: [{ controlPlaneInstanceId: INSTANCE, grantId: "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", grantedAt: "2026-10-16T00:00:01.000Z" }] });
  }
  const store = new SessionStore(join(root, "sessions"));
  const meta: SessionMeta = {
    ...baseMeta({ sessionId: "profile-launch", repoPath: root, agentId: "claude", driver: "claude-code", command: "claude",
      status: "starting", title: "Profile Launch" }),
    env: { CLAUDE_CONFIG_DIR: home }, providerAccountId: "work", providerAccountLabel: "Work", providerAccountProvider: "claude",
    providerCredentialHome: home, ...(recorded ? { providerProfileId: recorded } : {}),
  };
  store.create(meta);
  const messages: RunnerToControlPlane[] = [];
  let driversCreated = 0;
  const manager = new SessionManager(
    (message) => messages.push(message), () => {}, store, "runner", undefined,
    (() => { driversCreated++; throw new Error("provider construction reached"); }) as never,
    join(root, "runner-data"), 1, undefined, undefined, undefined,
    { mode: "provider", network: "inherit" }, async () => undefined,
    undefined, undefined, async () => {}, undefined, [], undefined, undefined, undefined, undefined,
    undefined, "a".repeat(64), undefined, undefined, [], undefined, undefined, undefined, undefined,
    () => [], () => [], INSTANCE,
  );
  // Every profile is granted here, and no configured account names this HOME (a renamed or
  // re-pointed account): only the session's own recorded id can catch a substitution.
  manager.configureProviderProfiles({
    access: () => ({ controlPlaneSupportsProfiles: true, activeProfileIds: [PROFILE, OTHER_PROFILE] }),
    expectedProfileIdForHome: () => undefined,
  });
  t.after(async () => {
    manager.shutdownAll();
    await manager.releaseProviderHomeLeasesAfterShutdown(true);
  });
  const internals = manager as unknown as {
    acquireAdmission: (sessionId: string) => Promise<boolean>;
    launch: (meta: SessionMeta) => Promise<boolean>;
  };
  assert.equal(await internals.acquireAdmission(meta.sessionId), true);
  await internals.launch(store.readMeta(meta.sessionId)!);
  const failed = messages.find((message) => message.type === "session_status" && message.status === "failed");
  return { driversCreated, failedDetail: failed?.type === "session_status" ? failed.detail : undefined };
}

test("a session's recorded profile id refuses a substituted HOME before any provider starts", { skip: process.platform === "win32" }, async (t) => {
  const substituted = await launchAgainstHome(t, OTHER_PROFILE, PROFILE);
  assert.equal(substituted.driversCreated, 0);
  assert.ok(substituted.failedDetail?.includes(LEASE_WORKER_ERRORS.profile_changed), String(substituted.failedDetail));

  const emptied = await launchAgainstHome(t, null, PROFILE);
  assert.equal(emptied.driversCreated, 0, "a replacement directory without the marker is refused too");
  assert.ok(emptied.failedDetail?.includes(LEASE_WORKER_ERRORS.profile_changed), String(emptied.failedDetail));
});

test("the recorded HOME is used when it still holds the session's profile, and a prior binding is not checked against one", { skip: process.platform === "win32" }, async (t) => {
  const same = await launchAgainstHome(t, PROFILE, PROFILE);
  assert.equal(same.driversCreated, 1, "the lease was granted and the launch reached provider construction");

  const prior = await launchAgainstHome(t, OTHER_PROFILE, undefined);
  assert.equal(prior.driversCreated, 1, "a binding made before adoption names no profile id");
});
