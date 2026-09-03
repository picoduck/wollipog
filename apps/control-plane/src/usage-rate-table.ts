import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UsagePricingStatus } from "@wollipog/protocol";
import { parseRateTable, type RateTable } from "./usage-pricing.js";

/**
 * Loads and refreshes the model rate table the usage ledger prices against.
 *
 * The table is fetched from a public per-token price list on a daily TTL and cached to disk so a
 * restart or an offline control plane keeps pricing with the last known rates. Status is reported
 * honestly: `fresh` after a successful fetch inside the TTL, `cached` while serving a copy that
 * could not be refreshed, and `unavailable` when no table has ever loaded or pricing is disabled.
 */

export const DEFAULT_USAGE_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const USAGE_PRICING_TTL_MS = 24 * 60 * 60 * 1000;
/** An explicit refresh ignores the TTL but not a table fetched this recently. */
export const USAGE_PRICING_REFRESH_FLOOR_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_FILE_VERSION = 1;

interface CacheFile {
  version: number;
  source: string;
  fetchedAt: number;
  document: unknown;
}

export interface UsageRateTableOptions {
  /** `null` disables pricing entirely; the service then reports `unavailable` and never fetches. */
  sourceUrl: string | null;
  /** Disk cache path, or `null` for an in-memory-only table (tests, `:memory:` databases). */
  cachePath: string | null;
  fetchDocument?: (url: string, signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  log?: (message: string) => void;
}

/** Resolves the cache path beside the control-plane database unless overridden or in memory. */
export function defaultUsagePricingCachePath(dbPath: string, override?: string): string | null {
  if (override) return override;
  if (dbPath === ":memory:" || dbPath.length === 0) return null;
  return join(dirname(dbPath), "usage-model-rates.json");
}

/** `off`, `none`, `0`, or `false` disable outbound pricing fetches. */
export function resolveUsagePricingUrl(raw: string | undefined): string | null {
  if (raw === undefined) return DEFAULT_USAGE_PRICING_URL;
  const value = raw.trim();
  if (value.length === 0 || ["off", "none", "0", "false", "disabled"].includes(value.toLowerCase())) return null;
  return value;
}

async function defaultFetchDocument(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`rate table returned HTTP ${response.status}`);
  return response.json();
}

export class UsageRateTableService {
  private table: RateTable | null = null;
  private fetchedAt: number | null = null;
  private state: UsagePricingStatus["status"] = "unavailable";
  private inflight: Promise<UsagePricingStatus> | null = null;
  private lastAttemptAt: number | null = null;
  private readonly fetchDocument: (url: string, signal: AbortSignal) => Promise<unknown>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: UsageRateTableOptions) {
    this.fetchDocument = options.fetchDocument ?? defaultFetchDocument;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(`[control-plane] ${message}`));
    this.loadDiskCache();
  }

  /** The current table for synchronous pricing inside a ledger transaction, if any loaded. */
  current(): RateTable | null {
    return this.table;
  }

  status(): UsagePricingStatus {
    // Freshness is a property of the clock, not of the last transition: a table that crossed its
    // TTL between refresh attempts is already only a cached copy.
    const expired = this.state === "fresh" && this.fetchedAt !== null && this.now() - this.fetchedAt >= USAGE_PRICING_TTL_MS;
    return {
      status: expired ? "cached" : this.state,
      source: this.options.sourceUrl ?? "disabled",
      fetchedAt: this.fetchedAt,
      knownModels: this.table?.size ?? 0,
    };
  }

  /** Refreshes unless a fresh table sits inside its TTL. `force` ignores the TTL. A table that is
   * merely cached (a failed refresh, or a cache written for another source) is refreshed on the
   * next call. Attempts, successful or not, are spaced by the refresh floor so a burst of
   * dashboard refreshes or a down upstream cannot hammer the source. One fetch runs at a time;
   * concurrent callers share it. */
  async ensure(force = false): Promise<UsagePricingStatus> {
    if (this.options.sourceUrl === null) return this.status();
    const now = this.now();
    if (this.table && this.fetchedAt !== null && this.state === "fresh" && !force && now - this.fetchedAt < USAGE_PRICING_TTL_MS) {
      return this.status();
    }
    if (this.inflight) return this.inflight;
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < USAGE_PRICING_REFRESH_FLOOR_MS) return this.status();
    this.lastAttemptAt = now;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<UsagePricingStatus> {
    const url = this.options.sourceUrl!;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const document = await this.fetchDocument(url, controller.signal);
      const table = parseRateTable(document);
      if (table.size === 0) throw new Error("rate table document contained no priced models");
      this.table = table;
      this.fetchedAt = this.now();
      this.state = "fresh";
      this.writeDiskCache({ version: CACHE_FILE_VERSION, source: url, fetchedAt: this.fetchedAt, document });
    } catch (error) {
      // Whatever is being served is now past its TTL and must not keep claiming to be fresh.
      if (this.table) this.state = "cached";
      this.log(`usage pricing refresh failed; ${this.table ? "serving the cached rate table" : "cost estimates are unavailable"}: ${
        error instanceof Error ? error.message : String(error)
      }`);
    } finally {
      clearTimeout(timer);
    }
    return this.status();
  }

  private loadDiskCache(): void {
    if (!this.options.cachePath || this.options.sourceUrl === null) return;
    try {
      const parsed = JSON.parse(readFileSync(this.options.cachePath, "utf8")) as Partial<CacheFile>;
      if (parsed.version !== CACHE_FILE_VERSION || typeof parsed.fetchedAt !== "number" || !Number.isFinite(parsed.fetchedAt)) return;
      const table = parseRateTable(parsed.document);
      if (table.size === 0) return;
      this.table = table;
      this.fetchedAt = parsed.fetchedAt;
      this.state = this.now() - parsed.fetchedAt < USAGE_PRICING_TTL_MS && parsed.source === this.options.sourceUrl
        ? "fresh"
        : "cached";
    } catch {
      /* no cache yet, or an unreadable one; the next ensure() fetches */
    }
  }

  private writeDiskCache(file: CacheFile): void {
    if (!this.options.cachePath) return;
    try {
      mkdirSync(dirname(this.options.cachePath), { recursive: true });
      const temporary = `${this.options.cachePath}.tmp-${process.pid}`;
      writeFileSync(temporary, JSON.stringify(file));
      renameSync(temporary, this.options.cachePath);
    } catch (error) {
      this.log(`usage pricing cache could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
