import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { mediaDispatchFenceBody, validMediaNeverDispatchedFence, type MediaDispatchFenceIdentity } from "@wollipog/protocol";
import { RunnerMediaDispatchFences } from "./media-dispatch-fences.js";
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const identity: MediaDispatchFenceIdentity = { rootSessionId: "root", sessionId: "synthetic-managed-media",
  runnerId: "runner", generation: "exact-generation", commandSha256: sha("exact command"), dispatchSha256: sha("exact grant and namespace") };

// Durable SQLite lifecycle tests only, no provider launch or real authenticated runner message.
test("cancelled exact command survives disk reopen and permanently refuses delayed launch or substitution", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "media-fence-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.sqlite"), db = new DatabaseSync(path);
  const fences = new RunnerMediaDispatchFences(db);
  const receipt = fences.cancelBeforeLaunch(identity)!;
  assert.equal(validMediaNeverDispatchedFence(receipt), true);
  assert.equal(receipt.fenceSha256, sha(mediaDispatchFenceBody(identity)));
  assert.equal(fences.claim(identity), false);
  assert.equal(fences.claim({ ...identity, commandSha256: sha("changed command") }), false);
  assert.deepEqual(fences.cancelBeforeLaunch(identity), receipt);
  db.close();
  const reopened = new DatabaseSync(path); t.after(() => reopened.close());
  const recovered = new RunnerMediaDispatchFences(reopened);
  assert.equal(recovered.claim(identity), false);
  assert.deepEqual(recovered.cancelBeforeLaunch(identity), receipt);
  assert.equal(recovered.cancelBeforeLaunch({ ...identity, runnerId: "different" }), null);
});
test("launch claim wins once across instances; a claimed or ambiguously launched command cannot produce a never-dispatched receipt", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const first = new RunnerMediaDispatchFences(db), second = new RunnerMediaDispatchFences(db);
  assert.equal(first.claim(identity), true);
  assert.equal(second.claim(identity), false);
  assert.equal(first.cancelBeforeLaunch(identity), null);
  assert.equal(second.cancelBeforeLaunch(identity), null);
  assert.doesNotMatch(String(db.prepare("SELECT identity FROM runner_media_dispatch_fences").get()!.identity), /never_dispatched/);
  assert.equal(first.claim({ ...identity, generation: "replacement" }), true);
  assert.equal(first.cancelBeforeLaunch({ ...identity, generation: "replacement" }), null);
});
test("malformed or caller-expanded command identities never claim a launch or acquire a terminal fence", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close()); const fences = new RunnerMediaDispatchFences(db);
  for (const changed of [{ ...identity, commandSha256: "not-a-sha" }, { ...identity, sessionId: identity.rootSessionId },
    { ...identity, generation: "" }, { ...identity, syntheticGrant: true }]) {
    assert.equal(fences.claim(changed), false);
    assert.equal(fences.cancelBeforeLaunch(changed), null);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runner_media_dispatch_fences").get()!.n, 0);
});
