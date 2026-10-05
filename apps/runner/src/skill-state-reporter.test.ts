import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { PROTOCOL_VERSION, runnerSupportsProtocol, type AgentDefinition, type SkillsStateMessage } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { ControlPlaneDb } from "../../control-plane/src/db.js";
import { Hub } from "../../control-plane/src/hub.js";
import { skillReconciliationProviderAccountPlan } from "./provider-accounts.js";
import { SkillStateReporter } from "./skill-state-reporter.js";
import * as skills from "./skills.js";
import { ChunkedSkillsSyncAssembler } from "./skills-sync.js";
import { mergeWslSkillsResult } from "./wsl-skills.js";

const empty = (): skills.ReconcileSkillsResult => ({ deployed: [], unmanaged: [], removedLinks: [] });
const superseded = (): skills.ReconcileSkillsResult => ({ ...empty(), superseded: true, error: "Fixture supersession" });

function reporterFixture() {
  const messages: SkillsStateMessage[] = [];
  const logs: string[] = [];
  let clock = 0;
  const reporter = new SkillStateReporter("fixture", message => messages.push(message), message => logs.push(message), () => clock);
  return { reporter, messages, logs, advance: (ms: number) => { clock += ms; } };
}

test("stale reports retain immutable scoped inventory/evidence/errors without replaying cached removals", () => {
  const f = reporterFixture();
  const observed: skills.ReconcileSkillsResult = {
    ...empty(),
    deployed: [{ name: "alpha", digest: "a".repeat(64), providerAccountId: "old-account", links: [] }],
    unmanaged: [{ name: "local", agentId: "fixture", providerAccountId: "old-account" }],
    drift: [{ name: "alpha", digest: "a".repeat(64), variant: "agent", held: true, observedDigest: "b".repeat(64) }],
    keptAside: [{ id: "00000000-0000-4000-8000-000000000001", name: "alpha", keptAsideAt: 1 }], keptAsideOmitted: 3,
    removedLinks: [{ path: "skills/old", reason: "Fixture removal", providerAccountId: "old-account" }],
    error: "Prior current observation error",
  };
  f.reporter.report(observed);
  const evidence = structuredClone({ drift: observed.drift, keptAside: observed.keptAside });
  observed.deployed[0]!.providerAccountId = "substituted";
  f.messages[0]!.deployed[0]!.name = "transport-mutated";
  f.reporter.report(superseded(), f.reporter.request("stale"));
  const stale = f.messages.at(-1)!;
  assert.equal(stale.deployed[0]!.name, "alpha");
  assert.equal(stale.deployed[0]!.providerAccountId, "old-account");
  assert.equal(stale.unmanaged[0]!.providerAccountId, "old-account");
  assert.deepEqual(stale.drift, evidence.drift);
  assert.deepEqual(stale.keptAside, evidence.keptAside);
  assert.equal(stale.keptAsideOmitted, 3);
  assert.deepEqual(stale.removals, []);
  assert.equal(stale.requestId, "stale");
  assert.match(stale.error!, /stale.*superseded/);
  assert.match(stale.error!, /Prior current observation error/);
  f.reporter.report({ ...superseded(), error: "Second partial error" });
  assert.match(f.messages.at(-1)!.error!, /Prior current observation error/);
  assert.doesNotMatch(f.messages.at(-1)!.error!, /Fixture supersession/);
});

test("cold-start burst is bounded, coalesces live IDs, and flushes full current state once per correlation", () => {
  const f = reporterFixture();
  for (let i = 0; i < 70; i++) f.reporter.report(superseded(), f.reporter.request(`request-${i}`));
  f.reporter.report(superseded(), f.reporter.request("request-69"));
  assert.equal(f.messages.length, 0);
  assert.equal(f.logs.filter(message => JSON.parse(message).event === "skill_request_evicted").length, 6);
  const current = { ...empty(), removedLinks: [{ path: "skills/removed", reason: "Current removal" }] };
  f.reporter.report(current, f.reporter.request("current"));
  assert.equal(f.messages.length, 64);
  assert.deepEqual(f.messages.map(message => message.requestId), [
    ...Array.from({ length: 63 }, (_, i) => `request-${i + 7}`), "current",
  ]);
  assert.deepEqual(f.messages[0]!.removals, current.removedLinks);
  assert.ok(f.messages.slice(1).every(message => message.removals?.length === 0));
  f.reporter.report(empty());
  assert.equal(f.messages.at(-1)!.requestId, undefined);
  assert.deepEqual(f.messages.at(-1)!.removals, []);
});

test("expiry timer prunes duplicate requests at the original monotonic deadline", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = reporterFixture();
  f.reporter.report(superseded(), f.reporter.request("duplicate"));
  f.advance(10_000); t.mock.timers.tick(10_000);
  f.reporter.report(superseded(), f.reporter.request("duplicate"));
  f.advance(20_000); t.mock.timers.tick(20_000);
  const expiry = f.logs.map(message => JSON.parse(message)).find(event => event.event === "skill_request_expired");
  assert.deepEqual(expiry, { event: "skill_request_expired", level: "warn", entryPoint: "skill_reconciliation",
    runnerId: "fixture", requestId: "duplicate", fallback: "server_timeout" });
  f.reporter.report(empty(), f.reporter.request("new"));
  assert.deepEqual(f.messages.map(message => message.requestId), ["new"]);
});

test("delayed queue tickets and old reconnect generations never re-emit solicited answers", () => {
  const f = reporterFixture();
  const delayed = f.reporter.request("delayed");
  f.advance(30_000);
  f.reporter.report(superseded(), delayed);
  const old = f.reporter.request("old-socket");
  f.reporter.report(superseded(), old);
  f.reporter.resetRequests();
  f.reporter.report(superseded(), old);
  f.reporter.report(empty(), old);
  assert.deepEqual(f.messages.map(message => message.requestId), [undefined]);
  f.reporter.report(superseded(), f.reporter.request("new-socket"));
  assert.equal(f.messages.at(-1)!.requestId, "new-socket");
});

test("a duplicate queued before the first deferral retains the first admission deadline", () => {
  const f = reporterFixture();
  const first = f.reporter.request("duplicate");
  f.advance(10_000);
  const duplicate = f.reporter.request("duplicate");
  assert.equal(duplicate!.expiresAt, first!.expiresAt);
  f.advance(10_000); f.reporter.report(superseded(), first);
  f.advance(15_000); f.reporter.report(empty(), duplicate);
  assert.deepEqual(f.messages.map(message => message.requestId), [undefined]);
});

test("queued admissions stay bounded and old tickets cannot resurrect after eviction or settlement", () => {
  const f = reporterFixture();
  const first = f.reporter.request("first");
  for (let i = 0; i < 64; i++) f.reporter.request(`queued-${i}`);
  f.reporter.report(superseded(), first);
  f.reporter.report(empty(), first);
  assert.equal(f.messages[0]!.requestId, undefined);
  const settled = f.reporter.request("settled");
  f.reporter.report(empty(), settled);
  f.reporter.report(superseded(), settled);
  assert.equal(f.messages.at(-1)!.requestId, undefined);
  f.reporter.resetRequests();
});

test("no-cache removal bookkeeping keeps only the latest bounded real event and hands it off once", () => {
  const f = reporterFixture();
  const event = Array.from({ length: 300 }, (_, i) => ({ path: `skills/${i}`, reason: "Actual fixture removal" }));
  f.reporter.report({ ...superseded(), removedLinks: [{ path: "skills/older", reason: "Older actual removal" }] });
  f.reporter.report({ ...superseded(), removedLinks: event }, f.reporter.request("pending"));
  f.reporter.report(superseded());
  f.reporter.report(empty());
  assert.deepEqual(f.messages[0]!.removals, event.slice(0, 256));
  f.reporter.report(superseded());
  assert.deepEqual(f.messages.at(-1)!.removals, []);
});

test("newer current removal event replaces pending events and stale cached reports carry only actual partial removals", () => {
  const f = reporterFixture();
  f.reporter.report({ ...superseded(), removedLinks: [{ path: "old", reason: "Old event" }] });
  const actual = [{ path: "new", reason: "New event" }];
  f.reporter.report({ ...empty(), removedLinks: actual });
  f.reporter.report({ ...superseded(), removedLinks: actual });
  assert.deepEqual(f.messages.map(message => message.removals), [actual, actual]);
  f.reporter.report(superseded());
  assert.deepEqual(f.messages.at(-1)!.removals, []);
});

test("error wording does not decide supersession and genuine current failure/empty replace normally", () => {
  const f = reporterFixture();
  f.reporter.report({ ...empty(), deployed: [{ name: "alpha", digest: "a".repeat(64), links: [] }] });
  f.reporter.report({ ...empty(), error: "Genuine failure containing the word superseded" });
  assert.deepEqual(f.messages.at(-1)!.deployed, []);
  f.reporter.report(superseded());
  assert.deepEqual(f.messages.at(-1)!.deployed, []);
  assert.match(f.messages.at(-1)!.error!, /Genuine failure/);
  f.reporter.report(empty());
  assert.equal(f.messages.at(-1)!.error, undefined);
});

test("a throwing transport cannot establish a published observation", () => {
  let fail = true;
  const messages: SkillsStateMessage[] = [];
  const reporter = new SkillStateReporter("fixture", message => {
    if (fail) throw new Error("Fixture send failure");
    messages.push(message);
  }, () => {});
  assert.throws(() => reporter.report(empty()), /Fixture send failure/);
  fail = false;
  reporter.report(superseded());
  assert.equal(messages.length, 0);
  reporter.report(empty());
  assert.equal(messages.length, 1);
});

test("supersession survives either native merge operand and remains off the wire", () => {
  for (const merged of [skills.mergeReconcileSkillsResults(empty(), superseded()),
    skills.mergeReconcileSkillsResults(superseded(), empty())]) {
    assert.equal(merged.superseded, true);
    assert.equal("superseded" in skills.skillsStateMessage("fixture", merged), false);
  }
});

test("real Hub timeout and disconnect settle cold-start requests without false inventory or stale reconnect answers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = reporterFixture();
  const db = ControlPlaneDb.open(":memory:");
  const hub = new Hub(db);
  const socket = { send: () => {} };
  hub.attachRunner("fixture", socket);
  const requestMessage = (requestId: string) => ({ type: "skills_sync" as const, runnerId: "fixture", requestId, skills: [] });
  try {
    const timeout = hub.requestFromRunner("fixture", "timeout", requestMessage("timeout"));
    const rejected = assert.rejects(timeout, /did not respond in time/);
    f.reporter.report(superseded(), f.reporter.request("timeout"));
    f.advance(30_000); t.mock.timers.tick(30_000); await rejected;
    assert.equal(f.messages.length, 0);
    f.reporter.report(empty());
    assert.equal(f.messages[0]!.requestId, undefined);
    const disconnected = hub.requestFromRunner("fixture", "disconnect", requestMessage("disconnect"));
    const disconnectedRejection = assert.rejects(disconnected, /disconnected/);
    assert.equal(hub.detachRunner("fixture", socket), true); await disconnectedRejection;
    f.reporter.resetRequests();
    hub.attachRunner("fixture", socket);
    const current = hub.requestFromRunner("fixture", "current", requestMessage("current"));
    f.reporter.report(empty(), f.reporter.request("current"));
    const reply = f.messages.at(-1)!;
    assert.ok(reply.requestId);
    assert.equal(hub.resolveRunnerRequest({ ...reply, requestId: reply.requestId }, "fixture"), true);
    assert.equal((await current).type, "skills_state");
  } finally { hub.detachRunner("fixture", socket); f.reporter.resetRequests(); db.close(); }
});

function integratedFixture() {
  const root = mkdtempSync(join(tmpdir(), "skill-report-fixture-"));
  const home = join(root, "home"); mkdirSync(home);
  const dataDir = join(root, "data"); mkdirSync(dataDir);
  const agent: AgentDefinition = { id: "codex-fixture", name: "Fixture", command: "unused", args: [], env: {}, driver: "codex-app-server" };
  const accounts = ["account-a", "account-b"].map(id => ({ id, label: id, provider: "codex" as const, directory: join(root, id) }));
  for (const account of accounts) {
    mkdirSync(join(account.directory, "skills", "local"), { recursive: true });
    writeFileSync(join(account.directory, "skills", "local", "SKILL.md"), "---\nname: local\ndescription: Fixture local skill\n---\n");
  }
  const makeEntry = (body: string) => {
    const files = [{ path: "SKILL.md", encoding: "utf8" as const, content: `---\nname: alpha\ndescription: Fixture skill\n---\n${body}\n` }];
    return { name: "alpha", versionDigest: skillVersionDigest(files), files, targets: [{ agentId: agent.id, invocation: "agent" as const }] };
  };
  const initial = makeEntry("Initial content");
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({ runnerId: "fixture", hostname: "fixture", os: "linux", version: "fixture", agents: [agent], workspaces: [] }, 1, PROTOCOL_VERSION);
  const messages: SkillsStateMessage[] = [];
  const logs: string[] = [];
  const reporter = new SkillStateReporter("fixture", message => {
    messages.push(message);
    db.setRunnerSkillState("fixture", message, messages.length + 1);
  }, message => logs.push(message));
  let acquire: (directory: string) => Promise<void> = async () => {};
  const assembler = new ChunkedSkillsSyncAssembler({ runnerId: "fixture", needsContent: () => true,
    cacheContent: item => skills.cacheSkillSyncEntry(dataDir, [agent], item) });
  const context = {
    ...skills, runnerSupportsProtocol, skillReconciliationProviderAccountPlan,
    mergeWslSkillsResult, reconcileWslSkills: async (_options: unknown): Promise<skills.ReconcileSkillsResult> => empty(),
    dataDirLease: { ownerHash: "a".repeat(64) },
    controlPlaneProtocolVersion: PROTOCOL_VERSION,
    lastDesiredSkills: [initial] as skills.ReconcileSkillEntry[], metadata: { agents: [agent] },
    config: { runnerId: "fixture", dataDir, providerAccounts: accounts, skillRetention: { removedSkillDays: 1, previousVersionMinutes: 0 } },
    chunkedSkillsSync: assembler, skillsReconcileQueue: Promise.resolve(), skillStateReporter: reporter,
    homedir: () => home, resolve, log: (message: string) => logs.push(message),
    store: { listSessions: () => [] }, process: { platform: "linux" },
    errText: (error: unknown) => error instanceof Error ? error.message : String(error),
    sessions: { acquireSkillReconciliationProviderHome: (directory: string) => acquire(directory) },
    sendUp: (message: SkillsStateMessage) => { messages.push(message); db.setRunnerSkillState("fixture", message, messages.length + 1); },
    queueSkillsReconcile: undefined as ((requestId?: string) => void) | undefined,
  };
  // Pin the actual production queue and its currency predicate without starting a runner/provider.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("function queueSkillsReconcile(");
  const end = source.indexOf("/** WSL adoption", start);
  assert.ok(start > 0 && end > start);
  runInNewContext(transformSync(source.slice(start, end), { loader: "ts" }).code, context);
  const queue = async (id?: string) => { context.queueSkillsReconcile!(id); await context.skillsReconcileQueue; };
  return { root, home, dataDir, agent, accounts, initial, makeEntry, db, messages, logs, reporter, assembler, context, queue,
    block: (directory: string, refused: boolean) => {
      let arrived!: () => void; let finish!: () => void;
      const entered = new Promise<void>(resolve => { arrived = resolve; });
      const gate = new Promise<void>(resolve => { finish = resolve; });
      const visited: string[] = [];
      acquire = async candidate => { visited.push(candidate); if (candidate !== directory) return; arrived(); await gate;
        if (refused) throw new Error("Fixture lease refusal"); };
      return { entered, finish, visited };
    },
    release: () => { acquire = async () => {}; },
    close: () => { reporter.resetRequests(); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const scope of ["base", "account-b"] as const) for (const refused of [false, true]) {
  test(`production queue preserves published base+two-account inventory after ${scope} ${refused ? "refused" : "granted"} supersession`, async () => {
    const f = integratedFixture();
    try {
      await f.queue("initial");
      const before = f.db.getRunnerSkillState("fixture")!;
      assert.equal(before.deployed.length, 3); assert.equal(before.unmanaged.length, 2);
      const gate = f.block(scope === "base" ? f.home : f.accounts[1]!.directory, refused);
      const pending = f.queue("superseded"); await gate.entered;
      const next = f.makeEntry("Latest completed content");
      assert.equal(f.assembler.begin({ type: "skills_sync_manifest", runnerId: "fixture", syncId: "next",
        skills: [{ name: next.name, versionDigest: next.versionDigest, targets: next.targets }] }).kind, "accepted");
      assert.equal(f.assembler.acceptContent({ type: "skills_sync_content", runnerId: "fixture", syncId: "next",
        name: next.name, versionDigest: next.versionDigest, files: next.files }).kind, "accepted");
      const staged = join(skills.skillsStoreRoot(f.dataDir), next.name, next.versionDigest);
      gate.finish(); await pending;
      const stale = f.db.getRunnerSkillState("fixture")!;
      assert.deepEqual(stale.deployed, before.deployed); assert.deepEqual(stale.unmanaged, before.unmanaged);
      assert.match(stale.error!, /stale.*superseded/);
      assert.equal(f.messages.at(-1)!.requestId, "superseded");
      assert.deepEqual(f.messages.at(-1)!.removals, []);
      assert.equal(existsSync(staged), true);
      assert.equal(realpathSync(join(f.home, ".agents/skills/alpha")), join(skills.skillsStoreRoot(f.dataDir), "alpha", f.initial.versionDigest));
      assert.equal(existsSync(join(f.accounts[1]!.directory, "skills/alpha")), true);
      if (scope === "base") assert.deepEqual(gate.visited, [f.home]);
      const completed = f.assembler.complete({ type: "skills_sync_complete", runnerId: "fixture", syncId: "next" });
      assert.equal(completed.kind, "accepted"); if (completed.kind !== "accepted") assert.fail("Expected completed fixture");
      f.context.lastDesiredSkills = completed.desired; f.release(); await f.queue("recovery");
      const current = f.db.getRunnerSkillState("fixture")!;
      assert.equal(current.error, undefined);
      assert.ok(current.deployed.every(row => row.digest === next.versionDigest));
      assert.equal(current.deployed.length, 3); assert.equal(current.unmanaged.length, 2);
    } finally { f.close(); }
  });
}

for (const change of ["desired", "discovery", "account-directory", "account-identity", "account-removal"] as const) {
  test(`production currency fence preserves scoped inventory when ${change} changes mid-pass`, async () => {
    const f = integratedFixture();
    try {
      await f.queue(); const before = f.db.getRunnerSkillState("fixture")!;
      const gate = f.block(f.home, false); const pending = f.queue(); await gate.entered;
      if (change === "desired") f.context.lastDesiredSkills = [];
      if (change === "discovery") f.context.metadata.agents = [...f.context.metadata.agents];
      if (change === "account-directory") f.accounts[0]!.directory = join(f.root, "new-account-home");
      if (change === "account-identity") f.accounts[0]!.id = "new-account-identity";
      if (change === "account-removal") f.accounts.pop();
      gate.finish(); await pending;
      const stale = f.db.getRunnerSkillState("fixture")!;
      assert.deepEqual(stale.deployed, before.deployed); assert.deepEqual(stale.unmanaged, before.unmanaged);
      assert.match(stale.error!, /stale.*superseded/); assert.deepEqual(gate.visited, [f.home]);
    } finally { f.close(); }
  });
}

test("cold-start production supersession preserves pre-restart CP inventory and settles deferred correlation on a current report", async () => {
  const f = integratedFixture();
  try {
    const persisted = { deployed: [{ name: "persisted", digest: "a".repeat(64), links: [] }], unmanaged: [] };
    f.db.setRunnerSkillState("fixture", persisted, 1);
    const gate = f.block(f.home, true); const pending = f.queue("cold-start"); await gate.entered;
    f.context.lastDesiredSkills = [...f.context.lastDesiredSkills]; gate.finish(); await pending;
    assert.equal(f.messages.length, 0);
    assert.deepEqual(f.db.getRunnerSkillState("fixture")!.deployed, persisted.deployed);
    f.release(); await f.queue("current");
    assert.deepEqual(f.messages.map(message => message.requestId), ["cold-start", "current"]);
    assert.equal(f.db.getRunnerSkillState("fixture")!.deployed.length, 3);
  } finally { f.close(); }
});

test("production current empty desired state clears rows/links and genuine lease failure replaces with visible scoped errors", async () => {
  const f = integratedFixture();
  try {
    await f.queue(); f.context.lastDesiredSkills = [];
    await f.queue("empty");
    assert.deepEqual(f.db.getRunnerSkillState("fixture")!.deployed, []);
    assert.equal(existsSync(join(f.home, ".agents/skills/alpha")), false);
    assert.equal(existsSync(join(f.accounts[0]!.directory, "skills/alpha")), false);
    assert.ok(f.messages.at(-1)!.removals!.length > 0);
    const removalTime = f.db.getRunnerSkillState("fixture")!.removalsUpdatedAt;
    assert.ok(removalTime !== undefined);
    f.context.lastDesiredSkills = [f.initial];
    const gate = f.block(f.home, true); const pending = f.queue("failure"); await gate.entered; gate.finish(); await pending;
    const failure = f.db.getRunnerSkillState("fixture")!;
    assert.match(failure.error!, /lease unavailable/);
    assert.doesNotMatch(failure.error!, /inventory is stale/);
    assert.equal(failure.deployed.length, 3);
    assert.equal(failure.removalsUpdatedAt, removalTime);
  } finally { f.close(); }
});

test("the final production publication fence catches currency lost after a completed account result", async () => {
  const f = integratedFixture();
  try {
    await f.queue(); const before = f.db.getRunnerSkillState("fixture")!;
    f.context.reconcileSkills = async options => {
      const result = await skills.reconcileSkills(options);
      if (options.providerAccountId === "account-b") f.context.lastDesiredSkills = [];
      return result;
    };
    await f.queue("final-fence");
    const stale = f.db.getRunnerSkillState("fixture")!;
    assert.deepEqual(stale.deployed, before.deployed);
    assert.match(stale.error!, /stale.*superseded/);
    assert.equal(f.messages.at(-1)!.requestId, "final-fence");
  } finally { f.close(); }
});

test("production partial supersession publishes actual completed removals once while preserving inventory", async () => {
  const f = integratedFixture();
  try {
    await f.queue(); const before = f.db.getRunnerSkillState("fixture")!;
    f.context.lastDesiredSkills = [];
    const gate = f.block(f.accounts[1]!.directory, false); const pending = f.queue("partial-removal"); await gate.entered;
    f.context.lastDesiredSkills = [f.initial]; gate.finish(); await pending;
    const stale = f.db.getRunnerSkillState("fixture")!;
    assert.deepEqual(stale.deployed, before.deployed);
    assert.ok(f.messages.at(-1)!.removals!.length > 0);
    assert.ok(f.messages.at(-1)!.removals!.every(removal => removal.providerAccountId !== "account-b"));
    const removalTime = stale.removalsUpdatedAt;
    f.release(); await f.queue();
    assert.deepEqual(f.messages.at(-1)!.removals, []);
    assert.equal(f.db.getRunnerSkillState("fixture")!.removalsUpdatedAt, removalTime);
  } finally { f.close(); }
});

test("production current content and caught failures remain visible and update the observation", async () => {
  const f = integratedFixture();
  try {
    await f.queue();
    const corrupt = f.makeEntry("Corrupt desired content");
    corrupt.versionDigest = "a".repeat(64);
    f.context.lastDesiredSkills = [corrupt];
    await f.queue("content-failure");
    assert.equal(f.messages.at(-1)!.requestId, "content-failure");
    assert.ok(f.db.getRunnerSkillState("fixture")!.deployed.some(row => row.error));
    f.context.reconcileSkills = async () => { throw new Error("Fixture caught failure"); };
    await f.queue("caught-failure");
    const failure = f.db.getRunnerSkillState("fixture")!;
    assert.deepEqual(failure.deployed, []);
    assert.match(failure.error!, /Fixture caught failure/);
    f.reporter.report(superseded());
    assert.deepEqual(f.db.getRunnerSkillState("fixture")!.deployed, []);
    assert.match(f.db.getRunnerSkillState("fixture")!.error!, /Fixture caught failure/);
  } finally { f.close(); }
});

test("the production chunked rejection producer updates the same current observation", async () => {
  const f = integratedFixture();
  try {
    await f.queue();
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.indexOf("function reportChunkedSkillsSyncRejection(");
    const end = source.indexOf("function beginChunkedSkillsSync(", start);
    assert.ok(start > 0 && end > start);
    const report = runInNewContext(transformSync(`${source.slice(start, end)}reportChunkedSkillsSyncRejection`, { loader: "ts" }).code, f.context) as
      (result: { kind: "rejected"; error: string; requestId: string }) => void;
    report({ kind: "rejected", error: "Fixture rejected content", requestId: "rejected" });
    assert.equal(f.messages.at(-1)!.requestId, "rejected");
    f.reporter.report(superseded());
    const state = f.db.getRunnerSkillState("fixture")!;
    assert.deepEqual(state.deployed, []);
    assert.match(state.error!, /Fixture rejected content/);
  } finally { f.close(); }
});

test("production publication stays fenced across a stubbed WSL await without starting WSL or native helpers", async () => {
  const f = integratedFixture();
  try {
    await f.queue(); const before = f.db.getRunnerSkillState("fixture")!;
    f.context.process.platform = "win32";
    f.context.metadata.agents = [...f.context.metadata.agents,
      { ...f.agent, id: "wsl-fixture", context: { kind: "wsl", distro: "FixtureDistro" } }];
    let entered!: () => void; let finish!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    f.context.reconcileWslSkills = async () => { entered(); await gate; return empty(); };
    const pending = f.queue("wsl-fence"); await arrived;
    f.context.metadata.agents = [...f.context.metadata.agents]; finish(); await pending;
    const stale = f.db.getRunnerSkillState("fixture")!;
    assert.deepEqual(stale.deployed, before.deployed);
    assert.deepEqual(stale.unmanaged, before.unmanaged);
    assert.match(stale.error!, /stale.*superseded/);
    f.context.reconcileWslSkills = async () => empty(); await f.queue("wsl-current");
    assert.equal(f.db.getRunnerSkillState("fixture")!.error, undefined);
  } finally { f.close(); }
});

for (const solicited of [false, true]) for (const refused of [false, true]) {
  test(`production queue drops old ${solicited ? "solicited" : "unsolicited"} generation after ${refused ? "refused" : "granted"} ownership wait`, async () => {
    const f = integratedFixture();
    try {
      await f.queue();
      const before = f.db.getRunnerSkillState("fixture")!;
      const messageCount = f.messages.length;
      const gate = f.block(f.home, refused);
      const pending = f.queue(solicited ? "R" : undefined);
      await gate.entered;
      f.reporter.beginConnection();
      f.reporter.resumeRequests(solicited ? [{ requestId: "R", remainingMs: 30_000 }] : []);
      gate.finish(); await pending;
      assert.equal(f.messages.length, messageCount, "old success/error cannot publish or drain resumed correlation");
      assert.deepEqual(f.db.getRunnerSkillState("fixture"), before);
      assert.deepEqual(gate.visited, [f.home], "old pass cannot replay subsequent account/GC/link reconciliation");
      f.release(); await f.queue();
      assert.equal(f.messages.at(-1)!.requestId, solicited ? "R" : undefined);
      assert.deepEqual(f.db.getRunnerSkillState("fixture")!.deployed, before.deployed);
    } finally { f.close(); }
  });
}

test("production queue skips queued work from an old connection before any ownership/link work", async () => {
  const f = integratedFixture();
  try {
    const gate = f.block(f.home, false);
    const running = f.queue(); await gate.entered;
    const queued = f.queue("R");
    f.reporter.beginConnection(); f.reporter.resumeRequests([{ requestId: "R", remainingMs: 30_000 }]);
    gate.finish(); await running; await queued;
    assert.deepEqual(gate.visited, [f.home]);
    assert.equal(f.messages.length, 0);
    f.release(); await f.queue();
    assert.equal(f.messages.at(-1)!.requestId, "R");
  } finally { f.close(); }
});

test("production queue does not turn a refused handoff into empty error inventory or consume its admission", async () => {
  const f = integratedFixture();
  try {
    await f.queue();
    const before = f.db.getRunnerSkillState("fixture")!, count = f.messages.length;
    const push = f.messages.push.bind(f.messages);
    let attempts = 0;
    f.messages.push = (...messages: SkillsStateMessage[]) => {
      attempts++;
      if (attempts === 1) throw new Error("Fixture handoff refused");
      return push(...messages);
    };
    await f.queue("R");
    assert.equal(attempts, 1, "transport failure is not retried as a reconcile error");
    assert.equal(f.messages.length, count);
    assert.deepEqual(f.db.getRunnerSkillState("fixture"), before);
    f.reporter.beginConnection(); f.reporter.resumeRequests([{ requestId: "R", remainingMs: 30_000 }]);
    await f.queue();
    assert.equal(f.messages.at(-1)!.requestId, "R");
    assert.deepEqual(f.db.getRunnerSkillState("fixture")!.deployed, before.deployed);
  } finally { f.close(); }
});
