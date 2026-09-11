/**
 * A bounded, runner-local record of provider request rejections the history classifier does not yet
 * recognize (#876).
 *
 * This exists to answer one question with evidence instead of speculation: which *other* rejection
 * shapes does the provider actually produce? The quarantine in #827 recognizes a single class
 * because inventing patterns is how a classifier starts quarantining sessions that were recoverable
 * in place. Widening it needs observations, and observations need somewhere to land.
 *
 * It is evidence, not behaviour. Nothing reads this journal to make a decision; recording is
 * best-effort and a failure to write never touches the error path the caller is already on.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  providerRejectionShapeKey,
  type ProviderRejectionShape,
} from "./provider-rejection-shape.js";

export interface UnclassifiedRejectionRecord {
  version: 1;
  driver: string;
  path: string;
  phrases: string[];
  /** How many times this exact shape was observed. Repeats are counted, never appended. */
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Distinct shapes retained. A provider producing more than this is itself the finding. */
const MAX_RECORDS = 64;

export class UnclassifiedRejectionJournal {
  private readonly path: string;
  private records = new Map<string, UnclassifiedRejectionRecord>();
  /** Distinct shapes seen after the journal filled. Kept as a count so the bound is honest. */
  private overflow = 0;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "unclassified-provider-rejections.json");
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as {
        records?: UnclassifiedRejectionRecord[];
        overflow?: number;
      };
      for (const record of parsed?.records ?? []) {
        if (record?.version !== 1 || typeof record.driver !== "string" || typeof record.path !== "string") continue;
        // Reconstruct rather than adopt. A record written by an older build carries whatever fields
        // that build stored, and inserting the parsed object would re-serialize them on the next
        // flush — so a property since removed for privacy would persist indefinitely. Loading is the
        // point at which retention is decided, so only fields named here survive.
        const sanitized: UnclassifiedRejectionRecord = {
          version: 1,
          driver: record.driver,
          path: record.path,
          phrases: Array.isArray(record.phrases) ? record.phrases.filter((phrase) => typeof phrase === "string") : [],
          count: Number.isSafeInteger(record.count) && record.count > 0 ? record.count : 1,
          firstSeenAt: Number.isSafeInteger(record.firstSeenAt) ? record.firstSeenAt : 0,
          lastSeenAt: Number.isSafeInteger(record.lastSeenAt) ? record.lastSeenAt : 0,
        };
        this.records.set(providerRejectionShapeKey(sanitized.driver, sanitized), sanitized);
      }
      // Rewrite immediately so a journal from an older build is sanitized on disk even if this
      // runner never records another rejection.
      if (this.records.size) this.flush();
      if (Number.isSafeInteger(parsed?.overflow) && parsed!.overflow! >= 0) this.overflow = parsed!.overflow!;
    } catch {
      // A missing or corrupt journal is not an error worth propagating: this is a diagnostic, and
      // losing prior observations must never break the session that is already failing.
      this.records = new Map();
      this.overflow = 0;
    }
  }

  list(): UnclassifiedRejectionRecord[] {
    return [...this.records.values()];
  }

  overflowCount(): number {
    return this.overflow;
  }

  /** Record one observation. Returns false when the bound rejected a new shape. */
  record(driver: string, shape: ProviderRejectionShape): boolean {
    const key = providerRejectionShapeKey(driver, shape);
    const at = this.now();
    const existing = this.records.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = at;
      this.flush();
      return true;
    }
    if (this.records.size >= MAX_RECORDS) {
      this.overflow += 1;
      this.flush();
      return false;
    }
    this.records.set(key, {
      version: 1,
      driver,
      path: shape.path,
      phrases: [...shape.phrases],
      count: 1,
      firstSeenAt: at,
      lastSeenAt: at,
    });
    this.flush();
    return true;
  }

  private flush(): void {
    try {
      writeFileSync(this.path, JSON.stringify({ records: this.list(), overflow: this.overflow }, null, 2));
    } catch {
      // Best effort by design — see the file header.
    }
  }
}
