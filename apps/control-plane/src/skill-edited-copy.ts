/**
 * Runner operations and checks shared by the routes that resolve edited skill copies: drifted
 * copies (protocol v183) and orphaned copies (kept aside by a restore, or left by a deleted skill).
 */

import { randomUUID } from "node:crypto";
import { SKILL_MAX_FILES, validSkillFilePath, type SkillFile, type SkillInvocationPolicy } from "@wollipog/protocol";
import { manualInvocationVariantFiles, withoutManualInvocationFrontmatter } from "@wollipog/protocol/skill-invocation";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import type { RunnerSkillStateRecord } from "./db.js";
import type { SkillsRouteDeps } from "./skills-route.js";

export const DIGEST = /^[0-9a-f]{64}$/;

export interface DriftTarget { name: string; digest: string; variant: SkillInvocationPolicy }

/** One edited-copy runner operation at a time, shared by the drift and orphaned-copy routes. */
export interface EditedCopyLock { pending: boolean }

export function runnerError(value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim().slice(0, 300)
    : "The machine refused the request.";
}

export function validReadFiles(value: unknown): value is SkillFile[] {
  return Array.isArray(value) && value.length <= SKILL_MAX_FILES && value.every((file) =>
    file && typeof file === "object" && typeof (file as SkillFile).path === "string" &&
    validSkillFilePath((file as SkillFile).path) && typeof (file as SkillFile).content === "string" &&
    ((file as SkillFile).encoding === "utf8" || (file as SkillFile).encoding === "base64"));
}

/** Source files for a Manual Only copy: remove exactly the injected frontmatter line, and prove the
 * runner would publish those source files as the identical observed copy. */
export function manualSource(files: SkillFile[], observedDigest: string): SkillFile[] | null {
  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!skillMd) return null;
  const source = withoutManualInvocationFrontmatter(Buffer.from(skillMd.content, skillMd.encoding).toString("utf8"));
  if (source === null) return null;
  const sourceFiles = files.map((file) => file === skillMd ? { path: file.path, content: source, encoding: "utf8" as const } : file);
  return skillVersionDigest(manualInvocationVariantFiles(sourceFiles)) === observedDigest ? sourceFiles : null;
}

/** Read a reported drifted copy on the runner; the result's digest is recomputed from its files. */
export async function readDriftCopy(hub: SkillsRouteDeps["hub"], runnerId: string, target: DriftTarget) {
  const requestId = randomUUID();
  const result = await hub.requestFromRunner(runnerId, requestId, {
    type: "skill_drift", runnerId, requestId, operation: "read", ...target,
  });
  if (result.type !== "skill_drift_result" || result.runnerId !== runnerId || result.requestId !== requestId) {
    throw new Error("unexpected runner reply");
  }
  if (result.status === "read") {
    if (typeof result.observedDigest !== "string" || !DIGEST.test(result.observedDigest) ||
        !validReadFiles(result.files) || skillVersionDigest(result.files) !== result.observedDigest) {
      throw new Error("invalid runner read");
    }
    return { status: "read" as const, observedDigest: result.observedDigest, files: result.files };
  }
  if (result.status === "not_needed") return { status: "not_needed" as const };
  if (result.status === "rejected") return { status: "rejected" as const, error: runnerError(result.error) };
  throw new Error("unexpected runner reply");
}

/** Confirmed, observation-fenced restore of a drifted copy; without `files` the copy is discarded. */
export async function restoreDriftCopy(
  hub: SkillsRouteDeps["hub"],
  runnerId: string,
  target: DriftTarget,
  observedDigest: string | null,
  files?: SkillFile[],
) {
  const requestId = randomUUID();
  const result = await hub.requestFromRunner(runnerId, requestId, {
    type: "skill_drift", runnerId, requestId, operation: "restore", ...target, observedDigest,
    ...(files ? { files } : {}), confirmation: "explicit",
  });
  if (result.type !== "skill_drift_result" || result.runnerId !== runnerId || result.requestId !== requestId ||
      !["restored", "not_needed", "rejected"].includes(result.status)) throw new Error("unexpected runner reply");
  return result.status === "rejected"
    ? { status: "rejected" as const, error: runnerError(result.error) }
    : { status: result.status as "restored" | "not_needed" };
}

export type SkillStateResponse = Omit<RunnerSkillStateRecord, "keptAside">;

/** A machine's skill state as API responses carry it. Kept-aside copies are left out: a client sees
 * them only through the orphaned-copy list, which omits copies of skills it cannot access. */
export function skillStateResponse(state: RunnerSkillStateRecord | null): SkillStateResponse | null {
  if (!state) return null;
  const { keptAside: _listedSeparately, ...response } = state;
  return response;
}

/** Refresh one machine's authoritative state so the caller sees a resolved copy. */
export async function refreshRunnerSkillState(deps: SkillsRouteDeps, runnerId: string): Promise<SkillStateResponse | null> {
  try {
    const requestId = `skills_${randomUUID().slice(0, 8)}`;
    const result = await deps.pushSkillsSync.request(runnerId, requestId);
    if (result.type === "skills_state") deps.db.setRunnerSkillState(runnerId, result, Date.now());
  } catch {
    // The runner still reports converged state on its own; the caller can refresh later.
  }
  return skillStateResponse(deps.db.getRunnerSkillState(runnerId));
}
