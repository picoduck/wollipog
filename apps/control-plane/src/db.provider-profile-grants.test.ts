import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ControlPlaneDb } from "./db.js";
import type { ResourceScope } from "@wollipog/protocol";
import { PERSONAL_ORGANIZATION_ID } from "./identity.js";

const PROFILE = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const OTHER_PROFILE = "7f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const PERSONAL = { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "organization" as const, organizationId: PERSONAL_ORGANIZATION_ID } };

function open() {
  const db = ControlPlaneDb.open(":memory:");
  const register = (runnerId: string, scope: ResourceScope = PERSONAL) => db.registerRunner({
    runnerId, hostname: runnerId, os: "linux", version: "1", agents: [], workspaces: [],
    providerAccounts: [{ id: "work", label: "Work", provider: "claude", authStatus: "authenticated" }],
  }, 1, 225, scope);
  register("runner-a");
  return { db, register };
}

function authorize(db: ControlPlaneDb, grantId: string, runnerId = "runner-a", providerAccountId = "work") {
  return db.authorizeProviderProfileGrant({
    grantId, runnerId, providerAccountId, provider: "claude", origin: "adopted", grantedBy: "user-1", grantedRole: "owner", now: 10,
  });
}

test("a grant is authorized pending in the runner's exact scope and reused while pending", () => {
  const { db } = open();
  try {
    const first = authorize(db, "11111111-1111-4111-8111-111111111111");
    assert.equal(first?.created, true);
    assert.deepEqual({ ...first!.grant, controlPlaneInstanceId: undefined }, {
      grantId: "11111111-1111-4111-8111-111111111111", profileId: null, controlPlaneInstanceId: undefined, scope: PERSONAL,
      grantScope: "provider_home", runnerId: "runner-a", providerAccountId: "work", provider: "claude", origin: "adopted",
      status: "pending", grantedBy: "user-1", grantedRole: "owner", createdAt: 10, activatedAt: null, revokedAt: null,
      revokedBy: null, revokedRole: null,
    });
    assert.equal(first!.grant.controlPlaneInstanceId, db.instanceId());
    const again = authorize(db, "22222222-2222-4222-8222-222222222222");
    assert.equal(again?.created, false);
    assert.equal(again?.grant.grantId, "11111111-1111-4111-8111-111111111111", "a retried adoption reuses the pending grant");
    assert.equal(authorize(db, "33333333-3333-4333-8333-333333333333", "unknown-runner"), null, "no runner scope, no grant");
  } finally {
    db.close();
  }
});

test("completion is idempotent, binds one profile, and supersedes this control plane's older grant", () => {
  const { db, register } = open();
  try {
    register("runner-b");
    const grant = authorize(db, "11111111-1111-4111-8111-111111111111")!.grant.grantId;
    assert.equal(db.completeProviderProfileGrant(grant, PROFILE, 20), true);
    assert.equal(db.completeProviderProfileGrant(grant, PROFILE, 21), true, "same profile again");
    assert.equal(db.completeProviderProfileGrant(grant, OTHER_PROFILE, 22), false, "an active grant never rebinds");
    assert.deepEqual([db.getProviderProfileGrant(grant)?.status, db.getProviderProfileGrant(grant)?.activatedAt], ["active", 20]);

    // Another runner in the same scope adopts the same HOME: the marker holds one grant per control
    // plane, so the newer grant supersedes the older one.
    const replacement = authorize(db, "22222222-2222-4222-8222-222222222222", "runner-b")!.grant.grantId;
    assert.equal(db.completeProviderProfileGrant(replacement, PROFILE, 30), true);
    assert.equal(db.getProviderProfileGrant(grant)?.status, "revoked");
    assert.equal(db.getProviderProfileGrant(grant)?.revokedAt, 30);
    assert.deepEqual(db.activeProviderProfileGrants(PERSONAL).map((row) => [row.grantId, row.status, row.profileId]),
      [[replacement, "active", PROFILE]]);
  } finally {
    db.close();
  }
});

test("revocation records who revoked and leaves the scope's list; scopes never mix", () => {
  const { db, register } = open();
  try {
    const team = { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "team" as const, teamId: "team-1" } };
    register("runner-team", team);
    const personal = authorize(db, "11111111-1111-4111-8111-111111111111")!.grant.grantId;
    const teamGrant = authorize(db, "22222222-2222-4222-8222-222222222222", "runner-team")!.grant.grantId;
    assert.deepEqual(db.activeProviderProfileGrants(PERSONAL).map((row) => row.grantId), [personal]);
    assert.deepEqual(db.activeProviderProfileGrants(team).map((row) => row.grantId), [teamGrant]);
    const revoked = db.revokeProviderProfileGrant({ grantId: personal, revokedBy: "user-2", revokedRole: "admin", now: 40 });
    assert.deepEqual([revoked?.status, revoked?.revokedAt, revoked?.revokedBy, revoked?.revokedRole], ["revoked", 40, "user-2", "admin"]);
    assert.equal(db.revokeProviderProfileGrant({ grantId: personal, revokedBy: "user-2", revokedRole: "admin", now: 41 }), null);
    assert.equal(db.completeProviderProfileGrant(personal, PROFILE, 42), false, "a revoked grant never activates");
    assert.deepEqual(db.activeProviderProfileGrants(PERSONAL), []);
    // A new authorization for the same account is possible once the pending one is spent.
    assert.equal(authorize(db, "33333333-3333-4333-8333-333333333333")?.created, true);
  } finally {
    db.close();
  }
});

test("the schema refuses scopes, roles, and states outside the grant model", () => {
  const { db } = open();
  try {
    assert.throws(() => db.authorizeProviderProfileGrant({ grantId: "11111111-1111-4111-8111-111111111111", runnerId: "runner-a",
      providerAccountId: "work", provider: "claude", origin: "adopted", grantedBy: "user-1", grantedRole: "member" as never, now: 1 }),
      /CHECK constraint failed/u, "only organization roles are recorded");
    // A grant created by Add Account records whoever could manage the Machine, not only an Owner/Admin.
    const created = db.authorizeProviderProfileGrant({ grantId: "33333333-3333-4333-8333-333333333333", runnerId: "runner-a",
      providerAccountId: "created-by-operator", provider: "claude", origin: "created", grantedBy: "user-2", grantedRole: "operator", now: 1 });
    assert.equal(created?.grant.grantedRole, "operator");
    const grant = authorize(db, "22222222-2222-4222-8222-222222222222")!.grant.grantId;
    const raw = (db as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).db;
    assert.throws(() => raw.prepare("UPDATE provider_profile_grants SET scope='runner' WHERE grant_id=?").run(grant), /CHECK constraint failed/u);
    assert.throws(() => raw.prepare("UPDATE provider_profile_grants SET status='active' WHERE grant_id=?").run(grant), /CHECK constraint failed/u,
      "an active grant needs its profile id");
    assert.throws(() => raw.prepare(
      `INSERT INTO provider_profile_grants (grant_id, control_plane_instance_id, organization_id, owner_kind, owner_id, scope, runner_id,
         provider_account_id, provider, origin, status, granted_by, granted_role, created_at)
       VALUES ('x', 'i', ?, 'organization', ?, 'provider_home', 'runner-a', 'work', 'claude', 'adopted', 'pending', 'u', 'owner', 1)`,
    ).run(PERSONAL_ORGANIZATION_ID, PERSONAL_ORGANIZATION_ID), /UNIQUE constraint failed/u, "one pending grant per runner account");
  } finally {
    db.close();
  }
});

test("a runner's registration list holds every grant for its profiles, however many the scope has, and overflow omits it", () => {
  const { db, register } = open();
  try {
    const runners = Array.from({ length: 17 }, (_, index) => `runner-${index}`);
    for (const runnerId of runners) register(runnerId);
    // 257 active grants across 17 runners in one scope, more than any single list could carry.
    const active: Array<{ runnerId: string; grantId: string; profileId: string }> = [];
    for (let index = 0; index < 257; index++) {
      const runnerId = runners[index % runners.length]!;
      const grantId = randomUUID(), profileId = randomUUID();
      authorize(db, grantId, runnerId);
      assert.equal(db.completeProviderProfileGrant(grantId, profileId, 100 + index), true);
      active.push({ runnerId, grantId, profileId });
    }
    assert.equal(db.activeProviderProfileGrants(PERSONAL).length, 257);
    const late = active.at(-1)!;
    const pending = authorize(db, randomUUID(), late.runnerId, "fresh")!.grant.grantId;
    // A replacement runner whose marker holds one of the latest grants sees exactly the grant for it.
    register("runner-replacement");
    assert.deepEqual(db.providerProfileGrantsForRunnerProfiles("runner-replacement", PERSONAL, [late.profileId])?.map((row) => row.grantId),
      [late.grantId]);
    assert.deepEqual(db.providerProfileGrantsForRunnerProfiles(late.runnerId, PERSONAL, [late.profileId, late.profileId])?.map((row) => row.grantId),
      [late.grantId, pending], "and the runner that made a pending grant sees that too");
    // Never a partial list: one row more than the bound omits the list.
    const three = active.slice(0, 3).map((grant) => grant.profileId);
    assert.equal(db.providerProfileGrantsForRunnerProfiles("runner-replacement", PERSONAL, three, 3)?.length, 3);
    assert.equal(db.providerProfileGrantsForRunnerProfiles("runner-replacement", PERSONAL, three, 2), null);
    const team = { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "team" as const, teamId: "team-1" } };
    assert.deepEqual(db.providerProfileGrantsForRunnerProfiles("runner-replacement", team, [late.profileId]), [],
      "another scope's grant for the same profile is never listed");
  } finally {
    db.close();
  }
});
