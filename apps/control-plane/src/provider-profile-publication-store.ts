import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** CP-owned observation history, not HOME ownership, a complete census, or deletion authority. */
export const PROVIDER_PUBLICATION_LIMITS = Object.freeze({ intents: 4096, events: 32768, recordBytes: 4096, page: 64 });
const EPOCH_KEY = "provider_profile_publication_epoch_v1";
const TABLES = ["provider_profile_publication_source", "provider_profile_publication_intents", "provider_profile_publication_events"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COUNTER = /^(0|[1-9][0-9]{0,19})$/u;
const MAX_COUNTER = (1n << 64n) - 1n;
const HASH = /^[a-f0-9]{64}$/u;
const identifier = (value: unknown): value is string => typeof value === "string" && ID.test(value);
// Runner/account values are hashed raw identities, not canonical ledger identifiers. Preserve
// their exact spelling and the existing UTF-8 hash domain; never narrow them to ID's charset.
const rawIdentity = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 128 && Buffer.byteLength(value) <= 512 &&
  Buffer.from(value, "utf8").toString("utf8") === value;
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && HASH.test(value);

export class ProviderPublicationUnavailable extends Error {
  readonly code = "PROVIDER_PUBLICATION_UNAVAILABLE";
  constructor() { super("Provider profile publication history is unavailable; no command was admitted."); }
}

/** Refuse before mutations: a savepoint, NORMAL commit, or caller-owned FULL transaction cannot return
 * a durable admission. No promises/callbacks escape the commit, and no ingestion setting changes. */
function fullTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction || (db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous !== 2) {
    throw new ProviderPublicationUnavailable();
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function validCounter(value: unknown): value is string {
  return typeof value === "string" && COUNTER.test(value) && BigInt(value) <= MAX_COUNTER;
}
function hash(domain: string, value: string): string {
  return createHash("sha256").update(`wollipog:cp-provider-publication:v1:${domain}\0`).update(value).digest("hex");
}
function encode(value: Record<string, string | number | null>): string {
  const text = JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  if (Buffer.byteLength(text) > PROVIDER_PUBLICATION_LIMITS.recordBytes) throw new ProviderPublicationUnavailable();
  return text;
}

export interface PublicationGrant {
  grantId: string; profileId: string | null; runnerId: string; providerAccountId: string; provider: "claude" | "codex";
}
export function validProviderPublicationInput(grant: PublicationGrant, requestId?: unknown): boolean {
  return identifier(grant.grantId) && rawIdentity(grant.runnerId) && rawIdentity(grant.providerAccountId) &&
    (grant.profileId === null || uuid(grant.profileId)) && ["claude", "codex"].includes(grant.provider) &&
    (requestId === undefined || identifier(requestId));
}
export type PublicationDispatchKind = "login" | "adopt";
export type PublicationObservation = "reply" | "not_sent" | "uncertain";
interface Source {
  singleton: number; version: number; owner_id: string; store_epoch: string;
  origin: "new-source-incomplete" | "legacy-incomplete"; history_complete: number;
  degraded: number; revision: string; intent_count: number; event_count: number;
}
export interface PublicationRecord {
  version: number; ownerId: string; storeEpoch: string; revision: string; kind: string;
  grantId: string; profileId: string | null; provider: "claude" | "codex";
  runnerKey: string; accountKey: string; requestId: string | null; ticket: string | null; observation: string | null;
}

/** Called after normal schema/instance initialization, with newDatabase captured before SCHEMA.
 * Presence is rechecked under the write lock. Any partial installation is left untouched. A
 * total rollback of all installation evidence is indistinguishable from pre-install history;
 * neither a new epoch nor reopening the DB proves anti-rollback or HOME provenance. */
export function installProviderPublicationStore(db: DatabaseSync, ownerId: string, newDatabase: boolean): void {
  fullTransaction(db, () => {
    const footprint = db.prepare("SELECT 1 FROM sqlite_schema WHERE name IN (?,?,?) LIMIT 1").get(...TABLES);
    const marker = db.prepare("SELECT value FROM control_plane_metadata WHERE key=?").get(EPOCH_KEY);
    if (footprint || marker) return;
    db.exec(`
      CREATE TABLE provider_profile_publication_source (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=1),
        owner_id TEXT NOT NULL, store_epoch TEXT NOT NULL, origin TEXT NOT NULL,
        history_complete INTEGER NOT NULL CHECK(history_complete=0),
        degraded INTEGER NOT NULL CHECK(degraded IN (0,1)), revision TEXT NOT NULL,
        intent_count INTEGER NOT NULL CHECK(intent_count BETWEEN 0 AND 4096),
        event_count INTEGER NOT NULL CHECK(event_count BETWEEN 0 AND 32768)
      );
      CREATE TRIGGER provider_publication_no_repair BEFORE UPDATE ON provider_profile_publication_source
        WHEN NEW.degraded<OLD.degraded OR NEW.store_epoch<>OLD.store_epoch OR NEW.owner_id<>OLD.owner_id
          OR NEW.origin<>OLD.origin OR NEW.version<>OLD.version
        BEGIN SELECT RAISE(ABORT,'provider publication source is irreversible'); END;
      CREATE TABLE provider_profile_publication_intents (
        intent_key TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=4096)
      );
      CREATE TABLE provider_profile_publication_events (
        seq INTEGER PRIMARY KEY CHECK(seq BETWEEN 1 AND 32768),
        record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=4096)
      );
    `);
    const epoch = randomUUID();
    db.prepare("INSERT INTO provider_profile_publication_source VALUES(1,1,?,?,?,0,0,'0',0,0)")
      .run(ownerId, epoch, newDatabase ? "new-source-incomplete" : "legacy-incomplete");
    db.prepare("INSERT INTO control_plane_metadata(key,value) VALUES(?,?)").run(EPOCH_KEY, epoch);
  });
}

/** Private server API only. There is deliberately no freeze, source-ack, terminal or cleanup API.
 * Missing/corrupt state disables new admission but must not stop existing grant revocation. */
export class ProviderProfilePublicationStore {
  constructor(private readonly db: DatabaseSync, private readonly ownerId: string) {}

  transaction<T>(work: () => T): T { return fullTransaction(this.db, work); }

  private source(): Source | null {
    try {
      const count = this.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN (?,?,?)")
        .get(...TABLES) as { n: number };
      if (count.n !== TABLES.length) return null;
      const row = this.db.prepare("SELECT * FROM provider_profile_publication_source WHERE singleton=1").get() as unknown as Source | undefined;
      const marker = this.db.prepare("SELECT value FROM control_plane_metadata WHERE key=?").get(EPOCH_KEY) as { value: string } | undefined;
      if (!row || row.version !== 1 || row.owner_id !== this.ownerId || !uuid(row.store_epoch) ||
          marker?.value !== row.store_epoch || row.history_complete !== 0 ||
          !["new-source-incomplete", "legacy-incomplete"].includes(row.origin) ||
          (row.degraded !== 0 && row.degraded !== 1) || !validCounter(row.revision) ||
          !Number.isInteger(row.intent_count) || row.intent_count < 0 || row.intent_count > PROVIDER_PUBLICATION_LIMITS.intents ||
          !Number.isInteger(row.event_count) || row.event_count < 0 || row.event_count > PROVIDER_PUBLICATION_LIMITS.events) return null;
      return row;
    } catch { return null; }
  }

  status(): { status: "healthy" | "degraded" | "disabled"; storeEpoch: string | null; revision: string | null;
    origin: Source["origin"] | null; historyIncomplete: true; physicalRetirementEligible: false } {
    const source = this.source();
    return { status: source ? source.degraded ? "degraded" : "healthy" : "disabled",
      storeEpoch: source?.store_epoch ?? null, revision: source?.revision ?? null, origin: source?.origin ?? null,
      historyIncomplete: true, physicalRetirementEligible: false };
  }

  private degrade(): void {
    // If metadata itself is missing/corrupt it remains disabled: never repair/rotate it. A failure
    // of this UPDATE is allowed to abort the transaction rather than report a committed fence.
    this.db.prepare("UPDATE provider_profile_publication_source SET degraded=1 WHERE singleton=1").run();
  }

  /** Must run within transaction(). On failure, evidence rolls back to the savepoint; the sticky
   * fence remains in the OUTER transaction. Existing grant SQL may still proceed. */
  record(kind: "authorize" | "bind" | "complete" | "revoke" | "supersede" | PublicationDispatchKind | "observe",
    grant: PublicationGrant, options: { requestId?: string; observation?: PublicationObservation; expectedRevision?: string } = {}): string | null {
    if (!this.db.isTransaction) throw new ProviderPublicationUnavailable();
    // A bad caller value refuses only this observation. It is not evidence/store corruption and
    // must not permanently disable unrelated authorization or existing grant security controls.
    if (!validProviderPublicationInput(grant, options.requestId) ||
        ((kind === "login" || kind === "adopt") && options.requestId === undefined)) return null;
    const source = this.source();
    if (!source || source.degraded) return null;
    if (options.expectedRevision !== undefined && options.expectedRevision !== source.revision) return null;
    this.db.exec("SAVEPOINT provider_publication_evidence");
    try {
      const dispatch = kind === "login" || kind === "adopt";
      const intentKey = kind === "authorize" ? `grant:${grant.grantId}` : dispatch ? `request:${options.requestId}` : null;
      if (intentKey && this.db.prepare("SELECT 1 FROM provider_profile_publication_intents WHERE intent_key=?").get(intentKey)) {
        // A committed/ambiguous dispatch intent can NEVER issue a second admission.
        this.db.exec("RELEASE provider_publication_evidence");
        return null;
      }
      if (source.event_count >= PROVIDER_PUBLICATION_LIMITS.events ||
          (intentKey && source.intent_count >= PROVIDER_PUBLICATION_LIMITS.intents) || BigInt(source.revision) === MAX_COUNTER) {
        throw new ProviderPublicationUnavailable();
      }
      const revision = (BigInt(source.revision) + 1n).toString();
      const fields = { version: 1, ownerId: source.owner_id, storeEpoch: source.store_epoch, revision, kind,
        grantId: grant.grantId, profileId: grant.profileId, provider: grant.provider,
        runnerKey: hash("runner", grant.runnerId), accountKey: hash("account", grant.providerAccountId),
        requestId: options.requestId ?? null, observation: options.observation ?? null };
      const ticket = intentKey ? hash("ticket", encode(fields)) : null;
      const text = encode({ ...fields, ticket });
      if (intentKey) this.db.prepare("INSERT INTO provider_profile_publication_intents VALUES(?,?)").run(intentKey, text);
      this.db.prepare("INSERT INTO provider_profile_publication_events VALUES(?,?)").run(source.event_count + 1, text);
      const changed = this.db.prepare(`UPDATE provider_profile_publication_source
        SET revision=?,event_count=event_count+1,intent_count=intent_count+?
        WHERE singleton=1 AND revision=? AND event_count=? AND intent_count=? AND degraded=0`)
        .run(revision, intentKey ? 1 : 0, source.revision, source.event_count, source.intent_count).changes;
      if (changed !== 1) throw new ProviderPublicationUnavailable();
      this.db.exec("RELEASE provider_publication_evidence");
      return ticket ?? revision;
    } catch {
      this.db.exec("ROLLBACK TO provider_publication_evidence; RELEASE provider_publication_evidence");
      this.degrade();
      return null;
    }
  }

  intent(requestId: string): PublicationRecord | null {
    if (!identifier(requestId)) return null;
    try {
      const row = this.db.prepare("SELECT record FROM provider_profile_publication_intents WHERE intent_key=?")
        .get(`request:${requestId}`) as { record: string } | undefined;
      return row ? this.decode(row.record) : null;
    } catch { return null; }
  }

  private decode(text: string): PublicationRecord {
    if (typeof text !== "string" || Buffer.byteLength(text) > PROVIDER_PUBLICATION_LIMITS.recordBytes) throw new ProviderPublicationUnavailable();
    const row = JSON.parse(text) as PublicationRecord;
    const keys = ["version", "ownerId", "storeEpoch", "revision", "kind", "grantId", "profileId", "provider", "runnerKey", "accountKey", "requestId", "ticket", "observation"].sort();
    if (!row || typeof row !== "object" || Object.keys(row).sort().join() !== keys.join() || row.version !== 1 ||
        row.ownerId !== this.ownerId || !uuid(row.storeEpoch) || !validCounter(row.revision) ||
        !["authorize", "bind", "complete", "revoke", "supersede", "login", "adopt", "observe"].includes(row.kind) ||
        !identifier(row.grantId) || (row.profileId !== null && !uuid(row.profileId)) ||
        !["claude", "codex"].includes(row.provider) || !digest(row.runnerKey) || !digest(row.accountKey) ||
        (row.requestId !== null && !identifier(row.requestId)) || (row.ticket !== null && !digest(row.ticket)) ||
        (row.observation !== null && !["reply", "not_sent", "uncertain"].includes(row.observation))) throw new ProviderPublicationUnavailable();
    if (encode(row as unknown as Record<string, string | number | null>) !== text) throw new ProviderPublicationUnavailable();
    return row;
  }

  /** Bounded keyset read for private diagnostics/tests. Never export through a public route. */
  events(after = 0): { records: PublicationRecord[]; nextAfter: number | null } {
    if (!Number.isInteger(after) || after < 0 || after > PROVIDER_PUBLICATION_LIMITS.events) throw new ProviderPublicationUnavailable();
    if (!this.source()) throw new ProviderPublicationUnavailable();
    const rows = this.db.prepare("SELECT seq,record FROM provider_profile_publication_events WHERE seq>? ORDER BY seq LIMIT ?")
      .all(after, PROVIDER_PUBLICATION_LIMITS.page + 1) as unknown as Array<{ seq: number; record: string }>;
    const page = rows.slice(0, PROVIDER_PUBLICATION_LIMITS.page);
    return { records: page.map(row => this.decode(row.record)), nextAfter: rows.length > page.length ? page.at(-1)!.seq : null };
  }
}
