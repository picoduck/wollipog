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
      CREATE INDEX IF NOT EXISTS assistant_threads_owner ON assistant_threads(owner_user_id, organization_id, state);`);
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
