/**
 * Orphaned edited skill copies: edited copies a machine keeps that no library skill page shows.
 * A copy is orphaned when a restore kept it aside in the runner's store (protocol v185
 * `keptAside`), or when it is a drifted copy (v183 `drift`) whose skill no longer exists in the
 * library.
 *
 * Each can be reviewed and imported, as a new version of the accessible skill with its name or as a
 * new skill when none exists, with the fences of Import Edit as New Version: the copy is read again
 * at commit and must still have the reviewed digest, and the library must not have changed since
 * the review. Each can also be discarded after explicit confirmation, and the runner deletes it
 * only while it still matches the reviewed observation. A client names a copy by the runner's
 * opaque kept-aside id, or by skill name, version digest, and variant, and never by a path.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  validSkillName,
  type SkillInvocationPolicy,
} from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { SkillImportConflictError, type ControlPlaneDb } from "./db.js";
import type { AuthPrincipal } from "./identity.js";
import type { SkillsRouteDeps } from "./skills-route.js";
import { resolveDesiredSkillSnapshot, validateSkillPayload, type ValidatedSkillPayload } from "./skills.js";
import {
  DIGEST,
  manualSource,
  readDriftCopy,
  refreshRunnerSkillState,
  restoreDriftCopy,
  runnerError,
  validReadFiles,
  type EditedCopyLock,
} from "./skill-edited-copy.js";

const KEPT_ASIDE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_PREVIEWS = 8;

export type OrphanedSkillCopyRef =
  | { kind: "kept_aside"; id: string }
  | { kind: "deleted_skill"; name: string; digest: string; variant: SkillInvocationPolicy };

/** One orphaned copy as the Skills view lists it for a machine. */
export interface OrphanedSkillCopy {
  kind: OrphanedSkillCopyRef["kind"];
  /** kept_aside: the runner's opaque store entry id. */
  id?: string;
  /** Skill name; absent only for an unidentified kept-aside copy. */
  name?: string;
  /** Version the copy was published as; absent when the runner did not record it. */
  digest?: string;
  variant?: SkillInvocationPolicy;
  keptAsideAt?: number;
  /** Content digest while the copy is readable skill content. */
  observedDigest?: string;
  /** kept_aside: the fingerprint of every entry, which a discard must name. */
  observedFingerprint?: string;
  /** deleted_skill: the runner's links still serve this copy. */
  held?: boolean;
  detail?: string;
  /** kept_aside: the accessible library skill with the copy's name, which an import updates. */
  skillId?: string;
}

/** Orphaned copies on one machine that this principal may see. A kept-aside copy of a skill the
 * principal cannot access is omitted; a drifted copy is orphaned only while no skill has its name. */
export function listOrphanedSkillCopies(db: ControlPlaneDb, principal: AuthPrincipal, runnerId: string): OrphanedSkillCopy[] {
  const state = db.getRunnerSkillState(runnerId);
  if (!state) return [];
  const copies: OrphanedSkillCopy[] = [];
  for (const copy of state.keptAside) {
    const skill = copy.name ? db.getSkillByName(copy.name) : null;
    if (skill && !db.canAccessSkill(principal, skill.id)) continue;
    copies.push({ kind: "kept_aside", ...copy, ...(skill ? { skillId: skill.id } : {}) });
  }
  for (const entry of state.drift) {
    if (db.getSkillByName(entry.name)) continue;
    copies.push({
      kind: "deleted_skill",
      name: entry.name,
      digest: entry.digest,
      variant: entry.variant,
      ...(entry.observedDigest ? { observedDigest: entry.observedDigest } : {}),
      held: entry.held,
      ...(entry.detail ? { detail: entry.detail } : {}),
    });
  }
  return copies;
}

function parseRef(body: unknown): OrphanedSkillCopyRef | null {
  const value = body as Record<string, unknown> | null;
  if (value?.kind === "kept_aside") {
    return typeof value.id === "string" && KEPT_ASIDE_ID.test(value.id) ? { kind: "kept_aside", id: value.id } : null;
  }
  if (value?.kind === "deleted_skill" && typeof value.name === "string" && validSkillName(value.name) &&
      typeof value.digest === "string" && DIGEST.test(value.digest) && (value.variant === "agent" || value.variant === "manual")) {
    return { kind: "deleted_skill", name: value.name, digest: value.digest, variant: value.variant };
  }
  return null;
}

const sameRef = (copy: OrphanedSkillCopy, ref: OrphanedSkillCopyRef) => copy.kind === ref.kind && (ref.kind === "kept_aside"
  ? copy.id === ref.id
  : copy.name === ref.name && copy.digest === ref.digest && copy.variant === ref.variant);

interface OrphanPreview {
  id: string;
  owner: string;
  runnerId: string;
  ref: OrphanedSkillCopyRef;
  name: string | null;
  /** The accessible skill the import updates; null creates a new skill. */
  skillId: string | null;
  observedDigest: string;
  /** kept_aside: the fingerprint of every entry when the copy was read for the review. */
  observedFingerprint?: string;
  payload: ValidatedSkillPayload | null;
  importBlocker?: string;
  disposition: "new" | "update" | "identical";
  expectedLatestVersionId: string | null;
  expires: number;
}

export function registerSkillOrphanRoutes(app: FastifyInstance, deps: SkillsRouteDeps, lock: EditedCopyLock): void {
  const { db, hub } = deps;
  const previews = new Map<string, OrphanPreview>();
  const purge = () => { for (const [id, preview] of previews) if (preview.expires <= Date.now()) previews.delete(id); };
  const timer = setInterval(purge, 60_000); timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); previews.clear(); });

  const authorize = (req: FastifyRequest, reply: FastifyReply, runnerId: string) => {
    const principal = deps.requestHuman(req);
    if (!principal || !["owner", "admin"].includes(principal.role)) {
      reply.code(403).send({ error: "An owner or administrator must resolve an orphaned skill copy." });
      return null;
    }
    if (!db.canAccessRunner(principal, runnerId)) {
      reply.code(404).send({ error: "Machine not found." });
      return null;
    }
    return principal;
  };
  const ownerKey = (principal: NonNullable<ReturnType<typeof authorize>>) => `${principal.organizationId}:${principal.userId}`;
  const available = (runnerId: string, kind: OrphanedSkillCopyRef["kind"], reply: FastifyReply) => {
    const runner = db.getRunner(runnerId);
    if (!runner || !hub.isRunnerOnline(runnerId)) {
      reply.code(409).send({ error: "Machine is offline." });
      return false;
    }
    const capability = kind === "kept_aside" ? "skillKeptAsideCopies" : "skillDrift";
    if (!runnerSupportsProtocol(runner.protocolVersion, capability)) {
      reply.code(409).send({ error: runnerCapabilityRequirement(runner.protocolVersion, capability, "Orphaned skill copy resolution") });
      return false;
    }
    return true;
  };
  /** Authority is rechecked after every runner await before any machine or library data is returned. */
  const stillAuthorized = (req: FastifyRequest, reply: FastifyReply, runnerId: string, owner: string, skillId: string | null) => {
    const current = authorize(req, reply, runnerId);
    if (!current) return null;
    if (ownerKey(current) !== owner || (skillId !== null && !db.canAccessSkill(current, skillId))) {
      reply.code(404).send({ error: "Skill not found." });
      return null;
    }
    return current;
  };
  const readKeptAside = async (runnerId: string, id: string) => {
    const requestId = randomUUID();
    const result = await hub.requestFromRunner(runnerId, requestId, {
      type: "skill_kept_aside", runnerId, requestId, operation: "read", id,
    });
    if (result.type !== "skill_kept_aside_result" || result.runnerId !== runnerId || result.requestId !== requestId) {
      throw new Error("unexpected runner reply");
    }
    if (result.status === "read") {
      if (typeof result.observedDigest !== "string" || !DIGEST.test(result.observedDigest) ||
          typeof result.observedFingerprint !== "string" || !DIGEST.test(result.observedFingerprint) ||
          !validReadFiles(result.files) || skillVersionDigest(result.files) !== result.observedDigest) {
        throw new Error("invalid runner read");
      }
      return { status: "read" as const, observedDigest: result.observedDigest, observedFingerprint: result.observedFingerprint, files: result.files };
    }
    if (result.status === "not_found") return { status: "gone" as const };
    if (result.status === "rejected") return { status: "rejected" as const, error: runnerError(result.error) };
    throw new Error("unexpected runner reply");
  };
  /** The fingerprint covers every entry; the digest, present for a readable copy, ties it to the reviewed content. */
  const discardKeptAside = async (runnerId: string, id: string, observation: { observedFingerprint: string; observedDigest?: string }) => {
    const requestId = randomUUID();
    const result = await hub.requestFromRunner(runnerId, requestId, {
      type: "skill_kept_aside", runnerId, requestId, operation: "discard", id, ...observation, confirmation: "explicit",
    });
    if (result.type !== "skill_kept_aside_result" || result.runnerId !== runnerId || result.requestId !== requestId ||
        !["discarded", "not_found", "rejected"].includes(result.status)) throw new Error("unexpected runner reply");
    return result.status === "rejected"
      ? { status: "rejected" as const, error: runnerError(result.error) }
      : { status: result.status as "discarded" | "not_found" };
  };
  const readOnRunner = (runnerId: string, ref: OrphanedSkillCopyRef) => ref.kind === "kept_aside"
    ? readKeptAside(runnerId, ref.id)
    : readDriftCopy(hub, runnerId, ref).then((result) => result.status === "not_needed" ? { status: "clean" as const } : result);

  app.post("/api/runners/:id/orphaned-skill-copies/preview", async (req, reply) => {
    purge();
    const runnerId = (req.params as { id: string }).id;
    const principal = authorize(req, reply, runnerId);
    if (!principal) return;
    const ref = parseRef(req.body);
    if (!ref) return reply.code(400).send({ error: "Select one reported orphaned skill copy." });
    const copy = listOrphanedSkillCopies(db, principal, runnerId).find((candidate) => sameRef(candidate, ref));
    if (!copy) return reply.code(409).send({ error: "This machine no longer reports that copy as orphaned. Sync it to refresh its state." });
    if (!available(runnerId, ref.kind, reply)) return;
    if (!copy.observedDigest) {
      return reply.code(409).send({ error: "The copy is not valid skill content, so it cannot be reviewed or imported. It can still be discarded." });
    }
    if (lock.pending) return reply.code(429).send({ error: "Another edited-copy operation is in progress." });
    for (const [id, preview] of previews) if (preview.owner === ownerKey(principal)) previews.delete(id);
    if (previews.size >= MAX_PREVIEWS) return reply.code(429).send({ error: "Too many orphaned-copy reviews are open. Try again shortly." });
    const name = copy.name ?? null;
    const skillId = copy.skillId ?? null;
    lock.pending = true;
    try {
      const result = await readOnRunner(runnerId, ref);
      if (!stillAuthorized(req, reply, runnerId, ownerKey(principal), skillId)) return;
      if (result.status === "gone") return reply.code(409).send({ error: "The machine no longer has this copy. Sync it to refresh its state." });
      if (result.status === "clean") {
        return reply.code(409).send({ error: "The copy matches the version it was published as again. Sync the machine to refresh its state." });
      }
      if (result.status === "rejected") return reply.code(409).send({ error: result.error });
      const observedDigest = result.observedDigest;
      const variant = ref.kind === "kept_aside" ? copy.variant : ref.variant;
      const source = variant === "manual" ? manualSource(result.files, observedDigest) : result.files;
      const validated = source && name ? validateSkillPayload({ name, files: source }) : null;
      const importBlocker = !source
        ? "The copy's Manual Only frontmatter line was edited, so the skill cannot be separated from the deployment transform."
        : !name ? "The copy's SKILL.md does not name a valid skill, so it cannot be imported."
        : validated && !validated.ok ? `The copy is not a valid library skill: ${validated.error}.` : undefined;
      const payload = validated?.ok ? validated : null;
      const skill = skillId ? db.getSkill(skillId) : null;
      if (ref.kind === "deleted_skill" && name && db.getSkillByName(name)) {
        return reply.code(409).send({ error: "A library skill with this name exists again. Resolve the copy from that skill's Deployment section." });
      }
      const latest = skill?.latestVersion ? db.getSkillVersion(skill.latestVersion.id) : null;
      const disposition = !skill ? "new" : payload && latest?.digest === payload.digest ? "identical" : "update";
      const preview: OrphanPreview = {
        id: randomUUID(), owner: ownerKey(principal), runnerId, ref, name, skillId, observedDigest, payload,
        ...("observedFingerprint" in result ? { observedFingerprint: result.observedFingerprint } : {}),
        ...(importBlocker ? { importBlocker } : {}),
        disposition,
        expectedLatestVersionId: skill ? skill.latestVersion?.id ?? null : null,
        expires: Date.now() + PREVIEW_TTL_MS,
      };
      previews.set(preview.id, preview);
      return {
        previewId: preview.id,
        copy: { ...ref, observedDigest },
        name,
        files: source ?? result.files,
        previousFiles: latest?.files ?? [],
        digest: payload?.digest ?? null,
        importable: !!payload,
        ...(importBlocker ? { importBlocker } : {}),
        disposition,
        assignmentCount: skill?.assignmentCount ?? 0,
      };
    } catch {
      return reply.code(502).send({ error: "The copy could not be read or failed validation. Sync the machine and try again." });
    } finally { lock.pending = false; }
  });

  app.post("/api/orphaned-skill-copies/:id/import", async (req, reply) => {
    purge();
    const preview = previews.get((req.params as { id: string }).id);
    if (!preview) return reply.code(404).send({ error: "Review expired. Review the copy again." });
    const principal = authorize(req, reply, preview.runnerId);
    if (!principal) return;
    if (ownerKey(principal) !== preview.owner) return reply.code(404).send({ error: "Review not found." });
    if (preview.skillId && !db.canAccessSkill(principal, preview.skillId)) return reply.code(404).send({ error: "Skill not found." });
    if (!preview.payload) return reply.code(409).send({ error: preview.importBlocker ?? "This copy cannot be imported." });
    const payload = preview.payload;
    if (preview.disposition === "update" && (req.body as { acceptUpdate?: unknown } | null)?.acceptUpdate !== true) {
      return reply.code(409).send({ error: "Accept the version diff before updating existing assignments." });
    }
    // Commit only what the machine still holds, exactly as reviewed.
    if (!available(preview.runnerId, preview.ref.kind, reply)) return;
    if (lock.pending) return reply.code(429).send({ error: "Another edited-copy operation is in progress." });
    lock.pending = true;
    let current: Awaited<ReturnType<typeof readOnRunner>>;
    try {
      current = await readOnRunner(preview.runnerId, preview.ref);
    } catch {
      return reply.code(502).send({ error: "The copy could not be read again. Sync the machine and review it again." });
    } finally { lock.pending = false; }
    if (!stillAuthorized(req, reply, preview.runnerId, preview.owner, preview.skillId)) return;
    if (previews.get(preview.id) !== preview) return reply.code(409).send({ error: "The review changed or expired. Review the copy again." });
    if (current.status !== "read" || current.observedDigest !== preview.observedDigest) {
      previews.delete(preview.id);
      return reply.code(409).send({ error: "The copy changed after you reviewed it. Review it again before importing." });
    }
    const { ref } = preview;
    let skill;
    try {
      skill = db.importMachineSkill({
        ...payload,
        note: ref.kind === "kept_aside"
          ? `Imported a kept-aside edited copy from machine ${preview.runnerId}.`
          : `Imported an edited copy of ${ref.digest.slice(0, 12)}, kept on machine ${preview.runnerId} after the skill was deleted.`,
        source: {
          runnerId: preview.runnerId,
          ...(ref.kind === "kept_aside"
            ? { sourceDirectory: "skills/store", name: `.drift-${ref.id}` }
            : { sourceDirectory: ref.variant === "manual" ? ".claude/skills" : ".agents/skills", name: ref.name }),
          digest: payload.digest,
          importedAt: Date.now(),
        },
        scope: { organizationId: principal.organizationId, owner: { kind: "organization", organizationId: principal.organizationId } },
        expectedVersionId: preview.expectedLatestVersionId,
      });
    } catch (error) {
      if (error instanceof SkillImportConflictError) return reply.code(409).send({ error: error.message });
      return reply.code(500).send({ error: "Importing the copy failed." });
    }
    previews.delete(preview.id);
    if (preview.disposition === "update") {
      for (const runner of db.listRunners()) if (runner.runnerId !== preview.runnerId) deps.pushSkillsSync(runner.runnerId);
    }
    // The library now holds exactly these bytes, so the machine's copy is released under the same
    // reviewed-observation fence a discard uses. A drifted copy the machine deploys again is instead
    // captured by reconciliation with no visible change.
    const deployedHere = ref.kind === "deleted_skill" && resolveDesiredSkillSnapshot(db, preview.runnerId)
      .some((entry) => entry.name === payload.name && entry.versionDigest === payload.digest);
    let released = false;
    let warning: string | undefined;
    if (!deployedHere) {
      if (lock.pending || !hub.isRunnerOnline(preview.runnerId)) {
        warning = "The copy was imported, but the machine did not release it. Discard it from Orphaned Copies.";
      } else {
        lock.pending = true;
        try {
          // The release names the observation of the review: a copy whose other entries changed since
          // is kept, and the warning says so.
          const result = ref.kind === "kept_aside"
            ? await discardKeptAside(preview.runnerId, ref.id,
              { observedDigest: preview.observedDigest, observedFingerprint: preview.observedFingerprint ?? "" })
            : await restoreDriftCopy(hub, preview.runnerId, ref, preview.observedDigest);
          released = result.status !== "rejected";
          if (result.status === "rejected") warning = `The copy was imported, but the machine kept it: ${result.error}`;
        } catch {
          warning = "The copy was imported, but the machine did not confirm releasing it. Sync it to check.";
        } finally { lock.pending = false; }
      }
    }
    const state = await refreshRunnerSkillState(deps, preview.runnerId);
    // The import is committed either way; only return data the caller may still see.
    if (!stillAuthorized(req, reply, preview.runnerId, preview.owner, skill.id)) return;
    return { skill, released, ...(warning ? { warning } : {}), state };
  });

  app.delete("/api/orphaned-skill-copies/:id", async (req, reply) => {
    const principal = deps.requestHuman(req);
    const id = (req.params as { id: string }).id;
    const preview = previews.get(id);
    if (principal && preview && preview.owner === `${principal.organizationId}:${principal.userId}`) previews.delete(id);
    return reply.code(204).send();
  });

  app.post("/api/runners/:id/orphaned-skill-copies/discard", async (req, reply) => {
    const runnerId = (req.params as { id: string }).id;
    const principal = authorize(req, reply, runnerId);
    if (!principal) return;
    const body = req.body as { observedDigest?: unknown; observedFingerprint?: unknown; confirmation?: unknown } | null;
    const ref = parseRef(body);
    const digest = body?.observedDigest;
    const fingerprint = body?.observedFingerprint;
    const validObservation = ref?.kind === "kept_aside"
      ? typeof fingerprint === "string" && DIGEST.test(fingerprint) &&
        (digest === undefined || (typeof digest === "string" && DIGEST.test(digest)))
      : fingerprint === undefined && (digest === null || (typeof digest === "string" && DIGEST.test(digest)));
    if (!ref || body?.confirmation !== "explicit" || !validObservation) {
      return reply.code(400).send({ error: "Select one reported orphaned copy and explicitly confirm discarding it." });
    }
    const copy = listOrphanedSkillCopies(db, principal, runnerId).find((candidate) => sameRef(candidate, ref));
    if (!copy) return reply.code(409).send({ error: "This machine no longer reports that copy as orphaned. Sync it to refresh its state." });
    if (ref.kind === "kept_aside" && !copy.observedFingerprint) {
      return reply.code(409).send({ error: copy.observedDigest
        ? "The copy changed while the machine reported it. Sync the machine and review it again."
        : "This copy is too large to verify, so it can only be removed on the machine itself." });
    }
    if ((copy.observedDigest ?? null) !== (digest ?? null) || (copy.observedFingerprint ?? null) !== (fingerprint ?? null)) {
      return reply.code(409).send({ error: "The copy changed after you reviewed it. Review it again before discarding it." });
    }
    if (!available(runnerId, ref.kind, reply)) return;
    if (lock.pending) return reply.code(429).send({ error: "Another edited-copy operation is in progress." });
    lock.pending = true;
    let status: "discarded" | "kept_aside" | "not_needed" | "gone";
    try {
      if (ref.kind === "kept_aside") {
        const result = await discardKeptAside(runnerId, ref.id,
          { observedFingerprint: fingerprint as string, ...(typeof digest === "string" ? { observedDigest: digest } : {}) });
        if (!stillAuthorized(req, reply, runnerId, ownerKey(principal), copy.skillId ?? null)) return;
        if (result.status === "rejected") return reply.code(409).send({ error: result.error });
        status = result.status === "not_found" ? "gone" : "discarded";
      } else {
        // Without library files the runner discards the copy; one reviewed as unreadable has no
        // content fence, so the runner keeps it aside instead, where it is listed again.
        const result = await restoreDriftCopy(hub, runnerId, ref, digest as string | null);
        if (!stillAuthorized(req, reply, runnerId, ownerKey(principal), null)) return;
        if (result.status === "rejected") return reply.code(409).send({ error: result.error });
        status = result.status === "not_needed" ? "not_needed" : digest === null ? "kept_aside" : "discarded";
      }
    } catch {
      return reply.code(502).send({ error: "The machine did not confirm discarding the copy. Sync it and review the copy again." });
    } finally { lock.pending = false; }
    const state = await refreshRunnerSkillState(deps, runnerId);
    if (!stillAuthorized(req, reply, runnerId, ownerKey(principal), copy.skillId ?? null)) return;
    return { status, state };
  });
}
