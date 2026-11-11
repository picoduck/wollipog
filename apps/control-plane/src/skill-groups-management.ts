import { randomUUID } from "node:crypto";
import { SkillApplicationService } from "./skills-management.js";
import type { SkillsRouteDeps } from "./skills-route.js";
import type { SkillAssignmentView } from "./db.js";
import type { HumanPrincipal, AuthPrincipal } from "./identity.js";
import { runnerSupportsProtocol, runnerCapabilityRequirementError, type ResourceScope, type SkillInvocationPolicy } from "@wollipog/protocol";
import { parseSkillAgentSelector, resolveDesiredSkills } from "./skills.js";
import { skillStateResponse } from "./skill-edited-copy.js";
import { listOrphanedSkillCopies } from "./skill-orphan-management.js";
import { SkillsSyncInProgressError, SkillsSyncBudgetError } from "./skills-route.js";
function defaultSkillScope(principal: HumanPrincipal): ResourceScope {
  return {
    organizationId: principal.organizationId,
    owner: principal.role === "owner" || principal.role === "admin"
      ? { kind: "organization", organizationId: principal.organizationId }
      : { kind: "user", userId: principal.userId },
  };
}

function parseInvocation(value: unknown): SkillInvocationPolicy | null | undefined {
  if (value === undefined) return undefined;
  return value === "agent" || value === "manual" ? value : null;
}

export function createSkillGroupsManagement(deps: SkillsRouteDeps): SkillApplicationService {
  const app = new SkillApplicationService();
  const { db, hub, pushSkillsSync } = deps;

  /** Re-sync every machine whose desired set may have changed. Runner-scoped assignment
   * mutations touch exactly one machine; everything else fans out (the pusher itself
   * no-ops for offline or incapable runners). */
  const pushAffected = (assignment?: Pick<SkillAssignmentView, "scopeKind" | "runnerId">): void => {
    if (assignment?.scopeKind === "runner" && assignment.runnerId) {
      pushSkillsSync(assignment.runnerId);
      return;
    }
    for (const runner of db.listRunners()) pushSkillsSync(runner.runnerId);
  };

  /* ------------------------------ Skill groups ------------------------------ */

  // Legacy groups remain visible metadata until explicitly converted. Owned groups and every
  // deployment rule are resource-scoped; no implicit ownership backfill grants deployment rights.
  app.get("/api/skill-groups", async (req) => {
    const principal = req.principal;
    const human = (req.principal?.kind === "human" ? req.principal : null);
    return { groups: principal ? db.listSkillGroups().filter(g => !g.scope || db.canAccessSkillGroup(principal, g.id)) : [],
      creationScope: human ? defaultSkillScope(human) : null };
  });

  app.post("/api/skill-groups", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const name = (req.body as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
      return reply.code(400).send({ error: "name must be 1-120 characters" });
    }
    return reply.code(201).send({ group: db.createSkillGroup(name, Date.now(), defaultSkillScope(principal)) });
  });

  app.post("/api/skill-groups/:id/convert", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    if (!db.listSkillGroups().some(g => g.id === id) ||
        (db.skillGroupScope(id) && !db.canAccessSkillGroup(principal, id))) {
      return reply.code(404).send({ error: "skill group not found" });
    }
    if ((req.body as { accepted?: unknown } | null)?.accepted !== true) {
      return reply.code(400).send({ error: "explicit acceptance of group ownership is required" });
    }
    try { db.convertSkillGroup(id, defaultSkillScope(principal)); }
    catch { return reply.code(409).send({ error: "group is already owned or its members do not share your default ownership scope" }); }
    return { group: db.listSkillGroups().find(g => g.id === id) };
  });

  app.delete("/api/skill-groups/:id", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    if (db.skillGroupScope(id) && !db.canAccessSkillGroup(principal, id)) {
      return reply.code(404).send({ error: "skill group not found" });
    }
    if (!db.deleteSkillGroup(id)) {
      return reply.code(404).send({ error: "skill group not found" });
    }
    pushAffected();
    return reply.code(204).send();
  });

  const accessibleGroupRule = (principal: AuthPrincipal, rule: { scopeKind: string; runnerId: string | null }) =>
    rule.scopeKind !== "runner" || (!!rule.runnerId && db.canAccessRunner(principal, rule.runnerId));

  app.get("/api/skill-groups/:id/assignments", async (req, reply) => {
    const principal = req.principal;
    const id = (req.params as { id: string }).id;
    if (!principal || !db.canAccessSkillGroup(principal, id)) return reply.code(404).send({ error: "skill group not found" });
    return { assignments: db.listSkillGroupAssignments(id).filter(a => accessibleGroupRule(principal, a)) };
  });

  app.post("/api/skill-groups/:id/assignments", async (req, reply) => {
    const principal = (req.principal?.kind === "human" ? req.principal : null);
    if (!principal) return reply.code(403).send({ error: "human identity is required" });
    const id = (req.params as { id: string }).id;
    if (!db.canAccessSkillGroup(principal, id)) return reply.code(404).send({ error: "owned skill group not found" });
    const body = (req.body ?? {}) as { scopeKind?: unknown; runnerId?: unknown; agentSelector?: unknown; invocation?: unknown; enabled?: unknown };
    if (body.scopeKind !== "runner" && body.scopeKind !== "instance") return reply.code(400).send({ error: "scopeKind must be instance or runner" });
    if (body.scopeKind === "runner" && (typeof body.runnerId !== "string" || !db.getRunner(body.runnerId) || !db.canAccessRunner(principal, body.runnerId))) {
      return reply.code(404).send({ error: "runner not found" });
    }
    const agentSelector = parseSkillAgentSelector(body.agentSelector);
    const invocation = parseInvocation(body.invocation);
    if (!agentSelector || invocation === null || (body.enabled !== undefined && typeof body.enabled !== "boolean")) {
      return reply.code(400).send({ error: "invalid agentSelector, invocation, or enabled value" });
    }
    try {
      const assignment = db.createSkillGroupAssignment({ groupId: id, scopeKind: body.scopeKind,
        runnerId: body.scopeKind === "runner" ? body.runnerId as string : null,
        agentSelector, invocation: invocation ?? "agent", enabled: body.enabled !== false });
      pushAffected(assignment);
      return reply.code(201).send({ assignment });
    } catch { return reply.code(409).send({ error: "the group's access scope does not include this machine" }); }
  });

  for (const method of ["PATCH", "DELETE"] as const) app.route({
    method, url: "/api/skill-groups/:id/assignments/:assignmentId",
    handler: async (req, reply) => {
      const principal = (req.principal?.kind === "human" ? req.principal : null);
      if (!principal) return reply.code(403).send({ error: "human identity is required" });
      const { id, assignmentId } = req.params as { id: string; assignmentId: string };
      if (!db.canAccessSkillGroup(principal, id)) return reply.code(404).send({ error: "skill group not found" });
      const existing = db.listSkillGroupAssignments(id).find(a => a.id === assignmentId);
      if (!existing || !accessibleGroupRule(principal, existing)) return reply.code(404).send({ error: "group assignment not found" });
      if (method === "DELETE") {
        db.deleteSkillGroupAssignment(id, assignmentId);
        pushAffected(existing);
        return reply.code(204).send();
      }
      const body = (req.body ?? {}) as { enabled?: unknown; invocation?: unknown };
      const invocation = parseInvocation(body.invocation);
      if (invocation === null || (body.enabled !== undefined && typeof body.enabled !== "boolean")) return reply.code(400).send({ error: "invalid enabled or invocation value" });
      const assignment = db.updateSkillGroupAssignment(id, assignmentId, {
        ...(body.enabled === undefined ? {} : { enabled: body.enabled as boolean }), ...(invocation === undefined ? {} : { invocation }),
      });
      pushAffected(existing);
      return { assignment };
    },
  });

  /* ---------------------------- Skill assignments ---------------------------- */

  // Assignment authorization derives from the referenced skill: listings show only assignments of
  // accessible skills, and creating/mutating/deleting one requires access to that skill (plus, for
  // runner-scoped rows, the same canAccessRunner gate the other /api/runners/:id routes use).

  /* ------------------------------ Per-machine view ------------------------------ */

  app.get("/api/runners/:id/skills", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const runner = db.getRunner(id);
    if (!runner) return reply.code(404).send({ error: "runner not found" });
    const principal = req.principal;
    return {
      // File contents stay out of the listing; the digest + targets are what the UI compares.
      desired: resolveDesiredSkills(db, id).map((entry) => ({
        name: entry.name,
        versionDigest: entry.versionDigest,
        targets: entry.targets,
      })),
      reported: skillStateResponse(db.getRunnerSkillState(id)),
      removalReporting: runnerSupportsProtocol(
        runner.protocolVersion,
        "skillLinkRemovalReporting",
      ) ? "supported" : "unsupported",
      // An older runner never reports drift, so an empty list from it proves nothing.
      driftReporting: runnerSupportsProtocol(runner.protocolVersion, "skillDrift") ? "supported" : "unsupported",
      // Likewise for copies a restore kept aside, which only a v185 runner reports.
      keptAsideReporting: runnerSupportsProtocol(runner.protocolVersion, "skillKeptAsideCopies") ? "supported" : "unsupported",
      orphaned: principal ? listOrphanedSkillCopies(db, principal, id) : [],
    };
  });

  app.post("/api/runners/:id/skills/sync", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const runner = db.getRunner(id);
    if (!runner) return reply.code(404).send({ error: "runner not found" });
    if (!hub.isRunnerOnline(id)) return reply.code(409).send({ error: "runner is offline" });
    if (!runnerSupportsProtocol(runner.protocolVersion, "agentSkills")) {
      return reply.code(409).send(runnerCapabilityRequirementError(runner.protocolVersion, "agentSkills", "managed agent skills"));
    }
    const requestId = `skills_${randomUUID().slice(0, 8)}`;
    try {
      const result = await pushSkillsSync.request(id, requestId);
      if (result.type !== "skills_state") {
        return reply.code(502).send({ error: "unexpected runner reply" });
      }
      db.setRunnerSkillState(id, result, Date.now());
      return { state: skillStateResponse(db.getRunnerSkillState(id)) };
    } catch (error) {
      if (error instanceof SkillsSyncInProgressError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof SkillsSyncBudgetError) {
        return reply.code(409).send({ error: error.message });
      }
      return reply.code(504).send({ error: (error as Error).message });
    }
  });
  return app;
}
