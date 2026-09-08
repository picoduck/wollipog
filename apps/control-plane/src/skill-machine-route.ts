import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { runnerSupportsProtocol, runnerCapabilityRequirement, validSkillName, type MachineSkillCandidate } from "@wollipog/protocol";
import { SkillImportConflictError } from "./db.js";
import { validateSkillPayload, type ValidatedSkillPayload } from "./skills.js";
import type { SkillsRouteDeps } from "./skills-route.js";
import { skillAdoptionPreflight } from "./skill-adoption-preflight.js";

export function registerMachineSkillRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  type Preview = { id: string; candidate: MachineSkillCandidate; payload: ValidatedSkillPayload; expectedVersionId: string | null };
  type Discovery = { owner: string; runnerId: string; expires: number; candidates: MachineSkillCandidate[]; preview?: Preview };
  const discoveries = new Map<string, Discovery>();
  let pending = false;
  const purge = () => { for (const [id, value] of discoveries) if (value.expires <= Date.now()) discoveries.delete(id); };
  const timer = setInterval(purge, 60_000); timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); discoveries.clear(); });
  const authorize = (req: FastifyRequest, reply: FastifyReply, runnerId: string) => {
    const principal = deps.requestHuman(req);
    if (!principal || !["owner", "admin"].includes(principal.role)) {
      reply.code(403).send({ error: "An owner or administrator must authorize reading machine skill files." }); return null;
    }
    if (!deps.db.canAccessRunner(principal, runnerId)) {
      reply.code(404).send({ error: "Machine not found." }); return null;
    }
    return principal;
  };
  const ownerKey = (principal: NonNullable<ReturnType<typeof authorize>>) => `${principal.organizationId}:${principal.userId}`;
  const available = (runnerId: string, reply: FastifyReply) => {
    const runner = deps.db.getRunner(runnerId);
    if (!runner || !deps.hub.isRunnerOnline(runnerId)) { reply.code(409).send({ error: "Machine is offline." }); return false; }
    if (!runnerSupportsProtocol(runner.protocolVersion, "machineSkillSnapshots")) {
      reply.code(409).send({ error: runnerCapabilityRequirement(runner.protocolVersion, "machineSkillSnapshots", "Machine skill snapshots") }); return false;
    }
    if (runner.os !== "linux") { reply.code(409).send({ error: "Machine skill snapshots currently require a Linux runner." }); return false; }
    return true;
  };

  app.post("/api/runners/:id/skill-snapshots", async (req, reply) => {
    const runnerId = (req.params as { id: string }).id;
    const principal = authorize(req, reply, runnerId);
    if (!principal || !available(runnerId, reply)) return;
    purge();
    if (pending || discoveries.size >= 4) return reply.code(429).send({ error: "Finish or close another machine import first." });
    pending = true;
    try {
      const requestId = randomUUID();
      const result = await deps.hub.requestFromRunner(runnerId, requestId, { type: "skill_snapshot", runnerId, requestId, operation: "list" });
      if (result.type !== "skill_snapshot_result" || result.runnerId !== runnerId || result.error || !Array.isArray(result.candidates) || result.candidates.length > 64) throw new Error();
      if (result.candidates.some((c) => !c || typeof c.id !== "string" || c.id.length > 64 || !validSkillName(c.name) ||
        ![".agents/skills", ".claude/skills", ".codex/skills"].includes(c.sourceDirectory) || typeof c.generation !== "string" || c.generation.length > 200) ||
        new Set(result.candidates.map((c) => c.id)).size !== result.candidates.length) throw new Error();
      // Keep only bounded metadata; unrecognized runner properties must not enter the cache/UI.
      const candidates = result.candidates.map(({ id, name, sourceDirectory, generation }) => ({ id, name, sourceDirectory, generation }));
      const discoveryId = randomUUID();
      discoveries.set(discoveryId, { owner: ownerKey(principal), runnerId, expires: Date.now() + 600_000, candidates });
      return { discoveryId, candidates };
    } catch { return reply.code(502).send({ error: "Machine skill discovery failed. Check the connection and try again." }); }
    finally { pending = false; }
  });

  app.post("/api/skill-machine/:id/preview", async (req, reply) => {
    purge();
    const discovery = discoveries.get((req.params as { id: string }).id);
    if (!discovery) return reply.code(404).send({ error: "Discovery expired. Discover the machine again." });
    const principal = authorize(req, reply, discovery.runnerId);
    if (!principal) return;
    if (discovery.owner !== ownerKey(principal)) return reply.code(404).send({ error: "Discovery not found." });
    if (!available(discovery.runnerId, reply)) return;
    const candidateId = (req.body as { candidateId?: unknown } | null)?.candidateId;
    const candidate = discovery.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) return reply.code(400).send({ error: "Select a discovered skill." });
    if (pending) return reply.code(429).send({ error: "Another machine read is in progress." });
    pending = true;
    delete discovery.preview;
    try {
      const requestId = randomUUID();
      const result = await deps.hub.requestFromRunner(discovery.runnerId, requestId, { type: "skill_snapshot", runnerId: discovery.runnerId, requestId, operation: "read", candidateId: candidate.id });
      if (result.type !== "skill_snapshot_result" || result.runnerId !== discovery.runnerId || result.error || !result.snapshot) throw new Error();
      const snapshot = result.snapshot;
      if (snapshot.candidate?.id !== candidate.id || snapshot.candidate.generation !== candidate.generation ||
        snapshot.candidate.name !== candidate.name || snapshot.candidate.sourceDirectory !== candidate.sourceDirectory) throw new Error();
      const payload = validateSkillPayload({ name: candidate.name, files: snapshot.files });
      if (!payload.ok || payload.digest !== snapshot.digest) throw new Error();
      const existing = deps.db.getSkillByName(candidate.name);
      if (existing && !deps.db.canAccessSkill(principal, existing.id)) return reply.code(409).send({ error: "This skill name is unavailable in the library." });
      discovery.preview = { id: randomUUID(), candidate, payload, expectedVersionId: existing?.latestVersion?.id ?? null };
      const prior = existing?.latestVersion ? deps.db.getSkillVersion(existing.latestVersion.id) : null;
      return { previewId: discovery.preview.id, candidate, files: payload.files, digest: payload.digest, previousFiles: prior?.files ?? [],
        disposition: prior?.digest === payload.digest ? "identical" : prior ? "update" : "new", assignmentCount: existing?.assignmentCount ?? 0 };
    } catch { return reply.code(502).send({ error: "Snapshot failed validation or the source changed. Discover it again. Symlinks, hard links, special files, and oversized trees are not supported." }); }
    finally { pending = false; }
  });

  app.post("/api/skill-machine/:id/adoption-preflight", async (req, reply) => {
    purge();
    const id = (req.params as { id: string }).id;
    const discovery = discoveries.get(id);
    if (!discovery) return reply.code(404).send({ error: "Discovery expired. Discover the machine again." });
    const principal = authorize(req, reply, discovery.runnerId);
    if (!principal) return;
    if (discovery.owner !== ownerKey(principal) || !discovery.preview) return reply.code(404).send({ error: "Preview not found." });
    const preview = discovery.preview;
    if ((req.body as { previewId?: unknown } | null)?.previewId !== preview.id) return reply.code(409).send({ error: "Review the current snapshot first." });
    if (!available(discovery.runnerId, reply)) return;
    const accessible = (human: NonNullable<ReturnType<typeof authorize>>) => {
      const skill = deps.db.getSkillByName(preview.candidate.name);
      return !skill || deps.db.canAccessSkill(human, skill.id);
    };
    if (!accessible(principal)) return reply.code(409).send({ error: "This skill name is unavailable in the library." });
    if (pending) return reply.code(429).send({ error: "Another machine read is in progress." });
    pending = true;
    try {
      const requestId = randomUUID();
      const result = await deps.hub.requestFromRunner(discovery.runnerId, requestId, {
        type: "skill_snapshot", runnerId: discovery.runnerId, requestId, operation: "read", candidateId: preview.candidate.id,
      });
      // Closing, importing, replacing, or expiring the preview while the read is in flight
      // invalidates this report. Recheck access and current DB targeting after the async boundary.
      purge();
      if (discoveries.get(id) !== discovery || discovery.preview !== preview) return reply.code(409).send({ error: "The preview changed or expired. Preview the source again." });
      const currentPrincipal = authorize(req, reply, discovery.runnerId);
      if (!currentPrincipal) return;
      if (ownerKey(currentPrincipal) !== discovery.owner || !accessible(currentPrincipal)) return reply.code(404).send({ error: "Preview not found." });
      if (!available(discovery.runnerId, reply)) return;
      if (result.type !== "skill_snapshot_result" || result.runnerId !== discovery.runnerId || result.requestId !== requestId || result.error || !result.snapshot) throw new Error();
      const { snapshot } = result;
      const candidate = preview.candidate;
      if (snapshot.candidate?.id !== candidate.id || snapshot.candidate.name !== candidate.name ||
        snapshot.candidate.sourceDirectory !== candidate.sourceDirectory || snapshot.candidate.generation !== candidate.generation) throw new Error();
      const payload = validateSkillPayload({ name: candidate.name, files: snapshot.files });
      if (!payload.ok || payload.digest !== snapshot.digest || payload.digest !== preview.payload.digest) throw new Error();
      return { ...skillAdoptionPreflight(deps.db, discovery.runnerId, candidate, payload.digest),
        source: { candidate, digest: payload.digest, checkedAt: Date.now() },
        notice: "Read-only prerequisite report. No directory was changed. Reader fields describe configured deployment exposure, not observed reads. A future adoption must revalidate the source and assignments under the provider-home lease before any replacement.",
      };
    } catch {
      return reply.code(502).send({ error: "The source changed or could not be validated. Preview it again before checking adoption prerequisites." });
    } finally { pending = false; }
  });

  app.post("/api/skill-machine/:id/import", async (req, reply) => {
    purge();
    const discovery = discoveries.get((req.params as { id: string }).id);
    if (!discovery) return reply.code(404).send({ error: "Preview expired. Discover the machine again." });
    const principal = authorize(req, reply, discovery.runnerId);
    if (!principal) return;
    if (discovery.owner !== ownerKey(principal) || !discovery.preview) return reply.code(404).send({ error: "Preview not found." });
    const preview = discovery.preview;
    if ((req.body as { previewId?: unknown } | null)?.previewId !== preview.id) return reply.code(409).send({ error: "The preview changed. Review the current snapshot before importing." });
    const existing = deps.db.getSkillByName(preview.payload.name);
    if (existing && !deps.db.canAccessSkill(principal, existing.id)) return reply.code(404).send({ error: "Skill not found." });
    const updating = existing && existing.latestVersion?.digest !== preview.payload.digest;
    if (updating && (req.body as { acceptUpdate?: unknown } | null)?.acceptUpdate !== true) {
      return reply.code(409).send({ error: "Accept the version diff before updating existing assignments." });
    }
    try {
      const skill = deps.db.importMachineSkill({ ...preview.payload, expectedVersionId: preview.expectedVersionId,
        source: { runnerId: discovery.runnerId, sourceDirectory: preview.candidate.sourceDirectory, name: preview.candidate.name, digest: preview.payload.digest, importedAt: Date.now() },
        scope: { organizationId: principal.organizationId, owner: { kind: "organization", organizationId: principal.organizationId } } });
      delete discovery.preview;
      if (updating) for (const runner of deps.db.listRunners()) deps.pushSkillsSync(runner.runnerId);
      return { skill };
    } catch (error) {
      if (error instanceof SkillImportConflictError) return reply.code(409).send({ error: error.message });
      return reply.code(500).send({ error: "Machine skill import failed." });
    }
  });
  app.delete("/api/skill-machine/:id", async (req, reply) => {
    const principal = deps.requestHuman(req);
    const id = (req.params as { id: string }).id;
    if (principal && discoveries.get(id)?.owner === ownerKey(principal)) discoveries.delete(id);
    return reply.code(204).send();
  });
}
