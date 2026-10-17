import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import type { ControlPlaneToRunner, ProviderAccountDefinition } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { Hub, RunnerRequestResult } from "./hub.js";
import { PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import {
  providerProfileGrantsForRunner,
  reconcileProviderProfileGrants,
  registerProviderProfileRoutes,
  revokeProviderProfileAccessForAccountRemoval,
  revokeProviderProfileGrantsForAccountRemoval,
} from "./provider-profile-route.js";

const PROFILE = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const OTHER_PROFILE = "7f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const ADOPT = "/api/runners/runner-a/provider-accounts/work/adopt-profile";
const REVOKE = "/api/runners/runner-a/provider-accounts/work/revoke-profile-access";

function principal(role: HumanPrincipal["role"] = "owner", organizationId = PERSONAL_ORGANIZATION_ID): HumanPrincipal {
  return {
    kind: "human", actorId: "user-1", userId: "user-1", userName: "Test User", organizationId,
    organizationName: organizationId, role, deviceId: null, localBootstrap: false,
  };
}

function account(id: string, profile?: ProviderAccountDefinition["profile"]): ProviderAccountDefinition {
  return { id, label: id, provider: "claude", authStatus: "authenticated", ...(profile ? { profile } : {}) };
}

type Handler = (runnerId: string, message: ControlPlaneToRunner) => RunnerRequestResult | Promise<RunnerRequestResult>;

async function fixture(options: { protocolVersion?: number; handler?: Handler; accounts?: ProviderAccountDefinition[] } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const register = (runnerId: string, accounts: ProviderAccountDefinition[], protocolVersion = options.protocolVersion ?? 225,
    scope = { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "organization" as const, organizationId: PERSONAL_ORGANIZATION_ID } }) =>
    db.registerRunner({ runnerId, hostname: runnerId, os: "linux", version: "1", agents: [], workspaces: [], providerAccounts: accounts },
      1, protocolVersion, scope);
  register("runner-a", options.accounts ?? [account("work"), account("other")]);
  const sent: Array<{ runnerId: string; message: ControlPlaneToRunner }> = [];
  const online = new Set(["runner-a"]);
  let handler: Handler = options.handler ?? (() => { throw new Error("runner request timed out"); });
  const hub = {
    isRunnerOnline: (runnerId: string) => online.has(runnerId),
    runnerChanged: () => {},
    requestFromRunner: async (runnerId: string, _requestId: string, message: ControlPlaneToRunner) => {
      sent.push({ runnerId, message });
      return handler(runnerId, message);
    },
  } as unknown as Pick<Hub, "isRunnerOnline" | "requestFromRunner" | "runnerChanged">;
  let caller: HumanPrincipal | null = principal();
  const app = Fastify();
  registerProviderProfileRoutes(app, { db, hub, requestHuman: () => caller, now: () => 100 });
  await app.ready();
  return {
    db, app, sent, online, register, hub,
    setHandler(next: Handler) { handler = next; },
    as(next: HumanPrincipal | null) { caller = next; },
    async close() { await app.close(); db.close(); },
  };
}

const hubOf = (f: { hub: Pick<Hub, "isRunnerOnline" | "requestFromRunner" | "runnerChanged"> }) => f.hub;

const adopted = (profileId = PROFILE): Handler => (_runnerId, message) => ({
  type: "adopt_provider_profile_result", requestId: (message as { requestId: string }).requestId, ok: true, profileId,
});

test("profile routes require an Owner or Admin human, an acknowledgement, and a v225 runner", async () => {
  const f = await fixture({ handler: adopted() });
  try {
    f.as(principal("operator"));
    assert.equal((await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "POST", url: REVOKE, payload: {} })).statusCode, 403);
    f.as(null); // an agent credential is not a human principal
    assert.equal((await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } })).statusCode, 403);
    f.as(principal("admin", "org-elsewhere"));
    assert.deepEqual((await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } })).json(),
      { error: "runner not found" });
    f.as(principal("admin"));
    const unacknowledged = await f.app.inject({ method: "POST", url: ADOPT, payload: {} });
    assert.equal(unacknowledged.statusCode, 400);
    assert.match(unacknowledged.json().error, /acknowledgeProfileAdoption must be true/u);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/runners/runner-a/provider-accounts/..%2F/adopt-profile",
      payload: { acknowledgeProfileAdoption: true } })).statusCode, 400);
    assert.equal((await f.app.inject({ method: "POST", url: REVOKE, payload: { force: "yes" } })).statusCode, 400);
    assert.deepEqual(f.sent, [], "no refused request reaches the runner");
    assert.equal(f.db.activeProviderProfileGrants({ organizationId: PERSONAL_ORGANIZATION_ID,
      owner: { kind: "organization", organizationId: PERSONAL_ORGANIZATION_ID } }).length, 0, "and none records a grant");
  } finally {
    await f.close();
  }
});

test("a runner below v225 gets the shared newer-runner refusal", async () => {
  const f = await fixture({ protocolVersion: 223 });
  try {
    for (const [url, payload] of [[ADOPT, { acknowledgeProfileAdoption: true }], [REVOKE, {}]] as const) {
      const response = await f.app.inject({ method: "POST", url, payload });
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), {
        error: "This machine needs a newer runner for provider profiles. Update and restart the runner.",
        requiredRunnerProtocolVersion: 225, runnerProtocolVersion: 223,
      });
    }
    assert.deepEqual(f.sent, []);
  } finally {
    await f.close();
  }
});

test("adoption is pending until the runner confirms, idempotent across retries, then active", async () => {
  const f = await fixture();
  try {
    const lost = await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } });
    assert.equal(lost.statusCode, 504);
    const { grantId } = lost.json() as { grantId: string };
    assert.equal(lost.json().status, "pending");
    assert.equal(f.db.getProviderProfileGrant(grantId)?.status, "pending");
    assert.equal(f.db.getProviderProfileGrant(grantId)?.grantedBy, "user-1");

    f.setHandler(adopted());
    const completed = await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } });
    assert.equal(completed.statusCode, 200);
    assert.deepEqual(completed.json(), { status: "active", profileId: PROFILE, grantId });
    assert.deepEqual(f.sent.map(({ message }) => (message as { grantId?: string }).grantId), [grantId, grantId], "the retry reused the grant");
    assert.deepEqual(f.sent[0]?.message, { type: "adopt_provider_profile", requestId: (f.sent[0]?.message as { requestId: string }).requestId,
      accountId: "work", grantId });
    assert.equal(f.db.getProviderProfileGrant(grantId)?.status, "active");

    // Once the runner reports the account as granted, another request returns the active grant.
    f.db.updateRunnerAgents("runner-a", [], 2, undefined, [account("work", { id: PROFILE, access: "granted" }), account("other")]);
    const repeated = await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } });
    assert.deepEqual(repeated.json(), { status: "active", profileId: PROFILE, grantId });
    assert.equal(f.sent.length, 2, "no third adoption was sent");
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-a", []), [{ grantId, status: "active", profileId: PROFILE }],
      "the account's reported profile selects its grant");
  } finally {
    await f.close();
  }
});

test("a coded runner refusal spends the authorization; an uncoded one stays pending", async () => {
  const f = await fixture({
    handler: (_runnerId, message) => ({ type: "adopt_provider_profile_result", requestId: (message as { requestId: string }).requestId,
      ok: false, code: "HOME_IN_USE", error: "Provider HOME is already in use." }),
  });
  try {
    const refused = await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().code, "HOME_IN_USE");
    const grantId = (f.sent[0]!.message as { grantId: string }).grantId;
    assert.equal(f.db.getProviderProfileGrant(grantId)?.status, "revoked");
    f.setHandler((_runnerId, message) => ({ type: "adopt_provider_profile_result", requestId: (message as { requestId: string }).requestId,
      ok: false, error: "The runner configuration could not be updated." }));
    const uncertain = await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } });
    assert.equal(uncertain.json().code, "PROVIDER_PROFILE_ADOPTION_FAILED");
    assert.equal(f.db.getProviderProfileGrant(uncertain.json().grantId)?.status, "pending");
  } finally {
    await f.close();
  }
});

test("a lost adoption reply is completed from the runner's account report", async () => {
  const f = await fixture();
  try {
    const lost = await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } });
    const { grantId } = lost.json() as { grantId: string };
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-a", []), [{ grantId, status: "pending" }]);
    assert.deepEqual(reconcileProviderProfileGrants(f.db, "runner-a", [account("work", { id: PROFILE, access: "not_granted" })], 5), [],
      "a profile the runner may not use completes nothing");
    assert.deepEqual(reconcileProviderProfileGrants(f.db, "runner-a", [account("work", { id: PROFILE, access: "pending" })], 5), [grantId]);
    assert.equal(f.db.getProviderProfileGrant(grantId)?.profileId, PROFILE);
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-a", [PROFILE]), [{ grantId, status: "active", profileId: PROFILE }]);
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-a", []), [],
      "an active grant for a profile the runner does not report is not its concern");
    assert.equal(providerProfileGrantsForRunner(f.db, "unregistered", [PROFILE]), undefined, "an unknown scope omits the list, never empties it");
  } finally {
    await f.close();
  }
});

test("revocation refuses active sessions without force and records revocation before the runner hears", async () => {
  const f = await fixture({ handler: adopted() });
  try {
    const { grantId } = (await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } })).json() as { grantId: string };
    f.db.updateRunnerAgents("runner-a", [], 2, undefined, [account("work", { id: PROFILE, access: "granted" }), account("other")]);
    f.db.createSession({ id: "session-1", runnerId: "runner-a", workspaceId: null, agentId: "claude", providerAccountId: "work",
      title: "Uses Work", useWorktree: false, driver: "claude-code", config: {}, now: 3 });
    const conflict = await f.app.inject({ method: "POST", url: REVOKE, payload: {} });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, "PROVIDER_PROFILE_HAS_ACTIVE_SESSIONS");
    assert.equal(conflict.json().activeSessionCount, 1);
    assert.equal(f.db.getProviderProfileGrant(grantId)?.status, "active");

    let statusWhenTold: string | undefined;
    f.setHandler((_runnerId, message) => {
      statusWhenTold = f.db.getProviderProfileGrant((message as { grantId: string }).grantId)?.status;
      return { type: "revoke_provider_profile_grant_result", requestId: (message as { requestId: string }).requestId, ok: true, markerUpdated: true };
    });
    const forced = await f.app.inject({ method: "POST", url: REVOKE, payload: { force: true } });
    assert.equal(forced.statusCode, 200);
    assert.deepEqual(forced.json(), { revoked: true, grantIds: [grantId], markerUpdated: true, runnerNotified: true, forced: true });
    assert.equal(statusWhenTold, "revoked");
    assert.deepEqual(f.sent.at(-1)?.message, { type: "revoke_provider_profile_grant",
      requestId: (f.sent.at(-1)?.message as { requestId: string }).requestId, profileId: PROFILE, grantId });
    const grant = f.db.getProviderProfileGrant(grantId);
    assert.deepEqual([grant?.status, grant?.revokedAt, grant?.revokedBy, grant?.revokedRole], ["revoked", 100, "user-1", "owner"]);
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-a", [PROFILE]), []);
    assert.equal((await f.app.inject({ method: "POST", url: REVOKE, payload: { force: true } })).statusCode, 404, "nothing left to revoke");

    // An offline runner still loses access: the revocation stands and registration drops the grant.
    f.setHandler(adopted(OTHER_PROFILE));
    const second = (await f.app.inject({ method: "POST", url: "/api/runners/runner-a/provider-accounts/other/adopt-profile",
      payload: { acknowledgeProfileAdoption: true } })).json() as { grantId: string };
    f.online.delete("runner-a");
    const offline = await f.app.inject({ method: "POST", url: "/api/runners/runner-a/provider-accounts/other/revoke-profile-access", payload: {} });
    assert.equal(offline.statusCode, 200);
    assert.equal(offline.json().runnerNotified, false);
    assert.equal(f.db.getProviderProfileGrant(second.grantId)?.status, "revoked");
  } finally {
    await f.close();
  }
});

test("account removal revokes only this account's grant from this control plane", async () => {
  const f = await fixture({ handler: adopted() });
  try {
    const work = (await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } })).json() as { grantId: string };
    f.setHandler(adopted(OTHER_PROFILE));
    const other = (await f.app.inject({ method: "POST", url: "/api/runners/runner-a/provider-accounts/other/adopt-profile",
      payload: { acknowledgeProfileAdoption: true } })).json() as { grantId: string };
    const revoked = revokeProviderProfileGrantsForAccountRemoval(f.db, "runner-a", account("work", { id: PROFILE, access: "granted" }),
      principal("admin"), 7);
    assert.deepEqual(revoked.map((grant) => grant.grantId), [work.grantId]);
    assert.equal(f.db.getProviderProfileGrant(work.grantId)?.revokedRole, "admin");
    assert.equal(f.db.getProviderProfileGrant(other.grantId)?.status, "active", "another account's grant is untouched");
    assert.deepEqual(revokeProviderProfileGrantsForAccountRemoval(f.db, "runner-a", account("legacy"), principal(), 8), [],
      "a legacy account has no grant to revoke");
  } finally {
    await f.close();
  }
});

test("a pending grant revoked while the runner adopts is revoked on the runner with the profile it returned", async () => {
  const f = await fixture();
  try {
    let replyToAdoption!: (result: RunnerRequestResult) => void;
    f.setHandler((_runnerId, message) => {
      if (message.type === "adopt_provider_profile") return new Promise<RunnerRequestResult>((resolve) => { replyToAdoption = resolve; });
      return { type: "revoke_provider_profile_grant_result", requestId: (message as { requestId: string }).requestId, ok: true, markerUpdated: true };
    });
    const adoption = f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } });
    while (f.sent.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const { grantId, requestId } = f.sent[0]!.message as { grantId: string; requestId: string };
    // The revocation lands while the runner is still writing the marker: a pending grant names no
    // profile, so nothing can be sent to the runner yet.
    const revoked = await f.app.inject({ method: "POST", url: REVOKE, payload: {} });
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json().runnerNotified, false);
    assert.equal(f.db.getProviderProfileGrant(grantId)?.status, "revoked");
    assert.equal(f.sent.length, 1);

    replyToAdoption({ type: "adopt_provider_profile_result", requestId, ok: true, profileId: PROFILE });
    const response = await adoption;
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "PROVIDER_PROFILE_GRANT_REVOKED");
    assert.equal(f.db.getProviderProfileGrant(grantId)?.status, "revoked", "the revocation stands");
    assert.deepEqual(f.sent.slice(1).map(({ runnerId, message }) => [runnerId, message.type, (message as { profileId?: string }).profileId,
      (message as { grantId?: string }).grantId]), [["runner-a", "revoke_provider_profile_grant", PROFILE, grantId]],
      "the runner that recorded the grant is told at once, with the profile id it returned");
  } finally {
    await f.close();
  }
});

test("account removal tells the runner to stop using each revoked grant before removal is attempted", async () => {
  const f = await fixture({ handler: adopted() });
  try {
    const work = (await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } })).json() as { grantId: string };
    f.setHandler((_runnerId, message) => {
      assert.equal(f.db.getProviderProfileGrant((message as { grantId: string }).grantId)?.status, "revoked", "recorded before the runner hears");
      return { type: "revoke_provider_profile_grant_result", requestId: (message as { requestId: string }).requestId, ok: true, markerUpdated: true };
    });
    const before = f.sent.length;
    const revoked = await revokeProviderProfileAccessForAccountRemoval({ db: f.db, hub: hubOf(f) }, "runner-a",
      account("work", { id: PROFILE, access: "granted" }), principal("admin"), 9);
    assert.deepEqual(revoked.map((grant) => grant.grantId), [work.grantId]);
    assert.deepEqual(f.sent.slice(before).map(({ message }) => [message.type, (message as { profileId?: string }).profileId,
      (message as { grantId?: string }).grantId]), [["revoke_provider_profile_grant", PROFILE, work.grantId]]);

    // A pending grant is named by the profile the account reports.
    f.setHandler(() => { throw new Error("runner request timed out"); });
    const pending = (await f.app.inject({ method: "POST", url: "/api/runners/runner-a/provider-accounts/other/adopt-profile",
      payload: { acknowledgeProfileAdoption: true } })).json() as { grantId: string };
    f.setHandler((_runnerId, message) => ({ type: "revoke_provider_profile_grant_result", requestId: (message as { requestId: string }).requestId,
      ok: true, markerUpdated: false }));
    const sentBefore = f.sent.length;
    await revokeProviderProfileAccessForAccountRemoval({ db: f.db, hub: hubOf(f) }, "runner-a",
      account("other", { id: OTHER_PROFILE, access: "pending" }), principal(), 10);
    assert.deepEqual(f.sent.slice(sentBefore).map(({ message }) => [(message as { profileId?: string }).profileId, (message as { grantId?: string }).grantId]),
      [[OTHER_PROFILE, pending.grantId]]);
    assert.equal(f.db.getProviderProfileGrant(pending.grantId)?.status, "revoked");
    assert.deepEqual(await revokeProviderProfileAccessForAccountRemoval({ db: f.db, hub: hubOf(f) }, "runner-a", account("legacy"), principal(), 11), [],
      "a legacy account has nothing to revoke");

    // An offline runner is not asked; the revoked row and its next registration's list suffice.
    f.setHandler(() => { throw new Error("runner request timed out"); });
    const offline = (await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } })).json() as { grantId: string };
    f.online.delete("runner-a");
    const sentOffline = f.sent.length;
    assert.deepEqual((await revokeProviderProfileAccessForAccountRemoval({ db: f.db, hub: hubOf(f) }, "runner-a",
      account("work", { id: PROFILE, access: "pending" }), principal(), 12)).map((grant) => grant.grantId), [offline.grantId]);
    assert.equal(f.sent.length, sentOffline);
    assert.equal(f.db.getProviderProfileGrant(offline.grantId)?.status, "revoked");
  } finally {
    await f.close();
  }
});

test("registration omits the list when the runner's reported profiles are unknown or its relevant grants overflow", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-a", []), []);
    for (const reported of [undefined, "x", [PROFILE.toUpperCase()], Array.from({ length: 33 }, () => PROFILE)]) {
      assert.equal(providerProfileGrantsForRunner(f.db, "runner-a", reported), undefined, JSON.stringify(reported));
    }
    // 65 pending grants recorded for this runner exceed the 64-row bound: never a partial list.
    for (let index = 0; index < 65; index++) {
      assert.ok(f.db.authorizeProviderProfileGrant({ grantId: randomUUID(), runnerId: "runner-a", providerAccountId: `account-${index}`,
        provider: "claude", origin: "adopted", grantedBy: "user-1", grantedRole: "owner", now: index }));
    }
    assert.equal(providerProfileGrantsForRunner(f.db, "runner-a", []), undefined);
  } finally {
    await f.close();
  }
});

test("a runner whose marker holds one of the later of 257 grants in its scope is listed that grant", async () => {
  const f = await fixture();
  try {
    let late: { grantId: string; profileId: string } | undefined;
    for (let index = 0; index < 257; index++) {
      const runnerId = `runner-${index % 17}`;
      if (index < 17) f.register(runnerId, [account("work")]);
      const grantId = randomUUID(), profileId = randomUUID();
      assert.ok(f.db.authorizeProviderProfileGrant({ grantId, runnerId, providerAccountId: "work", provider: "claude", origin: "adopted",
        grantedBy: "user-1", grantedRole: "owner", now: index }));
      assert.equal(f.db.completeProviderProfileGrant(grantId, profileId, 1_000 + index), true);
      late = { grantId, profileId };
    }
    // The replacement runner's HOME records the latest grant; its registration reports that profile.
    f.register("runner-replacement", [account("work")]);
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-replacement", [late!.profileId]),
      [{ grantId: late!.grantId, status: "active", profileId: late!.profileId }],
      "the grant is listed, so the runner neither treats it as stale nor removes it from the marker");
  } finally {
    await f.close();
  }
});
