import type { AutomationSpec, AutomationSchedule } from "@wollipog/protocol";
import type { HumanPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import { AutomationsService, validateAutomationSpec } from "./automations.js";
import { AssistantOperations, AssistantRefusal, type AssistantTarget } from "./assistant-connections.js";
import type { ManagementMutations } from "./assistant-management-command.js";
import { automationPayloadSchema } from "./assistant-management-schemas.js";
import { automationManagementTargets, ownerCanAccessAutomation } from "./assistant-automation-authority.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("An argument object is required.");
  return value as Record<string, unknown>;
}
function spec(value: unknown): AutomationSpec {
  const parsed = validateAutomationSpec(value);
  if (!parsed.ok) throw new AssistantRefusal(parsed.error ?? "Automation configuration is invalid.");
  return parsed.data!;
}
function specOf(schedule: AutomationSchedule): AutomationSpec {
  const {name, cron, timezone, enabled, misfirePolicy, runnerPolicy, concurrencyPolicy, limits, notifications, action} = schedule;
  return {name, cron, timezone, enabled, misfirePolicy, runnerPolicy, concurrencyPolicy, limits, notifications, action};
}

export function registerAssistantAutomations(operations: AssistantOperations, db: ControlPlaneDb,
  service: AutomationsService, mutations: ManagementMutations): void {
  const accessible = (owner: HumanPrincipal, value: AutomationSpec) => {
    return ownerCanAccessAutomation(db, owner, value);
  };
  const load = (a: Record<string, unknown>, includeDeleted = false): AutomationSchedule => {
    const schedule = typeof a.automationId === "string" ? db.getAutomation(a.automationId, includeDeleted) : null;
    if (!schedule) throw new AssistantRefusal("Automation not found.");
    return schedule;
  };
  for (const name of ["auto_list", "auto_get", "auto_create", "auto_update", "auto_enable", "auto_pause", "auto_delete"] as const) {
    const mutation = name !== "auto_list" && name !== "auto_get";
    const proposed = (a: Record<string, unknown>): AutomationSpec => name === "auto_create" || name === "auto_update"
      ? spec(a.payload) : specOf(load(a, name === "auto_delete"));
    const target = (value: unknown): AssistantTarget => {
      if (name === "auto_list") return {kind: "automation", id: "list"};
      const a = object(value), targets = automationManagementTargets(db, proposed(a));
      return {kind: "automation", id: name === "auto_create" ? "new" : load(a, name === "auto_delete").automationId, projectId: targets[0]?.projectId};
    };
    operations.register({name, description: ({auto_list: "List accessible automations and latest execution status.", auto_get: "Inspect configuration, revision, execution status and affected targets.",
      auto_create: "Create an automation using the owner's standing grant.", auto_update: "Replace an automation configuration with an expectedRevision.",
      auto_enable: "Enable or resume an automation with an expectedRevision.", auto_pause: "Pause an automation with an expectedRevision.", auto_delete: "Delete an automation under the owner's confirmation policy."})[name],
      inputSchema: {type: "object", properties: {automationId: {type: "string"}, expectedRevision: {type: "integer"},
        operationId: {type: "string"}, confirmationId: {type: "string"}, payload: automationPayloadSchema},
        required: [...(name === "auto_create" || name === "auto_list" ? [] : ["automationId"]),
          ...(mutation ? ["operationId", ...(name === "auto_create" ? [] : ["expectedRevision"]),
            ...(name === "auto_create" || name === "auto_update" ? ["payload"] : [])] : [])]},
      metadata: name === "auto_list", resolveTarget: target,
      ownerCanAccess: (owner, t) => name === "auto_list" || name === "auto_create" ||
        (!!db.getAutomation(t.id, name === "auto_delete") && accessible(owner, db.getAutomation(t.id, name === "auto_delete")!)),
      execute: async (value, context) => {
        const a = object(value);
        const authorize = (configuration: AutomationSpec) => {
          if (!accessible(context.owner, configuration)) throw new AssistantRefusal("The granting owner cannot access every automation target.");
          const current = db.assistantConnections.get(context.connection.id)!;
          const targets = automationManagementTargets(db, configuration);
          if (current.grant.projects !== "all" && targets.some(t => !t.projectId || !current.grant.projects.includes(t.projectId))) throw new AssistantRefusal("An automation target is outside the selected projects. The owner can adjust Assistant Connections.");
          return targets;
        };
        if (name === "auto_list") return {automations: service.list().automations.filter(schedule => {
          try {authorize(schedule); return true;} catch {return false;}
        })};
        if (name === "auto_get") {
          const schedule = load(a), targets = authorize(schedule);
          const result = service.get(schedule.automationId);
          return {...result.data, impact: {targets}};
        }
        let resultId: string | undefined;
        return mutations.run({connection: db.assistantConnections.get(context.connection.id)!, operation: name, args: a,
          target: target(a), destructive: name === "auto_delete", recheck: context.recheck,
          impact: () => {
            const current = name === "auto_create" ? null : load(a);
            if (current && current.revision !== a.expectedRevision) throw new AssistantRefusal("Automation revision changed. Inspect it again before editing.");
            return {targets: [...(current ? authorize(current) : []), ...authorize(proposed(a))]};
          },
          execute: () => {
            const actor = {kind: "agent" as const, id: context.connection.id};
            resultId = name === "auto_create" ? undefined : load(a).automationId;
            const result = name === "auto_create" ? service.create(proposed(a), actor, undefined, name)
              : name === "auto_delete" ? service.delete(load(a).automationId, actor)
              : service.update(load(a).automationId, name === "auto_update" ? proposed(a)
                : {...specOf(load(a)), enabled: name === "auto_enable"}, actor, undefined, name);
            if (!result.ok) throw new AssistantRefusal(result.error ?? "Automation change refused.");
            if (name === "auto_create") resultId = (result.data as AutomationSchedule).automationId;
            return result.data;
          }, resourceId: () => resultId,
        });
      }});
  }
}
