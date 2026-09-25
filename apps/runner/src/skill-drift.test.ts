import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { AgentDefinition, SkillFile, SkillSyncEntry, SkillSyncTarget } from "@wollipog/protocol";
import { withoutManualInvocationFrontmatter } from "@wollipog/protocol/skill-invocation";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { handleSkillDrift } from "./skill-drift.js";
import { readStoreSkillCopy } from "./skill-store-copy.js";
import {
  HELD_SKILL_LINK_DETAIL,
  heldSkillNames,
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
const codexAgent: AgentDefinition = {
  id: "codex-main", name: "Codex", command: "codex", args: [], env: {},
  driver: "codex-app-server", context: { kind: "native" },
};
const agents = [claudeAgent, codexAgent];
const agentTarget: SkillSyncTarget = { agentId: claudeAgent.id, invocation: "agent" };
const manualTarget: SkillSyncTarget = { agentId: claudeAgent.id, invocation: "manual" };

function makeRoots(): { root: string; home: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "runner-skill-drift-"));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return { root, home, dataDir };
}

function skillFiles(name: string, body = "Do the thing.\n"): SkillFile[] {
  return [
    { path: "SKILL.md", content: `---\nname: ${name}\ndescription: Drift test skill\n---\n\n${body}`, encoding: "utf8" },
    { path: "reference/notes.md", content: "Notes.\n", encoding: "utf8" },
  ];
}

function entry(name: string, targets: SkillSyncTarget[], files = skillFiles(name)): SkillSyncEntry {
  return { name, versionDigest: skillVersionDigest(files), files, targets };
}

function reconcile(
  roots: { home: string; dataDir: string },
  desired: SkillSyncEntry[],
  overrides: Partial<ReconcileSkillsOptions> = {},
) {
  return reconcileSkills({
    dataDir: roots.dataDir,
    home: roots.home,
    agents,
    desired,
    allowRemovals: true,
    ...overrides,
  });
}

function storeCopy(roots: { dataDir: string }, name: string, version: string): string {
  return join(realpathSync(skillsStoreRoot(roots.dataDir)), name, version);
}

function linkTarget(linkPath: string): string {
  return resolve(dirname(linkPath), readlinkSync(linkPath));
}

/** The edited copy as a library import would capture it. */
function editedFiles(name: string, edit: string): SkillFile[] {
  const [skillMd, ...rest] = skillFiles(name);
  return [{ ...skillMd!, content: `${skillMd!.content}${edit}` }, ...rest];
}

test("an edit through a harness link is reported as drift and holds every link unchanged", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget, { agentId: codexAgent.id, invocation: "agent" }]);
    const first = await reconcile(roots, [alpha]);
    assert.deepEqual(first.drift, []);
    const claudeLink = join(roots.home, ".claude", "skills", "alpha");
    const canonical = join(roots.home, ".agents", "skills", "alpha");
    writeFileSync(join(claudeLink, "SKILL.md"), `${alpha.files[0]!.content}Hand edit.\n`);

    const result = await reconcile(roots, [alpha]);
    const observedDigest = skillVersionDigest(editedFiles("alpha", "Hand edit.\n"));
    assert.deepEqual(result.drift, [{
      name: "alpha", digest: alpha.versionDigest, variant: "agent", observedDigest, held: true,
      detail: "Updates and removals for this skill are held until the edit is imported as a new version or the library version is restored.",
    }]);
    assert.deepEqual(result.deployed[0]!.links, [
      { agentId: claudeAgent.id, status: "conflict", detail: HELD_SKILL_LINK_DETAIL },
      { agentId: codexAgent.id, status: "conflict", detail: HELD_SKILL_LINK_DETAIL },
    ]);
    assert.equal(linkTarget(canonical), storeCopy(roots, "alpha", alpha.versionDigest));
    assert.equal(readFileSync(join(claudeLink, "SKILL.md"), "utf8"), `${alpha.files[0]!.content}Hand edit.\n`);
    assert.deepEqual(skillsStateMessage("runner-1", result).drift, result.drift);
    assert.deepEqual([...heldSkillNames(result)], ["alpha"]);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a held edit is never overwritten by an update or deleted by removal and GC", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const claudeLink = join(roots.home, ".claude", "skills", "alpha");
    const canonical = join(roots.home, ".agents", "skills", "alpha");
    const editedCopy = storeCopy(roots, "alpha", alpha.versionDigest);
    writeFileSync(join(claudeLink, "reference", "notes.md"), "Edited notes.\n");

    const update = entry("alpha", [agentTarget], skillFiles("alpha", "Library update.\n"));
    const updated = await reconcile(roots, [update], { previousVersionGraceMs: 0, now: 10 });
    assert.equal(linkTarget(canonical), editedCopy, "the canonical link stays on the edited copy");
    assert.equal(existsSync(storeCopy(roots, "alpha", update.versionDigest)), true, "the update is staged");
    assert.equal(updated.deployed[0]!.digest, update.versionDigest);
    assert.equal(updated.deployed[0]!.links[0]!.status, "conflict");
    assert.equal(updated.drift?.[0]?.held, true);

    const removed = await reconcile(roots, [], { removedSkillRetentionMs: 0, previousVersionGraceMs: 0, now: 20 });
    assert.deepEqual(removed.removedLinks, [], "no link is removed while the skill is held");
    assert.equal(lstatSync(claudeLink).isSymbolicLink(), true);
    assert.equal(readFileSync(join(editedCopy, "reference", "notes.md"), "utf8"), "Edited notes.\n");
    assert.equal(removed.drift?.[0]?.held, true);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an edited copy that no link serves is retained and reported without holding the skill", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const next = entry("alpha", [agentTarget], skillFiles("alpha", "Next version.\n"));
    await reconcile(roots, [next], { previousVersionGraceMs: Number.MAX_SAFE_INTEGER, now: 1 });
    const staleCopy = storeCopy(roots, "alpha", alpha.versionDigest);
    writeFileSync(join(staleCopy, "SKILL.md"), "edited while stale\n");

    const result = await reconcile(roots, [next], { previousVersionGraceMs: 0, now: 2 });
    assert.equal(result.drift?.length, 1);
    assert.equal(result.drift?.[0]?.held, false);
    assert.equal(result.deployed[0]!.links[0]!.status, "linked");
    assert.equal(readFileSync(join(staleCopy, "SKILL.md"), "utf8"), "edited while stale\n",
      "store GC never ages out an edited copy");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a Manual Only copy edited through its harness link is reported as manual drift", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [manualTarget]);
    await reconcile(roots, [alpha]);
    const claudeLink = join(roots.home, ".claude", "skills", "alpha");
    assert.equal(linkTarget(claudeLink), storeCopy(roots, "alpha", `${alpha.versionDigest}-manual`));
    const manualSkillMd = readFileSync(join(claudeLink, "SKILL.md"), "utf8");
    writeFileSync(join(claudeLink, "SKILL.md"), `${manualSkillMd}Manual edit.\n`);

    const result = await reconcile(roots, [alpha]);
    assert.equal(result.drift?.length, 1);
    assert.equal(result.drift?.[0]?.variant, "manual");
    assert.equal(result.drift?.[0]?.digest, alpha.versionDigest);
    assert.equal(result.drift?.[0]?.held, true);
    assert.equal(result.deployed[0]!.links[0]!.status, "conflict");

    // Importing the edit as a new version captures it: the reversed content, deployed Manual Only
    // again, reproduces exactly the edited bytes, so the hold releases without a visible change.
    const recovered = withoutManualInvocationFrontmatter(`${manualSkillMd}Manual edit.\n`);
    assert.ok(recovered);
    const imported = entry("alpha", [manualTarget], [
      { path: "SKILL.md", content: recovered, encoding: "utf8" },
      alpha.files[1]!,
    ]);
    const captured = await reconcile(roots, [imported], { previousVersionGraceMs: 0, now: 50 });
    assert.deepEqual(captured.drift, []);
    assert.equal(captured.deployed[0]!.links[0]!.status, "linked");
    assert.equal(linkTarget(claudeLink), storeCopy(roots, "alpha", `${imported.versionDigest}-manual`));
    assert.equal(readFileSync(join(claudeLink, "SKILL.md"), "utf8"), `${manualSkillMd}Manual edit.\n`);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("importing the edited bytes captures the drift, releases the hold, and lets GC reclaim the copy", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const canonical = join(roots.home, ".agents", "skills", "alpha");
    writeFileSync(join(canonical, "SKILL.md"), `${alpha.files[0]!.content}Keep this.\n`);
    assert.equal((await reconcile(roots, [alpha])).drift?.[0]?.held, true);

    const imported = entry("alpha", [agentTarget], editedFiles("alpha", "Keep this.\n"));
    const result = await reconcile(roots, [imported], { previousVersionGraceMs: 0, now: 100 });
    assert.deepEqual(result.drift, []);
    assert.equal(linkTarget(canonical), storeCopy(roots, "alpha", imported.versionDigest));
    assert.equal(result.deployed[0]!.links[0]!.status, "linked");
    assert.equal(existsSync(storeCopy(roots, "alpha", alpha.versionDigest)), false,
      "the captured copy is an ordinary stale version once its bytes live in the library");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("every tree the payload validator accepts verifies as a clean copy", async () => {
  const roots = makeRoots();
  try {
    // 64 files, each under its own chain of seven directories: 512 entries in total.
    const files: SkillFile[] = [
      { path: "SKILL.md", content: "---\nname: alpha\n---\nDeep.\n", encoding: "utf8" },
      ...Array.from({ length: 63 }, (_, index) => ({
        path: `d${index}/a/b/c/d/e/f/file.md`, content: `File ${index}.\n`, encoding: "utf8" as const,
      })),
    ];
    const result = await reconcile(roots, [entry("alpha", [agentTarget], files)]);
    assert.deepEqual(result.drift, []);
    assert.equal(result.deployed[0]!.links[0]!.status, "linked");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("generated interpreter and Finder artifacts are not edits", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const copy = storeCopy(roots, "alpha", alpha.versionDigest);
    mkdirSync(join(copy, "reference", "__pycache__"));
    writeFileSync(join(copy, "reference", "__pycache__", "helper.cpython-312.pyc"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(copy, ".DS_Store"), Buffer.from([0, 0, 0, 1]));
    const result = await reconcile(roots, [alpha]);
    assert.deepEqual(result.drift, []);
    assert.equal(result.deployed[0]!.links[0]!.status, "linked");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a copy that is no longer valid skill content is reported without content and still held", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const copy = storeCopy(roots, "alpha", alpha.versionDigest);
    symlinkSync("/etc/hostname", join(copy, "planted"));
    const result = await reconcile(roots, [entry("alpha", [agentTarget], skillFiles("alpha", "Update.\n"))],
      { previousVersionGraceMs: 0, now: 5 });
    assert.equal(result.drift?.length, 1);
    assert.equal(result.drift?.[0]?.observedDigest, undefined);
    assert.match(result.drift?.[0]?.detail ?? "", /cannot be read as skill content: it contains a symlink/);
    assert.equal(result.drift?.[0]?.held, true);
    assert.equal(lstatSync(join(copy, "planted")).isSymbolicLink(), true);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("the drift command reads an edited copy and refuses clean or unreadable copies", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const command = { type: "skill_drift" as const, runnerId: "runner-1", requestId: "read-1", operation: "read" as const,
      name: "alpha", digest: alpha.versionDigest, variant: "agent" as const };
    assert.equal(handleSkillDrift({ message: command, runnerId: "runner-1", dataDir: roots.dataDir }).status, "not_needed");

    const copy = storeCopy(roots, "alpha", alpha.versionDigest);
    writeFileSync(join(copy, "SKILL.md"), `${alpha.files[0]!.content}Edit.\n`);
    const read = handleSkillDrift({ message: command, runnerId: "runner-1", dataDir: roots.dataDir });
    assert.equal(read.status, "read");
    assert.deepEqual(read.files, editedFiles("alpha", "Edit.\n"));
    assert.equal(read.observedDigest, skillVersionDigest(editedFiles("alpha", "Edit.\n")));

    symlinkSync("/etc/hostname", join(copy, "planted"));
    const unreadable = handleSkillDrift({ message: command, runnerId: "runner-1", dataDir: roots.dataDir });
    assert.equal(unreadable.status, "rejected");
    assert.match(unreadable.error ?? "", /cannot be read as skill content/);
    assert.equal(handleSkillDrift({ message: { ...command, name: "../alpha" }, runnerId: "runner-1", dataDir: roots.dataDir }).status,
      "rejected");
    assert.equal(handleSkillDrift({ message: command, runnerId: "other", dataDir: roots.dataDir }).status, "rejected");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a confirmed restore replaces exactly the reviewed edit and the next pass converges", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const canonical = join(roots.home, ".agents", "skills", "alpha");
    const copy = storeCopy(roots, "alpha", alpha.versionDigest);
    writeFileSync(join(copy, "SKILL.md"), "first edit\n");
    const update = entry("alpha", [agentTarget], skillFiles("alpha", "Update.\n"));
    const held = await reconcile(roots, [update]);
    const observedDigest = held.drift?.[0]?.observedDigest;
    assert.ok(observedDigest);
    const restore = {
      type: "skill_drift" as const, runnerId: "runner-1", requestId: "restore-1", operation: "restore" as const,
      name: "alpha", digest: alpha.versionDigest, variant: "agent" as const, observedDigest,
      files: alpha.files, confirmation: "explicit" as const,
    };

    assert.equal(handleSkillDrift({ message: { ...restore, confirmation: undefined }, runnerId: "runner-1", dataDir: roots.dataDir }).status,
      "rejected");
    assert.equal(handleSkillDrift({ message: { ...restore, files: skillFiles("alpha", "Wrong.\n") }, runnerId: "runner-1", dataDir: roots.dataDir }).status,
      "rejected", "library files must match the copy's version digest");
    writeFileSync(join(copy, "SKILL.md"), "second edit\n");
    const stale = handleSkillDrift({ message: restore, runnerId: "runner-1", dataDir: roots.dataDir });
    assert.equal(stale.status, "rejected");
    assert.match(stale.error ?? "", /changed after it was reviewed/);
    assert.equal(readFileSync(join(copy, "SKILL.md"), "utf8"), "second edit\n", "an unreviewed edit is never discarded");

    const current = (await reconcile(roots, [update])).drift?.[0]?.observedDigest;
    const restored = handleSkillDrift({ message: { ...restore, observedDigest: current }, runnerId: "runner-1", dataDir: roots.dataDir });
    assert.equal(restored.status, "restored");
    assert.equal(readFileSync(join(copy, "SKILL.md"), "utf8"), alpha.files[0]!.content);
    assert.equal(linkTarget(canonical), copy);

    const converged = await reconcile(roots, [update]);
    assert.deepEqual(converged.drift, []);
    assert.equal(linkTarget(canonical), storeCopy(roots, "alpha", update.versionDigest));
    assert.equal(handleSkillDrift({ message: { ...restore, observedDigest: current }, runnerId: "runner-1", dataDir: roots.dataDir }).status,
      "not_needed");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a restore never discards bytes written after its observation fence", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const copy = storeCopy(roots, "alpha", alpha.versionDigest);
    writeFileSync(join(copy, "SKILL.md"), "reviewed edit\n");
    const observedDigest = (await reconcile(roots, [alpha])).drift?.[0]?.observedDigest ?? null;
    const restore = {
      type: "skill_drift" as const, runnerId: "runner-1", requestId: "restore-race", operation: "restore" as const,
      name: "alpha", digest: alpha.versionDigest, variant: "agent" as const, observedDigest,
      files: alpha.files, confirmation: "explicit" as const,
    };
    const logs: string[] = [];
    const late = handleSkillDrift({ message: restore, runnerId: "runner-1", dataDir: roots.dataDir, log: (line) => logs.push(line),
      hooks: { beforeQuarantine: () => writeFileSync(join(copy, "SKILL.md"), "newer, unreviewed edit\n") } });
    assert.equal(late.status, "rejected");
    assert.match(late.error ?? "", /changed after it was reviewed/);
    assert.equal(readFileSync(join(copy, "SKILL.md"), "utf8"), "newer, unreviewed edit\n", "the copy is put back untouched");

    // A writer that still holds the old file open after the swap keeps its bytes in the quarantine.
    const current = (await reconcile(roots, [alpha])).drift?.[0]?.observedDigest ?? null;
    let quarantined = "";
    const swapped = handleSkillDrift({ message: { ...restore, observedDigest: current }, runnerId: "runner-1", dataDir: roots.dataDir,
      log: (line) => logs.push(line),
      hooks: { beforeDiscard: (path) => { quarantined = path; writeFileSync(join(path, "SKILL.md"), "written through an open file\n"); } } });
    assert.equal(swapped.status, "restored");
    assert.equal(readFileSync(join(copy, "SKILL.md"), "utf8"), alpha.files[0]!.content);
    assert.equal(readFileSync(join(quarantined, "SKILL.md"), "utf8"), "written through an open file\n");
    assert.ok(logs.some((line) => line.includes("changed after the swap") && line.includes(quarantined)));
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("restoring an unreadable copy keeps it aside because a later change cannot be fenced", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const copy = storeCopy(roots, "alpha", alpha.versionDigest);
    writeFileSync(join(copy, "big.bin"), Buffer.alloc(600 * 1024, 1));
    const drift = (await reconcile(roots, [alpha])).drift?.[0];
    assert.equal(drift?.observedDigest, undefined);
    const restored = handleSkillDrift({
      message: { type: "skill_drift", runnerId: "runner-1", requestId: "restore-big", operation: "restore",
        name: "alpha", digest: alpha.versionDigest, variant: "agent", observedDigest: null,
        files: alpha.files, confirmation: "explicit" },
      runnerId: "runner-1",
      dataDir: roots.dataDir,
      hooks: { beforeQuarantine: () => writeFileSync(join(copy, "big.bin"), Buffer.alloc(700 * 1024, 2)) },
    });
    assert.equal(restored.status, "restored");
    assert.equal(readFileSync(join(copy, "SKILL.md"), "utf8"), alpha.files[0]!.content);
    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    const aside = readdirSync(store).filter((entry) => entry.startsWith(".drift-") && !entry.endsWith(".json"));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(store, aside[0]!, "big.bin")).length, 700 * 1024, "the late change is kept");
    assert.ok(existsSync(join(store, `${aside[0]}.json`)), "the kept-aside copy is identified by its record");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("restoring without library files discards an unreadable copy and removes its links when undesired", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const claudeLink = join(roots.home, ".claude", "skills", "alpha");
    const copy = storeCopy(roots, "alpha", alpha.versionDigest);
    symlinkSync("/etc/hostname", join(copy, "planted"));
    assert.equal((await reconcile(roots, [])).drift?.[0]?.held, true);

    const restored = handleSkillDrift({
      message: {
        type: "skill_drift", runnerId: "runner-1", requestId: "restore-2", operation: "restore",
        name: "alpha", digest: alpha.versionDigest, variant: "agent", observedDigest: null, confirmation: "explicit",
      },
      runnerId: "runner-1",
      dataDir: roots.dataDir,
      log: () => {},
    });
    assert.equal(restored.status, "restored");
    assert.equal(existsSync(copy), false);
    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    const aside = readdirSync(store).filter((entry) => entry.startsWith(".drift-") && !entry.endsWith(".json"));
    assert.equal(aside.length, 1, "an unreadable copy has no content fence, so it is moved aside, never deleted");
    assert.equal(lstatSync(join(store, aside[0]!, "planted")).isSymbolicLink(), true);
    const converged = await reconcile(roots, []);
    assert.deepEqual(converged.drift, []);
    assert.equal(existsSync(claudeLink), false, "the released links are swept like any undesired skill");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a confirmed restore rebuilds a Manual Only copy from library files", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [manualTarget]);
    await reconcile(roots, [alpha]);
    const manualCopy = storeCopy(roots, "alpha", `${alpha.versionDigest}-manual`);
    const original = readFileSync(join(manualCopy, "SKILL.md"), "utf8");
    writeFileSync(join(manualCopy, "SKILL.md"), `${original}Edit.\n`);
    const drift = (await reconcile(roots, [alpha])).drift?.[0];
    assert.equal(drift?.variant, "manual");
    const restored = handleSkillDrift({
      message: {
        type: "skill_drift", runnerId: "runner-1", requestId: "restore-3", operation: "restore",
        name: "alpha", digest: alpha.versionDigest, variant: "manual", observedDigest: drift?.observedDigest ?? null,
        files: alpha.files, confirmation: "explicit",
      },
      runnerId: "runner-1",
      dataDir: roots.dataDir,
    });
    assert.equal(restored.status, "restored");
    assert.equal(readFileSync(join(manualCopy, "SKILL.md"), "utf8"), original);
    assert.deepEqual((await reconcile(roots, [alpha])).drift, []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("account passes leave a held skill's credential-home links untouched", async () => {
  const roots = makeRoots();
  try {
    const accountSkills = join(roots.root, "claude-work", "skills");
    const alpha = entry("alpha", [agentTarget]);
    const accountPass = (desired: SkillSyncEntry[], held: ReadonlySet<string>) => reconcile(roots, desired, {
      harnessDirectories: { ".claude/skills": accountSkills },
      harnessScope: [".claude/skills"],
      reportUnknownTargets: false,
      manageCanonical: false,
      providerAccountId: "work",
      heldSkillNames: held,
    });
    const base = await reconcile(roots, [alpha], { liveLinkDirectories: [accountSkills] });
    assert.deepEqual(base.drift, []);
    await accountPass([alpha], new Set());
    const accountLink = join(accountSkills, "alpha");
    assert.equal(lstatSync(accountLink).isSymbolicLink(), true);

    const held = await accountPass([], new Set(["alpha"]));
    assert.deepEqual(held.removedLinks, []);
    assert.equal(lstatSync(accountLink).isSymbolicLink(), true);
    const heldDesired = await accountPass([alpha], new Set(["alpha"]));
    assert.deepEqual(heldDesired.deployed[0]!.links, [
      { agentId: claudeAgent.id, status: "conflict", detail: HELD_SKILL_LINK_DETAIL },
    ]);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an edited stale Manual Only copy outlives the collection of its agent-invocation sibling", async () => {
  const roots = makeRoots();
  try {
    const first = entry("alpha", [manualTarget]);
    await reconcile(roots, [first]);
    const second = entry("alpha", [manualTarget], skillFiles("alpha", "Second.\n"));
    await reconcile(roots, [second], { previousVersionGraceMs: Number.MAX_SAFE_INTEGER, now: 1 });
    const staleManual = storeCopy(roots, "alpha", `${first.versionDigest}-manual`);
    writeFileSync(join(staleManual, "SKILL.md"), "edited while stale\n");

    for (const now of [2, 3, 4]) {
      const result = await reconcile(roots, [second], { previousVersionGraceMs: 0, now });
      assert.equal(result.drift?.length, 1, `pass at ${now} still reports the edited Manual Only copy`);
      assert.equal(result.drift?.[0]?.variant, "manual");
    }
    assert.equal(readFileSync(join(staleManual, "SKILL.md"), "utf8"), "edited while stale\n");
    assert.equal(existsSync(storeCopy(roots, "alpha", first.versionDigest)), true,
      "the agent-invocation sibling that verifies the Manual Only copy is retained beside it");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an orphaned Manual Only copy is verified by reversing its transform and fails closed when edited", async () => {
  const roots = makeRoots();
  try {
    const first = entry("alpha", [manualTarget]);
    const second = entry("beta", [manualTarget]);
    await reconcile(roots, [first, second]);
    const next = [entry("alpha", [manualTarget], skillFiles("alpha", "Next.\n")), entry("beta", [manualTarget], skillFiles("beta", "Next.\n"))];
    await reconcile(roots, next, { previousVersionGraceMs: Number.MAX_SAFE_INTEGER, now: 1 });
    // An older runner could leave a stale Manual Only copy without its agent-invocation sibling.
    rmSync(storeCopy(roots, "alpha", first.versionDigest), { recursive: true });
    rmSync(storeCopy(roots, "beta", second.versionDigest), { recursive: true });
    const cleanOrphan = storeCopy(roots, "alpha", `${first.versionDigest}-manual`);
    const editedOrphan = storeCopy(roots, "beta", `${second.versionDigest}-manual`);
    writeFileSync(join(editedOrphan, "SKILL.md"), `${readFileSync(join(editedOrphan, "SKILL.md"), "utf8")}Edit.\n`);

    const result = await reconcile(roots, next, { previousVersionGraceMs: 0, now: 2 });
    assert.deepEqual(result.drift?.map((copy) => `${copy.name}:${copy.variant}`), ["beta:manual"]);
    assert.equal(existsSync(cleanOrphan), false, "a verified clean orphan ages out normally");
    assert.equal(existsSync(editedOrphan), true, "an edited orphan is retained and reported");

    const restored = handleSkillDrift({
      message: { type: "skill_drift", runnerId: "runner-1", requestId: "restore-orphan", operation: "restore",
        name: "beta", digest: second.versionDigest, variant: "manual", observedDigest: result.drift?.[0]?.observedDigest ?? null,
        files: second.files, confirmation: "explicit" },
      runnerId: "runner-1",
      dataDir: roots.dataDir,
    });
    assert.equal(restored.status, "restored");
    assert.equal(existsSync(storeCopy(roots, "beta", second.versionDigest)), true,
      "restoring republishes the missing agent-invocation sibling from library files");
    assert.deepEqual((await reconcile(roots, next, { previousVersionGraceMs: Number.MAX_SAFE_INTEGER, now: 3 })).drift, []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a live edited Manual Only copy stays held after its edited agent sibling is captured", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget, { agentId: codexAgent.id, invocation: "agent" }]);
    const claudeManual = [manualTarget, { agentId: codexAgent.id, invocation: "agent" as const }];
    const both = { ...alpha, targets: claudeManual };
    await reconcile(roots, [both]);
    const claudeLink = join(roots.home, ".claude", "skills", "alpha");
    const codexLink = join(roots.home, ".codex", "skills", "alpha");
    assert.equal(linkTarget(claudeLink), storeCopy(roots, "alpha", `${alpha.versionDigest}-manual`));
    const manualSkillMd = readFileSync(join(claudeLink, "SKILL.md"), "utf8");
    writeFileSync(join(claudeLink, "SKILL.md"), `${manualSkillMd}Claude edit.\n`);
    writeFileSync(join(codexLink, "SKILL.md"), `${alpha.files[0]!.content}Codex edit.\n`);

    const drift = await reconcile(roots, [both]);
    assert.deepEqual(drift.drift?.map((copy) => `${copy.variant}:${copy.held}`).sort(), ["agent:true", "manual:true"]);

    const imported = { ...entry("alpha", claudeManual, editedFiles("alpha", "Codex edit.\n")) };
    const result = await reconcile(roots, [imported], { previousVersionGraceMs: 0, now: 5 });
    assert.deepEqual(result.drift?.map((copy) => `${copy.variant}:${copy.held}`), ["manual:true"],
      "the captured agent edit clears while the unresolved Manual Only edit still holds the skill");
    assert.equal(linkTarget(claudeLink), storeCopy(roots, "alpha", `${alpha.versionDigest}-manual`));
    assert.equal(readFileSync(join(claudeLink, "SKILL.md"), "utf8"), `${manualSkillMd}Claude edit.\n`);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("replacing a directory with a symlink during a read never reads outside the copy", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const copy = storeCopy(roots, "alpha", alpha.versionDigest);
    const outside = join(roots.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "notes.md"), "outside the store\n");
    const swap = (relativeDirectory: string) => {
      if (relativeDirectory !== "reference/") return;
      renameSync(join(copy, "reference"), join(copy, "reference-moved"));
      symlinkSync(outside, join(copy, "reference"));
    };
    const restoreTree = () => {
      unlinkSync(join(copy, "reference"));
      renameSync(join(copy, "reference-moved"), join(copy, "reference"));
    };
    for (const anchored of process.platform === "linux" ? [true, false] : [false]) {
      const read = readStoreSkillCopy(copy, { anchored, beforeList: swap });
      restoreTree();
      if (read.readable) {
        assert.ok(anchored, "only descriptor-anchored traversal may still read the original directory");
        assert.equal(read.files.find((file) => file.path === "reference/notes.md")?.content, "Notes.\n");
      } else {
        assert.equal(read.reason, "a directory changed while it was read");
      }
      assert.ok(!read.readable || read.files.every((file) => !file.content.includes("outside the store")));
    }
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an edit that lands after the drift scan still holds the links it is served through", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [agentTarget]);
    await reconcile(roots, [alpha]);
    const canonical = join(roots.home, ".agents", "skills", "alpha");
    const claudeLink = join(roots.home, ".claude", "skills", "alpha");
    const copy = storeCopy(roots, "alpha", alpha.versionDigest);
    const editDuringPass = () => writeFileSync(join(copy, "SKILL.md"), "edited after the scan\n");

    const update = entry("alpha", [agentTarget], skillFiles("alpha", "Update.\n"));
    const updated = await reconcile(roots, [update], { previousVersionGraceMs: 0, now: 1, acquireProviderHomeLease: editDuringPass });
    assert.equal(linkTarget(canonical), copy, "the canonical link is not repointed away from the late edit");
    assert.equal(updated.drift?.[0]?.held, true);
    assert.equal(updated.deployed[0]!.links[0]!.status, "conflict");

    const other = makeRoots();
    try {
      await reconcile(other, [alpha]);
      const otherCopy = storeCopy(other, "alpha", alpha.versionDigest);
      const removed = await reconcile(other, [], {
        acquireProviderHomeLease: () => writeFileSync(join(otherCopy, "SKILL.md"), "edited after the scan\n"),
      });
      assert.deepEqual(removed.removedLinks, [], "a removal does not sweep links serving the late edit");
      assert.equal(lstatSync(join(other.home, ".claude", "skills", "alpha")).isSymbolicLink(), true);
      assert.equal(removed.drift?.[0]?.held, true);
    } finally {
      rmSync(other.root, { recursive: true, force: true });
    }
    assert.equal(readFileSync(join(claudeLink, "SKILL.md"), "utf8"), "edited after the scan\n");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("store GC re-verifies a copy immediately before deleting it", async () => {
  const roots = makeRoots();
  try {
    const first = entry("alpha", [agentTarget]);
    await reconcile(roots, [first]);
    const second = entry("alpha", [agentTarget], skillFiles("alpha", "Second.\n"));
    await reconcile(roots, [second], { previousVersionGraceMs: Number.MAX_SAFE_INTEGER, now: 0 });
    const staleCopy = storeCopy(roots, "alpha", first.versionDigest);
    // The lease is acquired after the drift scan and before GC: an edit landing in that window
    // (an editor still holding the formerly linked file open) must not be collected.
    const result = await reconcile(roots, [second], {
      previousVersionGraceMs: 0,
      now: 1,
      acquireProviderHomeLease: () => writeFileSync(join(staleCopy, "SKILL.md"), "late edit\n"),
    });
    assert.equal(readFileSync(join(staleCopy, "SKILL.md"), "utf8"), "late edit\n");
    assert.deepEqual(result.drift, [], "the scan ran before the edit");
    const next = await reconcile(roots, [second], { previousVersionGraceMs: 0, now: 2 });
    assert.equal(next.drift?.[0]?.digest, first.versionDigest, "the next pass reports the late edit");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a Manual Only link in a credential home keeps an edited stale copy live", async () => {
  const roots = makeRoots();
  try {
    const accountSkills = join(roots.root, "claude-work", "skills");
    const first = entry("alpha", [manualTarget]);
    await reconcile(roots, [first]);
    await reconcile(roots, [first], {
      harnessDirectories: { ".claude/skills": accountSkills }, harnessScope: [".claude/skills"],
      reportUnknownTargets: false, manageCanonical: false, providerAccountId: "work",
    });
    const second = entry("alpha", [manualTarget], skillFiles("alpha", "Second.\n"));
    await reconcile(roots, [second], { previousVersionGraceMs: Number.MAX_SAFE_INTEGER, now: 1 });
    const accountLink = join(accountSkills, "alpha");
    assert.equal(linkTarget(accountLink), storeCopy(roots, "alpha", `${first.versionDigest}-manual`));
    writeFileSync(join(accountLink, "SKILL.md"), "edited through the account home\n");

    const withoutAccountDirs = await reconcile(roots, [second], { previousVersionGraceMs: Number.MAX_SAFE_INTEGER, now: 2 });
    assert.equal(withoutAccountDirs.drift?.[0]?.held, false);
    const withAccountDirs = await reconcile(roots, [second], {
      previousVersionGraceMs: Number.MAX_SAFE_INTEGER, now: 3, liveLinkDirectories: [accountSkills],
    });
    assert.equal(withAccountDirs.drift?.[0]?.variant, "manual");
    assert.equal(withAccountDirs.drift?.[0]?.held, true);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("merged account and WSL reports carry the base pass drift", () => {
  const drift = [{ name: "alpha", digest: "a".repeat(64), variant: "agent" as const, held: true }];
  const base = { deployed: [], unmanaged: [], removedLinks: [], drift };
  const account = { deployed: [], unmanaged: [], removedLinks: [] };
  assert.deepEqual(mergeReconcileSkillsResults(base, account).drift, drift);
  assert.equal(mergeReconcileSkillsResults(account, account).drift, undefined);
  assert.deepEqual(mergeWslSkillsResult(base, account, agents).drift, drift);
});
