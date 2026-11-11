import { AssistantRefusal, type AssistantOperations, type AssistantTarget } from "./assistant-connections.js";
import type { ControlPlaneDb } from "./db.js";
import type { AutomationsService } from "./automations.js";
import type { ManagementMutations } from "./assistant-management-command.js";
import { automationManagementTargets, ownerCanAccessAutomation } from "./assistant-automation-authority.js";
import { assistantRequestDigest } from "./assistant-command-receipts.js";

/** Trigger creation/rotation issue a standing inbound signing credential and remain owner-only. */
export function registerAssistantTriggerParity(operations: AssistantOperations, db: ControlPlaneDb,
  service: AutomationsService, mutations: ManagementMutations): void {
  for (const name of ["auto_triggers", "auto_trigger_remove"] as const) {
    const target = (value: unknown): AssistantTarget => {
      const a = value as Record<string, unknown> | null;
      const schedule = typeof a?.automationId === "string" ? db.getAutomation(a.automationId) : null;
      if (!schedule) throw new AssistantRefusal("Automation not found.");
      return {kind: "automation", id: schedule.automationId, projectId: automationManagementTargets(db, schedule)[0]?.projectId};
    };
    const revision = (id: string) => assistantRequestDigest({scheduleRevision: db.getAutomation(id)?.revision,
      // generation is monotonic across same-timestamp credential rotations; no secret is read.
      triggers: db.listAutomationTriggers(id)});
    operations.register({name, description: name === "auto_triggers" ? "List trigger metadata without stored signing credentials."
      : "Remove a trigger with revision fencing and the owner's destructive confirmation policy.",
      inputSchema: {type: "object", additionalProperties: false, properties: {automationId: {type: "string"},
        triggerId: {type: "string"}, commandId: {type: "string"}, confirmationId: {type: "string"}, expectedRevision: {type: "string"}},
        required: name === "auto_triggers" ? ["automationId"] : ["automationId", "triggerId", "commandId", "expectedRevision"]},
      resolveTarget: target, ownerCanAccess: (owner, t) => {
        const schedule = db.getAutomation(t.id);
        return !!schedule && ownerCanAccessAutomation(db, owner, schedule);
      },
      execute: async (value, ctx) => {
        const a = value as Record<string, unknown>, t = target(a);
        const impact = () => {
          const owner = operations.authorize(ctx.connection.id, name, target(a));
          const schedule = db.getAutomation(t.id)!, targets = automationManagementTargets(db, schedule);
          if (!ownerCanAccessAutomation(db, owner, schedule)) throw new AssistantRefusal("The owner cannot access every automation target.");
          const grant = db.assistantConnections.get(ctx.connection.id)!.grant;
          if (grant.projects !== "all" && targets.some(target => !target.projectId || !grant.projects.includes(target.projectId))) {
            throw new AssistantRefusal("An affected automation target is outside this connection's selected projects.");
          }
          return {targets, triggers: db.listAutomationTriggers(t.id).filter(trigger => name === "auto_triggers" || trigger.triggerId === a.triggerId)};
        };
        if (name === "auto_triggers") { impact(); return {...service.triggers(t.id).data, revision: revision(t.id)}; }
        return mutations.run({connection: db.assistantConnections.get(ctx.connection.id)!, operation: name,
          args: {...a, operationId: a.commandId}, target: t, destructive: true, recheck: ctx.recheck,
          impact: () => {
            const affected = impact();
            if (typeof a.expectedRevision !== "string" || a.expectedRevision !== revision(t.id)) throw new AssistantRefusal("Trigger revision changed. Read auto_triggers again.");
            if (typeof a.triggerId !== "string") throw new AssistantRefusal("triggerId is required.");
            return affected;
          }, execute: () => {
            const result = service.deleteTrigger(t.id, a.triggerId as string, {kind: "agent", id: ctx.connection.id});
            if (!result.ok) throw new AssistantRefusal(result.error ?? "Trigger removal refused.");
            return {data: result.data, revision: revision(t.id)};
          }, resourceId: () => t.id});
      }});
  }
}
