import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import type { ControlPlaneToRunner, ProviderAccountDefinition } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { Hub, RunnerRequestResult } from "./hub.js";
import { PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import {
  authorizeCreatedProviderProfileGrant,
  ProviderProfileInventoryRevocations,
  providerProfileGrantsForRunner,
  reconcileProviderProfileGrants,
  registerProviderProfileRoutes,
  revokeProviderProfileAccessForAccountRemoval,
  revokeProviderProfileGrantsForAccountRemoval,
  revokeUnrecordedCreatedProviderProfileGrants,
  settleCreatedProviderProfileGrantStart,
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

test("adoption enrolls before RPC, retains its ticket through concurrent revocation and never readmits it", async () => {
  const f = await fixture();
  let finish!: (result: RunnerRequestResult) => void, entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  let requestId = "", grantId = "", ticket = "";
  f.setHandler((_runnerId, message) => {
    if (message.type !== "adopt_provider_profile") return { type: "revoke_provider_profile_grant_result",
      requestId: (message as { requestId: string }).requestId, ok: true, markerUpdated: true };
    requestId = message.requestId; grantId = message.grantId;
    const intent = f.db.providerPublicationIntent(requestId);
    assert.equal(intent?.kind, "adopt");
    assert.equal(intent?.grantId, grantId);
    assert.equal(f.db.raw().isTransaction, false, "no RPC inside an uncommitted transaction");
    ticket = intent!.ticket!;
    entered();
    return new Promise<RunnerRequestResult>(resolve => { finish = resolve; });
  });
  try {
    const response = f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } }).then(value => value);
    await reached;
    f.db.revokeProviderProfileGrant({ grantId, revokedBy: "user-1", revokedRole: "owner", now: 101 });
    finish({ type: "adopt_provider_profile_result", requestId, ok: true, profileId: PROFILE });
    assert.equal((await response).statusCode, 409);
    assert.equal(f.db.providerPublicationIntent(requestId)?.ticket, ticket);
    assert.equal(f.db.getProviderProfileGrant(grantId)?.status, "revoked");
    assert.throws(() => f.db.enrollProviderProfileDispatch({ grantId, requestId, runnerId: "runner-a", kind: "adopt" }));
    assert.equal(f.sent.filter(entry => entry.message.type === "adopt_provider_profile").length, 1);
    assert.ok(f.db.providerPublicationEvents().records.some(event => event.kind === "observe" && event.observation === "reply"));
  } finally { await f.close(); }
});

test("adoption timeout retains durable unknown intent, then inventory completes only the grant", async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } });
    assert.equal(response.statusCode, 504);
    const message = f.sent[0]!.message as Extract<ControlPlaneToRunner, { type: "adopt_provider_profile" }>;
    const intent = f.db.providerPublicationIntent(message.requestId);
    assert.equal(intent?.kind, "adopt");
    assert.ok(f.db.providerPublicationEvents().records.some(event => event.observation === "uncertain"));
    reconcileProviderProfileGrants(f.db, "runner-a", [account("work", { id: PROFILE, access: "granted" })], 101);
    assert.equal(f.db.getProviderProfileGrant(message.grantId)?.status, "active");
    assert.deepEqual(f.db.providerPublicationIntent(message.requestId), intent);
    assert.equal(f.sent.length, 1, "inventory must not retry the unknown command");
  } finally { await f.close(); }
});

test("explicit adoption still settles a previously authorized pending Add Account grant", async () => {
  const f = await fixture({ handler: adopted() });
  try {
    const grant = f.db.authorizeProviderProfileGrant({ grantId: randomUUID(), runnerId: "runner-a", providerAccountId: "work",
      provider: "claude", origin: "created", grantedBy: "user-1", grantedRole: "owner", now: 1 })!.grant;
    const response = await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } });
    assert.equal(response.statusCode, 200);
    const message = f.sent[0]!.message as Extract<ControlPlaneToRunner, { type: "adopt_provider_profile" }>;
    assert.equal(message.grantId, grant.grantId);
    assert.equal(f.db.providerPublicationIntent(message.requestId)?.grantId, grant.grantId);
    assert.equal(f.db.getProviderProfileGrant(grant.grantId)?.status, "active");
  } finally { await f.close(); }
});

test("adoption admission fails before RPC on epoch, capacity, dispatch-write or enclosing-transaction failure", async () => {
  for (const mode of ["epoch", "capacity", "dispatch", "outer"] as const) {
    const f = await fixture();
    try {
      if (mode === "epoch") f.db.raw().exec("DELETE FROM control_plane_metadata WHERE key='provider_profile_publication_epoch_v1'");
      if (mode === "capacity") f.db.raw().exec("UPDATE provider_profile_publication_source SET intent_count=4096");
      if (mode === "dispatch") f.db.raw().exec(`CREATE TRIGGER dispatch_fault BEFORE INSERT ON provider_profile_publication_events
        WHEN json_extract(NEW.record,'$.kind')='adopt' BEGIN SELECT RAISE(ABORT,'fixture dispatch fault'); END`);
      if (mode === "outer") f.db.raw().exec("BEGIN");
      const response = await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } });
      assert.equal(response.statusCode, 503, mode);
      assert.equal(response.json().code, "PROVIDER_PUBLICATION_UNAVAILABLE", mode);
      assert.equal(f.sent.length, 0, mode);
      if (mode === "outer") f.db.raw().exec("ROLLBACK");
      if (mode === "capacity" || mode === "dispatch") assert.equal(f.db.providerPublicationStatus().status, "degraded");
      assert.deepEqual(f.db.liveProviderProfileGrantsForAccount("runner-a", "work"), [], mode);
      assert.deepEqual(reconcileProviderProfileGrants(f.db, "runner-a", [account("work", { id: PROFILE, access: "granted" })], 101), [],
        "a later report cannot complete a fresh authorization whose enrollment refused");
      if (mode === "dispatch") {
        const row = f.db.raw().prepare("SELECT grant_id,status FROM provider_profile_grants WHERE provider_account_id='work'")
          .get() as { grant_id: string; status: string };
        assert.equal(row.status, "revoked");
        assert.ok(f.db.raw().prepare("SELECT record FROM provider_profile_publication_intents WHERE intent_key=?").get(`grant:${row.grant_id}`));
      }
    } finally { if (f.db.raw().isTransaction) f.db.raw().exec("ROLLBACK"); await f.close(); }
  }
});

test("adoption refusal preserves a reused grant and its earlier uncertain dispatch", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } })).statusCode, 504);
    const first = f.sent[0]!.message as Extract<ControlPlaneToRunner, { type: "adopt_provider_profile" }>;
    const grant = f.db.getProviderProfileGrant(first.grantId), intent = f.db.providerPublicationIntent(first.requestId);
    f.db.raw().exec(`CREATE TRIGGER adoption_retry_fault BEFORE INSERT ON provider_profile_publication_events
      WHEN json_extract(NEW.record,'$.kind')='adopt' BEGIN SELECT RAISE(ABORT,'fixture retry fault'); END`);
    assert.equal((await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } })).statusCode, 503);
    assert.equal(f.sent.length, 1, "no second command or automatic retry on admission refusal");
    assert.deepEqual(f.db.getProviderProfileGrant(first.grantId), grant);
    assert.deepEqual(f.db.providerPublicationIntent(first.requestId), intent);
    assert.equal(f.db.providerPublicationStatus().status, "degraded");
  } finally { await f.close(); }
});

test("adoption preserves established raw runner identities instead of globally degrading", async () => {
  const f = await fixture({ handler: adopted() });
  try {
    for (const runnerId of ["box@lab", "ci+1", "Müller-PC", "_build"]) {
      f.register(runnerId, [account("work")]); f.online.add(runnerId);
      const response = await f.app.inject({ method: "POST", url: `/api/runners/${encodeURIComponent(runnerId)}/provider-accounts/work/adopt-profile`,
        payload: { acknowledgeProfileAdoption: true } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(f.db.liveProviderProfileGrantsForAccount(runnerId, "work")[0]?.status, "active");
      assert.equal(f.db.providerPublicationStatus().status, "healthy");
    }
  } finally { await f.close(); }
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

test("an adoption reply after the request timeout for a since-revoked grant is revoked from the account report", async () => {
  const f = await fixture();
  try {
    const lost = await f.app.inject({ method: "POST", url: ADOPT, payload: { acknowledgeProfileAdoption: true } });
    assert.equal(lost.statusCode, 504);
    const { grantId } = lost.json() as { grantId: string };
    // Revoked while still pending: the grant names no profile, so the runner cannot be told yet.
    const revoked = await f.app.inject({ method: "POST", url: REVOKE, payload: {} });
    assert.equal(revoked.json().runnerNotified, false);
    assert.equal(f.sent.length, 1);

    // The runner finishes the adoption after the timeout, uses the grant and reports the account.
    f.setHandler((_runnerId, message) => ({ type: "revoke_provider_profile_grant_result",
      requestId: (message as { requestId: string }).requestId, ok: true, markerUpdated: true }));
    const reported = [account("work", { id: PROFILE, access: "granted" }), account("other")];
    f.db.updateRunnerAgents("runner-a", [], 2, undefined, reported);
    assert.deepEqual(reconcileProviderProfileGrants(f.db, "runner-a", reported, 5), [], "a revoked grant is never completed");
    let clock = 1_000;
    const revocations = new ProviderProfileInventoryRevocations({ db: f.db, hub: hubOf(f), now: () => clock, resendAfterMs: 60_000 });
    assert.deepEqual(await revocations.reconcile("runner-a", reported), [grantId]);
    assert.deepEqual(f.sent.slice(1).map(({ runnerId, message }) => [runnerId, message.type, (message as { profileId?: string }).profileId,
      (message as { grantId?: string }).grantId]), [["runner-a", "revoke_provider_profile_grant", PROFILE, grantId]],
      "the runner is told with the profile it reports and the revoked grant, without a reconnect");
    assert.deepEqual(await revocations.reconcile("runner-a", reported), [], "the next report does not repeat it");
    clock += 60_000;
    assert.deepEqual(await revocations.reconcile("runner-a", reported), [grantId], "until the resend window passes");

    // A live grant, a profile reported as not granted, or an offline runner sends nothing.
    f.setHandler(adopted(OTHER_PROFILE));
    await f.app.inject({ method: "POST", url: "/api/runners/runner-a/provider-accounts/other/adopt-profile", payload: { acknowledgeProfileAdoption: true } });
    const sent = f.sent.length;
    clock += 60_000;
    assert.deepEqual(await revocations.reconcile("runner-a", [account("other", { id: OTHER_PROFILE, access: "granted" })]), []);
    assert.deepEqual(await revocations.reconcile("runner-a", [account("work", { id: PROFILE, access: "not_granted" })]), []);
    f.online.delete("runner-a");
    assert.deepEqual(await revocations.reconcile("runner-a", reported), []);
    assert.equal(f.sent.length, sent);
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

test("Add Account on a v225 runner records a created grant with the creator's role and completes it from the account report", async () => {
  const f = await fixture();
  try {
    const grantId = authorizeCreatedProviderProfileGrant(f.db, { runnerId: "runner-a", protocolVersion: 225 }, principal("operator"), "codex", 10, "created-operator");
    assert.ok(grantId, "any person who can manage the Machine is granted the account they create");
    const pending = f.db.getProviderProfileGrant(grantId)!;
    assert.deepEqual([pending.status, pending.origin, pending.grantedBy, pending.grantedRole, pending.provider, pending.profileId],
      ["pending", "created", "user-1", "operator", "codex", null]);
    assert.notEqual(pending.providerAccountId, "work-1234", "the account is named only by the runner's start reply");
    assert.deepEqual(providerProfileGrantsForRunner(f.db, "runner-a", []), [{ grantId, status: "pending" }],
      "a reconnect during the sign-in still lists the grant to the runner");

    settleCreatedProviderProfileGrantStart(f.db, grantId, { started: true, accountId: "work-1234" }, principal("operator"), 11);
    assert.equal(f.db.getProviderProfileGrant(grantId)?.providerAccountId, "work-1234");
    f.register("runner-a", [account("work-1234", { id: PROFILE, access: "granted" })]);
    assert.deepEqual(reconcileProviderProfileGrants(f.db, "runner-a", f.db.getRunner("runner-a")?.providerAccounts, 12), [grantId]);
    const active = f.db.getProviderProfileGrant(grantId)!;
    assert.deepEqual([active.status, active.profileId, active.origin], ["active", PROFILE, "created"]);
  } finally {
    await f.close();
  }
});

test("Add Account records no grant for an older runner or a non-human caller", async () => {
  const f = await fixture({ protocolVersion: 224 });
  try {
    assert.equal(authorizeCreatedProviderProfileGrant(f.db, { runnerId: "runner-a", protocolVersion: 224 }, principal("owner"), "claude", 1, "old-runner"), undefined);
    const agent = { kind: "agent", actorId: "agent-1" } as unknown as Parameters<typeof authorizeCreatedProviderProfileGrant>[2];
    assert.equal(authorizeCreatedProviderProfileGrant(f.db, { runnerId: "runner-a", protocolVersion: 225 }, agent, "claude", 1, "agent"), undefined);
    assert.equal(authorizeCreatedProviderProfileGrant(f.db, { runnerId: "runner-unknown", protocolVersion: 225 }, principal("owner"), "claude", 1, "unknown-runner"),
      undefined, "a runner without a recorded scope keeps today's HOME");
    assert.deepEqual(f.db.liveProviderProfileGrantsForAccount("runner-a", "work"), []);
  } finally {
    await f.close();
  }
});

test("an Add Account grant is spent when the sign-in does not start, settles without an account, or reports no profile", async () => {
  const f = await fixture();
  try {
    const owner = principal("admin");
    const refused = authorizeCreatedProviderProfileGrant(f.db, { runnerId: "runner-a", protocolVersion: 225 }, owner, "claude", 1, "refused")!;
    settleCreatedProviderProfileGrantStart(f.db, refused, { started: false }, owner, 2);
    assert.deepEqual([f.db.getProviderProfileGrant(refused)?.status, f.db.getProviderProfileGrant(refused)?.revokedBy],
      ["revoked", "user-1"]);

    const cancelled = authorizeCreatedProviderProfileGrant(f.db, { runnerId: "runner-a", protocolVersion: 225 }, owner, "claude", 3, "cancelled")!;
    settleCreatedProviderProfileGrantStart(f.db, cancelled, { started: true, accountId: "cancelled-1" }, owner, 4);
    const adoption = f.db.authorizeProviderProfileGrant({ grantId: randomUUID(), runnerId: "runner-a", providerAccountId: "work",
      provider: "claude", origin: "adopted", grantedBy: "user-1", grantedRole: "owner", now: 4 })!.grant.grantId;
    const login = (accountId: string, status: string, sessionId?: string) => ({ accountId, status, ...(sessionId ? { sessionId } : {}) });
    assert.deepEqual(revokeUnrecordedCreatedProviderProfileGrants(f.db, "runner-a",
      [login("cancelled-1", "waiting_for_provider"), login("work", "failed"), login("cancelled-1", "failed", "session-1")], 5), [],
      "a running sign-in, a re-sign-in of an adopted account, and a session's repair keep their grants");
    assert.deepEqual(revokeUnrecordedCreatedProviderProfileGrants(f.db, "runner-a", [login("cancelled-1", "cancelled")], 6), [cancelled]);
    assert.equal(f.db.getProviderProfileGrant(cancelled)?.status, "revoked");
    assert.equal(f.db.getProviderProfileGrant(adoption)?.status, "pending");

    const windows = authorizeCreatedProviderProfileGrant(f.db, { runnerId: "runner-a", protocolVersion: 225 }, owner, "claude", 7, "windows")!;
    settleCreatedProviderProfileGrantStart(f.db, windows, { started: true, accountId: "windows-1" }, owner, 8);
    f.register("runner-a", [account("windows-1"), account("work")]);
    assert.deepEqual(reconcileProviderProfileGrants(f.db, "runner-a", f.db.getRunner("runner-a")?.providerAccounts, 9), []);
    assert.equal(f.db.getProviderProfileGrant(windows)?.status, "revoked", "the runner created no profile, so the grant is spent");
    assert.equal(f.db.getProviderProfileGrant(adoption)?.status, "pending", "an adoption waiting for its runner is untouched");
  } finally {
    await f.close();
  }
});
