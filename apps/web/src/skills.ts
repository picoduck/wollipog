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
  type DeployedSkillState,
  type SkillFile,
  type SkillInvocationPolicy,
  type SkillSyncTarget,
  type UnmanagedSkillInfo,
} from "@wollipog/protocol";
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
}

export interface SkillSummary {
  id: string;
  name: string;
  description?: string | null;
  groupId?: string | null;
  source?: string;
  latestVersion?: SkillVersionSummary | null;
  assignmentCount?: number;
}

export interface SkillGroupView {
  id: string;
  name: string;
  sortOrder?: number;
}

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
  error?: string;
  updatedAt?: number;
}

export interface RunnerSkillsResponse {
  desired: RunnerDesiredSkill[];
  reported: ReportedSkillsState | null;
}

/* Wrapped-or-bare payload aliases for the list routes, so the API client stays honest about the
 * two shapes the concurrent control-plane workstream may settle on. */
export type SkillListPayload = SkillSummary[] | { skills?: SkillSummary[] };
export type SkillGroupListPayload = SkillGroupView[] | { groups?: SkillGroupView[] };
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

/** Drivers the runner reconciler can deploy to in the MVP (native contexts only). */
const DEPLOYABLE_DRIVERS = new Set(["claude-code", "codex", "codex-app-server"]);

/** Agents on this machine that skill deployment can actually reach. The pickers list these so an
 * assignment cannot be aimed at an ACP or WSL agent the reconciler would only mark unsupported. */
export function skillEligibleAgents(agents: ReadonlyArray<AgentDefinition>): AgentDefinition[] {
  return agents.filter((agent) =>
    DEPLOYABLE_DRIVERS.has(agent.driver ?? "acp") && (agent.context?.kind ?? "native") === "native");
}

/* --- Deploy status derivation --- */

export type SkillDeployStatus = "deployed" | "pending" | "conflict" | "error" | "offline";

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
  conflict: { label: "Conflict", className: "st-input" },
  error: { label: "Error", className: "st-failed" },
  offline: { label: "Offline", className: "st-stopped" },
};

function badge(status: SkillDeployStatus, detail?: string): SkillDeployBadge {
  return { status, ...DEPLOY_BADGES[status], ...(detail ? { detail } : {}) };
}

/** One skill × one machine → the chip the detail pane shows.
 *
 * Precedence: an unreachable machine reports nothing trustworthy (offline); a real file in the
 * way must be surfaced over everything else the report says (conflict); an explicit error next;
 * anything not yet reconciled to the desired digest and every target linked is pending. */
export function skillDeployBadge(input: {
  runnerOnline: boolean;
  desired: Pick<RunnerDesiredSkill, "versionDigest" | "targets"> | undefined;
  reported: ReportedSkillsState | null | undefined;
  skillName: string;
}): SkillDeployBadge {
  if (!input.runnerOnline) return badge("offline");
  if (!input.desired) return badge("pending", "No assignment targets this machine yet.");
  const deployed = input.reported?.deployed?.find((entry) => entry.name === input.skillName);
  if (!deployed) {
    return input.reported?.error
      ? badge("error", input.reported.error)
      : badge("pending", "This machine has not reported this skill yet.");
  }
  const links = deployed.links ?? [];
  const conflicted = links.find((link) => link.status === "conflict");
  if (conflicted) return badge("conflict", conflicted.detail ?? `A conflicting file blocks ${conflicted.agentId}.`);
  const failed = links.find((link) => link.status === "error" || link.status === "unsupported");
  if (deployed.error || failed) return badge("error", deployed.error ?? failed?.detail);
  if (deployed.digest !== input.desired.versionDigest) {
    return badge("pending", "An older version is deployed. Sync to update it.");
  }
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
