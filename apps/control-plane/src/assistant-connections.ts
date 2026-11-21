import { randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { hashToken } from "./auth.js";
import type { HumanPrincipal } from "./identity.js";

import type { AssistantGrant, AssistantConnection } from "@wollipog/protocol";
export type { AssistantGrant, AssistantConnection } from "@wollipog/protocol";
export interface AssistantTarget { kind: string; id: string; projectId?: string }
export interface AssistantCredential { connectionId: string; tokenHash: string }
/** Mutation units persist this per connection before dispatch. Unknown delivery must be reconciled,
 * never automatically replayed. IDs are client-generated and bound to an argument digest. */
export interface AssistantOperationReceipt {
  controlPlaneId: string;
  connectionId: string;
  operationId: string;
  operation: string;
  argumentsDigest: string;
  grantRevision: number;
  target: AssistantTarget;
  status: "accepted" | "running" | "succeeded" | "failed" | "uncertain";
  resourceId?: string;
}
export class AssistantRefusal extends Error {}

/** The Assistant connection whose operation is executing, for services that apply a thread's
 * limits to work it starts (#4663). Absent outside an Assistant call. `ownerConfirmationId` is
 * set only while the control plane runs a command its owner approved (#4665); nothing an
 * assistant sends can set it. */
export const assistantCallContext = new AsyncLocalStorage<{ connectionId: string; ownerConfirmationId?: string }>();

/** Operations an Assistant thread may not call: each schedules future work, turns a session into
 * one that starts its own, or (a fork) materializes a session on the runner without the session
 * creation that counts a thread's launches. Its owner can still use them directly. */
const THREAD_EXCLUDED_OPERATIONS = new Set(["auto_create", "auto_update", "auto_enable", "auto_test",
  "session_role", "session_adopt", "session_fork"]);
export class AssistantConflict extends AssistantRefusal {}
export interface AssistantActivityRecord {
  connection_id: string; grant_revision: number; operation: string;
  target_json: string; outcome: string; created_at: number;
}
export const ASSISTANT_ACTIVITY_LIMIT = 1_000;
const secret = () => `wollipoga_${randomBytes(32).toString("base64url")}`;
function displayName(value: unknown): string {
  // Joiners inside visible emoji sequences are typography, unlike invisible formatting in text.
  const text = typeof value === "string" ? value.replace(/\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F]*(?:\u200D\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F]*)+/gu, "") : "";
  if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\p{Cc}\p{Cf}]/u.test(text)) throw new AssistantRefusal("Name must contain 1–80 characters without control or hidden formatting characters.");
  return value.trim();
}

export function assistantGrant(value: unknown, defaultConfirmation: "none" | "confirm" = "none"): AssistantGrant {
  const input = value as Partial<AssistantGrant> | null;
  const valid = (v: unknown): v is "all" | string[] => v === "all" ||
    (Array.isArray(v) && v.length <= 500 && v.every(x => typeof x === "string" && /^[\w.:-]{1,128}$/.test(x)));
  if (!input || !valid(input.operations) || !valid(input.projects)) throw new AssistantRefusal("Specify exact operations and projects, or all, in the owner's connection settings.");
  if (input.destructiveConfirmation !== undefined && input.destructiveConfirmation !== "none" && input.destructiveConfirmation !== "confirm") throw new AssistantRefusal("Destructive confirmation must be none or confirm in the owner's connection settings.");
  return { operations: input.operations, projects: input.projects, destructiveConfirmation: input.destructiveConfirmation ?? defaultConfirmation };
}

/** Separate credential namespace/table: never accepted as a human, runner or session. */
export class AssistantConnections {
  private changeListeners = new Set<(connectionId: string) => void>();
  /** Cleanup hint only. Consumers MUST recheck current authority even after missed notifications. */
  onChange(listener: (connectionId: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  private changed(id: string): void {
    for (const listener of this.changeListeners) {
      try { listener(id); } catch { /* Hints cannot roll back committed authority or lose a rotated secret. */ }
    }
  }
  static install(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      organization_id TEXT NOT NULL, grant_json TEXT NOT NULL, revision INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS assistant_activity (
      id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL, grant_revision INTEGER NOT NULL,
      operation TEXT NOT NULL, target_json TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS assistant_activity_connection ON assistant_activity(connection_id, id DESC);
      CREATE TABLE IF NOT EXISTS assistant_installation (singleton INTEGER PRIMARY KEY CHECK(singleton=1), name TEXT NOT NULL);
      INSERT OR IGNORE INTO assistant_installation VALUES (1, 'Wollipog');`);
    // v384 (#4663): a Wollipog Assistant thread's own connection. Its credential is minted by the
    // thread's runner proxy and expires unless the proxy registers a fresh one in time.
    for (const column of ["thread_id TEXT", "expires_at INTEGER"]) {
      try { db.exec(`ALTER TABLE assistant_connections ADD COLUMN ${column}`); } catch { /* column already present */ }
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS assistant_connections_thread ON assistant_connections(thread_id) WHERE thread_id IS NOT NULL");
  }
  constructor(private db: DatabaseSync) {}
  get(id: string): AssistantConnection | null {
    const row = this.db.prepare(`SELECT id,name,owner_user_id,organization_id,grant_json,revision,revoked,thread_id,expires_at FROM assistant_connections WHERE id=?`).get(id) as
      { id: string; name: string; owner_user_id: string; organization_id: string; grant_json: string; revision: number; revoked: number;
        thread_id: string | null; expires_at: number | null } | undefined;
    return row ? { id: row.id, name: row.name, ownerUserId: row.owner_user_id, organizationId: row.organization_id,
      grant: assistantGrant(JSON.parse(row.grant_json)), revision: row.revision, revoked: !!row.revoked,
      ...(row.thread_id ? { threadId: row.thread_id, expiresAt: row.expires_at } : {}) } : null;
  }
  list(owner: HumanPrincipal): AssistantConnection[] {
    return (this.db.prepare("SELECT id FROM assistant_connections WHERE owner_user_id=? AND organization_id=?").all(owner.userId, owner.organizationId) as {id: string}[]).map(r => this.get(r.id)!);
  }
  create(owner: HumanPrincipal, name: string, grant: AssistantGrant): { connection: AssistantConnection; token: string } {
    if (owner.kind !== "human" || owner.role !== "owner") throw new AssistantRefusal("Only an organization owner can issue standing Assistant authority.");
    name = displayName(name);
    const id = `asst_${randomUUID()}`, token = secret();
    this.db.prepare("INSERT INTO assistant_connections (id,name,owner_user_id,organization_id,grant_json,revision,token_hash,revoked) VALUES (?,?,?,?,?,1,?,0)").run(id, name.trim(), owner.userId, owner.organizationId, JSON.stringify(assistantGrant(grant)), hashToken(token));
    return { connection: this.get(id)!, token };
  }
  /** A Wollipog Assistant thread's connection (#4663): Full Access with destructive confirmation,
   * owned by the thread's owner. It authenticates nothing until the thread's runner proxy binds
   * a credential it minted, and the owner never sees that credential. */
  createForThread(owner: HumanPrincipal, threadId: string): AssistantConnection {
    if (owner.kind !== "human" || owner.role !== "owner") throw new AssistantRefusal("Only an organization owner can start a Wollipog Assistant thread.");
    const id = `asst_${randomUUID()}`;
    // An unguessable placeholder: no token with this hash is ever revealed, and it has expired.
    this.db.prepare("INSERT INTO assistant_connections (id,name,owner_user_id,organization_id,grant_json,revision,token_hash,revoked,thread_id,expires_at) VALUES (?,?,?,?,?,1,?,0,?,0)")
      .run(id, "Wollipog Assistant Thread", owner.userId, owner.organizationId,
        JSON.stringify(assistantGrant({ operations: "all", projects: "all", destructiveConfirmation: "confirm" })), hashToken(secret()), threadId);
    return this.get(id)!;
  }
  /** Removes a thread connection whose credential was never bound, after its thread's creation
   * failed. A connection that ever authenticated is only ever revoked, keeping its activity. */
  deleteUnboundThreadConnection(id: string): void {
    this.db.prepare("DELETE FROM assistant_connections WHERE id=? AND thread_id IS NOT NULL AND expires_at=0").run(id);
  }
  forThread(threadId: string): AssistantConnection | null {
    const row = this.db.prepare("SELECT id FROM assistant_connections WHERE thread_id=?").get(threadId) as {id: string} | undefined;
    return row ? this.get(row.id) : null;
  }
  /** Binds the thread proxy's newly minted credential, replacing the previous one at once. The
   * grant is unchanged, so its revision is too. */
  bindThreadCredential(id: string, tokenHash: string, expiresAt: number): boolean {
    if (!/^[0-9a-f]{64}$/u.test(tokenHash)) return false;
    try {
      return this.db.prepare("UPDATE assistant_connections SET token_hash=?, expires_at=? WHERE id=? AND thread_id IS NOT NULL AND revoked=0")
        .run(tokenHash, expiresAt, id).changes > 0;
    } catch {
      return false; // A hash collision with another connection is refused, never shared.
    }
  }
  configure(id: string, grant: unknown, name?: unknown, expectedRevision?: number): void {
    const normalized = assistantGrant(grant, this.destructiveConfirmation(id));
    // A thread's assistant could otherwise run destructive commands its owner never saw (#4665).
    if (this.get(id)?.threadId && normalized.destructiveConfirmation !== "confirm") {
      throw new AssistantRefusal("A Wollipog Assistant thread always asks its owner before a destructive command. Narrow its operations or projects instead, or revoke the connection.");
    }
    const nextName = name === undefined ? null : displayName(name);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new AssistantRefusal("Expected revision must be a positive integer. Refresh the connection before saving.");
    const updated = this.db.prepare("UPDATE assistant_connections SET grant_json=?,name=COALESCE(?,name),revision=revision+1 WHERE id=? AND (? IS NULL OR revision=?)").run(JSON.stringify(normalized), nextName, id, expectedRevision ?? null, expectedRevision ?? null);
    if (updated.changes === 0) throw new AssistantConflict("This connection changed in another window. Refresh and inspect the current grant before saving again.");
    this.changed(id);
  }
  rotate(id: string): string {
    if (this.get(id)?.threadId) throw new AssistantRefusal("A Wollipog Assistant thread's credential is held by its proxy and rotates on its own. Archive the thread or revoke this connection instead.");
    const token = secret();
    const updated = this.db.prepare("UPDATE assistant_connections SET token_hash=?,revision=revision+1 WHERE id=? AND revoked=0").run(hashToken(token), id);
    if (updated.changes === 0) throw new AssistantRefusal("Assistant connection is missing or revoked. Create a new connection instead.");
    this.changed(id);
    return token;
  }
  revoke(id: string): void {
    this.db.prepare("UPDATE assistant_connections SET revoked=1,revision=revision+1 WHERE id=?").run(id);
    this.changed(id);
  }
  authenticate(token: string | null): AssistantCredential | null {
    if (!token || !/^wollipoga_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = hashToken(token);
    const row = this.db.prepare("SELECT id FROM assistant_connections WHERE token_hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at > ?)").get(tokenHash, Date.now()) as {id: string} | undefined;
    return row ? { connectionId: row.id, tokenHash } : null;
  }
  current(credential: AssistantCredential): AssistantConnection {
    const row = this.db.prepare("SELECT id FROM assistant_connections WHERE id=? AND token_hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at > ?)").get(credential.connectionId, credential.tokenHash, Date.now());
    if (!row) throw new AssistantRefusal("Assistant credential was rotated or revoked, or it expired. The owner must issue a new credential in Assistant Connections.");
    return this.get(credential.connectionId)!;
  }
  installationName(): string { return (this.db.prepare("SELECT name FROM assistant_installation WHERE singleton=1").get() as {name: string}).name; }
  renameInstallation(name: unknown): void { this.db.prepare("UPDATE assistant_installation SET name=? WHERE singleton=1").run(displayName(name)); }
  /** Read live policy immediately before a destructive operation or its confirmation preview.
   * Sibling operation services implement preview + short-lived confirmation IDs for confirm. */
  destructiveConfirmation(connectionId: string): "none" | "confirm" {
    const connection = this.get(connectionId);
    if (!connection || connection.revoked) throw new AssistantRefusal("Assistant connection is missing or revoked. Create a new connection instead.");
    return connection.grant.destructiveConfirmation ?? "none";
  }
  activity(id: string): AssistantActivityRecord[] { return this.db.prepare("SELECT connection_id,grant_revision,operation,target_json,outcome,created_at FROM assistant_activity WHERE connection_id=? ORDER BY id DESC LIMIT 100").all(id) as unknown as AssistantActivityRecord[]; }
  lastUsedAt(id: string): number | null {
    const latest = this.db.prepare("SELECT created_at FROM assistant_activity WHERE connection_id=? ORDER BY id DESC LIMIT 1").get(id);
    return latest ? Number(latest.created_at) : null;
  }
  record(connection: AssistantConnection, operation: string, target: AssistantTarget, outcome: "succeeded" | "refused" | "failed"): void {
    // Only registered names and resolved resource identifiers. Never arguments or exception messages.
    this.db.prepare("INSERT INTO assistant_activity(connection_id,grant_revision,operation,target_json,outcome,created_at) VALUES (?,?,?,?,?,?)").run(connection.id, connection.revision, operation, JSON.stringify(target), outcome, Date.now());
    this.db.prepare(`DELETE FROM assistant_activity WHERE connection_id=? AND id <= (
      SELECT id FROM assistant_activity WHERE connection_id=? ORDER BY id DESC LIMIT 1 OFFSET ?
    )`).run(connection.id, connection.id, ASSISTANT_ACTIVITY_LIMIT);
  }
}

export interface AssistantOperation {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Explicit metadata-only operations may run with a selected-project grant and no target. */
  metadata?: boolean;
  /** Only built-in Assistant thread connections can call this operation. */
  threadOnly?: boolean;
  /** Can ask for destructive confirmation (for some arguments, at least). Each such operation's
   * owner confirmation card needs its own impact sentence (#4675). */
  destructive?: boolean;
  resolveTarget(args: unknown): AssistantTarget | Promise<AssistantTarget>;
  /** Must use existing application resource access rules, never session ancestry. */
  ownerCanAccess(owner: HumanPrincipal, target: AssistantTarget): boolean;
  execute(args: unknown, context: { owner: HumanPrincipal; connection: AssistantConnection; recheck(): Promise<HumanPrincipal> }): unknown | Promise<unknown>;
}

/** Every registered operation's name: also bounds the names a discovery request may echo back. */
export const ASSISTANT_OPERATION_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** Single inventory for every Assistant transport. Full Access includes future registrations. */
export class AssistantOperations {
  private operations = new Map<string, AssistantOperation>();
  constructor(
    readonly connections: AssistantConnections,
    private ownerPrincipal: (userId: string, organizationId: string) => HumanPrincipal | null,
    private threadChangingHarness?: (threadId: string) => boolean,
  ) {}
  register(operation: AssistantOperation): void {
    if (!ASSISTANT_OPERATION_NAME.test(operation.name) || this.operations.has(operation.name)) throw new Error("Invalid or duplicate Assistant operation");
    this.operations.set(operation.name, operation);
  }
  list(connection: AssistantConnection): AssistantOperation[] {
    return [...this.operations.values()].filter((operation) => (!operation.threadOnly || connection.threadId) &&
      (connection.grant.operations === "all" || connection.grant.operations.includes(operation.name)));
  }
  inventory(): { name: string; description: string }[] {
    return [...this.operations.values()].map(({name, description}) => ({name, description}));
  }
  /** Names of the operations that can ask for destructive confirmation. */
  destructive(): string[] {
    return [...this.operations.values()].filter(operation => operation.destructive).map(operation => operation.name).sort();
  }
  /** Background delivery/result reads use connection identity, not a retained bearer secret.
   * This rechecks current owner authority, grant and resource access. No campaign ancestry. */
  authorize(connectionId: string, name: string, target: AssistantTarget): HumanPrincipal {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.revoked) throw new AssistantRefusal("Assistant connection is revoked. The owner must create a new connection.");
    const operation = this.operations.get(name);
    if (!operation) throw new AssistantRefusal("Operation is not registered. Upgrade the control plane or select a registered operation.");
    if (operation.threadOnly && !connection.threadId) {
      throw new AssistantRefusal("This operation requires an explicit grant to a Wollipog Assistant thread.");
    }
    const owner = this.ownerPrincipal(connection.ownerUserId, connection.organizationId);
    if (!owner || owner.role !== "owner") throw new AssistantRefusal("The granting owner is no longer an active owner. An active owner must recreate this connection.");
    if (connection.grant.operations !== "all" && !connection.grant.operations.includes(name)) throw new AssistantRefusal(`Operation ${name} is excluded. The owner can allow it in Assistant Connections.`);
    if (connection.threadId && THREAD_EXCLUDED_OPERATIONS.has(name)) {
      throw new AssistantRefusal(`A Wollipog Assistant thread cannot call ${name}: it schedules work outside the thread's limits. Ask your owner to do it.`);
    }
    if (!operation.metadata && connection.grant.projects !== "all" && (!target.projectId || !connection.grant.projects.includes(target.projectId))) throw new AssistantRefusal("The target project is excluded by this connection. The owner can select it or grant all projects in Assistant Connections.");
    if (!operation.ownerCanAccess(owner, target)) throw new AssistantRefusal("The granting owner cannot access this target. Restore the owner's resource access or use another connection.");
    return owner;
  }
  async call(credential: AssistantCredential, name: string, args: unknown): Promise<unknown> {
    return this.run(() => this.connections.current(credential), name, args);
  }
  /** Runs the exact command a thread's owner approved (#4665), as the thread's connection under
   * its current grant and owner, authorized live like any call. The thread's credential is not
   * needed: the approval came from the owner, not the assistant. Only within this run can the
   * command's receipt reservation spend `ownerConfirmationId`. */
  async callOwnerApproved(connectionId: string, name: string, args: unknown, ownerConfirmationId: string): Promise<unknown> {
    return this.run(() => {
      const connection = this.connections.get(connectionId);
      if (!connection?.threadId || connection.revoked) throw new AssistantRefusal("The thread's Assistant connection is revoked, so the approved command did not run.");
      return connection;
    }, name, args, ownerConfirmationId);
  }
  private async run(currentConnection: () => AssistantConnection, name: string, args: unknown, ownerConfirmationId?: string): Promise<unknown> {
    const current = () => {
      const connection = currentConnection();
      if (connection.threadId && this.threadChangingHarness?.(connection.threadId)) {
        throw new AssistantRefusal("This Assistant thread is changing harnesses. Try again when the change finishes.");
      }
      return connection;
    };
    let connection = current();
    const operation = this.operations.get(name);
    if (!operation) throw new AssistantRefusal("Operation is not registered on this control plane. Upgrade the control plane or select a registered operation.");
    let target: AssistantTarget = { kind: "operation", id: name };
    try {
      target = await operation.resolveTarget(args);
      const recheck = async () => {
        // A session can move projects while a mutation waits; never reuse its queued placement.
        target = await operation.resolveTarget(args);
        connection = current();
        return this.authorize(connection.id, name, target);
      };
      const owner = await recheck();
      const result = await assistantCallContext.run({ connectionId: connection.id, ...(ownerConfirmationId ? { ownerConfirmationId } : {}) },
        () => operation.execute(args, { owner, connection, recheck }));
      // A delivered RPC can still report a refused service command or uncertain dispatch.
      // Registered services return receipts/status, never a private error in the activity row.
      const response = result && typeof result === "object" ? result as {status?: unknown; receipt?: {status?: unknown}} : undefined;
      const failed = response?.receipt?.status === "failed" || response?.receipt?.status === "uncertain" ||
        (typeof response?.status === "number" && response.status >= 400);
      this.connections.record(connection, name, target, failed ? "failed" : "succeeded");
      return result;
    } catch (error) {
      this.connections.record(connection, name, target, error instanceof AssistantRefusal ? "refused" : "failed");
      throw error;
    }
  }
}
