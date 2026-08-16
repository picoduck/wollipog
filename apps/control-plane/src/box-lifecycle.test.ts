import assert from "node:assert/strict";
import test from "node:test";
import type { SessionView } from "@wollipog/protocol";
import {
  blockingRunnerSessions,
  boxLifecycleConflict,
  canAuthorizeLegacyDataAdoption,
  decideBoxLifecycle,
  decideScopedBoxLifecycle,
  decideScopedBoxLifecycleForRunners,
  parseBoxLifecycleForce,
  parseLegacyDataAdoption,
} from "./box-lifecycle.js";

const session = (id: string, runnerId: string, status: SessionView["status"]): Pick<SessionView, "id" | "runnerId" | "title" | "status"> => ({
  id,
  runnerId,
  title: id,
  status,
});

test("box lifecycle protection includes every non-terminal runner session", () => {
  const sessions = [
    session("queued", "box-runner", "queued"),
    session("running", "box-runner", "running"),
    session("approval", "box-runner", "input_required"),
    session("idle", "box-runner", "idle"),
    session("done", "box-runner", "completed"),
    session("failed", "box-runner", "failed"),
    session("stopped", "box-runner", "stopped"),
    session("other", "another-runner", "running"),
  ];
  assert.deepEqual(
    blockingRunnerSessions(sessions, "box-runner").map(({ id }) => id),
    ["queued", "running", "approval", "idle"],
  );
});

test("box lifecycle force parsing fails closed and conflict payload stays bounded", () => {
  assert.deepEqual(parseBoxLifecycleForce(undefined), { ok: true, force: false });
  assert.deepEqual(parseBoxLifecycleForce({}), { ok: true, force: false });
  assert.deepEqual(parseBoxLifecycleForce({ force: true }), { ok: true, force: true });
  assert.deepEqual(parseBoxLifecycleForce({ force: "true" }), { ok: false, error: "force must be a boolean" });
  assert.equal(parseBoxLifecycleForce([]).ok, false);

  const active = Array.from({ length: 25 }, (_, index) => ({
    id: `session-${index}`,
    title: `Session ${index}`,
    status: "running" as const,
  }));
  const conflict = boxLifecycleConflict(active, "update");
  assert.equal(conflict.code, "BOX_HAS_ACTIVE_SESSIONS");
  assert.equal(conflict.activeSessionCount, 25);
  assert.equal(conflict.activeSessions.length, 20);
  assert.match(conflict.error, /25 active sessions.*force=true/);
  assert.equal(decideBoxLifecycle(active, false, "reconnect").ok, false);
  assert.deepEqual(decideBoxLifecycle(active, true, "reconnect"), { ok: true });
  assert.deepEqual(decideBoxLifecycle([], false, "update"), { ok: true });

  const scoped = boxLifecycleConflict(active, "update", [active[22]!, active[24]!]);
  assert.equal(scoped.activeSessionCount, 25, "the safety decision retains the true fleet-wide count");
  assert.deepEqual(
    scoped.activeSessions.map(({ id }) => id),
    ["session-22", "session-24"],
    "the response exposes only caller-visible details, including allowed rows after the first 20",
  );
  const scopedDecision = decideBoxLifecycle(active, false, "reconnect", [active[24]!]);
  assert.equal(scopedDecision.ok, false);
  if (!scopedDecision.ok) {
    assert.equal(scopedDecision.conflict.activeSessionCount, 25);
    assert.deepEqual(scopedDecision.conflict.activeSessions.map(({ id }) => id), ["session-24"]);
  }
});

test("legacy adoption requires exact acknowledgement and owner or admin authority", () => {
  assert.equal(parseLegacyDataAdoption(undefined).ok, false);
  assert.equal(parseLegacyDataAdoption({}).ok, false);
  assert.equal(parseLegacyDataAdoption({ acknowledgeAllLegacyRunnersStopped: false }).ok, false);
  assert.equal(parseLegacyDataAdoption({ acknowledgeAllLegacyRunnersStopped: true, force: "yes" }).ok, false);
  assert.deepEqual(parseLegacyDataAdoption({ acknowledgeAllLegacyRunnersStopped: true }), {
    ok: true,
    force: false,
  });
  assert.deepEqual(parseLegacyDataAdoption({ acknowledgeAllLegacyRunnersStopped: true, force: true }), {
    ok: true,
    force: true,
  });
  assert.equal(canAuthorizeLegacyDataAdoption(null), false);
  assert.equal(canAuthorizeLegacyDataAdoption({ role: "viewer" }), false);
  assert.equal(canAuthorizeLegacyDataAdoption({ role: "member" }), false);
  assert.equal(canAuthorizeLegacyDataAdoption({ role: "admin" }), true);
  assert.equal(canAuthorizeLegacyDataAdoption({ role: "owner" }), true);
});

test("scoped lifecycle conflicts hide inaccessible session metadata without weakening the safety gate", () => {
  const sessions = [
    session("visible", "box-runner", "idle"),
    session("secret", "box-runner", "running"),
    session("done", "box-runner", "completed"),
    session("other-runner", "other", "running"),
  ];
  const decision = decideScopedBoxLifecycle(
    sessions,
    "box-runner",
    false,
    "update",
    (sessionId) => sessionId === "visible",
  );
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.conflict.activeSessionCount, 2);
    assert.deepEqual(decision.conflict.activeSessions, [{ id: "visible", title: "visible", status: "idle" }]);
    assert.doesNotMatch(JSON.stringify(decision.conflict), /secret/);
  }
  assert.deepEqual(
    decideScopedBoxLifecycle(sessions, "box-runner", true, "update", () => false),
    { ok: true },
    "explicit force still permits the action even when every blocking session is hidden",
  );
});

test("legacy account admission includes active sessions from every sibling runner", () => {
  const sessions = [
    session("target-idle", "target-runner", "idle"),
    session("sibling-running", "sibling-runner", "running"),
    session("unrelated", "other-runner", "running"),
  ];
  const blocked = decideScopedBoxLifecycleForRunners(
    sessions,
    ["target-runner", "sibling-runner"],
    false,
    "adopt",
    () => true,
  );
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.deepEqual(blocked.conflict.activeSessions.map(({ id }) => id), ["target-idle", "sibling-running"]);
  }
  assert.deepEqual(
    decideScopedBoxLifecycleForRunners(
      sessions,
      ["target-runner", "sibling-runner"],
      true,
      "adopt",
      () => true,
    ),
    { ok: true },
    "the explicit force acknowledgement covers the complete legacy SSH-account sibling set",
  );
});
