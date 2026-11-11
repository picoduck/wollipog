import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CreateOutboundEventSubscriptionRequest } from "@wollipog/protocol";
import { AssistantRefusal, type AssistantOperations } from "./assistant-connections.js";
import type { AssistantDestinationBinding } from "./assistant-work.js";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import type { OutboundEventsService } from "./outbound-events.js";
import { AssistantConnectionManagement } from "./assistant-connection-management.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("Expected an argument object.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128) throw new AssistantRefusal("A bounded resource ID is required.");
  return value;
}

/** Minimal source-checked notice, shared by MCP and the credential-scoped trusted sender. */
export function assistantWorkView(db: ControlPlaneDb, operations: AssistantOperations, connectionId: string, workId: string) {
  const work = db.assistantWork.authorize(operations, connectionId, workId);
  const session = db.getSession(work.sessionId)!;
  const requests = session.pendingApproval ? [session.pendingApproval, ...(session.pendingApproval.additionalRequests ?? [])] : [];
  return {work, resolution: {kind: "wollipog_session", sessionId: session.id, eventEpoch: session.eventEpoch,
    path: `/sessions/~${Buffer.from(session.id, "utf16le").toString("base64url")}`,
    requests: requests.map(request => ({requestId: request.requestId, occurrenceId: request.occurrenceId, kind: request.kind,
      path: `/sessions/~${Buffer.from(session.id, "utf16le").toString("base64url")}/attention/~${Buffer.from(request.requestId, "utf16le").toString("base64url")}?epoch=${session.eventEpoch ?? 0}`})),
    ordinaryChatGrantsApproval: false}};
}

export function registerAssistantWorkOperations(db: ControlPlaneDb, operations: AssistantOperations): void {
  db.assistantWork.useOperations(operations);
  const target = (args: unknown) => {
    const session = db.getSession(text(record(args).sessionId));
    if (!session) throw new AssistantRefusal("Session not found.");
    return {kind: "session", id: session.id, ...(session.projectId ? {projectId: session.projectId} : {})};
  };
  const schema = {type: "object", properties: {sessionId: {type: "string"}, workId: {type: "string"},
    bindingId: {type: "string"}, operationId: {type: "string"}}, required: ["sessionId", "workId"], additionalProperties: false};
  operations.register({name: "assistant_work_track", description: "Track existing work using an explicit owner-issued destination binding. This grants no session mutation authority.",
    inputSchema: {...schema, required: ["sessionId", "workId", "bindingId"]}, resolveTarget: target, ownerCanAccess: (owner, resource) => db.canAccessSession(owner, resource.id),
    execute: (args, context) => {
      const input = record(args);
      return db.assistantWork.track(operations, context.connection.id, {workId: text(input.workId),
        sessionId: text(input.sessionId), bindingId: text(input.bindingId),
        ...(input.operationId === undefined ? {} : {operationId: text(input.operationId)})});
    }});
  operations.register({name: "assistant_work_read", description: "Read current authorized work state and attention resolution coordinates. Reply content requires a separate current source-access check.",
    inputSchema: {type: "object", properties: {sessionId: {type: "string"}, workId: {type: "string"}}, required: ["sessionId", "workId"], additionalProperties: false},
    resolveTarget: target, ownerCanAccess: (owner, resource) => db.canAccessSession(owner, resource.id),
    execute: (args, context) => {
      const input = record(args);
      const work = db.assistantWork.authorize(operations, context.connection.id, text(input.workId));
      if (work.sessionId !== input.sessionId) throw new AssistantRefusal("Work belongs to another session.");
      return assistantWorkView(db, operations, context.connection.id, work.workId);
    }});
  operations.register({name: "assistant_work_reconcile", description: "Page current authorized work after reconnect or missed webhooks. Persist each work revision and follow nextAfter, including empty filtered pages.",
    inputSchema: {type: "object", properties: {projectId: {type: "string"}, after: {type: "string"}, limit: {type: "integer", minimum: 1, maximum: 100}}, additionalProperties: false},
    resolveTarget: args => { const projectId = record(args).projectId; return projectId === undefined
      ? {kind: "control_plane", id: db.instanceId()} : {kind: "project", id: text(projectId), projectId: text(projectId)}; },
    ownerCanAccess: (owner, resource) => resource.kind === "control_plane" || db.canAccessProject(owner, resource.id),
    execute: (args, context) => {
      const input = record(args);
      const page = db.assistantWork.reconcile(operations, context.connection.id,
        input.after === undefined ? "" : text(input.after), input.limit === undefined ? 100 : input.limit as number);
      if (input.projectId !== undefined) page.items = page.items.filter(work => db.getSession(work.sessionId)?.projectId === input.projectId);
      return page;
    }});
}

export function registerAssistantWorkOwnerRoutes(app: FastifyInstance, deps: {
  db: ControlPlaneDb; outboundEvents: OutboundEventsService;
  requestHuman(req: FastifyRequest): HumanPrincipal | null;
}): void {
  const management = new AssistantConnectionManagement(deps.db);
  const owner = (req: FastifyRequest) => {
    const principal = deps.requestHuman(req), connectionId = text((req.params as {id: string}).id);
    if (!principal) throw new AssistantRefusal("Assistant connection not found for this owner.");
    management.connection(principal, connectionId);
    return {principal, connectionId};
  };
  const handle = (action: (req: FastifyRequest) => unknown | Promise<unknown>) => async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
    reply.header("cache-control", "no-store");
    try { return await action(req); }
    catch (error) { if (error instanceof AssistantRefusal) return reply.code(400).send({error: error.message}); throw error; }
  };
  const subscriptionId = (req: FastifyRequest): string => {
    const {principal, connectionId} = owner(req);
    const id = text((req.params as {subscriptionId: string}).subscriptionId);
    management.subscription(principal, connectionId, id);
    return id;
  };
  app.get("/api/assistant-connections/:id/event-subscriptions/:subscriptionId", handle(req => {
    const {principal, connectionId} = owner(req);
    return management.subscription(principal, connectionId, text((req.params as {subscriptionId: string}).subscriptionId));
  }));
  app.get("/api/assistant-connections/:id/event-subscriptions/:subscriptionId/deliveries", handle(req => {
    const {principal, connectionId} = owner(req);
    return management.deliveries(principal, connectionId, text((req.params as {subscriptionId: string}).subscriptionId), deps.outboundEvents);
  }));
  app.post("/api/assistant-connections/:id/event-subscriptions/:subscriptionId/rotate", handle(req =>
    deps.outboundEvents.rotate(subscriptionId(req)).data));
  app.post("/api/assistant-connections/:id/event-subscriptions/:subscriptionId/resume", handle(req => {
    const {principal, connectionId} = owner(req);
    return management.resume(principal, connectionId, text((req.params as {subscriptionId: string}).subscriptionId), deps.outboundEvents);
  }));
  app.delete("/api/assistant-connections/:id/event-subscriptions/:subscriptionId", handle(req =>
    deps.outboundEvents.revoke(subscriptionId(req)).data));
  app.post("/api/assistant-connections/:id/destination-bindings", handle(req => {
    const {principal, connectionId} = owner(req);
    return deps.db.assistantWork.createBinding(principal, connectionId, record(req.body) as unknown as Omit<AssistantDestinationBinding, "id" | "connectionId" | "revision" | "revoked">);
  }));
  app.get("/api/assistant-connections/:id/destination-bindings", handle(req => {
    const {principal, connectionId} = owner(req);
    return management.bindings(principal, connectionId);
  }));
  app.get("/api/assistant-connections/:id/event-subscriptions", handle(req => {
    const {principal, connectionId} = owner(req);
    return management.subscriptions(principal, connectionId);
  }));
  app.delete("/api/assistant-connections/:id/destination-bindings/:bindingId", handle(req => {
    const {principal, connectionId} = owner(req);
    deps.db.assistantWork.revokeBinding(principal, connectionId, text((req.params as {bindingId: string}).bindingId));
    return {revoked: true};
  }));
  app.post("/api/assistant-connections/:id/event-subscriptions", handle(async req => {
    const {principal, connectionId} = owner(req), body = record(req.body);
    const result = await deps.outboundEvents.create({...body, scope: {kind: "assistant", connectionId},
      includeSessionName: false, includeQuestionTitle: false} as unknown as CreateOutboundEventSubscriptionRequest,
      {kind: "human", id: principal.userId}, Date.now(), body.privateAddresses as string[] | undefined);
    if (!result.ok) throw new AssistantRefusal(result.error ?? "Callback configuration failed.");
    return result.data;
  }));
}
