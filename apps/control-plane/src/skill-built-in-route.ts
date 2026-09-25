/**
 * Built-in skill routes: per-user recommendation dismissal, and the review of release content that
 * does not apply on its own (an update held by local changes, or the adoption of a same-name
 * user-managed skill). Registered from skills-route.ts.
 */
import type { FastifyInstance } from "fastify";
import { SkillImportConflictError, type ControlPlaneDb, type SkillView } from "./db.js";
import { LOCAL_OWNER_USER_ID, type AuthPrincipal } from "./identity.js";
import type { BuiltInSkill } from "./built-in-skills.js";
import type { SkillsRouteDeps } from "./skills-route.js";

/** Add the requesting user's recommendation state to a built-in skill. */
export function withSkillRecommendation(
  db: ControlPlaneDb,
  principal: AuthPrincipal | null,
  skill: SkillView,
  dismissed?: ReadonlySet<string>,
): SkillView {
  if (!skill.builtIn || principal?.kind !== "human") return skill;
  const dismissals = dismissed ?? db.skillRecommendationDismissals(principal.userId);
  return { ...skill, recommendation: { dismissed: dismissals.has(skill.id) } };
}

export function registerSkillBuiltInRoutes(
  app: FastifyInstance,
  deps: SkillsRouteDeps,
  builtIns: readonly BuiltInSkill[],
): void {
  const { db } = deps;

  /** The running release's content the skill can review, or null when nothing waits for review. */
  const pendingContent = (skill: SkillView): BuiltInSkill | null => {
    const offered = skill.builtIn?.heldUpdate ?? skill.builtInOffer;
    return offered
      ? builtIns.find((entry) => entry.name === skill.name && entry.digest === offered.digest &&
        entry.release === offered.release) ?? null
      : null;
  };

  // Dismissal is private per-user metadata, like a worktree setup notice, so read-only members may
  // dismiss for themselves (identity.ts exempts this route from the viewer mutation gate).
  app.put("/api/skills/:id/recommendation", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const { id } = req.params as { id: string };
    if (!db.canAccessSkill(principal, id)) return reply.code(404).send({ error: "skill not found" });
    const body = (req.body ?? {}) as { dismissed?: unknown };
    if (typeof body.dismissed !== "boolean") return reply.code(400).send({ error: "dismissed must be a boolean" });
    const skill = db.getSkill(id);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    if (!skill.builtIn) return reply.code(409).send({ error: "Only a built-in skill has a recommendation." });
    db.setSkillRecommendationDismissed(principal.userId, id, body.dismissed);
    return { skill: withSkillRecommendation(db, principal, skill) };
  });

  app.get("/api/skills/:id/built-in-version", async (req, reply) => {
    const principal = deps.requestPrincipal(req);
    const { id } = req.params as { id: string };
    if (!principal || !db.canAccessSkill(principal, id)) return reply.code(404).send({ error: "skill not found" });
    const skill = db.getSkill(id);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    const content = pendingContent(skill);
    if (!content) return reply.code(404).send({ error: "No built-in version is waiting for review." });
    return {
      kind: skill.builtIn ? "update" : "adopt",
      release: content.release,
      digest: content.digest,
      files: content.files,
      currentVersion: skill.latestVersion ? db.getSkillVersion(skill.latestVersion.id) : null,
      expectedLatestVersionId: skill.latestVersion?.id ?? null,
      assignmentCount: skill.assignmentCount,
      gitAutoUpdate: skill.gitAutoUpdate?.enabled ?? false,
    };
  });

  app.post("/api/skills/:id/built-in-version", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const { id } = req.params as { id: string };
    if (!db.canAccessSkill(principal, id)) return reply.code(404).send({ error: "skill not found" });
    const body = (req.body ?? {}) as { digest?: unknown; expectedLatestVersionId?: unknown; accepted?: unknown };
    if (body.accepted !== true) {
      return reply.code(400).send({ error: "Accept the version diff explicitly before applying the built-in version." });
    }
    const bounded = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100;
    if (!bounded(body.digest) || !(body.expectedLatestVersionId === null || bounded(body.expectedLatestVersionId))) {
      return reply.code(400).send({ error: "digest and expectedLatestVersionId are required" });
    }
    const skill = db.getSkill(id);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    const content = pendingContent(skill);
    if (!content || content.digest !== body.digest) {
      return reply.code(409).send({ error: "The offered built-in version changed. Review it again." });
    }
    // Accepting turns off Git automatic updates, a setting only the instance owner may change.
    if (skill.gitAutoUpdate?.enabled &&
        (principal.userId !== LOCAL_OWNER_USER_ID || !["owner", "admin"].includes(principal.role))) {
      return reply.code(403).send({ error: "Only the instance owner can turn off this skill's automatic Git updates." });
    }
    let result;
    try {
      result = db.acceptBuiltInSkillVersion({
        skillId: id,
        files: content.files,
        manifest: content.manifest,
        digest: content.digest,
        release: content.release,
        expectedLatestVersionId: body.expectedLatestVersionId,
      });
    } catch (error) {
      if (error instanceof SkillImportConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
    if (result.changed) for (const runner of db.listRunners()) deps.pushSkillsSync(runner.runnerId);
    return { skill: withSkillRecommendation(db, principal, result.skill) };
  });
}
