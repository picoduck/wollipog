import { AssistantRefusal, type AssistantOperations, type AssistantTarget } from "./assistant-connections.js";
import { AssistantConnectionManagement } from "./assistant-connection-management.js";
import { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";
import { assistantRequestDigest, type AssistantCommandReceipts } from "./assistant-command-receipts.js";
import type { ControlPlaneDb } from "./db.js";
import type { OutboundEventsService } from "./outbound-events.js";

const str = {type: "string", minLength: 1, maxLength: 128};
export const ASSISTANT_CONNECTION_OPERATIONS = [
  ["connection_list", "GET /api/assistant-connections"],
  ["connection_activity", "GET /api/assistant-connections/:id/activity"],
  ["dest_list", "GET /api/assistant-connections/:id/destination-bindings"],
  ["sub_list", "GET /api/assistant-connections/:id/event-subscriptions"],
  ["sub_get", "GET /api/assistant-connections/:id/event-subscriptions/:subscriptionId"],
  ["delivery_list", "GET /api/assistant-connections/:id/event-subscriptions/:subscriptionId/deliveries"],
  ["delivery_resume", "POST /api/assistant-connections/:id/event-subscriptions/:subscriptionId/resume"],
  ["install_name", "POST /api/assistant-connections/installation"],
] as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("An argument object is required.");
  return value as Record<string, unknown>;
}
function id(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !/^[\w.:-]{1,128}$/.test(value)) throw new AssistantRefusal(`${key} must be a bounded resource or command ID.`);
  return value;
}

/** Installation-wide metadata/recovery uses all-project authority, never a model-supplied
 * project label. Connections remain scoped to the current granting user AND organization. */
export function registerAssistantConnectionOperations(operations: AssistantOperations, deps: {
  db: ControlPlaneDb; outbound: OutboundEventsService; receipts: AssistantCommandReceipts;
}) {
  const {db, outbound, receipts} = deps;
  const management = new AssistantConnectionManagement(db);
  AssistantCommandConfirmations.install(db.raw());
  const confirmations = new AssistantCommandConfirmations(db.raw());
  for (const [name] of ASSISTANT_CONNECTION_OPERATIONS) {
    const mutation = name === "delivery_resume" || name === "install_name";
    const scoped = name !== "connection_list" && name !== "install_name";
    const subscription = name === "sub_get" || name === "delivery_list" || name === "delivery_resume";
    const properties = {...(scoped ? {connectionId: str} : {}), ...(subscription ? {subscriptionId: str} : {}),
      ...(name === "install_name" ? {name: {type: "string", minLength: 1, maxLength: 80}} : {}),
      ...(mutation ? {commandId: str, confirmationId: str} : {})};
    const target = (value: unknown): AssistantTarget => scoped
      ? {kind: "assistant_connection", id: id(object(value), "connectionId")}
      : {kind: "control_plane", id: db.instanceId()};
    operations.register({name,
      description: ({connection_list: "List this owner's Assistant connections, current grants, installation and accessible projects. Requires all-project access.",
        connection_activity: "Read an owned connection's bounded operation activity, without arguments or results.",
        dest_list: "Inspect owner-established requester/destination bindings; cannot create or change standing destination authority.",
        sub_list: "List an owned connection's subscription metadata without signing credentials.",
        sub_get: "Inspect one owned subscription's current delivery configuration and pause state.",
        delivery_list: "Read a bounded delivery journal with content-minimized status and error codes; does not fetch results or resend events.",
        delivery_resume: "Resume an existing owner-authorized callback. Honors destructiveConfirmation; does not rotate credentials, expand grants or replay terminal deliveries. Reconcile commandId before retrying.",
        install_name: "Rename this installation through the owner service; requires an all-project grant from a personal-organization owner. Reconcile commandId before retrying."})[name],
      inputSchema: {type: "object", properties, additionalProperties: false,
        required: [...(scoped ? ["connectionId"] : []), ...(subscription ? ["subscriptionId"] : []),
          ...(name === "install_name" ? ["name"] : []), ...(mutation ? ["commandId"] : [])]},
      resolveTarget: target,
      ownerCanAccess: (owner, resource) => {
        if (resource.kind === "control_plane") return resource.id === db.instanceId();
        const connection = db.assistantConnections.get(resource.id);
        if (resource.kind === "assistant_connection_receipt") return name === "delivery_resume" && !!connection?.revoked &&
          connection.ownerUserId === owner.userId && connection.organizationId === owner.organizationId;
        if (resource.kind !== "assistant_connection") return false;
        return !!connection && (name === "connection_activity" || !connection.revoked) &&
          connection.ownerUserId === owner.userId && connection.organizationId === owner.organizationId;
      },
      execute: async (value, ctx) => {
        const args = object(value);
        if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new AssistantRefusal("Unknown connection-management argument.");
        await ctx.recheck();
        const connectionId = scoped ? id(args, "connectionId") : "";
        const subscriptionId = subscription ? id(args, "subscriptionId") : "";
        const read = () => {
          if (name === "connection_list") return management.list(ctx.owner, operations);
          if (name === "connection_activity") return management.activity(ctx.owner, connectionId);
          if (name === "dest_list") return management.bindings(ctx.owner, connectionId);
          if (name === "sub_list") return management.subscriptions(ctx.owner, connectionId);
          if (name === "sub_get") return management.subscription(ctx.owner, connectionId, subscriptionId);
          if (name === "delivery_list") return management.deliveries(ctx.owner, connectionId, subscriptionId, outbound)?.map(({error, ...row}) => ({...row,
            ...(error ? {error: row.statusCode === undefined ? "delivery_transport_or_policy_error" : "callback_http_error"} : {})}));
          throw new AssistantRefusal("Unknown connection-management read.");
        };
        if (!mutation) {
          const result = read();
          await ctx.recheck();
          return result;
        }
        const commandId = id(args, "commandId"), current = db.assistantConnections.get(ctx.connection.id)!;
        const {confirmationId, ...request} = args;
        const identity = {controlPlaneId: db.instanceId(), connectionId: current.id, operationId: commandId, operation: name,
          argumentsDigest: assistantRequestDigest({name, request}), grantRevision: current.revision, target: target(args)};
        // Reservation checks operation and arguments even for duplicates. No private result is
        // cached: read current state separately; an accepted/uncertain command is never replayed.
        if (receipts.get(current.id, commandId)) return {receipt: receipts.reserve(identity).receipt};
        const impact = name === "delivery_resume" ? management.subscription(ctx.owner, connectionId, subscriptionId) : {installationId: db.instanceId()};
        const binding = {connectionId: current.id, grantRevision: current.revision, operation: name,
          argumentsDigest: identity.argumentsDigest, targetDigest: assistantRequestDigest({target: identity.target, impact})};
        const confirm = name === "delivery_resume" && db.assistantConnections.destructiveConfirmation(current.id) === "confirm";
        if (confirm && confirmationId === undefined) return {confirmationRequired: true, ...confirmations.issue(binding),
          operation: name, target: identity.target, impact, recovery: "Review the callback; repeat unchanged arguments and commandId with confirmationId before expiry."};
        const reservation = receipts.reserve(identity, () => {
          operations.authorize(current.id, name, target(args));
          if (confirm) confirmations.consume(id(args, "confirmationId"), binding);
        });
        if (!reservation.created) return {receipt: reservation.receipt};
        let applied = false;
        try {
          const result = name === "install_name" ? management.rename(ctx.owner, args.name)
            : management.resume(ctx.owner, connectionId, subscriptionId, outbound);
          applied = true;
          receipts.settle(current.id, commandId, "succeeded");
          await ctx.recheck();
          return {receipt: receipts.get(current.id, commandId), result, meaning: "Application service accepted. Read current delivery state; resume does not prove callback or Discord delivery."};
        } catch (error) {
          // A post-effect access refusal cannot release the private result. settle is terminal:
          // a known synchronous success retains its verdict, without disclosing the result.
          if (error instanceof AssistantRefusal) return {receipt: receipts.settle(current.id, commandId, "failed"),
            error: applied ? "Current access changed after the application accepted the command. Inspect command_get under current authority." : error.message};
          return {receipt: receipts.settle(current.id, commandId, "uncertain"), recovery: "Inspect command_get and current state. Do not replay an uncertain mutation."};
        }
      }});
  }
}
