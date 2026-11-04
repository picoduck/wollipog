import { ControlPlaneDb } from "../../../control-plane/src/db.js";

/**
 * Write to the live database beside the running control plane. The attached connection applies no
 * schema and waits out the server's commits for a bounded time, so neither side's write fails on
 * the other's momentary lock (#3801, #3789).
 */
export async function withLiveDb<T>(databasePath: string, write: (db: ControlPlaneDb) => T): Promise<T> {
  const db = ControlPlaneDb.attach(databasePath);
  try {
    return write(db);
  } finally {
    db.close();
  }
}
