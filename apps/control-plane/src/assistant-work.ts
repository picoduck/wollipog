import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HumanPrincipal } from "./identity.js";
import { AssistantRefusal, type AssistantConnections, type AssistantOperations } from "./assistant-connections.js";
import type { ControlPlaneDb } from "./db.js";

export interface AssistantDestinationBinding {
  id: string;
  connectionId: string;
  requesterId: string;
  accountId: string;
  conversationId: string;
  destination: string;
  agentId: string;
  sessionKey: string;
  projects: "all" | string[];
  revision: number;
  revoked: boolean;
}
export interface AssistantWork {
  controlPlaneId: string;
  connectionId: string;
  workId: string;
  sessionId: string;
  bindingId: string;
  operationId?: string;
  revision: number;
  status: string;
  attentionRevision: number;
}

function bounded(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AssistantRefusal(`A bounded ${label} is required.`);
  }
  return value;
}

/** Protected correlation data stays in SQLite, never in outbound event bodies or activity logs.
 * A binding is standing destination authority and can only be issued by its connection's owner.
 * It does not authenticate inbound Discord messages; the trusted connector must supply that fact. */
export class AssistantWorkStore {
  private operations?: AssistantOperations;
  useOperations(operations: AssistantOperations): void { this.operations = operations; }
  attachAcceptedOrigin(origin: {connectionId: string; commandId: string}, sessionId: string): AssistantWork {
    if (!this.operations) throw new AssistantRefusal("Assistant work operations are not initialized.");
    return this.attachOrigin(this.operations, origin.connectionId, origin.commandId, sessionId);
  }
  authorizedForSession(connectionId: string, sessionId: string): AssistantWork[] {
    if (!this.operations) return [];
    return this.forSession(sessionId).filter(work => work.connectionId === connectionId).flatMap(work => {
      try { return [this.authorize(this.operations!, connectionId, work.workId)]; }
      catch (error) { if (error instanceof AssistantRefusal) return []; throw error; }
    });
  }

  authorizeDelivery(connectionId: string, payload: string): boolean {
    if (!this.operations) return false;
    const envelope = JSON.parse(payload) as {sessionId: string; assistant?: {
      controlPlaneId: string; connectionId: string; work: {workId: string}[];
    }};
    const origin = envelope.assistant;
    if (!origin || origin.controlPlaneId !== this.db.instanceId() || origin.connectionId !== connectionId || !origin.work.length) return false;
    return origin.work.every(reference => {
      try { return this.authorize(this.operations!, connectionId, reference.workId).sessionId === envelope.sessionId; }
      catch (error) { if (error instanceof AssistantRefusal) return false; throw error; }
    });
  }
  static install(sql: DatabaseSync): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_destination_bindings (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, data_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(connection_id) REFERENCES assistant_connections(id));
      CREATE TABLE IF NOT EXISTS assistant_work (
      connection_id TEXT NOT NULL, work_id TEXT NOT NULL, session_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, operation_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL, attention_revision INTEGER NOT NULL,
      PRIMARY KEY(connection_id,work_id),
      FOREIGN KEY(connection_id) REFERENCES assistant_connections(id),
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(binding_id) REFERENCES assistant_destination_bindings(id));
      CREATE INDEX IF NOT EXISTS assistant_work_session ON assistant_work(session_id);
      CREATE TABLE IF NOT EXISTS assistant_work_origins (
      connection_id TEXT NOT NULL, command_id TEXT NOT NULL, work_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, requester_id TEXT NOT NULL, project_id TEXT, session_id TEXT,
      PRIMARY KEY(connection_id,command_id), UNIQUE(connection_id,work_id),
      FOREIGN KEY(connection_id) REFERENCES assistant_connections(id),
      FOREIGN KEY(binding_id) REFERENCES assistant_destination_bindings(id));
      CREATE TABLE IF NOT EXISTS assistant_reply_intents (
      connection_id TEXT NOT NULL, work_id TEXT NOT NULL, revision INTEGER NOT NULL,
      binding_revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','uncertain','confirmed','blocked')),
      message_id TEXT, PRIMARY KEY(connection_id,work_id,revision),
      FOREIGN KEY(connection_id,work_id) REFERENCES assistant_work(connection_id,work_id));
      CREATE TRIGGER IF NOT EXISTS assistant_work_status AFTER UPDATE OF status ON sessions
      WHEN OLD.status<>NEW.status BEGIN
        UPDATE assistant_work SET status=NEW.status,revision=revision+1 WHERE session_id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS assistant_work_attention AFTER UPDATE OF revision ON session_attention
      WHEN OLD.revision<>NEW.revision BEGIN
        UPDATE assistant_work SET attention_revision=NEW.revision,revision=revision+1 WHERE session_id=NEW.session_id;
      END;
      CREATE TRIGGER IF NOT EXISTS assistant_work_attention_initial AFTER INSERT ON session_attention BEGIN
        UPDATE assistant_work SET attention_revision=NEW.revision,revision=revision+1 WHERE session_id=NEW.session_id;
      END;`);
  }

  constructor(private sql: DatabaseSync, private db: ControlPlaneDb,
    private connections: AssistantConnections) {}

  private atomic<T>(work: () => T): T {
    this.sql.exec("SAVEPOINT assistant_work_write");
    try { const result = work(); this.sql.exec("RELEASE assistant_work_write"); return result; }
    catch (error) { this.sql.exec("ROLLBACK TO assistant_work_write; RELEASE assistant_work_write"); throw error; }
  }

  private owner(owner: HumanPrincipal, connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.revoked || owner.kind !== "human" || owner.role !== "owner" ||
        owner.userId !== connection.ownerUserId || owner.organizationId !== connection.organizationId) {
      throw new AssistantRefusal("Assistant connection not found for this owner.");
    }
  }

  createBinding(owner: HumanPrincipal, connectionId: string, input: Omit<AssistantDestinationBinding,
    "id" | "connectionId" | "revision" | "revoked">): AssistantDestinationBinding {
    this.owner(owner, connectionId);
    const requesterId = bounded(input.requesterId, "requester identity");
    const accountId = bounded(input.accountId, "Discord account");
    const conversationId = bounded(input.conversationId, "conversation");
    const destination = bounded(input.destination, "destination");
    const agentId = bounded(input.agentId, "agent ID");
    const sessionKey = bounded(input.sessionKey, "conversation key", 512);
    // Only explicit Discord destinations. DM isolation is a connector configuration requirement.
    if (!/^(channel|user):[0-9]{1,32}$/.test(destination) ||
        !sessionKey.startsWith(`agent:${agentId}:discord:`) ||
        (destination.startsWith("channel:") && sessionKey !== `agent:${agentId}:discord:channel:${destination.slice(8)}`) ||
        (destination.startsWith("user:") && sessionKey !== `agent:${agentId}:discord:${accountId}:direct:${destination.slice(5)}`) ||
        (input.projects !== "all" && (!Array.isArray(input.projects) || input.projects.length > 500 ||
          input.projects.some(project => typeof project !== "string" || !this.db.getProject(project))))) {
      throw new AssistantRefusal("Specify an explicit Discord destination, matching agent conversation key and existing projects.");
    }
    const data = { requesterId, accountId, conversationId, destination, agentId, sessionKey, projects: input.projects };
    const id = `adb_${randomUUID()}`;
    this.sql.prepare("INSERT INTO assistant_destination_bindings(id,connection_id,data_json) VALUES (?,?,?)")
      .run(id, connectionId, JSON.stringify(data));
    return this.binding(connectionId, id)!;
  }

  binding(connectionId: string, id: string): AssistantDestinationBinding | null {
    const row = this.sql.prepare("SELECT * FROM assistant_destination_bindings WHERE id=? AND connection_id=?")
      .get(id, connectionId) as {data_json: string; revision: number; revoked: number} | undefined;
    return row ? { ...JSON.parse(row.data_json), id, connectionId, revision: row.revision, revoked: !!row.revoked } : null;
  }

  revokeBinding(owner: HumanPrincipal, connectionId: string, bindingId: string): void {
    this.owner(owner, connectionId);
    this.sql.prepare("UPDATE assistant_destination_bindings SET revoked=1,revision=revision+1 WHERE id=? AND connection_id=?")
      .run(bindingId, connectionId);
  }

  /** No private destination coordinates leave this service through the model's work tools. */
  get(connectionId: string, workId: string): AssistantWork | null {
    const row = this.sql.prepare("SELECT * FROM assistant_work WHERE connection_id=? AND work_id=?")
      .get(connectionId, workId) as {session_id: string; binding_id: string; operation_id: string | null;
        revision: number; status: string; attention_revision: number} | undefined;
    return row ? {controlPlaneId: this.db.instanceId(), connectionId, workId, sessionId: row.session_id,
      bindingId: row.binding_id, ...(row.operation_id ? {operationId: row.operation_id} : {}),
      revision: row.revision, status: row.status, attentionRevision: row.attention_revision} : null;
  }

  authorize(operations: AssistantOperations, connectionId: string, workId: string): AssistantWork {
    const work = this.get(connectionId, workId);
    const session = work && this.db.getSession(work.sessionId);
    const binding = work && this.binding(connectionId, work.bindingId);
    if (!work || !session || !binding || binding.revoked ||
        (binding.projects !== "all" && (!session.projectId || !binding.projects.includes(session.projectId)))) {
      throw new AssistantRefusal("Work or its current destination binding is unavailable. The owner must review the binding.");
    }
    operations.authorize(connectionId, "assistant_work_read", {kind: "session", id: session.id,
      ...(session.projectId ? {projectId: session.projectId} : {})});
    return work;
  }

  track(operations: AssistantOperations, connectionId: string, input: {
    workId: string; sessionId: string; bindingId: string; operationId?: string;
  }): AssistantWork {
    bounded(input.workId, "work ID", 128);
    if (!/^[\w.:-]{1,128}$/.test(input.workId)) throw new AssistantRefusal("Work IDs must use letters, numbers, dots, colons, underscores or hyphens.");
    if (input.operationId !== undefined) bounded(input.operationId, "operation ID", 128);
    return this.atomic(() => {
      const prior = this.get(connectionId, input.workId);
      if (prior) {
        if (prior.sessionId !== input.sessionId || prior.bindingId !== input.bindingId || prior.operationId !== input.operationId) {
          throw new AssistantRefusal("Work identity was reused with different correlation data.");
        }
        return this.authorize(operations, connectionId, input.workId);
      }
      const session = this.db.getSession(input.sessionId);
      if (!session) throw new AssistantRefusal("Session not found.");
      if (!this.binding(connectionId, input.bindingId)) throw new AssistantRefusal("Destination binding not found.");
      const count = this.sql.prepare("SELECT COUNT(*) AS n FROM assistant_work WHERE connection_id=? AND session_id=?")
        .get(connectionId, input.sessionId) as {n: number};
      if (count.n >= 100) throw new AssistantRefusal("This session already has 100 work correlations for this connection. Reuse its existing work identity.");
      this.sql.prepare(`INSERT INTO assistant_work(connection_id,work_id,session_id,binding_id,operation_id,status,attention_revision)
        VALUES (?,?,?,?,?,?,?)`).run(connectionId, input.workId, input.sessionId, input.bindingId,
        input.operationId ?? null, session.status, session.attention?.revision ?? 0);
      return this.authorize(operations, connectionId, input.workId);
    });
  }

  /** Called by the session command service's receipt-reservation associate callback, AFTER
   * authorizing the actual launch/prompt. Requester identity must come from trusted connector
   * ingress, never a model-supplied MCP argument. The savepoint nests in receipt reservation. */
  reserveOrigin(connectionId: string, input: {commandId: string; workId: string; bindingId: string;
    requesterId: string; projectId?: string}): void {
    bounded(input.commandId, "command ID", 128);
    if (!/^[\w.:-]{1,128}$/.test(input.workId)) throw new AssistantRefusal("A canonical work ID is required.");
    const binding = this.binding(connectionId, input.bindingId), connection = this.connections.get(connectionId);
    if (!connection || connection.revoked || !binding || binding.revoked || binding.requesterId !== input.requesterId ||
        (binding.projects !== "all" && (!input.projectId || !binding.projects.includes(input.projectId)))) {
      throw new AssistantRefusal("The authenticated requester or project is excluded by this destination binding.");
    }
    const prior = this.sql.prepare("SELECT * FROM assistant_work_origins WHERE connection_id=? AND command_id=?")
      .get(connectionId, input.commandId) as {work_id: string; binding_id: string; requester_id: string; project_id: string | null} | undefined;
    if (prior) {
      if (prior.work_id !== input.workId || prior.binding_id !== input.bindingId || prior.requester_id !== input.requesterId ||
          prior.project_id !== (input.projectId ?? null)) throw new AssistantRefusal("Command origin identity conflicts with its accepted work.");
      return;
    }
    this.sql.prepare("INSERT INTO assistant_work_origins VALUES (?,?,?,?,?,?,NULL)")
      .run(connectionId, input.commandId, input.workId, input.bindingId, input.requesterId, input.projectId ?? null);
  }

  /** Invoke in the session creation transaction before staging session.created. For an existing
   * session, invoke within command reservation. Persisted origins survive an uncertain launch. */
  attachOrigin(operations: AssistantOperations, connectionId: string, commandId: string, sessionId: string): AssistantWork {
    return this.atomic(() => {
      const origin = this.sql.prepare("SELECT * FROM assistant_work_origins WHERE connection_id=? AND command_id=?")
        .get(connectionId, commandId) as {work_id: string; binding_id: string; requester_id: string; project_id: string | null; session_id: string | null} | undefined;
      const session = this.db.getSession(sessionId);
      if (!origin || !session || (origin.session_id && origin.session_id !== sessionId) || (session.projectId ?? null) !== origin.project_id) {
        throw new AssistantRefusal("Session does not match its accepted command origin.");
      }
      this.reserveOrigin(connectionId, {commandId, workId: origin.work_id, bindingId: origin.binding_id,
        requesterId: origin.requester_id, ...(origin.project_id ? {projectId: origin.project_id} : {})});
      const work = this.track(operations, connectionId, {workId: origin.work_id, bindingId: origin.binding_id, sessionId, operationId: commandId});
      this.sql.prepare("UPDATE assistant_work_origins SET session_id=? WHERE connection_id=? AND command_id=?").run(sessionId, connectionId, commandId);
      return work;
    });
  }

  /** State recovery is independent of webhook success. No delivery-journal cursor is needed.
   * Bounded pages use an immutable work ID cursor; clients compare per-work revisions. */
  reconcile(operations: AssistantOperations, connectionId: string, after = "", limit = 100): {
    items: AssistantWork[]; nextAfter: string | null;
  } {
    if (typeof after !== "string" || after.length > 128 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AssistantRefusal("Use a work ID cursor and a page size from 1 to 100.");
    }
    const rows = this.sql.prepare("SELECT work_id FROM assistant_work WHERE connection_id=? AND work_id>? ORDER BY work_id LIMIT ?")
      .all(connectionId, after, limit + 1) as {work_id: string}[];
    const page = rows.slice(0, limit);
    const items = page.flatMap(row => {
      try {
        const work = this.authorize(operations, connectionId, row.work_id);
        const session = this.db.getSession(work.sessionId)!;
        const attention = session.attention?.revision ?? 0;
        this.sql.prepare(`UPDATE assistant_work SET status=?,attention_revision=?,revision=revision+1
          WHERE connection_id=? AND work_id=? AND (status<>? OR attention_revision<>?)`)
          .run(session.status, attention, connectionId, row.work_id, session.status, attention);
        return [this.get(connectionId, row.work_id)!];
      } catch (error) { if (error instanceof AssistantRefusal) return []; throw error; }
    });
    return {items, nextAfter: rows.length > limit ? page.at(-1)!.work_id : null};
  }

  forSession(sessionId: string): AssistantWork[] {
    const rows = this.sql.prepare("SELECT connection_id,work_id FROM assistant_work WHERE session_id=?")
      .all(sessionId) as {connection_id: string; work_id: string}[];
    return rows.map(row => this.get(row.connection_id, row.work_id)!);
  }

  /** Persist before entering Discord. A crash/timeout leaves an uncertain receipt which cannot
   * be replayed automatically. Only a real Discord message ID confirms a reply. */
  beginReply(operations: AssistantOperations, connectionId: string, workId: string, revision: number): {state: string} {
    return this.atomic(() => {
      const work = this.authorize(operations, connectionId, workId);
      if (work.revision !== revision) throw new AssistantRefusal("Work revision changed; reconcile before replying.");
      const binding = this.binding(connectionId, work.bindingId)!;
      this.sql.prepare(`INSERT OR IGNORE INTO assistant_reply_intents VALUES (?,?,?,?,'pending',NULL)`)
        .run(connectionId, workId, revision, binding.revision);
      const row = this.sql.prepare("SELECT state FROM assistant_reply_intents WHERE connection_id=? AND work_id=? AND revision=?")
        .get(connectionId, workId, revision) as {state: string};
      if (row.state === "pending") {
        this.sql.prepare("UPDATE assistant_reply_intents SET state='uncertain' WHERE connection_id=? AND work_id=? AND revision=?")
          .run(connectionId, workId, revision);
        return {state: "send"};
      }
      return {state: row.state};
    });
  }

  confirmReply(operations: AssistantOperations, connectionId: string, workId: string, revision: number, messageId: string): void {
    bounded(messageId, "Discord message receipt", 128);
    if (!/^[0-9]{1,32}$/.test(messageId)) throw new AssistantRefusal("A Discord message ID is required to confirm delivery.");
    const work = this.authorize(operations, connectionId, workId);
    const binding = this.binding(connectionId, work.bindingId)!;
    const changed = this.sql.prepare(`UPDATE assistant_reply_intents SET state='confirmed',message_id=?
      WHERE connection_id=? AND work_id=? AND revision=? AND binding_revision=?
      AND (state='uncertain' OR (state='confirmed' AND message_id=?))`)
      .run(messageId, connectionId, workId, revision, binding.revision, messageId);
    if (!changed.changes) throw new AssistantRefusal("Reply receipt conflicts or the destination binding changed.");
  }
}
