import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SKILL_MAX_FILES,
  type AgentDefinition,
  type ResourceScope,
  type RunnerMetadata,
  type SkillFile,
} from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { ControlPlaneDb, type SkillAgentSelector } from "./db.js";
import {
  parseSkillAgentSelector,
  readSkillFrontmatter,
  resolveDesiredSkills,
  validateSkillPayload,
} from "./skills.js";

function skillMd(name: string, description = "Does helpful things."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nInstructions.\n`;
}

function files(name: string, extra: SkillFile[] = []): SkillFile[] {
  return [{ path: "SKILL.md", content: skillMd(name), encoding: "utf8" }, ...extra];
}

/* ------------------------------ Frontmatter ------------------------------ */

test("readSkillFrontmatter reads only name and description from a closed block", () => {
  const value = readSkillFrontmatter('---\nname: my-skill\ndescription: "Quoted value"\nauthor: x\n---\nBody');
  assert.deepEqual(value, { name: "my-skill", description: "Quoted value" });
  assert.deepEqual(readSkillFrontmatter("no frontmatter here"), {});
  // An unterminated block is body text, never partially trusted metadata.
  assert.deepEqual(readSkillFrontmatter("---\nname: dangling"), {});
});

test("readSkillFrontmatter bounds values and tolerates a BOM", () => {
  const long = readSkillFrontmatter(`﻿---\ndescription: ${"x".repeat(600)}\n---\n`);
  assert.equal(long.description?.length, 280);
});

/* ------------------------------- Validation ------------------------------ */

test("validateSkillPayload normalizes a valid payload into a manifest and digest", () => {
  const payload = files("my-skill", [{ path: "ref/data.txt", content: "aGVsbG8=", encoding: "base64" }]);
  const result = validateSkillPayload({ name: "my-skill", files: payload });
  assert.ok(result.ok);
  assert.equal(result.name, "my-skill");
  assert.equal(result.description, "Does helpful things.", "frontmatter description backfills a missing explicit one");
  assert.equal(result.digest, skillVersionDigest(payload));
  const manifest = JSON.parse(result.manifest) as { files: Array<{ path: string; sha256: string; size: number }> };
  assert.deepEqual(manifest.files.map((file) => file.path), ["SKILL.md", "ref/data.txt"]);
  assert.equal(manifest.files[1]!.size, 5, "base64 sizes are decoded byte lengths");

  const explicit = validateSkillPayload({ name: "my-skill", description: "Custom", files: payload });
  assert.ok(explicit.ok);
  assert.equal(explicit.description, "Custom");
});

test("validateSkillPayload rejects bad names, paths, structure, and limits", () => {
  const ok = files("my-skill");
  for (const name of ["My-Skill", ".hidden", "..", "a/b", ""]) {
    const result = validateSkillPayload({ name, files: ok });
    assert.equal(result.ok, false, `name ${JSON.stringify(name)} must be rejected`);
  }
  assert.equal(validateSkillPayload({ name: "my-skill", files: [] }).ok, false);
  assert.equal(validateSkillPayload({ name: "my-skill", files: "nope" }).ok, false);
  for (const path of ["../escape.md", "/abs.md", "a\\b.md", "a/../b.md", "a/./b.md", "a/b/c/d/e/f/g/h/i.md"]) {
    const result = validateSkillPayload({
      name: "my-skill",
      files: [...ok, { path, content: "x", encoding: "utf8" }],
    });
    assert.equal(result.ok, false, `path ${JSON.stringify(path)} must be rejected`);
  }
  const duplicate = validateSkillPayload({
    name: "my-skill",
    files: [...ok, { path: "SKILL.md", content: "x", encoding: "utf8" }],
  });
  assert.equal(duplicate.ok, false);
  const badBase64 = validateSkillPayload({
    name: "my-skill",
    files: [...ok, { path: "bin", content: "!!!not-base64", encoding: "base64" }],
  });
  assert.equal(badBase64.ok, false);
  const tooMany = validateSkillPayload({
    name: "my-skill",
    files: [
      ...ok,
      ...Array.from({ length: SKILL_MAX_FILES }, (_, index) => ({
        path: `f${index}.txt`, content: "x", encoding: "utf8" as const,
      })),
    ],
  });
  assert.equal(tooMany.ok, false);
});

test("validateSkillPayload requires a top-level SKILL.md whose frontmatter name matches", () => {
  const missing = validateSkillPayload({
    name: "my-skill",
    files: [{ path: "docs/SKILL.md", content: skillMd("my-skill"), encoding: "utf8" }],
  });
  assert.equal(missing.ok, false);
  const mismatch = validateSkillPayload({
    name: "my-skill",
    files: [{ path: "SKILL.md", content: skillMd("other-skill"), encoding: "utf8" }],
  });
  assert.equal(mismatch.ok, false);
  const nameless = validateSkillPayload({
    name: "my-skill",
    files: [{ path: "SKILL.md", content: "# my-skill\n", encoding: "utf8" }],
  });
  assert.equal(nameless.ok, false);
});

test("parseSkillAgentSelector accepts exactly the three selector shapes", () => {
  assert.deepEqual(parseSkillAgentSelector({ kind: "all" }), { kind: "all" });
  assert.deepEqual(parseSkillAgentSelector({ kind: "driver", driver: "codex" }), { kind: "driver", driver: "codex" });
  assert.deepEqual(parseSkillAgentSelector({ kind: "agent", agentId: "claude" }), { kind: "agent", agentId: "claude" });
  for (const bad of [null, "all", { kind: "driver", driver: "vim" }, { kind: "agent" }, { kind: "all", extra: 1 }]) {
    assert.equal(parseSkillAgentSelector(bad), null);
  }
});

/* --------------------------- Desired-state resolution --------------------------- */

const AGENTS: AgentDefinition[] = [
  { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" },
  { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" },
  { id: "codex-app", name: "Codex App", command: "codex", args: [], env: {}, driver: "codex-app-server" },
  {
    id: "wsl-claude", name: "WSL Claude", command: "claude", args: [], env: {},
    driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu" },
  },
  { id: "gemini", name: "Gemini", command: "gemini", args: [], env: {}, driver: "acp" },
];

function runnerMeta(runnerId: string, agents: AgentDefinition[] = AGENTS): RunnerMetadata {
  return { runnerId, hostname: `${runnerId}-host`, os: "linux", version: "1.0.0", agents, workspaces: [] };
}

function createSkill(db: ControlPlaneDb, name: string, scope?: ResourceScope) {
  const validated = validateSkillPayload({ name, files: files(name) });
  assert.ok(validated.ok);
  return db.createSkill({
    name: validated.name,
    description: validated.description,
    files: validated.files,
    manifest: validated.manifest,
    digest: validated.digest,
    ...(scope ? { scope } : {}),
    now: 100,
  });
}

function assign(
  db: ControlPlaneDb,
  skillId: string,
  scope: { kind: "instance" } | { kind: "runner"; runnerId: string },
  selector: SkillAgentSelector,
  options: { enabled?: boolean; invocation?: "agent" | "manual"; now?: number } = {},
) {
  return db.createSkillAssignment({
    skillId,
    scopeKind: scope.kind,
    runnerId: scope.kind === "runner" ? scope.runnerId : null,
    agentSelector: selector,
    enabled: options.enabled,
    invocation: options.invocation,
    now: options.now ?? 200,
  });
}

test("resolveDesiredSkills targets only native claude-code and codex agents", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta("runner-1"), 10, 90);
  const skill = createSkill(db, "alpha-skill");
  assign(db, skill.id, { kind: "instance" }, { kind: "all" });
  const entries = resolveDesiredSkills(db, "runner-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.name, "alpha-skill");
  assert.equal(entries[0]!.versionDigest, skill.latestVersion!.digest);
  assert.equal(entries[0]!.files.some((file) => file.path === "SKILL.md"), true);
  assert.deepEqual(
    entries[0]!.targets.map((target) => target.agentId).sort(),
    ["claude", "codex", "codex-app"],
    "the WSL-context agent and the acp-driver agent never become targets",
  );
  assert.deepEqual(resolveDesiredSkills(db, "missing-runner"), []);
});

test("resolveDesiredSkills lets agent beat driver beat all within a scope", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta("runner-1"), 10, 90);
  const skill = createSkill(db, "beta-skill");
  assign(db, skill.id, { kind: "instance" }, { kind: "all" }, { invocation: "agent" });
  assign(db, skill.id, { kind: "instance" }, { kind: "driver", driver: "codex" }, { invocation: "manual" });
  assign(db, skill.id, { kind: "instance" }, { kind: "agent", agentId: "codex" }, { invocation: "agent" });
  const [entry] = resolveDesiredSkills(db, "runner-1");
  const byAgent = new Map(entry!.targets.map((target) => [target.agentId, target.invocation]));
  assert.equal(byAgent.get("claude"), "agent", "all applies where nothing more specific matches");
  assert.equal(byAgent.get("codex"), "agent", "the agent selector beats the driver selector");
  assert.equal(byAgent.get("codex-app"), "agent", "driver selectors match the exact driver kind only");
});

test("resolveDesiredSkills lets runner scope beat instance scope and disabled overrides remove agents", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta("runner-1"), 10, 90);
  db.registerRunner(runnerMeta("runner-2"), 10, 90);
  const skill = createSkill(db, "gamma-skill");
  assign(db, skill.id, { kind: "instance" }, { kind: "all" });
  assign(db, skill.id, { kind: "runner", runnerId: "runner-1" }, { kind: "agent", agentId: "codex" }, { enabled: false });
  assign(db, skill.id, { kind: "runner", runnerId: "runner-1" }, { kind: "driver", driver: "claude-code" }, { invocation: "manual" });

  const [entry] = resolveDesiredSkills(db, "runner-1");
  const byAgent = new Map(entry!.targets.map((target) => [target.agentId, target.invocation]));
  assert.equal(byAgent.has("codex"), false, "a disabled runner-scoped override removes exactly the agents it matches");
  assert.equal(byAgent.get("claude"), "manual", "a runner-scoped driver row overrides the instance-wide row");
  assert.equal(byAgent.get("codex-app"), "agent");

  // The other machine never sees runner-1's overrides.
  const [other] = resolveDesiredSkills(db, "runner-2");
  assert.deepEqual(other!.targets.map((target) => target.agentId).sort(), ["claude", "codex", "codex-app"]);
});

test("resolveDesiredSkills keeps an all-scoped skill desired with zero targets but drops unmatched selectors", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta("runner-1"), 10, 90);
  const kept = createSkill(db, "kept-skill");
  assign(db, kept.id, { kind: "instance" }, { kind: "all" });
  for (const agentId of ["claude", "codex", "codex-app"]) {
    assign(db, kept.id, { kind: "runner", runnerId: "runner-1" }, { kind: "agent", agentId }, { enabled: false });
  }
  const dropped = createSkill(db, "dropped-skill");
  assign(db, dropped.id, { kind: "instance" }, { kind: "agent", agentId: "not-on-this-machine" });
  const disabledOnly = createSkill(db, "disabled-skill");
  assign(db, disabledOnly.id, { kind: "instance" }, { kind: "all" }, { enabled: false });

  const entries = resolveDesiredSkills(db, "runner-1");
  assert.deepEqual(entries.map((entry) => entry.name), ["kept-skill"]);
  assert.deepEqual(entries[0]!.targets, [], "the machine-level canonical link survives per-agent removal");
});

// REGRESSION (P1): an instance-wide assignment used to fan the skill out to EVERY runner,
// including runners owned by other organizations. Desired-state resolution must apply the same
// ownership-audience containment projects use for project↔runner attachment.
test("resolveDesiredSkills never fans an instance assignment out across organizations", () => {
  const db = ControlPlaneDb.open(":memory:");
  const orgBScope: ResourceScope = {
    organizationId: "org_b",
    owner: { kind: "organization", organizationId: "org_b" },
  };
  db.registerRunner(runnerMeta("runner-org-a"), 10, 90); // defaults to the personal organization
  db.registerRunner(runnerMeta("runner-org-b"), 10, 90, orgBScope);

  const foreign = createSkill(db, "org-b-skill", orgBScope);
  assign(db, foreign.id, { kind: "instance" }, { kind: "all" });

  assert.deepEqual(resolveDesiredSkills(db, "runner-org-a"), [],
    "an org-B skill with an instance assignment must not reach org A's runner");
  assert.deepEqual(resolveDesiredSkills(db, "runner-org-b").map((entry) => entry.name), ["org-b-skill"],
    "the owning organization's own runner still receives the skill");
});

// Same containment inside one organization: a user-scoped skill deploys to an org-wide runner
// (everyone who can see the skill can see the machine) but an org-scoped skill must not deploy to
// a private user-scoped runner belonging to someone with no claim on it — the audience rule, not a
// symmetric equality check.
test("resolveDesiredSkills applies audience containment, not scope equality, within an organization", () => {
  const db = ControlPlaneDb.open(":memory:");
  const orgScope: ResourceScope = {
    organizationId: "org_c",
    owner: { kind: "organization", organizationId: "org_c" },
  };
  const userScope: ResourceScope = { organizationId: "org_c", owner: { kind: "user", userId: "usr_private" } };
  db.registerRunner(runnerMeta("runner-org-wide"), 10, 90, orgScope);
  db.registerRunner(runnerMeta("runner-private"), 10, 90, userScope);

  const userSkill = createSkill(db, "user-skill", userScope);
  assign(db, userSkill.id, { kind: "instance" }, { kind: "all" });

  assert.deepEqual(resolveDesiredSkills(db, "runner-org-wide").map((entry) => entry.name), ["user-skill"],
    "a user-scoped skill is contained within an org-wide runner audience");
  assert.deepEqual(resolveDesiredSkills(db, "runner-private").map((entry) => entry.name), ["user-skill"],
    "the exact same user audience is contained in the matching private runner");

  const orgSkill = createSkill(db, "org-skill", orgScope);
  assign(db, orgSkill.id, { kind: "instance" }, { kind: "all" });
  assert.deepEqual(resolveDesiredSkills(db, "runner-private").map((entry) => entry.name), ["user-skill"],
    "an org-audience skill is NOT contained within a single user's private runner audience");
});

test("resolveDesiredSkills always ships the latest version", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta("runner-1"), 10, 90);
  const skill = createSkill(db, "delta-skill");
  assign(db, skill.id, { kind: "instance" }, { kind: "all" });
  const updated: SkillFile[] = [
    { path: "SKILL.md", content: skillMd("delta-skill", "Updated."), encoding: "utf8" },
  ];
  const validated = validateSkillPayload({ name: "delta-skill", files: updated });
  assert.ok(validated.ok);
  const version = db.addSkillVersion(skill.id, {
    files: validated.files, manifest: validated.manifest, digest: validated.digest,
  }, 300);
  const [entry] = resolveDesiredSkills(db, "runner-1");
  assert.equal(entry!.versionDigest, version!.digest);
  assert.notEqual(entry!.versionDigest, skill.latestVersion!.digest);
});

test("resolveDesiredSkills never targets the synthesized conductor", () => {
  const db = ControlPlaneDb.open(":memory:");
  // The conductor shares its donor Claude's harness directory, so a target row for it would
  // double-deploy into the same directory and make mixed policies read as conflicts.
  db.registerRunner(runnerMeta("runner-1", [
    ...AGENTS,
    { id: "conductor", name: "Conductor (Wollipog)", command: "claude", args: [], env: {}, driver: "claude-code" },
  ]), 10, 91);
  const skill = createSkill(db, "gamma-skill");
  assign(db, skill.id, { kind: "instance" }, { kind: "all" });
  assign(db, skill.id, { kind: "instance" }, { kind: "agent", agentId: "conductor" });
  const [entry] = resolveDesiredSkills(db, "runner-1");
  assert.equal(entry!.targets.some((target) => target.agentId === "conductor"), false);
});
