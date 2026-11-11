import { AssistantOperations, AssistantRefusal, type AssistantOperation, type AssistantTarget } from "./assistant-connections.js";
import type { ControlPlaneDb } from "./db.js";
import { createSkillsManagement } from "./skills-management.js";
import { createSkillVersionPolicyManagement } from "./skill-version-policy-management.js";
import type { SkillsRouteDeps } from "./skills-route.js";
import { resolveDesiredSkillSnapshot } from "./skills.js";
import { skillStateResponse } from "./skill-edited-copy.js";
import { ManagementMutations } from "./assistant-management-command.js";
import { assistantRequestDigest } from "./assistant-command-receipts.js";
import { skillPayloadSchema } from "./assistant-management-schemas.js";
import { canReconcileSkillRemoval } from "./skill-removal-history.js";

function args(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("An argument object is required.");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128) throw new AssistantRefusal("A resource id is required.");
  return value;
}

/** Includes the entire read/modify/write surface, rather than a millisecond timestamp. */
export function skillManagementRevision(db: ControlPlaneDb, skillId: string): string {
  const counter = db.raw().prepare("SELECT revision FROM skill_management_revisions WHERE skill_id=?").get(skillId);
  return assistantRequestDigest({counter, skill: db.getSkill(skillId), assignments: db.listSkillAssignments(skillId),
    impact: db.skillDeploymentImpact(skillId)});
}

export function registerAssistantSkills(operations: AssistantOperations, deps: SkillsRouteDeps,
  mutations: ManagementMutations): void {
  const {db, hub} = deps;
  const service = createSkillsManagement(deps);
  const policyService = createSkillVersionPolicyManagement(deps);
  const impact = (skillId: string | null) => ({...db.skillDeploymentImpact(skillId),
    targets: db.listRunners().filter(r => {
      if (!skillId) return true;
      const skillScope = db.skillScope(skillId), runnerScope = db.runnerScope(r.runnerId);
      return skillScope && runnerScope && db.scopeAudienceContainedWithMembership(skillScope, runnerScope);
    })
      .map(r => ({runnerId: r.runnerId, online: hub.isRunnerOnline(r.runnerId)}))});
  const definitions = [
    ["skill_list", "GET /api/skills", "List accessible library skills.", false],
    ["skill_get", "GET /api/skills/:id", "Inspect a skill, assignments, revision and deployment scope.", false],
    ["skill_create", "POST /api/skills", "Create a library skill and first immutable version.", true],
    ["skill_update", "PUT /api/skills/:id", "Edit skill metadata with an expectedRevision.", true],
    ["skill_version_add", "POST /api/skills/:id/versions", "Publish a new immutable skill version with deployment impact.", true],
    ["skill_versions", "GET /api/skills/:id/versions", "List immutable skill version history.", false],
    ["skill_version_get", "GET /api/skills/:id/versions/:versionId", "Read a historical skill version.", false],
    ["skill_restore", "POST /api/skills/:id/restore", "Restore a historical version without discarding history.", true],
    ["skill_remove", "DELETE /api/skills/:id", "Remove a library skill and its assignments under the owner's confirmation policy.", true],
    ["skill_assign", "POST /api/skill-assignments", "Assign a skill to authorized machines or the installation.", true],
    ["skill_assign_update", "PATCH /api/skill-assignments/:id", "Edit an assignment with an expectedRevision.", true],
    ["skill_unassign", "DELETE /api/skill-assignments/:id", "Remove an assignment under the owner's confirmation policy.", true],
    ["skill_pin_get", "GET /api/skills/:id/machines/:runnerId/version", "Inspect a machine's version and pin policy.", false],
    ["skill_pin_set", "PUT /api/skills/:id/machines/:runnerId/version", "Pin or track latest on an authorized machine.", true],
  ] as const;
  for (const [name, route, description, mutation] of definitions) {
    const assignment = name === "skill_assign_update" || name === "skill_unassign";
    const skillId = (a: Record<string, unknown>): string | null => name === "skill_list" || name === "skill_create" ? null
      : assignment ? db.getSkillAssignment(id(a.assignmentId))?.skillId ?? id(a.skillId) : id(a.skillId);
    const target = (value: unknown): AssistantTarget => {
      const a = args(value), resolved = skillId(a);
      return {kind: "skill", id: resolved ?? name};
    };
    const operation: AssistantOperation = {
      name, description,
      inputSchema: {type: "object", properties: {skillId: {type: "string"}, assignmentId: {type: "string"},
        runnerId: {type: "string"}, versionId: {type: "string"}, before: {type: "string"},
        operationId: {type: "string"}, confirmationId: {type: "string"}, expectedRevision: {type: "string"},
        payload: skillPayloadSchema(name)},
        required: [...(name === "skill_list" || name === "skill_create" ? [] : [assignment ? "assignmentId" : "skillId"]),
          ...(name === "skill_version_get" ? ["versionId"] : []), ...(name.startsWith("skill_pin_") ? ["runnerId"] : []),
          ...(mutation ? ["operationId", ...(name === "skill_create" ? [] : ["expectedRevision"]),
            ...(name === "skill_remove" || name === "skill_unassign" ? [] : ["payload"])] : [])]},
      // A list is metadata only at authorization, then every result is separately filtered.
      metadata: name === "skill_list",
      resolveTarget: target,
      ownerCanAccess: (owner, t) => name === "skill_list" || name === "skill_create" || db.canAccessSkill(owner, t.id) ||
        (name === "skill_remove" && canReconcileSkillRemoval(db.raw(), owner, t.id)),
      execute: async (value, context) => {
        const a = args(value), resolved = skillId(a);
        const current = db.assistantConnections.get(context.connection.id)!;
        const scope = () => {
          if (!resolved) {
            const affected = impact(null);
            return {...affected, targets: affected.targets.filter(r => db.canAccessRunner(context.owner, r.runnerId))};
          }
          if (mutation && a.expectedRevision !== skillManagementRevision(db, resolved)) throw new AssistantRefusal("Skill revision changed. Inspect the skill and deployment scope again before editing.");
          const affected = impact(resolved);
          if (affected.targets.some(r => !db.canAccessRunner(context.owner, r.runnerId))) throw new AssistantRefusal("The granting owner cannot access every affected machine.");
          return affected;
        };
        let resourceId = resolved ?? undefined;
        const execute = async () => {
          const body = a.payload === undefined ? {} : args(a.payload);
          // Assignment identity comes from server records, never from a caller's substituted skill.
          const params = {id: assignment ? id(a.assignmentId) : resolved, versionId: a.versionId, runnerId: a.runnerId};
          const result = await (name.startsWith("skill_pin_") ? policyService : service).execute(route, {
            principal: context.owner, params, body: name === "skill_assign" ? {...body, skillId: resolved} : body,
            query: {before: a.before, versionId: a.versionId},
          });
          if (result.status >= 400) throw new AssistantRefusal(`Skill operation refused (${result.status}). ${String((result.body as {error?: string})?.error ?? "Inspect the owner API requirements.")}`);
          if (name === "skill_list") {
            const skills = (result.body as {skills: Array<{id: string}>}).skills.filter(skill => {
              try { operations.authorize(current.id, name, {kind: "skill", id: skill.id}); return true; } catch { return false; }
            });
            // Skill Library resources have installation ownership, not project placement.
            return {skills: current.grant.projects === "all" ? skills : []};
          }
          const resultingId = resolved ?? (result.body as {skill?: {id: string}})?.skill?.id;
          resourceId = resultingId;
          return {...(result.body as object ?? {}), ...(resultingId && db.getSkill(resultingId)
            ? {revision: skillManagementRevision(db, resultingId), impact: impact(resultingId)} : {})};
        };
        if (!mutation) return execute();
        return mutations.run({connection: current, operation: name, args: a, target: target(a),
          impact: scope, destructive: name === "skill_remove" || name === "skill_unassign",
          recheck: context.recheck, execute, resourceId: () => resourceId});
      },
    };
    operations.register(operation);
  }
  operations.register({name: "skill_deployments", description: "Inspect desired versus reported skill deployment, including offline machines. Offline is pending, never synchronized.",
    inputSchema: {type: "object", properties: {skillId: {type: "string"}}, required: ["skillId"]},
    resolveTarget: value => ({kind: "skill", id: id(args(value).skillId)}), ownerCanAccess: (owner, t) => db.canAccessSkill(owner, t.id),
    execute: (value, context) => {
      const skillId = id(args(value).skillId);
      return {revision: skillManagementRevision(db, skillId), impact: impact(skillId), targets: db.listRunners()
        .filter(r => db.canAccessRunner(context.owner, r.runnerId))
        .map(r => ({runnerId: r.runnerId, online: hub.isRunnerOnline(r.runnerId),
          desired: resolveDesiredSkillSnapshot(db, r.runnerId).filter(s => s.name === db.getSkill(skillId)?.name).map(({name, versionDigest, targets}) => ({name, versionDigest, targets})),
          reported: (() => {
            const state = skillStateResponse(db.getRunnerSkillState(r.runnerId));
            if (!state) return null;
            const name = db.getSkill(skillId)?.name;
            return {updatedAt: state.updatedAt, hasError: !!state.error,
              deployed: state.deployed.filter(s => s.name === name).map(s => ({name: s.name, digest: s.digest,
                hasError: !!s.error, links: s.links.map(({agentId, status}) => ({agentId, status}))})),
              drift: state.drift.filter(s => s.name === name).map(s => ({name: s.name})),
            };
          })()}))};
    }});
}
