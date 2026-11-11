import type { InvokeSessionCommandRequest, SteerRequest } from "@wollipog/protocol";
import { AssistantRefusal, type AssistantOperations, type AssistantOperation, type AssistantTarget } from "./assistant-connections.js";
import { AssistantCommandReceipts, assistantRequestDigest } from "./assistant-command-receipts.js";
import { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";
import type { ControlPlaneDb } from "./db.js";
import type { SessionsService, ServiceResult } from "./sessions.js";
import type { createSessionQueueManagement } from "./session-queue-management.js";
import type { OwnerManagementResult } from "./owner-management.js";
import { failureBody } from "./capability-refusal.js";

const str = {type: "string"};
const images = {type: "array", items: {type: "object"}, description: "Existing authorized prompt image or workspace-reference inputs, validated by the owner service."};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("Supply an object of arguments.");
  return value as Record<string, unknown>;
}
function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new AssistantRefusal(`${key} is required.`);
  return value;
}

export const ASSISTANT_SESSION_WORK_ROUTES = {
  "GET /api/sessions/:id/queued/:promptId/edit": "queue_get",
  "POST /api/sessions/:id/queued/:promptId/edit": "queue_edit",
  "POST /api/sessions/:id/cancel-queued": "queue_cancel",
  "POST /api/sessions/:id/steer": "session_steer",
  "POST /api/sessions/:id/command-invocations": "session_invoke",
} as const;

/** Session work management shares owner queue/services, not HTTP injection or human identity.
 * Current session placement is resolved at every boundary. No prompt content enters receipts. */
export function registerAssistantSessionWork(operations: AssistantOperations, deps: {
  db: ControlPlaneDb; svc: SessionsService; receipts: AssistantCommandReceipts;
  queue: ReturnType<typeof createSessionQueueManagement>;
}) {
  const {db, svc, receipts, queue} = deps;
  AssistantCommandConfirmations.install(db.raw());
  const confirmations = new AssistantCommandConfirmations(db.raw());
  const target = (value: unknown): AssistantTarget => {
    const session = db.getSession(text(object(value), "sessionId"));
    if (!session) throw new AssistantRefusal("Session not found. Refresh session_list.");
    return {kind: "session", id: session.id, ...(session.projectId ? {projectId: session.projectId} : {})};
  };
  type Context = Parameters<AssistantOperation["execute"]>[1];
  const define = (name: string, description: string, properties: Record<string, unknown>, required: string[],
    mutate: boolean, destructive: boolean, run: (args: Record<string, unknown>) => OwnerManagementResult | Promise<OwnerManagementResult>) => {
    operations.register({name, description,
      inputSchema: {type: "object", additionalProperties: false,
        properties: {sessionId: str, ...properties, ...(mutate ? {commandId: str, confirmationId: str} : {})},
        required: ["sessionId", ...required, ...(mutate ? ["commandId"] : [])]},
      resolveTarget: target, ownerCanAccess: (owner, t) => db.canAccessSession(owner, t.id),
      execute: async (value, ctx: Context) => {
        const args = object(value);
        // Direct registry callers must obey the same closed argument contract as MCP clients.
        const allowed = new Set(["sessionId", ...Object.keys(properties), ...(mutate ? ["commandId", "confirmationId"] : [])]);
        if (Object.keys(args).some(key => !allowed.has(key))) throw new AssistantRefusal("Unknown arguments. Read this tool's current schema.");
        await ctx.recheck();
        if (!mutate) {
          let result: OwnerManagementResult;
          try { result = await run(args); }
          catch { throw new AssistantRefusal("Queue read unavailable. Check the runner connection and retry the read."); }
          await ctx.recheck();
          if (result.status >= 400) throw new AssistantRefusal("Queue read refused. Refresh the session queue and check runner compatibility.");
          return result.body;
        }
        const commandId = text(args, "commandId"), {confirmationId, ...request} = args;
        const current = db.assistantConnections.get(ctx.connection.id)!;
        const resolved = target(args), argumentsDigest = assistantRequestDigest(request);
        const identity = {controlPlaneId: db.instanceId(), connectionId: current.id, operationId: commandId,
          operation: name, argumentsDigest, grantRevision: current.revision, target: resolved};
        // A duplicate returns only the stored verdict after current authorization, never a
        // cached prompt/result or a second dispatch (including accepted after process death).
        const prior = receipts.get(current.id, commandId);
        if (prior) {
          operations.authorize(current.id, name, prior.target);
          return {receipt: receipts.reserve(identity).receipt};
        }
        const session = db.getSession(resolved.id)!;
        const impact = {sessionId: session.id, projectId: session.projectId, runnerId: session.runnerId,
          promptId: args.promptId, queue: queue.snapshot(session.id)?.queued.map(p => ({id: p.id, editRevision: p.editRevision}))};
        const binding = {connectionId: current.id, grantRevision: current.revision, operation: name,
          argumentsDigest, targetDigest: assistantRequestDigest(impact)};
        const confirm = destructive && db.assistantConnections.destructiveConfirmation(current.id) === "confirm";
        if (confirm && confirmationId === undefined) return {confirmationRequired: true, ...confirmations.issue(binding), impact};
        const reservation = receipts.reserve(identity, () => {
          if (confirm) confirmations.consume(text(args, "confirmationId"), binding);
        });
        if (!reservation.created) return {receipt: reservation.receipt};
        let result: OwnerManagementResult;
        try { result = await run(args); }
        catch {
          receipts.settle(current.id, commandId, "uncertain");
          await ctx.recheck();
          return {receipt: receipts.get(current.id, commandId), recovery: "Outcome uncertain. Read command_get and the current queue/steering/invocation state before any new command. Never replay this ID."};
        }
        const state = (result.body as {state?: string} | undefined)?.state;
        const receipt = receipts.settle(current.id, commandId,
          result.status >= 500 || state === "uncertain" ? "uncertain" : result.status >= 400 ? "failed" : "succeeded");
        await ctx.recheck();
        if (result.status >= 400 && result.status < 500) {
          const body = result.body as {error?: string};
          throw new AssistantRefusal(`${body.error ?? "Service refused the command"}. Read command_get for this command ID; correct the cause before submitting a new ID.`);
        }
        if (receipt.status === "uncertain") return {receipt, recovery: "Read the session and command_get; do not replay an uncertain command."};
        return {receipt, result: result.body, meaning: "Owner service accepted. Queue/steering/invocation state is authoritative for delivery and execution completion."};
      }});
  };
  define("session_work_get", "Read the current runner queue, active turn ID, provider command catalog and durable invocation states before managing session work.",
    {}, [], false, false, args => ({status: 200, body: queue.snapshot(text(args, "sessionId"))}));
  define("queue_get", "Read an authorized queued prompt and its editRevision before editing. Cannot read an already-started prompt.",
    {promptId: str}, ["promptId"], false, false, args => queue.read(text(args, "sessionId"), text(args, "promptId")));
  define("queue_edit", "Replace one not-yet-started prompt with an exact revision and durable submission ID. Lost or mismatched runner replies remain uncertain.",
    {promptId: str, submissionId: str, expectedRevision: str, text: str, images}, ["promptId", "submissionId", "expectedRevision", "text"], true, false,
    args => queue.edit(text(args, "sessionId"), text(args, "promptId"), {submissionId: args.submissionId, expectedRevision: args.expectedRevision, text: args.text, images: args.images}));
  define("queue_cancel", "Request cancellation of one queued prompt. Honors destructiveConfirmation; runner queue updates establish whether it was removed.",
    {promptId: str}, ["promptId"], true, true, args => queue.cancel(text(args, "sessionId"), text(args, "promptId")));
  const response = (r: ServiceResult<unknown>): OwnerManagementResult => ({status: r.status, body: r.ok ? r.data : failureBody(r)});
  define("session_steer", "Steer a running turn, or promote a queued prompt, using the owner service and durable steering submission. Cannot supply human result-review authority. Read steering_get after uncertainty.",
    {submissionId: str, turnId: str, text: str, images, promotePromptId: str}, ["submissionId", "turnId"], true, false,
    async args => response(await svc.steer(text(args, "sessionId"), {submissionId: args.submissionId, turnId: args.turnId, text: args.text, images: args.images, promotePromptId: args.promotePromptId} as SteerRequest)));
  define("session_invoke", "Invoke a current provider catalog command using its exact revision and submission ID. Existing first-message, budget, policy and provider gates remain enforced.",
    {submissionId: str, providerCommandId: str, catalogRevision: str, argumentText: str}, ["submissionId", "providerCommandId", "catalogRevision", "argumentText"], true, true,
    args => response(svc.invokeSessionCommand(text(args, "sessionId"), {submissionId: args.submissionId, providerCommandId: args.providerCommandId, catalogRevision: args.catalogRevision, argumentText: args.argumentText} as InvokeSessionCommandRequest)));
}
