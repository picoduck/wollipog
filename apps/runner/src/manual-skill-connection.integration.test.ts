import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import {
  PROTOCOL_VERSION, parseMessage, runnerSupportsProtocol,
  type PendingSkillReportRequest, type RegisteredMessage, type SkillsStateMessage,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "../../control-plane/src/db.js";
import { Hub, type Socket } from "../../control-plane/src/hub.js";
import { SkillStateReporter } from "./skill-state-reporter.js";
import type { ReconcileSkillsResult } from "./skills.js";

const runnerSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../../control-plane/src/index.ts", import.meta.url), "utf8");
const empty = (): ReconcileSkillsResult => ({ deployed: [], unmanaged: [], removedLinks: [] });
const observed = (): ReconcileSkillsResult => ({ ...empty(), deployed: [{ name: "current", digest: "a".repeat(64), links: [] }] });
const partial = (): ReconcileSkillsResult => ({ ...empty(), superseded: true, error: "Fixture supersession" });

/** Execute pinned production slices without starting a daemon, provider, or network service. */
function install(source: string, scope: Record<string, unknown>): void {
  runInNewContext(transformSync(source, { loader: "ts" }).code, scope);
}
function slice(source: string, start: string, end: string): string {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing production slice: ${start}`);
  return source.slice(from, to);
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000 });
  let elapsed = 0;
  const db = ControlPlaneDb.open(":memory:");
  for (const runnerId of ["fixture", "other"]) db.registerRunner({
    runnerId, hostname: "fixture", os: "linux", version: "fixture", agents: [], workspaces: [],
  }, Date.now(), PROTOCOL_VERSION);
  // Deliberately unrelated epochs: only within-process elapsed time is compared.
  const hub = new Hub(db, { skillRequestNow: () => 70 + elapsed });
  const messages: SkillsStateMessage[] = [], commands: string[] = [], logs: string[] = [];
  const sockets: InertSocket[] = [];
  let reconnects = 0, heartbeatStops = 0, forgotten = 0, persisted = 0;
  const originalPersist = db.setRunnerSkillState.bind(db);
  t.mock.method(db, "setRunnerSkillState", (...args: Parameters<typeof db.setRunnerSkillState>) => {
    persisted++; return originalPersist(...args);
  });
  class InertSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    failSend = false;
    readonly server: Socket = { send: data => this.emit("message", Buffer.from(data)), close() {} };
    constructor(_url: string) { super(); sockets.push(this); }
    send(data: string) {
      if (this.failSend) throw new Error("Fixture handoff refused");
      const message = JSON.parse(data);
      if (message.type === "register") return;
      messages.push(message);
      const receiveScope = { hub, db, runnerId: "fixture", runnerClient: this.server, runnerSupportsProtocol,
        Date, app: { log: { warn() {} } } };
      const guard = serverSource.split("\n").find(line => line.includes('if (msg.type !== "register" && (!runnerId || !hub.isCurrentRunnerSocket'))!;
      assert.ok(guard);
      install(`function receive(msg) { ${guard}\n switch (msg.type) { ${slice(serverSource,
        '      case "skills_state": {', '      case "skill_snapshot_result":')} } }`, receiveScope);
      (receiveScope as typeof receiveScope & { receive: (message: SkillsStateMessage) => void }).receive(message);
    }
  }
  const scope: Record<string, any> = {
    ws: null, registered: true, controlPlaneProtocolVersion: PROTOCOL_VERSION,
    automaticAccountSwitchConfigurationSynchronized: true,
    heartbeatPongObserved: false, missedHeartbeatPongs: 3,
    sessions: { setAutomaticAccountSwitchAuthorityReady() {}, liveSessionIds: () => [] },
    chunkedSkillsSync: { reset() {} },
    config: { runnerId: "fixture", controlPlaneUrl: "inert", token: "", providerAccounts: [] }, metadata: { agents: [] },
    WebSocket: InertSocket, validateControlPlaneUrl: (url: string) => url, allowInsecureTransport: false,
    agentsForControlPlane: () => [], providerAccountsForControlPlane: () => [], registrationSessionSnapshots: () => [],
    PROTOCOL_VERSION, parseMessage, runnerSupportsProtocol,
    projectMessageForCurrentProtocol: (message: SkillsStateMessage) => message,
    stagedRunnerCredential: { promote() {} }, backoff: 99, INITIAL_BACKOFF_MS: 1,
    log: (message: string) => logs.push(message), errText: (error: Error) => error.message,
    stopHeartbeat: () => { heartbeatStops++; }, forgetAgentControlRegistrationAnswers: () => { forgotten++; },
    scheduleReconnect: () => { reconnects++; },
  };
  install(slice(runnerSource, "function sendSkillState(", "const skillStateReporter ="), scope);
  const reporter = new SkillStateReporter("fixture", scope.sendSkillState, scope.log, () => 1_000_000 + elapsed);
  scope.skillStateReporter = reporter;
  const registrationPrefix = slice(runnerSource, '    case "registered":', "      harnessInstallationChoices =");
  install(`function applyRegistered(msg) { switch(msg.type) { ${registrationPrefix} break; } }`, scope);
  scope.handleCommand = (message: { type: string; requestId?: string }) => {
    commands.push(message.type);
    if (message.type === "registered") scope.applyRegistered(message);
    if (message.type === "skills_sync") reporter.request(message.requestId);
  };
  install(slice(runnerSource, "function connect():", "function shutdown("), scope);
  function register(socket: InertSocket, protocolVersion = PROTOCOL_VERSION): RegisteredMessage {
    hub.attachRunner("fixture", socket.server);
    const registeredScope: Record<string, any> = {
      hub, db, runnerId: "fixture", msg: { protocolVersion }, socket, Date, PROTOCOL_VERSION,
      HEARTBEAT_INTERVAL_MS: 1, runnerSupportsProtocol, automaticAccountSwitchForRunner: () => undefined,
      send: (_socket: unknown, message: RegisteredMessage) => { registeredScope.result = message; },
    };
    const marker = serverSource.indexOf('          type: "registered",');
    const from = serverSource.lastIndexOf("        send(socket, {", marker);
    const to = serverSource.indexOf("        hub.syncProjectMemory", marker);
    assert.ok(from >= 0 && to > from);
    install(serverSource.slice(from, to), registeredScope);
    return registeredScope.result;
  }
  function start(deliver = true, version = PROTOCOL_VERSION) {
    scope.connect();
    const socket = sockets.at(-1)!;
    socket.emit("open");
    const response = register(socket, version);
    if (deliver) socket.emit("message", Buffer.from(JSON.stringify(response)));
    return { socket, response };
  }
  const initial = start();
  function request(id = "R", timeoutMs = 30_000, runnerId = "fixture") {
    const pending = hub.requestFromRunner(runnerId, id, { type: "skills_sync", runnerId, requestId: id, skills: [] }, timeoutMs);
    return pending.then(result => ({ result, error: undefined }), error => ({ result: undefined, error: error as Error }));
  }
  t.after(() => {
    for (const socket of sockets) hub.detachRunner("fixture", socket.server);
    reporter.resetRequests(); db.close();
  });
  return { db, hub, reporter, scope, messages, logs, commands, initial, sockets, register, start, request,
    counts: () => ({ reconnects, heartbeatStops, forgotten, persisted }),
    advance(ms: number) { elapsed += ms; t.mock.timers.tick(ms); },
  };
}

for (const result of [observed(), { ...empty(), error: "Fixture current error" }, empty()]) {
  test(`replacement resumption settles exactly once with current ${result.error ? "error" : result.deployed.length ? "inventory" : "empty"}`, async t => {
    const f = fixture(t);
    f.reporter.report(observed());
    const pending = f.request();
    const old = f.reporter.request("R"), oldGeneration = f.reporter.connectionGeneration;
    f.advance(10_000);
    const b = f.start();
    assert.deepEqual(b.response.pendingSkillRequests, [{ requestId: "R", remainingMs: 20_000 }]);
    assert.equal(f.hub.detachRunner("fixture", f.initial.socket.server), false);
    f.initial.socket.emit("close");
    assert.equal(f.counts().reconnects, 0);
    f.reporter.report({ ...observed(), removedLinks: [{ path: "old", reason: "Old result" }] }, old, true, oldGeneration);
    assert.equal(f.messages.length, 1, "obsolete result cannot persist or settle");
    f.reporter.report(partial(), f.reporter.request("R"));
    assert.equal(f.messages.at(-1)!.requestId, undefined, "cached partial cannot answer resumed R");
    f.reporter.report(result);
    const settled = await pending;
    assert.equal(settled.error, undefined);
    assert.equal(settled.result!.type, "skills_state");
    assert.deepEqual(f.db.getRunnerSkillState("fixture")!.deployed, result.deployed);
    assert.equal(f.db.getRunnerSkillState("fixture")!.error, result.error);
    assert.equal(f.messages.filter(message => message.requestId === "R").length, 1);
    f.reporter.resumeRequests(b.response.pendingSkillRequests);
    f.reporter.report(empty());
    assert.equal(f.messages.filter(message => message.requestId === "R").length, 1);
    f.advance(30_000);
    assert.deepEqual(f.hub.pendingSkillRequests("fixture"), []);
  });
}

test("genuine disconnect and server lifetime loss provide no resume authority", async t => {
  const f = fixture(t), pending = f.request();
  assert.equal(f.hub.detachRunner("fixture", f.initial.socket.server), true);
  f.initial.socket.emit("close");
  assert.match((await pending).error!.message, /disconnected/);
  const b = f.start();
  assert.deepEqual(b.response.pendingSkillRequests, []);
  f.reporter.report(observed());
  assert.equal(f.messages.at(-1)!.requestId, undefined);
  assert.equal(f.counts().reconnects, 1);
  const current = f.request("server-lost");
  const newHub = new Hub(f.db, { skillRequestNow: () => 5 });
  newHub.attachRunner("fixture", b.socket.server);
  f.reporter.beginConnection(); f.reporter.resumeRequests(newHub.pendingSkillRequests("fixture"));
  f.reporter.report(empty());
  assert.equal(f.messages.at(-1)!.requestId, undefined);
  f.advance(30_000); assert.equal((await current).error!.name, "RunnerRequestTimeoutError");
  newHub.detachRunner("fixture", b.socket.server);
});

test("old socket callbacks and replies cannot change replacement state or persist inventory", async t => {
  const f = fixture(t), pending = f.request(), b = f.start();
  const before = f.counts(), commands = f.commands.length;
  f.initial.socket.emit("open");
  f.initial.socket.emit("message", Buffer.from(JSON.stringify({ type: "registered", protocolVersion: 1 })));
  f.initial.socket.emit("pong"); f.initial.socket.emit("error", new Error("Fixture stale socket"));
  f.initial.socket.emit("close");
  f.initial.socket.send(JSON.stringify({ type: "skills_state", runnerId: "fixture", requestId: "R", deployed: [], unmanaged: [] }));
  assert.deepEqual(f.counts(), before); assert.equal(f.commands.length, commands);
  assert.equal(f.scope.ws, b.socket); assert.equal(f.scope.registered, true);
  assert.equal(f.scope.heartbeatPongObserved, false); assert.equal(f.scope.missedHeartbeatPongs, 3);
  f.reporter.report(observed()); assert.equal((await pending).error, undefined);
});

test("delayed registration charges elapsed time, retains chunk inactivity semantics, and ignores wall clock jumps", async t => {
  const f = fixture(t), pending = f.request();
  f.advance(10_000);
  const b = f.start(false);
  assert.equal(b.response.pendingSkillRequests![0]!.remainingMs, 20_000);
  assert.equal(f.reporter.request("R"), undefined, "inactive candidate is not authority");
  f.advance(19_999);
  t.mock.timers.setTime(1_000_000_000_000);
  b.socket.emit("message", Buffer.from(JSON.stringify(b.response)));
  assert.equal(f.reporter.request("R")!.expiresAt, 1_030_000);
  t.mock.timers.setTime(1);
  assert.equal(f.hub.refreshRunnerRequestTimeout("fixture", "R", 30_000), true);
  f.advance(1);
  assert.deepEqual(f.hub.pendingSkillRequests("fixture"), [], "refresh cannot resurrect admission projection");
  f.reporter.report(observed());
  assert.equal(f.messages.at(-1)!.requestId, undefined, "delayed receipt cannot extend earliest expiry");
  // Ordinary Hub chunk inactivity behavior remains independent and resolves an actual result.
  assert.equal(f.hub.resolveRunnerRequest({ type: "skills_state", runnerId: "fixture", requestId: "R", deployed: [], unmanaged: [] }, "fixture"), true);
  assert.equal((await pending).error, undefined);
});

test("repeat registration and reconnect duplicates never extend or resurrect earliest admission", async t => {
  const f = fixture(t), pending = f.request();
  f.advance(5_000); const b = f.start();
  const ticket = f.reporter.request("R")!;
  f.advance(5_000);
  assert.equal(f.reporter.request("R"), ticket);
  const fresh = f.request("new");
  f.reporter.resumeRequests([]);
  assert.ok(f.reporter.request("new"), "repeat authority cannot clear current admissions");
  const c = f.start();
  assert.equal(f.reporter.request("R")!.expiresAt, ticket.expiresAt);
  assert.equal(f.hub.detachRunner("fixture", b.socket.server), false);
  f.reporter.report(empty());
  assert.equal((await pending).error, undefined); assert.equal((await fresh).error, undefined);
  c.socket.emit("message", Buffer.from(JSON.stringify(c.response)));
  f.reporter.report(empty());
  assert.equal(f.messages.filter(message => message.requestId === "R").length, 1);
});

test("cold inventory preserves only current removals once and failed handoff retains admission", async t => {
  const f = fixture(t), pending = f.request();
  f.reporter.report({ ...partial(), removedLinks: [{ path: "old", reason: "Old generation" }] }, f.reporter.request("R"));
  const b = f.start();
  f.reporter.report(partial()); assert.equal(f.counts().persisted, 0);
  const current = { ...observed(), removedLinks: [{ path: "new", reason: "Current removal" }] };
  b.socket.failSend = true;
  assert.throws(() => f.reporter.report(current), /handoff refused/);
  assert.equal(f.counts().persisted, 0); assert.equal(f.messages.length, 0);
  b.socket.failSend = false;
  f.reporter.report(observed()); assert.equal((await pending).error, undefined);
  f.reporter.report(partial()); f.reporter.report(empty());
  assert.deepEqual(f.messages.flatMap(message => message.removals ?? []), current.removedLinks);
  f.scope.registered = false;
  assert.throws(() => f.scope.sendSkillState({ type: "skills_state" }), /not registered/);
  assert.equal(f.messages.length, 3, "unavailable publication never enters an outbox");
});

test("evicted and unknown local IDs cannot resume; Hub projection and deferred queue stay bounded", async t => {
  const f = fixture(t);
  const pending = Array.from({ length: 65 }, (_, i) => f.request(`R${i}`));
  assert.equal(f.hub.pendingSkillRequests("fixture").length, 64);
  f.start();
  f.reporter.report(observed());
  assert.equal(f.messages.length, 63, "intersection omits evicted R0 and unprojected R64");
  assert.ok(f.messages.every(message => message.requestId !== "R0" && message.requestId !== "R64"));
  f.advance(30_000);
  const outcomes = await Promise.all(pending);
  assert.equal(outcomes.filter(outcome => outcome.error).length, 2);
  const cold = new SkillStateReporter("fixture", message => assert.equal(message.requestId, undefined, "No process-lost authority"), () => {}, () => 0);
  cold.beginConnection(); cold.resumeRequests([{ requestId: "R", remainingMs: 30_000 }]);
  cold.report(empty()); cold.resetRequests();
});

for (const malformed of [
  undefined, null, {}, [null], [{ requestId: "", remainingMs: 1 }], [{ requestId: "R\n", remainingMs: 1 }],
  [{ requestId: "x".repeat(1025), remainingMs: 1 }], [{ requestId: 1, remainingMs: 1 }],
  ...[NaN, Infinity, -1, 0, 30_001, "100"].map(remainingMs => [{ requestId: "R", remainingMs }]),
  [{ requestId: "R", remainingMs: 1 }, { requestId: "R", remainingMs: 2 }],
  Array.from({ length: 65 }, (_, i) => ({ requestId: `R${i}`, remainingMs: 1 })),
]) test(`malformed registration authority fails closed: ${JSON.stringify(malformed)?.slice(0, 80)}`, async t => {
  const f = fixture(t), pending = f.request();
  const b = f.start(false);
  f.scope.applyRegistered({ ...b.response, pendingSkillRequests: malformed as PendingSkillReportRequest[] });
  f.reporter.report(empty()); assert.equal(f.messages.at(-1)!.requestId, undefined);
  f.advance(30_000); assert.equal((await pending).error!.name, "RunnerRequestTimeoutError");
});

test("older peers omit/ignore authority; cancelled/resolved/wrong-owner/non-skill requests are excluded", async t => {
  const f = fixture(t), pending = f.request();
  const old = f.start(true, 208);
  assert.equal(old.response.pendingSkillRequests, undefined);
  f.reporter.report(empty()); assert.equal(f.messages.at(-1)!.requestId, undefined);
  f.advance(30_000); assert.equal((await pending).error!.name, "RunnerRequestTimeoutError");
  const cancelled = f.request("cancelled"); f.hub.cancelRunnerRequest("fixture", "cancelled");
  assert.ok((await cancelled).error);
  const otherSocket = { send() {} }; f.hub.attachRunner("other", otherSocket);
  const other = f.request("owner", 30_000, "other");
  const nonSkill = f.hub.requestFromRunner("fixture", "git", { type: "git_action", requestId: "git", sessionId: "fixture", worktreePath: "inert", action: { kind: "status" } });
  const nonSkillOutcome = nonSkill.catch(error => error);
  assert.deepEqual(f.hub.pendingSkillRequests("fixture"), []);
  assert.equal(f.hub.resolveRunnerRequest({ type: "skills_state", runnerId: "fixture", requestId: "owner", deployed: [], unmanaged: [] }, "fixture"), false);
  f.hub.cancelRunnerRequest("fixture", "git"); await nonSkillOutcome;
  f.hub.detachRunner("other", otherSocket); assert.ok((await other).error);
});

test("reporter retains exactly one expiry timer through duplicates and replacement", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const realSet = setTimeout, realClear = clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => {
    const timer = realSet(() => { timers.delete(timer); callback(); }, ms);
    timers.add(timer); return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: ReturnType<typeof setTimeout>) => { timers.delete(timer); realClear(timer); });
  let now = 0;
  const reporter = new SkillStateReporter("fixture", () => {}, () => {}, () => now);
  reporter.request("R"); assert.equal(timers.size, 1);
  now = 1_000; t.mock.timers.tick(1_000);
  reporter.request("R"); reporter.beginConnection(); assert.equal(timers.size, 1);
  reporter.resumeRequests([{ requestId: "R", remainingMs: 29_000 }]); assert.equal(timers.size, 1);
  reporter.resumeRequests([]); assert.equal(timers.size, 1);
  now = 30_000; t.mock.timers.tick(29_000); assert.equal(timers.size, 0);
  reporter.resetRequests(); assert.equal(timers.size, 0);
});

test("late local admission and delayed registration cannot recover an expired server admission after inactivity refresh", async t => {
  const f = fixture(t), buffered: string[] = [];
  const deliver = f.initial.socket.server.send;
  f.initial.socket.server.send = data => { buffered.push(data); };
  const pending = f.request();
  f.advance(5_000);
  f.initial.socket.server.send = deliver;
  for (const data of buffered) deliver(data);
  assert.equal(f.reporter.request("R")!.expiresAt, 1_035_000, "local ticket was admitted later than Hub request");
  f.advance(5_000); const b = f.start(false);
  f.advance(19_999);
  f.hub.refreshRunnerRequestTimeout("fixture", "R", 30_000);
  f.advance(4_001);
  assert.deepEqual(f.hub.pendingSkillRequests("fixture"), []);
  b.socket.emit("message", Buffer.from(JSON.stringify(b.response)));
  f.reporter.report(empty());
  assert.equal(f.messages.at(-1)!.requestId, undefined, "receipt+remaining would wrongly extend to 54000ms");
  f.advance(30_000); assert.equal((await pending).error!.name, "RunnerRequestTimeoutError");
});

test("Hub duplicate waiters and reporter duplicates preserve the earliest admission and settle once", async t => {
  const f = fixture(t), first = f.request(), ticket = f.reporter.request("R")!;
  f.advance(10_000); const duplicate = f.request();
  assert.equal(f.reporter.request("R"), ticket);
  const b = f.start();
  assert.equal(b.response.pendingSkillRequests![0]!.remainingMs, 20_000);
  f.reporter.report(empty());
  assert.equal((await first).error, undefined); assert.equal((await duplicate).error, undefined);
  assert.equal(f.messages.filter(message => message.requestId === "R").length, 1);
});

test("ordinary manual success and current error resolve accurately through production persistence", async t => {
  const f = fixture(t);
  for (const result of [observed(), { ...empty(), error: "Fixture current error" }]) {
    const id = result.error ? "error" : "success", pending = f.request(id);
    f.reporter.report(result, f.reporter.request(id));
    const answer = await pending;
    assert.equal(answer.error, undefined);
    assert.equal(answer.result!.type, "skills_state");
    assert.equal((answer.result as SkillsStateMessage).error, result.error);
    assert.equal(f.db.getRunnerSkillState("fixture")!.error, result.error);
  }
});

test("valid unknown authority is ignored and older server authority is never adopted", async t => {
  const f = fixture(t), pending = f.request();
  const b = f.start(false);
  f.scope.applyRegistered({ ...b.response, pendingSkillRequests: [...b.response.pendingSkillRequests!, { requestId: "unknown", remainingMs: 20_000 }] });
  f.reporter.report(empty()); assert.equal((await pending).error, undefined);
  assert.deepEqual(f.messages.map(message => message.requestId), ["R"]);
  const oldServerPending = f.request("old-server"), c = f.start(false);
  f.scope.applyRegistered({ ...c.response, protocolVersion: 208 });
  f.reporter.report(empty()); assert.equal(f.messages.at(-1)!.requestId, undefined);
  f.advance(30_000); assert.equal((await oldServerPending).error!.name, "RunnerRequestTimeoutError");
});

for (const replacement of [false, true]) test(`failed current handoff ${replacement ? "discards old-generation" : "retains bounded same-generation"} removal evidence for a fresh result`, async t => {
  const f = fixture(t), pending = f.request(), b = f.start();
  const removedLinks = Array.from({ length: 300 }, (_, i) => ({ path: `~/skills/removed-${i}`, reason: "Current fixture removal" }));
  const expected = replacement ? [] : removedLinks.slice(0, 256);
  b.socket.failSend = true;
  assert.throws(() => f.reporter.report({ ...observed(), removedLinks }), /handoff refused/);
  b.socket.failSend = false;
  if (replacement) f.start();
  // Production's next reconciliation produces a fresh result: the link was already removed.
  f.reporter.report(empty());
  assert.equal((await pending).error, undefined);
  assert.deepEqual(f.messages.flatMap(message => message.removals ?? []), expected);
  assert.deepEqual(f.db.getRunnerSkillState("fixture")!.removals, expected);
  f.reporter.report(empty());
  assert.deepEqual(f.messages.flatMap(message => message.removals ?? []), expected);
});
