import { AssistantRefusal, type AssistantOperations, type AssistantTarget } from "./assistant-connections.js";
import type { SkillsRouteDeps } from "./skills-route.js";
import { createSkillsManagement, type SkillApplicationService } from "./skills-management.js";
import type { ManagementMutations } from "./assistant-management-command.js";
import { assistantRequestDigest } from "./assistant-command-receipts.js";
import {skillParityPayloadSchema} from "./assistant-skill-parity-schemas.js";

/** Explicit route-to-operation mapping; no caller-selected route or method dispatch. */
export const ASSISTANT_SKILL_PARITY = [
  ["skill_groups", "GET /api/skill-groups", "library", false, false],
  ["skill_group_create", "POST /api/skill-groups", "library", true, false],
  ["skill_group_remove", "DELETE /api/skill-groups/:id", "group", true, true],
  ["skill_group_assignments", "GET /api/skill-groups/:id/assignments", "group", false, false],
  ["skill_group_assign", "POST /api/skill-groups/:id/assignments", "group", true, false],
  ["skill_group_assignment_edit", "PATCH /api/skill-groups/:id/assignments/:assignmentId", "group", true, false],
  ["skill_group_unassign", "DELETE /api/skill-groups/:id/assignments/:assignmentId", "group", true, true],
  ["skill_assignments", "GET /api/skill-assignments", "library", false, false],
  ["skill_machine_state", "GET /api/runners/:id/skills", "runner", false, false],
  ["skill_sync", "POST /api/runners/:id/skills/sync", "runner", true, false],
  ["skill_builtin_get", "GET /api/skills/:id/built-in-version", "skill", false, false],
  ["skill_builtin_apply", "POST /api/skills/:id/built-in-version", "skill", true, true],
  ["skill_recommendation", "PUT /api/skills/:id/recommendation", "skill", true, false],
  ["skill_git_preview", "POST /api/skill-git/preview", "library", true, false],
  ["skill_git_preview_discard", "DELETE /api/skill-git/preview/:id", "preview", true, true],
  ["skill_git_import", "POST /api/skill-git/import", "library", true, true],
  ["skill_machine_discover", "POST /api/runners/:id/skill-snapshots", "runner", true, false],
  ["skill_machine_preview", "POST /api/skill-machine/:id/preview", "preview", true, false],
  ["skill_adoption_preflight", "POST /api/skill-machine/:id/adoption-preflight", "preview", true, false],
  ["skill_machine_adopt", "POST /api/skill-machine/:id/adopt", "preview", true, true],
  ["skill_machine_import", "POST /api/skill-machine/:id/import", "preview", true, true],
  ["skill_machine_discard", "DELETE /api/skill-machine/:id", "preview", true, true],
  ["skill_recovery_list", "POST /api/runners/:id/skill-adoption-recovery", "runner", false, false],
  ["skill_recovery_restore", "POST /api/runners/:id/skill-adoption-recovery/:operationId/restore", "runner", true, true],
  ["skill_drift_preview", "POST /api/runners/:id/skill-drift/preview", "runner", true, false],
  ["skill_drift_restore", "POST /api/runners/:id/skill-drift/restore", "runner", true, true],
  ["skill_drift_import", "POST /api/skill-drift/:id/import", "preview", true, true],
  ["skill_drift_discard", "DELETE /api/skill-drift/:id", "preview", true, true],
  ["skill_orphan_preview", "POST /api/runners/:id/orphaned-skill-copies/preview", "runner", true, false],
  ["skill_orphan_discard", "POST /api/runners/:id/orphaned-skill-copies/discard", "runner", true, true],
  ["skill_orphan_import", "POST /api/orphaned-skill-copies/:id/import", "preview", true, true],
  ["skill_orphan_preview_discard", "DELETE /api/orphaned-skill-copies/:id", "preview", true, true],
] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("Supply an argument object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new AssistantRefusal(`${label} is required.`);
  return value;
}
export function skillLibraryRevision(deps: Pick<SkillsRouteDeps, "db">): string {
  return assistantRequestDigest(deps.db.raw().prepare("SELECT revision FROM skill_library_revision WHERE id=1").get());
}

/** All Library resources are installation-owned. Selected-project grants cannot manufacture
 * placement by naming a Machine/Project; these operations require all-project authority. */
export function registerAssistantSkillParity(operations: AssistantOperations, deps: SkillsRouteDeps,
  service: SkillApplicationService, mutations: ManagementMutations): void {
  const {db, hub} = deps;
  const core = createSkillsManagement(deps);
  for (const [name, route, kind, mutation, destructive] of ASSISTANT_SKILL_PARITY) {
    const createsPreview = name.endsWith("_preview") || name === "skill_machine_discover" || name === "skill_adoption_preflight";
    const fenced = mutation && !createsPreview && name !== "skill_group_create";
    const target = (value: unknown): AssistantTarget => {
      const a = object(value);
      const resourceId = kind === "runner" ? text(a.runnerId, "runnerId") : kind === "skill" ? text(a.skillId, "skillId")
        : kind === "group" ? text(a.groupId, "groupId") : kind === "preview" ? text(a.previewId, "previewId") : "library";
      return {kind: "skill", id: resourceId};
    };
    const sourceRunner = (a: Record<string, unknown>) => kind === "runner" ? text(a.runnerId, "runnerId")
      : kind === "preview" ? service.reference(text(a.previewId, "previewId"))?.runnerId : undefined;
    operations.register({name, description: `${route}. Uses the owner's shared Skill Library service; inspect revision and affected scope before changes.`,
      inputSchema: {type: "object", additionalProperties: false, properties: {
        runnerId: {type: "string"}, skillId: {type: "string"}, groupId: {type: "string"}, previewId: {type: "string"},
        assignmentId: {type: "string"}, recoveryId: {type: "string"}, payload: skillParityPayloadSchema(name),
        commandId: {type: "string"}, confirmationId: {type: "string"}, expectedRevision: {type: "string"}},
        required: [...(kind === "library" ? [] : [kind === "runner" ? "runnerId" : kind === "skill" ? "skillId" : kind === "group" ? "groupId" : "previewId"]),
          ...(mutation ? ["commandId"] : []), ...(fenced ? ["expectedRevision"] : []),
          ...(route.includes(":assignmentId") ? ["assignmentId"] : []), ...(route.includes(":operationId") ? ["recoveryId"] : [])]},
      resolveTarget: target,
      ownerCanAccess: (owner, t) => kind === "runner" ? db.canAccessRunner(owner, t.id) : kind === "skill" ? db.canAccessSkill(owner, t.id)
        : kind === "group" ? !db.listSkillGroups().some(g => g.id === t.id) || db.canAccessSkillGroup(owner, t.id) : kind === "preview" ? (() => {
          const ref = service.reference(t.id);
          return !ref || ((!ref.runnerId || db.canAccessRunner(owner, ref.runnerId)) && (!ref.skillId || db.canAccessSkill(owner, ref.skillId)));
        })() : true,
      execute: async (value, ctx) => {
        const a = object(value);
        const authorize = () => operations.authorize(ctx.connection.id, name, target(a));
        const scope = () => {
          const owner = authorize(), runnerId = sourceRunner(a);
          const skills = kind === "skill" ? [db.getSkill(text(a.skillId, "skillId"))!]
            : kind === "group" ? db.listSkills().filter(s => s.groupId === a.groupId) : db.listSkillsForPrincipal(owner);
          if (name === "skill_builtin_apply" && skills[0]?.gitAutoUpdate?.enabled) {
            throw new AssistantRefusal("The owner must disable automatic Git credential use in Skill Library settings before applying this built-in version.");
          }
          const rules = kind === "group" ? db.listSkillGroupAssignments(text(a.groupId, "groupId")) : [];
          const body = a.payload === undefined ? {} : object(a.payload);
          const explicit = new Set([runnerId, ...(kind === "group" ? [body.runnerId, ...rules.map(rule => rule.runnerId)] : [])]);
          const scopes = [...skills.map(s => db.skillScope(s.id)), ...(kind === "group" ? [db.skillGroupScope(text(a.groupId, "groupId"))] : [])];
          const affectsLibrary = kind === "library" || kind === "group" || kind === "skill" || name.endsWith("_import");
          const targets = db.listRunners().filter(r => explicit.has(r.runnerId) || affectsLibrary && scopes.some(scope => {
            const runnerScope = db.runnerScope(r.runnerId);
            return scope && runnerScope && db.scopeAudienceContainedWithMembership(scope, runnerScope);
          }));
          if (skills.some(s => !db.canAccessSkill(owner, s.id)) || targets.some(r => !db.canAccessRunner(owner, r.runnerId))) {
            throw new AssistantRefusal("The granting owner cannot access every affected skill and Machine.");
          }
          if (fenced && a.expectedRevision !== skillLibraryRevision(deps)) throw new AssistantRefusal("Skill Library revision changed. Read the current resource and review its impact again.");
          return {skills: skills.map(s => ({id: s.id, impact: db.skillDeploymentImpact(s.id)})),
            targets: targets.map(r => ({runnerId: r.runnerId, online: hub.isRunnerOnline(r.runnerId)}))};
        };
        const execute = async () => {
          const params = {id: target(a).id, assignmentId: a.assignmentId, operationId: a.recoveryId};
          let effectStarted = false;
          let result;
          try {
            result = await (name === "skill_assignments" ? core : service).execute(route, {
              get principal() {return authorize();}, params, body: a.payload ?? {}, query: {},
              recheck: async () => {await ctx.recheck(); scope();}, beforeEffect: () => {scope();},
              effectStarted: () => {effectStarted = true;}});
          } catch (error) {
            if (mutation && effectStarted) throw new Error("A skill effect may have committed. Reconcile the command receipt and current state under authorized access.");
            throw error;
          }
          if (result.status >= 400 && mutation && effectStarted) throw new Error("A skill effect may have committed before the service refused further work. Reconcile its receipt and current state.");
          if (result.status >= 500) throw new Error("Skill operation outcome is uncertain. Inspect command_get and the current owner resource before any retry.");
          if (result.status >= 400) throw new AssistantRefusal(`Skill operation refused (${result.status}). ${String((result.body as {error?: string})?.error ?? "Inspect the owner API requirements.")}`);
          // Check live access after asynchronous runner/network work before exposing private files.
          try {await ctx.recheck(); authorize();} catch {
            if (mutation) throw new Error("Access changed while the operation ran. Reconcile its receipt through an authorized connection.");
            throw new AssistantRefusal("Access changed while reading the resource. Restore the connection's current access.");
          }
          return {data: result.body, revision: skillLibraryRevision(deps)};
        };
        if (!mutation) return execute();
        return mutations.run({connection: db.assistantConnections.get(ctx.connection.id)!, operation: name,
          args: {...a, operationId: text(a.commandId, "commandId")}, target: target(a), destructive,
          recheck: ctx.recheck, impact: scope, execute, resourceId: () => target(a).id});
      }});
  }
}
