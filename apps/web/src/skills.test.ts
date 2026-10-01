import assert from "node:assert/strict";
import test from "node:test";
import { SKILL_MAX_FILES, skillMarkdownFromFields, type RunnerView, type SkillFile } from "@wollipog/protocol";
import {
  describeAgentSelector,
  describeAssignmentScope,
  filterSkillList,
  findSkillVersions,
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
  skillDeployingMachineCount,
  skillEligibleAgents,
  skillFileByteLength,
  skillFilesFromUploads,
  skillSourceKind,
  skillSourceLabel,
  skillVersionLabel,
  skillFromPayload,
  skillGroupsFromPayload,
  skillLibrarySummary,
  skillListDescription,
  skillMarkdownBody,
  skillMarkdownFrontmatterName,
  skillNameError,
  skillOfflineMachineSentence,
  skillOverviewAttention,
  skillRecentChanges,
  skillRecommended,
  skillsFromPayload,
  skillUncheckedMachineSentence,
  skillVersionChangeDetail,
  validateSkillDraft,
  validateSkillFiles,
  agentTypeLabel,
  agentsReachedBySelector,
  supportsManualOnly,
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

test("a review finds the versions it names a page at a time, and stops once it has them (#1973)", async () => {
  const pages: Record<string, { versions: Array<{ id: string; digest: string; versionNumber: number }>; nextCursor: string | null }> = {
    first: { versions: [{ id: "v5", digest: "e", versionNumber: 5 }, { id: "v4", digest: "a", versionNumber: 4 }], nextCursor: "v4" },
    v4: { versions: [{ id: "v3", digest: "c", versionNumber: 3 }, { id: "v2", digest: "b", versionNumber: 2 }], nextCursor: "v2" },
    v2: { versions: [{ id: "v1", digest: "a", versionNumber: 1 }], nextCursor: null },
  };
  const read: string[] = [];
  const listPage = async (before?: string) => { read.push(before ?? "first"); return pages[before ?? "first"]!; };

  const found = await findSkillVersions(listPage, { digests: ["b"], ids: ["v3"] });
  assert.equal(found.latest?.versionNumber, 5);
  assert.equal(found.byDigest.get("b")?.versionNumber, 2);
  assert.equal(found.byId.get("v3")?.versionNumber, 3);
  assert.deepEqual(read, ["first", "v4"], "the last page is not read once every wanted version is found");

  // A restore repeats bytes, so a digest names its newest version.
  read.length = 0;
  assert.equal((await findSkillVersions(listPage, { digests: ["a"] })).byDigest.get("a")?.versionNumber, 4);
  assert.deepEqual(read, ["first"]);

  // A version the list does not have is simply not found, and the reading stops at the bound.
  read.length = 0;
  const missing = await findSkillVersions(listPage, { digests: ["z"] }, 2);
  assert.equal(missing.byDigest.get("z"), undefined);
  assert.deepEqual(read, ["first", "v4"]);
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

test("the Library Overview's count line counts skills, the library's groups and the machines deploying them", () => {
  assert.equal(skillLibrarySummary({ skills: 10, groups: 4, deployingMachines: 2 }),
    "10 skills in 4 groups, deployed to agents on 2 machines.");
  assert.equal(skillLibrarySummary({ skills: 1, groups: 1, deployingMachines: 1 }), "1 skill in 1 group, deployed to agents on 1 machine.");
  assert.equal(skillLibrarySummary({ skills: 2, groups: 0, deployingMachines: 0 }), "2 skills, not deployed to any machine yet.");

  const runner = (runnerId: string) => ({ runnerId, status: "online", agents: [] }) as unknown as RunnerView;
  const desired = [{ name: "code-review", versionDigest: "d1", targets: [] }];
  assert.equal(skillDeployingMachineCount([runner("r1"), runner("r2"), runner("r3"), runner("r4")], {
    r1: { desired, reported: null },
    r2: { desired: [], reported: null },
    r3: { desired, reported: null, loadError: "Request failed" },
  }), 1, "only a loaded machine with an assigned skill counts");
});

test("Needs Attention lists exactly the skills skillAttention() marks, most urgent first, then the orphaned copies", () => {
  const claude = { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" as const, available: true };
  const codex = { ...claude, id: "codex", name: "Codex", driver: "codex" as const };
  const studio = { runnerId: "r1", os: "linux", status: "online", agents: [claude, codex], protocolVersion: 200 } as unknown as RunnerView;
  const laptop = { ...studio, runnerId: "r2" } as RunnerView;
  const target = (name: string) => ({ name, versionDigest: "d1", targets: [{ agentId: "claude", invocation: "agent" as const }, { agentId: "codex", invocation: "agent" as const }] });
  const link = (name: string, status: "linked" | "error", detail?: string) => ({
    name, digest: "d1", links: ["claude", "codex"].map((agentId) => ({ agentId, status, ...(detail ? { detail } : {}) })),
  });
  const machineSkills: Record<string, RunnerSkillsResponse> = {
    r1: {
      desired: [target("broken"), target("edited"), target("fine"), target("held")],
      reported: {
        deployed: [link("broken", "error", "can't run manual-only skills"), link("edited", "linked"), link("fine", "linked"), link("held", "linked")],
        drift: [{ name: "edited", digest: "d1", variant: "agent", held: false }],
      },
    },
    r2: { desired: [target("broken")], reported: { deployed: [link("broken", "error")] } },
  };
  const skills = [
    skill({ id: "s-fine", name: "fine" }),
    skill({ id: "s-held", name: "held", gitAutoUpdate: { enabled: true, held: { commit: "0123456789abcdef", reason: "scripts", scriptPaths: [], heldAt: 1 } } }),
    skill({ id: "s-edited", name: "edited" }),
    skill({ id: "s-broken", name: "broken" }),
    skill({ id: "s-offer", name: "using-wollipog", builtIn: { release: "1", heldUpdate: null }, recommendation: { dismissed: false }, assignmentCount: 0 }),
  ];
  const labels: Record<string, string> = { r1: "Studio Workstation", r2: "Laptop" };
  const items = skillOverviewAttention({ skills, runners: [studio, laptop], machineSkills, orphanCount: 4, machineLabel: (id) => labels[id]! });

  assert.deepEqual(items.map((item) => item.kind), ["error", "edited", "update_held", "orphans"]);
  assert.deepEqual(items.flatMap((item) => item.kind === "orphans" ? [] : [item.skill.id]),
    skills.filter((entry) => skillAttention(entry, [studio, laptop], machineSkills)).map((entry) => entry.id).sort(
      (a, b) => ["s-broken", "s-edited", "s-held"].indexOf(a) - ["s-broken", "s-edited", "s-held"].indexOf(b)),
    "the overview and the list's badges mark the same skills; a recommendation is not an item");
  assert.deepEqual(items.map((item) => item.reason), [
    "Claude Code and Codex on Studio Workstation: can't run manual-only skills. 1 other machine also reports errors.",
    "Studio Workstation has an edited copy of this skill.",
    "An update to Git commit 0123456789ab waits for your review.",
    "Machines keep 4 edited copies that no library skill shows.",
  ]);
  const orphans = items.at(-1)!;
  assert.equal(orphans.kind === "orphans" && orphans.count, 4);

  // A held built-in update, an error without a detail, and nothing orphaned.
  const builtInHeld = skill({ id: "s-b", name: "fine", builtIn: { release: "1", heldUpdate: { release: "0.30.0", digest: "d2" } } });
  const quiet = skillOverviewAttention({
    skills: [builtInHeld, skill({ id: "s-broken", name: "broken" })],
    runners: [laptop], machineSkills, orphanCount: 0, machineLabel: (id) => labels[id]!,
  });
  assert.deepEqual(quiet.map((item) => item.reason), [
    "Claude Code and Codex on Laptop reported a deployment error.",
    "The update in Wollipog 0.30.0 waits for your review.",
  ]);
  assert.deepEqual(skillOverviewAttention({ skills: [skill({ name: "fine" })], runners: [studio], machineSkills, orphanCount: 0, machineLabel: String }), []);
  assert.equal(skillOverviewAttention({ skills: [], runners: [], machineSkills: {}, orphanCount: 1, machineLabel: String })[0]!.reason,
    "A machine keeps an edited copy that no library skill shows.");
});

test("an offline machine's agents update when it reconnects", () => {
  const runner = (runnerId: string, status: string) => ({ runnerId, status, agents: [] }) as unknown as RunnerView;
  const label = (id: string) => ({ r1: "Studio Workstation", r2: "Laptop" })[id]!;
  assert.equal(skillOfflineMachineSentence([runner("r1", "online")], label), null);
  assert.equal(skillOfflineMachineSentence([runner("r1", "online"), runner("r2", "offline")], label),
    "Laptop is offline; its agents update when it reconnects.");
  assert.equal(skillOfflineMachineSentence([runner("r1", "offline"), runner("r2", "offline")], label),
    "2 machines are offline; their agents update when they reconnect.");

  const loaded: RunnerSkillsResponse = { desired: [], reported: null };
  const failed: RunnerSkillsResponse = { ...loaded, loadError: "Skills status could not be loaded." };
  assert.equal(skillUncheckedMachineSentence([runner("r1", "online")], { r1: loaded }, label), null);
  assert.equal(skillUncheckedMachineSentence([runner("r1", "online")], {}, label), null, "still loading is not a failure");
  assert.equal(skillUncheckedMachineSentence([runner("r1", "online"), runner("r2", "online")], { r1: loaded, r2: failed }, label),
    "Laptop's skill status could not be loaded, so its skills are not checked.");
  assert.equal(skillUncheckedMachineSentence([runner("r1", "online"), runner("r2", "online")], { r1: failed, r2: failed }, label),
    "2 machines' skill status could not be loaded, so their skills are not checked.");
});

test("Recently Changed shows each skill's newest change, newest first, at most five", () => {
  const version = (createdAt: number, extra: Partial<NonNullable<SkillSummary["latestVersion"]>> = {}) => ({ id: `v${createdAt}`, digest: "d", createdAt, ...extra });
  const skills = [
    skill({ id: "a", name: "alpha", latestVersion: version(100, { versionNumber: 3, note: "Add migration and test-coverage checks" }) }),
    skill({ id: "b", name: "beta", latestVersion: version(50), lastAssignmentChangedAt: 400 }),
    skill({ id: "c", name: "gamma", latestVersion: version(300, { note: "Automatic update from Git commit abc" }), lastAssignmentChangedAt: 200 }),
    skill({ id: "d", name: "delta", latestVersion: version(250, { versionNumber: 2 }) }),
    skill({ id: "e", name: "epsilon", latestVersion: version(20, { note: "Restored from skillv_0123456789" }) }),
    skill({ id: "f", name: "zeta", latestVersion: version(10) }),
    skill({ id: "g", name: "no-version", latestVersion: null }),
  ];
  const recent = skillRecentChanges(skills);
  assert.deepEqual(recent.map((change) => [change.skill.name, change.kind, change.at, change.detail]), [
    ["beta", "assignment", 400, "Assignments changed"],
    ["gamma", "version", 300, "Automatic update from Git commit abc"],
    ["delta", "version", 250, "New version v2"],
    ["alpha", "version", 100, "v3: Add migration and test-coverage checks"],
    ["epsilon", "version", 20, "Restored an earlier version"],
  ]);

  // An older control plane sends neither field: version dates alone order the rows.
  const legacy = skills.map(({ lastAssignmentChangedAt: _ignored, ...rest }) => ({
    ...rest, latestVersion: rest.latestVersion ? { id: rest.latestVersion.id, digest: "d", createdAt: rest.latestVersion.createdAt } : null,
  }));
  assert.deepEqual(skillRecentChanges(legacy).map((change) => [change.skill.name, change.detail]), [
    ["gamma", "New version"], ["delta", "New version"], ["alpha", "New version"], ["beta", "New version"], ["epsilon", "New version"],
  ]);
  assert.equal(skillVersionChangeDetail({ versionNumber: 0, note: "  Line one\nline two " }), "Line one line two");
  assert.deepEqual(skillRecentChanges([]), []);
});

test("assignment presentation names machines, drivers, agents, and invocation policies", () => {
  assert.equal(describeAssignmentScope({ scopeKind: "instance" }, () => "Build"), "All Machines");
  assert.equal(describeAssignmentScope({ scopeKind: "runner", runnerId: "r1" }, () => "Build Machine"), "Build Machine");
  assert.equal(describeAssignmentScope({ scopeKind: "runner", runnerId: "r1" }, () => undefined), "r1");
  assert.equal(describeAgentSelector({ kind: "all" }), "All Agents");
  assert.equal(describeAgentSelector({ kind: "driver", driver: "claude-code" }), "Claude Code");
  assert.equal(describeAgentSelector({ kind: "driver", driver: "codex" }), "Codex (Command Line)");
  assert.equal(describeAgentSelector({ kind: "agent", agentId: "claude" }, [{ id: "claude", name: "Claude" }]), "Claude");
  assert.equal(describeAgentSelector({ kind: "agent", agentId: "gone" }, []), "gone");
  assert.equal(invocationLabel("agent"), "Agent Invocable");
  assert.equal(invocationLabel("manual"), "Manual Only");
});

test("agent types are named as the tool, never the driver protocol", () => {
  assert.deepEqual(["claude-code", "codex", "codex-app-server", "pi"].map(agentTypeLabel),
    ["Claude Code", "Codex (Command Line)", "Codex (App Server)", "Pi"]);
  for (const driver of ["claude-code", "codex", "codex-app-server", "pi"]) {
    assert.doesNotMatch(agentTypeLabel(driver), /Native|Non-Interactive|RPC/);
  }
});

test("Manual Only reaches only Claude Code, and a selector reaches the agents it names", () => {
  assert.deepEqual(["claude-code", "codex", "codex-app-server", "pi", undefined].map(supportsManualOnly),
    [true, false, false, false, false]);
  const agents = [
    { id: "claude", driver: "claude-code" as const },
    { id: "codex", driver: "codex" as const },
    { id: "codex-2", driver: "codex" as const },
  ];
  assert.deepEqual(agentsReachedBySelector(agents, { kind: "all" }).map((agent) => agent.id), ["claude", "codex", "codex-2"]);
  assert.deepEqual(agentsReachedBySelector(agents, { kind: "driver", driver: "codex" }).map((agent) => agent.id), ["codex", "codex-2"]);
  assert.deepEqual(agentsReachedBySelector(agents, { kind: "agent", agentId: "claude" }).map((agent) => agent.id), ["claude"]);
  assert.deepEqual(agentsReachedBySelector(agents, { kind: "agent", agentId: "gone" }), []);
});

test("a New Skill name error says what is wrong and how to fix it", () => {
  assert.equal(skillNameError("code-review"), null);
  assert.equal(skillNameError("v2.skill_x"), null);
  assert.equal(skillNameError(""), "Enter a name for the skill.");
  assert.equal(skillNameError(".hidden"), "Start with a lowercase letter or digit.");
  assert.equal(skillNameError("-dash"), "Start with a lowercase letter or digit.");
  assert.equal(skillNameError("Code Review"), "Start with a lowercase letter or digit.");
  assert.equal(skillNameError("code review"), "Use lowercase letters, digits, dots, dashes or underscores.");
  assert.equal(skillNameError("code/review"), "Use lowercase letters, digits, dots, dashes or underscores.");
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

test("a machine's unmanaged skills and link removals are read defensively", () => {
  assert.deepEqual(reportedUnmanagedSkills({ unmanaged: [{ agentId: "claude", name: "local-notes" }] }),
    [{ agentId: "claude", name: "local-notes" }]);
  assert.deepEqual(reportedUnmanagedSkills(null), []);
  assert.deepEqual(reportedSkillLinkRemovals({ removals: [{
    path: "~/.claude/skills/retired",
    reason: "No longer in the desired skill list.",
  }] }, null), [{
    path: "~/.claude/skills/retired",
    reason: "No longer in the desired skill list.",
  }]);
  assert.deepEqual(reportedSkillLinkRemovals(null, null), []);
  assert.deepEqual(reportedSkillLinkRemovals({ removals: [
    { path: {} as never, reason: "bad" },
    { path: "~/.codex/skills/good", reason: "Good." },
  ] }, null), [{ path: "~/.codex/skills/good", reason: "Good." }]);
});

test("a skill's link removals are only those whose path is that skill's directory (#1981)", () => {
  const reported = { removals: [
    { path: "~/.claude/skills/code-review", reason: "No longer in the desired skill list." },
    { path: "~/.codex/skills/release-notes", reason: "No longer in the desired skill list." },
    { path: "~/.codex/skills/code-review-extra", reason: "A longer name that starts the same." },
    { path: "~\\.codex\\skills\\code-review", reason: "A Windows path." },
    { path: "~/.agents/skills/code-review/", reason: "A trailing separator." },
    // A WSL removal names its distribution after the path (wsl-skills-helper.ts).
    { path: "~/.codex/skills/code-review (WSL Ubuntu-22.04)", reason: "A WSL path." },
    { path: "~/.codex/skills/code-review-extra (WSL Ubuntu)", reason: "Another skill in WSL." },
    { path: "~/.claude/skills/code-review (WSL Ubuntu (Work))", reason: "A WSL distribution with parentheses." },
  ] };
  assert.deepEqual(reportedSkillLinkRemovals(reported, "code-review").map((entry) => entry.reason), [
    "No longer in the desired skill list.",
    "A Windows path.",
    "A trailing separator.",
    "A WSL path.",
    "A WSL distribution with parentheses.",
  ]);
  assert.deepEqual(reportedSkillLinkRemovals(reported, "release-notes").map((entry) => entry.path),
    ["~/.codex/skills/release-notes"]);
  assert.deepEqual(reportedSkillLinkRemovals(reported, "deleted-skill"), []);
  // Null is the machine's whole history, for Connections.
  assert.equal(reportedSkillLinkRemovals(reported, null).length, 8);
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

  assert.deepEqual(validateSkillDraft({ name: "Bad Name", files: [md("Bad Name")] }), ["Start with a lowercase letter or digit."]);
  // Without a usable name the files are still checked, but not against the name.
  assert.deepEqual(validateSkillFiles({ files: [md("other-name")] }), []);
  assert.ok(validateSkillFiles({ name: "code-review", files: [md("other-name")] })
    .some((error) => error.includes("must match the skill name")));
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
  // New Skill builds SKILL.md from its fields; every reader here agrees on the name it wrote.
  for (const name of ["my-skill", "1.5", "true"]) {
    const built = skillMarkdownFromFields({ name, description: "Does: things, \"quoted\".\nTwice.", body: "# Usage\n" });
    assert.equal(skillMarkdownFrontmatterName(built), name);
    assert.equal(skillMarkdownBody(built), "# Usage\n");
  }
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
