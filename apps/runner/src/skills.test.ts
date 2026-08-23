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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { AgentDefinition, SkillFile, SkillSyncEntry, SkillSyncTarget } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import {
  SKILL_SCAN_LIMITS,
  parseSkillFrontmatter,
  reconcileSkills,
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
  overrides: { allowRemovals?: boolean; agents?: AgentDefinition[]; platform?: NodeJS.Platform } = {},
) {
  return reconcileSkills({
    dataDir: roots.dataDir,
    home: roots.home,
    agents: overrides.agents ?? agents,
    desired,
    allowRemovals: overrides.allowRemovals ?? true,
    ...(overrides.platform ? { platform: overrides.platform } : {}),
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

test("reconcile materializes verified versions and links claude and codex variants", async () => {
  const roots = makeRoots();
  try {
    const desired = [
      entry("alpha", [
        { agentId: claudeAgent.id, invocation: "agent" },
        { agentId: codexAgent.id, invocation: "manual" },
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
    const manualDir = `${agentDir}-manual`;
    assert.equal(
      readFileSync(join(agentDir, "SKILL.md"), "utf8"),
      desired[0]!.files[0]!.content,
    );
    assert.equal(readFileSync(join(agentDir, "reference", "notes.md"), "utf8"), "Notes.\n");
    const manualSkillMd = readFileSync(join(manualDir, "SKILL.md"), "utf8");
    assert.match(manualSkillMd, /^---\ndisable-model-invocation: true\nname: alpha\n/);

    assert.equal(linkTarget(join(roots.home, ".agents", "skills", "alpha")), agentDir);
    assert.equal(linkTarget(join(roots.home, ".claude", "skills", "alpha")), agentDir);
    assert.equal(linkTarget(join(roots.home, ".codex", "skills", "alpha")), manualDir);
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

test("shrinking desired removes managed links and GCs the store; foreign entries survive", async () => {
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
    assert.equal(existsSync(join(skillsStoreRoot(roots.dataDir), "beta")), false);
    // Still-desired deployment and every foreign entry survive untouched.
    assert.equal(lstatSync(join(claudeSkills, "alpha")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(claudeSkills, "foreign")).isSymbolicLink(), true);
    assert.equal(readFileSync(join(claudeSkills, "realdir", "keep.txt"), "utf8"), "keep");
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test("an invocation flip retargets the harness link and GCs the stale manual variant", async () => {
  const roots = makeRoots();
  try {
    const manual = entry("alpha", [{ agentId: codexAgent.id, invocation: "manual" }]);
    await reconcile(roots, [manual]);
    const store = realpathSync(skillsStoreRoot(roots.dataDir));
    const digest = manual.versionDigest;
    assert.equal(existsSync(join(store, "alpha", `${digest}-manual`)), true);

    await reconcile(roots, [entry("alpha", [{ agentId: codexAgent.id, invocation: "agent" }])]);
    assert.equal(linkTarget(join(roots.home, ".codex", "skills", "alpha")), join(store, "alpha", digest));
    assert.equal(existsSync(join(store, "alpha", `${digest}-manual`)), false);
    assert.equal(existsSync(join(store, "alpha", digest)), true);
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

    // The same empty list with an authoritative sync in hand does remove the deployment.
    await reconcile(roots, [], { allowRemovals: true });
    assert.equal(existsSync(join(roots.home, ".claude", "skills", "alpha")), false);
    assert.equal(existsSync(join(skillsStoreRoot(roots.dataDir), "alpha")), false);
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
