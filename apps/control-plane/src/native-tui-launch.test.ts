import assert from "node:assert/strict";
import { test } from "node:test";
import type { CreateSessionRequest, SessionView } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import {
  nativeTuiCreationError,
  nativeTuiSessionError,
  openNativeTuiAtomically,
} from "./native-tui-launch.js";

const online = { isRunnerOnline: () => true };

function fakeDb(overrides: {
  os?: string;
  protocolVersion?: number;
  driver?: string;
  targetAdapter?: string;
} = {}): ControlPlaneDb {
  return {
    getRunner: () => ({
      runnerId: "runner",
      os: overrides.os ?? "linux",
      protocolVersion: overrides.protocolVersion ?? 67,
      executionTargets: overrides.targetAdapter
        ? [{ id: "target", adapter: overrides.targetAdapter }]
        : [],
    }),
    getAgentLaunch: () => ({ driver: overrides.driver ?? "claude-code" }),
  } as unknown as ControlPlaneDb;
}

function request(overrides: Partial<CreateSessionRequest> = {}): CreateSessionRequest {
  return {
    runnerId: "runner",
    workspaceId: "workspace",
    agentId: "agent",
    launchSurface: "native_tui",
    ...overrides,
  };
}

test("Native TUI preflight accepts supported host launches and leaves Direct unchanged", () => {
  assert.equal(nativeTuiCreationError(fakeDb(), online, request()), null);
  assert.equal(nativeTuiCreationError(fakeDb({ os: "macos" }), online, request({ launchSurface: "direct" })), null);
});

test("Native TUI preflight rejects unsupported protocol, OS, driver, conductor, and target", () => {
  assert.match(nativeTuiCreationError(fakeDb({ protocolVersion: 57 }), online, request())!.error, /protocol v58/i);
  assert.match(nativeTuiCreationError(fakeDb({ os: "macos" }), online, request())!.error, /Windows or Linux/);
  assert.match(nativeTuiCreationError(fakeDb({ driver: "acp" }), online, request())!.error, /does not expose/);
  assert.match(nativeTuiCreationError(fakeDb(), online, request({ agentId: "conductor" }))!.error, /Conductor/);
  assert.match(
    nativeTuiCreationError(fakeDb({ targetAdapter: "container" }), online, request({ executionTargetId: "target" }))!.error,
    /host execution target/,
  );
});

test("v66 keeps manual Agent TUI attachment but rejects initial Native TUI launch", () => {
  assert.match(nativeTuiCreationError(fakeDb({ protocolVersion: 66 }), online, request())!.error, /protocol v67/i);
  const session = {
    runnerId: "runner",
    agentId: "agent",
    driver: "claude-code",
  } as unknown as SessionView;
  assert.equal(nativeTuiSessionError(fakeDb({ protocolVersion: 66 }), online, session), null);
});

test("materialized session validation rejects non-host Agent TUI isolation", () => {
  const session = {
    runnerId: "runner",
    agentId: "agent",
    driver: "claude-code",
    executionTarget: { adapter: "cloud" },
  } as unknown as SessionView;
  assert.match(nativeTuiSessionError(fakeDb(), online, session)!.error, /host execution target/);
});

test("atomic Native TUI launch keeps successful sessions and compensates failed opens", async () => {
  const removed: string[] = [];
  const compensate = (id: string) => {
    removed.push(id);
    return { ok: true, status: 200 };
  };
  const success = await openNativeTuiAtomically("ok", async () => ({ ok: true, status: 200 }), compensate);
  assert.equal(success.ok, true);
  assert.deepEqual(removed, []);

  const failure = await openNativeTuiAtomically(
    "failed",
    async () => ({ ok: false, status: 502, error: "provider exited" }),
    compensate,
  );
  assert.equal(failure.ok, false);
  assert.deepEqual(removed, ["failed"]);
});

test("ambiguous Native TUI timeouts never compensate a valid queued or slow session", async () => {
  const removed: string[] = [];
  const result = await openNativeTuiAtomically(
    "queued",
    async () => ({ ok: false, status: 504, error: "runner request timed out", definitive: false }),
    (id) => {
      removed.push(id);
      return { ok: true, status: 200 };
    },
  );
  assert.equal(result.definitive, false);
  assert.deepEqual(removed, []);
});

test("a thrown open is compensated and cleanup failure is surfaced", async () => {
  const removed: string[] = [];
  const compensated = await openNativeTuiAtomically(
    "thrown",
    async () => { throw new Error("transport exploded"); },
    (id) => {
      removed.push(id);
      return { ok: true, status: 200 };
    },
  );
  assert.match(compensated.error ?? "", /transport exploded/);
  assert.deepEqual(removed, ["thrown"]);

  const failedCleanup = await openNativeTuiAtomically(
    "cleanup-failed",
    async () => ({ ok: false, status: 502, error: "provider rejected", definitive: true }),
    () => ({ ok: false, status: 409, error: "pod reconciliation blocks deletion" }),
  );
  assert.equal(failedCleanup.status, 500);
  assert.equal(failedCleanup.retainedSession, true);
  assert.match(failedCleanup.error ?? "", /cleanup failed: pod reconciliation blocks deletion/);

  const alreadyRemoved = await openNativeTuiAtomically(
    "already-removed",
    async () => ({ ok: false, status: 502, error: "provider rejected", definitive: true }),
    () => ({ ok: false, status: 404, error: "session not found" }),
  );
  assert.equal(alreadyRemoved.status, 502, "an already-absent exact session satisfies compensation");
  assert.equal(alreadyRemoved.error, "provider rejected");
});
