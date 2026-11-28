import { randomUUID } from "node:crypto";
import {
  ASSISTANT_OWNER_CONFIRMATION_TTL_MS,
  type AssistantAutomationConfirmationPreview,
  type AssistantAutomationTargetDisplay,
  type AutomationCreationSnapshot,
  type AutomationSpec,
} from "@wollipog/protocol";
import { nextCronFire } from "@wollipog/protocol/cron-schedule";
import { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";
import { assistantRequestDigest, type AssistantCommandReceipt, type AssistantCommandReceipts } from "./assistant-command-receipts.js";
import { AssistantRefusal, assistantCallContext, type AssistantOperations, type AssistantTarget } from "./assistant-connections.js";
import { automationManagementTargets, ownerCanAccessAutomation } from "./assistant-automation-authority.js";
import { automationPayloadSchema } from "./assistant-management-schemas.js";
import { ASSISTANT_AUTOMATION_PROPOSE, type OwnerConfirmationBinding } from "./assistant-owner-confirmations.js";
import { validateAutomationSpec } from "./automations.js";
import { prepareAutomationCreationSpec } from "./automation-creation.js";
import type { ControlPlaneDb } from "./db.js";
import type { ScheduledCampaignRuntime } from "./scheduled-campaigns.js";
import { auditDigest } from "./sessions.js";

const COMMAND_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

const autoProposeSchema = {
  type: "object",
  properties: {
    commandId: { type: "string", description: "Stable caller command ID. Reconcile with command_get before retrying." },
    payload: automationPayloadSchema,
  },
  required: ["commandId", "payload"],
  additionalProperties: false,
};

interface ProposeArgs {
  commandId: string;
  payload: unknown;
  confirmationId?: unknown;
}

class AlreadyReserved {
  constructor(readonly receipt: AssistantCommandReceipt) {}
}

function parseArgs(value: unknown): ProposeArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssistantRefusal("Supply commandId and a complete automation payload.");
  }
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => key !== "commandId" && key !== "payload" && key !== "confirmationId")) {
    throw new AssistantRefusal("auto_propose accepts only commandId and payload.");
  }
  if (typeof args.commandId !== "string" || !COMMAND_ID.test(args.commandId)) {
    throw new AssistantRefusal("commandId must contain 1–128 letters, digits, dots, colons, underscores or hyphens. Reconcile that ID before retrying.");
  }
  if (!args.payload || typeof args.payload !== "object" || Array.isArray(args.payload)) {
    throw new AssistantRefusal("payload must be a complete AutomationSpec object.");
  }
  return { commandId: args.commandId, payload: args.payload, ...(args.confirmationId !== undefined ? { confirmationId: args.confirmationId } : {}) };
}

function parseSpec(payload: unknown): AutomationSpec {
  const parsed = validateAutomationSpec(payload);
  if (!parsed.ok) throw new AssistantRefusal(parsed.error ?? "Automation configuration is invalid.");
  return parsed.data!;
}

function buildTargetDisplay(db: ControlPlaneDb, spec: AutomationSpec): { display: AssistantAutomationTargetDisplay; label: string } {
  const action = spec.action;
  if (action.kind === "prompt_session") {
    const session = db.getSession(action.sessionId);
    const project = session?.projectId ? db.getProject(session.projectId) : null;
    const runner = session ? db.getRunner(session.runnerId) : null;
    const workspace = runner?.workspaces.find((w) => w.id === session?.workspaceId);
    const runnerName = runner?.displayName || runner?.hostname || null;
    const sessionTitle = session?.title ?? null;
    return {
      display: {
        sessionTitle,
        projectName: project?.name ?? null,
        runnerName,
        workspaceName: workspace?.name ?? null,
        workspacePath: workspace?.path ?? null,
      },
      label: [spec.name, sessionTitle || action.sessionId].filter(Boolean).join(" · "),
    };
  }
  if (action.kind !== "create_session") {
    return { display: {}, label: spec.name };
  }
  const req = action.request;
  const project = req.projectId ? db.getProject(req.projectId) : null;
  const location = req.projectLocationId ? db.projectLocation(req.projectLocationId) : null;
  const runner = db.getRunner(req.runnerId);
  const workspace = runner?.workspaces.find((w) => w.id === req.workspaceId);
  const runnerName = runner?.displayName || runner?.hostname || null;
  return {
    display: {
      projectName: project?.name ?? null,
      locationName: location?.name ?? null,
      locationPath: location?.path ?? null,
      runnerName,
      workspaceName: workspace?.name ?? null,
      workspacePath: workspace?.path ?? null,
    },
    label: [spec.name, location?.name ?? workspace?.name ?? req.workspaceId, runnerName ?? req.runnerId].filter(Boolean).join(" · "),
  };
}

/** Registers `auto_propose` (#4976): lets a built-in Assistant thread submit a complete
 * automation (standalone session or scheduled Orchestrator campaign) for owner approval in
 * Wollipog. Once approved, saves the exact configuration atomically as an owner-authorized
 * schedule with its own limits, independent of the originating thread's lifetime. */
export function registerAssistantAutomationPropose(
  operations: AssistantOperations,
  deps: {
    db: ControlPlaneDb;
    campaigns?: ScheduledCampaignRuntime;
    receipts: AssistantCommandReceipts;
    now?: () => number;
  },
): void {
  const { db, campaigns, receipts } = deps;
  const confirmations = new AssistantCommandConfirmations(db.raw(), db.assistantOwnerConfirmations);
  const currentTime = () => deps.now?.() ?? Date.now();

  const resolveTarget = (value: unknown): AssistantTarget => {
    const args = parseArgs(value);
    const submitted = parseSpec(args.payload);
    const targets = automationManagementTargets(db, submitted);
    return { kind: "automation", id: "new", ...(targets[0]?.projectId ? { projectId: targets[0].projectId } : {}) };
  };

  operations.register({
    name: ASSISTANT_AUTOMATION_PROPOSE,
    threadOnly: true,
    destructive: true,
    description: "Propose a complete recurring automation (standalone session or Orchestrator campaign) for owner approval in Wollipog. Saves as an owner-authorized schedule once approved; inspect with command_get and auto_get.",
    inputSchema: autoProposeSchema,
    resolveTarget,
    ownerCanAccess: (owner, target) =>
      db.automationCreationHuman(owner.userId, owner.organizationId) !== null &&
      (!target.projectId || db.canAccessProject(owner, target.projectId)),
    execute: async (value, context) => {
      const { confirmationId, ...args } = parseArgs(value);
      if (!context.connection.threadId) {
        throw new AssistantRefusal("Only a Wollipog Assistant thread can propose an automation for owner approval.");
      }
      const approvedId = assistantCallContext.getStore()?.ownerConfirmationId;
      if (confirmationId !== undefined && !approvedId) {
        throw new AssistantRefusal("Only the owner can approve this automation in Wollipog. Nothing was created.");
      }
      const argumentsDigest = assistantRequestDigest(args);
      const prior = receipts.get(context.connection.id, args.commandId);
      if (prior) {
        if (prior.operation !== ASSISTANT_AUTOMATION_PROPOSE || prior.argumentsDigest !== argumentsDigest) {
          throw new AssistantRefusal("This command ID already belongs to another request. Read command_get before retrying.");
        }
        const automation = prior.resourceId ? db.getAutomation(prior.resourceId) : null;
        return {
          receipt: prior,
          ...(automation ? { automation } : {}),
          recovery: "This automation proposal already ran. Read command_get and auto_get to inspect the saved schedule; do not submit it again.",
        };
      }

      const owner = await context.recheck();
      const live = db.assistantConnections.get(context.connection.id);
      if (!live || live.revoked || !live.threadId) {
        throw new AssistantRefusal("The thread's Assistant connection is no longer active.");
      }
      const thread = db.assistantThreads.forConnection(live.id);
      if (!thread) throw new AssistantRefusal("The Assistant thread is no longer active.");

      const human = db.automationCreationHuman(owner.userId, owner.organizationId);
      if (!human) {
        throw new AssistantRefusal("Only an active owner or admin of the personal organization can approve automations.");
      }

      const submittedSpec = parseSpec(args.payload);
      const authorizeTargets = (configuration: Pick<AutomationSpec, "action" | "runnerPolicy">) => {
        if (!ownerCanAccessAutomation(db, human, configuration)) {
          throw new AssistantRefusal("The granting owner cannot access every automation target.");
        }
        const targets = automationManagementTargets(db, configuration);
        if (live.grant.projects !== "all" && targets.some((t) => !t.projectId || !live.grant.projects.includes(t.projectId))) {
          throw new AssistantRefusal("An automation target is outside the selected projects. The owner can adjust Assistant Connections.");
        }
        return targets;
      };
      authorizeTargets(submittedSpec);

      const prepared = prepareAutomationCreationSpec({ db, campaigns }, human, submittedSpec);
      if (!prepared.ok) throw new AssistantRefusal(prepared.error ?? "Automation configuration is invalid.");
      const { spec, targetDigest, effectiveTargets } = prepared.data!;
      const resolvedTargets = authorizeTargets(spec);
      const target: AssistantTarget = {
        kind: "automation",
        id: "new",
        ...(resolvedTargets[0]?.projectId ? { projectId: resolvedTargets[0].projectId } : {}),
      };

      const now = currentTime();
      let previewNextFireAt: number;
      try {
        previewNextFireAt = nextCronFire(spec.cron, spec.timezone, now);
      } catch (error) {
        throw new AssistantRefusal((error as Error).message);
      }

      const campaignDecisionsRaw = spec.action.kind === "create_session" && spec.action.request.campaign
        ? (campaigns ? campaigns.previewSpec(spec, human) : { error: "Scheduled campaigns are unavailable on this server" })
        : null;
      if (campaignDecisionsRaw && "error" in campaignDecisionsRaw) {
        throw new AssistantRefusal(campaignDecisionsRaw.error);
      }
      const campaignDecisions = campaignDecisionsRaw ?? undefined;

      const { display: targetDisplay, label: targetLabel } = buildTargetDisplay(db, spec);
      const bindingDigest = auditDigest({
        targetDigest,
        specDigest: auditDigest(spec),
        campaignDecisions: campaignDecisions ?? null,
      })!;
      const binding: OwnerConfirmationBinding = {
        connectionId: live.id,
        grantRevision: live.revision,
        operation: ASSISTANT_AUTOMATION_PROPOSE,
        argumentsDigest,
        targetDigest: bindingDigest,
      };

      if (!approvedId) {
        const snapshot: AutomationCreationSnapshot = {
          category: "automation_creation",
          spec,
          nextFireAt: previewNextFireAt,
          targetDigest,
          requestedSpecDigest: auditDigest(args.payload)!,
          effectiveTargets,
          expiresAt: now + ASSISTANT_OWNER_CONFIRMATION_TTL_MS,
        };
        const automationPreview: AssistantAutomationConfirmationPreview = {
          digest: bindingDigest,
          snapshot,
          targetDisplay,
          ...(campaignDecisions ? { campaignDecisions } : {}),
        };
        return confirmations.preview(
          binding,
          { commandId: args.commandId, args, target, targetLabel, automation: automationPreview },
          {
            operation: ASSISTANT_AUTOMATION_PROPOSE,
            nextFireAt: previewNextFireAt,
            enabled: spec.enabled,
            effectiveTargets,
            ...(campaignDecisions ? { campaignDecisions } : {}),
          },
          now,
        );
      }

      let createNextFireAt: number | null;
      try {
        createNextFireAt = spec.enabled ? nextCronFire(spec.cron, spec.timezone, now) : null;
      } catch (error) {
        throw new AssistantRefusal((error as Error).message);
      }
      const automationId = `auto_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      try {
        const saved = db.createAutomation({
          automationId,
          spec,
          nextFireAt: createNextFireAt,
          actor: { kind: "human", id: human.userId },
          now,
          eventDetail: { ownerConfirmationId: approvedId, commandId: args.commandId, targetDigest: bindingDigest },
          beforeInsert: () => {
            const reserved = receipts.reserve(
              {
                controlPlaneId: db.instanceId(),
                connectionId: live.id,
                operationId: args.commandId,
                operation: ASSISTANT_AUTOMATION_PROPOSE,
                argumentsDigest,
                grantRevision: live.revision,
                target,
              },
              () => confirmations.consume(String(confirmationId), binding, now),
            );
            if (!reserved.created) throw new AlreadyReserved(reserved.receipt);
          },
          afterInsert: (created) => {
            if (created.automationId !== automationId ||
                (Object.keys(spec) as Array<keyof AutomationSpec>).some((key) => auditDigest(created[key]) !== auditDigest(spec[key]))) {
              throw new Error("Automation creation readback failed; inspect the durable receipt before retrying.");
            }
            receipts.settle(live.id, args.commandId, "succeeded", created.automationId);
          },
        });
        return { receipt: receipts.get(live.id, args.commandId), automation: saved };
      } catch (error) {
        if (error instanceof AlreadyReserved) {
          const automation = error.receipt.resourceId ? db.getAutomation(error.receipt.resourceId) : null;
          return { receipt: error.receipt, ...(automation ? { automation } : {}) };
        }
        throw error;
      }
    },
  });
}
