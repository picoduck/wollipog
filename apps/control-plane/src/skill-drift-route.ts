/**
 * Resolution of hand-edited deployed skill copies (protocol v183 drift).
 *
 * Import Edit as New Version reads the drifted store copy from the runner, shows it as an ordinary
 * library update preview, and commits exactly the reviewed bytes. Restore Library Version sends a
 * confirmed, observation-fenced restore to the runner. Neither route follows a path supplied by a
 * client: a copy is named only by skill name, version digest, and variant, and must be the one the
 * runner currently reports.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  validSkillName,
  type SkillDriftState,
  type SkillFile,
} from "@wollipog/protocol";
import { SkillImportConflictError } from "./db.js";
import type { SkillsRouteDeps } from "./skills-route.js";
import { resolveDesiredSkillSnapshot, validateSkillPayload, type ValidatedSkillPayload } from "./skills.js";
import {
  DIGEST,
  manualSource,
  readDriftCopy,
  refreshRunnerSkillState,
  restoreDriftCopy,
  type DriftTarget,
  type EditedCopyLock,
} from "./skill-edited-copy.js";
import { registerSkillOrphanRoutes } from "./skill-orphan-route.js";

const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_PREVIEWS = 8;

interface DriftPreview {
  id: string;
  owner: string;
  runnerId: string;
  skillId: string;
  target: DriftTarget;
  observedDigest: string;
  payload: ValidatedSkillPayload | null;
  importBlocker?: string;
  expectedLatestVersionId: string | null;
  expectedPinRevision: string | null;
  expires: number;
}

function parseTarget(body: unknown): DriftTarget | null {
  const value = body as Partial<Record<keyof DriftTarget, unknown>> | null;
  return value && typeof value.name === "string" && validSkillName(value.name) &&
    typeof value.digest === "string" && DIGEST.test(value.digest) &&
    (value.variant === "agent" || value.variant === "manual")
    ? { name: value.name, digest: value.digest, variant: value.variant }
    : null;
}

export function registerSkillDriftRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  const { db, hub } = deps;
  const previews = new Map<string, DriftPreview>();
  const lock: EditedCopyLock = { pending: false };
  const purge = () => { for (const [id, preview] of previews) if (preview.expires <= Date.now()) previews.delete(id); };
  const timer = setInterval(purge, 60_000); timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); previews.clear(); });

  const authorize = (req: FastifyRequest, reply: FastifyReply, runnerId: string) => {
    const principal = deps.requestHuman(req);
    if (!principal || !["owner", "admin"].includes(principal.role)) {
      reply.code(403).send({ error: "An owner or administrator must resolve an edited skill copy." });
      return null;
    }
    if (!db.canAccessRunner(principal, runnerId)) {
      reply.code(404).send({ error: "Machine not found." });
      return null;
    }
    return principal;
  };
  const ownerKey = (principal: NonNullable<ReturnType<typeof authorize>>) => `${principal.organizationId}:${principal.userId}`;
  const accessibleSkill = (principal: NonNullable<ReturnType<typeof authorize>>, name: string) => {
    const skill = db.getSkillByName(name);
    return skill && db.canAccessSkill(principal, skill.id) ? skill : null;
  };
  const available = (runnerId: string, reply: FastifyReply) => {
    const runner = db.getRunner(runnerId);
    if (!runner || !hub.isRunnerOnline(runnerId)) {
      reply.code(409).send({ error: "Machine is offline." });
      return false;
    }
    if (!runnerSupportsProtocol(runner.protocolVersion, "skillDrift")) {
      reply.code(409).send({ error: runnerCapabilityRequirement(runner.protocolVersion, "skillDrift", "Edited skill copy resolution") });
      return false;
    }
    return true;
  };
  const reported = (runnerId: string, target: DriftTarget): SkillDriftState | undefined =>
    db.getRunnerSkillState(runnerId)?.drift.find((entry) => entry.name === target.name &&
      entry.digest === target.digest && entry.variant === target.variant);
  const refreshState = (runnerId: string) => refreshRunnerSkillState(deps, runnerId);
  /** Authority is rechecked after every runner await before any machine or library data is returned. */
  const stillAuthorized = (req: FastifyRequest, reply: FastifyReply, runnerId: string, owner: string, skillId: string) => {
    const current = authorize(req, reply, runnerId);
    if (!current) return null;
    if (ownerKey(current) !== owner || accessibleSkill(current, db.getSkill(skillId)?.name ?? "")?.id !== skillId) {
      reply.code(404).send({ error: "Skill not found." });
      return null;
    }
    return current;
  };
  const readOnRunner = (runnerId: string, target: DriftTarget) => readDriftCopy(hub, runnerId, target);
  const restoreOnRunner = (runnerId: string, target: DriftTarget, observedDigest: string | null, files?: SkillFile[]) =>
    restoreDriftCopy(hub, runnerId, target, observedDigest, files);

  app.post("/api/runners/:id/skill-drift/preview", async (req, reply) => {
    purge();
    const runnerId = (req.params as { id: string }).id;
    const principal = authorize(req, reply, runnerId);
    if (!principal) return;
    const target = parseTarget(req.body);
    if (!target) return reply.code(400).send({ error: "Select one reported edited skill copy." });
    const skill = accessibleSkill(principal, target.name);
    if (!skill) return reply.code(404).send({ error: "Skill not found." });
    if (!available(runnerId, reply)) return;
    const drift = reported(runnerId, target);
    if (!drift) return reply.code(409).send({ error: "This machine no longer reports that edited copy. Sync it to refresh its state." });
    if (!drift.observedDigest) {
      return reply.code(409).send({ error: "The edited copy is no longer valid skill content, so it cannot be imported. Restore the library version instead." });
    }
    if (lock.pending) return reply.code(429).send({ error: "Another edited-copy operation is in progress." });
    for (const [id, preview] of previews) if (preview.owner === ownerKey(principal)) previews.delete(id);
    if (previews.size >= MAX_PREVIEWS) return reply.code(429).send({ error: "Too many edited-copy reviews are open. Try again shortly." });
    lock.pending = true;
    try {
      const result = await readOnRunner(runnerId, target);
      if (!stillAuthorized(req, reply, runnerId, ownerKey(principal), skill.id)) return;
      if (result.status === "not_needed") {
        return reply.code(409).send({ error: "The copy matches its library version again. Sync the machine to refresh its state." });
      }
      if (result.status === "rejected") return reply.code(409).send({ error: result.error });
      const observedDigest = result.observedDigest;
      const source = target.variant === "manual" ? manualSource(result.files, observedDigest) : result.files;
      const validated = source ? validateSkillPayload({ name: target.name, files: source }) : null;
      const importBlocker = !source
        ? "The edit changed the Manual Only frontmatter line, so it cannot be separated from the deployment transform. Restore the library version, then make the edit in the library."
        : validated && !validated.ok ? `The edited copy is not a valid library skill: ${validated.error}.` : undefined;
      const payload = validated?.ok ? validated : null;
      const latest = skill.latestVersion ? db.getSkillVersion(skill.latestVersion.id) : null;
      const pin = db.getMachineSkillVersion(skill.id, runnerId);
      const preview: DriftPreview = {
        id: randomUUID(), owner: ownerKey(principal), runnerId, skillId: skill.id, target, observedDigest, payload,
        ...(importBlocker ? { importBlocker } : {}),
        expectedLatestVersionId: latest?.id ?? null,
        expectedPinRevision: pin?.revision ?? null,
        expires: Date.now() + PREVIEW_TTL_MS,
      };
      previews.set(preview.id, preview);
      return {
        previewId: preview.id,
        drift: { ...target, observedDigest },
        files: source ?? result.files,
        previousFiles: latest?.files ?? [],
        digest: payload?.digest ?? null,
        importable: !!payload,
        ...(importBlocker ? { importBlocker } : {}),
        disposition: payload && latest?.digest === payload.digest ? "identical" : "update",
        publishedFromLatest: latest?.digest === target.digest,
        pinned: !!pin?.versionId,
        assignmentCount: skill.assignmentCount,
      };
    } catch {
      return reply.code(502).send({ error: "The edited copy could not be read or failed validation. Sync the machine and try again." });
    } finally { lock.pending = false; }
  });

  app.post("/api/skill-drift/:id/import", async (req, reply) => {
    purge();
    const preview = previews.get((req.params as { id: string }).id);
    if (!preview) return reply.code(404).send({ error: "Review expired. Review the edited copy again." });
    const principal = authorize(req, reply, preview.runnerId);
    if (!principal) return;
    if (ownerKey(principal) !== preview.owner) return reply.code(404).send({ error: "Review not found." });
    const skill = accessibleSkill(principal, preview.target.name);
    if (!skill || skill.id !== preview.skillId) return reply.code(404).send({ error: "Skill not found." });
    if (!preview.payload) return reply.code(409).send({ error: preview.importBlocker ?? "This edited copy cannot be imported." });
    const payload = preview.payload;
    const updating = skill.latestVersion?.digest !== payload.digest;
    if (updating && (req.body as { acceptUpdate?: unknown } | null)?.acceptUpdate !== true) {
      return reply.code(409).send({ error: "Accept the version diff before updating existing assignments." });
    }
    // Commit only what the machine still holds: an edit made after the review would otherwise stay
    // held on the machine while the library published the older one.
    if (!available(preview.runnerId, reply)) return;
    if (lock.pending) return reply.code(429).send({ error: "Another edited-copy operation is in progress." });
    lock.pending = true;
    let current: Awaited<ReturnType<typeof readOnRunner>>;
    try {
      current = await readOnRunner(preview.runnerId, preview.target);
    } catch {
      return reply.code(502).send({ error: "The edited copy could not be read again. Sync the machine and review it again." });
    } finally { lock.pending = false; }
    if (!stillAuthorized(req, reply, preview.runnerId, preview.owner, preview.skillId)) return;
    if (previews.get(preview.id) !== preview) return reply.code(409).send({ error: "The review changed or expired. Review the edited copy again." });
    if (current.status !== "read" || current.observedDigest !== preview.observedDigest) {
      previews.delete(preview.id);
      return reply.code(409).send({ error: "The edited copy changed after you reviewed it. Review it again before importing." });
    }
    let imported;
    try {
      imported = db.importSkillDriftEdit({
        skillId: skill.id,
        runnerId: preview.runnerId,
        files: payload.files,
        manifest: payload.manifest,
        digest: payload.digest,
        note: `Imported an edited deployed copy of ${preview.target.digest.slice(0, 12)} from machine ${preview.runnerId}.`,
        source: {
          runnerId: preview.runnerId,
          sourceDirectory: preview.target.variant === "manual" ? ".claude/skills" : ".agents/skills",
          name: preview.target.name,
          digest: payload.digest,
          importedAt: Date.now(),
        },
        expectedLatestVersionId: preview.expectedLatestVersionId,
        expectedPinRevision: preview.expectedPinRevision,
      });
    } catch (error) {
      if (error instanceof SkillImportConflictError) return reply.code(409).send({ error: error.message });
      return reply.code(500).send({ error: "Importing the edited copy failed." });
    }
    previews.delete(preview.id);
    for (const runner of db.listRunners()) {
      if (runner.runnerId !== preview.runnerId) deps.pushSkillsSync(runner.runnerId);
    }
    // Where this machine now deploys the imported version, reconciliation captures the edit with no
    // visible change. Otherwise the machine no longer deploys the skill, and the captured copy is
    // released with the same reviewed-observation fence a restore uses.
    const deployedHere = resolveDesiredSkillSnapshot(db, preview.runnerId)
      .some((entry) => entry.name === preview.target.name && entry.versionDigest === imported.version.digest);
    let released = false;
    let warning: string | undefined;
    if (!deployedHere) {
      if (lock.pending || !hub.isRunnerOnline(preview.runnerId)) {
        warning = "The edit was imported, but the machine did not release its edited copy. Use Restore Library Version to release it.";
      } else {
        lock.pending = true;
        try {
          const result = await restoreOnRunner(preview.runnerId, preview.target, preview.observedDigest);
          released = result.status !== "rejected";
          if (result.status === "rejected") warning = `The edit was imported, but the machine kept its edited copy: ${result.error}`;
        } catch {
          warning = "The edit was imported, but the machine did not confirm releasing its edited copy. Sync it to check.";
        } finally { lock.pending = false; }
      }
    }
    const state = await refreshState(preview.runnerId);
    // The import is committed either way; only return data the caller may still see.
    if (!stillAuthorized(req, reply, preview.runnerId, preview.owner, preview.skillId)) return;
    return { skill: imported.skill, version: imported.version, pinMoved: imported.pinMoved, released,
      ...(warning ? { warning } : {}), state };
  });

  app.delete("/api/skill-drift/:id", async (req, reply) => {
    const principal = deps.requestHuman(req);
    const id = (req.params as { id: string }).id;
    const preview = previews.get(id);
    if (principal && preview && preview.owner === `${principal.organizationId}:${principal.userId}`) previews.delete(id);
    return reply.code(204).send();
  });

  app.post("/api/runners/:id/skill-drift/restore", async (req, reply) => {
    const runnerId = (req.params as { id: string }).id;
    const principal = authorize(req, reply, runnerId);
    if (!principal) return;
    const body = req.body as { observedDigest?: unknown; confirmation?: unknown } | null;
    const target = parseTarget(body);
    const observedDigest = body?.observedDigest;
    if (!target || body?.confirmation !== "explicit" ||
        (observedDigest !== null && (typeof observedDigest !== "string" || !DIGEST.test(observedDigest)))) {
      return reply.code(400).send({ error: "Select one reported edited copy and explicitly confirm restoring it." });
    }
    const skill = accessibleSkill(principal, target.name);
    if (!skill) return reply.code(404).send({ error: "Skill not found." });
    if (!available(runnerId, reply)) return;
    const drift = reported(runnerId, target);
    if (!drift) return reply.code(409).send({ error: "This machine no longer reports that edited copy. Sync it to refresh its state." });
    if ((drift.observedDigest ?? null) !== observedDigest) {
      return reply.code(409).send({ error: "The edited copy changed after you reviewed it. Review it again before restoring." });
    }
    if (lock.pending) return reply.code(429).send({ error: "Another edited-copy operation is in progress." });
    lock.pending = true;
    let result: Awaited<ReturnType<typeof restoreOnRunner>>;
    try {
      // With the library version, the runner rebuilds the copy in place. Without it (the skill was
      // deleted and re-created), it discards the copy and converges to the current desired state.
      const library = db.getSkillVersionByDigest(skill.id, target.digest);
      result = await restoreOnRunner(runnerId, target, observedDigest, library?.files);
    } catch {
      return reply.code(502).send({ error: "The machine did not confirm the restore. Sync it and review the edited copy again." });
    } finally { lock.pending = false; }
    if (!stillAuthorized(req, reply, runnerId, ownerKey(principal), skill.id)) return;
    if (result.status === "rejected") return reply.code(409).send({ error: result.error });
    const state = await refreshState(runnerId);
    if (!stillAuthorized(req, reply, runnerId, ownerKey(principal), skill.id)) return;
    return { status: result.status, state };
  });

  registerSkillOrphanRoutes(app, deps, lock);
}
