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
import { adoptMachineSkill, type SkillAdoptionOptions } from "./skill-adoption.js";
import { listSkillAdoptionRecovery, restoreSkillAdoptionRecovery } from "./skill-adoption-recovery.js";
import { MachineSkillSnapshots } from "./skill-snapshots.js";
import { cacheSkillSyncEntry, reconcileSkills } from "./skills.js";
import {
  parseWindowsRecoveryInspection,
  WINDOWS_SKILL_ADOPTION_HELPER,
  windowsAdoptionInvocation,
  windowsAdoptionOutcome,
  windowsAdoptionSpecification,
  windowsRestoreSpecification,
} from "./windows-skill-adoption.js";
import { listWindowsSkillCandidates, readWindowsSkillCandidate } from "./windows-skill-snapshots.js";

const native = { skip: process.platform !== "win32" };
const agents: AgentDefinition[] = [
  { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" },
  { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code" },
];
const operationId = "123e4567-e89b-42d3-a456-426614174000";

test("the Windows adoption helper pins handles, renames relative to the journal, and never deletes", () => {
  assert.match(WINDOWS_SKILL_ADOPTION_HELPER, /FILE_FLAG_OPEN_REPARSE_POINT/u);
  assert.match(WINDOWS_SKILL_ADOPTION_HELPER, /GENERIC_READ \| DELETE, FILE_SHARE_READ \| FILE_SHARE_WRITE,/u,
    "the source is pinned with DELETE access and without delete sharing");
  assert.match(WINDOWS_SKILL_ADOPTION_HELPER, /NtSetInformationFile/u);
  assert.match(WINDOWS_SKILL_ADOPTION_HELPER, /CreateDirectoryW/u);
  assert.match(WINDOWS_SKILL_ADOPTION_HELPER, /FSCTL_SET_REPARSE_POINT/u);
  assert.match(WINDOWS_SKILL_ADOPTION_HELPER, /WollipogWindowsSkillSnapshots\.DirectoryGeneration/u,
    "discovery generation comes from the snapshot reader itself");
  assert.doesNotMatch(WINDOWS_SKILL_ADOPTION_HELPER,
    /Directory\.Delete|File\.Delete|DeleteFileW|RemoveDirectoryW|Remove-Item|MOVEFILE_REPLACE_EXISTING/u);
});

test("Windows recovery inspection output is strictly projected", () => {
  const journal = (overrides: Record<string, unknown> = {}) => ({ OperationId: operationId, Intent: "{}", Name: "alpha",
    Digest: "d".repeat(64), OriginalIdentity: "1:3", Kind: 2, SourceIdentity: "", Role: 1, Extra: "discarded",
    ...overrides });
  assert.deepEqual(parseWindowsRecoveryInspection({ parentIdentity: "1:2", truncated: true,
    journals: [journal(), journal({ Kind: 1, Role: 0, SourceIdentity: "1:3" })] }), {
    parentIdentity: "1:2", truncated: true, journals: [
      { operationId, intent: "{}", name: "alpha", digest: "d".repeat(64), originalIdentity: "1:3",
        source: { kind: "link", role: "managed" } },
      { operationId, intent: "{}", name: "alpha", digest: "d".repeat(64), originalIdentity: "1:3",
        source: { kind: "directory", identity: "1:3" } },
    ],
  });
  assert.deepEqual(parseWindowsRecoveryInspection({ parentIdentity: "", journals: [], truncated: false }),
    { parentIdentity: null, journals: [], truncated: false });
  for (const invalid of [
    null,
    { parentIdentity: "1:2", journals: [journal({ Role: 0 })], truncated: false },
    { parentIdentity: "1:2", journals: [journal({ Kind: 0, Role: 1 })], truncated: false },
    { parentIdentity: "1:2", journals: [journal({ Kind: 3, Role: 0, SourceIdentity: "1:3" })], truncated: false },
    { parentIdentity: "1:2", journals: [journal({ Kind: 4, Role: 0 })], truncated: false },
    { parentIdentity: "1:2", journals: [journal({ Name: "../alpha" })], truncated: false },
    { parentIdentity: "1:2", journals: [journal({ OperationId: "../x" })], truncated: false },
    { parentIdentity: "", journals: [journal()], truncated: false },
    { parentIdentity: "C:\\Users", journals: [], truncated: false },
    { parentIdentity: "1:2", journals: [], truncated: "no" },
  ]) assert.throws(() => parseWindowsRecoveryInspection(invalid));
});

test("Windows adoption progress distinguishes a clean refusal from recovery evidence", () => {
  assert.deepEqual(windowsAdoptionOutcome(["journal", "adopted", ""], true), { journal: true, adopted: true });
  assert.deepEqual(windowsAdoptionOutcome(["journal", "adopted", ""], false), { journal: true, adopted: false });
  assert.deepEqual(windowsAdoptionOutcome(["journal", ""], false), { journal: true, adopted: false });
  assert.deepEqual(windowsAdoptionOutcome([""], false), { journal: false, adopted: false });
});

function fixture(t: TestContext, sourceDirectory = ".codex/skills") {
  const root = fs.mkdtempSync(join(tmpdir(), "windows-skill-adoption-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const home = join(root, "home"), dataDir = join(root, "data");
  const parent = join(home, ...sourceDirectory.split("/")), source = join(parent, "alpha");
  fs.mkdirSync(join(source, "scripts"), { recursive: true });
  fs.mkdirSync(join(source, "notes", "é"), { recursive: true });
  fs.mkdirSync(dataDir);
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: alpha\n---\nOriginal instructions");
  fs.writeFileSync(join(source, "scripts", "run.ps1"), "Write-Output must-not-execute");
  fs.writeFileSync(join(source, "binary"), Buffer.from([0, 255, 254]));
  // Names that exercise UTF-16 ordering and UTF-8 encoding of the canonical digest.
  fs.writeFileSync(join(source, "notes", "é", "😀.md"), "astral");
  fs.writeFileSync(join(source, "notes", "\uff21.md"), "fullwidth");
  const snapshots = new MachineSkillSnapshots({ home, agents: () => agents });
  const message = { type: "skill_snapshot" as const, operation: "list" as const, runnerId: "one", requestId: "one" };
  const candidate = snapshots.handle(message).candidates!.find((entry) => entry.sourceDirectory === sourceDirectory)!;
  assert.ok(candidate, "the native reader offers the fixture source");
  const snapshot = snapshots.handle({ ...message, operation: "read", candidateId: candidate.id }).snapshot!;
  assert.equal(snapshot.digest, skillVersionDigest(snapshot.files));
  const entry = { name: "alpha", files: snapshot.files, versionDigest: snapshot.digest,
    targets: [{ agentId: "codex", invocation: "agent" as const }] };
  cacheSkillSyncEntry(dataDir, agents, entry);
  const options: SkillAdoptionOptions = { home, dataDir, agents, candidate, digest: snapshot.digest,
    acquireProviderHomeLease: () => undefined, assertAuthorized: () => undefined };
  const backups = () => fs.readdirSync(parent).filter((name) => name.startsWith(".wollipog-adoption-"));
  const restore = (id: string) => restoreSkillAdoptionRecovery({ home, dataDir, agents, operationId: id,
    acquireProviderHomeLease: () => undefined });
  const target = join(dataDir, "skills", "store", "alpha", snapshot.digest);
  return { root, home, dataDir, parent, source, entry, options, backups, restore, target,
    candidate: candidate as MachineSkillCandidate };
}

/** Pause the real helper at one test-only checkpoint, act on the filesystem, then release it with
 * continue, fail, or kill. The runner strips both checkpoint variables from its own launches. */
async function atCheckpoint(specification: Record<string, unknown>, stage: string, command: "c" | "f" | "k",
  action: () => void = () => {}) {
  const control = join(fs.mkdtempSync(join(tmpdir(), "windows-adoption-control-")), "command");
  const invocation = windowsAdoptionInvocation(specification);
  const child = spawn(invocation.command, invocation.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WOLLIPOG_SKILL_ADOPTION_SPEC: invocation.specification,
      WOLLIPOG_SKILL_ADOPTION_TEST_CHECKPOINT: stage, WOLLIPOG_SKILL_ADOPTION_TEST_CONTROL: control } });
  const timer = setTimeout(() => child.kill(), 120_000);
  let stdout = "", stderr = "";
  let paused = false;
  let failure: unknown;
  child.stdin.end(invocation.input);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (paused || !/^checkpoint\r?$/mu.test(stdout)) return;
    paused = true;
    try { action(); } catch (error) { failure = error; }
    fs.writeFileSync(`${control}.tmp`, command);
    fs.renameSync(`${control}.tmp`, control);
  });
  const [code] = await once(child, "close") as [number | null];
  clearTimeout(timer);
  if (failure) throw failure;
  assert.ok(paused, `the helper reached ${stage}: ${stderr}`);
  return { code, lines: stdout.split(/\r?\n/u), stderr };
}

function adoptionSpecification(f: ReturnType<typeof fixture>, id = operationId) {
  return windowsAdoptionSpecification({ home: f.home, localSourceDirectory: f.candidate.sourceDirectory,
    sourceDirectory: f.candidate.sourceDirectory, name: "alpha", generation: f.candidate.generation,
    digest: f.options.digest, dataDir: f.dataDir, operationId: id });
}

for (const sourceDirectory of [".codex/skills", ".agents/skills"]) {
  test(`Windows adoption preserves the original and publishes a reconcile-compatible junction from ${sourceDirectory}`,
    native, async (t) => {
      const f = fixture(t, sourceDirectory);
      const before = fs.statSync(f.source, { bigint: true });
      const result = adoptMachineSkill(f.options);
      assert.equal(result.status, "adopted", JSON.stringify(result));
      if (result.status !== "adopted") return;
      const backup = join(f.home, ...result.backupDirectory.split("/"));
      assert.equal(fs.statSync(join(backup, "original"), { bigint: true }).ino, before.ino,
        "the original directory is renamed, not copied");
      const intent = JSON.parse(fs.readFileSync(join(backup, "intent.json"), "utf8"));
      assert.deepEqual([intent.format, intent.operationId, intent.sourceDirectory, intent.digest, intent.generation],
        [1, result.operationId, sourceDirectory, f.options.digest, f.candidate.generation]);
      assert.ok(fs.existsSync(join(backup, "preserved.json")));
      assert.ok(fs.existsSync(join(backup, "linked.json")));
      assert.deepEqual(fs.readFileSync(join(backup, "original", "binary")), Buffer.from([0, 255, 254]));
      assert.ok(fs.lstatSync(f.source).isSymbolicLink(), "the managed link is a junction");
      assert.equal(fs.realpathSync(f.source).toLowerCase(), fs.realpathSync(f.target).toLowerCase());
      assert.equal(adoptMachineSkill(f.options).status, "rejected", "a stale retry never replaces the new link");
      assert.equal(f.backups().length, 1);

      const listed = listSkillAdoptionRecovery(f.home, f.dataDir, agents);
      assert.deepEqual(listed.operations.map((entry) => [entry.operationId, entry.state]),
        [[result.operationId, "managed_linked"]]);
      const deployed = await reconcileSkills({ dataDir: f.dataDir, home: f.home, agents, desired: [f.entry],
        acquireProviderHomeLease: () => {} });
      assert.equal(deployed.error, undefined);
      assert.equal(deployed.deployed[0]!.links.find((link) => link.agentId === "codex")!.status, "linked",
        "reconciliation recognizes the adopted junction as managed");
      assert.equal(fs.realpathSync(join(f.home, ".codex", "skills", "alpha")),
        fs.realpathSync(join(f.home, ".agents", "skills", "alpha")));
      await reconcileSkills({ dataDir: f.dataDir, home: f.home, agents, desired: [], allowRemovals: true,
        acquireProviderHomeLease: () => {} });
      assert.ok(fs.existsSync(join(backup, "original", "SKILL.md")), "normal disable keeps preserved source content");
    });
}

test("Windows recovery restores an adopted source and keeps its managed junction in the journal", native, (t) => {
  const f = fixture(t);
  const adopted = adoptMachineSkill(f.options);
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  const restored = f.restore(adopted.operationId);
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(restored.operation?.state, "restored");
  assert.ok(fs.lstatSync(f.source).isSymbolicLink());
  assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/u);
  const backup = join(f.home, ...adopted.backupDirectory.split("/"));
  assert.equal(fs.realpathSync(join(backup, "managed-link")).toLowerCase(), fs.realpathSync(f.target).toLowerCase());
  for (const record of ["restore-intent.json", "managed-link-preserved.json", "restored.json"]) {
    assert.ok(fs.existsSync(join(backup, record)), record);
  }
  assert.equal(f.restore(adopted.operationId).status, "not_needed");
});

for (const problem of ["changed-source", "bad-generation", "missing-store", "changed-store", "source-junction",
  "store-junction", "hard-link", "unsupported-source"]) {
  test(`Windows adoption rejects ${problem} before replacing the source`, native, (t) => {
    const f = fixture(t);
    if (problem === "changed-source") fs.writeFileSync(join(f.source, "scripts", "run.ps1"), "edited nested content");
    if (problem === "bad-generation") f.options.candidate = { ...f.options.candidate, generation: "0".repeat(64) };
    if (problem === "missing-store") fs.renameSync(f.target, f.target + "-removed");
    if (problem === "changed-store") fs.writeFileSync(join(f.target, "SKILL.md"), "corrupt stored bytes");
    if (problem === "source-junction") {
      fs.renameSync(f.source, f.source + "-original");
      fs.symlinkSync(f.source + "-original", f.source, "junction");
    }
    if (problem === "store-junction") {
      fs.renameSync(f.target, f.target + "-original");
      fs.symlinkSync(f.target + "-original", f.target, "junction");
    }
    if (problem === "hard-link") fs.linkSync(join(f.source, "SKILL.md"), join(f.root, "hard-link"));
    if (problem === "unsupported-source") f.options.candidate = { ...f.options.candidate, sourceDirectory: "../../outside" };
    const result = adoptMachineSkill(f.options);
    assert.equal(result.status, "rejected", JSON.stringify(result));
    assert.ok(fs.existsSync(join(f.source, "SKILL.md")));
    assert.deepEqual(f.backups(), []);
  });
}

for (const stage of ["intent_durable", "source_preserved", "link_created"] as const) {
  test(`Windows helper death at ${stage} leaves inspectable recovery evidence and original content`, native,
    async (t) => {
      const f = fixture(t);
      const run = await atCheckpoint(adoptionSpecification(f), stage, "k");
      assert.notEqual(run.code, 0);
      assert.deepEqual(windowsAdoptionOutcome(run.lines, false), { journal: true, adopted: false });
      assert.equal(f.backups().length, 1);
      const backup = join(f.parent, f.backups()[0]!);
      assert.ok(fs.existsSync(join(backup, "intent.json")));
      const original = stage === "intent_durable" ? f.source : join(backup, "original");
      assert.match(fs.readFileSync(join(original, "SKILL.md"), "utf8"), /Original instructions/u);
      assert.equal(fs.existsSync(join(backup, "linked.json")), false);
      const listed = listSkillAdoptionRecovery(f.home, f.dataDir, agents);
      assert.deepEqual(listed.operations.map((entry) => entry.state), [
        stage === "intent_durable" ? "intent_only" : stage === "source_preserved" ? "source_preserved" : "managed_linked",
      ]);
      const restored = f.restore(operationId);
      assert.equal(restored.status, stage === "intent_durable" ? "not_needed" : "restored", JSON.stringify(restored));
      assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/u);
    });
}

test("Windows pins the source and harness directory so neither can move during adoption", native, async (t) => {
  const f = fixture(t);
  const attempts: string[] = [];
  const run = await atCheckpoint(adoptionSpecification(f), "intent_durable", "c", () => {
    for (const [from, to] of [[f.source, f.source + "-moved"], [f.parent, f.parent + "-moved"]] as const) {
      try { fs.renameSync(from, to); attempts.push(`moved ${from}`); } catch { attempts.push("refused"); }
    }
  });
  assert.deepEqual(attempts, ["refused", "refused"]);
  assert.deepEqual(windowsAdoptionOutcome(run.lines, run.code === 0), { journal: true, adopted: true });
});

test("Windows adoption never overwrites a concurrent source occupant", native, async (t) => {
  const f = fixture(t);
  const run = await atCheckpoint(adoptionSpecification(f), "source_preserved", "c", () => {
    fs.mkdirSync(f.source);
    fs.writeFileSync(join(f.source, "new-user-file"), "keep me");
  });
  assert.deepEqual(windowsAdoptionOutcome(run.lines, run.code === 0), { journal: true, adopted: false });
  assert.equal(fs.readFileSync(join(f.source, "new-user-file"), "utf8"), "keep me");
  assert.match(fs.readFileSync(join(f.parent, f.backups()[0]!, "original", "SKILL.md"), "utf8"), /Original instructions/u);
  const listed = listSkillAdoptionRecovery(f.home, f.dataDir, agents);
  assert.deepEqual(listed.operations.map((entry) => entry.state), ["blocked"]);
  assert.equal(f.restore(operationId).status, "blocked");
  assert.equal(fs.readFileSync(join(f.source, "new-user-file"), "utf8"), "keep me");
});

test("Windows adoption detects a replaced link and a store edit before completion", native, async (t) => {
  const replaced = fixture(t);
  const link = await atCheckpoint(adoptionSpecification(replaced), "link_created", "c", () => {
    fs.rmdirSync(replaced.source);
    fs.mkdirSync(replaced.source);
  });
  assert.deepEqual(windowsAdoptionOutcome(link.lines, link.code === 0), { journal: true, adopted: false });
  assert.ok(fs.lstatSync(replaced.source).isDirectory());

  const edited = fixture(t);
  const store = await atCheckpoint(adoptionSpecification(edited), "link_created", "c", () => {
    fs.writeFileSync(join(edited.target, "SKILL.md"), "concurrent store edit");
  });
  assert.deepEqual(windowsAdoptionOutcome(store.lines, store.code === 0), { journal: true, adopted: false });
  assert.equal(fs.existsSync(join(edited.parent, edited.backups()[0]!, "linked.json")), false);
  assert.match(fs.readFileSync(join(edited.parent, edited.backups()[0]!, "original", "SKILL.md"), "utf8"),
    /Original instructions/u);
});

test("Windows pins the harness directory and journal so neither can move during restore", native, async (t) => {
  const f = fixture(t);
  const adopted = adoptMachineSkill(f.options);
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  const journal = join(f.home, ...adopted.backupDirectory.split("/"));
  const intent = JSON.parse(fs.readFileSync(join(journal, "intent.json"), "utf8"));
  const attempts: string[] = [];
  const run = await atCheckpoint(windowsRestoreSpecification({ home: f.home, localSourceDirectory: ".codex/skills",
    dataDir: f.dataDir, operationId: adopted.operationId, name: "alpha", digest: f.options.digest,
    parentIdentity: intent.parentIdentity, sourceIdentity: intent.sourceIdentity }), "restore_intent_durable", "c", () => {
    for (const [from, to] of [[journal, join(f.parent, "relocated-journal")], [f.parent, f.parent + "-moved"]] as const) {
      try { fs.renameSync(from, to); attempts.push(`moved ${from}`); } catch { attempts.push("refused"); }
    }
  });
  assert.deepEqual(attempts, ["refused", "refused"]);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.lines.includes("restored"));
  assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/u);
});

test("a targeted Windows restore finds its journal beyond the bounded listing scan", native, (t) => {
  const f = fixture(t);
  const adopted = adoptMachineSkill(f.options);
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  for (let index = 0; index < 4_200; index++) fs.writeFileSync(join(f.parent, `filler-${index}`), "");
  assert.equal(listSkillAdoptionRecovery(f.home, f.dataDir, agents).truncated, true);
  const restored = f.restore(adopted.operationId);
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/u);
});

for (const stage of ["restore_intent_durable", "managed_link_preserved", "recovery_link_created"] as const) {
  test(`Windows restore retries safely after interruption at ${stage}`, native, async (t) => {
    const f = fixture(t);
    const adopted = adoptMachineSkill(f.options);
    assert.equal(adopted.status, "adopted");
    if (adopted.status !== "adopted") return;
    const intent = JSON.parse(fs.readFileSync(join(f.home, ...adopted.backupDirectory.split("/"), "intent.json"), "utf8"));
    const run = await atCheckpoint(windowsRestoreSpecification({ home: f.home, localSourceDirectory: ".codex/skills",
      dataDir: f.dataDir, operationId: adopted.operationId, name: "alpha", digest: f.options.digest,
      parentIdentity: intent.parentIdentity, sourceIdentity: intent.sourceIdentity }), stage, "f");
    assert.notEqual(run.code, 0);
    const retry = f.restore(adopted.operationId);
    assert.ok(retry.status === "restored" || retry.status === "not_needed", JSON.stringify(retry));
    assert.ok(fs.lstatSync(f.source).isSymbolicLink());
    assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/u);
  });
}

test("Windows account-scoped adoption and recovery stay in the selected credential home", native, (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "windows-skill-adoption-account-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const home = join(root, "home"), dataDir = join(root, "data"), accountHome = join(root, "work");
  const accounts: RunnerProviderAccount[] = [{ id: "work", label: "Work", provider: "claude", directory: accountHome }];
  fs.mkdirSync(join(accountHome, "skills", "alpha"), { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(join(accountHome, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\nAccount original");
  const [listed] = listWindowsSkillCandidates(accountHome, ["skills"]);
  assert.ok(listed);
  const candidate: MachineSkillCandidate = { id: "account", ...listed, sourceDirectory: ".claude/skills",
    providerAccountId: "work" };
  const files = readWindowsSkillCandidate(accountHome, { ...candidate, sourceDirectory: "skills" });
  const digest = skillVersionDigest(files);
  cacheSkillSyncEntry(dataDir, agents, { name: "alpha", versionDigest: digest, files,
    targets: [{ agentId: "claude", invocation: "agent" }] });
  const adopted = adoptMachineSkill({ home: accountHome, localSourceDirectory: "skills", dataDir, agents, candidate,
    digest, acquireProviderHomeLease: () => undefined, assertAuthorized: () => undefined });
  assert.equal(adopted.status, "adopted", JSON.stringify(adopted));
  if (adopted.status !== "adopted") return;
  assert.equal(adopted.providerAccountId, "work");
  assert.ok(fs.lstatSync(join(accountHome, "skills", "alpha")).isSymbolicLink());
  const intent = JSON.parse(fs.readFileSync(join(accountHome, "skills", `.wollipog-adoption-${adopted.operationId}`,
    "intent.json"), "utf8"));
  assert.deepEqual([intent.format, intent.localSourceDirectory, intent.providerAccountId], [2, "skills", "work"]);
  assert.deepEqual(listSkillAdoptionRecovery(home, dataDir, agents, accounts).operations.map((operation) =>
    [operation.providerAccountId, operation.sourceDirectory, operation.state]), [["work", ".claude/skills", "managed_linked"]]);
  const leased: string[] = [];
  const restored = restoreSkillAdoptionRecovery({ home, dataDir, agents, providerAccounts: accounts,
    operationId: adopted.operationId, acquireProviderHomeLease: (credentialHome) => { leased.push(credentialHome); } });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(restored.operation?.providerAccountId, "work");
  assert.deepEqual(leased, [accountHome]);
});
