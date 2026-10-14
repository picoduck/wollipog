import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { mediaActiveStopIdentityBody, mediaActiveStopRequestBody,
  type MediaActiveStopIdentity, type MediaActiveStopRequest } from "@wollipog/protocol";
import { RunnerMediaDispatchFences } from "./media-dispatch-fences.js";
import { RunnerMediaActiveStops, type OwnedMediaStopHandle } from "./media-active-stops.js";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const identity: MediaActiveStopIdentity = { rootSessionId: "root", childSessionId: "child", sessionId: "media",
  runnerId: "runner", generation: "generation", commandSha256: sha("command"), dispatchSha256: sha("dispatch") };
const request: MediaActiveStopRequest = { ...identity, operationId: "operation" };
function fixture(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const fences = new RunnerMediaDispatchFences(db);
  const { childSessionId: _child, ...dispatch } = identity;
  let stops = 0, registered = true, allowed = true, ambiguous = false;
  let handle: OwnedMediaStopHandle = { identity, requestStop() { stops++; if (ambiguous) throw new Error("Synthetic unknown signal result"); } };
  const ports = { current: (i: MediaActiveStopIdentity) => registered && JSON.stringify(mediaActiveStopIdentityBody(i)) === JSON.stringify(identity) ? handle : null,
    currentAuthority: () => allowed };
  return { db, fences, dispatch, ports, worker: new RunnerMediaActiveStops(db, ports), stops: () => stops,
    register: (value: boolean) => { registered = value; }, allow: (value: boolean) => { allowed = value; },
    unknown: () => { ambiguous = true; }, replace: () => { handle = { ...handle, identity: { ...identity, generation: "replacement" } }; } };
}
test("dedicated Stop signals an exact claimed registered handle once, including after restart", (t) => {
  const f = fixture(t); assert.ok(f.fences.claim(f.dispatch));
  const ack = f.worker.request(request)!;
  assert.equal(ack.outcome, "stop_requested"); assert.equal(f.stops(), 1);
  assert.deepEqual(f.worker.request(request), ack);
  assert.deepEqual(new RunnerMediaActiveStops(f.db, f.ports).request(request), ack);
  assert.deepEqual(f.worker.readback(request), ack);
  assert.equal(f.stops(), 1);
  assert.equal(f.fences.claim(f.dispatch), false, "permanent original claim prevents late start replay");
  assert.equal(f.fences.cancelBeforeLaunch(f.dispatch), null, "a Stop ACK is not never-dispatched proof");
  const { stopFenceSha256, ...body } = ack;
  assert.equal(stopFenceSha256, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
});
test("ambiguous dedicated Stop retains permanent intent and exact readback without another signal", (t) => {
  const f = fixture(t); assert.ok(f.fences.claim(f.dispatch)); f.unknown();
  const ack = f.worker.request(request)!;
  assert.equal(ack.outcome, "unknown"); assert.equal(f.stops(), 1);
  assert.deepEqual(new RunnerMediaActiveStops(f.db, f.ports).request(request), ack);
  assert.equal(f.worker.request({ ...request, operationId: "replacement-operation" }), null);
  assert.equal(f.stops(), 1);
});
for (const mode of ["unclaimed", "unregistered", "revoked", "replaced", "transaction", "changed-command", "corrupt-claim"] as const) {
  test("dedicated Stop refuses " + mode + " without an intent or generic kill", (t) => {
    const f = fixture(t); if (mode !== "unclaimed") assert.ok(f.fences.claim(f.dispatch));
    if (mode === "unregistered") f.register(false);
    if (mode === "revoked") f.allow(false);
    if (mode === "replaced") f.replace();
    if (mode === "corrupt-claim") f.db.prepare("UPDATE runner_media_dispatch_fences SET identity='corrupt'").run();
    if (mode === "transaction") f.db.exec("BEGIN");
    try {
      const actual = mode === "changed-command" ? { ...request, commandSha256: sha("different command") } : request;
      assert.equal(f.worker.request(actual), null);
      assert.equal(f.stops(), 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM runner_media_active_stops").get()!.n, 0);
    } finally { if (mode === "transaction") f.db.exec("ROLLBACK"); }
  });
}
test("revocation and late changed frames cannot replace a durable dedicated Stop", (t) => {
  const f = fixture(t); assert.ok(f.fences.claim(f.dispatch));
  const ack = f.worker.request(request)!;
  f.allow(false); assert.equal(f.worker.request(request), null);
  f.allow(true);
  assert.equal(f.worker.request({ ...request, generation: "replacement" }), null);
  assert.equal(f.worker.request({ ...request, operationId: "another operation" }), null);
  assert.deepEqual(f.worker.readback(request), ack); assert.equal(f.stops(), 1);
  f.db.prepare("UPDATE runner_media_active_stops SET sha256='corrupt'").run();
  assert.equal(f.worker.request(request), null); assert.equal(f.worker.readback(request), null); assert.equal(f.stops(), 1);
});
test("missing Stop history cannot clear the original command's permanent operation fence", (t) => {
  const f = fixture(t); assert.ok(f.fences.claim(f.dispatch));
  assert.ok(f.worker.request(request)); assert.equal(f.stops(), 1);
  f.db.exec("DELETE FROM runner_media_active_stops");
  const restarted = new RunnerMediaActiveStops(f.db, f.ports);
  assert.equal(restarted.readback(request), null);
  assert.equal(restarted.request(request), null);
  assert.equal(restarted.request({ ...request, operationId: "fresh-operation" }), null);
  assert.equal(f.fences.stopOperation(f.dispatch), request.operationId);
  assert.equal(f.stops(), 1);
});

for (const changed of ["control", "rootSessionId", "childSessionId", "sessionId", "runnerId", "generation",
  "commandSha256", "dispatchSha256", "malformed-generation", "malformed-command"] as const) {
  test("final Stop handle refresh preserves exact intent without signaling " + changed, (t) => {
    const db = new DatabaseSync(":memory:"); t.after(() => db.close());
    const fences = new RunnerMediaDispatchFences(db);
    const { childSessionId: _child, ...dispatch } = identity;
    assert.equal(fences.claim(dispatch), true);
    let stops = 0, authorityChecks = 0;
    const handle: OwnedMediaStopHandle = { identity: { ...identity }, requestStop() { stops++; } };
    const ports = {
      current: (i: MediaActiveStopIdentity) => JSON.stringify(handle.identity) === JSON.stringify(i) ? handle : null,
      currentAuthority: (i: MediaActiveStopIdentity) => {
        assert.deepEqual(i, identity);
        if (++authorityChecks === 2) {
          assert.equal(fences.stopOperation(dispatch), request.operationId, "replacement occurs after committed intent");
          assert.equal(db.prepare("SELECT outcome FROM runner_media_active_stops").get()!.outcome, "unknown");
          if (changed === "malformed-generation") handle.identity.generation = "";
          else if (changed === "malformed-command") handle.identity.commandSha256 = "not-a-digest";
          else if (changed !== "control") handle.identity[changed] = changed.endsWith("Sha256")
            ? sha("replacement " + changed) : identity[changed] + "-replacement";
        }
        return true;
      },
    };
    const worker = new RunnerMediaActiveStops(db, ports);
    const ack = worker.request(request);
    assert.ok(ack, "even malformed coordinates must return the known same-operation receipt");
    const expectedOutcome = changed === "control" ? "stop_requested" : "unknown";
    assert.equal(ack.outcome, expectedOutcome);
    assert.equal(stops, changed === "control" ? 1 : 0, "a replaced handle must receive no signal");
    const { outcome, stopFenceSha256, ...ackRequest } = ack;
    assert.deepEqual(ackRequest, request);
    assert.equal(stopFenceSha256, sha(JSON.stringify({ ...ackRequest, outcome })));
    assert.deepEqual(worker.readback(request), ack);
    assert.deepEqual(new RunnerMediaActiveStops(db, ports).readback(request), ack);
    assert.equal(fences.stopOperation(dispatch), request.operationId);
    assert.equal(fences.claimed(dispatch), true);
    assert.equal(fences.cancelBeforeLaunch(dispatch), null, "unknown Stop cannot certify no launch");
    handle.identity = { ...identity };
    assert.deepEqual(worker.request(request), ack, "restoring the handle permits readback only");
    assert.equal(worker.request({ ...request, operationId: "replacement-operation" }), null);
    assert.equal(stops, changed === "control" ? 1 : 0, "no second or replacement operation signal");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runner_media_active_stops").get()!.n, 1);
    const saved = db.prepare("SELECT request,sha256,outcome FROM runner_media_active_stops").get()!;
    assert.equal(saved.request, JSON.stringify(request));
    assert.equal(saved.sha256, sha(JSON.stringify(request)));
    assert.equal(saved.outcome, expectedOutcome);
  });
}
