import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

export function isSqliteBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { errcode?: number }).errcode === 5;
}

type Contention = { active: boolean; retries: number; waitMs: number; report: (retries: number, exhausted: boolean) => void };
const context = new AsyncLocalStorage<Contention>();
export const RUNNER_PERSISTENCE_MAX_RETRIES = 3;
export const RUNNER_PERSISTENCE_RETRY_WINDOW_MS = 1_000;

/** Retry only the failed SQLite operation, never a frame's already-published side effects.
 * SQLite's existing 250ms busy handler paces attempts. A frame/run shares one budget even
 * across cooperative yields. No extra sleeps or larger connection timeout are introduced. */
export function withRunnerPersistenceRetry<T>(work: () => Promise<T>, report: Contention["report"]): Promise<T> {
  const state: Contention = { active: true, retries: 0, waitMs: 0, report };
  return context.run(state, async () => {
    try { return await work(); }
    finally { state.active = false; }
  });
}

function retry<T>(work: () => T): T {
  const state = context.getStore();
  if (!state?.active) return work();
  let retried = false;
  for (;;) {
    const started = performance.now();
    try {
      const result = work();
      if (retried) state.waitMs += performance.now() - started;
      return result;
    }
    catch (error) {
      if (!isSqliteBusy(error)) throw error;
      state.waitMs += performance.now() - started;
      const exhausted = state.retries >= RUNNER_PERSISTENCE_MAX_RETRIES ||
        state.waitMs >= RUNNER_PERSISTENCE_RETRY_WINDOW_MS;
      state.report(state.retries, exhausted);
      if (exhausted) throw error;
      state.retries++;
      retried = true;
    }
  }
}

/** Native SQLite methods require their original receiver. Only single prepared operations and
 * transaction boundaries are replayable; arbitrary multi-statement exec scripts are not. */
export function runnerRetryConnection(database: DatabaseSync): DatabaseSync {
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") {
        const prepare = target.prepare.bind(target);
        return (sql: string) => {
          const statement = prepare(sql);
          return new Proxy(statement, {
            get(stmt, member) {
              const value = Reflect.get(stmt, member, stmt);
              if (typeof value !== "function") return value;
              if (["run", "get", "all"].includes(String(member))) {
                return (...args: unknown[]) => retry(() => Reflect.apply(value, stmt, args));
              }
              return value.bind(stmt);
            },
          });
        };
      }
      if (key === "exec") {
        const exec = target.exec.bind(target);
        return (sql: string) => {
          // A deferred read transaction cannot wait out a write-lock upgrade: SQLite skips its
          // busy handler (and a committed competing writer can invalidate the read snapshot).
          // Runner frames intend to persist state. Acquire write intent before any reads, so
          // contention happens at a replayable boundary, before transaction side effects.
          if (context.getStore()?.active && /^\s*BEGIN(?: DEFERRED)?(?: TRANSACTION)?\s*;?\s*$/i.test(sql)) {
            return retry(() => exec("BEGIN IMMEDIATE"));
          }
          if (/^\s*(?:BEGIN(?: IMMEDIATE)?|COMMIT)\s*;?\s*$/i.test(sql)) {
            return retry(() => exec(sql));
          }
          return exec(sql);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
