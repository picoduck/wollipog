import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AssistantThreadHarness } from "@wollipog/protocol";
import type { HumanPrincipal } from "./identity.js";

/** Stored lifecycle. `creating` covers the window between reserving the id and recording the
 * backing session; such a row is never listed. The live status is derived from the session. */
export type StoredThreadState = "creating" | "active" | "archived";

export interface ThreadRow {
  id: string;
  owner_user_id: string;
  organization_id: string;
  assistant: "wollipog";
  title: string | null;
  harness: AssistantThreadHarness;
  session_id: string | null;
  connection_id: string | null;
  state: StoredThreadState;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

/** Persistence for Wollipog Assistant threads (#4663). Owner-scoped: a thread is its owner's
 * conversation, so even another owner of the organization never reads it. */
export class AssistantThreadStore {
  static install(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_threads (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      assistant TEXT NOT NULL CHECK (assistant IN ('wollipog')),
      -- NULL follows the backing session's title, which is generated from the first message.
      title TEXT,
      harness TEXT NOT NULL CHECK (harness IN ('claude-code','codex')),
      session_id TEXT UNIQUE,
      -- The thread-scoped Assistant connection, once minted.
      connection_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('creating','active','archived')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER);
      CREATE INDEX IF NOT EXISTS assistant_threads_owner ON assistant_threads(owner_user_id, organization_id, state);
      -- Sessions a thread's assistant launched (#4663): its work cards and its launch limit.
      CREATE TABLE IF NOT EXISTS assistant_thread_launches (
        session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS assistant_thread_launches_thread ON assistant_thread_launches(thread_id, created_at);
      -- Every session in a launched session's tree, recorded at creation so its cost stays the
      -- thread's even after a parent between them is deleted.
      -- A deleted member keeps its row and its final cost, within its own tree.
      CREATE TABLE IF NOT EXISTS assistant_thread_members (
        session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        root_session_id TEXT NOT NULL,
        retired_cost_usd REAL,
        -- A deleted root's cap, still held while any member of its tree lives.
        retired_cap_usd REAL);
      CREATE INDEX IF NOT EXISTS assistant_thread_members_thread ON assistant_thread_members(thread_id, root_session_id);`);
    // The backing session's final cost, if it was deleted: spend is never refunded by deletion.
    try { db.exec("ALTER TABLE assistant_threads ADD COLUMN retired_cost_usd REAL NOT NULL DEFAULT 0"); } catch { /* column already present */ }
    // The backing session's cost cap as the thread last set it. A different current cap was set by
    // the owner, and the thread then only ever lowers it.
    try { db.exec("ALTER TABLE assistant_threads ADD COLUMN backing_cap_usd REAL"); } catch { /* column already present */ }
    // The owner's own ceiling for the backing session, once the owner set one: never exceeded.
    try { db.exec("ALTER TABLE assistant_threads ADD COLUMN backing_owner_cap_usd REAL"); } catch { /* column already present */ }
    // Every launch is a member, with every existing descendant in its tree. Idempotent.
    db.exec(`INSERT OR IGNORE INTO assistant_thread_members (session_id, thread_id, root_session_id)
        SELECT session_id, thread_id, session_id FROM assistant_thread_launches;
      INSERT OR IGNORE INTO assistant_thread_members (session_id, thread_id, root_session_id)
        WITH RECURSIVE tree(id, thread_id, root) AS (
          SELECT session_id, thread_id, session_id FROM assistant_thread_launches
          UNION SELECT child.id, tree.thread_id, tree.root FROM sessions child JOIN tree ON child.parent_session_id=tree.id)
        SELECT id, thread_id, root FROM tree;`);
  }

  constructor(private readonly db: DatabaseSync) {}

  get(id: string): ThreadRow | null {
    return (this.db.prepare("SELECT * FROM assistant_threads WHERE id=?").get(id) as ThreadRow | undefined) ?? null;
  }

  forSession(sessionId: string): ThreadRow | null {
    return (this.db.prepare("SELECT * FROM assistant_threads WHERE session_id=?").get(sessionId) as ThreadRow | undefined) ?? null;
  }

  listForOwner(userId: string, organizationId: string, includeArchived: boolean): ThreadRow[] {
    return this.db.prepare(`SELECT * FROM assistant_threads WHERE owner_user_id=? AND organization_id=?
      AND state ${includeArchived ? "IN ('active','archived')" : "='active'"}`).all(userId, organizationId) as unknown as ThreadRow[];
  }

  reserve(owner: HumanPrincipal, harness: AssistantThreadHarness, title: string | null, now: number): string {
    const id = `thr_${randomUUID()}`;
    this.db.prepare(`INSERT INTO assistant_threads (id, owner_user_id, organization_id, assistant, title, harness, state, created_at, updated_at)
      VALUES (?, ?, ?, 'wollipog', ?, ?, 'creating', ?, ?)`).run(id, owner.userId, owner.organizationId, title, harness, now, now);
    return id;
  }

  activate(id: string, sessionId: string, now: number): void {
    this.db.prepare("UPDATE assistant_threads SET session_id=?, state='active', updated_at=? WHERE id=? AND state='creating'").run(sessionId, now, id);
  }

  forConnection(connectionId: string): ThreadRow | null {
    return (this.db.prepare("SELECT * FROM assistant_threads WHERE connection_id=?").get(connectionId) as ThreadRow | undefined) ?? null;
  }

  recordLaunch(threadId: string, sessionId: string, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO assistant_thread_launches (session_id, thread_id, created_at) VALUES (?, ?, ?)").run(sessionId, threadId, now);
    this.db.prepare("INSERT OR IGNORE INTO assistant_thread_members (session_id, thread_id, root_session_id) VALUES (?, ?, ?)").run(sessionId, threadId, sessionId);
  }

  /** A child of a thread member joins the same launched tree. */
  inheritMembership(sessionId: string, parentSessionId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO assistant_thread_members (session_id, thread_id, root_session_id)
      SELECT ?, thread_id, root_session_id FROM assistant_thread_members WHERE session_id=?`).run(sessionId, parentSessionId);
  }

  /** Before a session row is deleted: its spend stays its thread's, in its own launched tree. */
  retireSessionCost(sessionId: string): void {
    const cost = "COALESCE((SELECT cost_usd + live_cost_usd FROM sessions WHERE id=?), 0)";
    this.db.prepare(`UPDATE assistant_thread_members SET retired_cost_usd=${cost},
        retired_cap_usd=(SELECT cost_budget_usd FROM sessions WHERE id=?)
      WHERE session_id=? AND retired_cost_usd IS NULL`).run(sessionId, sessionId, sessionId);
    this.db.prepare(`UPDATE assistant_threads SET retired_cost_usd = retired_cost_usd + ${cost} WHERE session_id=?`).run(sessionId, sessionId);
  }

  /** The same, for every session of a runner before a bulk deletion removes them all. */
  retireRunnerSessionCosts(runnerId: string): void {
    const ids = this.db.prepare("SELECT id FROM sessions WHERE runner_id=?").all(runnerId) as Array<{ id: string }>;
    for (const { id } of ids) this.retireSessionCost(id);
  }

  launchedSessionIds(threadId: string): string[] {
    return (this.db.prepare("SELECT session_id FROM assistant_thread_launches WHERE thread_id=? ORDER BY created_at, session_id")
      .all(threadId) as Array<{ session_id: string }>).map((row) => row.session_id);
  }

  /** The thread's spend so far: its backing session's cost plus every launched session's, including
   * the in-flight estimate of a running turn. */
  /** What the thread has spent, and what its launched work holds. Spend is settled plus in-flight
   * cost of the backing session and of every member of every launched tree, deleted ones included.
   * Each tree holds the larger of its spend and its root's cost cap: the part of the budget the
   * backing session can no longer use. */
  costs(threadId: string): { spentUsd: number; backingSpentUsd: number; launchedHeldUsd: number } {
    const thread = this.db.prepare(`SELECT thread.retired_cost_usd +
        COALESCE((SELECT cost_usd + live_cost_usd FROM sessions WHERE id=thread.session_id), 0) AS backing
      FROM assistant_threads thread WHERE thread.id=?`).get(threadId) as { backing: number } | undefined;
    // A deleted member counts its final cost, inside its own tree; a deleted root no longer holds a cap.
    const trees = this.db.prepare(`SELECT member.root_session_id AS root,
        COALESCE(SUM(CASE WHEN session.id IS NULL THEN COALESCE(member.retired_cost_usd, 0)
          ELSE session.cost_usd + session.live_cost_usd END), 0) AS spent,
        COALESCE((SELECT cost_budget_usd FROM sessions WHERE id=member.root_session_id),
          (SELECT retired_cap_usd FROM assistant_thread_members WHERE session_id=member.root_session_id)) AS cap,
        COUNT(session.id) AS live
      FROM assistant_thread_members member LEFT JOIN sessions session ON session.id=member.session_id
      WHERE member.thread_id=? GROUP BY member.root_session_id`).all(threadId) as Array<{ spent: number; cap: number | null; live: number }>;
    const backingSpentUsd = thread?.backing ?? 0;
    let spentUsd = backingSpentUsd, launchedHeldUsd = 0;
    for (const tree of trees) {
      spentUsd += tree.spent;
      // A tree keeps its root's cap while any member lives, even after the root itself is deleted.
      launchedHeldUsd += tree.live > 0 ? Math.max(tree.spent, tree.cap ?? 0) : tree.spent;
    }
    return { spentUsd, backingSpentUsd, launchedHeldUsd };
  }

  backingCap(threadId: string): number | null {
    return (this.db.prepare("SELECT backing_cap_usd FROM assistant_threads WHERE id=?").get(threadId) as { backing_cap_usd: number | null } | undefined)?.backing_cap_usd ?? null;
  }

  setBackingCap(threadId: string, capUsd: number): void {
    this.db.prepare("UPDATE assistant_threads SET backing_cap_usd=? WHERE id=?").run(capUsd, threadId);
  }

  backingOwnerCap(threadId: string): number | null {
    return (this.db.prepare("SELECT backing_owner_cap_usd FROM assistant_threads WHERE id=?").get(threadId) as { backing_owner_cap_usd: number | null } | undefined)?.backing_owner_cap_usd ?? null;
  }

  /** Lowers the owner's recorded ceiling to `capUsd`; it only ever goes down. */
  recordBackingOwnerCap(threadId: string, capUsd: number): void {
    this.db.prepare("UPDATE assistant_threads SET backing_owner_cap_usd=MIN(COALESCE(backing_owner_cap_usd, ?), ?) WHERE id=?").run(capUsd, capUsd, threadId);
  }

  setConnection(id: string, connectionId: string): void {
    this.db.prepare("UPDATE assistant_threads SET connection_id=? WHERE id=? AND connection_id IS NULL").run(connectionId, id);
  }

  /** Only an unfinished reservation is removed; a recorded thread is archived instead. */
  abandon(id: string): void {
    this.db.prepare("DELETE FROM assistant_threads WHERE id=? AND state='creating'").run(id);
  }

  rename(id: string, title: string, now: number): void {
    this.db.prepare("UPDATE assistant_threads SET title=?, updated_at=? WHERE id=? AND state!='creating'").run(title, now, id);
  }

  /** Idempotent: the first archive time is kept. */
  archive(id: string, now: number): void {
    this.db.prepare(`UPDATE assistant_threads SET state='archived', archived_at=COALESCE(archived_at, ?), updated_at=?
      WHERE id=? AND state='active'`).run(now, now, id);
  }
}
