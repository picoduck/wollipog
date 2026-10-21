import { realpathSync, statfsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** SQLite can need two extra copies (temporary DB plus WAL/journal), plus operator headroom. */
export function incrementalVacuumConversionRequiredBytes(databaseBytes: bigint): bigint {
  const margin = (databaseBytes + 9n) / 10n;
  return 2n * databaseBytes + (margin > 256n * 1024n * 1024n ? margin : 256n * 1024n * 1024n);
}

/** Offline operator command only. Never call this from control-plane startup or maintenance. */
export function convertIncrementalVacuum(location: string, options: {
  ownerStopped: boolean;
  tempDirectory?: string;
  availableBytes?: (directory: string) => bigint;
}): { converted: boolean; databaseBytes: bigint; requiredBytes: bigint } {
  if (!options.ownerStopped) throw new Error("conversion requires --owner-stopped; stop every database owner, reader and backup first");
  const path = realpathSync(resolve(location)); // Refuse nonexistent paths rather than creating a DB.
  if (!statSync(path).isFile()) throw new Error("conversion requires an existing database file");
  const tempDirectory = realpathSync(options.tempDirectory ?? tmpdir());
  if (!statSync(tempDirectory).isDirectory()) throw new Error("SQLite temporary path must be a directory");
  const available = options.availableBytes ?? ((directory: string) => {
    const fs = statfsSync(directory, { bigint: true });
    if (fs.bavail < 0n || fs.bsize <= 0n) throw new Error("cannot determine available disk space");
    return fs.bavail * fs.bsize;
  });
  const db = new DatabaseSync(path);
  let previousTemp: string | undefined;
  let tempChanged = false;
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
    // EXCLUSIVE retains the lock across the commit and the subsequent VACUUM. In WAL mode
    // even an idle connected owner prevents acquisition. The acknowledgement is still required:
    // SQLite cannot prove that an idle rollback-mode handle, or an operator, won't try to reopen.
    const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    const pages = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    const databaseBytes = [BigInt(pageSize) * BigInt(pages), statSync(path, { bigint: true }).size]
      .reduce((a, b) => a > b ? a : b);
    const requiredBytes = incrementalVacuumConversionRequiredBytes(databaseBytes);
    if ((db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum === 2) {
      return { converted: false, databaseBytes, requiredBytes };
    }
    // Pin and verify SQLite's actual temporary-file directory instead of guessing its fallback
    // search order. Unsupported builds refuse rather than skipping the free-space check.
    previousTemp = (db.prepare("PRAGMA temp_store_directory").get() as { temp_store_directory: string } | undefined)?.temp_store_directory;
    db.exec(`PRAGMA temp_store_directory='${tempDirectory.replaceAll("'", "''")}'; PRAGMA temp_store=FILE;`);
    tempChanged = true;
    const actualTemp = (db.prepare("PRAGMA temp_store_directory").get() as { temp_store_directory: string } | undefined)?.temp_store_directory;
    if (actualTemp !== tempDirectory) throw new Error("cannot pin SQLite temporary-file directory; conversion refused");
    for (const directory of new Set([dirname(path), tempDirectory])) {
      const free = available(directory);
      if (typeof free !== "bigint" || free < requiredBytes) {
        throw new Error(`insufficient free disk for conversion: require ${requiredBytes} bytes on both database and temporary filesystems`);
      }
    }
    db.exec("PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA auto_vacuum=INCREMENTAL; VACUUM;");
    if ((db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum !== 2) {
      throw new Error("conversion did not produce INCREMENTAL mode");
    }
    return { converted: true, databaseBytes, requiredBytes };
  } finally {
    try {
      if (tempChanged) db.exec(`PRAGMA temp_store_directory='${(previousTemp ?? "").replaceAll("'", "''")}'`);
    } finally { db.close(); }
  }
}
