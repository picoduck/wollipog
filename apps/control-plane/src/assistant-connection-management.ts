import { AssistantRefusal, type AssistantOperations } from "./assistant-connections.js";
import type { ControlPlaneDb } from "./db.js";
import { PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import type { OutboundEventsService } from "./outbound-events.js";

/** Resolve labels only under current owner access; never show malformed historical metadata. */
export function assistantActivityTargetLabel(db: ControlPlaneDb, owner: HumanPrincipal, raw: string): string {
  let target: {kind?: unknown; id?: unknown};
  try { target = JSON.parse(raw); } catch { return "Target Unavailable"; }
  if (!target || typeof target.kind !== "string" || typeof target.id !== "string") return "Target Unavailable";
  if (target.kind === "control_plane") return target.id === db.instanceId() ? `Control Plane · ${db.assistantConnections.installationName()}` : "Control Plane (Unavailable)";
  if (target.kind === "session") return db.canAccessSession(owner, target.id) ? `Session · ${db.getSession(target.id)?.title ?? "Untitled Session"}` : "Session (Unavailable)";
  if (target.kind === "project") return db.canAccessProject(owner, target.id) ? `Project · ${db.getProject(target.id)?.name ?? "Unnamed Project"}` : "Project (Unavailable)";
  if (target.kind === "runner") {
    if (!db.canAccessRunner(owner, target.id)) return "Runner (Unavailable)";
    const runner = db.getRunner(target.id);
    return runner ? `Runner · ${runner.displayName ?? runner.hostname}` : "Runner (Unavailable)";
  }
  return "Target Unavailable";
}

/** Shared owner/Assistant application service. No credentials are selected or issued here. */
export class AssistantConnectionManagement {
  constructor(private readonly db: ControlPlaneDb) {}
  connection(owner: HumanPrincipal, id: string, includeRevoked = false) {
    const connection = this.db.assistantConnections.get(id);
    if (owner.role !== "owner" || !connection || (!includeRevoked && connection.revoked) ||
        connection.ownerUserId !== owner.userId || connection.organizationId !== owner.organizationId) {
      throw new AssistantRefusal("Assistant connection not found for this owner.");
    }
    return connection;
  }
  list(owner: HumanPrincipal, operations: AssistantOperations) {
    if (owner.role !== "owner") throw new AssistantRefusal("Only an organization owner can manage Assistant Connections.");
    return {connections: this.db.assistantConnections.list(owner),
      installation: {id: this.db.instanceId(), name: this.db.assistantConnections.installationName(), canRename: owner.organizationId === PERSONAL_ORGANIZATION_ID},
      operations: operations.inventory(), projects: this.db.listProjectsForPrincipal(owner).map(({id, name}) => ({id, name}))};
  }
  rename(owner: HumanPrincipal, name: unknown) {
    if (owner.role !== "owner" || owner.organizationId !== PERSONAL_ORGANIZATION_ID) {
      throw new AssistantRefusal("Only an owner of the installation's personal organization can rename this control plane.");
    }
    this.db.assistantConnections.renameInstallation(name);
    return {id: this.db.instanceId(), name: this.db.assistantConnections.installationName()};
  }
  activity(owner: HumanPrincipal, id: string) {
    const connection = this.connection(owner, id, true);
    return {activity: this.db.assistantConnections.activity(id).map(row => ({...row,
      assistant: {id: connection.id, name: connection.name}, targetLabel: assistantActivityTargetLabel(this.db, owner, row.target_json)}))};
  }
  bindings(owner: HumanPrincipal, id: string) {
    this.connection(owner, id);
    const rows = this.db.raw().prepare("SELECT id FROM assistant_destination_bindings WHERE connection_id=? ORDER BY id").all(id) as {id: string}[];
    return {bindings: rows.map(row => this.db.assistantWork.binding(id, row.id))};
  }
  subscriptions(owner: HumanPrincipal, id: string) {
    this.connection(owner, id);
    const rows = this.db.raw().prepare("SELECT subscription_id FROM outbound_event_subscriptions WHERE assistant_connection_id=? AND revoked_at IS NULL ORDER BY subscription_id")
      .all(id) as {subscription_id: string}[];
    return {subscriptions: rows.map(row => this.db.getOutboundEventSubscription(row.subscription_id))};
  }
  subscription(owner: HumanPrincipal, id: string, subscriptionId: string) {
    this.connection(owner, id);
    const subscription = this.db.getOutboundEventSubscription(subscriptionId);
    if (!subscription || subscription.scope.kind !== "assistant" || subscription.scope.connectionId !== id) {
      throw new AssistantRefusal("Event subscription not found for this connection owner.");
    }
    return subscription;
  }
  deliveries(owner: HumanPrincipal, id: string, subscriptionId: string, outbound: OutboundEventsService) {
    this.subscription(owner, id, subscriptionId);
    return outbound.deliveries(subscriptionId).data;
  }
  resume(owner: HumanPrincipal, id: string, subscriptionId: string, outbound: OutboundEventsService) {
    this.subscription(owner, id, subscriptionId);
    const result = outbound.resume(subscriptionId);
    if (!result.ok) throw new AssistantRefusal(result.error ?? "Delivery resume refused.");
    return result.data;
  }
}
