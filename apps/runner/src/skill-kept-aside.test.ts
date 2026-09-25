import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition, SkillFile, SkillKeptAsideMessage, SkillSyncEntry, SkillSyncTarget } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { handleSkillDrift, handleSkillKeptAside } from "./skill-drift.js";
import {
  keptAsideFingerprint,
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
    assert.equal(reported![0]!.observedFingerprint, undefined);
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
    assert.deepEqual(named, {
      id: legacy,
      name: "beta",
      observedDigest: skillVersionDigest(skillFiles("beta")),
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
    assert.deepEqual(scanKeptAsideCopies(store(roots)).map((copy) => copy.id), [unnamed, legacy]);
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
    assert.equal(scanKeptAsideCopies(store(roots)).some((copy) => copy.id === linked), false);
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

    assert.equal(run(discard(reported.id, { observedDigest: reported.observedDigest, confirmation: undefined })).status, "rejected");
    assert.equal(run(discard(reported.id, {})).status, "rejected", "a discard names the reviewed observation");
    assert.equal(run(discard(reported.id, { observedDigest: reported.observedDigest, observedFingerprint: "f".repeat(64) })).status,
      "rejected", "a discard names exactly one observation");
    assert.equal(run(discard(reported.id, { observedFingerprint: "f".repeat(64) })).status, "rejected");
    writeFileSync(join(dir, "SKILL.md"), "changed after review\n");
    const stale = run(discard(reported.id, { observedDigest: reported.observedDigest }));
    assert.equal(stale.status, "rejected");
    assert.match(stale.error ?? "", /changed after it was reviewed/);
    assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), "changed after review\n", "an unreviewed change is never discarded");

    const current = (await reconcile(roots, [alpha])).keptAside?.[0]?.observedDigest;
    assert.ok(current);
    assert.equal(run(discard(reported.id, { observedDigest: current })).status, "discarded");
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(`${dir}.json`), false);
    assert.deepEqual((await reconcile(roots, [alpha])).keptAside, []);
    assert.equal(run(discard(reported.id, { observedDigest: current })).status, "not_found");
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

test("removal with and without descriptor anchoring unlinks symlinks instead of traversing them", () => {
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
      removeKeptAsideTree(dir, { anchored });
      assert.equal(existsSync(dir), false);
      assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep\n");

      // A directory swapped for a symlink after it was inspected is refused, never traversed.
      const swapped = join(root, `swapped-${anchored}`);
      mkdirSync(join(swapped, "sub"), { recursive: true });
      writeFileSync(join(swapped, "sub", "file.txt"), "x");
      assert.throws(() => removeKeptAsideTree(swapped, { anchored, afterInspect: (name) => {
        if (name !== "sub") return;
        renameSync(join(swapped, "sub"), join(root, `moved-${anchored}`));
        symlinkSync(outside, join(swapped, "sub"));
      } }));
      assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep\n");
      assert.ok(existsSync(join(root, `moved-${anchored}`, "file.txt")));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
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
