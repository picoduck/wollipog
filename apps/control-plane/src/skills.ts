/**
 * Pure logic for managed agent skills: payload validation for the library routes and the
 * per-machine desired-state resolution the control plane pushes to runners (skills_sync).
 */

import { createHash } from "node:crypto";
import {
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  validSkillFilePath,
  validSkillName,
  type AgentDefinition,
  type SkillFile,
  type SkillInvocationPolicy,
  type SkillsSyncMessage,
  type SkillSyncEntry,
  type SkillSyncTarget,
} from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import type { ControlPlaneDb, SkillAgentSelector, SkillAssignmentView } from "./db.js";

/* ------------------------------ Frontmatter ------------------------------ */

// Deliberately non-YAML, mirroring the runner's parseClaudeCommandMetadata stance: a bounded
// line-based `key: value` reader for exactly the two keys the control plane needs. Anything a
// YAML parser would accept beyond that is treated as opaque body text.
const FRONTMATTER_MAX_BYTES = 16 * 1024;
const FRONTMATTER_MAX_LINES = 128;
const FRONTMATTER_VALUE_MAX_CHARS = 280;

/** Read `name:` / `description:` from a SKILL.md frontmatter block, bounded and best-effort. */
export function readSkillFrontmatter(content: string): { name?: string; description?: string } {
  const bounded = Buffer.from(content, "utf8")
    .subarray(0, FRONTMATTER_MAX_BYTES)
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  const lines = bounded.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const values: { name?: string; description?: string } = {};
  for (let index = 1; index < lines.length && index <= FRONTMATTER_MAX_LINES; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "---" || line.trim() === "...") return values;
    const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1).trim();
    }
    if (value) values[match[1] as "name" | "description"] = value.slice(0, FRONTMATTER_VALUE_MAX_CHARS);
  }
  // An unterminated frontmatter block is ordinary body text, not partially trusted metadata.
  return {};
}

/* ------------------------------- Validation ------------------------------ */

export interface ValidatedSkillPayload {
  ok: true;
  name: string;
  /** Explicit description, else the SKILL.md frontmatter description, else null. */
  description: string | null;
  files: SkillFile[];
  /** Canonical manifest JSON (`{"files":[{"path","sha256","size"},...]}`, sorted by path). */
  manifest: string;
  digest: string;
}

export type SkillPayloadValidation = ValidatedSkillPayload | { ok: false; error: string };

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodedBytes(file: SkillFile): Buffer | null {
  if (file.encoding === "base64") {
    const compact = file.content.replace(/\s+/g, "");
    if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) return null;
    return Buffer.from(compact, "base64");
  }
  return Buffer.from(file.content, "utf8");
}

/** Validate a create/version payload into normalized files plus their canonical manifest and
 * digest. Rejections carry a caller-safe message for a 400 response. */
export function validateSkillPayload(input: {
  name: unknown;
  description?: unknown;
  files: unknown;
}): SkillPayloadValidation {
  if (typeof input.name !== "string" || !validSkillName(input.name)) {
    return { ok: false, error: "name must be a lowercase directory-safe token (a-z, 0-9, ., _, -; max 64 characters)" };
  }
  const name = input.name;
  if (input.description !== undefined && input.description !== null && typeof input.description !== "string") {
    return { ok: false, error: "description must be a string" };
  }
  const explicitDescription = typeof input.description === "string" ? input.description.trim() : "";
  if (explicitDescription.length > 1024) {
    return { ok: false, error: "description must be 1024 characters or fewer" };
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    return { ok: false, error: "files must be a non-empty array" };
  }
  if (input.files.length > SKILL_MAX_FILES) {
    return { ok: false, error: `a skill may contain at most ${SKILL_MAX_FILES} files` };
  }
  const files: SkillFile[] = [];
  const seenPaths = new Set<string>();
  const manifestEntries: Array<{ path: string; sha256: string; size: number }> = [];
  let totalBytes = 0;
  let skillMd: Buffer | null = null;
  for (const candidate of input.files as unknown[]) {
    const record = candidate as Partial<SkillFile> | null;
    if (!record || typeof record !== "object" || typeof record.path !== "string" ||
        typeof record.content !== "string" || (record.encoding !== "utf8" && record.encoding !== "base64")) {
      return { ok: false, error: "each file needs a path, content, and a utf8 or base64 encoding" };
    }
    if (!validSkillFilePath(record.path)) {
      return { ok: false, error: `invalid file path: ${record.path.slice(0, 120)}` };
    }
    if (seenPaths.has(record.path)) {
      return { ok: false, error: `duplicate file path: ${record.path}` };
    }
    seenPaths.add(record.path);
    const file: SkillFile = { path: record.path, content: record.content, encoding: record.encoding };
    const bytes = decodedBytes(file);
    if (!bytes) return { ok: false, error: `file is not valid base64: ${record.path}` };
    if (bytes.length > SKILL_MAX_FILE_BYTES) {
      return { ok: false, error: `file exceeds ${SKILL_MAX_FILE_BYTES} bytes: ${record.path}` };
    }
    totalBytes += bytes.length;
    if (totalBytes > SKILL_MAX_TOTAL_BYTES) {
      return { ok: false, error: `skill exceeds ${SKILL_MAX_TOTAL_BYTES} bytes in total` };
    }
    files.push(file);
    manifestEntries.push({
      path: file.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
    if (file.path === "SKILL.md") skillMd = bytes;
  }
  if (!skillMd) return { ok: false, error: "a top-level SKILL.md is required" };
  const frontmatter = readSkillFrontmatter(skillMd.toString("utf8"));
  if (frontmatter.name !== name) {
    return { ok: false, error: "SKILL.md frontmatter name must equal the skill name" };
  }
  manifestEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    ok: true,
    name,
    description: explicitDescription || frontmatter.description || null,
    files,
    manifest: JSON.stringify({ files: manifestEntries }),
    digest: skillVersionDigest(files),
  };
}

/** Parse an assignment's agent selector from an untrusted request body. */
export function parseSkillAgentSelector(value: unknown): SkillAgentSelector | null {
  const record = value as Partial<Record<string, unknown>> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.kind === "all" && Object.keys(record).length === 1) return { kind: "all" };
  if (record.kind === "driver" && Object.keys(record).length === 2 &&
      (record.driver === "acp" || record.driver === "claude-code" ||
        record.driver === "codex" || record.driver === "codex-app-server")) {
    return { kind: "driver", driver: record.driver };
  }
  if (record.kind === "agent" && Object.keys(record).length === 2 &&
      typeof record.agentId === "string" && record.agentId.length > 0 && record.agentId.length <= 256) {
    return { kind: "agent", agentId: record.agentId };
  }
  return null;
}

/* --------------------------- Desired-state resolution --------------------------- */

/** Drivers whose harness skill directories the runner knows how to link in MVP. */
const SKILL_TARGET_DRIVERS = new Set<string>(["claude-code", "codex", "codex-app-server"]);

function agentEligibleForSkills(agent: AgentDefinition): boolean {
  return SKILL_TARGET_DRIVERS.has(agent.driver ?? "acp") && (agent.context?.kind ?? "native") === "native";
}

function selectorMatchesAgent(selector: SkillAgentSelector, agent: AgentDefinition): boolean {
  if (selector.kind === "all") return true;
  if (selector.kind === "driver") return (agent.driver ?? "acp") === selector.driver;
  return agent.id === selector.agentId;
}

/** runner scope beats instance scope; within a scope agent beats driver beats all. */
function assignmentRank(assignment: SkillAssignmentView): number {
  const scope = assignment.scopeKind === "runner" ? 10 : 0;
  const specificity = assignment.agentSelector.kind === "agent" ? 3
    : assignment.agentSelector.kind === "driver" ? 2 : 1;
  return scope + specificity;
}

/**
 * Resolve the complete desired skill set for one machine — the payload of a skills_sync.
 *
 * For each (skill, agent) pair the single winning assignment decides: a runner-scoped assignment
 * overrides an instance-scoped one, and within a scope an `agent` selector overrides `driver`
 * overrides `all`. A winning assignment with enabled=false removes the skill for exactly the
 * agents it matches (the skill itself stays desired for the machine while any enabled machine-wide
 * assignment still matches, so the canonical ~/.agents/skills link survives). Only native-context
 * claude-code / codex / codex-app-server agents ever become link targets.
 */
export function resolveDesiredSkills(db: ControlPlaneDb, runnerId: string): SkillSyncEntry[] {
  const runner = db.getRunner(runnerId);
  if (!runner) return [];
  const eligibleAgents = runner.agents.filter(agentEligibleForSkills);
  const bySkill = new Map<string, SkillAssignmentView[]>();
  for (const assignment of db.listSkillAssignmentsForRunner(runnerId)) {
    const list = bySkill.get(assignment.skillId) ?? [];
    list.push(assignment);
    bySkill.set(assignment.skillId, list);
  }
  const entries: SkillSyncEntry[] = [];
  for (const [skillId, assignments] of bySkill) {
    const skill = db.getSkill(skillId);
    if (!skill?.latestVersion) continue;
    const version = db.getSkillVersion(skill.latestVersion.id);
    if (!version) continue;
    const targets: SkillSyncTarget[] = [];
    for (const agent of eligibleAgents) {
      const winner = assignments
        .filter((assignment) => selectorMatchesAgent(assignment.agentSelector, agent))
        .sort((a, b) => assignmentRank(b) - assignmentRank(a) || b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))[0];
      if (winner?.enabled) {
        targets.push({ agentId: agent.id, invocation: winner.invocation as SkillInvocationPolicy });
      }
    }
    // Enabled machine-wide assignments keep the skill desired even when every per-agent winner is
    // a disabled override or no eligible agent matches; agent/driver-selector assignments only
    // make the skill desired through an actual target.
    const desired = targets.length > 0 ||
      assignments.some((assignment) => assignment.enabled && assignment.agentSelector.kind === "all");
    if (!desired) continue;
    entries.push({
      name: skill.name,
      versionDigest: version.digest,
      files: version.files,
      targets,
    });
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Upper bound for one assembled skills_sync frame. Per-skill payloads are individually capped
 * (SKILL_MAX_TOTAL_BYTES), but enough max-size skills assigned to one machine could otherwise
 * exceed the runner websocket frame limit and close the connection on a routine push. Senders
 * fail closed at this budget — a truncated authoritative list would make the runner delete
 * deployed skills. Chunked delivery is the future fix if real libraries ever approach this.
 */
export const SKILLS_SYNC_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** JSON-encoded size of an outgoing skills_sync, as it would go over the wire. */
export function skillsSyncMessageBytes(message: SkillsSyncMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}
