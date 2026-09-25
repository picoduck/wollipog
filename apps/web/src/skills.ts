/** Pure logic for the Skills view (no DOM, unit-tested): tolerant response normalization for the
 * skills REST surface, assignment presentation, per-machine deploy-status derivation, folder-upload
 * → SkillFile[] conversion, and client-side draft validation mirroring the protocol validators. */

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
  type SkillDriftState,
  type SkillFile,
  type SkillInvocationPolicy,
  type SkillLinkRemoval,
  type SkillSyncTarget,
  type UnmanagedSkillInfo,
} from "@wollipog/protocol";
import { accountLabelText } from "./personal-identifiers.js";
import { driverKindLabel } from "./agent-presentation.js";

/* --- Response DTOs. Every field beyond identity is optional on purpose: the control-plane routes
 * are versioned separately from this dashboard, so a shape difference must degrade to a blank
 * cell rather than a crashed view. --- */

export interface SkillVersionSummary {
  id?: string;
  digest?: string;
  createdAt?: number;
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
  latestVersion?: SkillVersionSummary | null;
  assignmentCount?: number;
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

/* --- Grouping --- */

export interface SkillListGroup {
  id: string | null;
  name: string;
  skills: SkillSummary[];
}

/** Grouped, alphabetical list; groups in their sort order, ungrouped skills last under one
 * heading. Empty groups are omitted — the list is a reading surface, not the group manager. */
export function groupSkillList(skills: SkillSummary[], groups: SkillGroupView[]): SkillListGroup[] {
  const byName = (a: SkillSummary, b: SkillSummary) => a.name.localeCompare(b.name);
  const ordered = [...groups].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  const out: SkillListGroup[] = [];
  for (const group of ordered) {
    const members = skills.filter((skill) => skill.groupId === group.id).sort(byName);
    if (members.length) out.push({ id: group.id, name: group.name, skills: members });
  }
  const groupIds = new Set(groups.map((group) => group.id));
  const ungrouped = skills.filter((skill) => !skill.groupId || !groupIds.has(skill.groupId)).sort(byName);
  if (ungrouped.length) out.push({ id: null, name: out.length ? "Ungrouped" : "All Skills", skills: ungrouped });
  return out;
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

export interface SkillDeployBadge {
  status: SkillDeployStatus;
  label: string;
  /** Existing status-badge tone class, so the chips reuse the app's one badge vocabulary. */
  className: string;
  detail?: string;
}

const DEPLOY_BADGES: Record<SkillDeployStatus, { label: string; className: string }> = {
  deployed: { label: "Deployed", className: "st-done" },
  pending: { label: "Pending", className: "st-running" },
  drift: { label: "Drift", className: "st-input" },
  conflict: { label: "Conflict", className: "st-input" },
  error: { label: "Error", className: "st-failed" },
  offline: { label: "Offline", className: "st-stopped" },
};

function badge(status: SkillDeployStatus, detail?: string): SkillDeployBadge {
  return { status, ...DEPLOY_BADGES[status], ...(detail ? { detail } : {}) };
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
