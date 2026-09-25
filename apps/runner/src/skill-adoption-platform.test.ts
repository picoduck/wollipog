import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition, MachineSkillCandidate } from "@wollipog/protocol";
import { adoptMachineSkill, type SkillAdoptionOptions } from "./skill-adoption.js";
import { listSkillAdoptionRecovery, restoreSkillAdoptionRecovery } from "./skill-adoption-recovery.js";
import {
  recoveryState,
  type PlatformAdoptionOutcome,
  type PlatformAdoptionRequest,
  type PlatformRestoreRequest,
  type RecoveryDirectoryFacts,
  type RecoveryJournalFacts,
  type SkillAdoptionPlatformHelper,
} from "./skill-adoption-platform.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = "d".repeat(64);
const agents: AgentDefinition[] = [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" }];
const candidate: MachineSkillCandidate = { id: "opaque", name: "alpha", sourceDirectory: ".codex/skills",
  generation: "a".repeat(64) };
const operationId = "123e4567-e89b-42d3-a456-426614174000";

function fakeHelper(outcome: PlatformAdoptionOutcome | (() => PlatformAdoptionOutcome)) {
  const requests: PlatformAdoptionRequest[] = [];
  const helper: SkillAdoptionPlatformHelper = {
    adopt: (request) => { requests.push(request); return typeof outcome === "function" ? outcome() : outcome; },
    inspect: () => { throw new Error("not used"); },
    restore: () => { throw new Error("not used"); },
  };
  return { helper, requests };
}

function options(helper: SkillAdoptionPlatformHelper, overrides: Partial<SkillAdoptionOptions> = {}) {
  const calls: string[] = [];
  const value: SkillAdoptionOptions = {
    home: "/home/user", dataDir: "/data", agents, candidate, digest, platform: "darwin", helper,
    acquireProviderHomeLease: () => { calls.push("lease"); return undefined; },
    assertAuthorized: () => { calls.push("authorized"); return undefined; },
    ...overrides,
  };
  return { value, calls };
}

test("the shared recovery state machine only restores exact identity matches", () => {
  const intent = { parentIdentity: "1:2", sourceIdentity: "1:3" };
  const state = (parent: string, original: string | null, source: Parameters<typeof recoveryState>[3]) =>
    recoveryState(intent, parent, original, source).state;
  assert.equal(state("9:9", "1:3", { kind: "absent" }), "blocked");
  assert.equal(state("1:2", null, { kind: "directory", identity: "1:3" }), "intent_only");
  assert.equal(state("1:2", null, { kind: "directory", identity: "1:4" }), "blocked");
  assert.equal(state("1:2", "1:3", { kind: "absent" }), "source_preserved");
  assert.equal(state("1:2", "1:4", { kind: "absent" }), "blocked");
  assert.equal(state("1:2", "1:3", { kind: "link", role: "managed" }), "managed_linked");
  assert.equal(state("1:2", "1:3", { kind: "link", role: "recovery" }), "restored");
  assert.equal(state("1:2", "1:3", { kind: "link", role: "foreign" }), "blocked");
  assert.equal(state("1:2", "1:3", { kind: "directory", identity: "1:5" }), "blocked");
  assert.equal(state("1:2", "1:3", { kind: "other" }), "blocked");
});

test("helper adoption passes only runner-resolved roots after both guards", () => {
  const { helper, requests } = fakeHelper({ journal: true, adopted: true });
  const { value, calls } = options(helper, {
    candidate: { ...candidate, providerAccountId: "acct-work" },
    home: "/accounts/work",
    localSourceDirectory: "skills",
    acquireProviderHomeLease: () => { calls.push("lease"); assert.equal(requests.length, 0); return undefined; },
  });
  const result = adoptMachineSkill(value);
  assert.equal(result.status, "adopted");
  if (result.status !== "adopted") return;
  assert.deepEqual(calls, ["lease", "authorized"]);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.match(request!.operationId, UUID);
  assert.deepEqual({ ...request, operationId: "id" }, {
    home: "/accounts/work", localSourceDirectory: "skills", sourceDirectory: ".codex/skills", name: "alpha",
    generation: "a".repeat(64), digest, dataDir: "/data", operationId: "id", providerAccountId: "acct-work",
  });
  assert.equal(result.operationId, request!.operationId);
  assert.equal(result.backupDirectory, `.codex/skills/.wollipog-adoption-${request!.operationId}`);
  assert.equal(result.providerAccountId, "acct-work");
});

test("helper progress decides between a clean rejection and recovery", () => {
  const recovery = adoptMachineSkill(options(fakeHelper({ journal: true, adopted: false }).helper).value);
  assert.equal(recovery.status, "recovery_required");
  assert.match(recovery.status === "recovery_required" ? recovery.backupDirectory : "", /^\.codex\/skills\/\.wollipog-adoption-/u);
  assert.equal(adoptMachineSkill(options(fakeHelper({ journal: false, adopted: false }).helper).value).status, "rejected");
  // A success line without its journal line cannot come from the helper, but it is still only an
  // adoption when the helper reported completion.
  assert.equal(adoptMachineSkill(options(fakeHelper({ journal: false, adopted: true }).helper).value).status, "adopted");
  const thrown = adoptMachineSkill(options(fakeHelper(() => { throw new Error("private detail"); }).helper).value);
  assert.equal(thrown.status, "recovery_required", "an unexpected wrapper failure cannot prove no journal exists");
  assert.doesNotMatch(JSON.stringify(thrown), /private detail/u);
});

test("helper adoption rejects invalid requests and failed guards before invoking the helper", () => {
  for (const overrides of [
    { candidate: { ...candidate, sourceDirectory: "../outside" } },
    { candidate: { ...candidate, sourceDirectory: ".claude/skills" } },
    { candidate: { ...candidate, name: "../alpha" } },
    { digest: "stale" },
    { acquireProviderHomeLease: () => { throw new Error("private lease detail"); } },
    { assertAuthorized: () => { throw new Error("private authorization detail"); } },
    { assertAuthorized: (async () => undefined) as unknown as () => undefined },
  ] satisfies Partial<SkillAdoptionOptions>[]) {
    const { helper, requests } = fakeHelper({ journal: true, adopted: true });
    const result = adoptMachineSkill(options(helper, overrides).value);
    assert.equal(result.status, "rejected");
    assert.doesNotMatch(JSON.stringify(result), /private/u);
    assert.equal(requests.length, 0);
  }
});

test("platforms without an adoption transaction refuse without touching guards", () => {
  for (const platform of ["freebsd", "aix"] as const) {
    const { value } = options(fakeHelper({ journal: true, adopted: true }).helper, {
      platform, helper: undefined, acquireProviderHomeLease: () => assert.fail("must not lease") });
    assert.equal(adoptMachineSkill(value).status, "rejected");
  }
});

test("a WSL candidate never reaches a native adoption helper", () => {
  const { helper, requests } = fakeHelper({ journal: true, adopted: true });
  const { value, calls } = options(helper, { platform: "win32",
    candidate: { ...candidate, context: { kind: "wsl", distro: "Ubuntu" } } });
  assert.equal(adoptMachineSkill(value).status, "rejected");
  assert.deepEqual(calls, []);
  assert.equal(requests.length, 0);
});

function journal(overrides: Partial<RecoveryJournalFacts> = {}, intent: Record<string, unknown> = {}): RecoveryJournalFacts {
  return {
    operationId,
    intent: JSON.stringify({ format: 1, operationId, sourceDirectory: ".codex/skills", name: "alpha", digest,
      generation: "a".repeat(64), sourceIdentity: "7:2", parentIdentity: "7:1", targetIdentity: "7:3",
      targetRelative: `skills/store/alpha/${digest}`, ...intent }),
    name: "alpha", digest, originalIdentity: "7:2", source: { kind: "link", role: "managed" },
    ...overrides,
  };
}

function recoveryHelper(byDirectory: Record<string, RecoveryDirectoryFacts>, restore: () => boolean = () => true) {
  const restores: PlatformRestoreRequest[] = [];
  const inspections: Array<{ localSourceDirectory: string; operationId?: string }> = [];
  const helper: SkillAdoptionPlatformHelper = {
    adopt: () => { throw new Error("not used"); },
    inspect: (request) => {
      inspections.push({ localSourceDirectory: request.localSourceDirectory,
        ...(request.operationId ? { operationId: request.operationId } : {}) });
      return byDirectory[request.localSourceDirectory] ?? { parentIdentity: null, journals: [], truncated: false };
    },
    restore: (request) => { restores.push(request); return restore(); },
  };
  return { helper, restores, inspections };
}

test("helper recovery listing validates each journal before deriving its state", () => {
  const { helper } = recoveryHelper({
    ".codex/skills": { parentIdentity: "7:1", truncated: true, journals: [
      journal(),
      journal({ operationId: "223e4567-e89b-42d3-a456-426614174000",
        intent: "{not json", name: "beta", digest }),
      journal({ operationId: "323e4567-e89b-42d3-a456-426614174000", name: "other" },
        { operationId: "323e4567-e89b-42d3-a456-426614174000" }),
      journal({ operationId: "423e4567-e89b-42d3-a456-426614174000", source: { kind: "absent" } },
        { operationId: "423e4567-e89b-42d3-a456-426614174000", sourceDirectory: ".agents/skills" }),
    ] },
  });
  const listed = listSkillAdoptionRecovery("/home/user", "/data", agents, [], { platform: "darwin", helper });
  assert.equal(listed.truncated, true);
  assert.deepEqual(listed.operations.map((entry) => [entry.operationId.slice(0, 1), entry.state]), [
    ["1", "managed_linked"],
    ["3", "blocked"],
  ]);
  assert.equal(listed.operations[0]!.backupDirectory, `.codex/skills/.wollipog-adoption-${operationId}`);
  assert.equal(listed.operations[1]!.detail, "The journal could not be inspected safely.");
});

test("helper recovery keeps copied operation IDs visible but not restorable", () => {
  const { helper, restores } = recoveryHelper({
    ".codex/skills": { parentIdentity: "7:1", truncated: false, journals: [journal()] },
    ".agents/skills": { parentIdentity: "8:1", truncated: false, journals: [
      journal({}, { sourceDirectory: ".agents/skills", parentIdentity: "8:1" })] },
  });
  const listed = listSkillAdoptionRecovery("/home/user", "/data", agents, [], { platform: "darwin", helper });
  assert.deepEqual(listed.operations.map((entry) => entry.state), ["blocked"]);
  assert.match(listed.operations[0]!.detail, /more than one recovery journal/u);
  const restored = restoreSkillAdoptionRecovery({ home: "/home/user", dataDir: "/data", agents, operationId,
    platform: "darwin", helper, acquireProviderHomeLease: () => assert.fail("must not lease") });
  assert.equal(restored.status, "blocked");
  assert.equal(restores.length, 0);
});

test("helper restore leases the scope home, passes journal facts, and reports the new state", () => {
  let restored = false;
  const facts = () => ({ parentIdentity: "7:1", truncated: false,
    journals: [journal({ source: restored ? { kind: "link", role: "recovery" } : { kind: "link", role: "managed" } })] });
  const helper: SkillAdoptionPlatformHelper = {
    adopt: () => { throw new Error("not used"); },
    inspect: (request) => request.localSourceDirectory === ".codex/skills"
      ? facts() : { parentIdentity: null, journals: [], truncated: false },
    restore: (request) => {
      assert.deepEqual(request, { home: "/home/user", canonicalHome: "/home/user", localSourceDirectory: ".codex/skills",
        dataDir: "/data", operationId, name: "alpha", digest, parentIdentity: "7:1", sourceIdentity: "7:2" });
      restored = true;
      return true;
    },
  };
  const leased: string[] = [];
  const result = restoreSkillAdoptionRecovery({ home: "/home/user", dataDir: "/data", agents, operationId,
    platform: "darwin", helper, acquireProviderHomeLease: (home) => { leased.push(home); } });
  assert.equal(result.status, "restored");
  assert.equal(result.operation?.state, "restored");
  assert.deepEqual(leased, ["/home/user"]);
  assert.equal(restoreSkillAdoptionRecovery({ home: "/home/user", dataDir: "/data", agents, operationId,
    platform: "darwin", helper, acquireProviderHomeLease: () => {} }).status, "not_needed");
});

test("helper restore stops safely on lease contention, blocked states, and helper failure", () => {
  const managed = { ".codex/skills": { parentIdentity: "7:1", truncated: false, journals: [journal()] } };
  const failing = recoveryHelper(managed, () => false);
  const failed = restoreSkillAdoptionRecovery({ home: "/home/user", dataDir: "/data", agents, operationId,
    platform: "darwin", helper: failing.helper, acquireProviderHomeLease: () => {} });
  assert.equal(failed.status, "recovery_required");
  assert.equal(failed.operation?.state, "managed_linked");
  assert.equal(failing.restores.length, 1);

  const contended = recoveryHelper(managed);
  assert.equal(restoreSkillAdoptionRecovery({ home: "/home/user", dataDir: "/data", agents, operationId,
    platform: "darwin", helper: contended.helper,
    acquireProviderHomeLease: () => { throw new Error("busy"); } }).status, "blocked");
  assert.equal(contended.restores.length, 0);

  const occupied = recoveryHelper({ ".codex/skills": { parentIdentity: "7:1", truncated: false,
    journals: [journal({ source: { kind: "directory", identity: "9:9" } })] } });
  assert.equal(restoreSkillAdoptionRecovery({ home: "/home/user", dataDir: "/data", agents, operationId,
    platform: "darwin", helper: occupied.helper, acquireProviderHomeLease: () => {} }).status, "blocked");
  assert.equal(occupied.restores.length, 0);

  const intentOnly = recoveryHelper({ ".codex/skills": { parentIdentity: "7:1", truncated: false,
    journals: [journal({ originalIdentity: null, source: { kind: "directory", identity: "7:2" } })] } });
  assert.equal(restoreSkillAdoptionRecovery({ home: "/home/user", dataDir: "/data", agents, operationId,
    platform: "darwin", helper: intentOnly.helper, acquireProviderHomeLease: () => {} }).status, "not_needed");
  assert.equal(intentOnly.restores.length, 0);
  assert.deepEqual(intentOnly.inspections.every((entry) => entry.operationId === operationId), true);

  assert.equal(restoreSkillAdoptionRecovery({ home: "/home/user", dataDir: "/data", agents,
    operationId: "../../outside", platform: "darwin", helper: intentOnly.helper,
    acquireProviderHomeLease: () => assert.fail("must not lease") }).status, "blocked");
  assert.equal(restoreSkillAdoptionRecovery({ home: "/home/user", dataDir: "/data", agents, operationId,
    platform: "freebsd", acquireProviderHomeLease: () => assert.fail("must not lease") }).status, "blocked");
});
