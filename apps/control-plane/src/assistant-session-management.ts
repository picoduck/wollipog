import {AssistantRefusal, type AssistantOperations, type AssistantOperation, type AssistantTarget} from "./assistant-connections.js";
import {AssistantCommandReceipts, assistantRequestDigest} from "./assistant-command-receipts.js";
import {AssistantCommandConfirmations} from "./assistant-command-confirmations.js";
import type {ControlPlaneDb} from "./db.js";
import type {OwnerManagementResult} from "./owner-management.js";

export type SessionManagementContext = Parameters<AssistantOperation["execute"]>[1];
export const sessionArgumentObject = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new AssistantRefusal("Supply an object of arguments.");
  return v as Record<string, unknown>;
};
export function sessionArgumentText(a: Record<string, unknown>, key: string): string {
  if (typeof a[key] !== "string" || !(a[key] as string).trim()) throw new AssistantRefusal(`${key} is required.`);
  return a[key] as string;
}

/** Shared adapter for subsequent session-management slices. The operation services themselves
 * remain shared with owner HTTP. Additional-target checks repeat at every await boundary. */
export class AssistantSessionManagement {
  private confirmations: AssistantCommandConfirmations;
  constructor(readonly operations: AssistantOperations, readonly db: ControlPlaneDb, readonly receipts: AssistantCommandReceipts) {
    AssistantCommandConfirmations.install(db.raw());
    this.confirmations = new AssistantCommandConfirmations(db.raw());
  }
  target = (value: unknown): AssistantTarget => {
    const s = this.db.getSession(sessionArgumentText(sessionArgumentObject(value), "sessionId"));
    if (!s) throw new AssistantRefusal("Session not found. Use session_list or reconcile a deleted target with command_get.");
    return {kind: "session", id: s.id, ...(s.projectId ? {projectId: s.projectId} : {})};
  };
  register(spec: {
    name: string; description: string; properties?: Record<string, unknown>; required?: string[];
    target?: (args: unknown) => AssistantTarget; mutate?: boolean; destructive?: boolean; deletesTarget?: boolean;
    check?(args: Record<string, unknown>, ctx: SessionManagementContext): void;
    impact?(args: Record<string, unknown>, ctx: SessionManagementContext): unknown;
    run(args: Record<string, unknown>, ctx: SessionManagementContext): OwnerManagementResult | Promise<OwnerManagementResult>;
  }): void {
    const {operations, db, receipts} = this, target = spec.target ?? this.target;
    const properties = {...(spec.target ? {} : {sessionId: {type: "string"}}), ...spec.properties,
      ...(spec.mutate ? {commandId: {type: "string"}, confirmationId: {type: "string"}} : {})};
    operations.register({name: spec.name, description: spec.description,
      inputSchema: {type: "object", additionalProperties: false, properties,
        required: [...(spec.target ? [] : ["sessionId"]), ...(spec.required ?? []), ...(spec.mutate ? ["commandId"] : [])]},
      resolveTarget: target, ownerCanAccess: (owner, t) => t.kind === "session" ? db.canAccessSession(owner, t.id)
        : t.kind === "project" ? db.canAccessProject(owner, t.id)
        : t.kind === "runner" ? db.canManageRunner(owner, t.id)
          : t.kind === "receipt" ? (!t.projectId || db.canAccessProject(owner, t.projectId)) : false,
      execute: async (value, ctx) => {
        const args = sessionArgumentObject(value);
        if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new AssistantRefusal("Unknown argument. Read the current tool schema.");
        const admittedTarget = target(args);
        const recheck = async () => {
          const owner = await ctx.recheck();
          operations.authorize(ctx.connection.id, spec.name, admittedTarget);
          spec.check?.(args, {...ctx, owner});
          return owner;
        };
        await recheck();
        const checkedCtx = {...ctx, recheck};
        if (!spec.mutate) {
          const result = await spec.run(args, checkedCtx);
          await recheck();
          if (result.status >= 400) throw new AssistantRefusal((result.body as {error?: string})?.error ?? "Read refused. Refresh the session and retry.");
          return result.body;
        }
        const commandId = sessionArgumentText(args, "commandId"), {confirmationId, ...request} = args;
        const current = db.assistantConnections.get(ctx.connection.id)!, resolved = target(args);
        const argumentsDigest = assistantRequestDigest(request);
        const identity = {controlPlaneId: db.instanceId(), connectionId: current.id, operationId: commandId,
          operation: spec.name, grantRevision: current.revision, argumentsDigest, target: resolved};
        const prior = receipts.get(current.id, commandId);
        if (prior) {
          operations.authorize(current.id, spec.name, prior.target);
          return {receipt: receipts.reserve(identity).receipt};
        }
        const impact = spec.impact?.(args, checkedCtx) ?? resolved;
        const binding = {connectionId: current.id, grantRevision: current.revision, operation: spec.name,
          argumentsDigest, targetDigest: assistantRequestDigest(impact)};
        const confirm = spec.destructive && db.assistantConnections.destructiveConfirmation(current.id) === "confirm";
        if (confirm && confirmationId === undefined) return {confirmationRequired: true, ...this.confirmations.issue(binding), impact};
        const reserved = receipts.reserve(identity, () => {if (confirm) this.confirmations.consume(sessionArgumentText(args, "confirmationId"), binding);});
        if (!reserved.created) return {receipt: reserved.receipt};
        let result: OwnerManagementResult;
        try {result = await spec.run(args, checkedCtx);}
        catch {
          receipts.settle(current.id, commandId, "uncertain");
          await recheck();
          throw new AssistantRefusal("Outcome uncertain. Inspect command_get and the current resource; never replay an accepted or uncertain command.");
        }
        const body = result.body as {id?: string; state?: string} | undefined;
        const receipt = receipts.settle(current.id, commandId, result.status >= 500 || body?.state === "uncertain" ? "uncertain" : result.status >= 400 ? "failed" : "succeeded",
          result.status < 400 && typeof body?.id === "string" ? body.id : undefined);
        if (spec.deletesTarget && receipt.status === "succeeded") {
          // The resource is gone. Validate current operation/original-project authority without
          // reconstructing a deleted private resource, and return a content-free verdict.
          operations.authorize(current.id, spec.name, {...resolved, kind: "receipt"});
          return {commandId, status: receipt.status, recovery: "Use command_get to reconcile the deleted resource."};
        }
        await recheck();
        if (receipt.status === "succeeded" && typeof body?.id === "string") {
          const created = db.getSession(body.id);
          if (created) operations.authorize(current.id, spec.name, {kind: "session", id: created.id, ...(created.projectId ? {projectId: created.projectId} : {})});
        }
        if (result.status >= 400) throw new AssistantRefusal(result.status >= 500
          ? "Outcome uncertain. Inspect command_get and current state; do not replay."
          : `${(result.body as {error?: string})?.error ?? "Service refused"}. Reconcile command_get before submitting a new command.`);
        return {receipt, result: result.body, meaning: "Service admitted the operation; read current resource/delivery state for completion."};
      }});
  }
}
