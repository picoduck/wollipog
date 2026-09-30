import assert from "node:assert/strict";
import test from "node:test";
import { SKILL_MAX_FILES, type RunnerView, type SkillFile } from "@wollipog/protocol";
import {
  describeAgentSelector,
  describeAssignmentScope,
  filterSkillList,
  groupSkillList,
  invocationLabel,
  normalizeRemovalReporting,
  orphanedCopyKey,
  orphanedCopyRef,
  reportedOrphanedCopies,
  reportedSkillDrift,
  reportedSkillLinkRemovals,
  reportedUnmanagedSkills,
  skillAssignmentsFromPayload,
  skillAttention,
  skillDeployBadge,
  skillEligibleAgents,
  skillFileByteLength,
  skillFilesFromUploads,
  skillSourceKind,
  skillSourceLabel,
  skillVersionLabel,
  skillFromPayload,
  skillGroupsFromPayload,
  skillListDescription,
  skillMarkdownBody,
  skillMarkdownFrontmatterName,
  skillMarkdownTemplate,
  skillRecommended,
  skillsFromPayload,
  validateSkillDraft,
  type RunnerSkillsResponse,
  type SkillSummary,
} from "./skills.js";

const skill = (overrides: Partial<SkillSummary> = {}): SkillSummary => ({
  id: "skill-1",
  name: "code-review",
  ...overrides,
});

test("a built-in skill is recommended until it is assigned or the user dismisses it", () => {
  const builtIn = { release: "0.28.0", heldUpdate: null };
  assert.equal(skillRecommended(skill({ builtIn, recommendation: { dismissed: false }, assignmentCount: 0 })), true);
  assert.equal(skillRecommended(skill({ builtIn, recommendation: { dismissed: false } })), true);
  assert.equal(skillRecommended(skill({ builtIn, recommendation: { dismissed: false }, assignmentCount: 1 })), false);
  assert.equal(skillRecommended(skill({ builtIn, recommendation: { dismissed: true }, assignmentCount: 0 })), false);
  // An older control plane, or an agent credential, reports no per-user state.
  assert.equal(skillRecommended(skill({ builtIn, assignmentCount: 0 })), false);
  assert.equal(skillRecommended(skill({ builtInOffer: { release: "0.28.0", digest: "d" }, assignmentCount: 0 })), false);
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
  assert.equal(normalizeRemovalReporting("supported"), "supported");
  assert.equal(normalizeRemovalReporting("unsupported"), "unsupported");
  assert.equal(normalizeRemovalReporting("future-value"), "unknown");
  assert.equal(normalizeRemovalReporting(undefined), "unknown");

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

test("a version is named by its number, or by its short digest against a control plane without numbers", () => {
  assert.deepEqual(skillVersionLabel({ id: "skillv_a", digest: "0123456789abcdef", versionNumber: 3 }), { text: "v3", mono: false });
  assert.deepEqual(skillVersionLabel({ id: "skillv_a", digest: "0123456789abcdef" }), { text: "0123456789ab", mono: true });
  // A malformed number is not trusted over the digest; an id alone names nothing.
  assert.deepEqual(skillVersionLabel({ digest: "0123456789abcdef", versionNumber: 0 }), { text: "0123456789ab", mono: true });
  assert.deepEqual(skillVersionLabel({ digest: "0123456789abcdef", versionNumber: 1.5 }), { text: "0123456789ab", mono: true });
  assert.equal(skillVersionLabel({ id: "skillv_a" }), null);
  assert.equal(skillVersionLabel(null), null);
});

test("a skill's source is Built-In, Git, Machine or Library, in that precedence", () => {
  const git = { url: "https://example.com/r.git", ref: "main", subdirectory: "", path: "", commit: "c" };
  const machine = { runnerId: "r", sourceDirectory: ".agents/skills", name: "s", digest: "d", importedAt: 1 };
  const base = { id: "s", name: "s" };
  assert.equal(skillSourceKind(base), "library");
  assert.equal(skillSourceKind({ ...base, latestVersion: { machineSource: machine } }), "machine");
  assert.equal(skillSourceKind({ ...base, gitSource: git, latestVersion: { machineSource: machine } }), "git");
  assert.equal(skillSourceKind({ ...base, latestVersion: { gitSource: git } }), "git");
  assert.equal(skillSourceKind({ ...base, gitSource: git, builtIn: { release: "1", heldUpdate: null } }), "built_in");
  assert.deepEqual((["built_in", "git", "machine", "library"] as const).map(skillSourceLabel), ["Built-In", "Git", "Machine", "Library"]);
});

test("the skill list orders Recommended, then No Group, then the named groups in their sort order", () => {
  const groups = [
    { id: "g2", name: "Writing", sortOrder: 2 },
    { id: "g1", name: "Review", sortOrder: 1 },
    { id: "g3", name: "Empty", sortOrder: 0 },
  ];
  const recommended = { builtIn: { release: "0.29.0", heldUpdate: null }, recommendation: { dismissed: false }, assignmentCount: 0 };
  const skills = [
    skill({ id: "s1", name: "zeta", groupId: "g1" }),
    skill({ id: "s2", name: "alpha", groupId: "g1" }),
    skill({ id: "s3", name: "draft", groupId: "g2" }),
    skill({ id: "s4", name: "loose" }),
    skill({ id: "s5", name: "orphan", groupId: "gone" }),
    skill({ id: "s6", name: "using-wollipog", groupId: "g1", ...recommended }),
    skill({ id: "s7", name: "orchestrate-issues", ...recommended }),
  ];
  const grouped = groupSkillList(skills, groups);
  assert.deepEqual(grouped.map((entry) => entry.name), ["Recommended", "No Group", "Review", "Writing"]);
  assert.deepEqual(grouped.map((entry) => entry.key), ["recommended", "no-group", "group:g1", "group:g2"]);
  assert.deepEqual(grouped[0]!.skills.map((entry) => entry.name), ["orchestrate-issues", "using-wollipog"],
    "a recommended skill is listed once, in Recommended, whatever its group");
  assert.deepEqual(grouped[1]!.skills.map((entry) => entry.name), ["loose", "orphan"], "a missing group reads as No Group");
  assert.deepEqual(grouped[2]!.skills.map((entry) => entry.name), ["alpha", "zeta"]);

  // Assigning or dismissing it moves it to its own group on the next refresh.
  const assigned = skills.map((entry) => entry.id === "s6" ? { ...entry, assignmentCount: 1 } : entry);
  assert.deepEqual(groupSkillList(assigned, groups)[2]!.skills.map((entry) => entry.name), ["alpha", "using-wollipog", "zeta"]);
  const dismissed = skills.map((entry) => entry.id === "s7" ? { ...entry, recommendation: { dismissed: true } } : entry);
  assert.deepEqual(groupSkillList(dismissed, groups)[1]!.skills.map((entry) => entry.name), ["loose", "orchestrate-issues", "orphan"]);

  // Without any library group or recommendation, the list is one No Group group.
  assert.deepEqual(groupSkillList([skill()], []).map((entry) => entry.name), ["No Group"]);
  assert.deepEqual(groupSkillList([], groups), []);
});

test("Group By None is one flat alphabetical list without a label", () => {
  const grouped = groupSkillList([
    skill({ id: "s1", name: "zeta", groupId: "g1" }),
    skill({ id: "s2", name: "beta" }),
    skill({ id: "s3", name: "alpha", builtIn: { release: "1", heldUpdate: null }, recommendation: { dismissed: false } }),
  ], [{ id: "g1", name: "Review" }], "none");
  assert.deepEqual(grouped.map((entry) => entry.name), [null]);
  assert.deepEqual(grouped[0]!.skills.map((entry) => entry.name), ["alpha", "beta", "zeta"]);
  assert.deepEqual(groupSkillList([], [], "none"), []);
});

test("a row's description is one line, hidden when it repeats the name, and empty when missing", () => {
  assert.equal(skillListDescription(skill({ description: "Reviews code.\nThen\t writes  notes.\r\n" })), "Reviews code. Then writes notes.");
  assert.equal(skillListDescription(skill({ name: "qa", description: "QA" })), null);
  assert.equal(skillListDescription(skill({ name: "qa", description: " qa\n" })), null);
  assert.equal(skillListDescription(skill({ description: null })), "");
  assert.equal(skillListDescription(skill({ description: "  \n " })), "");
});

test("the filter matches the name and the full description, and Show narrows by kind", () => {
  const long = "Plans a campaign of child sessions. ".repeat(20) + "Finally it reconciles the\nmerge queue.";
  const gitSource = { url: "https://example.test/r.git", ref: "main", subdirectory: "", path: "", commit: "c" };
  const skills = [
    skill({ id: "s1", name: "orchestrate-issues", description: long, builtIn: { release: "1", heldUpdate: null }, assignmentCount: 0 }),
    skill({ id: "s2", name: "code-review", description: "Reviews code", assignmentCount: 2, gitSource }),
    skill({ id: "s3", name: "release-notes", assignmentCount: 1, latestVersion: { gitSource } }),
  ];
  const attention = (entry: SkillSummary) => entry.id === "s2" ? "edited" as const : null;
  const names = (query: string, show: Parameters<typeof filterSkillList>[1]["show"] = "all") =>
    filterSkillList(skills, { query, show, attention }).map((entry) => entry.name);
  assert.deepEqual(names(""), ["orchestrate-issues", "code-review", "release-notes"]);
  assert.deepEqual(names("RECONCILES"), ["orchestrate-issues"], "a word past the row's ellipsis still matches");
  assert.deepEqual(names("the merge"), ["orchestrate-issues"], "a line break in the description reads as a space");
  assert.deepEqual(names("  review "), ["code-review"]);
  assert.deepEqual(names("nothing like it"), []);
  assert.deepEqual(names("", "attention"), ["code-review"]);
  assert.deepEqual(names("", "git"), ["code-review", "release-notes"]);
  assert.deepEqual(names("", "built_in"), ["orchestrate-issues"]);
  assert.deepEqual(names("", "unassigned"), ["orchestrate-issues"]);
  assert.deepEqual(names("notes", "git"), ["release-notes"]);
});

test("a skill's attention is Error, then Edited, then Update Held, and Built-In or Recommended is none", () => {
  const agent = { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code" as const, available: true };
  const runner = { runnerId: "r1", os: "linux", status: "online", agents: [agent], protocolVersion: 200 } as unknown as RunnerView;
  const desired = [{ name: "code-review", versionDigest: "d1", targets: [{ agentId: "claude", invocation: "agent" as const }] }];
  const linked: RunnerSkillsResponse = { desired, reported: { deployed: [{ name: "code-review", digest: "d1", links: [{ agentId: "claude", status: "linked" }] }] } };
  const failed: RunnerSkillsResponse = { desired, reported: { deployed: [{ name: "code-review", digest: "d1", links: [{ agentId: "claude", status: "error", detail: "EACCES" }] }] } };
  const edited: RunnerSkillsResponse = { ...linked, reported: { ...linked.reported, drift: [{ name: "code-review", digest: "d1", variant: "agent", held: false }] } };
  const both: RunnerSkillsResponse = { ...failed, reported: { ...failed.reported, drift: edited.reported!.drift } };
  const healthy = skill({ builtIn: { release: "1", heldUpdate: null }, recommendation: { dismissed: false }, assignmentCount: 0 });
  const heldBuiltIn = skill({ builtIn: { release: "1", heldUpdate: { release: "2", digest: "d2" } } });

  assert.equal(skillAttention(healthy, [runner], { r1: linked }), null, "a healthy recommended built-in skill needs nothing");
  assert.equal(skillAttention(skill(), [runner], { r1: failed }), "error");
  assert.equal(skillAttention(skill(), [runner], { r1: edited }), "edited");
  assert.equal(skillAttention(skill(), [runner], { r1: both }), "error", "Error outranks Edited");
  const second = { ...runner, runnerId: "r2" } as RunnerView;
  assert.equal(skillAttention(skill(), [runner, second], { r1: edited, r2: failed }), "error", "on any machine");
  assert.equal(skillAttention(skill({ gitAutoUpdate: { enabled: true, held: { commit: "c", reason: "scripts", scriptPaths: [], heldAt: 1 } } }),
    [runner], { r1: linked }), "update_held");
  assert.equal(skillAttention(heldBuiltIn, [runner], {}), "update_held");
  assert.equal(skillAttention(heldBuiltIn, [runner], { r1: edited }), "edited", "Edited outranks Update Held");

  // A machine-wide sync error belongs to the skills that machine deploys, not to every skill.
  const syncFailed: RunnerSkillsResponse = { desired: [], reported: { error: "Disk full" } };
  assert.equal(skillAttention(skill(), [runner], { r1: syncFailed }), null);
  assert.equal(skillAttention(skill(), [runner], { r1: { ...syncFailed, desired } }), "error");
  // An agent that cannot receive managed skills reports nothing, and an unloaded machine says nothing.
  const acp = { ...runner, agents: [{ ...agent, driver: "acp" }] } as unknown as RunnerView;
  assert.equal(skillAttention(skill(), [acp], { r1: failed }), null);
  assert.equal(skillAttention(skill(), [runner], {}), null);
  assert.equal(skillAttention(skill(), [runner], { r1: { ...failed, loadError: "Request failed" } }), null);
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

test("deployable native agents are eligible and WSL agents require runner capability", () => {
  const base = { name: "x", command: "x", args: [], env: {} };
  const eligible = skillEligibleAgents([
    { ...base, id: "claude", driver: "claude-code" },
    { ...base, id: "codex", driver: "codex-app-server" },
    { ...base, id: "acp", driver: "acp" },
    { ...base, id: "wsl", driver: "codex", context: { kind: "wsl", distro: "ubuntu" } },
  ]);
  assert.deepEqual(eligible.map((agent) => agent.id), ["claude", "codex"]);
  const withWsl = skillEligibleAgents([
    { ...base, id: "wsl", driver: "codex", context: { kind: "wsl", distro: "ubuntu" } },
    { ...base, id: "wsl-acp", driver: "acp", context: { kind: "wsl", distro: "ubuntu" } },
  ], true);
  assert.deepEqual(withWsl.map((agent) => agent.id), ["wsl"]);
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

  const drift = [{ name: "code-review", digest: "a".repeat(64), variant: "agent" as const, held: true }];
  const driftBadge = skillDeployBadge({ runnerOnline: true, desired, reported: { ...conflicted, drift }, skillName: "code-review" });
  assert.equal(driftBadge.status, "drift", "an edited copy outranks the held links it causes");
  assert.equal(driftBadge.label, "Edited");
  assert.match(driftBadge.detail ?? "", /held until you import the edit or restore the library version/);
  assert.equal(skillDeployBadge({ runnerOnline: true, desired: undefined, skillName: "code-review",
    reported: { drift: [{ ...drift[0]!, held: false }] } }).status, "drift", "a retained edit is shown without an assignment");
  assert.equal(skillDeployBadge({ runnerOnline: false, desired, reported: { drift }, skillName: "code-review" }).status, "offline");
  assert.equal(skillDeployBadge({ runnerOnline: true, desired, reported: { ...linked, drift }, skillName: "other" }).status, "pending");
  assert.deepEqual(reportedSkillDrift({ drift: [...drift, { name: "code-review", variant: "bogus" } as never] }, "code-review"), drift);

  const accountConflict = skillDeployBadge({
    runnerOnline: true,
    desired,
    skillName: "code-review",
    providerAccounts: [{ id: "work", label: "Work" }, { id: "personal", label: "Personal" }],
    reported: { deployed: [
      { name: "code-review", digest: "d1", providerAccountId: "work",
        links: [{ agentId: "claude", status: "linked" }] },
      { name: "code-review", digest: "d1", providerAccountId: "personal",
        links: [{ agentId: "claude", status: "conflict", detail: "A real directory is in the way." }] },
    ] },
  });
  assert.equal(accountConflict.status, "conflict");
  assert.equal(accountConflict.detail, "Personal: A real directory is in the way.");

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
  // The chip speaks the shared skill-deployment vocabulary (docs/design-system.md §11.2).
  assert.equal(done.label, "Linked");
  assert.equal(done.tone, "success");

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

test("account-scoped deploy badges require every applicable sibling account link", () => {
  const desired = { versionDigest: "d1", targets: [{ agentId: "claude", invocation: "agent" as const }] };
  const agents = [{ id: "claude", driver: "claude-code" as const }];
  const providerAccounts = [
    { id: "work", label: "Work", provider: "claude" as const },
    { id: "personal", label: "Personal", provider: "claude" as const },
  ];
  const deployed = [
    { name: "code-review", digest: "d1", providerAccountId: "work",
      links: [{ agentId: "claude", status: "linked" as const }] },
    { name: "code-review", digest: "d1", providerAccountId: "personal", links: [] },
  ];

  const pending = skillDeployBadge({
    runnerOnline: true, desired, agents, providerAccounts,
    reported: { deployed }, skillName: "code-review",
  });
  assert.equal(pending.status, "pending");
  assert.equal(pending.detail, "Personal: Awaiting link for claude.");

  deployed[1]!.links = [{ agentId: "claude", status: "linked" }];
  assert.equal(skillDeployBadge({
    runnerOnline: true, desired, agents, providerAccounts,
    reported: { deployed }, skillName: "code-review",
  }).status, "deployed");
});

test("account-scoped deploy badges ignore other providers and use unscoped WSL links", () => {
  const providerAccounts = [
    { id: "claude-work", label: "Claude Work", provider: "claude" as const },
    { id: "codex-work", label: "Codex Work", provider: "codex" as const },
  ];
  const mixedProvider = skillDeployBadge({
    runnerOnline: true,
    desired: { versionDigest: "d1", targets: [{ agentId: "claude", invocation: "agent" }] },
    agents: [{ id: "claude", driver: "claude-code" }, { id: "codex", driver: "codex-app-server" }],
    providerAccounts,
    reported: { deployed: [{
      name: "code-review", digest: "d1", providerAccountId: "claude-work",
      links: [{ agentId: "claude", status: "linked" }],
    }] },
    skillName: "code-review",
  });
  assert.equal(mixedProvider.status, "deployed");

  const wsl = skillDeployBadge({
    runnerOnline: true,
    desired: { versionDigest: "d1", targets: [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }] },
    agents: [{ id: "codex-wsl-Ubuntu", driver: "codex", context: { kind: "wsl", distro: "Ubuntu" } }],
    providerAccounts,
    reported: { deployed: [
      { name: "code-review", digest: "d1",
        links: [{ agentId: "codex-wsl-Ubuntu", status: "linked" }] },
      { name: "code-review", digest: "d1", providerAccountId: "codex-work",
        links: [{ agentId: "codex", status: "linked" }] },
    ] },
    skillName: "code-review",
  });
  assert.equal(wsl.status, "deployed");
});

test("legacy unscoped deploy badges retain flattened link behavior", () => {
  const badge = skillDeployBadge({
    runnerOnline: true,
    desired: { versionDigest: "d1", targets: [{ agentId: "claude", invocation: "agent" }] },
    reported: { deployed: [{
      name: "code-review", digest: "d1", links: [{ agentId: "claude", status: "linked" }],
    }] },
    skillName: "code-review",
  });
  assert.equal(badge.status, "deployed");
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

test("orphaned copies are read defensively and addressed without paths", () => {
  const response = {
    desired: [], reported: null,
    orphaned: [
      { kind: "kept_aside", id: "0f0e0d0c-0b0a-4908-8706-050403020100", name: "notes" },
      { kind: "deleted_skill", name: "retired", digest: "d".repeat(64), variant: "manual" },
      { kind: "deleted_skill", name: "broken", digest: "d".repeat(64), variant: "other" },
      { kind: "unknown" },
      null,
    ],
  } as unknown as RunnerSkillsResponse;
  const copies = reportedOrphanedCopies(response);
  assert.deepEqual(copies.map((copy) => orphanedCopyRef(copy)), [
    { kind: "kept_aside", id: "0f0e0d0c-0b0a-4908-8706-050403020100" },
    { kind: "deleted_skill", name: "retired", digest: "d".repeat(64), variant: "manual" },
  ]);
  assert.deepEqual(copies.map(orphanedCopyKey), [
    "kept:0f0e0d0c-0b0a-4908-8706-050403020100", `deleted:retired:manual:${"d".repeat(64)}`,
  ]);
  assert.deepEqual(reportedOrphanedCopies(undefined), []);
});
