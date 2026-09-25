import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition, SkillFile, SkillKeptAsideMessage, SkillSyncEntry, SkillSyncTarget } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { handleSkillDrift, handleSkillKeptAside } from "./skill-drift.js";
import {
  KEPT_ASIDE_REPORT_LIMIT,
  keptAsideFingerprint,
  keptAsideStamps,
  readKeptAsideRecord,
  removeKeptAsideTree,
  scanKeptAsideCopies,
} from "./skill-kept-aside.js";
import {
  mergeReconcileSkillsResults,
  reconcileSkills,
  skillsStateMessage,
  skillsStoreRoot,
  type ReconcileSkillsOptions,
} from "./skills.js";
import { mergeWslSkillsResult } from "./wsl-skills.js";

const claudeAgent: AgentDefinition = {
  id: "claude-main", name: "Claude Code", command: "claude", args: [], env: {},
  driver: "claude-code", context: { kind: "native" },
};
const agents = [claudeAgent];
const agentTarget: SkillSyncTarget = { agentId: claudeAgent.id, invocation: "agent" };
const manualTarget: SkillSyncTarget = { agentId: claudeAgent.id, invocation: "manual" };

function makeRoots(): { root: string; home: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "runner-skill-kept-aside-"));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return { root, home, dataDir };
}

function skillFiles(name: string, body = "Do the thing.\n"): SkillFile[] {
  return [
    { path: "SKILL.md", content: `---\nname: ${name}\ndescription: Kept-aside test skill\n---\n\n${body}`, encoding: "utf8" },
    { path: "reference/notes.md", content: "Notes.\n", encoding: "utf8" },
  ];
}

function entry(name: string, targets: SkillSyncTarget[], files = skillFiles(name)): SkillSyncEntry {
  return { name, versionDigest: skillVersionDigest(files), files, targets };
}

function reconcile(roots: { home: string; dataDir: string }, desired: SkillSyncEntry[], overrides: Partial<ReconcileSkillsOptions> = {}) {
  return reconcileSkills({ dataDir: roots.dataDir, home: roots.home, agents, desired, allowRemovals: true, ...overrides });
}

function store(roots: { dataDir: string }): string {
  return realpathSync(skillsStoreRoot(roots.dataDir));
}

function keptAsideIds(roots: { dataDir: string }): string[] {
  return readdirSync(store(roots)).flatMap((entry) => {
    const match = /^\.drift-([0-9a-f-]{36})$/.exec(entry);
    return match ? [match[1]!] : [];
  });
}

/** Restore an unreadable copy, which the runner keeps aside because it has no content fence. */
async function keepUnreadableAside(roots: { home: string; dataDir: string }, variant: "agent" | "manual" = "agent") {
  const alpha = entry("alpha", [variant === "manual" ? manualTarget : agentTarget]);
  await reconcile(roots, [alpha]);
  const copy = join(store(roots), "alpha", variant === "manual" ? `${alpha.versionDigest}-manual` : alpha.versionDigest);
  writeFileSync(join(copy, "big.bin"), Buffer.alloc(600 * 1024, 1));
  const before = Date.now();
  const restored = handleSkillDrift({
    message: { type: "skill_drift", runnerId: "runner-1", requestId: "restore", operation: "restore",
      name: "alpha", digest: alpha.versionDigest, variant, observedDigest: null, files: alpha.files, confirmation: "explicit" },
    runnerId: "runner-1",
    dataDir: roots.dataDir,
  });
  assert.equal(restored.status, "restored");
  const [id] = keptAsideIds(roots);
  assert.ok(id);
  return { alpha, id, before };
}

const discard = (id: string, observation: Partial<SkillKeptAsideMessage>): SkillKeptAsideMessage => ({
  type: "skill_kept_aside", runnerId: "runner-1", requestId: "discard", operation: "discard", id,
  confirmation: "explicit", ...observation,
});

test("a restore records which copy it keeps aside, and every base pass reports it", async () => {
  const roots = makeRoots();
  try {
    const { alpha, id, before } = await keepUnreadableAside(roots, "manual");
    const record = readKeptAsideRecord(store(roots), id);
    assert.equal(record?.name, "alpha");
    assert.equal(record?.digest, alpha.versionDigest);
    assert.equal(record?.variant, "manual");
    assert.ok(record && record.keptAsideAt >= before && record.keptAsideAt <= Date.now());

    const result = await reconcile(roots, [alpha]);
    assert.equal(result.keptAside?.length, 1);
    const [copy] = result.keptAside!;
    assert.equal(copy!.id, id);
    assert.equal(copy!.name, "alpha");
    assert.equal(copy!.digest, alpha.versionDigest);
    assert.equal(copy!.variant, "manual");
    assert.equal(copy!.keptAsideAt, record!.keptAsideAt);
    assert.equal(copy!.observedDigest, undefined, "an unreadable copy has no content digest");
    assert.match(copy!.observedFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.match(copy!.detail ?? "", /cannot be read as skill content: a file exceeds the skill file size limit/);
    assert.deepEqual(skillsStateMessage("runner-1", result).keptAside, result.keptAside);
    assert.deepEqual(result.drift, [], "the restored copy is no longer drift");

    // Store GC never reclaims a kept-aside copy or its record, however old.
    await reconcile(roots, [], { removedSkillRetentionMs: 0, previousVersionGraceMs: 0, now: Date.now() + 365 * 86_400_000 });
    assert.ok(existsSync(join(store(roots), `.drift-${id}`)));
    assert.ok(existsSync(join(store(roots), `.drift-${id}.json`)));
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a copy changed after the restore swap is kept aside readable, and a clean restore keeps nothing", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const copy = join(store(roots), "alpha", alpha.versionDigest);
    writeFileSync(join(copy, "SKILL.md"), "edited\n");
    const observedDigest = (await reconcile(roots, [alpha])).drift?.[0]?.observedDigest;
    assert.ok(observedDigest);
    const restore = {
      type: "skill_drift" as const, runnerId: "runner-1", requestId: "restore", operation: "restore" as const,
      name: "alpha", digest: alpha.versionDigest, variant: "agent" as const, observedDigest, files: alpha.files,
      confirmation: "explicit" as const,
    };
    // Changed before the swap: nothing moves and no record is left behind.
    writeFileSync(join(copy, "SKILL.md"), "edited again\n");
    assert.equal(handleSkillDrift({ message: restore, runnerId: "runner-1", dataDir: roots.dataDir }).status, "rejected");
    assert.deepEqual(readdirSync(store(roots)).filter((name) => name.startsWith(".drift-")), []);

    const current = (await reconcile(roots, [alpha])).drift?.[0]?.observedDigest;
    const swapped = handleSkillDrift({ message: { ...restore, observedDigest: current }, runnerId: "runner-1", dataDir: roots.dataDir,
      hooks: { beforeDiscard: (path) => writeFileSync(join(path, "SKILL.md"), "written through an open file\n") } });
    assert.equal(swapped.status, "restored");
    const reported = (await reconcile(roots, [alpha])).keptAside;
    assert.equal(reported?.length, 1);
    const late = [{ ...alpha.files[0]!, content: "written through an open file\n" }, alpha.files[1]!];
    assert.equal(reported![0]!.observedDigest, skillVersionDigest(late));
    assert.match(reported![0]!.observedFingerprint ?? "", /^[0-9a-f]{64}$/, "every copy reports the fingerprint of all its entries");
    assert.equal(reported![0]!.detail, "A restore kept this edited copy aside in the skill store instead of deleting it.");

    // A restore that discards the reviewed copy leaves neither a copy nor a record.
    rmSync(join(store(roots), `.drift-${reported![0]!.id}`), { recursive: true });
    rmSync(join(store(roots), `.drift-${reported![0]!.id}.json`));
    writeFileSync(join(copy, "SKILL.md"), "edited once more\n");
    const last = (await reconcile(roots, [alpha])).drift?.[0]?.observedDigest;
    assert.equal(handleSkillDrift({ message: { ...restore, observedDigest: last }, runnerId: "runner-1", dataDir: roots.dataDir }).status,
      "restored");
    assert.deepEqual(readdirSync(store(roots)).filter((name) => name.startsWith(".drift-")), []);
    assert.deepEqual((await reconcile(roots, [alpha])).keptAside, []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a copy kept aside before records existed is reported with the name its SKILL.md gives", async () => {
  const roots = makeRoots();
  try {
    await reconcile(roots, []);
    const legacy = randomUUID();
    const dir = join(store(roots), `.drift-${legacy}`);
    mkdirSync(join(dir, "reference"), { recursive: true });
    for (const file of skillFiles("beta")) writeFileSync(join(dir, file.path), file.content);
    const unnamed = randomUUID();
    mkdirSync(join(store(roots), `.drift-${unnamed}`));
    symlinkSync("/etc/hostname", join(store(roots), `.drift-${unnamed}`, "planted"));
    // Look-alike entries are never reported.
    mkdirSync(join(store(roots), ".drift-not-a-uuid"));
    writeFileSync(join(store(roots), `.drift-${randomUUID()}`), "a file, not a copy");

    const reported = (await reconcile(roots, [])).keptAside ?? [];
    const named = reported.find((copy) => copy.id === legacy);
    assert.match(named?.observedFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(named, {
      id: legacy,
      name: "beta",
      observedDigest: skillVersionDigest(skillFiles("beta")),
      observedFingerprint: named?.observedFingerprint,
      detail: "An earlier runner kept this edited copy aside without recording the skill version it came from.",
    });
    const unidentified = reported.find((copy) => copy.id === unnamed);
    assert.equal(unidentified?.name, undefined);
    assert.match(unidentified?.observedFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.match(unidentified?.detail ?? "", /it contains a symlink/);
    assert.equal(reported.length, 2);
    // Copies with a record are listed first, oldest first.
    writeFileSync(join(store(roots), `.drift-${unnamed}.json`), JSON.stringify({
      version: 1, name: "gamma", digest: "c".repeat(64), variant: "agent", keptAsideAt: 5,
    }));
    assert.deepEqual(scanKeptAsideCopies(store(roots)).copies.map((copy) => copy.id), [unnamed, legacy]);
    // A malformed record reads as absent rather than trusted.
    writeFileSync(join(store(roots), `.drift-${unnamed}.json`), JSON.stringify({ version: 1, name: "../x", digest: "c", variant: "agent", keptAsideAt: 5 }));
    assert.equal(readKeptAsideRecord(store(roots), unnamed), undefined);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("the kept-aside command reads a readable copy and refuses anything else", async () => {
  const roots = makeRoots();
  try {
    await reconcile(roots, []);
    const id = randomUUID();
    const dir = join(store(roots), `.drift-${id}`);
    mkdirSync(join(dir, "reference"), { recursive: true });
    for (const file of skillFiles("beta")) writeFileSync(join(dir, file.path), file.content);
    const read: SkillKeptAsideMessage = { type: "skill_kept_aside", runnerId: "runner-1", requestId: "read", operation: "read", id };
    const result = handleSkillKeptAside({ message: read, runnerId: "runner-1", dataDir: roots.dataDir });
    assert.equal(result.status, "read");
    assert.deepEqual(result.files, skillFiles("beta"));
    assert.equal(result.observedDigest, skillVersionDigest(skillFiles("beta")));

    assert.equal(handleSkillKeptAside({ message: { ...read, id: randomUUID() }, runnerId: "runner-1", dataDir: roots.dataDir }).status,
      "not_found");
    assert.equal(handleSkillKeptAside({ message: { ...read, id: "../alpha" }, runnerId: "runner-1", dataDir: roots.dataDir }).status,
      "rejected");
    assert.equal(handleSkillKeptAside({ message: read, runnerId: "other", dataDir: roots.dataDir }).status, "rejected");
    symlinkSync("/etc/hostname", join(dir, "planted"));
    const unreadable = handleSkillKeptAside({ message: read, runnerId: "runner-1", dataDir: roots.dataDir });
    assert.equal(unreadable.status, "rejected");
    assert.match(unreadable.error ?? "", /cannot be read as skill content: it contains a symlink/);
    // A symlinked kept-aside entry is never followed.
    const outside = join(roots.root, "outside");
    mkdirSync(outside);
    const linked = randomUUID();
    symlinkSync(outside, join(store(roots), `.drift-${linked}`));
    assert.equal(handleSkillKeptAside({ message: { ...read, id: linked }, runnerId: "runner-1", dataDir: roots.dataDir }).status,
      "not_found");
    assert.equal(scanKeptAsideCopies(store(roots)).copies.some((copy) => copy.id === linked), false);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a readable kept-aside copy is discarded only with confirmation and its reviewed digest", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const copy = join(store(roots), "alpha", alpha.versionDigest);
    writeFileSync(join(copy, "SKILL.md"), "edited\n");
    const observedDigest = (await reconcile(roots, [alpha])).drift?.[0]?.observedDigest;
    handleSkillDrift({ message: { type: "skill_drift", runnerId: "runner-1", requestId: "restore", operation: "restore",
      name: "alpha", digest: alpha.versionDigest, variant: "agent", observedDigest, files: alpha.files, confirmation: "explicit" },
    runnerId: "runner-1", dataDir: roots.dataDir,
    hooks: { beforeDiscard: (path) => writeFileSync(join(path, "SKILL.md"), "late write\n") } });
    const [reported] = (await reconcile(roots, [alpha])).keptAside ?? [];
    assert.ok(reported?.observedDigest);
    const dir = join(store(roots), `.drift-${reported.id}`);
    const run = (message: SkillKeptAsideMessage) => handleSkillKeptAside({ message, runnerId: "runner-1", dataDir: roots.dataDir });

    const observed = { observedDigest: reported.observedDigest, observedFingerprint: reported.observedFingerprint! };
    assert.equal(run(discard(reported.id, { ...observed, confirmation: undefined })).status, "rejected");
    assert.equal(run(discard(reported.id, {})).status, "rejected", "a discard names the reviewed observation");
    assert.equal(run(discard(reported.id, { observedDigest: reported.observedDigest })).status, "rejected",
      "the fingerprint of every entry is required");
    assert.equal(run(discard(reported.id, { observedFingerprint: reported.observedFingerprint })).status, "rejected",
      "a readable copy is also named by its content digest");
    assert.equal(run(discard(reported.id, { ...observed, observedFingerprint: "f".repeat(64) })).status, "rejected");
    writeFileSync(join(dir, "SKILL.md"), "changed after review\n");
    const stale = run(discard(reported.id, observed));
    assert.equal(stale.status, "rejected");
    assert.match(stale.error ?? "", /changed after it was reviewed/);
    assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), "changed after review\n", "an unreviewed change is never discarded");

    // Generated artifacts are outside the content digest, but not outside the fence.
    const settled = (await reconcile(roots, [alpha])).keptAside?.[0];
    writeFileSync(join(dir, ".DS_Store"), "written after the report");
    const artifact = run(discard(reported.id, { observedDigest: settled!.observedDigest, observedFingerprint: settled!.observedFingerprint }));
    assert.equal(artifact.status, "rejected");
    assert.equal(readFileSync(join(dir, ".DS_Store"), "utf8"), "written after the report");

    const current = (await reconcile(roots, [alpha])).keptAside?.[0];
    assert.ok(current?.observedDigest && current.observedFingerprint);
    const fence = { observedDigest: current.observedDigest, observedFingerprint: current.observedFingerprint };
    assert.equal(run(discard(reported.id, fence)).status, "discarded");
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(`${dir}.json`), false);
    assert.deepEqual((await reconcile(roots, [alpha])).keptAside, []);
    assert.equal(run(discard(reported.id, fence)).status, "not_found");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an unreadable kept-aside copy is discarded against its fingerprint without following its links", async () => {
  const roots = makeRoots();
  try {
    const { id } = await keepUnreadableAside(roots);
    const dir = join(store(roots), `.drift-${id}`);
    const outside = join(roots.root, "outside");
    mkdirSync(join(outside, "nested"), { recursive: true });
    writeFileSync(join(outside, "nested", "keep.txt"), "outside the store\n");
    symlinkSync(outside, join(dir, "linked-directory"));
    symlinkSync(join(outside, "nested", "keep.txt"), join(dir, "linked-file"));
    const [reported] = (await reconcile(roots, [])).keptAside ?? [];
    assert.ok(reported?.observedFingerprint);
    const run = (message: SkillKeptAsideMessage) => handleSkillKeptAside({ message, runnerId: "runner-1", dataDir: roots.dataDir });

    assert.equal(run(discard(id, { observedDigest: "a".repeat(64) })).status, "rejected");
    // Same size, new bytes: the change time still moves the fingerprint.
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(600 * 1024, 7));
    assert.notEqual(keptAsideFingerprint(dir), reported.observedFingerprint);
    assert.equal(run(discard(id, { observedFingerprint: reported.observedFingerprint })).status, "rejected");
    assert.ok(existsSync(join(dir, "big.bin")));

    const current = (await reconcile(roots, [])).keptAside?.[0]?.observedFingerprint;
    assert.ok(current);
    assert.equal(keptAsideFingerprint(dir), current, "an unchanged tree keeps its fingerprint");
    assert.equal(run(discard(id, { observedFingerprint: current })).status, "discarded");
    assert.equal(existsSync(dir), false);
    assert.equal(readFileSync(join(outside, "nested", "keep.txt"), "utf8"), "outside the store\n", "link targets are never touched");
    assert.deepEqual((await reconcile(roots, [])).keptAside, []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("removal unlinks symlinks, removes only verified entries, and never lists through a swapped directory", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-kept-aside-remove-"));
  try {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    for (const anchored of [true, false]) {
      const dir = join(root, `copy-${anchored}`);
      mkdirSync(join(dir, "a", "b"), { recursive: true });
      writeFileSync(join(dir, "a", "b", "file.txt"), "x");
      symlinkSync(outside, join(dir, "a", "link"));
      const stamps = keptAsideStamps(dir, { anchored })!;
      assert.ok(stamps.has("a/link") && stamps.has("a/b/file.txt"));
      removeKeptAsideTree(dir, stamps, { anchored });
      assert.equal(existsSync(dir), false);
      assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep\n");

      // An entry that changed or appeared after verification stops the removal and is kept.
      const changed = join(root, `changed-${anchored}`);
      mkdirSync(join(changed, "sub"), { recursive: true });
      writeFileSync(join(changed, "sub", "file.txt"), "reviewed");
      writeFileSync(join(changed, "z-last.txt"), "reviewed");
      const reviewed = keptAsideStamps(changed, { anchored })!;
      writeFileSync(join(changed, "sub", "file.txt"), "written after review");
      assert.throws(() => removeKeptAsideTree(changed, reviewed, { anchored }), /changed while it was discarded/);
      assert.equal(readFileSync(join(changed, "sub", "file.txt"), "utf8"), "written after review");
      const added = keptAsideStamps(changed, { anchored })!;
      writeFileSync(join(changed, "sub", "new.txt"), "new");
      assert.throws(() => removeKeptAsideTree(changed, added, { anchored }));
      assert.ok(existsSync(join(changed, "sub", "new.txt")));

      // A directory swapped for a symlink after its check lists nothing it may remove.
      const swapped = join(root, `swapped-${anchored}`);
      mkdirSync(join(swapped, "sub"), { recursive: true });
      writeFileSync(join(swapped, "sub", "file.txt"), "x");
      const before = keptAsideStamps(swapped, { anchored })!;
      assert.throws(() => removeKeptAsideTree(swapped, before, { anchored, beforeList: (relative) => {
        if (relative !== "sub/") return;
        renameSync(join(swapped, "sub"), join(root, `moved-${anchored}`));
        symlinkSync(outside, join(swapped, "sub"));
      } }));
      assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep\n", "nothing outside the copy is removed");

      // A link entry whose directory is moved out of the copy just before the unlink stays linked.
      const linked = join(root, `linked-${anchored}`);
      const linkedAway = join(root, `linked-away-${anchored}`);
      mkdirSync(join(linked, "sub"), { recursive: true });
      symlinkSync(outside, join(linked, "sub", "link"));
      const linkStamps = keptAsideStamps(linked, { anchored })!;
      assert.throws(() => removeKeptAsideTree(linked, linkStamps, { anchored, beforeUnlink: (relative) => {
        if (relative !== "sub/link") return;
        renameSync(join(linked, "sub"), linkedAway);
        symlinkSync(linkedAway, join(linked, "sub"));
      } }), /changed while it was discarded/);
      assert.equal(lstatSync(join(linkedAway, "link")).isSymbolicLink(), true, "the relocated link is put back, not removed");

      // A verified directory moved out of the copy, with a link to it left in its place, is not
      // followed: its files are not removed from their new location.
      for (const seam of ["beforeList", "afterVerify"] as const) {
        const copy = join(root, `relocated-${anchored}-${seam}`);
        const away = join(root, `away-${anchored}-${seam}`);
        mkdirSync(join(copy, "sub"), { recursive: true });
        writeFileSync(join(copy, "sub", "file.txt"), "reviewed");
        const reviewed = keptAsideStamps(copy, { anchored })!;
        const relocate = (relative: string) => {
          if (relative !== (seam === "beforeList" ? "sub/" : "sub/file.txt")) return;
          renameSync(join(copy, "sub"), away);
          symlinkSync(away, join(copy, "sub"));
        };
        assert.throws(() => removeKeptAsideTree(copy, reviewed, { anchored, [seam]: relocate }), /changed while it was discarded/);
        assert.equal(readFileSync(join(away, "file.txt"), "utf8"), "reviewed", `${seam}: the relocated files are kept`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stamp walk never follows a directory swapped for a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-kept-aside-stamps-"));
  try {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret-name.txt"), "outside\n");
    for (const anchored of [true, false]) {
      const dir = join(root, `copy-${anchored}`);
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "file.txt"), "x");
      const stamps = keptAsideStamps(dir, { anchored, beforeList: (relative) => {
        if (relative !== "sub") return;
        renameSync(join(dir, "sub"), join(root, `moved-${anchored}`));
        symlinkSync(outside, join(dir, "sub"));
      } });
      assert.equal(stamps?.has("sub/secret-name.txt") ?? false, false, "the outside tree is never walked");
      if (!anchored) assert.equal(stamps, undefined, "a directory swapped during the walk invalidates it");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a kept-aside copy changed after its fence check, or during removal, is kept", async () => {
  const roots = makeRoots();
  try {
    await reconcile(roots, []);
    const id = randomUUID();
    const dir = join(store(roots), `.drift-${id}`);
    mkdirSync(join(dir, "reference"), { recursive: true });
    for (const file of skillFiles("beta")) writeFileSync(join(dir, file.path), file.content);
    const observedDigest = skillVersionDigest(skillFiles("beta"));
    // Named by the observation as it stands when each discard starts.
    const run = (hooks: Parameters<typeof handleSkillKeptAside>[0]["hooks"]) =>
      handleSkillKeptAside({ message: discard(id, { observedDigest, observedFingerprint: keptAsideFingerprint(dir)! }),
        runnerId: "runner-1", dataDir: roots.dataDir, hooks });

    const late = run({ beforeRemove: () => writeFileSync(join(dir, "SKILL.md"), "late write\n") });
    assert.equal(late.status, "rejected");
    assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), "late write\n", "a write after the fence check is never discarded");

    const reset = () => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, "reference"), { recursive: true });
      for (const file of skillFiles("beta")) writeFileSync(join(dir, file.path), file.content);
    };
    const leftovers = () => readdirSync(dir).filter((name) => name.startsWith(".wollipog-discard-"));

    reset();
    const during = run({ removal: { afterVerify: (relative) => {
      if (relative === "SKILL.md") writeFileSync(join(dir, "reference", "notes.md"), "written mid-removal\n");
    } } });
    assert.equal(during.status, "rejected");
    assert.match(during.error ?? "", /could not be removed completely/);
    assert.equal(readFileSync(join(dir, "reference", "notes.md"), "utf8"), "written mid-removal\n");
    const [still] = (await reconcile(roots, [])).keptAside ?? [];
    assert.equal(still?.id, id, "what remains is still reported");

    // A write to the very entry being removed, after its check under its name.
    reset();
    const same = run({ removal: { afterVerify: (relative) => {
      if (relative === "SKILL.md") writeFileSync(join(dir, "SKILL.md"), "written after its own check\n");
    } } });
    assert.equal(same.status, "rejected");
    assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), "written after its own check\n");
    assert.deepEqual(leftovers(), [], "a changed entry goes back under its own name");

    // An editor's atomic save over the name after its check is never touched.
    reset();
    const saved = run({ removal: { afterVerify: (relative) => {
      if (relative !== "SKILL.md") return;
      writeFileSync(join(dir, ".SKILL.md.swp"), "saved by an editor\n");
      renameSync(join(dir, ".SKILL.md.swp"), join(dir, "SKILL.md"));
    } } });
    assert.equal(saved.status, "rejected");
    assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), "saved by an editor\n");
    assert.deepEqual(leftovers(), []);

    // A replacement placed at the private name after the file was opened there is not removed.
    reset();
    const swapped = run({ removal: { beforeUnlink: (relative) => {
      if (relative !== "SKILL.md") return;
      const [privateName] = leftovers();
      renameSync(join(dir, privateName!), join(roots.root, "moved-away"));
      writeFileSync(join(dir, privateName!), "placed at the private name\n");
    } } });
    assert.equal(swapped.status, "rejected");
    assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), "placed at the private name\n",
      "the replacement is put back under the entry's name, never unlinked");
    assert.deepEqual(leftovers(), []);

    // A write through a handle opened before the discard lands just before the unlink: kept. The write
    // keeps the size, and may land in the same timestamp tick, so only the reviewed content reveals it.
    reset();
    utimesSync(join(dir, "SKILL.md"), 1_000, 1_000);
    const handle = openSync(join(dir, "SKILL.md"), "r+");
    try {
      const held = run({ removal: { beforeUnlink: (relative) => {
        if (relative !== "SKILL.md") return;
        writeSync(handle, "+++", 0);
        futimesSync(handle, 1_000, 1_000);
      } } });
      assert.equal(held.status, "rejected");
    } finally {
      closeSync(handle);
    }
    assert.match(readFileSync(join(dir, "SKILL.md"), "utf8"), /^\+\+\+\nname: beta\n/);
    assert.deepEqual(leftovers(), []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a restore that finds its discarded copy changing during removal keeps the rest aside with its record", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const copy = join(store(roots), "alpha", alpha.versionDigest);
    writeFileSync(join(copy, "SKILL.md"), "edited\n");
    const observedDigest = (await reconcile(roots, [alpha])).drift?.[0]?.observedDigest;
    let quarantined = "";
    const restored = handleSkillDrift({
      message: { type: "skill_drift", runnerId: "runner-1", requestId: "restore", operation: "restore",
        name: "alpha", digest: alpha.versionDigest, variant: "agent", observedDigest, files: alpha.files, confirmation: "explicit" },
      runnerId: "runner-1",
      dataDir: roots.dataDir,
      hooks: {
        beforeDiscard: (path) => { quarantined = path; },
        removal: { afterVerify: (relative) => {
          if (relative === "SKILL.md") writeFileSync(join(quarantined, "reference", "notes.md"), "written mid-removal\n");
        } },
      },
    });
    assert.equal(restored.status, "restored");
    assert.equal(readFileSync(join(quarantined, "reference", "notes.md"), "utf8"), "written mid-removal\n");
    const [kept] = (await reconcile(roots, [alpha])).keptAside ?? [];
    assert.equal(kept?.name, "alpha", "the preserved remainder stays identified by its record");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("copies beyond the report bound are counted, not dropped silently", async () => {
  const roots = makeRoots();
  try {
    await reconcile(roots, []);
    for (let index = 0; index < KEPT_ASIDE_REPORT_LIMIT + 2; index += 1) mkdirSync(join(store(roots), `.drift-${randomUUID()}`));
    const result = await reconcile(roots, []);
    assert.equal(result.keptAside?.length, KEPT_ASIDE_REPORT_LIMIT);
    assert.equal(result.keptAsideOmitted, 2);
    assert.equal(skillsStateMessage("runner-1", result).keptAsideOmitted, 2);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("merged account and WSL reports carry the base pass kept-aside copies", () => {
  const keptAside = [{ id: randomUUID(), name: "alpha", observedDigest: "a".repeat(64) }];
  const base = { deployed: [], unmanaged: [], removedLinks: [], drift: [], keptAside };
  const account = { deployed: [], unmanaged: [], removedLinks: [] };
  assert.deepEqual(mergeReconcileSkillsResults(base, account).keptAside, keptAside);
  assert.deepEqual(mergeReconcileSkillsResults(account, base).keptAside, keptAside);
  assert.equal(mergeReconcileSkillsResults(account, account).keptAside, undefined);
  assert.deepEqual(mergeWslSkillsResult(base, account, agents).keptAside, keptAside);
  assert.equal(skillsStateMessage("runner-1", account).keptAside, undefined, "an unverified store reports no kept-aside list");
});
