import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitActionRequestMessage, ProjectView, SessionEvent, SessionReminderView, SessionView } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID } from "./identity.js";
import {
  Hub,
  isRunnerRequestTimeoutError,
  MAX_UI_CLIENTS,
  MAX_UI_CLIENTS_PER_ADMISSION_KEY,
  MAX_UI_BACKGROUND_OBSERVATIONS_PER_CONNECTION,
  MAX_UI_BACKGROUND_OBSERVATIONS_PER_WINDOW,
  UI_BACKGROUND_OBSERVATION_RATE_WINDOW_MS,
  UI_CONNECTION_RATE_WINDOW_MS,
  MAX_UI_BUFFERED_BYTES,
  MAX_UI_QUEUED_MESSAGES,
  MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW,
  UI_SUBSCRIPTION_ADMISSION_TTL_MS,
  UI_SUBSCRIPTION_RATE_WINDOW_MS,
  type Socket,
  reminderWakeReasonForEvent,
} from "./hub.js";

// The runner request/response methods don't touch the DB, so a bare stub is fine.
const fakeDb = {} as ControlPlaneDb;

test("reminder activity recognizes only authoritative agent response completion", () => {
  assert.equal(reminderWakeReasonForEvent({ kind: "agent_message", text: "partial" }), null);
  assert.equal(reminderWakeReasonForEvent({ kind: "agent_response_completed" }), "agent_response");
  assert.equal(
    reminderWakeReasonForEvent({ kind: "agent_message", text: "completion-only", final: true }),
    "agent_response",
  );
  assert.equal(reminderWakeReasonForEvent({ kind: "turn_interrupted" }), null);
});

function gitReq(requestId: string): GitActionRequestMessage {
  return { type: "git_action", requestId, sessionId: "s", worktreePath: "/w", action: { kind: "status" } };
}

test("requestFromRunner sends the message and resolves on the matching git_result", async () => {
  const sent: string[] = [];
  const socket: Socket = { send: (d) => sent.push(d) };
  const hub = new Hub(fakeDb);
  hub.attachRunner("r1", socket);

  const p = hub.requestFromRunner("r1", "req-1", gitReq("req-1"), 5000);
  assert.ok(sent.some((m) => m.includes("git_action")), "request forwarded to the runner");

  hub.resolveRunnerRequest({ type: "git_result", requestId: "req-1", ok: true, data: {} });
  const result = await p;
  assert.equal(result.ok, true);
});

test("flow-controlled runner sends wait for flush and reject frames beyond the caller's byte bound", async () => {
  const sent: string[] = [];
  let bufferedAmount = 0;
  let complete: ((error?: Error) => void) | undefined;
  let terminations = 0;
  const socket: Socket = {
    asyncDelivery: true,
    get bufferedAmount() { return bufferedAmount; },
    send: (data, onComplete) => {
      sent.push(data);
      complete = onComplete;
    },
    terminate: () => { terminations += 1; },
  };
  const hub = new Hub(fakeDb);
  hub.attachRunner("r1", socket);

  let settled = false;
  const pending = hub.sendToRunnerAndWait("r1", gitReq("flow-1"), 4_096).then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false, "the caller cannot enqueue the next frame before ws flushes this one");
  complete?.();
  assert.equal(await pending, true);

  bufferedAmount = 4_096;
  assert.equal(await hub.sendToRunnerAndWait("r1", gitReq("flow-2"), 4_096), false);
  assert.equal(sent.length, 1, "an over-bound frame never reaches socket.send");

  bufferedAmount = 0;
  assert.equal(await hub.sendToRunnerAndWait("r1", gitReq("flow-3"), 4_096, 1), false);
  assert.equal(terminations, 1, "a socket that never flushes is terminated to release its retained frame");
});

test("duplicate durable callers join one runner request and share its receipt", async () => {
  const sent: string[] = [];
  const hub = new Hub(fakeDb);
  hub.attachRunner("r1", { send: (data) => sent.push(data) });
  const first = hub.requestFromRunner("r1", "req-shared", gitReq("req-shared"), 5_000);
  const second = hub.waitForRunnerRequest("r1", "req-shared");
  assert.equal(sent.length, 1);
  hub.resolveRunnerRequest({ type: "git_result", requestId: "req-shared", ok: true, data: { shared: true } }, "r1");
  assert.deepEqual(await first, await second);
});

test("a correlated runner result cannot resolve another runner's pending request", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const hub = new Hub(db);
  hub.attachRunner("r1", { send() {} });
  const pending = hub.requestFromRunner("r1", "req-owner", gitReq("req-owner"), 5_000);
  assert.equal(hub.resolveRunnerRequest(
    { type: "git_result", requestId: "req-owner", ok: true, data: { source: "wrong" } },
    "r2",
  ), false);
  assert.equal(hub.resolveRunnerRequest(
    { type: "git_result", requestId: "req-owner", ok: true, data: { source: "right" } },
    "r1",
  ), true);
  assert.deepEqual(await pending, {
    type: "git_result",
    requestId: "req-owner",
    ok: true,
    data: { source: "right" },
  });
});

test("requestFromRunner rejects immediately when the runner is offline", async () => {
  const hub = new Hub(fakeDb);
  await assert.rejects(() => hub.requestFromRunner("ghost", "x", gitReq("x")), /offline/);
});

test("requestFromRunner exposes a typed timeout without relying on message text", async () => {
  const hub = new Hub(fakeDb);
  hub.attachRunner("r1", { send() {} });
  await assert.rejects(
    () => hub.requestFromRunner("r1", "req-timeout", gitReq("req-timeout"), 1),
    (error) => isRunnerRequestTimeoutError(error),
  );
});

test("verified progress refreshes only the exact runner request inactivity deadline", async () => {
  const hub = new Hub(fakeDb);
  hub.attachRunner("r1", { send() {} });
  const pending = hub.requestFromRunner("r1", "req-progress", gitReq("req-progress"), 1);
  assert.equal(hub.refreshRunnerRequestTimeout("r2", "req-progress", 50), false);
  assert.equal(hub.refreshRunnerRequestTimeout("r1", "missing", 50), false);
  assert.equal(hub.refreshRunnerRequestTimeout("r1", "req-progress", 50), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hub.resolveRunnerRequest({
    type: "git_result", requestId: "req-progress", ok: true, data: { refreshed: true },
  }, "r1"), true);
  assert.deepEqual(await pending, {
    type: "git_result", requestId: "req-progress", ok: true, data: { refreshed: true },
  });
});

test("cancelRunnerRequest releases one exact in-flight correlation immediately", async () => {
  const hub = new Hub(fakeDb);
  hub.attachRunner("r1", { send() {} });
  const pending = hub.requestFromRunner("r1", "req-cancel", gitReq("req-cancel"), 30_000);
  assert.equal(hub.cancelRunnerRequest("r2", "req-cancel"), false);
  assert.equal(hub.cancelRunnerRequest("r1", "req-cancel"), true);
  await assert.rejects(() => pending, /cancelled/);
  assert.equal(hub.cancelRunnerRequest("r1", "req-cancel"), false);
});

test("detachRunner rejects in-flight requests for that runner (no hang until timeout)", async () => {
  const socket: Socket = { send: () => {} };
  const hub = new Hub(fakeDb);
  hub.attachRunner("r1", socket);

  const p = hub.requestFromRunner("r1", "req-2", gitReq("req-2"), 30_000);
  hub.detachRunner("r1", socket);
  await assert.rejects(() => p, /disconnected/);
});

test("detachRunner leaves other runners' requests intact", async () => {
  const s1: Socket = { send: () => {} };
  const s2: Socket = { send: () => {} };
  const hub = new Hub(fakeDb);
  hub.attachRunner("r1", s1);
  hub.attachRunner("r2", s2);

  const p2 = hub.requestFromRunner("r2", "req-3", gitReq("req-3"), 30_000);
  hub.detachRunner("r1", s1); // unrelated runner drops
  hub.resolveRunnerRequest({ type: "git_result", requestId: "req-3", ok: true, data: {} });
  assert.equal((await p2).ok, true);
});

// addUiClient sends a snapshot, so a UI-client test needs the list methods stubbed.
const snapshotDb = {
  listRunners: () => [],
  listRunnersForPrincipal: () => [],
  listBoxes: () => [],
  listSessions: () => [],
  listSessionsForPrincipal: () => [],
  listProjects: () => [],
  listProjectsForPrincipal: () => [],
  listRuns: () => [],
  listPods: () => [],
  listSessionReminders: () => [],
} as unknown as ControlPlaneDb;

test("dashboard background delivery acknowledgements are session-authorized and idempotent", () => {
  const acknowledged: string[] = [];
  const db = {
    ...snapshotDb,
    canAccessSession: (_principal: unknown, sessionId: string) => sessionId === "allowed",
    acknowledgeBackgroundDelivery: (sessionId: string, continuationId: string) => {
      acknowledged.push(`${sessionId}:${continuationId}`);
      return true;
    },
    getSession: () => null,
  } as unknown as ControlPlaneDb;
  const hub = new Hub(db);
  const client = { send: () => {} };
  hub.addUiClient(client, {
    deviceId: "device-1",
    principal: { kind: "human", organizationId: "org", userId: "user", deviceId: "device-1" },
    close: () => {},
  });
  assert.equal(hub.acknowledgeUiBackgroundDelivery(client, "denied", "bgcont-1", 10), false);
  assert.deepEqual(acknowledged, []);
  assert.equal(hub.acknowledgeUiBackgroundDelivery(client, "allowed", "bgcont-1", 11), true);
  assert.deepEqual(acknowledged, ["allowed:bgcont-1"]);
  assert.equal(hub.acknowledgeUiBackgroundDelivery(client, "allowed", "bgcont-1", 12), false);
  assert.deepEqual(acknowledged, ["allowed:bgcont-1"], "one connection cannot replay the same database write");
  assert.equal(hub.acknowledgeUiBackgroundDelivery({ send: () => {} }, "allowed", "bgcont-1", 12), false);
});

test("background delivery acknowledgement retries after authorization and rotates its bounded cache", () => {
  let authorized = false;
  const acknowledged: string[] = [];
  const db = {
    ...snapshotDb,
    canAccessSession: () => authorized,
    acknowledgeBackgroundDelivery: (_sessionId: string, continuationId: string) => {
      acknowledged.push(continuationId);
      return true;
    },
    getSession: () => null,
  } as unknown as ControlPlaneDb;
  const hub = new Hub(db);
  const client = { send: () => {} };
  hub.addUiClient(client, {
    deviceId: "device-retry",
    principal: { kind: "human", organizationId: "org", userId: "user", deviceId: "device-retry" },
    close: () => {},
  });
  assert.equal(hub.acknowledgeUiBackgroundDelivery(client, "session", "retry", 10), false);
  authorized = true;
  assert.equal(hub.acknowledgeUiBackgroundDelivery(client, "session", "retry", 11), true);

  for (let i = 0; i <= MAX_UI_BACKGROUND_OBSERVATIONS_PER_CONNECTION; i++) {
    assert.equal(hub.acknowledgeUiBackgroundDelivery(client, "session", `continuation-${i}`, 20 + i * 100), true);
  }
  assert.equal(
    hub.acknowledgeUiBackgroundDelivery(client, "session", "continuation-0", 200_000),
    true,
    "the bounded dedupe cache evicts oldest keys instead of permanently disabling acknowledgements",
  );

  for (let i = 0; i < MAX_UI_BACKGROUND_OBSERVATIONS_PER_WINDOW; i++) {
    assert.equal(
      hub.acknowledgeUiBackgroundDelivery(client, "session", `rate-${i}`, 300_000),
      true,
    );
  }
  assert.equal(
    hub.acknowledgeUiBackgroundDelivery(client, "session", "rate-over", 300_000),
    false,
    "the fixed-window admission limit blocks DB work after its bounded allowance",
  );
  assert.equal(
    hub.acknowledgeUiBackgroundDelivery(
      client,
      "session",
      "rate-next-window",
      300_000 + UI_BACKGROUND_OBSERVATION_RATE_WINDOW_MS,
    ),
    true,
    "a later window restores acknowledgement admission",
  );
  assert.ok(acknowledged.includes("retry"));
});

test("project upserts build only the changed principal-scoped Project view", () => {
  const globalProject: ProjectView = {
    id: "project-1",
    name: "Project One",
    hidden: false,
    locations: [],
    activeSessionCount: 9,
    unarchivedSessionCount: 9,
    totalSessionCount: 9,
    createdAt: 1,
    updatedAt: 1,
  };
  const scopedProject = { ...globalProject, activeSessionCount: 1, unarchivedSessionCount: 1, totalSessionCount: 1 };
  let listReads = 0;
  let exactReads = 0;
  const db = {
    ...snapshotDb,
    listProjectsForPrincipal: () => { listReads++; return [scopedProject]; },
    getProjectForPrincipal: (_principal: unknown, projectId: string) => {
      exactReads++;
      assert.equal(projectId, globalProject.id);
      return scopedProject;
    },
    canAccessProject: () => true,
  } as unknown as ControlPlaneDb;
  const messages: Array<{ type: string; project?: ProjectView }> = [];
  const hub = new Hub(db);
  hub.addUiClient(
    { send: (data) => messages.push(JSON.parse(data) as { type: string; project?: ProjectView }) },
    {
      deviceId: "device-1",
      principal: { kind: "human", organizationId: "org", userId: "user", deviceId: "device-1" },
      close: () => {},
    },
  );
  assert.equal(listReads, 1, "the initial snapshot reads the complete Project inventory once");
  listReads = 0;
  hub.projectChanged(globalProject);
  assert.equal(listReads, 0, "a Project delta never rebuilds sibling Project views");
  assert.equal(exactReads, 1);
  const upsert = messages.findLast((message) => message.type === "project_upsert");
  assert.equal(upsert?.project?.totalSessionCount, 1, "the client receives principal-filtered counts");
});

test("moving a session between Locations in one Project refreshes exact Location counts", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({
    runnerId: "runner-project-locations",
    hostname: "project-locations-host",
    os: "linux",
    version: "1",
    agents: [],
    workspaces: [
      { id: "workspace-one", name: "One", path: "/repos/one" },
      { id: "workspace-two", name: "Two", path: "/repos/two" },
    ],
  }, 1);
  const projects = db.listProjects(true);
  const project = projects.find((item) => item.locations[0]?.workspaceId === "workspace-one")!;
  const second = projects.find((item) => item.locations[0]?.workspaceId === "workspace-two")!;
  db.moveProjectLocation(second.locations[0]!.id, project.id, 2);
  const session = db.createSession({
    id: "session-project-location",
    runnerId: "runner-project-locations",
    workspaceId: "workspace-one",
    agentId: null,
    title: "Location counts",
    useWorktree: false,
    driver: "acp",
    config: {},
    now: 3,
  });

  const messages: Array<{ type: string; project?: ProjectView }> = [];
  const hub = new Hub(db);
  hub.addUiClient({
    send: (data) => messages.push(JSON.parse(data) as { type: string; project?: ProjectView }),
  });
  messages.length = 0;

  db.setSessionWorkspace(session.id, "workspace-two", 4);
  hub.sessionChangedById(session.id);

  const upsert = messages.findLast((message) =>
    message.type === "project_upsert" && message.project?.id === project.id);
  assert.ok(upsert?.project, "same-Project Location moves must invalidate the Project projection");
  assert.deepEqual(
    upsert.project.locations.map((location) => [location.workspaceId, location.totalSessionCount]).sort(),
    [["workspace-one", 0], ["workspace-two", 1]],
  );
  db.close();
});

test("runner queue hold state is projected to dashboards and cleared authoritatively", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({
    runnerId: "runner-queue-hold",
    hostname: "queue-host",
    os: "linux",
    version: "1",
    agents: [],
    workspaces: [],
  }, 1);
  const session = db.createSession({
    id: "session-queue-hold",
    runnerId: "runner-queue-hold",
    workspaceId: null,
    agentId: null,
    title: "Queue Hold",
    useWorktree: false,
    driver: "acp",
    config: {},
    now: 2,
  });
  const messages: Array<{ type: string; session?: SessionView }> = [];
  const hub = new Hub(db);
  hub.attachRunner("runner-queue-hold", { send() {} });
  hub.addUiClient({
    send: (data) => messages.push(JSON.parse(data) as { type: string; session?: SessionView }),
  });
  messages.length = 0;

  hub.setSessionQueue(session.id, [{ id: "prompt-b", text: "B" }], true, "turn-a");
  const held = messages.findLast((message) => message.type === "session_upsert")?.session;
  assert.equal(held?.queueHeld, true);
  assert.equal(held?.activeTurnId, "turn-a");
  assert.equal(hub.activeTurnIdForSession(session.id), "turn-a");
  assert.deepEqual(held?.queued, [{ id: "prompt-b", text: "B" }]);

  hub.setSessionQueue(session.id, [{ id: "prompt-b", text: "B" }], false);
  const released = messages.findLast((message) => message.type === "session_upsert")?.session;
  assert.equal(released?.queueHeld, undefined);
  assert.deepEqual(released?.queued, [{ id: "prompt-b", text: "B" }]);

  hub.setSessionQueue(session.id, [], false);
  const drained = messages.findLast((message) => message.type === "session_upsert")?.session;
  assert.equal(drained?.queueHeld, undefined);
  assert.equal(drained?.queued, undefined);
  assert.equal(drained?.activeTurnId, undefined);
  assert.equal(hub.activeTurnIdForSession(session.id), undefined);
  db.close();
});

test("UI connection admission is bounded per principal and globally before snapshot work", () => {
  let scopedReads = 0;
  const db = {
    ...snapshotDb,
    listRunnersForPrincipal: () => { scopedReads++; return []; },
    listSessionsForPrincipal: () => { scopedReads++; return []; },
  } as unknown as ControlPlaneDb;
  const hub = new Hub(db, { maxUiClients: 3, maxUiClientsPerAdmissionKey: 2 });
  const principal = {
    kind: "human" as const, organizationId: "org", userId: "user", deviceId: "device-a",
  };
  const add = (deviceId: string, actor = principal) => hub.addUiClient(
    { send: () => {} },
    { deviceId, principal: actor, close: () => {} },
  );

  assert.equal(add("device-a"), true);
  assert.equal(add("device-a"), true, "multiple dashboard tabs remain supported");
  assert.equal(add("device-a"), false, "one device cannot multiply legacy fan-out without bound");
  assert.equal(scopedReads, 4, "rejection occurs before either scoped snapshot query");

  const other = { ...principal, userId: "other", deviceId: "device-b" };
  assert.equal(add("device-b", other), true);
  assert.equal(add("device-c", { ...other, userId: "third", deviceId: "device-c" }), false,
    "the global ceiling also rejects before snapshot construction");
  assert.equal(scopedReads, 6);

  assert.equal(MAX_UI_CLIENTS >= MAX_UI_CLIENTS_PER_ADMISSION_KEY, true);
  assert.equal(MAX_UI_CLIENTS_PER_ADMISSION_KEY >= 1, true, "rolling legacy compatibility retains a socket");
});

test("UI connection-start admission bounds sequential reconnect snapshot churn", () => {
  let scopedReads = 0;
  const db = {
    ...snapshotDb,
    listRunnersForPrincipal: () => { scopedReads++; return []; },
    listSessionsForPrincipal: () => { scopedReads++; return []; },
  } as unknown as ControlPlaneDb;
  const principal = {
    kind: "human" as const, organizationId: "org", userId: "user", deviceId: "device-a",
  };
  const info = { deviceId: "device-a", principal, close: () => {} };
  const hub = new Hub(db, {
    maxUiConnectionStartsPerWindow: 2,
    maxUiConnectionStartsGlobalPerWindow: 100,
  });
  const connectThenClose = (now: number) => {
    const socket: Socket = { send: () => {} };
    const admitted = hub.addUiClient(socket, { ...info }, now);
    if (admitted) hub.removeUiClient(socket);
    return admitted;
  };

  assert.equal(connectThenClose(0), true);
  assert.equal(connectThenClose(1), true);
  assert.equal(connectThenClose(2), false);
  assert.equal(connectThenClose(3), false, "rejected starts do not gain snapshot work");
  assert.equal(scopedReads, 4, "rate rejection occurs before principal-wide snapshot queries");
  assert.equal(connectThenClose(UI_CONNECTION_RATE_WINDOW_MS), true, "a later reconnect self-heals");
  assert.equal(scopedReads, 6);

  const atomicHub = new Hub(snapshotDb, {
    maxUiConnectionStartsPerWindow: 1,
    maxUiConnectionStartsGlobalPerWindow: 2,
  });
  const first: Socket = { send: () => {} };
  assert.equal(atomicHub.addUiClient(first, { ...info }, 0), true);
  atomicHub.removeUiClient(first);
  for (let i = 0; i < 5; i++) {
    assert.equal(atomicHub.addUiClient({ send: () => {} }, { ...info }, i + 1), false);
  }
  assert.equal(atomicHub.addUiClient({ send: () => {} }, {
    deviceId: "independent",
    principal: { ...principal, userId: "independent", deviceId: "independent" },
    close: () => {},
  }, 7), true, "per-key rejections do not poison independent global capacity");

  const globalHub = new Hub(snapshotDb, {
    maxUiConnectionStartsPerWindow: 100,
    maxUiConnectionStartsGlobalPerWindow: 2,
  });
  for (let i = 0; i < 2; i++) {
    const socket: Socket = { send: () => {} };
    assert.equal(globalHub.addUiClient(socket, {
      deviceId: `device-${i}`,
      principal: { ...principal, userId: `user-${i}`, deviceId: `device-${i}` },
      close: () => {},
    }, 0), true);
    globalHub.removeUiClient(socket);
  }
  assert.equal(globalHub.addUiClient({ send: () => {} }, {
    deviceId: "device-3",
    principal: { ...principal, userId: "user-3", deviceId: "device-3" },
    close: () => {},
  }, 0), false, "global start admission bounds churn across rotating principals");
});

test("closeUiClientsForDevice force-closes only the revoked device's sockets", () => {
  const hub = new Hub(snapshotDb);
  const closed: string[] = [];
  const mk = (id: string): Socket => ({ send: () => {} });
  const a = mk("a");
  const b = mk("b");
  const anon = mk("anon");
  hub.addUiClient(a, { deviceId: "dev_a", close: () => closed.push("a") });
  hub.addUiClient(b, { deviceId: "dev_b", close: () => closed.push("b") });
  hub.addUiClient(anon); // loopback client, no device

  hub.closeUiClientsForDevice("dev_a");
  assert.deepEqual(closed, ["a"], "only dev_a's socket is closed");

  // Its client is dropped from the fan-out set; a later broadcast reaches only the survivors.
  const sends: string[] = [];
  const track = (label: string): Socket => ({ send: () => sends.push(label) });
  const hub2 = new Hub(snapshotDb);
  const x = track("x");
  hub2.addUiClient(x, { deviceId: "dev_x", close: () => {} }); // sends the initial snapshot
  hub2.closeUiClientsForDevice("dev_x");
  sends.length = 0; // ignore the snapshot; count only post-revoke broadcasts
  hub2.runnerRemoved("r"); // triggers a broadcast
  assert.equal(sends.length, 0, "revoked client no longer receives broadcasts");
});

test("pod context entries fan out as one attributed websocket delta", () => {
  const hub = new Hub(snapshotDb);
  const sent: string[] = [];
  hub.addUiClient({ send: (data) => sent.push(data) });
  sent.length = 0;
  hub.podContextEntry({
    id: "ctx-1",
    podId: "pod-1",
    seq: 1,
    ts: 100,
    source: { kind: "session", sessionId: "s1", sessionTitle: "Builder", agentLabel: "Claude", fromSeq: 2, toSeq: 4 },
    content: "done",
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0]!), {
    type: "pod_context_entry",
    entry: {
      id: "ctx-1",
      podId: "pod-1",
      seq: 1,
      ts: 100,
      source: { kind: "session", sessionId: "s1", sessionTitle: "Builder", agentLabel: "Claude", fromSeq: 2, toSeq: 4 },
      content: "done",
    },
  });
});

function sessionEvent(sessionId: string, id = 1): SessionEvent {
  return { id, sessionId, seq: id, ts: id, payload: { kind: "agent_message", text: `event-${id}` } };
}

test("explicit UI subscriptions narrow only high-volume session streams", () => {
  const hub = new Hub(snapshotDb);
  const legacy: string[] = [];
  const selected: string[] = [];
  const metadataOnly: string[] = [];
  const legacySocket: Socket = { send: (data) => legacy.push(data) };
  const selectedSocket: Socket = { send: (data) => selected.push(data) };
  const metadataSocket: Socket = { send: (data) => metadataOnly.push(data) };
  hub.addUiClient(legacySocket);
  hub.addUiClient(selectedSocket);
  hub.addUiClient(metadataSocket);
  assert.equal(hub.setUiSessionSubscriptions(selectedSocket, 1, ["session-a"], ["pod-a"]).ok, true);
  assert.equal(hub.setUiSessionSubscriptions(metadataSocket, 1, [], []).ok, true);
  legacy.length = selected.length = metadataOnly.length = 0;

  hub.sessionEvent(sessionEvent("session-a", 1));
  hub.sessionEvent(sessionEvent("session-b", 2));
  hub.sessionEventsReset("session-b", [sessionEvent("session-b", 3)]);
  hub.shellOutput("session-a", "shell-1", "stdout", "hello");
  hub.shellExit("session-b", "shell-2", 0);
  hub.podContextEntry({
    id: "ctx-a", podId: "pod-a", seq: 1, ts: 1,
    source: { kind: "session", sessionId: "session-a", sessionTitle: "A", agentLabel: "Agent", fromSeq: 1, toSeq: 1 },
    content: "selected",
  });
  hub.podContextEntry({
    id: "ctx-b", podId: "pod-b", seq: 1, ts: 1,
    source: { kind: "session", sessionId: "session-b", sessionTitle: "B", agentLabel: "Agent", fromSeq: 1, toSeq: 1 },
    content: "not selected",
  });
  hub.boxRemoved("box-1");

  assert.deepEqual(legacy.map((data) => JSON.parse(data).type), [
    "session_event", "session_event", "session_events_reset", "shell_output", "shell_exit",
    "pod_context_entry", "pod_context_entry", "box_removed",
  ], "an old dashboard that never subscribes retains rolling-upgrade behavior");
  assert.deepEqual(selected.map((data) => JSON.parse(data).type), [
    "session_event", "shell_output", "pod_context_entry", "box_removed",
  ]);
  assert.deepEqual(metadataOnly.map((data) => JSON.parse(data).type), ["box_removed"]);
});

test("an authorized archived subscription receives deletion even though it was absent from the snapshot", () => {
  const hub = new Hub(snapshotDb);
  const sent: string[] = [];
  const socket: Socket = { send: (data) => sent.push(data) };
  hub.addUiClient(socket);
  assert.deepEqual(hub.setUiSessionSubscriptions(socket, 1, ["archived.txt"], []), {
    ok: true, sessionIds: ["archived.txt"], podIds: [],
  });
  sent.length = 0;

  hub.sessionRemoved("archived.txt");
  assert.deepEqual(sent.map((data) => JSON.parse(data)), [
    { type: "session_removed", sessionId: "archived.txt" },
  ]);
});

test("subscription replacement is acknowledged in writer order and revisions are monotonic", () => {
  const hub = new Hub(snapshotDb);
  const sent: string[] = [];
  const socket: Socket = { send: (data) => sent.push(data) };
  hub.addUiClient(socket);
  sent.length = 0;

  assert.deepEqual(hub.setUiSessionSubscriptions(socket, 7, ["s2", "s1"], ["p1"], 100), {
    ok: true, sessionIds: ["s1", "s2"], podIds: ["p1"],
  });
  assert.deepEqual(JSON.parse(sent[0]!), {
    type: "session_subscriptions_applied", revision: 7, sessionIds: ["s1", "s2"], podIds: ["p1"],
  });
  assert.deepEqual(hub.setUiSessionSubscriptions(socket, 7, [], [], 101), {
    ok: false, reason: "stale_revision",
  });
  assert.equal(sent.length, 1, "a stale replacement is never acknowledged");
});

test("subscription admission bounds repeated authorization work per caller", () => {
  const hub = new Hub(snapshotDb);
  const socket: Socket = { send: () => {} };
  hub.addUiClient(socket);
  for (let i = 1; i <= MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW; i++) {
    assert.equal(hub.setUiSessionSubscriptions(socket, i, [], [], 1_000).ok, true);
  }
  assert.deepEqual(
    hub.setUiSessionSubscriptions(socket, MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW + 1, [], [], 1_000),
    { ok: false, reason: "rate_limited" },
  );
  assert.equal(
    hub.setUiSessionSubscriptions(
      socket,
      MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW + 2,
      [],
      [],
      1_000 + UI_SUBSCRIPTION_RATE_WINDOW_MS,
    ).ok,
    true,
    "a fresh window accepts the current replacement",
  );
});

function consumeSubscriptionAllowance(hub: Hub, socket: Socket, now: number): void {
  for (let revision = 1; revision <= MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW; revision++) {
    assert.equal(hub.setUiSessionSubscriptions(socket, revision, [], [], now).ok, true);
  }
}

function addDeviceClient(hub: Hub, deviceId: string): Socket {
  const socket: Socket = { send: () => {} };
  hub.addUiClient(socket, { deviceId, close: () => {} });
  return socket;
}

test("subscription admission survives a paired-device reconnect", () => {
  const hub = new Hub(snapshotDb);
  const first = addDeviceClient(hub, "dev-reconnect");
  consumeSubscriptionAllowance(hub, first, 1_000);
  hub.removeUiClient(first);

  const replacement = addDeviceClient(hub, "dev-reconnect");
  assert.deepEqual(hub.setUiSessionSubscriptions(replacement, 1, [], [], 1_001), {
    ok: false, reason: "rate_limited",
  });
});

test("concurrent sockets share a stable principal admission window", () => {
  const hub = new Hub(snapshotDb);
  const principal = {
    kind: "human" as const,
    actorId: "user-shared",
    userId: "user-shared",
    userName: "Shared User",
    organizationId: "org-shared",
    organizationName: "Shared Org",
    role: "viewer" as const,
    deviceId: null,
    localBootstrap: false,
  };
  const first: Socket = { send: () => {} };
  const second: Socket = { send: () => {} };
  hub.addUiClient(first, { deviceId: null, principal, close: () => {} });
  hub.addUiClient(second, { deviceId: null, principal, close: () => {} });

  for (let revision = 1; revision <= MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW / 2; revision++) {
    assert.equal(hub.setUiSessionSubscriptions(first, revision, [], [], 2_000).ok, true);
    assert.equal(hub.setUiSessionSubscriptions(second, revision, [], [], 2_000).ok, true);
  }
  assert.deepEqual(
    hub.setUiSessionSubscriptions(first, MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW / 2 + 1, [], [], 2_000),
    { ok: false, reason: "rate_limited" },
  );
});

test("paired devices have independent subscription admission keys", () => {
  const hub = new Hub(snapshotDb);
  const first = addDeviceClient(hub, "dev-one");
  const second = addDeviceClient(hub, "dev-two");
  consumeSubscriptionAllowance(hub, first, 3_000);
  assert.equal(hub.setUiSessionSubscriptions(second, 1, [], [], 3_000).ok, true);
});

test("legacy clients without identity share the safe fallback admission key", () => {
  const hub = new Hub(snapshotDb);
  const first: Socket = { send: () => {} };
  const second: Socket = { send: () => {} };
  hub.addUiClient(first);
  hub.addUiClient(second);
  consumeSubscriptionAllowance(hub, first, 4_000);
  assert.deepEqual(hub.setUiSessionSubscriptions(second, 1, [], [], 4_000), {
    ok: false, reason: "rate_limited",
  });
});

test("idle subscription admission entries expire deterministically", () => {
  const hub = new Hub(snapshotDb);
  const first = addDeviceClient(hub, "dev-expiring");
  consumeSubscriptionAllowance(hub, first, 5_000);
  hub.removeUiClient(first);

  const replacement = addDeviceClient(hub, "dev-expiring");
  assert.equal(
    hub.setUiSessionSubscriptions(replacement, 1, [], [], 5_000 + UI_SUBSCRIPTION_ADMISSION_TTL_MS).ok,
    true,
  );
});

test("subscription admission uses deterministic LRU eviction at its hard key ceiling", () => {
  const hub = new Hub(snapshotDb, { uiSubscriptionAdmissionMaxKeys: 2 });
  const first = addDeviceClient(hub, "dev-lru-first");
  const oldest = addDeviceClient(hub, "dev-lru-oldest");
  consumeSubscriptionAllowance(hub, first, 6_000);
  consumeSubscriptionAllowance(hub, oldest, 6_001);
  assert.deepEqual(hub.setUiSessionSubscriptions(first, MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW + 1, [], [], 6_002), {
    ok: false, reason: "rate_limited",
  }, "a rejected access still makes the active caller most recently used");

  const newcomer = addDeviceClient(hub, "dev-lru-new");
  assert.equal(hub.setUiSessionSubscriptions(newcomer, 1, [], [], 6_003).ok, true);
  const oldestReplacement = addDeviceClient(hub, "dev-lru-oldest");
  assert.equal(
    hub.setUiSessionSubscriptions(oldestReplacement, 1, [], [], 6_004).ok,
    true,
    "the least recently used key was evicted and receives a fresh bounded window",
  );
});

test("reminder snapshots and live fan-out require exact owner and session access", () => {
  const reminder = (userId: string): SessionReminderView => ({
    reminderId: "reminder-" + userId,
    sessionId: "shared-session",
    scheduledFor: 10_000,
    timeZone: "UTC",
    originalExpression: userId,
    wakePolicy: "until_activity",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const db = {
    ...snapshotDb,
    listSessionReminders: (userId: string) => [reminder(userId)],
    canAccessSession: (principal: { organizationId: string }, sessionId: string) =>
      sessionId === "shared-session" && principal.organizationId !== "denied",
  } as unknown as ControlPlaneDb;
  const hub = new Hub(db);
  const messages = new Map<string, Array<Record<string, unknown>>>();
  const add = (name: string, userId?: string, organizationId = "allowed") => {
    const received: Array<Record<string, unknown>> = [];
    messages.set(name, received);
    const socket: Socket = { send: (data) => received.push(JSON.parse(data) as Record<string, unknown>) };
    hub.addUiClient(socket, {
      deviceId: name,
      ...(userId === undefined ? {} : {
        principal: { kind: "human" as const, organizationId, userId, deviceId: name },
      }),
      close: () => {},
    });
    return socket;
  };

  add("owner", "user-a");
  add("other-authorized-user", "user-b");
  add("owner-without-session-access", "user-a", "denied");
  add("local-owner");
  assert.deepEqual(
    [...messages].map(([name, received]) => [
      name,
      (received[0]?.reminders as SessionReminderView[] | undefined)?.map((item) => item.originalExpression),
    ]),
    [
      ["owner", ["user-a"]],
      ["other-authorized-user", ["user-b"]],
      ["owner-without-session-access", []],
      ["local-owner", [LOCAL_OWNER_USER_ID]],
    ],
    "reconnect snapshots remain exactly user-scoped and session-authorized",
  );
  for (const received of messages.values()) received.length = 0;

  hub.sessionReminderChanged("user-a", reminder("user-a"));
  assert.deepEqual(messages.get("owner")?.map((item) => item.type), ["session_reminder_upsert"]);
  assert.deepEqual(messages.get("other-authorized-user"), []);
  assert.deepEqual(messages.get("owner-without-session-access"), []);
  assert.deepEqual(messages.get("local-owner"), []);

  for (const received of messages.values()) received.length = 0;
  hub.sessionReminderRemoved("user-b", "shared-session");
  assert.deepEqual(messages.get("other-authorized-user")?.map((item) => item.type), ["session_reminder_removed"]);
  assert.deepEqual(messages.get("owner"), []);

  for (const received of messages.values()) received.length = 0;
  hub.sessionReminderChanged(LOCAL_OWNER_USER_ID, reminder(LOCAL_OWNER_USER_ID));
  assert.deepEqual(messages.get("local-owner")?.map((item) => item.type), ["session_reminder_upsert"]);
  assert.deepEqual(messages.get("owner"), []);
});

test("generic reminder fan-out fails closed without exact ownership", () => {
  const db = { ...snapshotDb, canAccessSession: () => true } as unknown as ControlPlaneDb;
  const hub = new Hub(db);
  const received: string[] = [];
  hub.addUiClient({ send: (data) => received.push(data) }, {
    deviceId: "owner",
    principal: { kind: "human", organizationId: "org", userId: "user-a", deviceId: "owner" },
    close: () => {},
  });
  received.length = 0;
  const unsafeBroadcast = hub as unknown as { broadcast(message: unknown): void };
  unsafeBroadcast.broadcast({
    type: "session_reminder_removed",
    sessionId: "shared-session",
  });
  assert.deepEqual(received, []);
});

test("unsubscribed high-volume events skip authorization database reads", () => {
  let authorizationReads = 0;
  const scopedDb = {
    listRunnersForPrincipal: () => [],
    listSessionsForPrincipal: () => [],
    listProjectsForPrincipal: () => [],
    listBoxes: () => [],
    listRuns: () => [],
    listPods: () => [],
    listSessionReminders: () => [],
    canAccessSession: () => { authorizationReads++; return true; },
  } as unknown as ControlPlaneDb;
  const hub = new Hub(scopedDb);
  const socket: Socket = { send: () => {} };
  hub.addUiClient(socket, {
    deviceId: "dev-1",
    principal: {
      kind: "human", actorId: "u1", userId: "u1", userName: "User",
      organizationId: "org-1", organizationName: "Org", role: "viewer", deviceId: "dev-1",
      localBootstrap: false,
    },
    close: () => {},
  });
  assert.equal(hub.setUiSessionSubscriptions(socket, 1, [], [], 1).ok, true);
  hub.sessionEvent(sessionEvent("not-selected", 1));
  assert.equal(authorizationReads, 0);
});

test("a slow UI client is evicted at a bounded queued-byte ceiling and cannot receive later deltas", () => {
  const hub = new Hub(snapshotDb);
  const sent: string[] = [];
  const closed: Array<[number | undefined, string | undefined]> = [];
  let bufferedAmount = 0;
  const socket: Socket = {
    send: (data) => sent.push(data),
    get bufferedAmount() { return bufferedAmount; },
  };
  hub.addUiClient(socket, {
    deviceId: null,
    close: (code, reason) => closed.push([code, reason]),
  });
  sent.length = 0;
  bufferedAmount = MAX_UI_BUFFERED_BYTES;

  hub.boxRemoved("box-slow");
  assert.deepEqual(closed, [[1013, "client is too slow; reconnect for fresh state"]]);
  assert.equal(sent.length, 0);
  bufferedAmount = 0;
  hub.boxRemoved("box-after-eviction");
  assert.equal(sent.length, 0, "eviction removes the socket from future fan-out");
  assert.deepEqual(hub.setUiSessionSubscriptions(socket, 1, ["session-a"], []), {
    ok: false, reason: "client_missing",
  });
});

test("one oversized UI frame is evicted before socket.send can retain it", () => {
  const hub = new Hub(snapshotDb);
  const sent: string[] = [];
  const closed: number[] = [];
  const socket: Socket = { send: (data) => sent.push(data) };
  hub.addUiClient(socket, { deviceId: null, close: (code) => closed.push(code ?? 0) });
  sent.length = 0;
  hub.shellOutput("session-a", "shell-a", "stdout", "x".repeat(MAX_UI_BUFFERED_BYTES));
  assert.deepEqual(closed, [1013]);
  assert.deepEqual(sent, [], "the over-limit frame never reaches the WebSocket implementation");
});

test("an asynchronous UI send error evicts with 1011 exactly once", () => {
  const hub = new Hub(snapshotDb);
  const completions: Array<(error?: Error) => void> = [];
  const closed: number[] = [];
  const socket: Socket = {
    asyncDelivery: true,
    send: (_data, complete) => { if (complete) completions.push(complete); },
  };
  hub.addUiClient(socket, { deviceId: null, close: (code) => closed.push(code ?? 0) });
  completions.shift()!(new Error("write failed"));
  assert.deepEqual(closed, [1011]);
  hub.boxRemoved("after-error");
  assert.deepEqual(closed, [1011]);
});

test("normal UI removal releases queued payloads even when the in-flight callback never arrives", () => {
  const hub = new Hub(snapshotDb);
  const completions: Array<(error?: Error) => void> = [];
  const sent: string[] = [];
  const socket: Socket = {
    asyncDelivery: true,
    send: (data, complete) => {
      sent.push(data);
      if (complete) completions.push(complete);
    },
  };
  const info = { deviceId: null, close: () => {} };
  const state = info as typeof info & { outbound?: unknown[]; queuedBytes?: number; sending?: boolean };
  hub.addUiClient(socket, info);
  hub.sessionEvent(sessionEvent("session-a", 1));
  hub.sessionEvent(sessionEvent("session-a", 2));
  assert.equal(state.sending, true);
  assert.equal(state.outbound?.length, 2);
  assert.ok((state.queuedBytes ?? 0) > 0);

  hub.removeUiClient(socket);
  assert.equal(state.sending, false);
  assert.deepEqual(state.outbound, []);
  assert.equal(state.queuedBytes, 0);
  completions.shift()!();
  const sentBefore = sent.length;
  hub.sessionEvent(sessionEvent("session-a", 3));
  assert.equal(sent.length, sentBefore, "a late callback cannot restart a removed writer");
});

test("a synchronous UI send throw evicts with 1011 exactly once", () => {
  const hub = new Hub(snapshotDb);
  const closed: number[] = [];
  const socket: Socket = { send: () => { throw new Error("closed socket"); } };
  hub.addUiClient(socket, { deviceId: null, close: (code) => closed.push(code ?? 0) });
  assert.deepEqual(closed, [1011]);
  hub.boxRemoved("after-throw");
  assert.deepEqual(closed, [1011]);
});

test("the UI writer serializes sends, coalesces interleaved replaceable upserts, and preserves events", () => {
  const hub = new Hub(snapshotDb);
  const sent: string[] = [];
  const completions: Array<(error?: Error) => void> = [];
  const socket: Socket = {
    asyncDelivery: true,
    send: (data, complete) => {
      sent.push(data);
      if (complete) completions.push(complete);
    },
  };
  hub.addUiClient(socket);
  const session = (updatedAt: number) => ({ id: "session-a", updatedAt } as SessionView);
  hub.sessionEvent(sessionEvent("session-a", 1));
  hub.sessionChanged(session(1));
  hub.sessionEvent(sessionEvent("session-a", 2));
  hub.sessionChanged(session(2));
  assert.equal(sent.length, 1, "the initial snapshot remains the sole in-flight frame");

  completions.shift()!();
  assert.equal(sent.length, 2);
  assert.equal(JSON.parse(sent[1]!).event.id, 1);
  completions.shift()!();
  assert.equal(JSON.parse(sent[2]!).event.id, 2, "durable events retain exact order and are never coalesced");
  completions.shift()!();
  assert.equal(JSON.parse(sent[3]!).session.updatedAt, 2, "interleaved upserts collapsed after the lossless events");
  completions.shift()!();
  assert.equal(completions.length, 0);
});

test("replacing a queued upsert subtracts its bytes before enforcing the hard ceiling", () => {
  const hub = new Hub(snapshotDb);
  const closed: number[] = [];
  const socket: Socket = { asyncDelivery: true, send: () => {} };
  hub.addUiClient(socket, { deviceId: null, close: (code) => closed.push(code ?? 0) });
  hub.sessionChanged({ id: "session-a", preview: "x".repeat(6 * 1024 * 1024) } as SessionView);
  hub.sessionChanged({ id: "session-a", preview: "small" } as SessionView);
  hub.shellOutput("session-a", "shell-a", "stdout", "y".repeat(2 * 1024 * 1024));
  assert.deepEqual(closed, [], "the replaced six-megabyte frame no longer counts against the queue");
});

test("queued bytes remain bounded while the in-flight send callback is delayed", () => {
  const hub = new Hub(snapshotDb);
  const closed: number[] = [];
  const socket: Socket = { asyncDelivery: true, send: () => {} };
  hub.addUiClient(socket, { deviceId: null, close: (code) => closed.push(code ?? 0) });
  hub.shellOutput("session-a", "shell-a", "stdout", "x".repeat(4 * 1024 * 1024));
  assert.deepEqual(closed, [], "one queued chunk remains below the byte ceiling");
  hub.shellOutput("session-a", "shell-a", "stdout", "y".repeat(4 * 1024 * 1024));
  assert.deepEqual(closed, [1013], "the second chunk accounts for the first while delivery is stalled");
});

test("a stalled UI writer has a hard message ceiling and is closed exactly once", () => {
  const hub = new Hub(snapshotDb);
  const closed: number[] = [];
  const socket: Socket = {
    asyncDelivery: true,
    send: () => {},
  };
  hub.addUiClient(socket, { deviceId: null, close: (code) => closed.push(code ?? 0) });
  for (let i = 0; i <= MAX_UI_QUEUED_MESSAGES; i++) hub.sessionEvent(sessionEvent("session-a", i + 1));
  assert.deepEqual(closed, [1013]);
  hub.sessionEvent(sessionEvent("session-a", MAX_UI_QUEUED_MESSAGES + 2));
  assert.deepEqual(closed, [1013], "later fan-out cannot close an already-evicted client again");
});

test("a stale socket detach is a no-op: reconnect replacement survives and reports it", () => {
  let replacementClose: [number | undefined, string | undefined] | null = null;
  const oldSock: Socket = { send: () => {}, close: (code, reason) => { replacementClose = [code, reason]; } };
  const newSock: Socket = { send: () => {} };
  const hub = new Hub(fakeDb);
  hub.attachRunner("r1", oldSock);
  hub.attachRunner("r1", newSock); // reconnect replaced the socket before the old close fired
  assert.deepEqual(replacementClose, [1008, "runner credential replaced"]);

  assert.equal(hub.detachRunner("r1", oldSock), false, "stale detach must report non-current");
  assert.equal(hub.isRunnerOnline("r1"), true, "replacement connection stays attached");
  assert.equal(hub.isCurrentRunnerSocket("r1", newSock), true);
  assert.equal(hub.isCurrentRunnerSocket("r1", oldSock), false);

  assert.equal(hub.detachRunner("r1", newSock), true, "current-socket detach reports true");
  assert.equal(hub.isRunnerOnline("r1"), false);
});

test("closeRunner preserves current identity until the shared close teardown runs", async () => {
  const closed: Array<[number | undefined, string | undefined]> = [];
  const hub = new Hub(fakeDb);
  let teardowns = 0;
  let socket!: Socket;
  socket = {
    send: () => {},
    close: (code, reason) => {
      closed.push([code, reason]);
      // Faithfully model index.ts onGone: only a current-socket detach may run durable teardown.
      if (hub.detachRunner("r1", socket)) teardowns += 1;
    },
  };
  hub.attachRunner("r1", socket);
  const pending = hub.requestFromRunner("r1", "req-revoked", gitReq("req-revoked"), 30_000);

  assert.equal(hub.closeRunner("r1"), true);
  assert.equal(hub.isRunnerOnline("r1"), false);
  assert.deepEqual(closed, [[1008, "runner credential revoked"]]);
  assert.equal(teardowns, 1, "the close must reach the ordinary current-socket teardown exactly once");
  await assert.rejects(() => pending, /disconnected/);
  assert.equal(hub.detachRunner("r1", socket), false, "a duplicate close/error event is stale");
  assert.equal(hub.closeRunner("r1"), false);
});

test("sendToRunner failure closes through the shared current-socket teardown", async () => {
  const closed: Array<[number | undefined, string | undefined]> = [];
  const hub = new Hub(fakeDb);
  let teardowns = 0;
  let socket!: Socket;
  socket = {
    send: () => { throw new Error("serialize or transport failure"); },
    close: (code, reason) => {
      closed.push([code, reason]);
      // Faithfully model index.ts onGone: durable teardown only runs for the current socket.
      if (hub.detachRunner("r1", socket)) teardowns += 1;
    },
  };
  hub.attachRunner("r1", socket);

  const pending = hub.requestFromRunner("r1", "req-send-failed", gitReq("req-send-failed"), 30_000);

  assert.equal(await pending.then(() => true, () => false), false);
  assert.deepEqual(closed, [[1011, "runner send failed"]]);
  assert.equal(teardowns, 1, "send failure must reach ordinary disconnect cleanup exactly once");
  assert.equal(hub.isRunnerOnline("r1"), false);
  assert.equal(hub.detachRunner("r1", socket), false, "a later close/error event is stale");
});

test("sendToRunner failure terminates a runner socket that has no graceful close", () => {
  const hub = new Hub(fakeDb);
  let terminated = 0;
  const socket: Socket = {
    send: () => { throw new Error("send failed"); },
    terminate: () => { terminated += 1; },
  };
  hub.attachRunner("r1", socket);

  assert.equal(hub.sendToRunner("r1", { type: "rediscover", runnerId: "r1" }), false);
  assert.equal(terminated, 1);
  assert.equal(hub.isCurrentRunnerSocket("r1", socket), true,
    "identity stays current until terminate emits the ordinary close event");
  assert.equal(hub.detachRunner("r1", socket), true);
});

test("a stale socket detach does not reject in-flight requests riding the replacement", async () => {
  const oldSock: Socket = { send: () => {} };
  const newSock: Socket = { send: () => {} };
  const hub = new Hub(fakeDb);
  hub.attachRunner("r1", oldSock);
  hub.attachRunner("r1", newSock);

  const p = hub.requestFromRunner("r1", "req-live", gitReq("req-live"), 5000);
  hub.detachRunner("r1", oldSock); // stale close — must NOT kill the request
  hub.resolveRunnerRequest({ type: "git_result", requestId: "req-live", ok: true, data: {} });
  assert.equal((await p).ok, true);
});
