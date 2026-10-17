import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION, type RunnerToControlPlane, type SessionLaunchSpec } from "@wollipog/protocol";
import type { RunnerProviderAccount } from "./config.js";
import { bindSessionProviderAccount, selectProviderAccount, type BoundProviderAccount } from "./provider-accounts.js";
import { LEASE_WORKER_ERRORS } from "./provider-home-lease-worker-protocol.js";
import { writeProviderProfileMarker } from "./provider-profile.js";
import { ProviderProfileGrants } from "./provider-profile-grants.js";
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

const GRANT = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";

function profileMarker(profileId: string, provider: "claude" | "codex") {
  return { version: 1 as const, kind: "wollipog-provider-profile" as const, profileId, provider,
    createdAt: "2026-10-16T00:00:00.000Z", grants: [{ controlPlaneInstanceId: INSTANCE, grantId: GRANT, grantedAt: "2026-10-16T00:00:01.000Z" }] };
}

/** A SessionManager with the real lease worker whose provider construction only counts. */
function leasedManager(root: string, store: SessionStore, resolve: ProviderAccountResolver, created: { count: number }) {
  const messages: RunnerToControlPlane[] = [];
  const manager = new SessionManager(
    (message) => messages.push(message), () => {}, store, "runner", undefined,
    (() => { created.count++; throw new Error("provider construction reached"); }) as never,
    join(root, "runner-data"), 1, undefined, undefined, undefined,
    { mode: "provider", network: "inherit" }, async () => undefined,
    undefined, undefined, async () => {}, undefined, [],
    (meta: SessionMeta) => { if (meta.providerCredentialHome) meta.env = { CLAUDE_CONFIG_DIR: meta.providerCredentialHome }; },
    undefined, undefined, undefined, undefined, "a".repeat(64), undefined, undefined, [], undefined, undefined,
    resolve, undefined, () => [], () => [], INSTANCE,
  );
  return { manager, messages };
}

test("a replacement runner's account without a recorded profile id binds new sessions to the HOME's granted marker identity", { skip: process.platform === "win32" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-profile-replacement-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(home);
  mkdirSync(elsewhere);
  // Another runner adopted this HOME; the replacement runner's account points at it but records no profileId.
  writeProviderProfileMarker(home, profileMarker(PROFILE, "claude"));
  const accounts: RunnerProviderAccount[] = [{ id: "work", label: "Work", provider: "claude", directory: home }];
  const grants = new ProviderProfileGrants({ controlPlaneInstanceId: INSTANCE, accounts: () => accounts });
  assert.deepEqual(grants.reportedProfileIds(), [PROFILE]);
  grants.synchronize(PROTOCOL_VERSION, [{ grantId: GRANT, status: "active", profileId: PROFILE }]);
  assert.deepEqual(grants.accountProfile(accounts[0]!), { id: PROFILE, access: "granted" });
  const resolve: ProviderAccountResolver = (launch) => selectProviderAccount(accounts,
    { id: "claude", driver: "claude-code", context: { kind: "native" } }, "claude-code", launch.providerAccountId);
  const configure = (manager: SessionManager) => manager.configureProviderProfiles({
    access: () => grants.access(),
    expectedProfileIdForHome: (path) => grants.expectedProfileIdForHome(path),
    verifiedProfileIdForAccount: (account) => grants.bindingProfileId(account),
  });

  const store = new SessionStore(join(root, "sessions"));
  const created = { count: 0 };
  const first = leasedManager(root, store, resolve, created);
  configure(first.manager);
  await first.manager.start(spec({ sessionId: "replacement", workspacePath: root, agentId: "claude", command: "claude",
    driver: "claude-code", providerAccountId: "work" }));
  const bound = store.readMeta("replacement")!;
  assert.equal(bound.providerCredentialHome, home);
  assert.equal(bound.providerProfileId, PROFILE, "the new binding records the marker identity the runner verified");
  assert.equal(created.count, 1, "the granted HOME reached provider construction");
  first.manager.shutdownAll();
  await first.manager.releaseProviderHomeLeasesAfterShutdown(true);

  // The configured account is re-pointed elsewhere and the session's original HOME is replaced by a
  // directory without the marker: no configured account now names the path, so only the session's
  // recorded id can refuse it.
  accounts[0] = { ...accounts[0]!, directory: elsewhere };
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home);
  store.patchMeta("replacement", { status: "starting" });
  const second = leasedManager(root, store, resolve, created);
  configure(second.manager);
  t.after(async () => {
    second.manager.shutdownAll();
    await second.manager.releaseProviderHomeLeasesAfterShutdown(true);
  });
  const internals = second.manager as unknown as {
    acquireAdmission: (sessionId: string) => Promise<boolean>;
    launch: (meta: SessionMeta) => Promise<boolean>;
  };
  assert.equal(await internals.acquireAdmission("replacement"), true);
  await internals.launch(store.readMeta("replacement")!);
  assert.equal(created.count, 1, "the replaced HOME is refused before provider construction");
  const failed = second.messages.find((message) => message.type === "session_status" && message.status === "failed");
  assert.ok(failed?.type === "session_status" && failed.detail?.includes(LEASE_WORKER_ERRORS.profile_changed), JSON.stringify(failed));
});

test("only a granted or pending marker identity, or the configured id, is recorded for a new binding", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-profile-binding-id-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  writeProviderProfileMarker(home, profileMarker(PROFILE, "codex"));
  const accounts: RunnerProviderAccount[] = [{ id: "work", label: "Work", provider: "codex", directory: home }];
  const grants = new ProviderProfileGrants({ controlPlaneInstanceId: INSTANCE, accounts: () => accounts });
  const binding = { id: "work", provider: "codex" as const, credentialHome: home };
  grants.reportedProfileIds();
  grants.synchronize(PROTOCOL_VERSION, []);
  assert.equal(grants.bindingProfileId(binding), undefined, "a marker this control plane may not use is not recorded");
  grants.synchronize(PROTOCOL_VERSION, [{ grantId: GRANT, status: "pending" }]);
  assert.equal(grants.bindingProfileId(binding), PROFILE, "a pending grant the marker records counts");
  assert.equal(grants.bindingProfileId({ ...binding, credentialHome: join(root, "other") }), undefined, "another HOME path does not");
  accounts[0] = { ...accounts[0]!, profileId: OTHER_PROFILE };
  assert.equal(grants.bindingProfileId(binding), OTHER_PROFILE, "the configured id wins");
});

/** A fake-provider manager for account handoffs; `launches` records each provider's CODEX_HOME. */
function handoffManager(root: string, resolve: ProviderAccountResolver, launches: string[]) {
  const store = new SessionStore(join(root, "data", "sessions"));
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined,
    ((_driver: unknown, launch: { env: Record<string, string> }) => {
      launches.push(launch.env.CODEX_HOME!);
      return {
        pid: launches.length, initialize: async () => {}, newSession: async () => {}, prompt: async () => "end_turn" as const,
        cancel: () => {}, dispose: () => {}, setConfig: async () => {}, resolvePermission: () => false,
        agentSessionId: () => "codex-thread",
      };
    }) as never, join(root, "data"), 1);
  const internals = manager as unknown as {
    resolveProviderAccount: ProviderAccountResolver;
    transferAccountTranscript: () => Promise<void>;
    prepareLaunch: (meta: SessionMeta) => void;
  };
  internals.resolveProviderAccount = resolve;
  internals.transferAccountTranscript = async () => {};
  internals.prepareLaunch = (meta) => {
    if (meta.providerCredentialHome) meta.env = { CODEX_HOME: meta.providerCredentialHome };
  };
  return { manager, store };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

const handoffAccounts = {
  work: { id: "work", label: "Work", provider: "codex" as const, credentialHome: "/accounts/work" },
  personal: { id: "personal", label: "Personal", provider: "codex" as const, credentialHome: "/accounts/personal" },
};

/** Start a session on Work, schedule a handoff to Personal saved with profile P, and stop the
 * runner (optionally stopping the session first), so a reconstructed manager owns the pending switch. */
async function scheduleProfiledHandoff(root: string, stopSession: boolean): Promise<SessionLaunchSpec> {
  const launches: string[] = [];
  const { manager, store } = handoffManager(root, (launch) =>
    Object.values(handoffAccounts).find((account) => account.id === launch.providerAccountId), launches);
  const launch = spec({ sessionId: "handoff", workspacePath: root, providerAccountId: "work" });
  try {
    assert.equal(await manager.start(launch), true);
    store.patchMeta("handoff", {
      agentSessionId: "codex-thread", providerUnstartedThreadId: undefined,
      pendingProviderAccountId: "personal", pendingProviderAccountLabel: "Personal", pendingProviderAccountProvider: "codex",
      pendingProviderCredentialHome: "/accounts/personal", pendingProviderProfileId: PROFILE,
    });
    if (stopSession) manager.stop("handoff");
  } finally {
    manager.shutdownAll();
  }
  return launch;
}

for (const path of ["a resumed stopped session", "an active session handoff"] as const) {
  test(`${path} keeps the saved pending profile id and refuses a target that now reports another`, async (t) => {
    for (const reported of [OTHER_PROFILE, undefined]) {
      const root = mkdtempSync(join(tmpdir(), "wollipog-profile-pending-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const launch = await scheduleProfiledHandoff(root, path === "a resumed stopped session");
      const launches: string[] = [];
      const { manager, store } = handoffManager(root, (request) => request.providerAccountId === "personal"
        ? { ...handoffAccounts.personal, ...(reported ? { profileId: reported } : {}) }
        : request.providerAccountId === "work" ? handoffAccounts.work : undefined, launches);
      t.after(() => manager.shutdownAll());
      if (path === "an active session handoff") assert.equal(await manager.start(launch), true);
      assert.equal(store.readMeta("handoff")?.pendingProviderProfileId, PROFILE);
      assert.equal(manager.prompt("handoff", "continue"), true);
      if (reported) {
        await waitUntil(() => store.readMeta("handoff")?.pendingProviderAccountId === undefined, "the changed target was not refused");
        const refused = store.readMeta("handoff")!;
        assert.equal(refused.providerAccountId, "work", "the switch did not bind");
        assert.equal(refused.providerProfileId, undefined, `${reported} was never bound`);
        assert.ok(!launches.includes("/accounts/personal"), "no provider started under the changed target");
        if (path === "an active session handoff") {
          assert.match(refused.providerAccountSwitchFailure?.reason ?? "", /provider profile changed/);
        }
      } else {
        await waitUntil(() => store.readMeta("handoff")?.providerAccountId === "personal", "the handoff did not run");
        assert.equal(store.readMeta("handoff")?.providerProfileId, PROFILE, "a target reporting no id binds the saved one");
        assert.equal(store.readMeta("handoff")?.pendingProviderProfileId, undefined);
      }
    }
  });
}
