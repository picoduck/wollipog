import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { SkillsRouteDeps } from "./skills-route.js";
import { discoverGitSkills, parseSkillGitSource, type SkillGitCandidate } from "./skill-git.js";

export function registerSkillGitRoutes(app: FastifyInstance, deps: SkillsRouteDeps,
  discover = discoverGitSkills): void {
  type Snapshot = { owner: string; expires: number; candidates: SkillGitCandidate[]; versions: Map<string, string | null> };
  const snapshots = new Map<string, Snapshot>();
  let discovering = false;
  const purge = () => { for (const [id, value] of snapshots) if (value.expires <= Date.now()) snapshots.delete(id); };
  const timer = setInterval(purge, 60_000);
  timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); snapshots.clear(); });

  app.post("/api/skill-git/preview", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal || !["owner", "admin"].includes(principal.role)) {
      return reply.code(403).send({ error: "An owner or administrator is required to access control-plane Git credentials." });
    }
    purge();
    if (discovering || snapshots.size >= 4) return reply.code(429).send({ error: "Another import is in progress. Finish or cancel a preview first." });
    let source;
    try { source = parseSkillGitSource(req.body); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    discovering = true;
    try {
      const candidates = await discover(source);
      const versions = new Map<string, string | null>();
      const previews = candidates.map((candidate) => {
        const existing = deps.db.getSkillByName(candidate.name);
        if (existing && !deps.db.canAccessSkill(principal, existing.id)) throw new Error("A skill name is unavailable in this library.");
        versions.set(candidate.name, existing?.latestVersion?.id ?? null);
        const prior = existing?.latestVersion ? deps.db.getSkillVersion(existing.latestVersion.id) : null;
        return { ...candidate, existingSkillId: existing?.id ?? null,
          assignmentCount: existing?.assignmentCount ?? 0,
          disposition: prior?.digest === candidate.digest ? "identical" : prior ? "update" : "new",
          previousFiles: prior?.files ?? [] };
      });
      const previewId = randomUUID();
      snapshots.set(previewId, { owner: `${principal.organizationId}:${principal.userId}`, expires: Date.now() + 600_000, candidates, versions });
      return { previewId, candidates: previews };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    } finally { discovering = false; }
  });

  app.delete("/api/skill-git/preview/:id", async (req, reply) => {
    const principal = deps.requestHuman(req);
    const id = (req.params as { id: string }).id;
    const snapshot = snapshots.get(id);
    if (principal && snapshot?.owner === `${principal.organizationId}:${principal.userId}`) snapshots.delete(id);
    return reply.code(204).send();
  });

  app.post("/api/skill-git/import", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal || !["owner", "admin"].includes(principal.role)) return reply.code(403).send({ error: "An owner or administrator is required." });
    purge();
    const body = (req.body ?? {}) as { previewId?: string; path?: string; acceptUpdate?: boolean };
    const snapshot = typeof body.previewId === "string" ? snapshots.get(body.previewId) : undefined;
    if (!snapshot || snapshot.owner !== `${principal.organizationId}:${principal.userId}`) {
      return reply.code(404).send({ error: "Import preview expired or not found. Preview the source again." });
    }
    const candidate = snapshot.candidates.find((entry) => entry.path === body.path);
    if (!candidate) return reply.code(400).send({ error: "Select a skill from the preview." });
    const existing = deps.db.getSkillByName(candidate.name);
    if (existing && !deps.db.canAccessSkill(principal, existing.id)) return reply.code(404).send({ error: "Skill not found." });
    if (existing && existing.latestVersion?.digest !== candidate.digest && body.acceptUpdate !== true) {
      return reply.code(409).send({ error: "Accept the version diff explicitly before updating an existing skill." });
    }
    try {
      const skill = deps.db.importGitSkill({ ...candidate,
        source: { ...candidate.source, path: candidate.path, commit: candidate.commit },
        scope: { organizationId: principal.organizationId, owner: { kind: "organization", organizationId: principal.organizationId } },
        expectedVersionId: snapshot.versions.get(candidate.name) ?? null,
      });
      snapshot.candidates = snapshot.candidates.filter((entry) => entry.path !== candidate.path);
      if (!snapshot.candidates.length) snapshots.delete(body.previewId!);
      if (existing && existing.latestVersion?.digest !== candidate.digest) {
        for (const runner of deps.db.listRunners()) deps.pushSkillsSync(runner.runnerId);
      }
      return { skill };
    } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
}
