import assert from "node:assert/strict";
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
    db, app, sent, online, register,
    setHandler(next: Handler) { handler = next; },
    as(next: HumanPrincipal | null) { caller = next; },
    async close() { await app.close(); db.close(); },
  };
}

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
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-a"), [{ grantId, status: "active", profileId: PROFILE }]);
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
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-a"), [{ grantId, status: "pending" }]);
    assert.deepEqual(reconcileProviderProfileGrants(f.db, "runner-a", [account("work", { id: PROFILE, access: "not_granted" })], 5), [],
      "a profile the runner may not use completes nothing");
    assert.deepEqual(reconcileProviderProfileGrants(f.db, "runner-a", [account("work", { id: PROFILE, access: "pending" })], 5), [grantId]);
    assert.equal(f.db.getProviderProfileGrant(grantId)?.profileId, PROFILE);
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-a"), [{ grantId, status: "active", profileId: PROFILE }]);
    assert.equal(providerProfileGrantsForRunner(f.db, "unregistered"), undefined, "an unknown scope omits the list, never empties it");
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
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-a"), []);
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
