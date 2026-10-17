import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { DurableSessionCommand, PacedVideoTransportGrant } from "@wollipog/protocol";
import { reviewerBudgetAdmissionDigest, type EvidenceReviewerBudgetAdmission } from "./evidence-review-admission.js";
import { PreparedMediaSessions, pacedGrantPlanDigest, type PreparedMediaBinding, type PreparedMediaIdentity,
  type PreparedMediaSessionPorts, type PreparedMediaRecord } from "./prepared-media-sessions.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const identity: PreparedMediaIdentity = { rootSessionId: "root", childSessionId: "child",
  admissionId: "media-attempt", requestSha256: digest("original gate and source") };
const now = 1_000_000;
function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE synthetic_managed_sessions(id TEXT PRIMARY KEY); CREATE TABLE synthetic_members(id TEXT PRIMARY KEY);");
  const raw = { rootSessionId: "root", authorityRevision: 4, allocation: { sessionId: "worker", costUsd: 1, toolCalls: 100 },
    dispatch: { rootSessionId: "root", generation: "generation-one" },
    worker: { sessionId: "worker", driver: "codex-app-server", model: "synthetic", effort: "high" } };
  let admission: EvidenceReviewerBudgetAdmission | null = { ...raw, allocationDigest: reviewerBudgetAdmissionDigest(raw) };
  const command = { type: "start_session", spec: { sessionId: "worker", driver: "codex-app-server",
    config: { model: "synthetic", effort: "high", costBudgetUsd: 1, maxToolCalls: 100 } } } as
    Extract<DurableSessionCommand, { type: "start_session" }>;
  let sends = 0, releases = 0, authorizes = 0;
  const ports: PreparedMediaSessionPorts = {
    database: db,
    materialize() {
      db.prepare("INSERT INTO synthetic_managed_sessions VALUES ('worker')").run();
      db.prepare("INSERT INTO synthetic_members VALUES ('worker')").run();
      return { sessionId: "worker", runnerId: "runner", command: structuredClone(command), admission: structuredClone(admission!) };
    },
    currentAdmission: () => structuredClone(admission),
    currentIdentity: () => ({ rootSessionId: "root", runnerId: "runner", generation: "generation-one" }),
    authorize: async () => { authorizes++; return true; },
    send: async () => { sends++; return "accepted"; },
    reconcile: async () => null,
    cancelNeverDispatched() {
      releases++;
      db.prepare("DELETE FROM synthetic_members WHERE id='worker'").run();
    },
  };
  const grant: PacedVideoTransportGrant = { reviewId: "review", reviewerSessionId: "worker", childSessionId: "child",
    occurrenceId: "original-occurrence", policyRevision: 4, sourceEvidenceId: "original-video", sourceArtifactId: "source",
    sourceSha256: digest("source"), manifestSha256: digest("complete manifest"), bindingSha256: digest("binding"),
    criteriaSha256: digest("criteria"), expiresAt: now + 60_000, deliveryPlanSha256: "",
    frames: [{ index: 0, ptsUs: 0, durationUs: 33_333, sha256: digest("native frame"), sizeBytes: 1024 }] };
  grant.deliveryPlanSha256 = pacedGrantPlanDigest(grant.frames)!;
  const binding: PreparedMediaBinding = { grant, namespaceLaunchSha256: digest("actual worker namespace launch"),
    namespacePolicySha256: digest("validated namespace"), authoritySha256: digest("exact current policy and disclosure") };
  const store = new PreparedMediaSessions(db, ports, () => now);
  return { db, ports, store, binding, command, setAdmission: (value: EvidenceReviewerBudgetAdmission | null) => { admission = value; },
    counts: () => ({ sends, releases, authorizes }) };
}
// These are synthetic lifecycle and crash-safety tests, not real model transport, usage or live proof.
test("real Session/member adapter and exact command materialize atomically; invalid post-materialization generation rolls back", (t) => {
  const h = harness(); t.after(() => h.db.close());
  h.setAdmission({ ...h.ports.currentAdmission("worker")!, allocationDigest: digest("substituted") });
  assert.throws(() => h.store.prepare(identity), /actual managed media Session/iu);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM synthetic_managed_sessions").get()!.n, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM synthetic_members").get()!.n, 0);
  assert.equal(h.store.get(identity), null);
  assert.equal(h.counts().sends, 0);
});

test("binding performs no provider send and rejects reordered frames, widened allowance, or changed generation", async (t) => {
  const h = harness(); t.after(() => h.db.close());
  const prepared = h.store.prepare(identity);
  assert.deepEqual(h.store.prepare(identity), prepared);
  assert.equal(h.counts().sends, 0);
  const reordered = structuredClone(h.binding); reordered.grant.frames[0]!.index = 1;
  await assert.rejects(h.store.bind(identity, reordered), /current never-dispatched/);
  const changed = structuredClone(prepared.admission); changed.dispatch.generation = "generation-two";
  changed.allocationDigest = reviewerBudgetAdmissionDigest(changed); h.setAdmission(changed);
  await assert.rejects(h.store.bind(identity, h.binding), /current never-dispatched/);
  assert.equal(h.counts().releases, 0, "a changed active ledger is never released by guessing");
  h.setAdmission(prepared.admission);
  await h.store.bind(identity, h.binding);
  assert.equal(h.counts().sends, 0);
  assert.throws(() => h.store.prepare({ ...identity, requestSha256: digest("another source") }), /cannot be rebound/);
});

test("concurrent independent coordinators send only once; all-frame grant and actual namespace are in the dispatch digest", async (t) => {
  const h = harness(); t.after(() => h.db.close());
  h.store.prepare(identity); const bound = await h.store.bind(identity, h.binding);
  assert.notEqual(bound.dispatchSha256, bound.commandSha256);
  let sent: PreparedMediaRecord | undefined, launches = 0;
  h.ports.send = async (record) => { launches++; sent = record; return "accepted"; };
  let resume!: () => void; const wait = new Promise<void>((r) => { resume = r; });
  let attempts = 0;
  h.ports.authorize = async () => { attempts++; await wait; return true; };
  const other = new PreparedMediaSessions(h.db, h.ports, () => now);
  const a = h.store.dispatch(identity), b = other.dispatch(identity);
  resume(); await Promise.all([a, b]);
  assert.equal(attempts, 2); assert.equal(launches, 1); assert.equal(sent?.binding?.grant.sourceEvidenceId, "original-video");
  assert.equal(sent?.binding?.namespaceLaunchSha256, h.binding.namespaceLaunchSha256);
  assert.equal(h.store.get(identity)?.state, "active");
  // Any subsequent invocation reconciles rather than resending the exact command.
  h.ports.send = async () => { assert.fail("settled dispatch must never be replayed"); };
  await other.dispatch(identity);
});

test("crash after intent or lost send reply retains capacity across restart; only exact authenticated generation can settle", async (t) => {
  const h = harness(); t.after(() => h.db.close());
  h.store.prepare(identity); await h.store.bind(identity, h.binding);
  h.ports.send = async () => { throw new Error("reply lost"); };
  const uncertain = await h.store.dispatch(identity);
  assert.equal(uncertain.state, "uncertain"); assert.equal(h.counts().releases, 0);
  const restarted = new PreparedMediaSessions(h.db, h.ports, () => now);
  h.ports.send = async () => { assert.fail("unknown outcomes cannot relaunch"); };
  h.ports.reconcile = async (r) => ({ dispatchSha256: r.dispatchSha256!, sessionId: r.sessionId,
    runnerId: r.runnerId, generation: "wrong-generation", outcome: "never_dispatched" });
  assert.equal((await restarted.dispatch(identity)).state, "uncertain");
  assert.equal(h.counts().releases, 0);
  h.ports.reconcile = async (r) => ({ dispatchSha256: r.dispatchSha256!, sessionId: r.sessionId,
    runnerId: r.runnerId, generation: r.admission.dispatch.generation, outcome: "accepted" });
  assert.equal((await restarted.dispatch(identity)).state, "active");
  assert.equal(h.counts().releases, 0);
});

test("proven never-dispatched preparation releases atomically; uncertain launch and substituted stored grant cannot release", async (t) => {
  const h = harness(); t.after(() => h.db.close());
  h.store.prepare(identity); await h.store.bind(identity, h.binding);
  h.ports.send = async () => "unknown";
  await h.store.dispatch(identity);
  assert.throws(() => h.store.cancelPrepared(identity), /possibly dispatched/);
  h.ports.authorize = async () => false;
  h.ports.reconcile = async (r) => ({ dispatchSha256: r.dispatchSha256!, sessionId: r.sessionId,
    runnerId: r.runnerId, generation: r.admission.dispatch.generation, outcome: "never_dispatched" });
  assert.equal((await h.store.reconcile(identity)).state, "cancelled");
  assert.equal(h.counts().releases, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM synthetic_members").get()!.n, 0);
  h.db.prepare("UPDATE prepared_media_sessions SET payload=json_set(payload,'$.binding.grant.sourceEvidenceId','another')").run();
  assert.throws(() => h.store.get(identity), /provenance is invalid/);
});

test("revocation during asynchronous integrity check prevents dispatch and leaves proven preparation available for explicit cancellation", async (t) => {
  const h = harness(); t.after(() => h.db.close());
  const prepared = h.store.prepare(identity); await h.store.bind(identity, h.binding);
  h.ports.authorize = async () => { h.setAdmission(null); return true; };
  await assert.rejects(h.store.dispatch(identity), /dispatch authority denied/);
  assert.equal(h.counts().sends, 0); assert.equal(h.counts().releases, 0);
  h.setAdmission(prepared.admission);
  h.ports.cancelNeverDispatched = () => { throw new Error("ledger release failed"); };
  assert.throws(() => h.store.cancelPrepared(identity), /ledger release failed/);
  assert.equal(h.store.get(identity)?.state, "bound");
});

test("wider launch ceilings cannot materialize under a tighter actual member allocation", (t) => {
  const h = harness(); t.after(() => h.db.close());
  h.command.spec.config!.costBudgetUsd = 2;
  assert.throws(() => h.store.prepare(identity), /actual managed media Session/iu);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM synthetic_members").get()!.n, 0);
  assert.equal(h.counts().sends, 0);
});

test("old never-dispatched receipt cannot release a replacement generation's capacity", async (t) => {
  const h = harness(); t.after(() => h.db.close());
  h.store.prepare(identity); await h.store.bind(identity, h.binding);
  h.ports.send = async () => "unknown"; await h.store.dispatch(identity);
  h.ports.currentIdentity = () => ({ rootSessionId: "root", runnerId: "runner", generation: "replacement" });
  h.ports.reconcile = async (r) => ({ dispatchSha256: r.dispatchSha256!, sessionId: r.sessionId,
    runnerId: r.runnerId, generation: r.admission.dispatch.generation, outcome: "never_dispatched" });
  assert.equal((await h.store.reconcile(identity)).state, "uncertain");
  assert.equal(h.counts().releases, 0);
});
