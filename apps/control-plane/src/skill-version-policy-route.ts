import type { FastifyInstance } from "fastify";
import { runnerCapabilityRequirement, runnerSupportsProtocol } from "@wollipog/protocol";
import { SkillImportConflictError } from "./db.js";
import type { SkillsRouteDeps } from "./skills-route.js";

export function registerSkillVersionPolicyRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  const { db } = deps;
  const path = "/api/skills/:id/machines/:runnerId/version";
  app.get(path, async (req, reply) => {
    const principal = deps.requestPrincipal(req);
    const { id, runnerId } = req.params as { id: string; runnerId: string };
    if (!principal || !db.canAccessSkill(principal, id) || !db.canAccessRunner(principal, runnerId)) return reply.code(404).send({ error: "skill or runner not found" });
    const skill = db.getSkill(id);
    const policy = db.getMachineSkillVersion(id, runnerId);
    const { versionId } = req.query as { versionId?: unknown };
    if (versionId !== undefined && (typeof versionId !== "string" || !versionId || versionId.length > 100)) return reply.code(400).send({ error: "invalid versionId" });
    if (!skill?.latestVersion) return reply.code(404).send({ error: "skill version not found" });
    const proposed = db.getSkillVersion(typeof versionId === "string" ? versionId : skill.latestVersion.id);
    if (!proposed || proposed.skillId !== id) return reply.code(404).send({ error: "version not found" });
    return {
      policy: policy ? { versionId: policy.versionId, revision: policy.revision } : null,
      currentVersion: db.getSkillVersion(policy?.versionId ?? skill.latestVersion.id),
      proposedVersion: proposed,
      expectedLatestVersionId: skill.latestVersion.id,
    };
  });
  app.put(path, async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const { id, runnerId } = req.params as { id: string; runnerId: string };
    if (!db.canAccessSkill(principal, id) || !db.canAccessRunner(principal, runnerId)) return reply.code(404).send({ error: "skill or runner not found" });
    const runner = db.getRunner(runnerId)!;
    if (!runnerSupportsProtocol(runner.protocolVersion, "agentSkills")) return reply.code(409).send({ error: runnerCapabilityRequirement(runner.protocolVersion, "agentSkills", "Managed agent skills") });
    const skillScope = db.skillScope(id);
    const runnerScope = db.runnerScope(runnerId);
    if (!skillScope || !runnerScope || !db.scopeAudienceContainedWithMembership(skillScope, runnerScope)) return reply.code(409).send({ error: "the skill's access scope does not include this machine" });
    const body = (req.body ?? {}) as { versionId?: unknown; expectedRevision?: unknown; expectedLatestVersionId?: unknown };
    const bounded = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100;
    if (!(body.versionId === null || bounded(body.versionId)) || !(body.expectedRevision === null || bounded(body.expectedRevision)) || !bounded(body.expectedLatestVersionId)) return reply.code(400).send({ error: "versionId, expectedRevision, and expectedLatestVersionId are required" });
    if (body.versionId && db.getSkillVersion(body.versionId)?.skillId !== id) return reply.code(404).send({ error: "version not found" });
    try { db.setMachineSkillVersion(id, runnerId, body.versionId, body.expectedRevision, body.expectedLatestVersionId); }
    catch (error) {
      if (error instanceof SkillImportConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
    deps.pushSkillsSync(runnerId);
    return { policy: db.getMachineSkillVersion(id, runnerId) };
  });
}
