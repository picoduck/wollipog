import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { ControlPlaneDb } from "./db.js";
import { ProviderPublicationUnavailable, PROVIDER_PUBLICATION_LIMITS } from "./provider-profile-publication-store.js";
import { reconcileProviderProfileGrants } from "./provider-profile-route.js";

const PROFILE = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const EPOCH_KEY = "provider_profile_publication_epoch_v1";
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "wollipog-publications-")), path = join(directory, "db.sqlite");
  let db = ControlPlaneDb.open(path);
  const peer = new DatabaseSync(path);
  t.after(() => {
    peer.close(); db.close();
    const bytes = readdirSync(directory).reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
    rmSync(directory, { recursive: true, force: true });
    assert.ok(bytes <= 32 * 1024 * 1024, `synthetic fixture exceeded 32 MiB: ${bytes}`);
  });
  db.registerRunner({ runnerId: "runner-a", hostname: "fixture", os: "linux", version: "fixture", agents: [], workspaces: [] }, 1, 225);
  return {
    get db() { return db; }, path, peer,
    reopen() { db.close(); db = ControlPlaneDb.open(path); return db; },
    authorize(account: string = randomUUID(), origin: "adopted" | "created" = "adopted") {
      return db.authorizeProviderProfileGrant({ grantId: randomUUID(), runnerId: "runner-a", providerAccountId: account,
        provider: "claude", origin, grantedBy: "must-not-appear-in-new-evidence", grantedRole: "owner", now: 1 })!.grant;
    },
    revoke(grantId: string) { return db.revokeProviderProfileGrant({ grantId, revokedBy: "private-actor", revokedRole: "owner", now: 2 }); },
  };
}

test("real FULL commits expose enrollment to a second connection before admission returns, and survive reopen", t => {
  const f = fixture(t), source = f.db.providerPublicationStatus();
  assert.equal(source.origin, "new-source-incomplete");
  assert.equal(source.physicalRetirementEligible, false);
  const grant = f.authorize("account-not-a-label");
  const requestId = "adopt-before-rpc";
  const ticket = f.db.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId, runnerId: "runner-a", kind: "adopt" });
  assert.equal(f.db.raw().isTransaction, false);
  const row = f.peer.prepare("SELECT record FROM provider_profile_publication_intents WHERE intent_key=?")
    .get(`request:${requestId}`) as { record: string };
  assert.equal(JSON.parse(row.record).ticket, ticket, "independent connection sees committed admission");
  const before = f.db.providerPublicationIntent(requestId);
  assert.equal(before?.profileId, null, "unknown physical target remains unknown");
  assert.doesNotMatch(row.record, /account-not-a-label|runner-a|must-not-appear|private-actor/);
  f.db.observeProviderProfileDispatch(requestId, "uncertain");
  assert.deepEqual(f.db.providerPublicationIntent(requestId), before, "observations cannot rewrite the ticket/binding");
  assert.throws(() => f.db.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId, runnerId: "runner-a", kind: "adopt" }), ProviderPublicationUnavailable);
  const next = f.reopen();
  assert.equal(next.providerPublicationStatus().storeEpoch, source.storeEpoch);
  assert.equal(next.providerPublicationIntent(requestId)?.ticket, ticket);
  assert.equal(next.providerPublicationStatus().historyIncomplete, true);
  assert.equal(next.providerPublicationStatus().physicalRetirementEligible, false);
});

test("preexisting database first install is legacy-incomplete; partial installations never regenerate epochs", t => {
  const f = fixture(t), grant = f.authorize();
  // Construct a pre-feature schema fixture, not a supported evidence-reset operation.
  f.db.raw().exec("DROP TABLE provider_profile_publication_events; DROP TABLE provider_profile_publication_intents; DROP TABLE provider_profile_publication_source");
  f.db.raw().prepare("DELETE FROM control_plane_metadata WHERE key=?").run(EPOCH_KEY);
  f.reopen();
  assert.equal(f.db.providerPublicationStatus().origin, "legacy-incomplete");
  assert.equal(f.db.getProviderProfileGrant(grant.grantId)?.status, "pending");
  assert.deepEqual(f.db.providerPublicationEvents().records, [], "old grants are never backfilled as complete history");
  const epoch = f.db.providerPublicationStatus().storeEpoch;
  f.db.raw().prepare("DELETE FROM control_plane_metadata WHERE key=?").run(EPOCH_KEY);
  f.reopen();
  assert.equal(f.db.providerPublicationStatus().status, "disabled");
  assert.equal(f.db.raw().prepare("SELECT value FROM control_plane_metadata WHERE key=?").get(EPOCH_KEY), undefined);
  assert.equal((f.db.raw().prepare("SELECT store_epoch FROM provider_profile_publication_source").get() as { store_epoch: string }).store_epoch, epoch);
  assert.equal(f.revoke(grant.grantId)?.status, "revoked", "missing epoch does not disable revocation");
  assert.throws(() => f.authorize(), ProviderPublicationUnavailable);
});

test("malformed, missing and mismatched installation records disable admission without repairing history", t => {
  const f = fixture(t), grant = f.authorize(), epoch = f.db.providerPublicationStatus().storeEpoch;
  for (const value of ["malformed", randomUUID()]) {
    f.db.raw().prepare("UPDATE control_plane_metadata SET value=? WHERE key=?").run(value, EPOCH_KEY);
    f.reopen();
    assert.equal(f.db.providerPublicationStatus().status, "disabled");
    assert.throws(() => f.db.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: randomUUID(), runnerId: "runner-a", kind: "adopt" }), ProviderPublicationUnavailable);
    assert.equal((f.db.raw().prepare("SELECT value FROM control_plane_metadata WHERE key=?").get(EPOCH_KEY) as { value: string }).value, value);
  }
  f.db.raw().prepare("UPDATE control_plane_metadata SET value=? WHERE key=?").run(epoch, EPOCH_KEY);
  f.db.raw().exec("DELETE FROM provider_profile_publication_source");
  f.reopen();
  assert.equal(f.db.providerPublicationStatus().status, "disabled");
  assert.equal(f.db.raw().prepare("SELECT * FROM provider_profile_publication_source").get(), undefined);
  assert.equal(f.revoke(grant.grantId)?.status, "revoked");
});

test("outer transactions and NORMAL contexts refuse all writers/admission; inventory defers without RPC or mutation", t => {
  const f = fixture(t), adopted = f.authorize(), created = f.authorize("login:created", "created");
  const before = f.db.providerPublicationEvents();
  const attempt = () => {
    assert.throws(() => f.authorize(), ProviderPublicationUnavailable);
    assert.throws(() => f.db.bindCreatedProviderProfileGrant(created.grantId, "login:created", "work"), ProviderPublicationUnavailable);
    assert.throws(() => f.db.completeProviderProfileGrant(adopted.grantId, PROFILE, 2), ProviderPublicationUnavailable);
    assert.throws(() => f.revoke(adopted.grantId), ProviderPublicationUnavailable);
    assert.throws(() => f.db.enrollProviderProfileDispatch({ grantId: adopted.grantId, requestId: "outer", runnerId: "runner-a", kind: "adopt" }), ProviderPublicationUnavailable);
    assert.deepEqual(reconcileProviderProfileGrants(f.db, "runner-a", [{ id: adopted.providerAccountId,
      label: "Fixture", provider: "claude", authStatus: "authenticated", profile: { id: PROFILE, access: "granted" } }], 2), []);
  };
  f.db.raw().exec("BEGIN");
  attempt();
  assert.equal(f.db.raw().isTransaction, true, "writer must not commit or roll back its caller's transaction");
  f.db.raw().exec("ROLLBACK; PRAGMA synchronous=NORMAL");
  attempt();
  f.db.raw().exec("PRAGMA synchronous=FULL");
  assert.deepEqual(f.db.providerPublicationEvents(), before);
  assert.equal(f.db.getProviderProfileGrant(adopted.grantId)?.status, "pending");
  assert.equal(f.db.getProviderProfileGrant(created.grantId)?.providerAccountId, "login:created");
  assert.equal(f.db.completeProviderProfileGrant(adopted.grantId, PROFILE, 3), true, "next ordinary inventory can complete");
});

test("grant SQL and COMMIT faults roll back both evidence and source rows before dispatch", t => {
  const f = fixture(t), grant = f.authorize(), before = f.db.providerPublicationStatus();
  f.db.raw().exec("CREATE TRIGGER publication_grant_fault BEFORE INSERT ON provider_profile_grants BEGIN SELECT RAISE(ABORT,'fixture grant fault'); END");
  assert.throws(() => f.authorize(), /fixture grant fault/);
  assert.deepEqual(f.db.providerPublicationStatus(), before);
  f.db.raw().exec("DROP TRIGGER publication_grant_fault");
  const raw = f.db.raw(), exec = raw.exec.bind(raw);
  let fail = true;
  raw.exec = (sql: string) => { if (sql === "COMMIT" && fail) { fail = false; throw new Error("fixture commit fault"); } exec(sql); };
  try {
    assert.throws(() => f.db.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: "commit-fault", runnerId: "runner-a", kind: "adopt" }), /fixture commit fault/);
  } finally { raw.exec = exec; }
  assert.equal(f.db.providerPublicationIntent("commit-fault"), null);
  assert.deepEqual(f.db.providerPublicationStatus(), before);
  assert.equal(f.peer.prepare("SELECT 1 FROM provider_profile_publication_intents WHERE intent_key='request:commit-fault'").get(), undefined);
});

test("audit insert faults commit degradation, deny new work, and preserve existing security controls", t => {
  const f = fixture(t), existing = f.authorize(), before = f.db.providerPublicationEvents();
  f.db.raw().exec("CREATE TRIGGER publication_audit_fault BEFORE INSERT ON provider_profile_publication_events BEGIN SELECT RAISE(ABORT,'fixture audit fault'); END");
  assert.throws(() => f.authorize("denied"), ProviderPublicationUnavailable);
  assert.equal(f.db.providerPublicationStatus().status, "degraded");
  assert.equal(f.db.raw().prepare("SELECT 1 FROM provider_profile_grants WHERE provider_account_id='denied'").get(), undefined);
  assert.deepEqual(f.db.providerPublicationEvents(), before, "failed evidence does not leave a partial intent");
  f.db.raw().exec("DROP TRIGGER publication_audit_fault");
  assert.equal(f.revoke(existing.grantId)?.status, "revoked");
  assert.throws(() => f.authorize(), ProviderPublicationUnavailable, "capacity/error fence never clears after repair");
  assert.throws(() => f.db.raw().exec("UPDATE provider_profile_publication_source SET degraded=0"), /irreversible/);
  f.reopen();
  assert.equal(f.db.providerPublicationStatus().status, "degraded");
});

test("numeric saturation never evicts history or prevents revocation, completion or supersession", t => {
  const f = fixture(t), old = f.authorize();
  f.db.completeProviderProfileGrant(old.grantId, PROFILE, 2);
  const replacement = f.authorize(), cancelled = f.authorize("login:cancelled", "created");
  const requestId = "before-saturation";
  f.db.enrollProviderProfileDispatch({ grantId: replacement.grantId, requestId, runnerId: "runner-a", kind: "adopt" });
  const intent = f.db.providerPublicationIntent(requestId), before = f.db.providerPublicationEvents();
  // Seed the exact counter boundary rather than allocate 128 MiB of unnecessary evidence.
  f.db.raw().prepare("UPDATE provider_profile_publication_source SET event_count=?").run(PROVIDER_PUBLICATION_LIMITS.events);
  assert.equal(f.db.completeProviderProfileGrant(replacement.grantId, PROFILE, 3), true);
  assert.equal(f.db.getProviderProfileGrant(old.grantId)?.status, "revoked");
  assert.equal(f.db.bindCreatedProviderProfileGrant(cancelled.grantId, "login:cancelled", "cancelled"), true);
  assert.equal(f.revoke(cancelled.grantId)?.status, "revoked");
  assert.equal(f.db.providerPublicationStatus().status, "degraded");
  assert.deepEqual(f.db.providerPublicationEvents(), before);
  assert.deepEqual(f.db.providerPublicationIntent(requestId), intent);
  assert.equal(f.db.providerPublicationStatus().physicalRetirementEligible, false);
  assert.throws(() => f.authorize(), ProviderPublicationUnavailable);
});

test("intent capacity, uint64 overflow, strict record bytes and bounded keyset pages refuse without truncation", t => {
  const f = fixture(t);
  for (let n = 0; n < 70; n++) f.authorize(`account-${n}`);
  const first = f.db.providerPublicationEvents();
  assert.equal(first.records.length, 64);
  assert.equal(first.nextAfter, 64);
  const second = f.db.providerPublicationEvents(first.nextAfter!);
  assert.equal(second.records.length, 6); assert.equal(second.nextAfter, null);
  assert.ok(Buffer.byteLength(JSON.stringify(first.records)) <= 65 * 4096);
  assert.throws(() => f.db.raw().prepare("INSERT INTO provider_profile_publication_intents VALUES('too-big',?)").run("x".repeat(4097)), /CHECK/);
  assert.throws(() => f.db.providerPublicationEvents(-1), ProviderPublicationUnavailable);
  assert.throws(() => f.db.providerPublicationEvents(32769), ProviderPublicationUnavailable);
  f.db.raw().prepare("UPDATE provider_profile_publication_source SET intent_count=?").run(PROVIDER_PUBLICATION_LIMITS.intents);
  assert.throws(() => f.authorize(), ProviderPublicationUnavailable);
  assert.equal(f.db.providerPublicationStatus().status, "degraded");
  assert.deepEqual(f.db.providerPublicationEvents(), first);
});

test("stale source preimages and revoked-before-enrollment refuse; revoked-after-enrollment retains exact ticket", t => {
  const f = fixture(t), grant = f.authorize(), previous = f.db.providerPublicationStatus().revision!;
  f.authorize();
  assert.throws(() => f.db.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: "stale", runnerId: "runner-a", kind: "adopt", expectedRevision: previous }), ProviderPublicationUnavailable);
  assert.equal(f.db.providerPublicationStatus().status, "healthy", "a normal stale CAS is not source corruption");
  const ticket = f.db.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: "admitted", runnerId: "runner-a", kind: "adopt" });
  f.revoke(grant.grantId);
  assert.equal(f.db.providerPublicationIntent("admitted")?.ticket, ticket);
  assert.throws(() => f.db.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: "late", runnerId: "runner-a", kind: "adopt" }), ProviderPublicationUnavailable);
  assert.equal(f.db.providerPublicationIntent("late"), null);
});

test("uint64 exhaustion and oversized identifiers fence new work while preserving revocation", t => {
  const f = fixture(t), grant = f.authorize();
  f.db.raw().exec("UPDATE provider_profile_publication_source SET revision='18446744073709551615'");
  assert.throws(() => f.db.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: "counter-overflow", runnerId: "runner-a", kind: "adopt" }), ProviderPublicationUnavailable);
  assert.equal(f.db.providerPublicationStatus().status, "degraded");
  assert.equal(f.revoke(grant.grantId)?.status, "revoked");
  const other = fixture(t), existing = other.authorize();
  assert.throws(() => other.db.enrollProviderProfileDispatch({ grantId: existing.grantId, requestId: "r".repeat(129), runnerId: "runner-a", kind: "adopt" }), ProviderPublicationUnavailable);
  assert.equal(other.db.providerPublicationStatus().status, "degraded");
  assert.equal(other.revoke(existing.grantId)?.status, "revoked");
});

test("competing real connections serialize admission, reject stale preimages and preserve the winner's ticket", t => {
  const f = fixture(t), grant = f.authorize(), previous = f.db.providerPublicationStatus().revision!;
  const second = ControlPlaneDb.open(f.path);
  try {
    f.authorize();
    assert.throws(() => second.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: "second-stale",
      runnerId: "runner-a", kind: "adopt", expectedRevision: previous }), ProviderPublicationUnavailable);
    f.db.raw().exec("BEGIN IMMEDIATE");
    try {
      assert.throws(() => second.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: "locked",
        runnerId: "runner-a", kind: "adopt" }), /locked/);
      assert.equal(f.db.providerPublicationIntent("locked"), null);
    } finally { f.db.raw().exec("ROLLBACK"); }
    const ticket = second.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: "winner", runnerId: "runner-a", kind: "adopt" });
    assert.equal(f.db.providerPublicationIntent("winner")?.ticket, ticket);
    f.revoke(grant.grantId);
    assert.throws(() => second.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: "successor", runnerId: "runner-a", kind: "adopt" }), ProviderPublicationUnavailable);
    assert.equal(second.providerPublicationIntent("winner")?.ticket, ticket);
  } finally { second.close(); }
});

test("private record reads reject unknown shape and coercible non-string identifiers", t => {
  const f = fixture(t), grant = f.authorize();
  f.db.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: "strict-shape", runnerId: "runner-a", kind: "adopt" });
  const record = f.db.providerPublicationIntent("strict-shape")!;
  for (const corrupt of [{ ...record, grantId: [record.grantId] }, { ...record, unexpected: true }, { ...record, version: 2 }]) {
    f.db.raw().prepare("UPDATE provider_profile_publication_intents SET record=? WHERE intent_key=?")
      .run(JSON.stringify(corrupt), "request:strict-shape");
    assert.equal(f.db.providerPublicationIntent("strict-shape"), null);
    assert.throws(() => f.db.enrollProviderProfileDispatch({ grantId: grant.grantId, requestId: "strict-shape", runnerId: "runner-a", kind: "adopt" }), ProviderPublicationUnavailable);
  }
});
