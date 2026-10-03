/** Pure logic for the Skills view (no DOM, unit-tested): tolerant response normalization for the
 * skills REST surface, assignment presentation, folder-upload → SkillFile[] conversion, and
 * client-side draft validation mirroring the protocol validators. */

import {
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  readSkillFrontmatter,
  validSkillFilePath,
  validSkillName,
  type AgentDefinition,
  type AgentContext,
  type DeployedSkillState,
  type ResourceScope,
  type RunnerView,
  type SkillDriftState,
  type SkillFile,
  type SkillInvocationPolicy,
  type SkillLinkRemoval,
  type SkillSyncTarget,
  type UnmanagedSkillInfo,
} from "@wollipog/protocol";
// A cycle (the matrix reads invocationLabel and skillEligibleAgents from here) that only function
// declarations cross, so neither module reads the other while it is still evaluating.
import { skillDeploymentErrorSummary, skillMachineErrors, type SkillDeploymentErrorSummary } from "./skill-assignment-matrix.js";

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
  /** What made the version ("Restored from v2"). A listed version carries it, or null, from a control
   * plane that lists notes (#1984); undefined means the note was not read. */
  note?: string | null;
  manifest?: unknown;
  files?: SkillFile[];
  gitSource?: SkillGitSource & { path: string; commit: string };
  machineSource?: { runnerId: string; sourceDirectory: string; name: string; digest: string; importedAt: number;
    context?: AgentContext; providerAccountId?: string };
  /** The Wollipog release whose built-in content this version is. */
  builtInSource?: SkillBuiltInRelease;
}

export interface SkillGitSource {
  url: string; ref: string; subdirectory: string;
  /** Reads this commit rather than the ref's head: reviewing a held automatic update (#2280). */
  commit?: string;
}
/** Opt-in unattended Git updates; `held` waits for a reviewed import through the preview. */
export interface SkillGitAutoUpdate {
  enabled: boolean;
  intervalMs?: number;
  checkedAt?: number | null;
  checkedCommit?: string | null;
  error?: { message: string; at: number } | null;
  held?: { commit: string; reason: "scripts" | "local_changes" | "untracked_modes"; scriptPaths: string[]; heldAt: number } | null;
}
export interface SkillVersionPreview {
  version: SkillVersionSummary;
  currentVersion: SkillVersionSummary | null;
  /** Where accepting deploys, as the server computed it for this preview; the accept carries it back so a
   * change in between is refused (#2129). Absent from a control plane that predates the fence. */
  deploymentImpact?: string;
}
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
  /** Where accepting deploys, as the server computed it for this preview; the accept carries it back so a
   * change in between is refused (#2129). Absent from a control plane that predates the fence. */
  deploymentImpact?: string;
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
    /** Where accepting this candidate deploys; see `MachineSkillPreview`. */
    deploymentImpact?: string;
  }>;
  /** A preview of `commit`: where its ref points now, or null when that couldn't be read. */
  refCommit?: string | null;
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
  /** Where accepting deploys, as the server computed it for this preview; the accept carries it back so a
   * change in between is refused (#2129). Absent from a control plane that predates the fence. */
  deploymentImpact?: string;
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
  /** Where accepting deploys, as the server computed it for this preview; the accept carries it back so a
   * change in between is refused (#2129). Absent from a control plane that predates the fence. */
  deploymentImpact?: string;
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
  /** deleted_skill: when the library deleted the skill (#2289); absent when the deletion predates the
   * record, or from an older control plane. */
  skillDeletedAt?: number;
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
  /** Where accepting deploys, as the server computed it for this preview; the accept carries it back so a
   * change in between is refused (#2129). Absent from a control plane that predates the fence. */
  deploymentImpact?: string;
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

/** The skill-store entry a kept-aside copy lives in, which support may ask for. A deleted skill's
 * edited copy has none: it is addressed by its name and digest. */
export function orphanedCopyStoreEntry(copy: OrphanedSkillCopy): string | null {
  return copy.kind === "kept_aside" && copy.id ? `.drift-${copy.id}` : null;
}

/** A kept-aside copy may be discarded only against the fingerprint of every entry; a copy too large
 * to fingerprint has nothing to fence a discard on. */
export function orphanedCopyDiscardable(copy: OrphanedSkillCopy): boolean {
  return copy.kind === "deleted_skill" || !!copy.observedFingerprint;
}

/** A timestamp an orphaned copy carries, as a Date, or null when it is absent or malformed. */
export function orphanedCopyDate(value: unknown): Date | null {
  const at = typeof value === "number" && Number.isFinite(value) ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

/**
 * The second line of an orphaned copy's row (#1974): what kind of copy it is, when a restore kept it
 * aside or the library deleted its skill (#2289), and its invocation, as sentences. The date is
 * formatted as a date, never a time of day, and its spaces are non-breaking, so a wrapping line never
 * splits it.
 */
export function orphanedCopySentence(copy: OrphanedSkillCopy, options: { locale?: string; timeZone?: string } = {}): string {
  const date = (at: Date) => new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium", ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(at).replace(/\s/g, "\u00a0");
  let kind: string;
  if (copy.kind === "kept_aside") {
    const at = orphanedCopyDate(copy.keptAsideAt);
    kind = at
      ? `Kept aside by a restore on ${date(at)}.`
      // Only a copy kept aside before records existed has no record, and so no date or version.
      : copy.digest ? "Kept aside by a restore." : "Kept aside by an earlier runner.";
  } else {
    // A deletion before the library recorded them, or from an older control plane, has no date.
    const at = orphanedCopyDate(copy.skillDeletedAt);
    const deleted = `Its skill was deleted from the library${at ? ` on ${date(at)}` : ""}`;
    kind = copy.held ? `${deleted}; links still serve this copy.` : `${deleted}; no link serves it.`;
  }
  return copy.variant ? `${kind} ${invocationLabel(copy.variant)}.` : kind;
}

/** The runner's own words for why a copy is not skill content ("it contains a symlink"). */
const UNREADABLE_REASON = /cannot be read as skill content: (.+?)\.(?:\s|$)/;

/**
 * Why an orphaned copy cannot be imported, as the row's visible reason (§3.1), or null when it can be
 * imported once its machine is online. `runnerSupports` is whether the machine's runner can resolve a
 * copy of this kind at all.
 */
export function orphanedCopyImportBlocker(copy: OrphanedSkillCopy, runnerSupports: boolean): string | null {
  if (!copy.observedDigest) {
    const reason = copy.detail?.match(UNREADABLE_REASON)?.[1];
    return `Can't be imported: its content can't be read as a skill${reason ? ` (${reason})` : ""}.`;
  }
  return runnerSupports ? null : "Update this machine's runner to import it here.";
}

/** Why an orphaned copy cannot be discarded from this page, or null when it can be once its machine
 * is online. */
export function orphanedCopyDiscardBlocker(copy: OrphanedSkillCopy, runnerSupports: boolean): string | null {
  if (!runnerSupports) return "Update this machine's runner to discard it here.";
  return orphanedCopyDiscardable(copy) ? null : "It's too large to verify, so remove it on the machine itself.";
}

/**
 * What a machine's runner cannot tell this page about its orphaned copies (#1974), as one sentence
 * for a compact notice under the machine, or null when it reports everything.
 */
export function orphanedCopyLimitation(keptAsideUnsupported: boolean, omitted: number): string | null {
  const parts: string[] = [];
  if (keptAsideUnsupported) parts.push("This machine's runner can't list copies a restore kept aside. Update it to list them here.");
  if (omitted > 0) {
    parts.push(`${omitted === 1 ? "1 more kept-aside copy isn't" : `${omitted} more kept-aside copies aren't`} listed. ` +
      "Resolve the listed copies, or remove copies on the machine, to list the rest.");
  }
  return parts.length > 0 ? parts.join(" ") : null;
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
  const number = skillVersionNumber(version);
  if (number !== null) return { text: `v${number}`, mono: false };
  if (version?.digest) return { text: version.digest.slice(0, SHORT_DIGEST_LENGTH), mono: true };
  return null;
}

/** A version's number, or null from a control plane that predates version numbers (#1962). */
export function skillVersionNumber(version: SkillVersionSummary | null | undefined): number | null {
  const number = version?.versionNumber;
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : null;
}

/** The versions a skill review names (#1973), read from the skill's version list. */
export interface SkillReviewVersions {
  latest: SkillVersionSummary | null;
  /** The newest version with each digest: a restore repeats an earlier version's bytes. */
  byDigest: ReadonlyMap<string, SkillVersionSummary>;
  byId: ReadonlyMap<string, SkillVersionSummary>;
}

/**
 * Reads a skill's version list, newest first, a page at a time until every wanted digest and id is
 * found or the list ends. A review only names versions with it, so a version it cannot find is named
 * in words rather than by a digest; `maxPages` bounds a very long history.
 */
export async function findSkillVersions(
  listPage: (before?: string) => Promise<{ versions: SkillVersionSummary[]; nextCursor: string | null }>,
  wanted: { digests?: readonly string[]; ids?: readonly string[] },
  maxPages = 20,
): Promise<SkillReviewVersions> {
  const byDigest = new Map<string, SkillVersionSummary>();
  const byId = new Map<string, SkillVersionSummary>();
  let latest: SkillVersionSummary | null = null;
  let cursor: string | undefined;
  const missing = () => (wanted.digests ?? []).some((digest) => !byDigest.has(digest)) ||
    (wanted.ids ?? []).some((id) => !byId.has(id));
  for (let page = 0; page < maxPages; page++) {
    const { versions, nextCursor } = await listPage(cursor);
    latest ??= versions[0] ?? null;
    for (const version of versions) {
      if (version.digest && !byDigest.has(version.digest)) byDigest.set(version.digest, version);
      if (version.id) byId.set(version.id, version);
    }
    if (!nextCursor || !missing()) break;
    cursor = nextCursor;
  }
  return { latest, byDigest, byId };
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
 * Error when any agent's Deployment row shows Error for it (a reported error, a Manual Only target
 * the agent cannot run, a Conflict or an Unsupported link: `skillMachineErrors`), then Edited when a
 * machine reports an edited copy, then Update Held for a held Git or built-in update. Machines whose
 * report has not loaded say nothing.
 */
export function skillAttention(
  skill: Pick<SkillSummary, "name" | "gitAutoUpdate" | "builtIn">,
  runners: ReadonlyArray<RunnerView>,
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>,
): SkillAttention | null {
  if (skillMachineErrors(skill.name, runners, machineSkills).length) return "error";
  const edited = runners.some((runner) => {
    const state = machineSkills[runner.runnerId];
    return Boolean(state && !state.loadError && reportedSkillDrift(state.reported, skill.name).length);
  });
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
export function skillOverviewAttention({ skills, runners, machineSkills, orphanCount, machineLabel, hideAccountEmails = true }: {
  skills: ReadonlyArray<SkillSummary>;
  runners: ReadonlyArray<RunnerView>;
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>;
  orphanCount: number;
  machineLabel: (runnerId: string) => string;
  hideAccountEmails?: boolean;
}): SkillOverviewAttentionItem[] {
  const items: SkillOverviewAttentionItem[] = skills
    .flatMap((skill) => {
      const kind = skillAttention(skill, runners, machineSkills);
      return kind ? [{ kind, skill, reason: skillAttentionReason(kind, skill, runners, machineSkills, machineLabel, hideAccountEmails) }] : [];
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

/**
 * The words for a skill's deployment error that the Overview's row and the notice share (#2293), so
 * both name the same machine, agents and detail: `who` ("Codex and Pi on Studio"), `detail` (a
 * sentence on one line) and `more`, which counts what else shows Error ("1 other agent there and
 * 2 more machines also report errors."), or "".
 */
export function skillDeploymentErrorWords(
  summary: SkillDeploymentErrorSummary,
  machineLabel: (runnerId: string) => string,
): { who: string; detail: string; more: string } {
  const { agents, otherAgents, moreMachines } = summary;
  const elsewhere = [
    ...(otherAgents ? [counted(otherAgents, "other agent there", "other agents there")] : []),
    ...(moreMachines ? [counted(moreMachines, "more machine", "more machines")] : []),
  ];
  return {
    who: `${joinNames(agents)} on ${machineLabel(summary.runnerId)}`,
    detail: sentence(oneLine(summary.detail)),
    more: elsewhere.length
      ? `${elsewhere.join(" and ")} also ${otherAgents + moreMachines === 1 ? "reports" : "report"} errors.`
      : "",
  };
}

/** Why a skill is in Needs Attention, read from the same reports `skillAttention()` read. */
function skillAttentionReason(
  kind: SkillAttention,
  skill: SkillSummary,
  runners: ReadonlyArray<RunnerView>,
  machineSkills: Readonly<Record<string, RunnerSkillsResponse | undefined>>,
  machineLabel: (runnerId: string) => string,
  hideAccountEmails: boolean,
): string {
  const loaded = runners.flatMap((runner) => {
    const state = machineSkills[runner.runnerId];
    return state && !state.loadError ? [{ runner, state }] : [];
  });
  if (kind === "error") {
    const summary = skillDeploymentErrorSummary(skill.name, runners, machineSkills, undefined, hideAccountEmails);
    if (!summary) return "A machine reported a deployment error.";
    const { who, detail, more } = skillDeploymentErrorWords(summary, machineLabel);
    return `${who}: ${detail}${more ? ` ${more}` : ""}`;
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

/**
 * A version's note on one line (#1984). Restores used to name the restored version by its internal
 * id, which never shows: it reads as that version's number when `known` has it, and in words when not.
 * Null for a version without a note; undefined when the note was not read (an older control plane).
 */
export function skillVersionNote(
  version: SkillVersionSummary,
  known?: ReadonlyMap<string, SkillVersionSummary>,
): string | null | undefined {
  if (version.note === undefined) return undefined;
  const text = oneLine(version.note);
  return text ? nameVersionIds(text, known) : null;
}

/**
 * A version's whole note (#2286), for the selected version's detail: its own line breaks kept, the
 * spaces at each line's end and runs of blank lines dropped, and internal ids named as on the row.
 * Null for a version without a note; undefined when the note was not read (an older control plane).
 */
export function skillVersionFullNote(
  version: SkillVersionSummary,
  known?: ReadonlyMap<string, SkillVersionSummary>,
): string | null | undefined {
  if (version.note === undefined) return undefined;
  const text = (version.note ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return text ? nameVersionIds(text, known) : null;
}

/** A note names a version by its internal id, which never shows: its number when `known` has it. */
function nameVersionIds(text: string, known?: ReadonlyMap<string, SkillVersionSummary>): string {
  return text.replace(/skillv_[A-Za-z0-9_-]+/g, (id) => {
    const number = skillVersionNumber(known?.get(id));
    return number === null ? "an earlier version" : `v${number}`;
  });
}

/** Where a version's content came from (#1984), for a version history's Source fact. A restored
 * version keeps the source of the content it repeats. */
export function skillVersionSource(version: SkillVersionSummary, machineName?: (runnerId: string) => string | undefined): string {
  if (version.builtInSource) return `Built-in release ${version.builtInSource.release}`;
  if (version.gitSource) return `Git commit ${version.gitSource.commit.slice(0, 7)}`;
  if (version.machineSource) {
    const machine = machineName?.(version.machineSource.runnerId);
    return machine ? `Machine snapshot from ${machine}` : "Machine snapshot";
  }
  return "Library edit";
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
  if (selector.kind === "driver") return agentTypeLabel(selector.driver);
  if (selector.kind === "agent") {
    return agents.find((agent) => agent.id === selector.agentId)?.name ?? selector.agentId;
  }
  return "All Agents";
}

export function invocationLabel(invocation: SkillInvocationPolicy): string {
  return invocation === "manual" ? "Manual Only" : "Agent Invocable";
}

/** Agent types the runner reconciler can deploy to, in the order the assignment pickers list them. */
export const SKILL_AGENT_TYPES = ["claude-code", "codex", "codex-app-server", "pi"] as const;
const DEPLOYABLE_DRIVERS = new Set<string>(SKILL_AGENT_TYPES);

/** An agent type as a person assigning a skill knows it: the tool, not the driver protocol.
 * `driverKindLabel` keeps the protocol names ("Codex Non-Interactive") for Agents settings. */
export function agentTypeLabel(driver: string): string {
  if (driver === "claude-code") return "Claude Code";
  if (driver === "codex") return "Codex (Command Line)";
  if (driver === "codex-app-server") return "Codex (App Server)";
  if (driver === "pi") return "Pi";
  return driver;
}

/** Only Claude Code honours `disable-model-invocation`; the runner reports a Manual Only target on
 * any other agent as unsupported. */
export function supportsManualOnly(driver: string | undefined): boolean {
  return driver === "claude-code";
}

/** The agents among `agents` an assignment's selector reaches. */
export function agentsReachedBySelector<A extends Pick<AgentDefinition, "id" | "driver">>(
  agents: ReadonlyArray<A>,
  selector: SkillAgentSelector,
): A[] {
  if (selector.kind === "driver") return agents.filter((agent) => agent.driver === selector.driver);
  if (selector.kind === "agent") return agents.filter((agent) => agent.id === selector.agentId);
  return [...agents];
}

/** Agents on this machine that skill deployment can actually reach. The pickers list these so an
 * assignment cannot be aimed at an ACP or unsupported execution context. */
export function skillEligibleAgents(agents: ReadonlyArray<AgentDefinition>, includeWsl = false): AgentDefinition[] {
  return agents.filter((agent) =>
    DEPLOYABLE_DRIVERS.has(agent.driver ?? "acp") &&
    ((agent.context?.kind ?? "native") === "native" || (includeWsl && agent.context?.kind === "wsl")));
}

export function reportedUnmanagedSkills(reported: ReportedSkillsState | null | undefined): UnmanagedSkillInfo[] {
  return Array.isArray(reported?.unmanaged) ? reported.unmanaged : [];
}

/** The skill directory a removed link's display path names: its last segment, without the
 * " (WSL <distro>)" a WSL removal adds after it. A distribution's name may hold parentheses, but a
 * skill's directory name never holds " (WSL ", so the suffix starts at its first occurrence. */
function removalSkillName(path: string): string | undefined {
  const wsl = path.indexOf(" (WSL ");
  return (wsl >= 0 && path.endsWith(")") ? path.slice(0, wsl) : path).split(/[\\/]/).filter(Boolean).pop();
}

/** The link removals a machine reported. With a skill name, only that skill's: a removed link's
 * path ends in the skill's directory name (`~/.claude/skills/<name>`). `null` keeps every removal,
 * for the machine's own history in Connections. */
export function reportedSkillLinkRemovals(
  reported: ReportedSkillsState | null | undefined,
  skillName: string | null,
): SkillLinkRemoval[] {
  if (!Array.isArray(reported?.removals)) return [];
  return reported.removals.filter(
    (entry) => entry && typeof entry.path === "string" && typeof entry.reason === "string" &&
      (skillName === null || removalSkillName(entry.path) === skillName),
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

/** A SKILL.md's `name:` and `description:` exactly as the control plane reads them: the library's
 * reader over the file's text, a base64 file decoded as UTF-8 the way the server decodes its bytes
 * (#2377). An unterminated frontmatter block has neither. */
export function skillFileFrontmatter(file: SkillFile): { name?: string; description?: string } {
  if (file.encoding === "utf8") return readSkillFrontmatter(file.content);
  try {
    const bytes = Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));
    return readSkillFrontmatter(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes));
  } catch {
    return {};
  }
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
  const nameError = skillNameError(input.name);
  return [...(nameError ? [nameError] : []), ...validateSkillFiles(input)];
}

/** The draft's file errors: count, paths, sizes, and a top-level SKILL.md whose frontmatter name,
 * read as the library reads it, is `name`. The name itself is checked by `skillNameError`; without
 * a usable name the frontmatter name is not compared. */
export function validateSkillFiles(input: { name?: string; files: SkillFile[] }): string[] {
  const errors: string[] = [];
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
  } else if (input.name !== undefined) {
    const frontmatterName = skillFileFrontmatter(skillMd).name;
    if (frontmatterName === undefined) {
      errors.push(`SKILL.md has no frontmatter name. Put "name: ${input.name}" between two "---" lines at its top.`);
    } else if (frontmatterName !== input.name) {
      errors.push(`The SKILL.md frontmatter name "${frontmatterName}" must match the skill name "${input.name}".`);
    }
  }
  return errors;
}

/** Why a New Skill name is not usable, in one sentence, or null when it is (§8.5). */
export function skillNameError(name: string): string | null {
  if (!name) return "Enter a name for the skill.";
  if (validSkillName(name)) return null;
  if (!/^[a-z0-9]/.test(name)) return "Start with a lowercase letter or digit.";
  return "Use lowercase letters, digits, dots, dashes or underscores.";
}
