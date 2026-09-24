import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentDefinition, MachineSkillCandidate } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import type { RunnerProviderAccount } from "./config.js";
import {
  listMacosSkillCandidates,
  macosAdoptionArguments,
  macosAdoptionOutcome,
  macosRestoreArguments,
  macosSkillAdoptionHelper,
  parseMacosRecoveryInspection,
  readMacosSkillCandidate,
  resolveMacosSkillSnapshotHelper,
} from "./macos-skill-snapshots.js";
import { adoptMachineSkill, type SkillAdoptionOptions } from "./skill-adoption.js";
import { listSkillAdoptionRecovery, restoreSkillAdoptionRecovery } from "./skill-adoption-recovery.js";
import { MachineSkillSnapshots } from "./skill-snapshots.js";
import { cacheSkillSyncEntry, reconcileSkills } from "./skills.js";

// The helper is native macOS code. Another POSIX host can exercise it only with an explicitly
// supplied build that maps the same descriptor primitives.
const override = process.env.WOLLIPOG_TEST_MACOS_SKILL_HELPER;
const native = { skip: process.platform !== "darwin" && !override };
const helperPath = () => override || resolveMacosSkillSnapshotHelper();
const agents: AgentDefinition[] = [
  { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" },
  { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code" },
];
const u32 = (value: number) => { const result = Buffer.alloc(4); result.writeUInt32LE(value); return result; };
const blob = (value: string) => Buffer.concat([u32(Buffer.byteLength(value)), Buffer.from(value)]);
const operationId = "123e4567-e89b-42d3-a456-426614174000";

test("macOS recovery inspection output is strictly projected", () => {
  const record = (kind: number, sourceIdentity: string, role: number) => Buffer.concat([
    blob(operationId), blob("{\"intent\":true}"), blob("alpha"), blob("d".repeat(64)), blob("1:3"),
    Buffer.from([kind]), blob(sourceIdentity), Buffer.from([role]),
  ]);
  const output = (records: Buffer[], parent = "1:2", truncated = 0) =>
    Buffer.concat([Buffer.from("WMS1I"), blob(parent), u32(records.length), ...records, Buffer.from([truncated])]);
  assert.deepEqual(parseMacosRecoveryInspection(output([record(2, "", 1), record(1, "1:3", 0)], "1:2", 1)), {
    parentIdentity: "1:2", truncated: true, journals: [
      { operationId, intent: "{\"intent\":true}", name: "alpha", digest: "d".repeat(64), originalIdentity: "1:3",
        source: { kind: "link", role: "managed" } },
      { operationId, intent: "{\"intent\":true}", name: "alpha", digest: "d".repeat(64), originalIdentity: "1:3",
        source: { kind: "directory", identity: "1:3" } },
    ],
  });
  assert.deepEqual(parseMacosRecoveryInspection(output([], "")), { parentIdentity: null, journals: [], truncated: false });
  for (const invalid of [
    output([record(2, "", 0)]),
    output([record(0, "", 1)]),
    output([record(3, "1:3", 0)]),
    output([record(4, "", 0)]),
    output([record(0, "", 0)], ""),
    output([], "../2"),
    output([], "1:2", 2),
    Buffer.concat([output([]), Buffer.from("extra")]),
  ]) assert.throws(() => parseMacosRecoveryInspection(invalid));
});

test("macOS adoption progress distinguishes a clean refusal from recovery evidence", () => {
  assert.deepEqual(macosAdoptionOutcome(["journal", "adopted", ""], true), { journal: true, adopted: true });
  assert.deepEqual(macosAdoptionOutcome(["journal", "adopted", ""], false), { journal: true, adopted: false });
  assert.deepEqual(macosAdoptionOutcome(["journal", ""], false), { journal: true, adopted: false });
  assert.deepEqual(macosAdoptionOutcome([""], false), { journal: false, adopted: false });
});

function fixture(t: TestContext, sourceDirectory = ".codex/skills") {
  const root = fs.mkdtempSync(join(tmpdir(), "macos-skill-adoption-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), dataDir = join(root, "data");
  const parent = join(home, sourceDirectory), source = join(parent, "alpha");
  fs.mkdirSync(join(source, "scripts"), { recursive: true });
  fs.mkdirSync(join(source, "notes/é"), { recursive: true });
  fs.mkdirSync(dataDir);
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: alpha\n---\nOriginal instructions");
  fs.writeFileSync(join(source, "scripts/run.sh"), "echo must-not-execute", { mode: 0o644 });
  fs.writeFileSync(join(source, "binary"), Buffer.from([0, 255, 254]));
  // Names that exercise the helper's JSON escaping and UTF-16 ordering of the canonical digest.
  fs.writeFileSync(join(source, "notes/q\"uote.md"), "quoted");
  fs.writeFileSync(join(source, "notes/é/😀.md"), "astral");
  fs.writeFileSync(join(source, "notes/Ａ.md"), "fullwidth");
  const helper = helperPath();
  const snapshots = new MachineSkillSnapshots({ home, agents: () => agents, platform: "darwin",
    macosList: (base, directories) => listMacosSkillCandidates(base, directories, helper),
    macosRead: (base, candidate) => readMacosSkillCandidate(base, candidate, helper) });
  const message = { type: "skill_snapshot" as const, operation: "list" as const, runnerId: "one", requestId: "one" };
  const candidate = snapshots.handle(message).candidates!.find((entry) => entry.sourceDirectory === sourceDirectory)!;
  assert.ok(candidate, "the native reader offers the fixture source");
  const snapshot = snapshots.handle({ ...message, operation: "read", candidateId: candidate.id }).snapshot!;
  assert.equal(snapshot.digest, skillVersionDigest(snapshot.files));
  const entry = { name: "alpha", files: snapshot.files, versionDigest: snapshot.digest,
    targets: [{ agentId: "codex", invocation: "agent" as const }] };
  cacheSkillSyncEntry(dataDir, agents, entry);
  const options: SkillAdoptionOptions = { home, dataDir, agents, candidate, digest: snapshot.digest,
    platform: "darwin", helper: macosSkillAdoptionHelper(helper),
    acquireProviderHomeLease: () => undefined, assertAuthorized: () => undefined };
  const backups = () => fs.readdirSync(parent).filter((name) => name.startsWith(".wollipog-adoption-"));
  const recovery = { platform: "darwin" as const, helper: macosSkillAdoptionHelper(helper) };
  const restore = (id: string) => restoreSkillAdoptionRecovery({ home, dataDir, agents, operationId: id,
    acquireProviderHomeLease: () => undefined, ...recovery });
  const target = join(dataDir, "skills/store/alpha", snapshot.digest);
  return { root, home, dataDir, parent, source, entry, options, backups, recovery, restore, target, helper,
    candidate: candidate as MachineSkillCandidate };
}

/** Pause the real helper at one test-only checkpoint, act on the filesystem, then resume, fail,
 * or kill it. The runner itself never sets the checkpoint variable. */
async function atCheckpoint(helper: string, args: string[], stage: string, command: "c" | "f" | "k",
  action: () => void = () => {}) {
  const child = spawn(helper, args, { env: { WOLLIPOG_SKILL_ADOPTION_TEST_CHECKPOINT: stage },
    stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let stdout = "";
  let paused = false;
  let failure: unknown;
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (paused || !stdout.includes("checkpoint\n")) return;
    paused = true;
    try { action(); } catch (error) { failure = error; }
    child.stdin.end(command);
  });
  const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  clearTimeout(timer);
  if (failure) throw failure;
  assert.ok(paused, `the helper reached ${stage}`);
  return { code, signal, lines: stdout.split("\n") };
}

function adoptionArguments(f: ReturnType<typeof fixture>, id = operationId) {
  return macosAdoptionArguments({ home: f.home, localSourceDirectory: f.candidate.sourceDirectory,
    sourceDirectory: f.candidate.sourceDirectory, name: "alpha", generation: f.candidate.generation,
    digest: f.options.digest, dataDir: f.dataDir, operationId: id });
}

for (const sourceDirectory of [".codex/skills", ".agents/skills"]) {
  test(`macOS adoption preserves the original and publishes a reconcile-compatible link from ${sourceDirectory}`,
    native, async (t) => {
      const f = fixture(t, sourceDirectory);
      const before = fs.statSync(f.source);
      const result = adoptMachineSkill(f.options);
      assert.equal(result.status, "adopted", JSON.stringify(result));
      if (result.status !== "adopted") return;
      const backup = join(f.home, result.backupDirectory);
      assert.equal(fs.statSync(join(backup, "original")).ino, before.ino, "original directory is renamed, not copied");
      assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
      assert.equal(fs.statSync(join(backup, "intent.json")).mode & 0o777, 0o600);
      const intent = JSON.parse(fs.readFileSync(join(backup, "intent.json"), "utf8"));
      assert.deepEqual([intent.format, intent.operationId, intent.sourceDirectory, intent.digest, intent.generation],
        [1, result.operationId, sourceDirectory, f.options.digest, f.candidate.generation]);
      assert.ok(fs.existsSync(join(backup, "preserved.json")));
      assert.ok(fs.existsSync(join(backup, "linked.json")));
      assert.equal(fs.statSync(join(backup, "original/scripts/run.sh")).mode & 0o777, 0o644);
      assert.deepEqual(fs.readFileSync(join(backup, "original/binary")), Buffer.from([0, 255, 254]));
      assert.equal(fs.readlinkSync(f.source), join(fs.realpathSync(f.dataDir), "skills/store/alpha", f.options.digest));
      assert.equal(adoptMachineSkill(f.options).status, "rejected", "a stale retry never replaces the new link");
      assert.equal(f.backups().length, 1);

      const listed = listSkillAdoptionRecovery(f.home, f.dataDir, agents, [], f.recovery);
      assert.deepEqual(listed.operations.map((entry) => [entry.operationId, entry.state]),
        [[result.operationId, "managed_linked"]]);
      const deployed = await reconcileSkills({ dataDir: f.dataDir, home: f.home, agents, desired: [f.entry],
        acquireProviderHomeLease: () => {} });
      assert.equal(deployed.error, undefined);
      assert.equal(deployed.deployed[0]!.links.find((link) => link.agentId === "codex")!.status, "linked");
      assert.equal(fs.realpathSync(join(f.home, ".codex/skills/alpha")), fs.realpathSync(join(f.home, ".agents/skills/alpha")));
      await reconcileSkills({ dataDir: f.dataDir, home: f.home, agents, desired: [], allowRemovals: true,
        acquireProviderHomeLease: () => {} });
      assert.ok(fs.existsSync(join(backup, "original/SKILL.md")), "normal disable keeps preserved source content");
    });
}

test("macOS recovery restores an adopted source and keeps its managed link in the journal", native, (t) => {
  const f = fixture(t);
  const before = fs.statSync(f.source);
  const adopted = adoptMachineSkill(f.options);
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  const restored = f.restore(adopted.operationId);
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(restored.operation?.state, "restored");
  assert.equal(fs.lstatSync(f.source).isSymbolicLink(), true);
  assert.equal(fs.statSync(f.source).ino, before.ino);
  assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/u);
  const backup = join(f.home, adopted.backupDirectory);
  assert.equal(fs.readlinkSync(join(backup, "managed-link")), fs.realpathSync(f.target));
  for (const record of ["restore-intent.json", "managed-link-preserved.json", "restored.json"]) {
    assert.ok(fs.existsSync(join(backup, record)), record);
  }
  assert.equal(f.restore(adopted.operationId).status, "not_needed");
});

for (const problem of ["changed-source", "bad-generation", "missing-store", "changed-store", "source-link",
  "store-link", "hard-link", "executable", "unsupported-source"]) {
  test(`macOS adoption rejects ${problem} before replacing the source`, native, (t) => {
    const f = fixture(t);
    if (problem === "changed-source") fs.writeFileSync(join(f.source, "scripts/run.sh"), "edited nested content");
    if (problem === "bad-generation") f.options.candidate = { ...f.options.candidate, generation: "0".repeat(64) };
    if (problem === "missing-store") fs.renameSync(f.target, f.target + "-removed");
    if (problem === "changed-store") fs.writeFileSync(join(f.target, "SKILL.md"), "corrupt stored bytes");
    if (problem === "source-link") { fs.renameSync(f.source, f.source + "-original"); fs.symlinkSync(f.source + "-original", f.source); }
    if (problem === "store-link") { fs.renameSync(f.target, f.target + "-original"); fs.symlinkSync(f.target + "-original", f.target); }
    if (problem === "hard-link") fs.linkSync(join(f.source, "SKILL.md"), join(f.root, "hard-link"));
    if (problem === "executable") fs.chmodSync(join(f.source, "scripts/run.sh"), 0o755);
    if (problem === "unsupported-source") f.options.candidate = { ...f.options.candidate, sourceDirectory: "../../outside" };
    const result = adoptMachineSkill(f.options);
    assert.equal(result.status, "rejected");
    assert.doesNotMatch(JSON.stringify(result), /Original instructions/u);
    assert.ok(fs.existsSync(join(f.source, "SKILL.md")));
    assert.deepEqual(f.backups(), []);
  });
}

for (const stage of ["intent_durable", "source_preserved", "link_created"] as const) {
  test(`macOS helper death at ${stage} leaves inspectable recovery evidence and original content`, native, async (t) => {
    const f = fixture(t);
    const run = await atCheckpoint(f.helper, adoptionArguments(f), stage, "k");
    assert.equal(run.signal, "SIGKILL");
    assert.deepEqual(macosAdoptionOutcome(run.lines, false), { journal: true, adopted: false });
    assert.equal(f.backups().length, 1);
    const backup = join(f.parent, f.backups()[0]!);
    assert.ok(fs.existsSync(join(backup, "intent.json")));
    const original = stage === "intent_durable" ? f.source : join(backup, "original");
    assert.match(fs.readFileSync(join(original, "SKILL.md"), "utf8"), /Original instructions/u);
    assert.equal(fs.existsSync(join(backup, "linked.json")), false);
    if (stage === "source_preserved") assert.equal(fs.existsSync(f.source), false);
    if (stage === "link_created") assert.ok(fs.lstatSync(f.source).isSymbolicLink());
    const listed = listSkillAdoptionRecovery(f.home, f.dataDir, agents, [], f.recovery);
    assert.deepEqual(listed.operations.map((entry) => entry.state), [
      stage === "intent_durable" ? "intent_only" : stage === "source_preserved" ? "source_preserved" : "managed_linked",
    ]);
    const restored = f.restore(operationId);
    assert.equal(restored.status, stage === "intent_durable" ? "not_needed" : "restored", JSON.stringify(restored));
    assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/u);
  });
}

test("macOS adoption never overwrites a concurrent source occupant", native, async (t) => {
  const f = fixture(t);
  const run = await atCheckpoint(f.helper, adoptionArguments(f), "source_preserved", "c", () => {
    fs.mkdirSync(f.source);
    fs.writeFileSync(join(f.source, "new-user-file"), "keep me");
  });
  assert.equal(run.code, 1);
  assert.deepEqual(macosAdoptionOutcome(run.lines, false), { journal: true, adopted: false });
  assert.equal(fs.readFileSync(join(f.source, "new-user-file"), "utf8"), "keep me");
  assert.match(fs.readFileSync(join(f.parent, f.backups()[0]!, "original/SKILL.md"), "utf8"), /Original instructions/u);
  const listed = listSkillAdoptionRecovery(f.home, f.dataDir, agents, [], f.recovery);
  assert.deepEqual(listed.operations.map((entry) => entry.state), ["blocked"]);
  assert.equal(f.restore(operationId).status, "blocked");
  assert.equal(fs.readFileSync(join(f.source, "new-user-file"), "utf8"), "keep me");
});

test("macOS adoption detects a replaced link, a store edit, and a moved source before completion", native, async (t) => {
  const replaced = fixture(t);
  const link = await atCheckpoint(replaced.helper, adoptionArguments(replaced), "link_created", "c", () => {
    fs.unlinkSync(replaced.source);
    fs.mkdirSync(replaced.source);
  });
  assert.deepEqual(macosAdoptionOutcome(link.lines, link.code === 0), { journal: true, adopted: false });
  assert.ok(fs.lstatSync(replaced.source).isDirectory());

  const edited = fixture(t);
  const store = await atCheckpoint(edited.helper, adoptionArguments(edited), "link_created", "c", () => {
    fs.writeFileSync(join(edited.target, "SKILL.md"), "concurrent store edit");
  });
  assert.deepEqual(macosAdoptionOutcome(store.lines, store.code === 0), { journal: true, adopted: false });
  assert.equal(fs.existsSync(join(edited.parent, edited.backups()[0]!, "linked.json")), false);
  assert.match(fs.readFileSync(join(edited.parent, edited.backups()[0]!, "original/SKILL.md"), "utf8"),
    /Original instructions/u);

  const moved = fixture(t);
  const swap = await atCheckpoint(moved.helper, adoptionArguments(moved), "intent_durable", "c", () => {
    fs.renameSync(moved.source, moved.source + "-user-moved");
    fs.mkdirSync(moved.source);
    fs.writeFileSync(join(moved.source, "SKILL.md"), "replacement content");
  });
  assert.deepEqual(macosAdoptionOutcome(swap.lines, swap.code === 0), { journal: true, adopted: false });
  assert.match(fs.readFileSync(join(moved.source + "-user-moved", "SKILL.md"), "utf8"), /Original instructions/u);
  assert.equal(fs.readFileSync(join(moved.source, "SKILL.md"), "utf8"), "replacement content");
});

test("a macOS parent symlink swap cannot redirect writes outside the pinned parent", native, async (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside"), moved = join(f.home, ".codex/moved");
  fs.mkdirSync(outside);
  const run = await atCheckpoint(f.helper, adoptionArguments(f), "source_preserved", "c", () => {
    fs.renameSync(f.parent, moved);
    fs.symlinkSync(outside, f.parent);
  });
  assert.deepEqual(macosAdoptionOutcome(run.lines, run.code === 0), { journal: true, adopted: false });
  assert.deepEqual(fs.readdirSync(outside), []);
  const backupName = fs.readdirSync(moved).find((name) => name.startsWith(".wollipog-adoption-"))!;
  assert.match(fs.readFileSync(join(moved, backupName, "original/SKILL.md"), "utf8"), /Original instructions/u);
});

test("a retargeted data-directory symlink cannot separate the verified store from the published link", native,
  async (t) => {
    const f = fixture(t);
    const verified = f.dataDir + "-verified", replacement = f.dataDir + "-replacement";
    fs.renameSync(f.dataDir, verified);
    fs.symlinkSync(verified, f.dataDir);
    fs.cpSync(verified, replacement, { recursive: true });
    fs.writeFileSync(join(replacement, "skills/store/alpha", f.options.digest, "SKILL.md"), "unverified content");
    const run = await atCheckpoint(f.helper, adoptionArguments(f), "intent_durable", "c", () => {
      fs.unlinkSync(f.dataDir);
      fs.symlinkSync(replacement, f.dataDir);
    });
    assert.deepEqual(macosAdoptionOutcome(run.lines, run.code === 0), { journal: true, adopted: true });
    assert.equal(fs.readlinkSync(f.source), join(fs.realpathSync(verified), "skills/store/alpha", f.options.digest));
    assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/u);
  });

for (const stage of ["restore_intent_durable", "managed_link_preserved", "recovery_link_created"] as const) {
  test(`macOS restore retries safely after interruption at ${stage}`, native, async (t) => {
    const f = fixture(t);
    const adopted = adoptMachineSkill(f.options);
    assert.equal(adopted.status, "adopted");
    if (adopted.status !== "adopted") return;
    const intent = JSON.parse(fs.readFileSync(join(f.home, adopted.backupDirectory, "intent.json"), "utf8"));
    const run = await atCheckpoint(f.helper, macosRestoreArguments({ home: f.home,
      localSourceDirectory: ".codex/skills", dataDir: f.dataDir, operationId: adopted.operationId, name: "alpha",
      digest: f.options.digest, parentIdentity: intent.parentIdentity, sourceIdentity: intent.sourceIdentity }),
    stage, "f");
    assert.equal(run.code, 1);
    const retry = f.restore(adopted.operationId);
    assert.ok(retry.status === "restored" || retry.status === "not_needed", JSON.stringify(retry));
    assert.equal(fs.lstatSync(f.source).isSymbolicLink(), true);
    assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/u);
  });
}

test("macOS account-scoped adoption and recovery stay in the selected credential home", native, (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "macos-skill-adoption-account-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), dataDir = join(root, "data"), accountHome = join(root, "work");
  const accounts: RunnerProviderAccount[] = [{ id: "work", label: "Work", provider: "claude", directory: accountHome }];
  fs.mkdirSync(join(accountHome, "skills/alpha"), { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(join(accountHome, "skills/alpha/SKILL.md"), "---\nname: alpha\n---\nAccount original");
  const helper = helperPath();
  const [listed] = listMacosSkillCandidates(accountHome, ["skills"], helper);
  assert.ok(listed);
  const candidate: MachineSkillCandidate = { id: "account", ...listed, sourceDirectory: ".claude/skills",
    providerAccountId: "work" };
  const files = readMacosSkillCandidate(accountHome, { ...candidate, sourceDirectory: "skills" }, helper).files;
  const digest = skillVersionDigest(files);
  cacheSkillSyncEntry(dataDir, agents, { name: "alpha", versionDigest: digest, files,
    targets: [{ agentId: "claude", invocation: "agent" }] });
  const platform = { platform: "darwin" as const, helper: macosSkillAdoptionHelper(helper) };
  const adopted = adoptMachineSkill({ home: accountHome, localSourceDirectory: "skills", dataDir, agents, candidate,
    digest, acquireProviderHomeLease: () => undefined, assertAuthorized: () => undefined, ...platform });
  assert.equal(adopted.status, "adopted", JSON.stringify(adopted));
  if (adopted.status !== "adopted") return;
  assert.equal(adopted.providerAccountId, "work");
  assert.ok(fs.lstatSync(join(accountHome, "skills/alpha")).isSymbolicLink());
  const intent = JSON.parse(fs.readFileSync(join(accountHome, "skills", `.wollipog-adoption-${adopted.operationId}`,
    "intent.json"), "utf8"));
  assert.deepEqual([intent.format, intent.localSourceDirectory, intent.providerAccountId], [2, "skills", "work"]);
  assert.deepEqual(listSkillAdoptionRecovery(home, dataDir, agents, accounts, platform).operations.map((operation) =>
    [operation.providerAccountId, operation.sourceDirectory, operation.state]), [["work", ".claude/skills", "managed_linked"]]);
  const leased: string[] = [];
  const restored = restoreSkillAdoptionRecovery({ home, dataDir, agents, providerAccounts: accounts,
    operationId: adopted.operationId, acquireProviderHomeLease: (credentialHome) => { leased.push(credentialHome); },
    ...platform });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(restored.operation?.providerAccountId, "work");
  assert.deepEqual(leased, [accountHome]);
});
