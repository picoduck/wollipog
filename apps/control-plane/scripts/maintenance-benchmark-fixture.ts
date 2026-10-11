import type { SQLInputValue } from "node:sqlite";
import { ControlPlaneDb } from "../src/db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID } from "../src/identity.js";

export const BENCHMARK_NOW = 2_000_000_000_000;

/** Synthetic data only. Foreign keys are disabled for generated maintenance-history references;
 * production upgrade/cascade tests use valid references and keep enforcement enabled. */
export function seedMaintenanceFixture(db: ControlPlaneDb, historyRows = 20_000): Record<string, number> {
  const raw = db.raw();
  raw.exec("PRAGMA foreign_keys=OFF");
  raw.prepare(`INSERT INTO runners(runner_id,hostname,os,version,status,created_at,updated_at)
    VALUES('bench','synthetic','linux','test','online',1,1)`).run();
  for (let i = 0; i < 2_000; i++) {
    db.createSession({
      id: `s${i}`, runnerId: "bench", workspaceId: null, agentId: "bench", title: "Synthetic",
      useWorktree: false, driver: "acp", config: {}, now: 1,
      scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user", userId: LOCAL_OWNER_USER_ID } },
    });
  }
  raw.exec("BEGIN");
  const event = raw.prepare(`INSERT INTO session_events(session_id,seq,runner_seq,ts,kind,payload)
    VALUES(?,?,?,?,'agent_message','{"text":"synthetic"}')`);
  for (let i = 0; i < 200_000; i++) event.run(`s${i % 2_000}`, Math.floor(i / 2_000) + 1, i + 1, i);
  raw.exec("COMMIT");

  type Generator = (i: number) => SQLInputValue;
  const now = BENCHMARK_NOW;
  const tables: Record<string, Record<string, Generator>> = {
    workflow_attempts: {
      status: i => i % 1_000 === 0 ? "running" : "succeeded", session_id: i => `s${i % 2_000}`,
      deadline_at: i => i % 1_000 === 0 ? now - 1 : now + 1,
    },
    session_reminders: {
      session_id: i => `s${i % 2_000}`, user_id: i => `user${i}`, schedule_kind: () => "timed",
      scheduled_for: i => now + (i % 1_000 === 0 ? -1 : 1), time_zone: () => "UTC",
      wake_policy: () => "regardless", state: i => i % 1_000 === 0 ? "pending" : "fired",
    },
    session_stop_intents: {
      session_id: i => `s${i}`, runner_id: () => "bench", archive_after_stop: () => 1,
      failed_at: i => i % 1_000 === 0 ? null : now, attempt_count: () => 1, last_attempt_at: i => i,
    },
    session_command_invocations: {
      session_id: i => `s${i % 2_000}`, runner_id: () => "bench",
      state: i => i % 1_000 === 0 ? "pending" : "completed", execution_mode: () => "passthrough",
      expires_at: i => now + (i % 1_000 === 0 ? 1_000 : -1_000), next_attempt_at: () => now - 1,
    },
    session_prompt_commands: {
      session_id: i => `s${i % 2_000}`, runner_id: () => "bench", payload_json: () => "{}",
      state: i => i % 1_000 === 0 ? "pending" : "completed",
      expires_at: i => now + (i % 1_000 === 0 ? 1_000 : -1_000), next_attempt_at: () => now - 1,
    },
    background_push_deliveries: {
      session_id: i => `s${i % 2_000}`, payload_json: () => "{}",
      state: i => i % 1_000 === 0 ? "pending" : "shown", expires_at: () => now + 1_000,
      next_attempt_at: () => now - 1, endpoint: () => "https://example.invalid/synthetic",
    },
    outbound_event_subscriptions: {
      scope_kind: () => "project", project_id: () => "synthetic-project", automation_id: () => null,
      event_kinds_json: () => "[]", state: () => "active", created_by_kind: () => "user",
    },
    outbound_events: { session_id: i => `s${i % 2_000}`, kind: () => "session.idle" },
    outbound_event_deliveries: {
      subscription_id: () => "outbound_event_subscriptions-0-subscription_id",
      event_id: i => `outbound_events-${i}-event_id`, kind: () => "session.idle",
      status: i => i % 1_000 === 0 ? "pending" : "delivered", payload_json: () => "{}",
      next_attempt_at: () => now - 1, lease_expires_at: () => now - 1, updated_at: () => now,
    },
  };
  const counts: Record<string, number> = { sessions: 2_000, session_events: 200_000 };
  for (const [table, generators] of Object.entries(tables)) {
    const columns = raw.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }>;
    const included = columns.filter(c => (c.notnull && c.dflt_value === null) || c.pk || c.name in generators);
    const statement = raw.prepare(`INSERT INTO ${table}(${included.map(c => c.name).join(",")})
      VALUES(${included.map(() => "?").join(",")})`);
    const count = table === "session_stop_intents" ? 2_000 : table === "outbound_event_subscriptions" ? 1 : historyRows;
    raw.exec("BEGIN");
    for (let i = 0; i < count; i++) {
      statement.run(...included.map(c => generators[c.name]
        ? generators[c.name]!(i) : c.type === "INTEGER" ? i + 1 : `${table}-${i}-${c.name}`));
    }
    raw.exec("COMMIT");
    counts[table] = count;
  }
  return counts;
}

export interface MaintenanceQuery { method: string; sql: string; args: SQLInputValue[] }

/** Invoke real query builders with empty results. Capture exact SQL/parameters, including UPDATE
 * predicates, without firing reminders or retrying network deliveries in the benchmark fixture. */
export function captureMaintenanceQueries(db: ControlPlaneDb): MaintenanceQuery[] {
  const captured: MaintenanceQuery[] = [];
  const target = db as unknown as { stmt(sql: string): {
    all(...args: SQLInputValue[]): unknown[];
    get(...args: SQLInputValue[]): unknown;
    run(...args: SQLInputValue[]): { changes: number };
  } };
  const original = target.stmt;
  let method = "";
  target.stmt = sql => ({
    all: (...args) => { captured.push({ method, sql, args }); return []; },
    get: (...args) => { captured.push({ method, sql, args }); return undefined; },
    run: (...args) => { captured.push({ method, sql, args }); return { changes: 0 }; },
  });
  const now = BENCHMARK_NOW;
  const actions: Array<[string, () => unknown]> = [
    ["activeWorkflowAttempts", () => db.activeWorkflowAttempts(now)],
    ["fireDueSessionReminders", () => db.fireDueSessionReminders(now)],
    ["pendingSessionStopIntents", () => db.pendingSessionStopIntents()],
    ["dueSessionCommandInvocationRunnerIds", () => db.dueSessionCommandInvocationRunnerIds(now)],
    ["dueSessionCommandInvocationMessages", () => db.dueSessionCommandInvocationMessages("bench", now)],
    ["expiringSessionCommandInvocationSessionIds", () => db.expiringSessionCommandInvocationSessionIds(now)],
    ["expireSessionCommandInvocations", () => db.expireSessionCommandInvocations(now)],
    ["dueSessionPromptCommands", () => db.dueSessionPromptCommands(now)],
    ["expireSessionPromptCommands", () => db.expireSessionPromptCommands(now)],
    ["pruneSessionPromptCommands", () => db.pruneSessionPromptCommands(now)],
    ["settledWorkflowDecisionResumeCommands", () => db.settledWorkflowDecisionResumeCommands()],
    ["sessionsWithHeldWorkflowDecisionResumes", () => db.sessionsWithHeldWorkflowDecisionResumes()],
    ["settledRestartNoticeCommands", () => db.settledRestartNoticeCommands()],
    ["sessionsWithHeldRestartNotices", () => db.sessionsWithHeldRestartNotices()],
    ["listOrchestratorCampaignSessionIds", () => db.listOrchestratorCampaignSessionIds()],
    ["claimDueBackgroundPushDeliveries", () => db.claimDueBackgroundPushDeliveries(now)],
    ["claimOutboundEventDeliveries", () => db.claimOutboundEventDeliveries(now, 16, 30_000)],
    ["compactOutboundEventDeliveries", () => db.compactOutboundEventDeliveries(now)],
  ];
  try {
    for (const [name, action] of actions) { method = name; action(); }
  } finally {
    target.stmt = original;
  }
  return captured;
}
