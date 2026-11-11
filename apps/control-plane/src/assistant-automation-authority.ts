import type { AutomationSpec, AutomationSchedule } from "@wollipog/protocol";
import type { DatabaseSync } from "node:sqlite";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import { AssistantRefusal, type AssistantTarget } from "./assistant-connections.js";

export type AssistantAutomationOperation = "auto_create" | "auto_update" | "auto_enable" | "auto_pause";
export interface AssistantAutomationAuthorization {
  connectionId: string; operation: AssistantAutomationOperation; grantRevision: number;
  ownerUserId: string; organizationId: string; authorEventRowid: number;
}

export function installAssistantAutomationAuthority(sql: DatabaseSync): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS assistant_automation_authority (
    automation_id TEXT PRIMARY KEY, authorization_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_automation_occurrence_audit (
    id INTEGER PRIMARY KEY, automation_id TEXT NOT NULL, execution_id TEXT NOT NULL,
    connection_id TEXT NOT NULL, grant_revision INTEGER, owner_user_id TEXT NOT NULL,
    operation TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS assistant_automation_audit_schedule ON assistant_automation_occurrence_audit(automation_id,id DESC);
    CREATE INDEX IF NOT EXISTS assistant_automation_audit_execution ON assistant_automation_occurrence_audit(execution_id,outcome,id);`);
}

/** Server placement, including every alternate. Client-supplied Project labels are assertions. */
export function automationManagementTargets(db: ControlPlaneDb, value: AutomationSpec): AssistantTarget[] {
  const action = value.action;
  if (action.kind === "prompt_session") {
    const session = db.getSession(action.sessionId);
    if (!session) throw new AssistantRefusal("Automation target session is unavailable.");
    return [{kind: "session", id: session.id, projectId: session.projectId ?? undefined}];
  }
  return [action.request, ...(value.runnerPolicy.kind === "alternate" ? value.runnerPolicy.targets : [])].map(t => {
    const location = t.projectLocationId ? db.getProjectLocation(t.projectLocationId)
      : t.projectId ? db.findProjectLocationForProject(t.projectId, t.runnerId, t.workspaceId)
      : db.findProjectLocation(t.runnerId, t.workspaceId);
    if ((t.projectId || t.projectLocationId) && (!location || location.projectId !== t.projectId || location.runnerId !== t.runnerId || location.workspaceId !== t.workspaceId)) {
      throw new AssistantRefusal("Automation Project Location does not match its current Machine and workspace. Select it again.");
    }
    return {kind: "workspace", id: `${t.runnerId}/${t.workspaceId}`, projectId: location?.projectId};
  });
}

export function ownerCanAccessAutomation(db: ControlPlaneDb, owner: HumanPrincipal, value: AutomationSpec): boolean {
  if (value.action.kind === "prompt_session") return db.canAccessSession(owner, value.action.sessionId);
  return [value.action.request, ...(value.runnerPolicy.kind === "alternate" ? value.runnerPolicy.targets : [])]
    .every(t => db.canAccessRunner(owner, t.runnerId) && db.canAccessWorkspace(owner, t.runnerId, t.workspaceId) &&
      (!t.projectId || db.canAccessProject(owner, t.projectId)));
}

/** This checks standing authority, not a retained credential or a session/campaign grant. */
export function authorizeAssistantAutomation(db: ControlPlaneDb, connectionId: string,
  operation: AssistantAutomationOperation, spec: AutomationSpec): {owner: HumanPrincipal; grantRevision: number} {
  const connection = db.assistantConnections.get(connectionId);
  if (!connection || connection.revoked) throw new AssistantRefusal("assistant_connection_revoked: The schedule's Assistant connection is unavailable. The owner must reconnect and re-authorize this schedule.");
  const owner = db.operatingHumanPrincipal(connection.ownerUserId, connection.organizationId);
  if (!owner || owner.role !== "owner") throw new AssistantRefusal("assistant_owner_inactive: The granting owner is no longer active. An active owner must re-authorize this schedule.");
  if (connection.grant.operations !== "all" && !connection.grant.operations.includes(operation)) throw new AssistantRefusal(`assistant_operation_excluded: ${operation} is no longer granted. The owner can restore it in Assistant Connections or re-authorize the schedule.`);
  if (!ownerCanAccessAutomation(db, owner, spec)) throw new AssistantRefusal("assistant_owner_target_excluded: A schedule target exceeds its owner's current access. Restore that access or select an accessible target.");
  const targets = automationManagementTargets(db, spec);
  if (connection.grant.projects !== "all" && targets.some(t => !t.projectId || !connection.grant.projects.includes(t.projectId))) {
    throw new AssistantRefusal("assistant_project_excluded: A schedule target is no longer granted. The owner can select its project in Assistant Connections or reconfigure this schedule.");
  }
  return {owner, grantRevision: connection.revision};
}

function definingEvent(db: ControlPlaneDb, automationId: string): {rowid: number; actor_kind: string; actor_id: string | null} | null {
  const row = db.raw().prepare(`SELECT rowid,actor_kind,actor_id FROM automation_events WHERE automation_id=?
    AND kind IN ('created','updated','enabled','disabled','trigger_created','trigger_rotated')
    AND NOT(kind='updated' AND actor_kind='system' AND actor_id=('automation:' || automation_id)
      AND COALESCE(json_extract(detail,'$.installationPinned'),0)=1)
    ORDER BY rowid DESC LIMIT 1`).get(automationId) as {rowid: number; actor_kind: string; actor_id: string | null} | undefined;
  return row ?? null;
}

/** Bind after the defining event, inside the shared write's transaction. */
export function bindAssistantAutomation(db: ControlPlaneDb, schedule: AutomationSchedule,
  connectionId: string, operation: AssistantAutomationOperation): void {
  const {owner, grantRevision} = authorizeAssistantAutomation(db, connectionId, operation, schedule);
  const event = definingEvent(db, schedule.automationId);
  if (event?.actor_kind !== "agent" || event.actor_id !== connectionId) throw new AssistantRefusal("assistant_author_mismatch: The schedule's audit author does not match its authorizing connection. Re-authorize the schedule.");
  const authorization: AssistantAutomationAuthorization = {connectionId, operation, grantRevision,
    ownerUserId: owner.userId, organizationId: owner.organizationId, authorEventRowid: event.rowid};
  db.raw().prepare("INSERT INTO assistant_automation_authority VALUES (?,?) ON CONFLICT(automation_id) DO UPDATE SET authorization_json=excluded.authorization_json")
    .run(schedule.automationId, JSON.stringify(authorization));
}

export function assistantAutomationAuthorization(db: ControlPlaneDb, automationId: string): AssistantAutomationAuthorization | null {
  const row = db.raw().prepare("SELECT authorization_json FROM assistant_automation_authority WHERE automation_id=?").get(automationId) as {authorization_json: string} | undefined;
  return row ? JSON.parse(row.authorization_json) as AssistantAutomationAuthorization : null;
}

function occurrenceAuthorization(db: ControlPlaneDb, automationId: string, executionId?: string): AssistantAutomationAuthorization | null {
  if (!executionId) return null;
  const row = db.raw().prepare(`SELECT connection_id,operation,owner_user_id,grant_revision
    FROM assistant_automation_occurrence_audit WHERE automation_id=? AND execution_id=? AND outcome='authorized'
    ORDER BY id LIMIT 1`).get(automationId, executionId) as {connection_id: string; operation: AssistantAutomationOperation; owner_user_id: string; grant_revision: number} | undefined;
  if (!row) return null;
  // Connection ownership is immutable. Persisted occurrence identity survives later schedule edits.
  const connection = db.assistantConnections.get(row.connection_id);
  return {connectionId: row.connection_id, operation: row.operation, ownerUserId: row.owner_user_id,
    organizationId: connection?.organizationId ?? "", grantRevision: row.grant_revision, authorEventRowid: 0};
}

/** Recheck the immutable occurrence snapshot and the current schedule lineage at every boundary. */
export function scheduledAssistantOwner(db: ControlPlaneDb, schedule: AutomationSchedule, executionId?: string):
  {owner: HumanPrincipal; authorization: AssistantAutomationAuthorization} | null {
  const occurrence = occurrenceAuthorization(db, schedule.automationId, executionId);
  const authorization = occurrence ?? assistantAutomationAuthorization(db, schedule.automationId);
  if (!authorization) {
    const event = definingEvent(db, schedule.automationId);
    if (event?.actor_kind === "agent" && event.actor_id?.startsWith("asst_")) throw new AssistantRefusal("assistant_authority_missing: This schedule has no durable Assistant authorization. The owner must re-authorize its complete configuration.");
    return null;
  }
  if (!occurrence && definingEvent(db, schedule.automationId)?.rowid !== authorization.authorEventRowid) throw new AssistantRefusal("assistant_schedule_author_changed: Another actor changed the schedule. The owner must re-authorize its complete configuration.");
  const {owner, grantRevision} = authorizeAssistantAutomation(db, authorization.connectionId, authorization.operation, schedule);
  if (owner.userId !== authorization.ownerUserId || owner.organizationId !== authorization.organizationId) throw new AssistantRefusal("assistant_schedule_owner_changed: The schedule's authorizing owner changed. Re-authorize the schedule.");
  return {owner, authorization: {...authorization, grantRevision}};
}

export function auditAssistantAutomationOccurrence(db: ControlPlaneDb, automationId: string, executionId: string,
  outcome: "authorized" | "refused", reason?: string): void {
  const authorization = occurrenceAuthorization(db, automationId, executionId) ?? assistantAutomationAuthorization(db, automationId);
  if (!authorization) return;
  const connection = db.assistantConnections.get(authorization.connectionId);
  db.raw().prepare("INSERT INTO assistant_automation_occurrence_audit(automation_id,execution_id,connection_id,grant_revision,owner_user_id,operation,outcome,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(automationId, executionId, authorization.connectionId, connection?.revision ?? null,
      authorization.ownerUserId, authorization.operation, outcome, reason?.split(":", 1)[0] ?? null, Date.now());
}
