/** Pure logic for the Skills view (no DOM, unit-tested): tolerant response normalization for the
 * skills REST surface, assignment presentation, per-machine deploy-status derivation, folder-upload
 * → SkillFile[] conversion, and client-side draft validation mirroring the protocol validators. */

import { statusMeta, type StatusMeta } from "./status-meta.js";
import {
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  validSkillFilePath,
  validSkillName,
  type AgentDefinition,
  type AgentContext,
  type ResourceScope,
  type DeployedSkillState,
  type RunnerView,
  type SkillDriftState,
  type SkillFile,
  type SkillInvocationPolicy,
  type SkillLinkRemoval,
  type SkillSyncTarget,
  type UnmanagedSkillInfo,
} from "@wollipog/protocol";
import { accountLabelText } from "./personal-identifiers.js";
import { driverKindLabel } from "./agent-presentation.js";
// A cycle (the matrix reads invocationLabel and skillEligibleAgents from here) that only function
// declarations cross, so neither module reads the other while it is still evaluating.
import { skillAgentMatrixCell } from "./skill-assignment-matrix.js";

/* --- Response DTOs. Every field beyond identity is optional on purpose: the control-plane routes
 * are versioned separately from this dashboard, so a shape difference must degrade to a blank
 * cell rather than a crashed view. --- */

export interface SkillVersionSummary {
  id?: string;
  digest?: string;
  createdAt?: number;
  /** 1-based, in creation order within the skill, from the control plane (#1962): shown as "v3".
   * Absent from an older control plane, where a version is named by its short digest instead. */
  versionNumber?: number;
  note?: string;
  manifest?: unknown;
  files?: SkillFile[];
  gitSource?: SkillGitSource & { path: string; commit: string };
  machineSource?: { runnerId: string; sourceDirectory: string; name: string; digest: string; importedAt: number;
    context?: AgentContext; providerAccountId?: string };
}

export interface SkillGitSource { url: string; ref: string; subdirectory: string }
/** Opt-in unattended Git updates; `held` waits for a reviewed import through the preview. */
export interface SkillGitAutoUpdate {
  enabled: boolean;
  intervalMs?: number;
  checkedAt?: number | null;
  checkedCommit?: string | null;
  error?: { message: string; at: number } | null;
  held?: { commit: string; reason: "scripts" | "local_changes" | "untracked_modes"; scriptPaths: string[]; heldAt: number } | null;
}
export interface SkillVersionPreview { version: SkillVersionSummary; currentVersion: SkillVersionSummary | null }
export interface MachineSkillVersionPreview {
  policy: { versionId: string | null; revision: string } | null;
  currentVersion: SkillVersionSummary | null;
  proposedVersion: SkillVersionSummary;
  expectedLatestVersionId: string;
}
export interface MachineSkillVersionPolicy { policy: { versionId: string | null; revision: string } | null }
export interface MachineSkillDiscovery { discoveryId: string; candidates: import("@wollipog/protocol").MachineSkillCandidate[] }
export interface MachineSkillPreview {
  previewId: string; candidate: import("@wollipog/protocol").MachineSkillCandidate;
  files: SkillFile[]; previousFiles: SkillFile[]; digest: string;
  executablePaths?: string[];
  disposition: "new" | "identical" | "update"; assignmentCount: number;
}
export interface MachineSkillAdoptionPreflight {
  status: "blocked" | "prerequisites_met";
  mutationSupported: boolean;
  blockers: string[];
  advisories: string[];
  adoptionToken?: string;
  sharedReaders: string[];
  source: { candidate: import("@wollipog/protocol").MachineSkillCandidate; digest: string; checkedAt: number };
  notice: string;
}
export interface MachineSkillAdoptionResult {
  status: "adopted" | "rejected" | "recovery_required";
  operationId?: string;
  backupDirectory?: string;
  providerAccountId?: string;
  error?: string;
}
export interface MachineSkillRecovery {
  operations: import("@wollipog/protocol").SkillAdoptionRecoveryOperation[];
  truncated: boolean;
}
export interface MachineSkillRecoveryResult {
  status: "restored" | "not_needed" | "blocked" | "recovery_required";
  operation?: import("@wollipog/protocol").SkillAdoptionRecoveryOperation;
  error?: string;
}
export interface SkillGitPreview {
  previewId: string;
  candidates: Array<{
    name: string; path: string; commit: string; digest: string; files: SkillFile[];
    previousFiles: SkillFile[]; source: SkillGitSource;
    disposition: "new" | "update" | "identical"; assignmentCount: number;
    executablePaths: string[];
  }>;
}

export interface SkillSummary {
  id: string;
  name: string;
  description?: string | null;
  groupId?: string | null;
  source?: string;
  gitSource?: SkillVersionSummary["gitSource"];
  gitAutoUpdate?: SkillGitAutoUpdate;
  /** Present while this entry follows a built-in skill the running Wollipog release ships. */
  builtIn?: { release: string; heldUpdate: SkillBuiltInRelease | null };
  /** Present on a user-managed skill whose name a built-in skill also uses. */
  builtInOffer?: SkillBuiltInRelease;
  /** The signed-in user's recommendation state for a built-in skill. */
  recommendation?: { dismissed: boolean };
  /** When a direct assignment last changed; absent with none, or from an older control plane. */
  lastAssignmentChangedAt?: number | null;
  latestVersion?: SkillVersionSummary | null;
  assignmentCount?: number;
  /** When the skill last changed: a new version, a new description, or a new group. */
  updatedAt?: number;
}

export interface SkillBuiltInRelease { release: string; digest: string }

/** GET /api/skills/:id/built-in-version: the running release's content awaiting review. */
export interface SkillBuiltInReview {
  kind: "update" | "adopt";
  release: string;
  digest: string;
  files: SkillFile[];
  currentVersion: SkillVersionSummary | null;
  expectedLatestVersionId: string | null;
  assignmentCount: number;
  gitAutoUpdate: boolean;
}

/** A built-in skill is recommended to the signed-in user until it is assigned or they dismiss it. */
export function skillRecommended(skill: SkillSummary): boolean {
  return Boolean(skill.builtIn && skill.recommendation && !skill.recommendation.dismissed && !skill.assignmentCount);
}

export interface SkillGroupView {
  id: string;
  name: string;
  sortOrder?: number;
  scope?: ResourceScope;
}

export type SkillGroupAssignmentView = Omit<SkillAssignmentView, "skillId"> & { groupId: string };

export type SkillAgentSelector =
  | { kind: "all" }
  | { kind: "driver"; driver: string }
  | { kind: "agent"; agentId: string };

export interface SkillAssignmentView {
  id: string;
  skillId: string;
  scopeKind: "instance" | "runner";
  runnerId?: string | null;
  agentSelector: SkillAgentSelector;
  enabled: boolean;
  invocation: SkillInvocationPolicy;
  createdAt?: number;
  updatedAt?: number;
}

/** Desired entry as returned by GET /api/runners/:id/skills — file contents are omitted. */
export interface RunnerDesiredSkill {
  name: string;
  versionDigest: string;
  targets: SkillSyncTarget[];
}

/** The stored skills_state payload for one machine, or whatever subset the CP persisted. */
export interface ReportedSkillsState {
  deployed?: DeployedSkillState[];
  unmanaged?: UnmanagedSkillInfo[];
  removals?: SkillLinkRemoval[];
  removalsUpdatedAt?: number;
  drift?: SkillDriftState[];
  /** Kept-aside copies beyond the runner's report bound; they are not listed individually. */
  keptAsideOmitted?: number;
  error?: string;
  updatedAt?: number;
}

export interface RunnerSkillsResponse {
  /** Dashboard-only fetch failure; never interpret it as an authoritative empty desired state. */
  loadError?: string;
  desired: RunnerDesiredSkill[];
  reported: ReportedSkillsState | null;
  /** Capability of the runner binary, independent of whether any removal event exists. */
  removalReporting?: "supported" | "unsupported" | "unknown";
  /** Whether this runner verifies deployed copies; an older runner's empty drift list proves nothing. */
  driftReporting?: "supported" | "unsupported" | "unknown";
  /** Whether this runner reports copies a restore kept aside; an older runner's empty list proves nothing. */
  keptAsideReporting?: "supported" | "unsupported" | "unknown";
  /** Edited copies on this machine that no library skill shows, as this user may see them. */
  orphaned?: OrphanedSkillCopy[];
}

export function normalizeRemovalReporting(value: unknown): NonNullable<RunnerSkillsResponse["removalReporting"]> {
  return value === "supported" || value === "unsupported" ? value : "unknown";
}

/** One reported drifted copy, as the resolution routes address it. */
export type SkillDriftCopy = Pick<SkillDriftState, "name" | "digest" | "variant">;

export interface SkillDriftPreview {
  previewId: string;
  drift: SkillDriftCopy & { observedDigest: string };
  /** Library files the import would create (the Manual Only frontmatter line removed). */
  files: SkillFile[];
  /** The current latest library version's files. */
  previousFiles: SkillFile[];
  digest: string | null;
  importable: boolean;
  importBlocker?: string;
  disposition: "identical" | "update";
  /** False when the edited copy was published from an older version than the library's latest. */
  publishedFromLatest: boolean;
  pinned: boolean;
  assignmentCount: number;
}

export interface SkillDriftResolution {
  status?: "restored" | "not_needed";
  released?: boolean;
  pinMoved?: boolean;
  warning?: string;
  state?: ReportedSkillsState | null;
}

/** Well-formed drift entries for one skill; anything malformed is ignored rather than trusted. */
export function reportedSkillDrift(reported: ReportedSkillsState | null | undefined, skillName: string): SkillDriftState[] {
  if (!Array.isArray(reported?.drift)) return [];
  return reported.drift.filter((entry) => entry && entry.name === skillName && typeof entry.digest === "string" &&
    (entry.variant === "agent" || entry.variant === "manual"));
}

export function driftVariantLabel(variant: SkillInvocationPolicy): string {
  return variant === "manual" ? "Manual Only Copy" : "Agent Invocable Copy";
}

/** How the resolution routes address one orphaned copy. */
export type OrphanedSkillCopyRef =
  | { kind: "kept_aside"; id: string }
  | { kind: "deleted_skill"; name: string; digest: string; variant: SkillInvocationPolicy };

/** An edited copy a machine keeps that no library skill page shows: a copy a restore kept aside, or
 * an edited copy of a skill deleted from the library. */
export interface OrphanedSkillCopy {
  kind: OrphanedSkillCopyRef["kind"];
  id?: string;
  name?: string;
  digest?: string;
  variant?: SkillInvocationPolicy;
  keptAsideAt?: number;
  observedDigest?: string;
  observedFingerprint?: string;
  held?: boolean;
  detail?: string;
  /** The accessible library skill with this name, which an import adds a version to. */
  skillId?: string;
}

export interface OrphanedSkillCopyPreview {
  previewId: string;
  copy: OrphanedSkillCopyRef & { observedDigest: string };
  /** The skill the import creates or updates; null when the copy does not name one. */
  name: string | null;
  /** Library files the import would create (a Manual Only copy's injected line removed). */
  files: SkillFile[];
  /** The latest version's files when a skill with this name exists. */
  previousFiles: SkillFile[];
  digest: string | null;
  importable: boolean;
  importBlocker?: string;
  disposition: "new" | "update" | "identical";
  assignmentCount: number;
}

export interface OrphanedSkillCopyResolution {
  status?: "discarded" | "kept_aside" | "not_needed" | "gone";
  released?: boolean;
  warning?: string;
  state?: ReportedSkillsState | null;
}

/** Well-formed orphaned copies from a runner skills response; anything malformed is ignored. */
export function reportedOrphanedCopies(response: RunnerSkillsResponse | undefined): OrphanedSkillCopy[] {
  if (!Array.isArray(response?.orphaned)) return [];
  return response.orphaned.filter((copy) => copy && (copy.kind === "kept_aside"
    ? typeof copy.id === "string"
    : copy.kind === "deleted_skill" && typeof copy.name === "string" && typeof copy.digest === "string" &&
      (copy.variant === "agent" || copy.variant === "manual")));
}

/** Kept-aside copies a machine could not list individually. */
export function omittedKeptAsideCopies(response: RunnerSkillsResponse | undefined): number {
  const count = response?.reported?.keptAsideOmitted;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export function orphanedCopyRef(copy: OrphanedSkillCopy): OrphanedSkillCopyRef {
  return copy.kind === "kept_aside"
    ? { kind: "kept_aside", id: copy.id! }
    : { kind: "deleted_skill", name: copy.name!, digest: copy.digest!, variant: copy.variant! };
}

export function orphanedCopyKey(copy: OrphanedSkillCopy): string {
  return copy.kind === "kept_aside" ? `kept:${copy.id}` : `deleted:${copy.name}:${copy.variant}:${copy.digest}`;
}

/* Wrapped-or-bare payload aliases for the list routes, so the API client stays honest about the
 * two shapes the concurrent control-plane workstream may settle on. */
export type SkillListPayload = SkillSummary[] | { skills?: SkillSummary[] };
export type SkillGroupListPayload = SkillGroupView[] | { groups?: SkillGroupView[]; creationScope?: ResourceScope | null };
export type SkillAssignmentListPayload = SkillAssignmentView[] | { assignments?: SkillAssignmentView[] };
export type SkillAssignmentPayload = SkillAssignmentView | { assignment?: SkillAssignmentView };
export type SkillDetailPayload = SkillSummary | { skill?: SkillSummary };

function fromPayload<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const nested = (payload as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return nested as T[];
  }
  return [];
}

export function skillsFromPayload(payload: SkillListPayload | unknown): SkillSummary[] {
  return fromPayload<SkillSummary>(payload, "skills").filter((skill) => Boolean(skill?.id && skill?.name));
}

export function skillGroupsFromPayload(payload: SkillGroupListPayload | unknown): SkillGroupView[] {
  return fromPayload<SkillGroupView>(payload, "groups").filter((group) => Boolean(group?.id && group?.name));
}

export function skillAssignmentsFromPayload(payload: SkillAssignmentListPayload | unknown): SkillAssignmentView[] {
  return fromPayload<SkillAssignmentView>(payload, "assignments")
    .filter((assignment) => Boolean(assignment?.id && assignment?.agentSelector?.kind))
    .map((assignment) => ({ ...assignment, enabled: assignment.enabled !== false }));
}

export function skillFromPayload(payload: SkillDetailPayload | unknown): SkillSummary | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { skill?: unknown; latestVersion?: unknown; id?: unknown; name?: unknown };
  const wrapped = record.skill && typeof record.skill === "object";
  const candidate = wrapped ? (record.skill as SkillSummary) : (record as SkillSummary);
  if (!candidate.id || !candidate.name) return null;
  // The detail route returns { skill, latestVersion, assignments } where the skill record holds
  // only a version summary and the sibling holds the full version including files — the sibling
  // always wins so the view sees the files.
  if (wrapped && record.latestVersion && typeof record.latestVersion === "object") {
    return { ...candidate, latestVersion: record.latestVersion as SkillVersionSummary };
  }
  return candidate;
}

/* --- Versions and sources --- */

/** The 12 characters a digest shows as, wherever a version needs a fingerprint (§11.3). */
export const SHORT_DIGEST_LENGTH = 12;

/**
 * How people name a version: "v3". A control plane that predates version numbers gets the short
 * digest instead (`mono` tells the caller to set it in the monospace face); `skillv_…` ids never show.
 */
export function skillVersionLabel(version: SkillVersionSummary | null | undefined): { text: string; mono: boolean } | null {
  const number = version?.versionNumber;
  if (typeof number === "number" && Number.isInteger(number) && number > 0) return { text: `v${number}`, mono: false };
  if (version?.digest) return { text: version.digest.slice(0, SHORT_DIGEST_LENGTH), mono: true };
  return null;
}

export type SkillSourceKind = "built_in" | "git" | "machine" | "library";

/** Where a skill's content comes from. A built-in skill updates with each release whatever else it
 * records, and a Git skill keeps its source (and its updates) even when a later version was imported
 * from a machine. */
export function skillSourceKind(skill: SkillSummary): SkillSourceKind {
  if (skill.builtIn) return "built_in";
  if (skill.gitSource ?? skill.latestVersion?.gitSource) return "git";
  if (skill.latestVersion?.machineSource) return "machine";
  return "library";
}

export function skillSourceLabel(kind: SkillSourceKind): string {
  return { built_in: "Built-In", git: "Git", machine: "Machine", library: "Library" }[kind];
}

/* --- The list --- */

/** What a skill needs from the user, most urgent first. Built-In and Recommended are not here: a
 * skill that needs nothing shows no status (§5.2, §11.1). */
export type SkillAttention = "error" | "edited" | "update_held";

/**
 * The one status a skill shows in the list, and the reason the Library Overview (#1971) lists it:
 * Error when any eligible agent reports a deployment error for it (the Machine × Agents model), then
 * Edited when a machine reports an edited copy, then Update Held for a held Git or built-in update.
 * Machines whose report has not loaded say nothing.
 */
export function skillAttention(
  skill: Pick<SkillSummary, "name" | "gitAutoUpdate" | "builtIn">,
  runners: ReadonlyArray<RunnerView>,
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>,
): SkillAttention | null {
  let edited = false;
  for (const runner of runners) {
    const state = machineSkills[runner.runnerId];
    if (!state || state.loadError) continue;
    // A machine-wide sync error is this skill's only on a machine that deploys it.
    const deploys = state.desired.some((entry) => entry.name === skill.name) ||
      Boolean(state.reported?.deployed?.some((entry) => entry.name === skill.name));
    if (deploys && runner.agents.some((agent) => {
      const cell = skillAgentMatrixCell(runner, agent, skill.name, state);
      return cell.desired !== "Unavailable" && cell.reported === "Error";
    })) return "error";
    if (reportedSkillDrift(state.reported, skill.name).length) edited = true;
  }
  if (edited) return "edited";
  return skill.gitAutoUpdate?.held || skill.builtIn?.heldUpdate ? "update_held" : null;
}

const oneLine = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/**
 * A row's second line: the description with its line breaks collapsed to spaces, "" when the skill
 * has none (the row says "No description"), or null when it only repeats the name (§5.2).
 */
export function skillListDescription(skill: Pick<SkillSummary, "name" | "description">): string | null {
  const text = oneLine(skill.description);
  return text.toLocaleLowerCase() === skill.name.toLocaleLowerCase() ? null : text;
}

/** View Options › Show. */
export type SkillListShow = "all" | "attention" | "git" | "built_in" | "unassigned";
/** View Options › Group By. */
export type SkillListGrouping = "group" | "none";

/** The skills a filter keeps: the query matches the name or the full description, not only what a
 * row has room for, and Show narrows by attention, source or assignment. */
export function filterSkillList(
  skills: ReadonlyArray<SkillSummary>,
  { query, show, attention }: {
    query: string;
    show: SkillListShow;
    attention: (skill: SkillSummary) => SkillAttention | null;
  },
): SkillSummary[] {
  const needle = oneLine(query).toLocaleLowerCase();
  return skills.filter((skill) => {
    if (needle && !skill.name.toLocaleLowerCase().includes(needle) &&
      !oneLine(skill.description).toLocaleLowerCase().includes(needle)) return false;
    switch (show) {
      case "attention": return attention(skill) !== null;
      case "git": return Boolean(skill.gitSource ?? skill.latestVersion?.gitSource);
      case "built_in": return Boolean(skill.builtIn);
      case "unassigned": return !skill.assignmentCount;
      default: return true;
    }
  });
}

export interface SkillListGroup {
  /** A stable key: `recommended`, `no-group`, `all`, or `group:<id>`. */
  key: string;
  /** The library group's id; null for the list's own groups. */
  id: string | null;
  /** The label, or null for Group By › None's one flat list, which has none. */
  name: string | null;
  skills: SkillSummary[];
}

/**
 * The list's groups, each alphabetical: Recommended first (built-in skills offered to this user,
 * which leave it once assigned or dismissed), then No Group, then the library's groups in their sort
 * order. A skill in a group that no longer exists is in No Group. Empty groups are omitted: the list
 * is a reading surface, not the group manager. Group By › None is one flat list with no label.
 */
export function groupSkillList(
  skills: ReadonlyArray<SkillSummary>,
  groups: ReadonlyArray<SkillGroupView>,
  grouping: SkillListGrouping = "group",
): SkillListGroup[] {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  if (grouping === "none") return sorted.length ? [{ key: "all", id: null, name: null, skills: sorted }] : [];
  const out: SkillListGroup[] = [];
  const push = (group: SkillListGroup) => { if (group.skills.length) out.push(group); };
  const recommended = sorted.filter(skillRecommended);
  const rest = sorted.filter((skill) => !skillRecommended(skill));
  const groupIds = new Set(groups.map((group) => group.id));
  push({ key: "recommended", id: null, name: "Recommended", skills: recommended });
  push({ key: "no-group", id: null, name: "No Group", skills: rest.filter((skill) => !skill.groupId || !groupIds.has(skill.groupId)) });
  const ordered = [...groups].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  for (const group of ordered) {
    push({ key: `group:${group.id}`, id: group.id, name: group.name, skills: rest.filter((skill) => skill.groupId === group.id) });
  }
  return out;
}

/* --- The Library Overview (#1971) --- */

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Pi". */
function joinNames(names: ReadonlyArray<string>): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const sentence = (text: string) => /[.!?]$/.test(text) ? text : `${text}.`;

/**
 * The overview's count line: "10 skills in 4 groups, deployed to agents on 2 machines." A machine
 * counts once any assignment targets it; the groups are the library's, whether or not they hold a
 * skill, as Manage Groups lists them.
 */
export function skillLibrarySummary({ skills, groups, deployingMachines }: {
  skills: number;
  groups: number;
  deployingMachines: number;
}): string {
  const library = counted(skills, "skill", "skills") + (groups > 0 ? ` in ${counted(groups, "group", "groups")}` : "");
  return deployingMachines > 0
    ? `${library}, deployed to agents on ${counted(deployingMachines, "machine", "machines")}.`
    : `${library}, not deployed to any machine yet.`;
}

/** Machines whose skills report has loaded and assigns them at least one skill. */
export function skillDeployingMachineCount(
  runners: ReadonlyArray<RunnerView>,
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>,
): number {
  return runners.filter((runner) => {
    const state = machineSkills[runner.runnerId];
    return Boolean(state && !state.loadError && state.desired.length > 0);
  }).length;
}

/** One Needs Attention row: a skill with its status, or the machines' orphaned copies. */
export type SkillOverviewAttentionItem =
  | { kind: SkillAttention; skill: SkillSummary; reason: string }
  | { kind: "orphans"; count: number; reason: string };

const ATTENTION_ORDER: Record<SkillAttention, number> = { error: 0, edited: 1, update_held: 2 };

/**
 * Needs Attention: every skill `skillAttention()` marks, so the overview and the list's badges
 * always agree, most urgent first and then by name, with a one-line reason each; then the orphaned
 * copies as one row while any machine reports some. A recommendation is never an item.
 */
export function skillOverviewAttention({ skills, runners, machineSkills, orphanCount, machineLabel }: {
  skills: ReadonlyArray<SkillSummary>;
  runners: ReadonlyArray<RunnerView>;
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>;
  orphanCount: number;
  machineLabel: (runnerId: string) => string;
}): SkillOverviewAttentionItem[] {
  const items: SkillOverviewAttentionItem[] = skills
    .flatMap((skill) => {
      const kind = skillAttention(skill, runners, machineSkills);
      return kind ? [{ kind, skill, reason: skillAttentionReason(kind, skill, runners, machineSkills, machineLabel) }] : [];
    })
    .sort((a, b) => ATTENTION_ORDER[a.kind] - ATTENTION_ORDER[b.kind] || a.skill.name.localeCompare(b.skill.name));
  if (orphanCount > 0) {
    items.push({
      kind: "orphans",
      count: orphanCount,
      reason: orphanCount === 1
        ? "A machine keeps an edited copy that no library skill shows."
        : `Machines keep ${orphanCount} edited copies that no library skill shows.`,
    });
  }
  return items;
}

/** Why a skill is in Needs Attention, read from the same reports `skillAttention()` read. */
function skillAttentionReason(
  kind: SkillAttention,
  skill: SkillSummary,
  runners: ReadonlyArray<RunnerView>,
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>,
  machineLabel: (runnerId: string) => string,
): string {
  const loaded = runners.flatMap((runner) => {
    const state = machineSkills[runner.runnerId];
    return state && !state.loadError ? [{ runner, state }] : [];
  });
  if (kind === "error") {
    // The Machine × Agents model: the eligible agents whose cell reports Error, per machine.
    const failing = loaded.flatMap(({ runner, state }) => {
      const deploys = state.desired.some((entry) => entry.name === skill.name) ||
        Boolean(state.reported?.deployed?.some((entry) => entry.name === skill.name));
      if (!deploys) return [];
      const cells = runner.agents.flatMap((agent) => {
        const cell = skillAgentMatrixCell(runner, agent, skill.name, state);
        return cell.desired !== "Unavailable" && cell.reported === "Error" ? [{ agent, detail: cell.detail }] : [];
      });
      return cells.length ? [{ runner, cells }] : [];
    });
    const first = failing[0];
    if (!first) return "A machine reported a deployment error.";
    const who = `${joinNames(first.cells.map(({ agent }) => agent.name))} on ${machineLabel(first.runner.runnerId)}`;
    const detail = first.cells.find((cell) => cell.detail)?.detail;
    const more = failing.length > 1 ? ` ${counted(failing.length - 1, "other machine also reports", "other machines also report")} errors.` : "";
    return (detail ? `${who}: ${sentence(oneLine(detail))}` : `${who} reported a deployment error.`) + more;
  }
  if (kind === "edited") {
    const machines = loaded.filter(({ state }) => reportedSkillDrift(state.reported, skill.name).length > 0)
      .map(({ runner }) => machineLabel(runner.runnerId));
    if (machines.length <= 1) return `${machines[0] ?? "A machine"} has an edited copy of this skill.`;
    return `${machines[0]} and ${counted(machines.length - 1, "other machine", "other machines")} have edited copies of this skill.`;
  }
  const held = skill.gitAutoUpdate?.held;
  if (held) return `An update to Git commit ${held.commit.slice(0, 12)} waits for your review.`;
  return `The update in Wollipog ${skill.builtIn?.heldUpdate?.release ?? "this release"} waits for your review.`;
}

/** Machines whose agents get assignment changes only once they reconnect. */
export function skillOfflineMachineSentence(
  runners: ReadonlyArray<RunnerView>,
  machineLabel: (runnerId: string) => string,
): string | null {
  const offline = runners.filter((runner) => runner.status !== "online");
  if (!offline.length) return null;
  return offline.length === 1
    ? `${machineLabel(offline[0]!.runnerId)} is offline; its agents update when it reconnects.`
    : `${offline.length} machines are offline; their agents update when they reconnect.`;
}

/** Machines whose skills report failed to load, which `skillAttention()` cannot check. */
export function skillUncheckedMachineSentence(
  runners: ReadonlyArray<RunnerView>,
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>,
  machineLabel: (runnerId: string) => string,
): string | null {
  const unchecked = runners.filter((runner) => machineSkills[runner.runnerId]?.loadError);
  if (!unchecked.length) return null;
  return unchecked.length === 1
    ? `${machineLabel(unchecked[0]!.runnerId)}'s skill status could not be loaded, so its skills are not checked.`
    : `${unchecked.length} machines' skill status could not be loaded, so their skills are not checked.`;
}

/** One Recently Changed row: the skill's newest change, a version or an assignment edit. */
export interface SkillRecentChange {
  skill: SkillSummary;
  kind: "version" | "assignment";
  at: number;
  /** Line 2, sentence case. */
  detail: string;
}

/** A restore's note names the restored version by its internal id, which never shows. */
const RESTORED_NOTE = /^Restored from skillv_\S+$/;

/** Line 2 of a new version: "v3: Add migration checks", the note alone before version numbers
 * (#1962), or the number alone when the version has no note. */
export function skillVersionChangeDetail(version: SkillVersionSummary): string {
  const note = version.note && RESTORED_NOTE.test(version.note) ? "Restored an earlier version" : oneLine(version.note);
  const number = typeof version.versionNumber === "number" && Number.isInteger(version.versionNumber) &&
    version.versionNumber > 0 ? `v${version.versionNumber}` : null;
  if (number && note) return `${number}: ${note}`;
  return number ? `New version ${number}` : note || "New version";
}

/**
 * Recently Changed: up to `limit` skills, newest first, each by its newest change. A control plane
 * without `lastAssignmentChangedAt` leaves only the version dates, and the rows still render.
 */
export function skillRecentChanges(skills: ReadonlyArray<SkillSummary>, limit = 5): SkillRecentChange[] {
  const changes = skills.flatMap((skill): SkillRecentChange[] => {
    const version = skill.latestVersion;
    const versionAt = typeof version?.createdAt === "number" ? version.createdAt : null;
    const assignedAt = typeof skill.lastAssignmentChangedAt === "number" ? skill.lastAssignmentChangedAt : null;
    if (assignedAt !== null && (versionAt === null || assignedAt > versionAt)) {
      return [{ skill, kind: "assignment", at: assignedAt, detail: "Assignments changed" }];
    }
    return versionAt !== null && version ? [{ skill, kind: "version", at: versionAt, detail: skillVersionChangeDetail(version) }] : [];
  });
  return changes.sort((a, b) => b.at - a.at || a.skill.name.localeCompare(b.skill.name)).slice(0, limit);
}

/* --- Assignment presentation --- */

export function describeAssignmentScope(
  assignment: Pick<SkillAssignmentView, "scopeKind" | "runnerId">,
  machineLabel: (runnerId: string) => string | undefined,
): string {
  if (assignment.scopeKind === "runner" && assignment.runnerId) {
    return machineLabel(assignment.runnerId) ?? assignment.runnerId;
  }
  return "All Machines";
}

export function describeAgentSelector(
  selector: SkillAgentSelector,
  agents: ReadonlyArray<Pick<AgentDefinition, "id" | "name">> = [],
): string {
  if (selector.kind === "driver") {
    return driverKindLabel(selector.driver as Parameters<typeof driverKindLabel>[0]);
  }
  if (selector.kind === "agent") {
    return agents.find((agent) => agent.id === selector.agentId)?.name ?? selector.agentId;
  }
  return "All Agents";
}

export function invocationLabel(invocation: SkillInvocationPolicy): string {
  return invocation === "manual" ? "Manual Only" : "Agent Invocable";
}

/** Drivers the runner reconciler can deploy to. */
const DEPLOYABLE_DRIVERS = new Set(["claude-code", "codex", "codex-app-server", "pi"]);

/** Agents on this machine that skill deployment can actually reach. The pickers list these so an
 * assignment cannot be aimed at an ACP or unsupported execution context. */
export function skillEligibleAgents(agents: ReadonlyArray<AgentDefinition>, includeWsl = false): AgentDefinition[] {
  return agents.filter((agent) =>
    DEPLOYABLE_DRIVERS.has(agent.driver ?? "acp") &&
    ((agent.context?.kind ?? "native") === "native" || (includeWsl && agent.context?.kind === "wsl")));
}

/* --- Deploy status derivation --- */

export type SkillDeployStatus = "deployed" | "pending" | "drift" | "conflict" | "error" | "offline";

/** The chip's words and tone come from the shared skill-deployment vocabulary (§11.2): a deployed
 * copy is Linked, and a hand-edited one is Edited. */
export interface SkillDeployBadge extends StatusMeta {
  status: SkillDeployStatus;
  detail?: string;
}

function badge(status: SkillDeployStatus, detail?: string): SkillDeployBadge {
  const meta = statusMeta("skill", status === "deployed" ? "linked" : status === "drift" ? "edited" : status);
  return { status, ...meta, ...(detail ? { detail } : {}) };
}

/** One skill × one machine → the chip the detail pane shows.
 *
 * Precedence: an unreachable machine reports nothing trustworthy (offline); a hand-edited deployed
 * copy needs a decision before anything else can converge (drift); a real file in the way must be
 * surfaced over everything else the report says (conflict); an explicit error next; anything not
 * yet reconciled to the desired digest and every target linked is pending. */
export function skillDeployBadge(input: {
  loadError?: string;
  loading?: boolean;
  runnerOnline: boolean;
  desired: Pick<RunnerDesiredSkill, "versionDigest" | "targets"> | undefined;
  reported: ReportedSkillsState | null | undefined;
  skillName: string;
  agents?: ReadonlyArray<Pick<AgentDefinition, "id" | "driver" | "context">>;
  providerAccounts?: ReadonlyArray<{ id: string; label: string; provider?: "claude" | "codex" }>;
}): SkillDeployBadge {
  if (!input.runnerOnline) return badge("offline");
  if (input.loading) return badge("pending", "Skills status has not loaded.");
  if (input.loadError) return badge("error", input.loadError);
  const drift = reportedSkillDrift(input.reported, input.skillName);
  if (drift.length) {
    return badge("drift", drift.some((entry) => entry.held)
      ? "A deployed copy of this skill was edited on this machine. Updates and removals are held until you import the edit or restore the library version."
      : "An edited copy of this skill is retained on this machine until you import the edit or restore the library version.");
  }
  if (!input.desired) return badge("pending", "No assignment targets this machine yet.");
  const deployed = input.reported?.deployed?.filter((entry) => entry.name === input.skillName) ?? [];
  if (!deployed.length) {
    return input.reported?.error
      ? badge("error", input.reported.error)
      : badge("pending", "This machine has not reported this skill yet.");
  }
  const scopedDetail = (row: DeployedSkillState, detail: string | undefined) => {
    if (!row.providerAccountId) return detail;
    const label = accountLabelText(input.providerAccounts?.find((account) => account.id === row.providerAccountId)?.label ??
      "Provider Account");
    return `${label}: ${detail ?? "deployment did not succeed"}`;
  };
  for (const row of deployed) {
    const conflicted = row.links?.find((link) => link.status === "conflict");
    if (conflicted) return badge("conflict", scopedDetail(row,
      conflicted.detail ?? `A conflicting file blocks ${conflicted.agentId}.`));
  }
  for (const row of deployed) {
    const failed = row.links?.find((link) => link.status === "error" || link.status === "unsupported");
    if (row.error || failed) return badge("error", scopedDetail(row, row.error ?? failed?.detail));
  }
  if (deployed.some((row) => row.digest !== input.desired!.versionDigest)) {
    return badge("pending", "An older version is deployed. Sync to update it.");
  }
  const agentsById = new Map(input.agents?.map((agent) => [agent.id, agent]));
  const accountScoped = deployed.some((row) => Boolean(row.providerAccountId));
  if (accountScoped && input.agents && input.providerAccounts?.some((account) => account.provider)) {
    const unscoped = deployed.filter((row) => !row.providerAccountId);
    for (const target of input.desired.targets) {
      const agent = agentsById.get(target.agentId);
      const native = (agent?.context?.kind ?? "native") === "native";
      const provider = native
        ? agent?.driver === "claude-code"
          ? "claude"
          : agent?.driver === "codex" || agent?.driver === "codex-app-server"
            ? "codex"
            : undefined
        : undefined;
      const applicableAccounts = provider
        ? input.providerAccounts.filter((account) => account.provider === provider)
        : [];
      if (applicableAccounts.length) {
        for (const account of applicableAccounts) {
          const linked = deployed.some((row) => row.providerAccountId === account.id &&
            row.links?.some((link) => link.agentId === target.agentId && link.status === "linked"));
          if (!linked) return badge("pending", `${accountLabelText(account.label)}: Awaiting link for ${target.agentId}.`);
        }
        continue;
      }
      const linked = unscoped.some((row) =>
        row.links?.some((link) => link.agentId === target.agentId && link.status === "linked"));
      if (!linked) return badge("pending", `Awaiting links for ${target.agentId}.`);
    }
    return badge("deployed");
  }
  const links = deployed.flatMap((row) => row.links ?? []);
  const linked = new Set(links.filter((link) => link.status === "linked").map((link) => link.agentId));
  const missing = input.desired.targets.filter((target) => !linked.has(target.agentId));
  if (missing.length) {
    return badge("pending", `Awaiting links for ${missing.map((target) => target.agentId).join(", ")}.`);
  }
  return badge("deployed");
}

export function reportedUnmanagedSkills(reported: ReportedSkillsState | null | undefined): UnmanagedSkillInfo[] {
  return Array.isArray(reported?.unmanaged) ? reported.unmanaged : [];
}

export function reportedSkillLinkRemovals(reported: ReportedSkillsState | null | undefined): SkillLinkRemoval[] {
  if (!Array.isArray(reported?.removals)) return [];
  return reported.removals.filter(
    (entry) => entry && typeof entry.path === "string" && typeof entry.reason === "string",
  );
}

/* --- Folder upload → SkillFile[] --- */

export interface UploadedSkillFile {
  /** webkitRelativePath: always starts with the picked folder's own name. */
  relativePath: string;
  bytes: Uint8Array;
}

/** True when the bytes are valid UTF-8 without control garbage, so the file can travel as plain
 * text; anything else is carried base64. */
function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return !text.includes("\0");
  } catch {
    return false;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}

/** Strip the picked folder's own name (the first segment every webkitRelativePath shares) so the
 * skill's files are rooted at the folder the user chose, then produce protocol SkillFiles. */
export function skillFilesFromUploads(uploads: UploadedSkillFile[]): { files: SkillFile[]; errors: string[] } {
  const errors: string[] = [];
  const files: SkillFile[] = [];
  const stripRoot = uploads.length > 0 && uploads.every((upload) => upload.relativePath.includes("/"));
  for (const upload of uploads) {
    const path = stripRoot
      ? upload.relativePath.slice(upload.relativePath.indexOf("/") + 1)
      : upload.relativePath;
    if (!validSkillFilePath(path)) {
      errors.push(`"${path}" is not a valid skill file path.`);
      continue;
    }
    files.push(isUtf8Text(upload.bytes)
      ? { path, content: new TextDecoder().decode(upload.bytes), encoding: "utf8" }
      : { path, content: toBase64(upload.bytes), encoding: "base64" });
  }
  // Byte-wise, matching the canonical manifest ordering the version digest is computed over.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, errors };
}

/* --- Draft validation (mirrors the control plane's protocol-based checks) --- */

export function skillFileByteLength(file: SkillFile): number {
  if (file.encoding === "base64") {
    const trimmed = file.content.replace(/=+$/, "");
    return Math.floor((trimmed.length * 3) / 4);
  }
  return new TextEncoder().encode(file.content).length;
}

/** Line-based frontmatter `name:` reader — deliberately not YAML, mirroring the runner's and the
 * control plane's readers so all three surfaces agree on what "the name matches" means. */
export function skillMarkdownFrontmatterName(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  for (let index = 1; index < Math.min(lines.length, 128); index++) {
    const line = lines[index]!;
    if (line.trim() === "---") break;
    const match = /^name\s*:\s*(.+?)\s*$/.exec(line);
    if (match) return match[1]!.replace(/^["']|["']$/g, "");
  }
  return null;
}

/** SKILL.md without its frontmatter block, for rendering through the transcript's Markdown
 * component — frontmatter is metadata, and CommonMark would render it as a broken heading. */
export function skillMarkdownBody(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return markdown;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return end === -1 ? markdown : lines.slice(end + 1).join("\n").replace(/^\n+/, "");
}

export function validateSkillDraft(input: { name: string; files: SkillFile[] }): string[] {
  const errors: string[] = [];
  if (!validSkillName(input.name)) {
    errors.push("Skill names are lowercase letters, digits, dots, dashes, or underscores (max 64 characters) and cannot start with a dot.");
  }
  if (input.files.length === 0) {
    errors.push("A skill needs at least a SKILL.md file.");
    return errors;
  }
  if (input.files.length > SKILL_MAX_FILES) {
    errors.push(`A skill can contain at most ${SKILL_MAX_FILES} files.`);
  }
  const seen = new Set<string>();
  let total = 0;
  for (const file of input.files) {
    if (!validSkillFilePath(file.path)) errors.push(`"${file.path}" is not a valid skill file path.`);
    if (seen.has(file.path)) errors.push(`"${file.path}" appears more than once.`);
    seen.add(file.path);
    const size = skillFileByteLength(file);
    total += size;
    if (size > SKILL_MAX_FILE_BYTES) {
      errors.push(`"${file.path}" exceeds the ${Math.floor(SKILL_MAX_FILE_BYTES / 1024)} KiB per-file limit.`);
    }
  }
  if (total > SKILL_MAX_TOTAL_BYTES) {
    errors.push(`The skill exceeds the ${Math.floor(SKILL_MAX_TOTAL_BYTES / (1024 * 1024))} MiB total size limit.`);
  }
  const skillMd = input.files.find((file) => file.path === "SKILL.md");
  if (!skillMd) {
    errors.push("SKILL.md must exist at the top level of the skill.");
  } else if (skillMd.encoding === "utf8") {
    const frontmatterName = skillMarkdownFrontmatterName(skillMd.content);
    if (frontmatterName !== null && frontmatterName !== input.name) {
      errors.push(`The SKILL.md frontmatter name "${frontmatterName}" must match the skill name "${input.name}".`);
    }
  }
  return errors;
}

/** The SKILL.md a fresh New Skill dialog starts from. */
export function skillMarkdownTemplate(name: string, description: string): string {
  return `---\nname: ${name || "my-skill"}\ndescription: ${description || "What this skill helps an agent do."}\n---\n\n`;
}
