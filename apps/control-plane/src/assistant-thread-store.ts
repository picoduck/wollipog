import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_ASSISTANT_THREAD_LIMITS,
  type AssistantDecisionDefault,
  type AssistantDecisionDelegation,
  type AssistantDecisionGrant,
  type AssistantThreadHarness,
  type AssistantThreadHistoryEntry,
  type AssistantThreadLaunchDefaults,
  type AssistantThreadLimits,
} from "@wollipog/protocol";
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
  cost_limit_usd: number | null;
  launch_limit: number | null;
  launch_paused: number;
  decision_grant: string | null;
  decision_grant_revision: number;
}

export function threadDecisionDelegation(row: ThreadRow): AssistantDecisionDelegation {
  return {
    revision: row.decision_grant_revision,
    grant: row.decision_grant === null ? null : JSON.parse(row.decision_grant) as AssistantDecisionGrant,
  };
}

/** What a launched tree's root commits of the thread's budget: the cap it was launched with, which
 * its own cap and every descendant's are carved out of (#4671), or more if the owner raised its cap. */
const TREE_COMMITMENT_SQL = (session: string, member: string) => `CASE WHEN ${session}.cost_budget_usd IS NULL
  THEN ${member}.allowance_usd ELSE MAX(COALESCE(${member}.allowance_usd, 0), ${session}.cost_budget_usd) END`;

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
      CREATE TABLE IF NOT EXISTS assistant_thread_harness_change (
        thread_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT UNIQUE NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_thread_history (
        thread_id TEXT NOT NULL, session_id TEXT UNIQUE NOT NULL, harness TEXT NOT NULL,
        next_harness TEXT NOT NULL, switched_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assistant_thread_history_thread ON assistant_thread_history(thread_id, switched_at);
      CREATE INDEX IF NOT EXISTS assistant_threads_owner ON assistant_threads(owner_user_id, organization_id, state);
      CREATE TABLE IF NOT EXISTS assistant_thread_limit_defaults (
        owner_user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        cost_limit_usd REAL,
        launch_limit INTEGER,
        PRIMARY KEY (owner_user_id, organization_id));
      CREATE TABLE IF NOT EXISTS assistant_thread_launch_defaults (
        owner_user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        harness TEXT NOT NULL CHECK (harness IN ('claude-code','codex')),
        runner_id TEXT,
        account_ref TEXT,
        PRIMARY KEY (owner_user_id, organization_id));
      CREATE TABLE IF NOT EXISTS assistant_thread_decision_defaults (
        owner_user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        grant_json TEXT NOT NULL,
        PRIMARY KEY (owner_user_id, organization_id));
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
    // A membership table an earlier build created lacks the retirement columns, and the allowance
    // columns (#4671): the cost cap a member was given, which it shares with the children it
    // creates; the own cap the thread last set it to; and the owner's own ceiling, once they set one.
    for (const column of ["retired_cost_usd REAL", "retired_cap_usd REAL", "allowance_usd REAL", "managed_cap_usd REAL", "owner_cap_usd REAL"]) {
      try { db.exec(`ALTER TABLE assistant_thread_members ADD COLUMN ${column}`); } catch { /* column already present */ }
    }
    // The backing session's cost cap as the thread last set it. A different current cap was set by
    // the owner, and the thread then only ever lowers it.
    try { db.exec("ALTER TABLE assistant_threads ADD COLUMN backing_cap_usd REAL"); } catch { /* column already present */ }
    // The owner's own ceiling for the backing session, once the owner set one: never exceeded.
    try { db.exec("ALTER TABLE assistant_threads ADD COLUMN backing_owner_cap_usd REAL"); } catch { /* column already present */ }
    // Fixed historical defaults for rows created before owners could set limits. NULL is unlimited.
    try { db.exec("ALTER TABLE assistant_threads ADD COLUMN cost_limit_usd REAL DEFAULT 25"); } catch { /* column already present */ }
    try { db.exec("ALTER TABLE assistant_threads ADD COLUMN launch_limit INTEGER DEFAULT 10"); } catch { /* column already present */ }
    try { db.exec("ALTER TABLE assistant_threads ADD COLUMN launch_paused INTEGER NOT NULL DEFAULT 0"); } catch { /* column already present */ }
    try { db.exec("ALTER TABLE assistant_threads ADD COLUMN decision_grant TEXT"); } catch { /* column already present */ }
    try { db.exec("ALTER TABLE assistant_threads ADD COLUMN decision_grant_revision INTEGER NOT NULL DEFAULT 0"); } catch { /* column already present */ }
    // All earlier launches were subject to a budget, even when their allowance was not recorded.
    try { db.exec("ALTER TABLE assistant_thread_launches ADD COLUMN uncapped INTEGER NOT NULL DEFAULT 0"); } catch { /* column already present */ }
    // A cross-model review's parent is for display only. Remove memberships an older backfill
    // recorded, including retired costs, and skip these links when rebuilding launched trees.
    // Delegated image reviewers are created as children and keep their normal membership.
    db.exec(`DELETE FROM assistant_thread_members WHERE session_id IN (SELECT review_session_id FROM review_sessions);
      INSERT OR IGNORE INTO assistant_thread_members (session_id, thread_id, root_session_id)
        SELECT session_id, thread_id, session_id FROM assistant_thread_launches;
      INSERT OR IGNORE INTO assistant_thread_members (session_id, thread_id, root_session_id)
        WITH RECURSIVE tree(id, thread_id, root) AS (
          SELECT session_id, thread_id, session_id FROM assistant_thread_launches
          UNION SELECT child.id, tree.thread_id, tree.root FROM sessions child JOIN tree ON child.parent_session_id=tree.id
          WHERE NOT EXISTS (SELECT 1 FROM review_sessions WHERE review_session_id=child.id))
        SELECT id, thread_id, root FROM tree;`);
  }

  constructor(private readonly db: DatabaseSync) {}

  /** Convert independent legacy ceilings to one budget without granting either surface more. */
  migrateLegacyBackingBudgets(): void {
    this.db.prepare(`WITH budgets AS (
      SELECT thread.id, thread.cost_limit_usd AS thread_limit,
        thread.backing_owner_cap_usd AS owner_cap,
        CASE WHEN session.cost_budget_usd > 0 AND (
          COALESCE(thread.backing_cap_usd, CASE WHEN thread.cost_limit_usd IS NOT NULL THEN ?1 END) IS NULL
          OR ABS(session.cost_budget_usd - COALESCE(thread.backing_cap_usd, ?1)) >= 0.005
        ) THEN session.cost_budget_usd END AS edited_cap
      FROM assistant_threads thread JOIN sessions session ON session.id = thread.session_id
    ), ceilings AS (
      SELECT id, owner_cap AS amount FROM budgets
      UNION ALL SELECT id, edited_cap FROM budgets
      UNION ALL SELECT id, thread_limit FROM budgets WHERE owner_cap > 0 OR edited_cap > 0
    ), tightened AS (
      SELECT id, MIN(amount) AS ceiling FROM ceilings WHERE amount > 0 GROUP BY id
    )
    UPDATE assistant_threads SET cost_limit_usd = tightened.ceiling
    FROM tightened WHERE assistant_threads.id = tightened.id`).run(DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);
  }

  get(id: string): ThreadRow | null {
    return (this.db.prepare("SELECT * FROM assistant_threads WHERE id=?").get(id) as ThreadRow | undefined) ?? null;
  }

  forSession(sessionId: string): ThreadRow | null {
    return (this.db.prepare("SELECT * FROM assistant_threads WHERE session_id=?").get(sessionId) as ThreadRow | undefined) ?? null;
  }

  history(threadId: string): AssistantThreadHistoryEntry[] {
    return this.db.prepare(`SELECT session_id AS sessionId, harness, next_harness AS nextHarness, switched_at AS switchedAt
      FROM assistant_thread_history WHERE thread_id=? ORDER BY switched_at DESC, rowid DESC`).all(threadId) as unknown as AssistantThreadHistoryEntry[];
  }

  harnessChangeInProgress(threadId: string): boolean {
    return this.db.prepare("SELECT 1 FROM assistant_thread_harness_change WHERE thread_id=?").get(threadId) !== undefined;
  }

  startHarnessChange(threadId: string, sourceId: string, targetId: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO assistant_thread_harness_change VALUES (?,?,?)")
      .run(threadId, sourceId, targetId).changes === 1;
  }

  finishHarnessChange(threadId: string, targetId: string): void {
    this.db.prepare("DELETE FROM assistant_thread_harness_change WHERE thread_id=? AND target_id=?").run(threadId, targetId);
  }

  unfinishedHarnessChanges(): { threadId: string; targetId: string }[] {
    return this.db.prepare("SELECT thread_id AS threadId, target_id AS targetId FROM assistant_thread_harness_change")
      .all() as { threadId: string; targetId: string }[];
  }

  unretiredHarnessSources(): { runnerId: string; sessionId: string }[] {
    return this.db.prepare(`SELECT session.runner_id AS runnerId, session.id AS sessionId
      FROM assistant_thread_history history JOIN sessions session ON session.id=history.session_id
      WHERE session.archived_at IS NULL`).all() as { runnerId: string; sessionId: string }[];
  }

  harnessChangeForTarget(targetId: string): boolean {
    return this.db.prepare("SELECT 1 FROM assistant_thread_harness_change WHERE target_id=?").get(targetId) !== undefined;
  }

  /** A staged or former backing session cannot receive prompts through its ordinary Session URL. */
  harnessChangeBlocksSession(sessionId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM assistant_thread_harness_change WHERE source_id=? OR target_id=?
      UNION ALL SELECT 1 FROM assistant_thread_history WHERE session_id=? LIMIT 1`).get(sessionId, sessionId, sessionId) !== undefined;
  }

  earlierBackingSpend(threadId: string): number {
    return (this.db.prepare(`SELECT retired_cost_usd + (${this.historySpendSql("assistant_threads.id")}) AS cost
      FROM assistant_threads WHERE id=?`)
      .get(threadId) as { cost: number } | undefined)?.cost ?? 0;
  }

  private historySpendSql(threadId: string): string {
    return `SELECT COALESCE(SUM(session.cost_usd + session.live_cost_usd), 0)
      FROM assistant_thread_history history JOIN sessions session ON session.id=history.session_id
      WHERE history.thread_id=${threadId}`;
  }

  /** Credential activation and the backing pointer share a transaction. A target with no
   * committed credential cannot use the Assistant connection, even if its process started. */
  commitHarnessChange(input: {
    threadId: string; sourceId: string; targetId: string; harness: AssistantThreadHarness; title: string;
    connectionId: string; tokenHash: string; expiresAt: number; now: number;
    bindCredential: (connectionId: string, tokenHash: string, expiresAt: number) => boolean;
  }): boolean {
    const { threadId, sourceId, targetId, harness, title, connectionId, tokenHash, expiresAt, now, bindCredential } = input;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.get(threadId);
      if (!row || row.state !== "active" || row.session_id !== sourceId || row.connection_id !== connectionId ||
          !this.db.prepare("SELECT 1 FROM assistant_thread_harness_change WHERE thread_id=? AND source_id=? AND target_id=?")
            .get(threadId, sourceId, targetId) ||
          !this.db.prepare("SELECT 1 FROM sessions WHERE id=? AND assistant_thread_id=? AND archived_at IS NULL")
            .get(targetId, threadId) ||
          !bindCredential(connectionId, tokenHash, expiresAt)) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const grant = threadDecisionDelegation(row).grant;
      const invalidate = grant?.evidenceDisclosureDigest !== undefined;
      if (invalidate) delete grant.evidenceDisclosureDigest;
      this.db.prepare("INSERT INTO assistant_thread_history VALUES (?,?,?,?,?)")
        .run(threadId, sourceId, row.harness, harness, now);
      this.db.prepare(`UPDATE assistant_threads SET session_id=?, harness=?, title=COALESCE(title, ?), updated_at=?,
        backing_cap_usd=NULL, decision_grant=?, decision_grant_revision=decision_grant_revision+?
        WHERE id=?`).run(targetId, harness, title, now, grant ? JSON.stringify(grant) : null, invalidate ? 1 : 0, threadId);
      this.finishHarnessChange(threadId, targetId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listForOwner(userId: string, organizationId: string, includeArchived: boolean): ThreadRow[] {
    return this.db.prepare(`SELECT * FROM assistant_threads WHERE owner_user_id=? AND organization_id=?
      AND state ${includeArchived ? "IN ('active','archived')" : "='active'"}`).all(userId, organizationId) as unknown as ThreadRow[];
  }

  defaultLimits(owner: HumanPrincipal): AssistantThreadLimits {
    const row = this.db.prepare("SELECT cost_limit_usd, launch_limit FROM assistant_thread_limit_defaults WHERE owner_user_id=? AND organization_id=?")
      .get(owner.userId, owner.organizationId) as Pick<ThreadRow, "cost_limit_usd" | "launch_limit"> | undefined;
    return row ? { costUsd: row.cost_limit_usd, launchedSessions: row.launch_limit } : DEFAULT_ASSISTANT_THREAD_LIMITS;
  }

  setDefaultLimits(owner: HumanPrincipal, limits: AssistantThreadLimits): void {
    this.db.prepare(`INSERT INTO assistant_thread_limit_defaults (owner_user_id, organization_id, cost_limit_usd, launch_limit)
      VALUES (?, ?, ?, ?) ON CONFLICT (owner_user_id, organization_id) DO UPDATE
      SET cost_limit_usd=excluded.cost_limit_usd, launch_limit=excluded.launch_limit`)
      .run(owner.userId, owner.organizationId, limits.costUsd, limits.launchedSessions);
  }

  defaultLaunch(owner: Pick<HumanPrincipal, "userId" | "organizationId">): AssistantThreadLaunchDefaults {
    const row = this.db.prepare("SELECT harness, runner_id, account_ref FROM assistant_thread_launch_defaults WHERE owner_user_id=? AND organization_id=?")
      .get(owner.userId, owner.organizationId) as { harness: AssistantThreadHarness; runner_id: string | null; account_ref: string | null } | undefined;
    return {
      harness: row?.harness ?? "claude-code",
      providerAccount: row?.runner_id && row.account_ref ? { runnerId: row.runner_id, accountRef: row.account_ref } : null,
    };
  }

  setDefaultLaunch(owner: Pick<HumanPrincipal, "userId" | "organizationId">, defaults: AssistantThreadLaunchDefaults): void {
    this.db.prepare(`INSERT INTO assistant_thread_launch_defaults (owner_user_id, organization_id, harness, runner_id, account_ref)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_user_id, organization_id) DO UPDATE
      SET harness=excluded.harness, runner_id=excluded.runner_id, account_ref=excluded.account_ref`)
      .run(owner.userId, owner.organizationId, defaults.harness, defaults.providerAccount?.runnerId ?? null, defaults.providerAccount?.accountRef ?? null);
  }

  defaultDecision(owner: HumanPrincipal): AssistantDecisionDefault | null {
    const row = this.db.prepare("SELECT grant_json FROM assistant_thread_decision_defaults WHERE owner_user_id=? AND organization_id=?")
      .get(owner.userId, owner.organizationId) as { grant_json: string } | undefined;
    return row ? JSON.parse(row.grant_json) as AssistantDecisionDefault : null;
  }

  setDefaultDecision(owner: HumanPrincipal, grant: AssistantDecisionDefault | null): void {
    if (grant === null) {
      this.db.prepare("DELETE FROM assistant_thread_decision_defaults WHERE owner_user_id=? AND organization_id=?")
        .run(owner.userId, owner.organizationId);
      return;
    }
    this.db.prepare(`INSERT INTO assistant_thread_decision_defaults (owner_user_id, organization_id, grant_json)
      VALUES (?, ?, ?) ON CONFLICT (owner_user_id, organization_id) DO UPDATE SET grant_json=excluded.grant_json`)
      .run(owner.userId, owner.organizationId, JSON.stringify(grant));
  }

  setLimits(threadId: string, limits: AssistantThreadLimits): void {
    this.db.prepare("UPDATE assistant_threads SET cost_limit_usd=?, launch_limit=?, launch_paused=COALESCE(?, launch_paused) WHERE id=?")
      .run(limits.costUsd, limits.launchedSessions, limits.launchPaused === undefined ? null : Number(limits.launchPaused), threadId);
  }

  setDecisionGrant(threadId: string, expectedRevision: number, grant: AssistantDecisionGrant | null): boolean {
    return this.db.prepare(`UPDATE assistant_threads SET decision_grant=?, decision_grant_revision=decision_grant_revision+1
      WHERE id=? AND state='active' AND decision_grant_revision=?`)
      .run(grant === null ? null : JSON.stringify(grant), threadId, expectedRevision).changes === 1;
  }

  reserve(owner: HumanPrincipal, harness: AssistantThreadHarness, title: string | null, now: number, limits = this.defaultLimits(owner)): string {
    const id = `thr_${randomUUID()}`;
    this.db.prepare(`INSERT INTO assistant_threads (id, owner_user_id, organization_id, assistant, title, harness, state,
      created_at, updated_at, cost_limit_usd, launch_limit, backing_cap_usd)
      VALUES (?, ?, ?, 'wollipog', ?, ?, 'creating', ?, ?, ?, ?, ?)`)
      .run(id, owner.userId, owner.organizationId, title, harness, now, now, limits.costUsd, limits.launchedSessions, limits.costUsd);
    return id;
  }

  activate(id: string, sessionId: string, now: number, grant: AssistantDecisionGrant | null = null): void {
    this.db.prepare(`UPDATE assistant_threads SET session_id=?, state='active', updated_at=?,
      decision_grant=?, decision_grant_revision=? WHERE id=? AND state='creating'`)
      .run(sessionId, now, grant === null ? null : JSON.stringify(grant), grant === null ? 0 : 1, id);
  }

  forConnection(connectionId: string): ThreadRow | null {
    return (this.db.prepare("SELECT * FROM assistant_threads WHERE connection_id=?").get(connectionId) as ThreadRow | undefined) ?? null;
  }

  /** `capUsd` is the launch's cost cap, its allowance (#4671). */
  recordLaunch(threadId: string, sessionId: string, now: number, capUsd: number | null = null): void {
    this.db.prepare("INSERT OR IGNORE INTO assistant_thread_launches (session_id, thread_id, created_at, uncapped) VALUES (?, ?, ?, ?)")
      .run(sessionId, threadId, now, capUsd === null ? 1 : 0);
    this.db.prepare("INSERT OR IGNORE INTO assistant_thread_members (session_id, thread_id, root_session_id, allowance_usd) VALUES (?, ?, ?, ?)")
      .run(sessionId, threadId, sessionId, capUsd);
  }

  /** A child of a thread member joins the same launched tree, with the cap it was created with as
   * its allowance. */
  inheritMembership(sessionId: string, parentSessionId: string, capUsd: number | null = null): void {
    this.db.prepare(`INSERT OR IGNORE INTO assistant_thread_members (session_id, thread_id, root_session_id, allowance_usd)
      SELECT ?, thread_id, root_session_id, ? FROM assistant_thread_members WHERE session_id=?`).run(sessionId, capUsd, parentSessionId);
  }

  /** A member of a thread's launched trees, with its cost allowance (#4671); null for any other
   * session. A member recorded before allowances were kept has none until it next creates a child. */
  member(sessionId: string): { allowanceUsd: number | null; managedCapUsd: number | null; ownerCapUsd: number | null } | null {
    const row = this.db.prepare("SELECT allowance_usd, managed_cap_usd, owner_cap_usd FROM assistant_thread_members WHERE session_id=?")
      .get(sessionId) as { allowance_usd: number | null; managed_cap_usd: number | null; owner_cap_usd: number | null } | undefined;
    return row ? { allowanceUsd: row.allowance_usd, managedCapUsd: row.managed_cap_usd, ownerCapUsd: row.owner_cap_usd } : null;
  }

  setMemberCap(sessionId: string, allowanceUsd: number, capUsd: number): void {
    this.db.prepare("UPDATE assistant_thread_members SET allowance_usd=?, managed_cap_usd=? WHERE session_id=?").run(allowanceUsd, capUsd, sessionId);
  }

  /** Lowers the owner's recorded ceiling for a member to `capUsd`; it only ever goes down. */
  recordMemberOwnerCap(sessionId: string, capUsd: number): void {
    this.db.prepare("UPDATE assistant_thread_members SET owner_cap_usd=MIN(COALESCE(owner_cap_usd, ?), ?) WHERE session_id=?").run(capUsd, capUsd, sessionId);
  }

  /** Before a session row is deleted: its spend stays its thread's, in its own launched tree. */
  retireSessionCost(sessionId: string): void {
    const cost = "COALESCE((SELECT cost_usd + live_cost_usd FROM sessions WHERE id=?), 0)";
    this.db.prepare(`UPDATE assistant_thread_members SET retired_cost_usd=${cost},
        retired_cap_usd=(SELECT ${TREE_COMMITMENT_SQL("s", "assistant_thread_members")} FROM sessions s WHERE s.id=?)
      WHERE session_id=? AND retired_cost_usd IS NULL`).run(sessionId, sessionId, sessionId);
    this.db.prepare(`UPDATE assistant_threads SET retired_cost_usd = retired_cost_usd + ${cost}
      WHERE session_id=? OR id=(SELECT thread_id FROM assistant_thread_history WHERE session_id=?)`)
      .run(sessionId, sessionId, sessionId);
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
   * Each tree holds the larger of its spend and its root's commitment: the part of the budget the
   * backing session can no longer use. */
  costs(threadId: string): { spentUsd: number; backingSpentUsd: number; launchedHeldUsd: number } {
    const thread = this.db.prepare(`SELECT thread.retired_cost_usd + (${this.historySpendSql("thread.id")}) +
        COALESCE((SELECT cost_usd + live_cost_usd FROM sessions WHERE id=thread.session_id), 0) AS backing
      FROM assistant_threads thread WHERE thread.id=?`).get(threadId) as { backing: number } | undefined;
    // A deleted member counts its final cost, inside its own tree; a deleted root no longer holds a cap.
    const trees = this.db.prepare(`SELECT member.root_session_id AS root,
        COALESCE(SUM(CASE WHEN session.id IS NULL THEN COALESCE(member.retired_cost_usd, 0)
          ELSE session.cost_usd + session.live_cost_usd END), 0) AS spent,
        COALESCE((SELECT ${TREE_COMMITMENT_SQL("s", "rm")} FROM sessions s JOIN assistant_thread_members rm ON rm.session_id=s.id
            WHERE s.id=member.root_session_id),
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

  /** A root launched without an allowance may have uncapped descendants, even if the root has
   * since been capped or deleted. Its tree must retire before a finite thread budget can cover it. */
  hasUncappedWork(threadId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM assistant_thread_members member
      JOIN sessions session ON session.id=member.session_id
      JOIN assistant_thread_members root ON root.session_id=member.root_session_id
      LEFT JOIN assistant_thread_launches launch ON launch.session_id=root.session_id
      LEFT JOIN sessions root_session ON root_session.id=root.session_id
      WHERE member.thread_id=? AND (launch.uncapped=1 OR session.cost_budget_usd IS NULL OR
        COALESCE(root.allowance_usd, root_session.cost_budget_usd, root.retired_cap_usd) IS NULL) LIMIT 1`)
      .get(threadId) !== undefined;
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
    this.db.prepare(`UPDATE assistant_threads SET state='archived', archived_at=COALESCE(archived_at, ?), updated_at=?,
      decision_grant_revision=decision_grant_revision+(decision_grant IS NOT NULL), decision_grant=NULL
      WHERE id=? AND state='active'`).run(now, now, id);
  }
}
