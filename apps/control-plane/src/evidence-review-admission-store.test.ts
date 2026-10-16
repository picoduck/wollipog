import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteEvidenceReviewerAdmissions } from "./evidence-review-admission-store.js";
import { reviewerBudgetAdmissionDigest } from "./evidence-review-admission.js";
import type { ReviewerAdmissionResult } from "./evidence-review-worker.js";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const admission = { rootSessionId: "root", authorityRevision: 4,
  allocation: { sessionId: "worker", costUsd: 1, toolCalls: 1000 },
  dispatch: { rootSessionId: "root", generation: "synthetic-dispatch" },
  worker: { sessionId: "worker", driver: "codex-app-server", model: "synthetic-model", effort: "high" } };
const result: ReviewerAdmissionResult = { ok: true, admissionId: "attempt", reviewerSessionId: "worker",
  reservationId: "reservation", workerAdmission: { ...admission, allocationDigest: reviewerBudgetAdmissionDigest(admission) } };
// Durable metadata tests only; no actual worker, grant, zero-cost accounting or live receipt.
test("lost launch response survives process restart as existing intent and can settle only with exact managed provenance", (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-admission-ledger-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "ledger.sqlite");
  let db = new DatabaseSync(path), store = new SqliteEvidenceReviewerAdmissions(db, "root");
  assert.equal(store.begin("attempt", digest("exact request")), "created");
  store.finish("attempt", { ok: false, reason: "launch_uncertain" });
  db.close();
  db = new DatabaseSync(path); t.after(() => db.close());
  store = new SqliteEvidenceReviewerAdmissions(db, "root");
  assert.equal(store.begin("attempt", digest("exact request")), "existing");
  assert.equal(store.begin("attempt", digest("different request")), "mismatch");
  assert.deepEqual(store.get("attempt")?.result, { ok: false, reason: "launch_uncertain" });
  store.finish("attempt", result);
  assert.deepEqual(store.get("attempt")?.result, result);
  assert.equal(store.begin("attempt", digest("exact request")), "existing");
  assert.throws(() => store.finish("attempt", { ...result, reviewerSessionId: "replacement" } as ReviewerAdmissionResult),
    /actual campaign admission|rebound/u);
});
test("cross-campaign, absent intent and substituted worker snapshots cannot create settled provenance", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const store = new SqliteEvidenceReviewerAdmissions(db, "other-root");
  assert.throws(() => store.finish("attempt", result), /Unknown reviewer dispatch/u);
  store.begin("attempt", digest("request"));
  assert.throws(() => store.finish("attempt", result), /actual campaign admission/u);
  assert.equal(store.get("attempt")?.result, null);
  store.finish("attempt", { ok: false, reason: "launch_failed" });
  assert.throws(() => store.finish("attempt", { ok: false, reason: "launch_uncertain" }), /settled reviewer intent/u);
});
test("stored result substitution is not usable proof or a transferable review grant", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const store = new SqliteEvidenceReviewerAdmissions(db, "root");
  store.begin("attempt", digest("request")); store.finish("attempt", result);
  db.prepare("UPDATE evidence_reviewer_admissions SET result=json_set(result,'$.reviewerSessionId','forged')").run();
  assert.equal(store.get("attempt")?.result, null);
  assert.equal(store.begin("attempt", digest("request")), "existing", "reconcile actual launch; never replay it based on damaged metadata");
});
