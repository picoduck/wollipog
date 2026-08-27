import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { AgentDefinition, SkillFile, SkillSyncEntry, SkillSyncTarget } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import {
  SKILL_SCAN_LIMITS,
  linkManifestPath,
  parseSkillFrontmatter,
  reconcileSkills,
  skillRetentionStatePath,
  skillsStateMessage,
  skillsStoreRoot,
  withManualInvocationFrontmatter,
} from "./skills.js";

const claudeAgent: AgentDefinition = {
  id: "claude-main",
  name: "Claude Code",
  command: "claude",
  args: [],
  env: {},
  driver: "claude-code",
  context: { kind: "native" },
};
const codexAgent: AgentDefinition = {
  id: "codex-main",
  name: "Codex",
  command: "codex",
  args: [],
  env: {},
  driver: "codex-app-server",
  context: { kind: "native" },
};
const agents = [claudeAgent, codexAgent];

function makeRoots(): { root: string; home: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "runner-skills-"));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return { root, home, dataDir };
}

function skillFiles(name: string, body = "Do the thing.\n"): SkillFile[] {
  return [
    {
      path: "SKILL.md",
      content: `---\nname: ${name}\ndescription: Managed test skill\n---\n\n${body}`,
      encoding: "utf8",
    },
    { path: "reference/notes.md", content: "Notes.\n", encoding: "utf8" },
  ];
}

function entry(name: string, targets: SkillSyncTarget[], files = skillFiles(name)): SkillSyncEntry {
  return { name, versionDigest: skillVersionDigest(files), files, targets };
}

async function reconcile(
  roots: { home: string; dataDir: string },
  desired: SkillSyncEntry[],
  overrides: {
    allowRemovals?: boolean;
    agents?: AgentDefinition[];
    platform?: NodeJS.Platform;
    log?: (message: string) => void;
    acquireProviderHomeLease?: () => void;
    removedSkillRetentionMs?: number;
    previousVersionGraceMs?: number;
    now?: number;
  } = {},
) {
  return reconcileSkills({
    dataDir: roots.dataDir,
    home: roots.home,
    agents: overrides.agents ?? agents,
    desired,
    allowRemovals: overrides.allowRemovals ?? true,
    ...(overrides.platform ? { platform: overrides.platform } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
    ...(overrides.acquireProviderHomeLease
      ? { acquireProviderHomeLease: overrides.acquireProviderHomeLease }
      : {}),
    ...(overrides.removedSkillRetentionMs !== undefined
      ? { removedSkillRetentionMs: overrides.removedSkillRetentionMs }
      : {}),
    ...(overrides.previousVersionGraceMs !== undefined
      ? { previousVersionGraceMs: overrides.previousVersionGraceMs }
      : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });
}

function linkTarget(linkPath: string): string {
  return resolve(dirname(linkPath), readlinkSync(linkPath));
}

test("manual variant frontmatter injection covers existing, absent, and conflicting frontmatter", () => {
  const withBlock = withManualInvocationFrontmatter("---\nname: alpha\n---\n\nBody\n");
  assert.equal(withBlock, "---\ndisable-model-invocation: true\nname: alpha\n---\n\nBody\n");

  const withoutBlock = withManualInvocationFrontmatter("Just a body\n");
  assert.equal(withoutBlock, "---\ndisable-model-invocation: true\n---\n\nJust a body\n");

  const conflicting = withManualInvocationFrontmatter(
    "---\ndisable-model-invocation: false\nname: alpha\n---\nBody\n",
  );
  assert.equal(conflicting, "---\ndisable-model-invocation: true\nname: alpha\n---\nBody\n");
});

test("skill frontmatter reader is line-based, bounded, and truncating", () => {
  const long = "x".repeat(SKILL_SCAN_LIMITS.maxValueCharacters + 40);
  const meta = parseSkillFrontmatter(`---\nname: local-skill\ndescription: ${long}\n---\n\nBody`);
  assert.equal(meta.name, "local-skill");
  assert.equal(meta.description?.length, SKILL_SCAN_LIMITS.maxValueCharacters);

  // An unterminated frontmatter block is body text, not partially trusted metadata.
  assert.deepEqual(parseSkillFrontmatter("---\nname: dangling\n\nBody"), {});
});

test("reconcile materializes verified versions and links every harness through the canonical link", async () => {
  const roots = makeRoots();
  try {
    const desired = [
      entry("alpha", [
        { agentId: claudeAgent.id, invocation: "agent" },
        { agentId: codexAgent.id, invocation: "agent" },
      ]),
    ];
    const result = await reconcile(roots, desired);

    assert.equal(result.deployed.length, 1);
    const state = result.deployed[0]!;
    assert.equal(state.name, "alpha");
    assert.equal(state.digest, desired[0]!.versionDigest);
    assert.equal(state.error, undefined);
    assert.deepEqual(
      new Map(state.links.map((link) => [link.agentId, link.status])),
      new Map([
        [claudeAgent.id, "linked"],
        [codexAgent.id, "linked"],
      ]),
    );

    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    const agentDir = join(store, "alpha", state.digest);
    assert.equal(
      readFileSync(join(agentDir, "SKILL.md"), "utf8"),
      desired[0]!.files[0]!.content,
    );
    assert.equal(readFileSync(join(agentDir, "reference", "notes.md"), "utf8"), "Notes.\n");
    // No manual target, so the manual variant is never materialized.
    assert.equal(existsSync(`${agentDir}-manual`), false);

    // The canonical link points at the store; every harness link routes through the canonical
    // link so one atomic canonical flip switches all harnesses at once.
    const canonicalPath = join(roots.home, ".agents", "skills", "alpha");
    assert.equal(linkTarget(canonicalPath), agentDir);
    assert.equal(linkTarget(join(roots.home, ".claude", "skills", "alpha")), canonicalPath);
    assert.equal(linkTarget(join(roots.home, ".codex", "skills", "alpha")), canonicalPath);
    assert.equal(realpathSync(join(roots.home, ".claude", "skills", "alpha")), agentDir);
    assert.equal(realpathSync(join(roots.home, ".codex", "skills", "alpha")), agentDir);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a claude manual target links the manual variant directly, bypassing the canonical link", async () => {
  const roots = makeRoots();
  try {
    const desired = [entry("alpha", [{ agentId: claudeAgent.id, invocation: "manual" }])];
    const result = await reconcile(roots, desired);
    const state = result.deployed[0]!;
    assert.equal(state.error, undefined);
    assert.deepEqual(state.links, [{ agentId: claudeAgent.id, status: "linked" }]);

    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    const agentDir = join(store, "alpha", state.digest);
    const manualDir = `${agentDir}-manual`;
    const manualSkillMd = readFileSync(join(manualDir, "SKILL.md"), "utf8");
    assert.match(manualSkillMd, /^---\ndisable-model-invocation: true\nname: alpha\n/);
    // The manual variant's content differs from the canonical agent-invocation variant, so its
    // harness link points straight at the -manual digest dir.
    assert.equal(linkTarget(join(roots.home, ".claude", "skills", "alpha")), manualDir);
    assert.equal(linkTarget(join(roots.home, ".agents", "skills", "alpha")), agentDir);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a digest mismatch is rejected before anything is written", async () => {
  const roots = makeRoots();
  try {
    const bad = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    bad.versionDigest = "0".repeat(64);
    const result = await reconcile(roots, [bad]);

    assert.equal(result.deployed.length, 1);
    assert.match(result.deployed[0]!.error ?? "", /digest does not match/);
    assert.deepEqual(result.deployed[0]!.links, []);
    assert.equal(existsSync(join(skillsStoreRoot(roots.dataDir), "alpha")), false);
    assert.equal(existsSync(join(roots.home, ".agents", "skills", "alpha")), false);
    assert.equal(existsSync(join(roots.home, ".claude", "skills", "alpha")), false);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a traversal file path is rejected before anything is written", async () => {
  const roots = makeRoots();
  try {
    const files: SkillFile[] = [
      { path: "SKILL.md", content: "---\nname: alpha\n---\nBody", encoding: "utf8" },
      { path: "../evil.md", content: "nope", encoding: "utf8" },
    ];
    const result = await reconcile(roots, [
      { name: "alpha", versionDigest: skillVersionDigest(files), files, targets: [] },
    ]);
    assert.match(result.deployed[0]!.error ?? "", /invalid skill file path/);
    assert.equal(existsSync(join(skillsStoreRoot(roots.dataDir), "alpha")), false);
    assert.equal(existsSync(join(roots.dataDir, "skills", "evil.md")), false);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a real directory at a link path is a reported conflict and is never touched", async () => {
  const roots = makeRoots();
  try {
    const occupied = join(roots.home, ".claude", "skills", "alpha");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "sentinel.txt"), "keep me");

    const result = await reconcile(roots, [
      entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]),
    ]);
    const link = result.deployed[0]!.links.find((l) => l.agentId === claudeAgent.id)!;
    assert.equal(link.status, "conflict");
    assert.match(link.detail ?? "", /unmanaged file or directory/);
    assert.equal(lstatSync(occupied).isDirectory(), true);
    assert.equal(readFileSync(join(occupied, "sentinel.txt"), "utf8"), "keep me");
    // The canonical link is independent of the harness conflict.
    assert.equal(lstatSync(join(roots.home, ".agents", "skills", "alpha")).isSymbolicLink(), true);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an unknown target agent is reported as unsupported", async () => {
  const roots = makeRoots();
  try {
    const result = await reconcile(roots, [
      entry("alpha", [{ agentId: "ghost", invocation: "agent" }]),
    ]);
    const link = result.deployed[0]!.links.find((l) => l.agentId === "ghost")!;
    assert.equal(link.status, "unsupported");
    assert.match(link.detail ?? "", /not present/);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("shrinking desired removes managed links but keeps store content; foreign entries survive", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    const beta = entry("beta", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [alpha, beta]);

    const claudeSkills = join(roots.home, ".claude", "skills");
    const foreignTarget = join(roots.home, "elsewhere");
    mkdirSync(foreignTarget, { recursive: true });
    symlinkSync(foreignTarget, join(claudeSkills, "foreign"));
    mkdirSync(join(claudeSkills, "realdir"), { recursive: true });
    writeFileSync(join(claudeSkills, "realdir", "keep.txt"), "keep");

    await reconcile(roots, [alpha]);

    assert.equal(existsSync(join(claudeSkills, "beta")), false);
    assert.equal(existsSync(join(roots.home, ".agents", "skills", "beta")), false);
    // Disable is link removal only: the staged store content stays for a cheap re-enable.
    assert.equal(existsSync(join(skillsStoreRoot(roots.dataDir), "beta", beta.versionDigest)), true);
    // Still-desired deployment and every foreign entry survive untouched.
    assert.equal(lstatSync(join(claudeSkills, "alpha")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(claudeSkills, "foreign")).isSymbolicLink(), true);
    assert.equal(readFileSync(join(claudeSkills, "realdir", "keep.txt"), "utf8"), "keep");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an invocation flip retains the prior variant through the grace period, then GCs it", async () => {
  const roots = makeRoots();
  try {
    const manual = entry("alpha", [{ agentId: claudeAgent.id, invocation: "manual" }]);
    await reconcile(roots, [manual], { now: 1_000 });
    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    const digest = manual.versionDigest;
    assert.equal(existsSync(join(store, "alpha", `${digest}-manual`)), true);
    assert.equal(
      linkTarget(join(roots.home, ".claude", "skills", "alpha")),
      join(store, "alpha", `${digest}-manual`),
    );

    const agent = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [agent], { now: 2_000, previousVersionGraceMs: 60_000 });
    // The agent-invocation link routes through the canonical link, which points at the digest dir.
    assert.equal(
      linkTarget(join(roots.home, ".claude", "skills", "alpha")),
      join(roots.home, ".agents", "skills", "alpha"),
    );
    assert.equal(realpathSync(join(roots.home, ".claude", "skills", "alpha")), join(store, "alpha", digest));
    assert.equal(existsSync(join(store, "alpha", `${digest}-manual`)), true);
    assert.equal(existsSync(join(store, "alpha", digest)), true);
    await reconcile(roots, [agent], { now: 62_001, previousVersionGraceMs: 60_000 });
    assert.equal(existsSync(join(store, "alpha", `${digest}-manual`)), false);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an empty desired list before the first sync performs no removals", async () => {
  const roots = makeRoots();
  try {
    await reconcile(roots, [entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }])]);
    const unmanagedDir = join(roots.home, ".claude", "skills", "local-skill");
    mkdirSync(unmanagedDir, { recursive: true });
    writeFileSync(join(unmanagedDir, "SKILL.md"), "---\nname: local-skill\ndescription: Mine\n---\nBody");

    const scanOnly = await reconcile(roots, [], { allowRemovals: false });
    assert.equal(lstatSync(join(roots.home, ".claude", "skills", "alpha")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(roots.home, ".agents", "skills", "alpha")).isSymbolicLink(), true);
    assert.equal(readdirSync(join(skillsStoreRoot(roots.dataDir), "alpha")).length, 1);
    assert.ok(scanOnly.unmanaged.some((s) => s.agentId === claudeAgent.id && s.name === "local-skill"));

    // The same empty list with an authoritative sync in hand does remove the links; the store
    // content stays staged (disable = link removal only).
    await reconcile(roots, [], { allowRemovals: true });
    assert.equal(existsSync(join(roots.home, ".claude", "skills", "alpha")), false);
    assert.equal(existsSync(join(roots.home, ".agents", "skills", "alpha")), false);
    assert.equal(existsSync(join(skillsStoreRoot(roots.dataDir), "alpha")), true);
    assert.equal(lstatSync(unmanagedDir).isDirectory(), true);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("unmanaged scan reports real skill directories with parsed, truncated metadata", async () => {
  const roots = makeRoots();
  try {
    const dir = join(roots.home, ".claude", "skills", "local-skill");
    mkdirSync(dir, { recursive: true });
    const longDescription = "d".repeat(SKILL_SCAN_LIMITS.maxValueCharacters + 100);
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: local-skill\ndescription: ${longDescription}\n---\n\nBody`,
    );
    // A directory without a SKILL.md is not a skill; a bare file is not a skill either.
    mkdirSync(join(roots.home, ".claude", "skills", "not-a-skill"), { recursive: true });
    writeFileSync(join(roots.home, ".claude", "skills", "stray.md"), "stray");

    const result = await reconcile(roots, []);
    const found = result.unmanaged.filter((s) => s.agentId === claudeAgent.id);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.name, "local-skill");
    assert.equal(found[0]!.description?.length, SKILL_SCAN_LIMITS.maxValueCharacters);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("unmanaged scan is bounded per harness directory", async () => {
  const roots = makeRoots();
  try {
    const skills = join(roots.home, ".claude", "skills");
    for (let index = 0; index < SKILL_SCAN_LIMITS.maxEntriesPerDirectory + 10; index += 1) {
      const dir = join(skills, `skill-${String(index).padStart(3, "0")}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\ndescription: One\n---\nBody");
    }
    const result = await reconcile(roots, []);
    const found = result.unmanaged.filter((s) => s.agentId === claudeAgent.id);
    assert.equal(found.length, SKILL_SCAN_LIMITS.maxEntriesPerDirectory);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a symlinked store name dir is a reported error, never followed, and never deleted through", async () => {
  const roots = makeRoots();
  try {
    const outside = join(roots.root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "user-file.txt"), "precious");
    const store = skillsStoreRoot(roots.dataDir);
    mkdirSync(store, { recursive: true });
    symlinkSync(outside, join(store, "alpha"));

    const result = await reconcile(roots, [
      entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]),
    ]);
    const state = result.deployed[0]!;
    assert.match(state.error ?? "", /symlink/);
    assert.equal(state.links.length, 1);
    assert.equal(state.links[0]!.status, "error");
    // Nothing was published through the symlink and the outside content is untouched.
    assert.deepEqual(readdirSync(outside), ["user-file.txt"]);
    assert.equal(readFileSync(join(outside, "user-file.txt"), "utf8"), "precious");
    // The planted symlink is reported, not followed and not deleted.
    assert.equal(lstatSync(join(store, "alpha")).isSymbolicLink(), true);
    assert.equal(existsSync(join(roots.home, ".agents", "skills", "alpha")), false);
    assert.equal(existsSync(join(roots.home, ".claude", "skills", "alpha")), false);

    // A removal pass with the name absent from desired must not GC through the symlink either.
    await reconcile(roots, [], { allowRemovals: true });
    assert.deepEqual(readdirSync(outside), ["user-file.txt"]);
    assert.equal(lstatSync(join(store, "alpha")).isSymbolicLink(), true);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a symlink planted at the skills ancestor fails the whole pass with no writes outside the data dir", async () => {
  const roots = makeRoots();
  try {
    const outside = mkdtempSync(join(tmpdir(), "runner-skills-outside-"));
    try {
      // `<dataDir>/skills` is a symlink to an outside dir; only `<dataDir>/skills/store` gets
      // an lstat check, so a recursive mkdir of the store root would land inside `outside`.
      symlinkSync(outside, join(roots.dataDir, "skills"));

      const result = await reconcile(roots, [
        entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]),
        entry("beta", [{ agentId: codexAgent.id, invocation: "agent" }]),
      ]);

      // Every entry reports an error; nothing was materialized, linked, or removed.
      assert.equal(result.deployed.length, 2);
      for (const state of result.deployed) {
        assert.match(state.error ?? "", /skills store unavailable/);
        assert.match(state.error ?? "", /symlink/);
        assert.deepEqual(state.links, []);
      }
      assert.deepEqual(readdirSync(outside), []);
      // The planted symlink is reported, not followed and not deleted.
      assert.equal(lstatSync(join(roots.dataDir, "skills")).isSymbolicLink(), true);
      assert.equal(existsSync(join(roots.home, ".agents", "skills", "alpha")), false);
      assert.equal(existsSync(join(roots.home, ".claude", "skills", "alpha")), false);
      assert.equal(existsSync(join(roots.home, ".codex", "skills", "beta")), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a conflicted canonical path removes the managed harness links routed through it", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [
      { agentId: claudeAgent.id, invocation: "agent" },
      { agentId: codexAgent.id, invocation: "agent" },
    ]);
    await reconcile(roots, [alpha]);
    const canonicalPath = join(roots.home, ".agents", "skills", "alpha");
    const claudeLink = join(roots.home, ".claude", "skills", "alpha");
    const codexLink = join(roots.home, ".codex", "skills", "alpha");
    assert.equal(linkTarget(claudeLink), canonicalPath);

    // Replace the canonical symlink with a foreign real directory: the existing harness links
    // would otherwise keep resolving through it and serve the foreign content.
    unlinkSync(canonicalPath);
    mkdirSync(canonicalPath, { recursive: true });
    writeFileSync(join(canonicalPath, "marker.txt"), "foreign content");

    const result = await reconcile(roots, [alpha]);
    const state = result.deployed[0]!;
    // The canonical conflict is reported.
    assert.match(state.error ?? "", /canonical link:.*unmanaged file or directory/);
    for (const agentId of [claudeAgent.id, codexAgent.id]) {
      const link = state.links.find((candidate) => candidate.agentId === agentId)!;
      assert.equal(link.status, "error");
      assert.match(link.detail ?? "", /canonical location at ~\/\.agents\/skills\/alpha is conflicted/);
    }
    // The managed harness links are gone: nothing serves the foreign content under a managed name.
    assert.equal(existsSync(claudeLink), false);
    assert.equal(existsSync(codexLink), false);
    assert.deepEqual(result.removedLinks, [
      {
        path: "~/.claude/skills/alpha",
        reason: "The canonical location it routes through is conflicted.",
      },
      {
        path: "~/.codex/skills/alpha",
        reason: "The canonical location it routes through is conflicted.",
      },
    ]);
    // The foreign directory itself is never touched and its content survives byte-identical.
    const foreign = lstatSync(canonicalPath);
    assert.equal(foreign.isDirectory() && !foreign.isSymbolicLink(), true);
    assert.deepEqual(readdirSync(canonicalPath), ["marker.txt"]);
    assert.equal(readFileSync(join(canonicalPath, "marker.txt"), "utf8"), "foreign content");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a manual codex target is a conflict while the shared harness dir still exposes the skill", async () => {
  const roots = makeRoots();
  try {
    const codexCli: AgentDefinition = {
      id: "codex-cli",
      name: "Codex CLI",
      command: "codex",
      args: [],
      env: {},
      driver: "codex",
      context: { kind: "native" },
    };
    const roster = [claudeAgent, codexAgent, codexCli];

    // Another codex-driver agent gets an agent-invocable link in the shared ~/.codex/skills dir,
    // so the manual-only target can consume the skill anyway: that is a conflict, not a skip.
    const result = await reconcile(
      roots,
      [
        entry("alpha", [
          { agentId: codexCli.id, invocation: "manual" },
          { agentId: codexAgent.id, invocation: "agent" },
        ]),
      ],
      { agents: roster },
    );
    const links = result.deployed[0]!.links;
    const linked = links.find((link) => link.agentId === codexAgent.id)!;
    assert.equal(linked.status, "linked");
    const manual = links.find((link) => link.agentId === codexCli.id)!;
    assert.equal(manual.status, "conflict");
    assert.equal(
      manual.detail,
      "Manual-only invocation is not supported for this agent and the skill is still visible through the shared harness directory.",
    );
    assert.equal(lstatSync(join(roots.home, ".codex", "skills", "alpha")).isSymbolicLink(), true);

    // Flip to the manual codex target alone: no other target links into the shared dir, so the
    // state is plain unsupported and the previously shared link is swept.
    const alone = await reconcile(roots, [entry("alpha", [{ agentId: codexCli.id, invocation: "manual" }])], {
      agents: roster,
    });
    const aloneLinks = alone.deployed[0]!.links;
    assert.equal(aloneLinks.length, 1);
    assert.equal(aloneLinks[0]!.agentId, codexCli.id);
    assert.equal(aloneLinks[0]!.status, "unsupported");
    assert.equal(aloneLinks[0]!.detail, "Manual-only invocation is not supported for this agent.");
    assert.equal(existsSync(join(roots.home, ".codex", "skills", "alpha")), false);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("store GC never follows or deletes through a symlinked version entry", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [alpha]);
    const outside = join(roots.root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "user-file.txt"), "precious");
    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    symlinkSync(outside, join(store, "alpha", "stale-version"));

    await reconcile(roots, [alpha], { allowRemovals: true });
    assert.deepEqual(readdirSync(outside), ["user-file.txt"]);
    assert.equal(lstatSync(join(store, "alpha", "stale-version")).isSymbolicLink(), true);
    assert.equal(existsSync(join(store, "alpha", alpha.versionDigest)), true);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a link in a shared harness directory reports visibility to every agent sharing it", async () => {
  const roots = makeRoots();
  try {
    const codexCli: AgentDefinition = {
      id: "codex-cli",
      name: "Codex CLI",
      command: "codex",
      args: [],
      env: {},
      driver: "codex",
      context: { kind: "native" },
    };
    const roster = [claudeAgent, codexAgent, codexCli];
    const result = await reconcile(
      roots,
      [entry("alpha", [{ agentId: codexCli.id, invocation: "agent" }])],
      { agents: roster },
    );
    const links = result.deployed[0]!.links;
    // The targeted agent keeps its normal state.
    const targeted = links.find((link) => link.agentId === codexCli.id)!;
    assert.equal(targeted.status, "linked");
    assert.equal(targeted.detail, undefined);
    // codex-app-server shares ~/.codex/skills, so it can consume the link too and must say so.
    const shared = links.find((link) => link.agentId === codexAgent.id)!;
    assert.equal(shared.status, "linked");
    assert.equal(shared.detail, "Shared harness directory; also visible to this agent.");
    // claude-code reads a different directory and is not reported.
    assert.equal(links.some((link) => link.agentId === claudeAgent.id), false);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("manual-only invocation on codex drivers is unsupported and never linked", async () => {
  const roots = makeRoots();
  try {
    const codexCli: AgentDefinition = {
      id: "codex-cli",
      name: "Codex CLI",
      command: "codex",
      args: [],
      env: {},
      driver: "codex",
      context: { kind: "native" },
    };
    const desired = [
      entry("alpha", [
        { agentId: codexAgent.id, invocation: "manual" },
        { agentId: codexCli.id, invocation: "manual" },
      ]),
    ];
    const result = await reconcile(roots, desired, { agents: [claudeAgent, codexAgent, codexCli] });
    const links = result.deployed[0]!.links;
    assert.equal(links.length, 2);
    for (const link of links) {
      assert.equal(link.status, "unsupported");
      assert.equal(link.detail, "Manual-only invocation is not supported for this agent.");
    }
    // Nothing is linked into the shared codex directory and no manual variant is materialized.
    assert.equal(existsSync(join(roots.home, ".codex", "skills", "alpha")), false);
    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    assert.equal(existsSync(join(store, "alpha", `${desired[0]!.versionDigest}-manual`)), false);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("disabling a skill removes links but retains the staged store content for re-enable", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [alpha]);
    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    const agentDir = join(store, "alpha", alpha.versionDigest);
    writeFileSync(join(agentDir, "retained-marker"), "keep");

    await reconcile(roots, [], { allowRemovals: true });
    assert.equal(existsSync(join(roots.home, ".claude", "skills", "alpha")), false);
    assert.equal(existsSync(join(roots.home, ".agents", "skills", "alpha")), false);
    // Disable = link removal; the staged content stays so re-enabling needs no re-transfer.
    assert.equal(readFileSync(join(agentDir, "SKILL.md"), "utf8"), alpha.files[0]!.content);

    const reEnabled = await reconcile(roots, [alpha]);
    assert.deepEqual(reEnabled.deployed[0]!.links, [{ agentId: claudeAgent.id, status: "linked" }]);
    assert.equal(realpathSync(join(roots.home, ".claude", "skills", "alpha")), agentDir);
    assert.equal(readFileSync(join(agentDir, "retained-marker"), "utf8"), "keep",
      "re-enable reused the retained version rather than rematerializing it");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an undesired skill is deleted only after its configured retention window", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [alpha], { now: 1_000 });
    const versionPath = join(realpathSync(skillsStoreRoot(roots.dataDir)), "alpha", alpha.versionDigest);

    await reconcile(roots, [], { now: 2_000, removedSkillRetentionMs: 10_000 });
    assert.equal(existsSync(versionPath), true);
    await reconcile(roots, [], { now: 11_999, removedSkillRetentionMs: 10_000 });
    assert.equal(existsSync(versionPath), true);
    await reconcile(roots, [], { now: 12_000, removedSkillRetentionMs: 10_000 });
    assert.equal(existsSync(versionPath), false);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a foreign invalid store name cannot reset valid retention windows", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [alpha], { now: 1_000 });
    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    const alphaPath = join(store, "alpha", alpha.versionDigest);
    mkdirSync(join(store, "Not A Skill", "f".repeat(64)), { recursive: true });

    await reconcile(roots, [], { now: 2_000, removedSkillRetentionMs: 1_000 });
    assert.equal(existsSync(alphaPath), true);
    await reconcile(roots, [], { now: 3_000, removedSkillRetentionMs: 1_000 });
    assert.equal(existsSync(alphaPath), false);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("malformed retention state restarts the grace window instead of deleting early", async () => {
  const roots = makeRoots();
  try {
    const v1 = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [v1], { now: 1_000 });
    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    const v1Path = join(store, "alpha", v1.versionDigest);
    const v2 = entry(
      "alpha",
      [{ agentId: claudeAgent.id, invocation: "agent" }],
      skillFiles("alpha", "new version\n"),
    );
    await reconcile(roots, [v2], { now: 2_000, previousVersionGraceMs: 10_000 });
    writeFileSync(skillRetentionStatePath(roots.dataDir), "not json");

    await reconcile(roots, [v2], { now: 20_000, previousVersionGraceMs: 10_000 });
    assert.equal(existsSync(v1Path), true);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("retention GC refuses a stale version tree containing a symlink", async () => {
  const roots = makeRoots();
  try {
    const v1 = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [v1], { now: 1_000 });
    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    const v1Path = join(store, "alpha", v1.versionDigest);
    const outside = join(roots.root, "outside-retention");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "keep");
    symlinkSync(outside, join(v1Path, "planted-link"));
    const v2 = entry(
      "alpha",
      [{ agentId: claudeAgent.id, invocation: "agent" }],
      skillFiles("alpha", "new version\n"),
    );

    await reconcile(roots, [v2], { now: 2_000, previousVersionGraceMs: 0 });
    assert.equal(existsSync(v1Path), true, "the unsafe stale tree is retained for inspection");
    assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a content-free manifest reuses a verified stored digest without retransferring files", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [alpha]);
    const reused = await reconcileSkills({
      dataDir: roots.dataDir,
      home: roots.home,
      agents,
      desired: [{
        name: alpha.name,
        versionDigest: alpha.versionDigest,
        targets: [
          { agentId: claudeAgent.id, invocation: "agent" },
          { agentId: codexAgent.id, invocation: "agent" },
        ],
      }],
      allowRemovals: true,
    });
    assert.deepEqual(
      new Map(reused.deployed[0]!.links.map((link) => [link.agentId, link.status])),
      new Map([[claudeAgent.id, "linked"], [codexAgent.id, "linked"]]),
    );
    assert.equal(
      realpathSync(join(roots.home, ".codex", "skills", "alpha")),
      join(realpathSync(skillsStoreRoot(roots.dataDir)), "alpha", alpha.versionDigest),
    );
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an incomplete content-free manifest never removes the prior deployment", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [alpha]);
    const harnessPath = join(roots.home, ".claude", "skills", "alpha");
    const before = realpathSync(harnessPath);
    const incomplete = await reconcileSkills({
      dataDir: roots.dataDir,
      home: roots.home,
      agents,
      desired: [{
        name: alpha.name,
        versionDigest: "f".repeat(64),
        targets: alpha.targets,
      }],
      allowRemovals: true,
    });
    assert.match(incomplete.deployed[0]!.error ?? "", /absent from the runner store/);
    assert.equal(realpathSync(harnessPath), before);
    assert.deepEqual(incomplete.removedLinks, []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a version bump flips only the canonical link; harness links stay routed through it", async () => {
  const roots = makeRoots();
  try {
    const v1 = entry("alpha", [
      { agentId: claudeAgent.id, invocation: "agent" },
      { agentId: codexAgent.id, invocation: "agent" },
    ]);
    await reconcile(roots, [v1]);
    const v2 = entry(
      "alpha",
      [
        { agentId: claudeAgent.id, invocation: "agent" },
        { agentId: codexAgent.id, invocation: "agent" },
      ],
      skillFiles("alpha", "Do the new thing.\n"),
    );
    assert.notEqual(v2.versionDigest, v1.versionDigest);
    await reconcile(roots, [v2]);

    const canonicalPath = join(roots.home, ".agents", "skills", "alpha");
    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    // Both harness links still point at the canonical link; only the canonical link moved.
    assert.equal(linkTarget(join(roots.home, ".claude", "skills", "alpha")), canonicalPath);
    assert.equal(linkTarget(join(roots.home, ".codex", "skills", "alpha")), canonicalPath);
    assert.equal(linkTarget(canonicalPath), join(store, "alpha", v2.versionDigest));
    assert.equal(
      realpathSync(join(roots.home, ".codex", "skills", "alpha")),
      join(store, "alpha", v2.versionDigest),
    );
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a foreign provider-home lease stages content but blocks every harness mutation", async () => {
  const roots = makeRoots();
  const contenderDataDir = join(roots.root, "contender-data");
  mkdirSync(contenderDataDir, { recursive: true });
  const holder = new ProviderHomeLeaseRegistry("a".repeat(64), {
    pid: 101,
    hostname: "shared-host",
  });
  const contender = new ProviderHomeLeaseRegistry("b".repeat(64), {
    pid: 202,
    hostname: "shared-host",
    isProcessAlive: (pid) => pid === 101,
  });
  const leaseRequest = {
    driver: "claude-code" as const,
    command: "claude",
    context: { kind: "native" as const },
    env: { HOME: roots.home },
  };
  try {
    const v1 = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [v1], {
      acquireProviderHomeLease: () => holder.acquire(leaseRequest),
    });
    const canonicalPath = join(roots.home, ".agents", "skills", "alpha");
    const harnessPath = join(roots.home, ".claude", "skills", "alpha");
    const canonicalBefore = readlinkSync(canonicalPath);
    const harnessBefore = readlinkSync(harnessPath);

    const v2 = entry(
      "alpha",
      [{ agentId: claudeAgent.id, invocation: "agent" }],
      skillFiles("alpha", "A contending version.\n"),
    );
    const blocked = await reconcile(
      { home: roots.home, dataDir: contenderDataDir },
      [v2],
      { acquireProviderHomeLease: () => contender.acquire(leaseRequest) },
    );

    assert.match(blocked.deployed[0]!.error ?? "", /provider-home lease unavailable/i);
    assert.match(blocked.error ?? "", /provider-home lease unavailable/i);
    assert.equal(blocked.deployed[0]!.links[0]!.status, "error");
    assert.match(blocked.deployed[0]!.links[0]!.detail ?? "", /already in use by process 101/);
    assert.equal(readlinkSync(canonicalPath), canonicalBefore);
    assert.equal(readlinkSync(harnessPath), harnessBefore);
    assert.equal(existsSync(linkManifestPath(contenderDataDir)), false);
    assert.equal(
      existsSync(join(skillsStoreRoot(contenderDataDir), "alpha", v2.versionDigest)),
      true,
      "runner-local materialization completes before the shared-home lease attempt",
    );

    const blockedRemoval = await reconcile(
      { home: roots.home, dataDir: contenderDataDir },
      [],
      { allowRemovals: true, acquireProviderHomeLease: () => contender.acquire(leaseRequest) },
    );
    assert.match(blockedRemoval.error ?? "", /already in use by process 101/);
    assert.equal(readlinkSync(canonicalPath), canonicalBefore);
    assert.equal(readlinkSync(harnessPath), harnessBefore);

  } finally {
    holder.releaseAll();
    contender.releaseAll();
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("canonical link mutations require the provider-home lease even without a harness binding", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    const canonicalPath = join(roots.home, ".agents", "skills", "alpha");
    const blocked = await reconcile(roots, [alpha], {
      agents: [],
      acquireProviderHomeLease: () => {
        assert.equal(existsSync(canonicalPath), false);
        throw new Error("foreign owner");
      },
    });
    assert.match(blocked.error ?? "", /foreign owner/);
    assert.equal(existsSync(canonicalPath), false);
    assert.equal(existsSync(join(skillsStoreRoot(roots.dataDir), "alpha", alpha.versionDigest)), true);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an orphaned harness link behind a removed canonical link is still swept as ours", async () => {
  const roots = makeRoots();
  try {
    await reconcile(roots, [entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }])]);
    // Simulate a crash that removed the canonical link but left the harness link dangling.
    unlinkSync(join(roots.home, ".agents", "skills", "alpha"));
    assert.equal(lstatSync(join(roots.home, ".claude", "skills", "alpha")).isSymbolicLink(), true);

    await reconcile(roots, [], { allowRemovals: true });
    // The dangling managed link is not misclassified as foreign; the sweep removes it.
    assert.equal(existsSync(join(roots.home, ".claude", "skills", "alpha")), false);
    assert.equal(
      readdirSync(join(roots.home, ".claude", "skills")).some((name) => name === "alpha"),
      false,
    );
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a user-created symlink to the canonical location survives the sweep and is reported unmanaged", async () => {
  const roots = makeRoots();
  try {
    // A hand-rolled skill lives at the canonical location as a real directory, and the user
    // hand-linked a harness dir to it — byte-identical in shape to a managed harness link.
    const canonicalPath = join(roots.home, ".agents", "skills", "mine");
    mkdirSync(canonicalPath, { recursive: true });
    writeFileSync(join(canonicalPath, "SKILL.md"), "---\nname: mine\ndescription: Hand-rolled\n---\nBody");
    const userLink = join(roots.home, ".claude", "skills", "mine");
    mkdirSync(dirname(userLink), { recursive: true });
    symlinkSync(canonicalPath, userLink);

    const result = await reconcile(roots, [], { allowRemovals: true });

    // The link the runner never created is left in place and stays functional.
    assert.equal(lstatSync(userLink).isSymbolicLink(), true);
    assert.equal(linkTarget(userLink), canonicalPath);
    assert.equal(realpathSync(userLink), realpathSync(canonicalPath));
    // Nothing was removed, and the hand-linked skill is visible in the reported state.
    assert.deepEqual(result.removedLinks, []);
    assert.ok(result.unmanaged.some((s) => s.agentId === claudeAgent.id && s.name === "mine"));
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a user-created dangling canonical-shaped link is never swept", async () => {
  const roots = makeRoots();
  try {
    // The canonical target does not exist: the link is dangling, exactly the shape the sweep
    // uses the canonical-path rule for. Without a manifest record it still is not ours.
    const userLink = join(roots.home, ".codex", "skills", "mine");
    mkdirSync(dirname(userLink), { recursive: true });
    symlinkSync(join(roots.home, ".agents", "skills", "mine"), userLink);

    const result = await reconcile(roots, [], { allowRemovals: true });
    assert.equal(lstatSync(userLink).isSymbolicLink(), true);
    assert.deepEqual(result.removedLinks, []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("removals of runner-created links are logged and returned in the reconcile result", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [
      { agentId: claudeAgent.id, invocation: "agent" },
      { agentId: codexAgent.id, invocation: "agent" },
    ]);
    await reconcile(roots, [alpha]);
    // The manifest records every link the deployment created.
    const manifest = JSON.parse(readFileSync(linkManifestPath(roots.dataDir), "utf8")) as {
      links: string[];
    };
    assert.deepEqual(
      new Set(manifest.links),
      new Set([
        join(roots.home, ".agents", "skills", "alpha"),
        join(roots.home, ".claude", "skills", "alpha"),
        join(roots.home, ".codex", "skills", "alpha"),
      ]),
    );

    const logged: string[] = [];
    const result = await reconcile(roots, [], { allowRemovals: true, log: (m) => logged.push(m) });
    assert.deepEqual(
      new Set(result.removedLinks.map((entry) => entry.path)),
      new Set(["~/.claude/skills/alpha", "~/.codex/skills/alpha", "~/.agents/skills/alpha"]),
    );
    for (const removal of result.removedLinks) {
      assert.equal(removal.reason, "No longer in the desired skill list.");
      assert.ok(
        logged.some((line) => line.includes("skill link removed") && line.includes(removal.path)),
        `expected a removal log line for ${removal.path}`,
      );
    }
    assert.deepEqual(
      skillsStateMessage("runner-1", result, "skills_request"),
      {
        type: "skills_state",
        runnerId: "runner-1",
        requestId: "skills_request",
        deployed: result.deployed,
        unmanaged: result.unmanaged,
        removals: result.removedLinks,
      },
      "the outbound skills_state carries this pass's exact removal records",
    );
    // The swept links leave the manifest too.
    const after = JSON.parse(readFileSync(linkManifestPath(roots.dataDir), "utf8")) as {
      links: string[];
    };
    assert.deepEqual(after.links, []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a conflicted canonical path leaves a user-created harness link in place and reports it", async () => {
  const roots = makeRoots();
  try {
    // Foreign real directory at the canonical path, plus a user-made harness link routing
    // through it. The runner created neither.
    const canonicalPath = join(roots.home, ".agents", "skills", "alpha");
    mkdirSync(canonicalPath, { recursive: true });
    writeFileSync(join(canonicalPath, "marker.txt"), "foreign content");
    const userLink = join(roots.home, ".claude", "skills", "alpha");
    mkdirSync(dirname(userLink), { recursive: true });
    symlinkSync(canonicalPath, userLink);

    const result = await reconcile(roots, [
      entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]),
    ]);
    const state = result.deployed[0]!;
    assert.match(state.error ?? "", /canonical link:.*unmanaged file or directory/);
    const link = state.links.find((candidate) => candidate.agentId === claudeAgent.id)!;
    assert.equal(link.status, "conflict");
    assert.match(link.detail ?? "", /not created by this runner and was left in place/);
    // Both user artifacts survive untouched.
    assert.equal(lstatSync(userLink).isSymbolicLink(), true);
    assert.equal(readFileSync(join(canonicalPath, "marker.txt"), "utf8"), "foreign content");
    assert.deepEqual(result.removedLinks, []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a corrupt link manifest fails safe: canonical-routed links are left, never swept", async () => {
  const roots = makeRoots();
  try {
    await reconcile(roots, [entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }])]);
    writeFileSync(linkManifestPath(roots.dataDir), "not json at all");

    const logged: string[] = [];
    const result = await reconcile(roots, [], { allowRemovals: true, log: (m) => logged.push(m) });
    assert.ok(logged.some((line) => line.includes("skill link manifest unreadable")));
    // The canonical link targets the store, so it is provably ours and still swept; the harness
    // link's only ownership evidence was the manifest, so it is left in place (fail-safe).
    assert.equal(existsSync(join(roots.home, ".agents", "skills", "alpha")), false);
    assert.equal(lstatSync(join(roots.home, ".claude", "skills", "alpha")).isSymbolicLink(), true);
    assert.deepEqual(result.removedLinks, [{
      path: "~/.agents/skills/alpha",
      reason: "No longer in the desired skill list.",
    }]);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a partially malformed manifest is rejected whole, not partially trusted", async () => {
  const roots = makeRoots();
  try {
    // A user hand-link plus a manifest the runner never wrote: one valid-looking absolute path
    // next to an invalid entry. Partially trusting it would authorize removing the user's link.
    const userLink = join(roots.home, ".claude", "skills", "mine");
    mkdirSync(dirname(userLink), { recursive: true });
    symlinkSync(join(roots.home, ".agents", "skills", "mine"), userLink);
    mkdirSync(join(roots.dataDir, "skills"), { recursive: true });
    writeFileSync(
      linkManifestPath(roots.dataDir),
      JSON.stringify({ version: 1, links: [userLink, 42] }),
    );

    const logged: string[] = [];
    const result = await reconcile(roots, [], { allowRemovals: true, log: (m) => logged.push(m) });
    assert.ok(logged.some((line) => line.includes("skill link manifest has an unknown shape")));
    assert.equal(lstatSync(userLink).isSymbolicLink(), true);
    assert.deepEqual(result.removedLinks, []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("a stale manifest entry never transfers to a user link created at the same path later", async () => {
  const roots = makeRoots();
  try {
    const alpha = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [alpha]);
    const claudeLink = join(roots.home, ".claude", "skills", "alpha");
    // Simulate a crash after the links vanished but before the manifest was saved: the recorded
    // paths hold nothing. A no-change pass must still prune and persist the shrunken record.
    unlinkSync(claudeLink);
    unlinkSync(join(roots.home, ".agents", "skills", "alpha"));
    await reconcile(roots, [], { allowRemovals: true });
    const persisted = JSON.parse(readFileSync(linkManifestPath(roots.dataDir), "utf8")) as {
      links: string[];
    };
    assert.deepEqual(persisted.links, []);

    // A user link created at the previously recorded path must not inherit the stale authority.
    symlinkSync(join(roots.home, ".agents", "skills", "alpha"), claudeLink);
    const result = await reconcile(roots, [], { allowRemovals: true });
    assert.equal(lstatSync(claudeLink).isSymbolicLink(), true);
    assert.deepEqual(result.removedLinks, []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("store gc logs what it removes", async () => {
  const roots = makeRoots();
  try {
    const v1 = entry("alpha", [{ agentId: claudeAgent.id, invocation: "agent" }]);
    await reconcile(roots, [v1]);
    const v2 = entry(
      "alpha",
      [{ agentId: claudeAgent.id, invocation: "agent" }],
      skillFiles("alpha", "Do the new thing.\n"),
    );
    const logged: string[] = [];
    await reconcile(roots, [v2], {
      log: (m) => logged.push(m),
      previousVersionGraceMs: 0,
      now: 1_000,
    });
    assert.ok(
      logged.some((line) => line.includes("skill store gc") && line.includes(v1.versionDigest)),
      "expected a gc log line for the stale version",
    );
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("windows performs no writes and reports every link as unsupported", async () => {
  const roots = makeRoots();
  try {
    const result = await reconcile(
      roots,
      [
        entry("alpha", [
          { agentId: claudeAgent.id, invocation: "agent" },
          { agentId: codexAgent.id, invocation: "manual" },
        ]),
      ],
      { platform: "win32" },
    );
    for (const link of result.deployed[0]!.links) {
      assert.equal(link.status, "unsupported");
      assert.match(link.detail ?? "", /Windows/);
    }
    assert.equal(existsSync(join(roots.dataDir, "skills")), false);
    assert.deepEqual(readdirSync(roots.home), []);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("the synthesized conductor contributes no harness binding", async () => {
  // It shares the donor Claude's ~/.claude/skills directory: a second binding for the same
  // directory doubles every unmanaged row and turns one directory's state into a per-agent
  // conflict under mixed invocation policies.
  const home = mkdtempSync(join(tmpdir(), "wollipog-skills-conductor-"));
  const dataDir = mkdtempSync(join(tmpdir(), "wollipog-skills-conductor-data-"));
  try {
    mkdirSync(join(home, ".claude", "skills", "handrolled"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "handrolled", "SKILL.md"), "---\nname: handrolled\n---\n");
    const agents = [
      { id: "claude-native", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code" as const },
      { id: "conductor", name: "Conductor (Wollipog)", command: "claude", args: [], env: {}, driver: "claude-code" as const },
    ];
    const result = await reconcileSkills({ dataDir, home, agents, desired: [], allowRemovals: false, log: () => {} });
    const unmanagedAgents = result.unmanaged.flatMap((entry) => entry.agentIds ?? []);
    assert.equal(unmanagedAgents.includes("conductor"), false);
    const reported = JSON.stringify(result);
    assert.equal(reported.includes('"conductor"'), false, "no per-agent state names the conductor");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
