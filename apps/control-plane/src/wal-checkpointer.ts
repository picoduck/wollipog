import { Worker } from "node:worker_threads";

/**
 * Checkpoints the control plane's write-ahead log from a worker thread (#2761).
 *
 * SQLite's automatic checkpoint runs inside whichever commit crosses its threshold, so on the
 * control plane's one connection it copied the log into the database file and flushed both on the
 * event loop, in the middle of event ingest. The worker runs `wal_checkpoint(PASSIVE)` on its own
 * connection instead. PASSIVE never takes the write lock and never waits for one, so readers and
 * writers on the main connection are never blocked by it; frames it cannot copy yet are left for
 * the next pass. The main connection keeps an automatic checkpoint as a backstop, at a threshold
 * high enough that it fires only when the worker is not keeping up, so the log stays bounded even
 * if the worker stalls or dies. See docs/control-plane-database-durability.md.
 */

/** Pages the log may hold before the main connection checkpoints it itself (64 MiB at 4 KiB). */
export const WAL_CHECKPOINT_BACKSTOP_PAGES = 16_384;
/** SQLite's default automatic checkpoint threshold, restored when the worker stops. */
export const DEFAULT_WAL_AUTOCHECKPOINT_PAGES = 1_000;
export const WAL_CHECKPOINT_INTERVAL_MS = 250;
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000];
/** A worker that stayed up this long is healthy again: its next restart waits the first delay. */
const HEALTHY_AFTER_MS = 60_000;
/** How long a clean stop waits for the worker's last checkpoint and close. */
const STOP_TIMEOUT_MS = 2_000;

export type WalCheckpointerEvent =
  | { type: "online" }
  | { type: "disabled"; reason: string }
  | { type: "checkpoint"; busy: number; log: number; checkpointed: number }
  | { type: "failed"; message: string }
  | { type: "exited"; code: number; restartInMs: number | null };

export interface WalCheckpointerOptions {
  intervalMs?: number;
  backstopPages?: number;
  restartDelaysMs?: readonly number[];
  healthyAfterMs?: number;
  /** The SQLite library version; defaults to the one Node bundles. */
  sqliteVersion?: string;
  /** Observes the worker; it must not throw. */
  onEvent?: (event: WalCheckpointerEvent) => void;
}

/** Runs in the worker. Plain CommonJS so it also loads from the bundled single-file sidecar. */
const WORKER_SOURCE = /* js */ `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const done = new Int32Array(workerData.done);
const db = new DatabaseSync(workerData.location);
// A checkpoint that copies frames flushes the log first and the database after. Set explicitly: it
// is what makes such a pass end the exposure of commits relaxed to synchronous=NORMAL.
db.exec("PRAGMA synchronous = FULL");
const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
const pass = () => {
  const row = checkpoint.get();
  if (row.log > 0) parentPort.postMessage({ type: "checkpoint", busy: row.busy, log: row.log, checkpointed: row.checkpointed });
};
// Online only once a pass has succeeded, so a worker that cannot checkpoint keeps backing off.
pass();
const timer = setInterval(pass, workerData.intervalMs);
parentPort.on("message", (message) => {
  if (message !== "stop") return;
  clearInterval(timer);
  try { pass(); } finally {
    db.close();
    Atomics.store(done, 0, 1);
    Atomics.notify(done, 0);
    parentPort.close();
  }
});
parentPort.postMessage({ type: "online" });
`;

interface MainConnection {
  exec(sql: string): void;
}

export class WalCheckpointer {
  private worker: Worker | null = null;
  private done: Int32Array | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private onlineAt: number | null = null;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly backstopPages: number;
  private readonly restartDelaysMs: readonly number[];
  private readonly healthyAfterMs: number;
  private readonly sqliteVersion: string | undefined;
  private readonly onEvent: (event: WalCheckpointerEvent) => void;

  constructor(
    private readonly connection: MainConnection,
    private readonly location: string,
    options: WalCheckpointerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? WAL_CHECKPOINT_INTERVAL_MS;
    this.backstopPages = options.backstopPages ?? WAL_CHECKPOINT_BACKSTOP_PAGES;
    this.restartDelaysMs = options.restartDelaysMs ?? RESTART_DELAYS_MS;
    this.healthyAfterMs = options.healthyAfterMs ?? HEALTHY_AFTER_MS;
    this.sqliteVersion = "sqliteVersion" in options ? options.sqliteVersion : process.versions.sqlite;
    this.onEvent = options.onEvent ?? (() => {});
  }

  /** Start the worker and raise the main connection's automatic checkpoint to the backstop. */
  start(): void {
    if (this.stopped || this.worker) return;
    if (!sqliteHasWalResetFix(this.sqliteVersion)) {
      // A second connection checkpointing beside the writer is exactly what SQLite's WAL-reset bug
      // needs to corrupt the database (https://sqlite.org/wal.html#the_wal_reset_bug). Without the
      // fix, keep the main connection's own automatic checkpoint, as before.
      this.stopped = true;
      this.report({ type: "disabled", reason: `SQLite ${this.sqliteVersion ?? "(unknown)"} lacks the WAL-reset fix` });
      return;
    }
    this.connection.exec(`PRAGMA wal_autocheckpoint = ${this.backstopPages}`);
    this.spawn();
  }

  /** Whether a worker thread is running now. */
  running(): boolean {
    return this.worker !== null;
  }

  /** End the worker after one last checkpoint pass and restore SQLite's automatic checkpoint. Waits
   * up to two seconds so the main connection, closed next, is the last one and checkpoints at close. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const worker = this.worker;
    const done = this.done;
    this.worker = null;
    if (worker && done) {
      try {
        worker.postMessage("stop");
        Atomics.wait(done, 0, 0, STOP_TIMEOUT_MS);
      } catch {
        // The worker already exited; nothing of it remains to wait for.
      }
      if (Atomics.load(done, 0) !== 1) void worker.terminate().catch(() => {});
    }
    try {
      this.connection.exec(`PRAGMA wal_autocheckpoint = ${DEFAULT_WAL_AUTOCHECKPOINT_PAGES}`);
    } catch {
      // The connection is closing; the threshold no longer matters.
    }
  }

  private spawn(): void {
    const done = new Int32Array(new SharedArrayBuffer(4));
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { location: this.location, intervalMs: this.intervalMs, done: done.buffer },
      });
    } catch (error) {
      this.report({ type: "failed", message: error instanceof Error ? error.message : String(error) });
      this.scheduleRestart(1);
      return;
    }
    worker.unref();
    this.worker = worker;
    this.done = done;
    worker.on("message", (message: WalCheckpointerEvent) => {
      if (message.type === "online") this.onlineAt = Date.now();
      this.report(message);
    });
    worker.on("error", (error) => {
      this.report({ type: "failed", message: error instanceof Error ? error.message : String(error) });
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.done = null;
      if (this.onlineAt !== null && Date.now() - this.onlineAt >= this.healthyAfterMs) this.failures = 0;
      this.onlineAt = null;
      this.scheduleRestart(code);
    });
  }

  /** The backstop keeps the log bounded meanwhile; the main connection never depends on the worker. */
  private scheduleRestart(code: number): void {
    if (this.stopped) return;
    const delay = this.restartDelaysMs[Math.min(this.failures, this.restartDelaysMs.length - 1)] ?? 30_000;
    this.failures++;
    this.report({ type: "exited", code, restartInMs: delay });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
    this.restartTimer.unref?.();
  }

  private report(event: WalCheckpointerEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Observation must never affect checkpointing.
    }
  }
}

/** Whether this SQLite has the fix for the WAL-reset bug: 3.51.3 and later, or the 3.44.6 and 3.50.7
 * backports (https://sqlite.org/wal.html#the_wal_reset_bug). An unknown version does not. */
export function sqliteHasWalResetFix(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (major !== 3) return major > 3;
  if (minor === 44) return patch >= 6;
  if (minor === 50) return patch >= 7;
  return minor > 51 || (minor === 51 && patch >= 3);
}
