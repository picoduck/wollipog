import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "@wollipog/protocol";
import { linuxNoReplaceRename } from "./linux-skill-rename.js";
import { adoptMachineSkill, type SkillAdoptionOptions } from "./skill-adoption.js";
import { listSkillAdoptionRecovery } from "./skill-adoption-recovery.js";
import { MachineSkillSnapshots } from "./skill-snapshots.js";
import { cacheSkillSyncEntry, reconcileSkills } from "./skills.js";

const linux = { skip: process.platform !== "linux" };
const agents: AgentDefinition[] = [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" }];
function fixture(t: TestContext, sourceDirectory = ".codex/skills") {
  const root = fs.mkdtempSync(join(tmpdir(), "skill-adoption-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), dataDir = join(root, "data");
  const parent = join(home, sourceDirectory), source = join(parent, "alpha");
  fs.mkdirSync(join(source, "scripts"), { recursive: true });
  fs.mkdirSync(dataDir);
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: alpha\n---\nOriginal instructions");
  fs.writeFileSync(join(source, "scripts/run.sh"), "echo must-not-execute", { mode: 0o644 });
  fs.writeFileSync(join(source, "binary"), Buffer.from([0, 255, 254]));
  const snapshots = new MachineSkillSnapshots({ home, agents: () => agents });
  const message = { type: "skill_snapshot" as const, operation: "list" as const, runnerId: "one", requestId: "one" };
  const candidate = snapshots.handle(message).candidates!.find((candidate) => candidate.sourceDirectory === sourceDirectory)!;
  const snapshot = snapshots.handle({ ...message, operation: "read", candidateId: candidate.id }).snapshot!;
  const entry = { name: "alpha", files: snapshot.files, versionDigest: snapshot.digest, targets: [{ agentId: "codex", invocation: "agent" as const }] };
  cacheSkillSyncEntry(dataDir, agents, entry);
  let leased = false, authorized = 0;
  const options: SkillAdoptionOptions = { home, dataDir, agents, candidate, digest: snapshot.digest,
    acquireProviderHomeLease: () => { leased = true; return undefined; },
    assertAuthorized: () => { assert.ok(leased); authorized++; return undefined; },
  };
  const backups = () => fs.readdirSync(parent).filter((name) => name.startsWith(".wollipog-adoption-"));
  return { root, home, dataDir, parent, source, entry, options, backups, authorized: () => authorized };
}

for (const sourceDirectory of [".codex/skills", ".agents/skills"]) {
  test(`adoption preserves the original and publishes a reconcile-compatible link from ${sourceDirectory}`, linux, async (t) => {
    const f = fixture(t, sourceDirectory);
    const before = fs.statSync(f.source);
    const result = adoptMachineSkill(f.options);
    assert.equal(result.status, "adopted", JSON.stringify(result));
    if (result.status !== "adopted") throw new Error();
    const backup = join(f.home, result.backupDirectory);
    assert.equal(fs.statSync(join(backup, "original")).ino, before.ino, "original directory is renamed, not copied or deleted");
    assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
    assert.equal(fs.statSync(join(backup, "intent.json")).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(join(backup, "preserved.json")));
    assert.ok(fs.existsSync(join(backup, "linked.json")));
    assert.equal(JSON.parse(fs.readFileSync(join(backup, "intent.json"), "utf8")).digest, f.options.digest);
    assert.equal(fs.readFileSync(join(backup, "original/scripts/run.sh"), "utf8"), "echo must-not-execute");
    assert.equal(fs.statSync(join(backup, "original/scripts/run.sh")).mode & 0o777, 0o644);
    assert.deepEqual(fs.readFileSync(join(backup, "original/binary")), Buffer.from([0, 255, 254]));
    assert.equal(fs.realpathSync(f.source), join(f.dataDir, "skills/store/alpha", f.options.digest));
    assert.ok(f.authorized() >= 3);
    assert.equal(adoptMachineSkill(f.options).status, "rejected", "stale retry never replaces the new link");
    assert.equal(f.backups().length, 1);
    const deployed = await reconcileSkills({ dataDir: f.dataDir, home: f.home, agents, desired: [f.entry], acquireProviderHomeLease: () => {} });
    assert.equal(deployed.error, undefined);
    assert.equal(deployed.deployed[0]!.links[0]!.status, "linked");
    assert.equal(fs.realpathSync(join(f.home, ".codex/skills/alpha")), fs.realpathSync(join(f.home, ".agents/skills/alpha")));
    await reconcileSkills({ dataDir: f.dataDir, home: f.home, agents, desired: [], allowRemovals: true, acquireProviderHomeLease: () => {} });
    assert.ok(fs.existsSync(join(backup, "original/SKILL.md")), "normal disable does not garbage-collect preserved source content");
  });
}

for (const problem of ["lease", "authorization", "async-guard", "changed-source", "bad-generation", "missing-store", "changed-store", "source-link", "store-link", "hard-link", "executable", "unsupported-source"]) {
  test(`adoption rejects ${problem} before replacing the source`, linux, (t) => {
    const f = fixture(t);
    const target = join(f.dataDir, "skills/store/alpha", f.options.digest);
    if (problem === "lease") f.options.acquireProviderHomeLease = () => { throw new Error("private lease detail"); };
    if (problem === "authorization") f.options.assertAuthorized = () => { throw new Error("private auth detail"); };
    if (problem === "async-guard") f.options.assertAuthorized = (async () => undefined) as unknown as () => undefined;
    if (problem === "changed-source") fs.writeFileSync(join(f.source, "scripts/run.sh"), "edited nested content");
    if (problem === "bad-generation") f.options.candidate = { ...f.options.candidate, generation: "stale" };
    if (problem === "missing-store") fs.renameSync(target, target + "-removed");
    if (problem === "changed-store") fs.writeFileSync(join(target, "SKILL.md"), "corrupt stored bytes");
    if (problem === "source-link") { fs.renameSync(f.source, f.source + "-original"); fs.symlinkSync(f.source + "-original", f.source); }
    if (problem === "store-link") { fs.renameSync(target, target + "-original"); fs.symlinkSync(target + "-original", target); }
    if (problem === "hard-link") fs.linkSync(join(f.source, "SKILL.md"), join(f.root, "hard-link"));
    if (problem === "executable") fs.chmodSync(join(f.source, "scripts/run.sh"), 0o755);
    if (problem === "unsupported-source") f.options.candidate = { ...f.options.candidate, sourceDirectory: "../../outside" };
    const result = adoptMachineSkill(f.options);
    assert.equal(result.status, "rejected");
    assert.doesNotMatch(JSON.stringify(result), /private|Original instructions/);
    assert.ok(fs.existsSync(join(f.source, "SKILL.md")));
    assert.deepEqual(f.backups(), []);
  });
}

for (const stage of ["intent_durable", "source_preserved", "link_created"] as const) {
  test(`process death at ${stage} leaves inspectable recovery evidence and original content`, linux, (t) => {
    const f = fixture(t);
    const script = `import { adoptMachineSkill } from ${JSON.stringify(new URL("./skill-adoption.ts", import.meta.url).href)};
      adoptMachineSkill({ ...${JSON.stringify(f.options)}, acquireProviderHomeLease: () => undefined, assertAuthorized: () => undefined,
        checkpoint: (stage) => { if (stage === ${JSON.stringify(stage)}) process.kill(process.pid, "SIGKILL"); } });`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.equal(f.backups().length, 1);
    const backup = join(f.parent, f.backups()[0]!);
    assert.ok(fs.existsSync(join(backup, "intent.json")));
    const original = stage === "intent_durable" ? f.source : join(backup, "original");
    assert.match(fs.readFileSync(join(original, "SKILL.md"), "utf8"), /Original instructions/);
    assert.equal(fs.existsSync(join(backup, "linked.json")), false);
    if (stage === "source_preserved") assert.equal(fs.existsSync(f.source), false);
    if (stage === "link_created") assert.ok(fs.lstatSync(f.source).isSymbolicLink());
  });
}

test("a concurrent source occupant is never overwritten or auto-restored over", linux, (t) => {
  const f = fixture(t);
  f.options.checkpoint = (stage) => { if (stage === "source_preserved") { fs.mkdirSync(f.source); fs.writeFileSync(join(f.source, "new-user-file"), "keep me"); } };
  const result = adoptMachineSkill(f.options);
  assert.equal(result.status, "recovery_required");
  assert.equal(fs.readFileSync(join(f.source, "new-user-file"), "utf8"), "keep me");
  assert.match(fs.readFileSync(join(f.parent, f.backups()[0]!, "original/SKILL.md"), "utf8"), /Original instructions/);
});

test("a final source-link replacement cannot be reported as adopted", linux, (t) => {
  const f = fixture(t);
  f.options.checkpoint = (stage) => { if (stage === "link_created") { fs.unlinkSync(f.source); fs.mkdirSync(f.source); } };
  assert.equal(adoptMachineSkill(f.options).status, "recovery_required");
  assert.ok(fs.lstatSync(f.source).isDirectory());
});

test("a store edit at publication is detected and retains the recovery journal", linux, (t) => {
  const f = fixture(t);
  f.options.checkpoint = (stage) => {
    if (stage === "link_created") fs.writeFileSync(join(f.dataDir, "skills/store/alpha", f.options.digest, "SKILL.md"), "concurrent store edit");
  };
  assert.equal(adoptMachineSkill(f.options).status, "recovery_required");
  assert.match(fs.readFileSync(join(f.parent, f.backups()[0]!, "original/SKILL.md"), "utf8"), /Original instructions/);
  assert.equal(fs.existsSync(join(f.parent, f.backups()[0]!, "linked.json")), false);
});

test("a parent symlink swap cannot redirect writes outside the pinned parent", linux, (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside"), moved = join(f.home, ".codex/moved");
  fs.mkdirSync(outside);
  f.options.checkpoint = (stage) => { if (stage === "source_preserved") { fs.renameSync(f.parent, moved); fs.symlinkSync(outside, f.parent); } };
  assert.equal(adoptMachineSkill(f.options).status, "recovery_required");
  assert.deepEqual(fs.readdirSync(outside), []);
  const backupName = fs.readdirSync(moved).find((name) => name.startsWith(".wollipog-adoption-"))!;
  assert.match(fs.readFileSync(join(moved, backupName, "original/SKILL.md"), "utf8"), /Original instructions/);
});

test("a last-instant source swap is detected after preservation without deleting either tree", linux, (t) => {
  const f = fixture(t);
  f.options.noReplaceRename = () => {
    const rename = linuxNoReplaceRename(f.dataDir);
    return (fromParent, fromName, toParent, toName) => {
      if (toName === "original") {
        fs.renameSync(f.source, f.source + "-user-moved");
        fs.mkdirSync(f.source);
        fs.writeFileSync(join(f.source, "SKILL.md"), "replacement content");
      }
      rename(fromParent, fromName, toParent, toName);
    };
  };
  assert.equal(adoptMachineSkill(f.options).status, "recovery_required");
  assert.match(fs.readFileSync(join(f.source + "-user-moved", "SKILL.md"), "utf8"), /Original instructions/);
  assert.equal(fs.readFileSync(join(f.parent, f.backups()[0]!, "original/SKILL.md"), "utf8"), "replacement content");
});

test("retargeting the data directory after it is resolved cannot separate the verified store version from the published link",
  linux, (t) => {
    const f = fixture(t);
    // An identical store elsewhere passes every content check, so only the path walk can tell them apart.
    const other = join(f.root, "other-data");
    fs.cpSync(join(f.dataDir, "skills"), join(other, "skills"), { recursive: true });
    const realpath = fs.realpathSync;
    let retargeted = false;
    t.mock.method(fs, "realpathSync", (path: fs.PathLike, ...rest: []) => {
      const resolved = realpath(path, ...rest);
      if (!retargeted && String(path) === f.dataDir) {
        retargeted = true;
        fs.renameSync(f.dataDir, f.dataDir + "-held");
        fs.symlinkSync(other, f.dataDir);
      }
      return resolved;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const result = adoptMachineSkill(f.options);
    assert.ok(retargeted);
    assert.equal(result.status, "rejected", JSON.stringify(result));
    assert.ok(fs.lstatSync(f.source).isDirectory());
    assert.deepEqual(f.backups(), []);
  });

test("renaming the journal after its intent is durable stops adoption before the original moves", linux, (t) => {
  const f = fixture(t);
  const moved = join(f.parent, ".moved-journal");
  f.options.checkpoint = (stage) => { if (stage === "intent_durable") fs.renameSync(join(f.parent, f.backups()[0]!), moved); };
  const result = adoptMachineSkill(f.options);
  assert.equal(result.status, "recovery_required", JSON.stringify(result));
  assert.ok(fs.lstatSync(f.source).isDirectory());
  assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/);
  assert.deepEqual(fs.readdirSync(moved), ["intent.json"], "the original never moves into a relocated journal");
});

test("an entry created at the preserving move's destination is never replaced", linux, (t) => {
  const f = fixture(t);
  let occupant: fs.Stats | undefined;
  f.options.checkpoint = (stage) => {
    if (stage !== "intent_durable") return;
    const destination = join(f.parent, f.backups()[0]!, "original");
    fs.mkdirSync(destination);
    occupant = fs.statSync(destination);
  };
  const result = adoptMachineSkill(f.options);
  assert.equal(result.status, "recovery_required", JSON.stringify(result));
  assert.ok(fs.lstatSync(f.source).isDirectory());
  assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/);
  const destination = join(f.parent, f.backups()[0]!, "original");
  assert.equal(fs.statSync(destination).ino, occupant!.ino);
  assert.deepEqual(fs.readdirSync(destination), []);
});

test("a runner that cannot refuse to replace rejects adoption before creating a journal", linux, (t) => {
  const f = fixture(t);
  f.options.noReplaceRename = () => { throw new Error("private helper detail"); };
  const result = adoptMachineSkill(f.options);
  assert.equal(result.status, "rejected");
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.ok(fs.lstatSync(f.source).isDirectory());
  assert.deepEqual(f.backups(), []);
});

test("a filesystem without a no-replace move stops with only the intent-only journal", linux, (t) => {
  const f = fixture(t);
  f.options.noReplaceRename = () => () => { throw new Error("EINVAL"); };
  const result = adoptMachineSkill(f.options);
  assert.equal(result.status, "recovery_required", JSON.stringify(result));
  assert.ok(fs.lstatSync(f.source).isDirectory());
  assert.deepEqual(fs.readdirSync(join(f.parent, f.backups()[0]!)), ["intent.json"]);
  assert.deepEqual(listSkillAdoptionRecovery(f.home, f.dataDir, agents).operations.map((entry) => entry.state),
    ["intent_only"]);
});

test("authorization revoked after preservation prevents link publication", linux, (t) => {
  const f = fixture(t);
  let revoked = false;
  f.options.checkpoint = (stage) => { if (stage === "source_preserved") revoked = true; };
  f.options.assertAuthorized = () => { if (revoked) throw new Error(); return undefined; };
  assert.equal(adoptMachineSkill(f.options).status, "recovery_required");
  assert.equal(fs.existsSync(f.source), false);
  assert.ok(fs.existsSync(join(f.parent, f.backups()[0]!, "original/SKILL.md")));
});

test("a journal flush failure preserves the source and reports recovery instead of publishing", linux, (t) => {
  const f = fixture(t);
  const flush = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith("/intent.json")) throw new Error("private disk error");
    flush(fd);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = adoptMachineSkill(f.options);
  assert.equal(result.status, "recovery_required");
  assert.doesNotMatch(JSON.stringify(result), /private disk error/);
  assert.ok(fs.lstatSync(f.source).isDirectory());
  assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/);
  assert.equal(fs.existsSync(join(f.parent, f.backups()[0]!, "original")), false);
});

test("ordinary snapshots do not opt into durability operations", linux, (t) => {
  const f = fixture(t);
  t.mock.method(fs, "fsyncSync", () => { throw new Error("unexpected flush"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const snapshots = new MachineSkillSnapshots({ home: f.home, agents: () => agents });
  const message = { type: "skill_snapshot" as const, operation: "list" as const, runnerId: "one", requestId: "one" };
  const candidate = snapshots.handle(message).candidates![0]!;
  assert.ok(snapshots.handle({ ...message, operation: "read", candidateId: candidate.id }).snapshot);
});

test("unsupported platforms and invalid requests do not touch the filesystem or call guards", () => {
  assert.equal(adoptMachineSkill({ platform: "aix" } as SkillAdoptionOptions).status, "rejected");
  assert.equal(adoptMachineSkill({ platform: "freebsd" } as SkillAdoptionOptions).status, "rejected");
  assert.equal(adoptMachineSkill({ platform: "win32" } as SkillAdoptionOptions).status, "rejected");
  assert.equal(adoptMachineSkill({ platform: "darwin" } as SkillAdoptionOptions).status, "rejected");
});
