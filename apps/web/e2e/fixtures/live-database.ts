import { setTimeout as delay } from "node:timers/promises";
import { ControlPlaneDb } from "../../../control-plane/src/db.js";

/**
 * Write to the live database beside the running control plane, retrying a momentary lock. Opening
 * writes too (schema checks and the usage-aggregation baseline), so it can meet the server's lock as
 * well as the writes themselves can (#3801). Keep each `write` idempotent: a lock can interrupt it
 * after an earlier statement committed, and the whole callback then runs again.
 */
export async function withLiveDb<T>(databasePath: string, write: (db: ControlPlaneDb) => T): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let db: ControlPlaneDb | null = null;
    try {
      db = ControlPlaneDb.open(databasePath);
      return write(db);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("database is locked") || attempt === 49) throw error;
    } finally {
      db?.close();
    }
    await delay(20);
  }
}
