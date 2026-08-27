import assert from "node:assert/strict";
import test from "node:test";
import { SKILL_MAX_FILES, type SkillFile } from "@wollipog/protocol";
import {
  describeAgentSelector,
  describeAssignmentScope,
  groupSkillList,
  invocationLabel,
  reportedSkillLinkRemovals,
  reportedUnmanagedSkills,
  skillAssignmentsFromPayload,
  skillDeployBadge,
  skillEligibleAgents,
  skillFileByteLength,
  skillFilesFromUploads,
  skillFromPayload,
  skillGroupsFromPayload,
  skillMarkdownBody,
  skillMarkdownFrontmatterName,
  skillMarkdownTemplate,
  skillsFromPayload,
  validateSkillDraft,
  type SkillSummary,
} from "./skills.js";

const skill = (overrides: Partial<SkillSummary> = {}): SkillSummary => ({
  id: "skill-1",
  name: "code-review",
  ...overrides,
});

test("payload normalizers accept wrapped and bare shapes and drop malformed rows", () => {
  const rows = [skill(), { id: "", name: "broken" } as SkillSummary];
  assert.deepEqual(skillsFromPayload(rows), [skill()]);
  assert.deepEqual(skillsFromPayload({ skills: rows }), [skill()]);
  assert.deepEqual(skillsFromPayload({ unexpected: true }), []);
  assert.deepEqual(skillsFromPayload(undefined), []);

  assert.deepEqual(skillGroupsFromPayload({ groups: [{ id: "g1", name: "Review" }] }), [{ id: "g1", name: "Review" }]);

  const assignment = {
    id: "a1", skillId: "skill-1", scopeKind: "instance" as const,
    agentSelector: { kind: "all" as const }, enabled: undefined as unknown as boolean, invocation: "agent" as const,
  };
  const normalized = skillAssignmentsFromPayload({ assignments: [assignment] });
  assert.equal(normalized[0]!.enabled, true, "absent enabled defaults on");

  assert.deepEqual(skillFromPayload({ skill: skill() }), skill());
  assert.deepEqual(skillFromPayload(skill()), skill());
  assert.equal(skillFromPayload({ error: "nope" }), null);

  // The detail route keeps the full version (with files) as a sibling while the skill record
  // carries only a summary version without files — the sibling must win or the view never sees
  // the files.
  const siblingVersion = {
    id: "v1", digest: "d1", createdAt: 1,
    files: [{ path: "SKILL.md", content: "---\nname: s\n---\nBody", encoding: "utf8" as const }],
  };
  const summarySkill = { ...skill(), latestVersion: { id: "v1", digest: "d1", createdAt: 1 } };
  const merged = skillFromPayload({ skill: summarySkill, latestVersion: siblingVersion, assignments: [] });
  assert.deepEqual(merged?.latestVersion, siblingVersion, "sibling full version replaces the summary");
});

test("the skill list groups by group order and collects ungrouped skills last", () => {
  const groups = [
    { id: "g2", name: "Writing", sortOrder: 2 },
    { id: "g1", name: "Review", sortOrder: 1 },
    { id: "g3", name: "Empty", sortOrder: 0 },
  ];
  const skills = [
    skill({ id: "s1", name: "zeta", groupId: "g1" }),
    skill({ id: "s2", name: "alpha", groupId: "g1" }),
    skill({ id: "s3", name: "draft", groupId: "g2" }),
    skill({ id: "s4", name: "loose" }),
    skill({ id: "s5", name: "orphan", groupId: "gone" }),
  ];
  const grouped = groupSkillList(skills, groups);
  assert.deepEqual(grouped.map((entry) => entry.name), ["Review", "Writing", "Ungrouped"]);
  assert.deepEqual(grouped[0]!.skills.map((entry) => entry.name), ["alpha", "zeta"]);
  assert.deepEqual(grouped[2]!.skills.map((entry) => entry.name), ["loose", "orphan"]);
  assert.deepEqual(groupSkillList([skill()], []).map((entry) => entry.name), ["All Skills"]);
});

test("assignment presentation names machines, drivers, agents, and invocation policies", () => {
  assert.equal(describeAssignmentScope({ scopeKind: "instance" }, () => "Build"), "All Machines");
  assert.equal(describeAssignmentScope({ scopeKind: "runner", runnerId: "r1" }, () => "Build Machine"), "Build Machine");
  assert.equal(describeAssignmentScope({ scopeKind: "runner", runnerId: "r1" }, () => undefined), "r1");
  assert.equal(describeAgentSelector({ kind: "all" }), "All Agents");
  assert.equal(describeAgentSelector({ kind: "driver", driver: "claude-code" }), "Claude Code Native");
  assert.equal(describeAgentSelector({ kind: "agent", agentId: "claude" }, [{ id: "claude", name: "Claude" }]), "Claude");
  assert.equal(describeAgentSelector({ kind: "agent", agentId: "gone" }, []), "gone");
  assert.equal(invocationLabel("agent"), "Agent Invocable");
  assert.equal(invocationLabel("manual"), "Manual Only");
});

test("only native claude-code and codex agents are eligible deployment targets", () => {
  const base = { name: "x", command: "x", args: [], env: {} };
  const eligible = skillEligibleAgents([
    { ...base, id: "claude", driver: "claude-code" },
    { ...base, id: "codex", driver: "codex-app-server" },
    { ...base, id: "acp", driver: "acp" },
    { ...base, id: "wsl", driver: "codex", context: { kind: "wsl", distro: "ubuntu" } },
  ]);
  assert.deepEqual(eligible.map((agent) => agent.id), ["claude", "codex"]);
});

test("deploy badges rank offline, conflict, error, digest and link gaps, then deployed", () => {
  const desired = { versionDigest: "d1", targets: [{ agentId: "claude", invocation: "agent" as const }] };
  const linked = { deployed: [{ name: "code-review", digest: "d1", links: [{ agentId: "claude", status: "linked" as const }] }] };

  assert.equal(skillDeployBadge({ runnerOnline: false, desired, reported: linked, skillName: "code-review" }).status, "offline");
  assert.equal(skillDeployBadge({ runnerOnline: true, desired: undefined, reported: linked, skillName: "code-review" }).status, "pending");
  assert.equal(skillDeployBadge({ runnerOnline: true, desired, reported: null, skillName: "code-review" }).status, "pending");
  assert.equal(skillDeployBadge({ runnerOnline: true, desired, reported: { error: "boom" }, skillName: "code-review" }).status, "error");

  const conflicted = { deployed: [{ name: "code-review", digest: "d1", links: [
    { agentId: "claude", status: "conflict" as const, detail: "A real directory is in the way." },
    { agentId: "codex", status: "error" as const },
  ] }] };
  const conflictBadge = skillDeployBadge({ runnerOnline: true, desired, reported: conflicted, skillName: "code-review" });
  assert.equal(conflictBadge.status, "conflict");
  assert.equal(conflictBadge.detail, "A real directory is in the way.");

  const unsupported = { deployed: [{ name: "code-review", digest: "d1", links: [
    { agentId: "claude", status: "unsupported" as const, detail: "Windows deployment is not yet supported" },
  ] }] };
  assert.equal(skillDeployBadge({ runnerOnline: true, desired, reported: unsupported, skillName: "code-review" }).status, "error");

  const stale = { deployed: [{ name: "code-review", digest: "d0", links: [{ agentId: "claude", status: "linked" as const }] }] };
  assert.equal(skillDeployBadge({ runnerOnline: true, desired, reported: stale, skillName: "code-review" }).status, "pending");

  const partial = { deployed: [{ name: "code-review", digest: "d1", links: [] }] };
  assert.equal(skillDeployBadge({ runnerOnline: true, desired, reported: partial, skillName: "code-review" }).status, "pending");

  const done = skillDeployBadge({ runnerOnline: true, desired, reported: linked, skillName: "code-review" });
  assert.equal(done.status, "deployed");
  assert.equal(done.label, "Deployed");
  assert.equal(done.className, "st-done");

  assert.deepEqual(reportedUnmanagedSkills({ unmanaged: [{ agentId: "claude", name: "local-notes" }] }),
    [{ agentId: "claude", name: "local-notes" }]);
  assert.deepEqual(reportedUnmanagedSkills(null), []);
  assert.deepEqual(reportedSkillLinkRemovals({ removals: [{
    path: "~/.claude/skills/retired",
    reason: "No longer in the desired skill list.",
  }] }), [{
    path: "~/.claude/skills/retired",
    reason: "No longer in the desired skill list.",
  }]);
  assert.deepEqual(reportedSkillLinkRemovals(null), []);
  assert.deepEqual(reportedSkillLinkRemovals({ removals: [
    { path: {} as never, reason: "bad" },
    { path: "~/.codex/skills/good", reason: "Good." },
  ] }), [{ path: "~/.codex/skills/good", reason: "Good." }]);
});

test("folder uploads strip the picked root, sort by path, and split text from binary", () => {
  const text = new TextEncoder().encode("---\nname: code-review\n---\nBody\n");
  const binary = new Uint8Array([0, 159, 146, 150]);
  const { files, errors } = skillFilesFromUploads([
    { relativePath: "code-review/scripts/logo.bin", bytes: binary },
    { relativePath: "code-review/SKILL.md", bytes: text },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(files.map((file) => file.path), ["SKILL.md", "scripts/logo.bin"]);
  assert.equal(files[0]!.encoding, "utf8");
  assert.equal(files[1]!.encoding, "base64");
  assert.deepEqual([...Uint8Array.from(atob(files[1]!.content), (char) => char.charCodeAt(0))], [...binary]);

  const traversal = skillFilesFromUploads([{ relativePath: "root/../escape.md", bytes: text }]);
  assert.equal(traversal.files.length, 0);
  assert.equal(traversal.errors.length, 1);
});

test("draft validation mirrors the protocol validators and limits", () => {
  const md = (name: string): SkillFile => ({ path: "SKILL.md", content: `---\nname: ${name}\n---\nBody\n`, encoding: "utf8" });
  assert.deepEqual(validateSkillDraft({ name: "code-review", files: [md("code-review")] }), []);

  assert.ok(validateSkillDraft({ name: "Bad Name", files: [md("Bad Name")] }).length > 0);
  assert.ok(validateSkillDraft({ name: "code-review", files: [] })[0]!.includes("SKILL.md"));
  assert.ok(validateSkillDraft({ name: "code-review", files: [{ path: "notes.md", content: "x", encoding: "utf8" }] })
    .some((error) => error.includes("SKILL.md must exist")));
  assert.ok(validateSkillDraft({ name: "code-review", files: [md("other-name")] })
    .some((error) => error.includes("must match the skill name")));
  assert.ok(validateSkillDraft({ name: "code-review", files: [md("code-review"), md("code-review")] })
    .some((error) => error.includes("more than once")));

  const many = Array.from({ length: SKILL_MAX_FILES + 1 }, (_, index): SkillFile => (
    { path: `extra-${index}.md`, content: "x", encoding: "utf8" }
  ));
  assert.ok(validateSkillDraft({ name: "code-review", files: [md("code-review"), ...many] })
    .some((error) => error.includes(`${SKILL_MAX_FILES} files`)));

  assert.equal(skillFileByteLength({ path: "a", content: "héllo", encoding: "utf8" }), 6);
  assert.equal(skillFileByteLength({ path: "a", content: btoa("1234"), encoding: "base64" }), 4);
});

test("SKILL.md helpers read and strip frontmatter the same line-based way", () => {
  const markdown = "---\nname: code-review\ndescription: Reviews code\n---\n\n# Usage\n";
  assert.equal(skillMarkdownFrontmatterName(markdown), "code-review");
  assert.equal(skillMarkdownFrontmatterName("# no frontmatter"), null);
  assert.equal(skillMarkdownBody(markdown), "# Usage\n");
  assert.equal(skillMarkdownBody("plain body"), "plain body");
  assert.equal(skillMarkdownFrontmatterName(skillMarkdownTemplate("my-skill", "Does things")), "my-skill");
});
