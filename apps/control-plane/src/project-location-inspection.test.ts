import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECT_LOCATION_INSPECTION_FAILURES, PROTOCOL_VERSION,
  type CampaignLaunchInspectionResult, type ControlPlaneToRunner, type RunnerMetadata, type RunnerRuntimeInfo,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { inspectProjectLocation } from "./project-location-inspection.js";

type Inspect = Extract<ControlPlaneToRunner, { type: "campaign_launch_inspect" }>;
const runtime = (version?: 1 | 2 | 3): RunnerRuntimeInfo => ({ dataDir: "/fixture/data", worktreeRoot: "/fixture/data/worktrees",
  maxConcurrentSessions: 4, ...(version ? { campaignLaunchInspection: { version } } : {}) });

function fixture(options: { version?: 1 | 2 | 3 | null } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const meta = (runnerId: string, path: string, version: 1 | 2 | 3 | undefined): RunnerMetadata => ({ runnerId, hostname: runnerId, os: "linux",
    version: "test", workspaces: [{ id: "w", name: `Repo on ${runnerId}`, path }], agents: [], runtime: runtime(version) });
  db.registerRunner(meta("r", "/fixture/one", options.version === null ? undefined : options.version ?? 3), Date.now(), PROTOCOL_VERSION);
  db.registerRunner(meta("other", "/fixture/two", 3), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const online = new Set(["r", "other"]);
  hub.isRunnerOnline = (runnerId) => online.has(runnerId);
  const sent: Inspect[] = [];
  const state: { answer: (message: Inspect) => CampaignLaunchInspectionResult | null; during?: () => void } = {
    answer: (message) => ({ type: "campaign_launch_inspection_result", requestId: message.requestId, workspaceId: message.workspaceId,
      ok: true, repository: "owner/repo", issueNumbers: [], digest: "d".repeat(64) }),
  };
  hub.sendToRunner = (runnerId, message) => {
    if (message.type !== "campaign_launch_inspect") return true;
    sent.push(message);
    state.during?.();
    const answer = state.answer(message);
    if (answer) queueMicrotask(() => hub.resolveRunnerRequest(answer, runnerId));
    return true;
  };
  const project = db.createProject({ name: "Fixture" });
  const location = db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "w" });
  return { db, hub, online, sent, state, project, location };
}

test("a Location verifies in its own authorized path, by id, with no issue read", async () => {
  const f = fixture();
  const result = await inspectProjectLocation(f, f.location.id, { projectId: f.project.id, now: () => 42 });
  assert.deepEqual(result, { ok: true, location: { locationId: f.location.id, projectId: f.project.id, runnerId: "r", workspaceId: "w",
    repository: "owner/repo", digest: "d".repeat(64), verifiedAt: 42 } });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.workspacePath, "/fixture/one");
  assert.equal(f.sent[0]!.workspaceId, "w");
  assert.deepEqual(f.sent[0]!.issueNumbers, []);
});

test("each Location of a Project is inspected on its own runner and path", async () => {
  const f = fixture();
  const second = f.db.addProjectLocation(f.project.id, { runnerId: "other", workspaceId: "w" });
  const results = await Promise.all([f.location.id, second.id].map((id) => inspectProjectLocation(f, id, { projectId: f.project.id })));
  assert.deepEqual(results.map((result) => result.ok && result.location.runnerId), ["r", "other"]);
  assert.deepEqual(f.sent.map((message) => message.workspacePath).sort(), ["/fixture/one", "/fixture/two"]);
});

test("unknown, foreign, removed and detached Locations are unknown without contacting a runner", async () => {
  const f = fixture();
  const elsewhere = f.db.createProject({ name: "Elsewhere" });
  const removable = f.db.addProjectLocation(elsewhere.id, { runnerId: "other", workspaceId: "w" });
  f.db.removeProjectLocation(removable.id);
  // Removing a runner detaches its Locations; they stay listed but are no longer active.
  const detached = f.db.addProjectLocation(f.project.id, { runnerId: "other", workspaceId: "w" });
  f.db.deleteRunner("other");
  assert.equal(f.db.getProjectLocation(detached.id)?.availability, "runner_removed");
  for (const [id, projectId] of [["missing", undefined], [f.location.id, elsewhere.id], [removable.id, undefined], [detached.id, f.project.id]] as const) {
    const result = await inspectProjectLocation(f, id, { projectId });
    assert.deepEqual(result, { ok: false, locationId: id, failure: "unknown_location", reason: PROJECT_LOCATION_INSPECTION_FAILURES.unknown_location });
  }
  assert.equal(f.sent.length, 0);
});

test("an offline runner and a runner without Location inspection fail before any request", async () => {
  const offline = fixture();
  offline.online.delete("r");
  const result = await inspectProjectLocation(offline, offline.location.id);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure, "runner_offline");
  assert.equal(!result.ok && result.reason, PROJECT_LOCATION_INSPECTION_FAILURES.runner_offline);
  for (const version of [null, 1, 2] as const) {
    const old = fixture({ version });
    const answer = await inspectProjectLocation(old, old.location.id);
    assert.equal(!answer.ok && answer.failure, "runner_too_old", `version ${version}`);
    assert.equal(old.sent.length, 0);
  }
  assert.equal(offline.sent.length, 0);
});

test("runner failure codes map to closed Location reasons, and anything else reads as read_failed", async () => {
  const cases = [["unknown_location", "unknown_location"], ["missing_path", "path_missing"], ["not_repository", "not_repository"],
    ["unsupported_origin", "unsupported_origin"], ["issue_read_failed", "read_failed"], ["invalid_request", "read_failed"]] as const;
  for (const [runnerFailure, expected] of cases) {
    const f = fixture();
    // A runner error string is never relayed: only the fixed sentence for the mapped reason is.
    f.state.answer = (message) => ({ type: "campaign_launch_inspection_result", requestId: message.requestId, workspaceId: message.workspaceId,
      ok: false, failure: runnerFailure, error: "/home/secret/path origin git@example.com:x" });
    const result = await inspectProjectLocation(f, f.location.id);
    assert.deepEqual(result, { ok: false, locationId: f.location.id, failure: expected, reason: PROJECT_LOCATION_INSPECTION_FAILURES[expected] });
  }
});

test("only an exact success for the requested workspace verifies; malformed answers read as read_failed", async () => {
  const good = { ok: true, repository: "owner/repo", issueNumbers: [], digest: "d".repeat(64) };
  // Runner frames are not validated on the wire, so each variant is cast past its static type.
  const variants: Array<Record<string, unknown>> = [
    { ok: true },
    { ...good, cancelled: true },
    { ...good, workspaceId: "another" },
    { ...good, ok: 1 },
    { ...good, ok: "true" },
    { ...good, digest: "not-a-digest" },
    { ...good, digest: "D".repeat(64) },
    { ...good, repository: "" },
    { ...good, repository: "https://github.com/owner/repo.git" },
    { ok: false, failure: "__proto__" },
    { ok: false, failure: "constructor" },
    { ok: false, failure: "toString" },
    { ok: false, failure: 7 },
    { ok: true, failure: "not_repository" },
  ];
  for (const variant of variants) {
    const f = fixture();
    f.state.answer = (message) => ({ type: "campaign_launch_inspection_result", requestId: message.requestId,
      workspaceId: message.workspaceId, ...variant } as unknown as CampaignLaunchInspectionResult);
    const result = await inspectProjectLocation(f, f.location.id);
    assert.deepEqual(result, { ok: false, locationId: f.location.id, failure: "read_failed", reason: PROJECT_LOCATION_INSPECTION_FAILURES.read_failed },
      JSON.stringify(variant));
  }
  const mixedCase = fixture();
  mixedCase.state.answer = (message) => ({ type: "campaign_launch_inspection_result", requestId: message.requestId, workspaceId: message.workspaceId,
    ...good, repository: "Owner/Repo" });
  const canonical = await inspectProjectLocation(mixedCase, mixedCase.location.id);
  assert.equal(canonical.ok && canonical.location.repository, "owner/repo");
});

test("a timeout or cancelled caller never verifies a Location", async () => {
  const silent = fixture();
  silent.state.answer = () => null;
  const timedOut = await inspectProjectLocation(silent, silent.location.id, { timeoutMs: 5 });
  assert.equal(!timedOut.ok && timedOut.failure, "read_failed");
  const caller = new AbortController();
  const pending = inspectProjectLocation(silent, silent.location.id, { signal: caller.signal });
  caller.abort();
  const aborted = await pending;
  assert.equal(!aborted.ok && aborted.failure, "read_failed");
});

test("a Location missing its workspace path or changing during inspection is not verified", async () => {
  const unregistered = fixture();
  unregistered.db.registerRunner({ runnerId: "r", hostname: "r", os: "linux", version: "test", workspaces: [], agents: [], runtime: runtime(3) },
    Date.now(), PROTOCOL_VERSION);
  const result = await inspectProjectLocation(unregistered, unregistered.location.id);
  assert.equal(!result.ok && result.failure, "path_missing");
  assert.equal(unregistered.sent.length, 0);

  const removed = fixture();
  removed.state.during = () => { removed.db.removeProjectLocation(removed.location.id); };
  const gone = await inspectProjectLocation(removed, removed.location.id);
  assert.equal(!gone.ok && gone.failure, "unknown_location");

  const repointed = fixture();
  repointed.state.during = () => {
    repointed.db.registerRunner({ runnerId: "r", hostname: "r", os: "linux", version: "test",
      workspaces: [{ id: "w", name: "Moved", path: "/fixture/elsewhere" }], agents: [], runtime: runtime(3) }, Date.now(), PROTOCOL_VERSION);
  };
  const moved = await inspectProjectLocation(repointed, repointed.location.id);
  assert.equal(!moved.ok && moved.failure, "read_failed");

  // A Location moved to another Project keeps its runner, workspace and path, but it is no longer
  // the Location the caller asked about, with or without a `projectId` constraint.
  for (const constrained of [false, true]) {
    const relocated = fixture();
    const target = relocated.db.createProject({ name: "Target" });
    relocated.state.during = () => { assert.ok(relocated.db.moveProjectLocation(relocated.location.id, target.id)); };
    const answer = await inspectProjectLocation(relocated, relocated.location.id, constrained ? { projectId: relocated.project.id } : {});
    assert.equal(answer.ok, false, `constrained=${constrained}`);
    assert.equal(!answer.ok && answer.failure, constrained ? "unknown_location" : "read_failed");
  }
});
