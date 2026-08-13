import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  InvokeSessionCommandMessage,
  SessionCommandInvocationErrorCode,
  SessionCommandInvocationState,
} from "@wollipog/protocol";

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_RECEIPTS = 10_000;
const MAX_ERROR = 512;
const OWNER_STALE_MS = 60_000;
const LOCK_STALE_MS = 30_000;

type ReceiptState = Exclude<SessionCommandInvocationState, "pending" | "sent">;

interface SessionCommandReceiptRecord {
  version: 1 | 2;
  requestId: string;
  invocationId: string;
  submissionId: string;
  sessionId: string;
  payloadDigest: string;
  state: ReceiptState;
  revision: number;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** Version 2 retains the exact CP-authored envelope needed to recover accepted/queued work after
   * a runner-process restart. Version 1 records remain readable for dedupe, but are not replayable
   * without a fresh message from the control plane. */
  providerCommandId?: string;
  catalogRevision?: string;
  expectedExecutionMode?: InvokeSessionCommandMessage["expectedExecutionMode"];
  argumentText?: string;
  error?: string;
  code?: SessionCommandInvocationErrorCode;
  userEventSeq?: number;
}

export interface SessionCommandInvocationReceipt {
  requestId: string;
  invocationId: string;
  submissionId: string;
  sessionId: string;
  state: ReceiptState;
  revision: number;
  duplicate: boolean;
  error?: string;
  code?: SessionCommandInvocationErrorCode;
  userEventSeq?: number;
}

export type SessionCommandReceiptClaim =
  | {
      kind: "new" | "reclaimed";
      handle: SessionCommandReceiptHandle;
      receipt: SessionCommandInvocationReceipt;
    }
  | { kind: "duplicate" | "conflict"; receipt: SessionCommandInvocationReceipt }
  | { kind: "busy" };

export interface RecoverableSessionCommandReceipt {
  message: InvokeSessionCommandMessage;
  state: Extract<ReceiptState, "accepted" | "queued" | "started">;
}

export interface SessionCommandReceiptStoreOptions {
  ownerId?: string;
  now?: () => number;
  maxReceipts?: number;
  ownerStaleMs?: number;
}

type InvocationPayload = Pick<
  InvokeSessionCommandMessage,
  | "submissionId"
  | "sessionId"
  | "providerCommandId"
  | "catalogRevision"
  | "expectedExecutionMode"
  | "argumentText"
>;

/** Digest of command meaning. Transport request ids, expiry, and the invocation id are not payload. */
export function sessionCommandInvocationPayloadDigest(payload: InvocationPayload): string {
  return createHash("sha256").update(canonicalJson({
    argumentText: payload.argumentText,
    catalogRevision: payload.catalogRevision,
    expectedExecutionMode: payload.expectedExecutionMode,
    providerCommandId: payload.providerCommandId,
    sessionId: payload.sessionId,
    submissionId: payload.submissionId,
  }), "utf8").digest("hex");
}

/** A journal dedicated to explicit, manual session commands. Its root and capacity are independent
 * of the durable automation-command journal so neither workload can evict the other. */
export class SessionCommandReceiptStore {
  readonly ownerId: string;
  private readonly now: () => number;
  private readonly maxReceipts: number;
  private readonly ownerStaleMs: number;
  private readonly activeHandles = new Set<string>();
  /** One startup scan seeds these indexes. The 10-second recovery path reads only nonterminal
   * candidates and expiry metadata; it never enumerates a journal full of terminal history. */
  private readonly knownRecordFiles = new Set<string>();
  private readonly expiresAtByInvocation = new Map<string, number>();
  private readonly nonterminalCandidates = new Set<string>();
  private fullRecordScans = 0;
  private readonly heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly root: string, options: SessionCommandReceiptStoreOptions = {}) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.maxReceipts = options.maxReceipts ?? MAX_RECEIPTS;
    this.ownerStaleMs = options.ownerStaleMs ?? OWNER_STALE_MS;
    const rootExisted = existsSync(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!rootExisted) this.fsyncDirectory(dirname(root));
    this.rebuildRecordIndex();
    this.heartbeatOwner();
    if (!options.now) {
      this.heartbeatTimer = setInterval(() => {
        try { this.heartbeatOwner(); } catch { /* the next store operation retries the lease */ }
      }, Math.max(1_000, Math.floor(this.ownerStaleMs / 3)));
      this.heartbeatTimer.unref?.();
    }
  }

  claim(message: InvokeSessionCommandMessage): SessionCommandReceiptClaim {
    const now = this.now();
    const validation = validateMessage(message, now);
    if (validation) {
      return { kind: "conflict", receipt: failedReceipt(message, validation.code, validation.error) };
    }
    if (sessionCommandInvocationPayloadDigest(message) !== message.payloadDigest) {
      return {
        kind: "conflict",
        receipt: failedReceipt(message, "INVALID_COMMAND", "session command payload digest does not match"),
      };
    }

    const file = this.recordPath(message.invocationId);
    const record: SessionCommandReceiptRecord = {
      version: 2,
      requestId: message.requestId,
      invocationId: message.invocationId,
      submissionId: message.submissionId,
      sessionId: message.sessionId,
      payloadDigest: message.payloadDigest,
      state: "accepted",
      revision: 1,
      ownerId: this.ownerId,
      createdAt: now,
      updatedAt: now,
      expiresAt: message.expiresAt,
      providerCommandId: message.providerCommandId,
      catalogRevision: message.catalogRevision,
      expectedExecutionMode: message.expectedExecutionMode,
      argumentText: message.argumentText,
    };

    this.heartbeatOwner();
    const claimed = this.withLock(message.invocationId, () => {
      let existing = this.read(message.invocationId);
      if (!existing) {
        if (existsSync(file)) {
          return {
            kind: "conflict" as const,
            receipt: failedReceipt(
              message,
              "INVALID_COMMAND",
              "session command receipt is malformed; refusing to overwrite its identity",
            ),
          };
        }
        if (this.countRecords() >= this.maxReceipts) {
          this.prune(now);
          if (this.countRecords() >= this.maxReceipts) {
            return {
              kind: "conflict" as const,
              receipt: failedReceipt(message, "RECEIPT_STORE_FULL", "session command receipt store is full"),
            };
          }
        }
        try {
          this.publishNew(file, record);
        } finally {
          // publishNew can surface a directory-fsync error after the link is already durable. Keep
          // the process-local index aligned with whatever actually reached the journal.
          const persisted = this.readFile(file);
          if (persisted) this.indexRecord(persisted);
        }
        return {
          kind: "new" as const,
          handle: new SessionCommandReceiptHandle(this, record),
          receipt: toReceipt(record, false),
        };
      }

      if (!sameIdentity(existing, record)) {
        return {
          kind: "conflict" as const,
          receipt: {
            ...toReceipt(existing, true, message.requestId),
            state: "rejected" as const,
            error: "invocation id is already bound to a different payload or owner",
            code: "COMMAND_ID_CONFLICT" as const,
          },
        };
      }
      if (existing.version === 1) {
        existing = {
          ...existing,
          version: 2,
          providerCommandId: message.providerCommandId,
          catalogRevision: message.catalogRevision,
          expectedExecutionMode: message.expectedExecutionMode,
          argumentText: message.argumentText,
        };
        // Format enrichment does not change lifecycle meaning, so preserve the monotonic receipt
        // revision while making any later owner-stale recovery reconstructable.
        this.writeAtomic(file, existing);
        this.indexRecord(existing);
      }
      if (isTerminal(existing.state)) {
        return { kind: "duplicate" as const, receipt: toReceipt(existing, true, message.requestId) };
      }
      if (existing.ownerId === this.ownerId && this.activeHandles.has(existing.invocationId)) {
        return { kind: "duplicate" as const, receipt: toReceipt(existing, true, message.requestId) };
      }
      if (existing.ownerId !== this.ownerId && this.ownerIsLive(existing.ownerId, now)) {
        return { kind: "duplicate" as const, receipt: toReceipt(existing, true, message.requestId) };
      }
      if (existing.state === "started") {
        const uncertain = this.transitionLocked(existing, "uncertain", {
          error: "runner lost the command receipt after provider submission began; command was not replayed",
        }, true);
        return { kind: "duplicate" as const, receipt: toReceipt(uncertain, true, message.requestId) };
      }
      const reclaimed = this.transitionLocked(existing, "accepted", {}, true);
      return {
        kind: "reclaimed" as const,
        handle: new SessionCommandReceiptHandle(this, reclaimed),
        receipt: toReceipt(reclaimed, true, message.requestId),
      };
    });
    return claimed ?? { kind: "busy" };
  }

  recentUpdates(now = this.now()): SessionCommandInvocationReceipt[] {
    const updates: SessionCommandInvocationReceipt[] = [];
    // Reconnect replay is an explicit full inventory boundary. Rebuild here so externally-added
    // legacy files become indexed without making the periodic recovery timer enumerate shards.
    for (const record of this.rebuildRecordIndex()) {
      if (record.expiresAt >= now) updates.push(toReceipt(record, true));
    }
    return updates.sort((a, b) => a.invocationId.localeCompare(b.invocationId));
  }

  /** Return reconstructable, nonterminal records whose prior owner can no longer be live. The
   * caller decides whether accepted/queued work has fresh live authority and queue capacity before
   * passing the envelope back through claim(); started work is always claimed so it becomes
   * uncertain without risking a second provider submission. */
  staleRecoveries(now = this.now()): RecoverableSessionCommandReceipt[] {
    const recoveries: RecoverableSessionCommandReceipt[] = [];
    for (const invocationId of [...this.nonterminalCandidates]) {
      const file = this.recordPath(invocationId);
      const record = this.readFile(file);
      if (!record) {
        if (!existsSync(file)) this.dropIndexedRecord(invocationId);
        else this.nonterminalCandidates.delete(invocationId);
        continue;
      }
      this.indexRecord(record);
      if (record.expiresAt <= now ||
          (record.state !== "accepted" && record.state !== "queued" && record.state !== "started")) continue;
      if (record.ownerId === this.ownerId && this.activeHandles.has(record.invocationId)) continue;
      if (record.ownerId !== this.ownerId && this.ownerIsLive(record.ownerId, now)) continue;
      const message = messageFromRecord(record);
      if (message) recoveries.push({ message, state: record.state });
    }
    return recoveries.sort((left, right) => left.message.invocationId.localeCompare(right.message.invocationId));
  }

  prune(now = this.now(), maxRemovals = Number.POSITIVE_INFINITY): number {
    let removed = 0;
    const changedDirectories = new Set<string>();
    for (const [invocationId, expiresAt] of [...this.expiresAtByInvocation]) {
      if (expiresAt >= now || removed >= maxRemovals) continue;
      const file = this.recordPath(invocationId);
      const existed = existsSync(file);
      rmSync(file, { force: true });
      if (existed) {
        changedDirectories.add(dirname(file));
        removed += 1;
      }
      this.dropIndexedRecord(invocationId);
    }
    for (const directory of changedDirectories) this.fsyncDirectory(directory);
    return removed;
  }

  read(invocationId: string): SessionCommandReceiptRecord | null {
    const file = this.recordPath(invocationId);
    const record = this.readFile(file);
    if (record) this.indexRecord(record);
    else if (!existsSync(file)) this.dropIndexedRecord(invocationId);
    return record;
  }

  transition(
    prior: SessionCommandReceiptRecord,
    state: ReceiptState,
    patch: { error?: string; code?: SessionCommandInvocationErrorCode; userEventSeq?: number },
    takeOwnership = false,
  ): SessionCommandReceiptRecord {
    const next = this.withLock(prior.invocationId, () =>
      this.transitionLocked(prior, state, patch, takeOwnership));
    if (!next) throw new Error("session command receipt is busy; retry shortly");
    return next;
  }

  activateHandle(invocationId: string): void { this.activeHandles.add(invocationId); }
  releaseHandle(invocationId: string): void { this.activeHandles.delete(invocationId); }

  private transitionLocked(
    prior: SessionCommandReceiptRecord,
    state: ReceiptState,
    patch: { error?: string; code?: SessionCommandInvocationErrorCode; userEventSeq?: number },
    takeOwnership = false,
  ): SessionCommandReceiptRecord {
    const current = this.read(prior.invocationId);
    if (!current || current.revision !== prior.revision) throw new Error("session command receipt changed concurrently");
    if (!takeOwnership && current.ownerId !== this.ownerId) throw new Error("session command receipt is owned by another runner process");
    const replayReset = takeOwnership && current.state === "queued" && state === "accepted";
    if (!replayReset && !transitionAllowed(current.state, state)) {
      throw new Error(`invalid session command transition ${current.state} -> ${state}`);
    }
    const next: SessionCommandReceiptRecord = {
      ...current,
      state,
      revision: current.revision + 1,
      ownerId: this.ownerId,
      updatedAt: this.now(),
      ...(patch.error ? { error: patch.error.slice(0, MAX_ERROR) } : {}),
      ...(patch.code ? { code: patch.code } : {}),
      ...(patch.userEventSeq !== undefined ? { userEventSeq: patch.userEventSeq } : {}),
    };
    this.writeAtomic(this.recordPath(next.invocationId), next);
    this.indexRecord(next);
    return next;
  }

  private publishNew(file: string, record: SessionCommandReceiptRecord): void {
    const directory = dirname(file);
    const existed = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existed) this.fsyncDirectory(this.root);
    const temp = `${file}.${this.ownerId}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, file);
      this.fsyncDirectory(directory);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  private writeAtomic(file: string, record: SessionCommandReceiptRecord): void {
    const directory = dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${this.ownerId}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    this.fsyncDirectory(directory);
  }

  private recordPath(invocationId: string): string {
    const digest = createHash("sha256").update(invocationId, "utf8").digest("hex");
    return join(this.root, digest.slice(0, 2), `${digest}.json`);
  }

  private ownerLeasePath(ownerId: string): string {
    const digest = createHash("sha256").update(ownerId, "utf8").digest("hex");
    return join(this.root, "owners", `${digest}.lease`);
  }

  private heartbeatOwner(): void {
    const file = this.ownerLeasePath(this.ownerId);
    const directory = dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ ownerId: this.ownerId, updatedAt: this.now() }), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    this.fsyncDirectory(directory);
  }

  private ownerIsLive(ownerId: string, now: number): boolean {
    try {
      const value = JSON.parse(readFileSync(this.ownerLeasePath(ownerId), "utf8")) as {
        ownerId?: unknown; updatedAt?: unknown;
      };
      return value.ownerId === ownerId && typeof value.updatedAt === "number" &&
        now - value.updatedAt < this.ownerStaleMs;
    } catch {
      return false;
    }
  }

  private withLock<T>(invocationId: string, run: () => T): T | null {
    const file = `${this.recordPath(invocationId)}.lock`;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const token = JSON.stringify({ ownerId: this.ownerId, nonce: randomUUID() });
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(file).mtimeMs <= LOCK_STALE_MS) return null;
        rmSync(file);
        fd = openSync(file, "wx", 0o600);
      } catch {
        return null;
      }
    }
    try {
      writeFileSync(fd, token, "utf8");
      fsyncSync(fd);
      return run();
    } finally {
      closeSync(fd);
      try {
        if (readFileSync(file, "utf8") === token) rmSync(file, { force: true });
      } catch { /* a stale-owner takeover replaced the lock */ }
    }
  }

  private readFile(file: string): SessionCommandReceiptRecord | null {
    if (!existsSync(file)) return null;
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as SessionCommandReceiptRecord;
      return validRecord(value) ? value : null;
    } catch {
      return null;
    }
  }

  private recordFiles(): string[] {
    this.fullRecordScans += 1;
    const files: string[] = [];
    for (const shard of readdirSync(this.root, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
      for (const item of readdirSync(join(this.root, shard.name), { withFileTypes: true })) {
        if (item.isFile() && item.name.endsWith(".json")) files.push(join(this.root, shard.name, item.name));
      }
    }
    return files;
  }

  private countRecords(): number { return this.knownRecordFiles.size; }

  private rebuildRecordIndex(): SessionCommandReceiptRecord[] {
    const files = this.recordFiles();
    this.knownRecordFiles.clear();
    this.expiresAtByInvocation.clear();
    this.nonterminalCandidates.clear();
    const records: SessionCommandReceiptRecord[] = [];
    for (const file of files) {
      this.knownRecordFiles.add(file);
      const record = this.readFile(file);
      if (!record) continue;
      records.push(record);
      this.indexRecord(record);
    }
    return records;
  }

  private indexRecord(record: SessionCommandReceiptRecord): void {
    this.knownRecordFiles.add(this.recordPath(record.invocationId));
    this.expiresAtByInvocation.set(record.invocationId, record.expiresAt);
    if (isTerminal(record.state)) this.nonterminalCandidates.delete(record.invocationId);
    else this.nonterminalCandidates.add(record.invocationId);
  }

  private dropIndexedRecord(invocationId: string): void {
    this.knownRecordFiles.delete(this.recordPath(invocationId));
    this.expiresAtByInvocation.delete(invocationId);
    this.nonterminalCandidates.delete(invocationId);
  }

  private fsyncDirectory(directory: string): void {
    let fd: number | undefined;
    try {
      fd = openSync(directory, "r");
      fsyncSync(fd);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

export class SessionCommandReceiptHandle {
  constructor(private readonly store: SessionCommandReceiptStore, private record: SessionCommandReceiptRecord) {
    this.store.activateHandle(record.invocationId);
  }

  get invocationId(): string { return this.record.invocationId; }
  get state(): ReceiptState { return this.record.state; }
  get current(): SessionCommandInvocationReceipt { return toReceipt(this.record, false); }

  queued(): SessionCommandInvocationReceipt {
    return this.nonterminal(() => this.store.transition(this.record, "queued", {}));
  }

  started(userEventSeq?: number): SessionCommandInvocationReceipt {
    return this.nonterminal(() => this.store.transition(this.record, "started", { userEventSeq }));
  }

  completed(): SessionCommandInvocationReceipt {
    return this.terminal(() => this.store.transition(this.record, "completed", {}));
  }

  failed(error: string, code?: SessionCommandInvocationErrorCode): SessionCommandInvocationReceipt {
    return this.terminal(() => this.store.transition(this.record, "rejected", { error, code }));
  }

  uncertain(error: string): SessionCommandInvocationReceipt {
    return this.terminal(() => this.store.transition(this.record, "uncertain", { error }));
  }

  private nonterminal(run: () => SessionCommandReceiptRecord): SessionCommandInvocationReceipt {
    try {
      this.record = run();
      return this.current;
    } catch (error) {
      this.store.releaseHandle(this.record.invocationId);
      throw error;
    }
  }

  private terminal(run: () => SessionCommandReceiptRecord): SessionCommandInvocationReceipt {
    try {
      this.record = run();
      return this.current;
    } finally {
      this.store.releaseHandle(this.record.invocationId);
    }
  }
}

function validateMessage(
  message: InvokeSessionCommandMessage,
  now: number,
): { code: SessionCommandInvocationErrorCode; error: string } | null {
  if (!isInvokeSessionCommandMessage(message)) return { code: "INVALID_COMMAND", error: "session command envelope is malformed" };
  if (![message.requestId, message.invocationId, message.submissionId, message.sessionId].every((value) => ID.test(value))) {
    return { code: "INVALID_COMMAND", error: "session command identity is invalid" };
  }
  if (!DIGEST.test(message.payloadDigest)) return { code: "INVALID_COMMAND", error: "session command payload digest is invalid" };
  if (!Number.isFinite(message.expiresAt) || message.expiresAt <= now) {
    return { code: "COMMAND_EXPIRED", error: "session command has expired" };
  }
  return null;
}

export function isInvokeSessionCommandMessage(value: unknown): value is InvokeSessionCommandMessage {
  if (!isObject(value) || value.type !== "invoke_session_command") return false;
  return typeof value.requestId === "string" && typeof value.invocationId === "string" &&
    typeof value.submissionId === "string" && typeof value.payloadDigest === "string" &&
    typeof value.expiresAt === "number" && typeof value.sessionId === "string" &&
    typeof value.providerCommandId === "string" && Boolean(value.providerCommandId) &&
    typeof value.catalogRevision === "string" && Boolean(value.catalogRevision) &&
    (value.expectedExecutionMode === "passthrough" || value.expectedExecutionMode === "structured") &&
    typeof value.argumentText === "string";
}

function failedReceipt(
  message: InvokeSessionCommandMessage,
  code: SessionCommandInvocationErrorCode,
  error: string,
): SessionCommandInvocationReceipt {
  return {
    requestId: typeof message?.requestId === "string" ? message.requestId : "invalid",
    invocationId: typeof message?.invocationId === "string" ? message.invocationId : "invalid",
    submissionId: typeof message?.submissionId === "string" ? message.submissionId : "invalid",
    sessionId: typeof message?.sessionId === "string" ? message.sessionId : "",
    state: "rejected",
    // Even a locally-generated terminal rejection is the first authoritative receipt for this
    // invocation. Revision one lets a control plane in pending/sent state accept it monotonically.
    revision: 1,
    duplicate: false,
    code,
    error: error.slice(0, MAX_ERROR),
  };
}

function sameIdentity(a: SessionCommandReceiptRecord, b: SessionCommandReceiptRecord): boolean {
  return a.payloadDigest === b.payloadDigest && a.submissionId === b.submissionId && a.sessionId === b.sessionId;
}

function toReceipt(
  record: SessionCommandReceiptRecord,
  duplicate: boolean,
  requestId = record.requestId,
): SessionCommandInvocationReceipt {
  return {
    requestId,
    invocationId: record.invocationId,
    submissionId: record.submissionId,
    sessionId: record.sessionId,
    state: record.state,
    revision: record.revision,
    duplicate,
    ...(record.error ? { error: record.error } : {}),
    ...(record.code ? { code: record.code } : {}),
    ...(record.userEventSeq !== undefined ? { userEventSeq: record.userEventSeq } : {}),
  };
}

function transitionAllowed(from: ReceiptState, to: ReceiptState): boolean {
  if (isTerminal(from)) return false;
  if (from === to) return true;
  if (to === "rejected" || to === "uncertain") return true;
  if (from === "accepted") return to === "queued" || to === "started" || to === "completed";
  if (from === "queued") return to === "started" || to === "completed";
  return from === "started" && to === "completed";
}

function isTerminal(state: ReceiptState): boolean {
  return state === "completed" || state === "rejected" || state === "uncertain";
}

function validRecord(value: SessionCommandReceiptRecord): boolean {
  const base = (value?.version === 1 || value?.version === 2) && ID.test(value.requestId) && ID.test(value.invocationId) &&
    ID.test(value.submissionId) && ID.test(value.sessionId) && DIGEST.test(value.payloadDigest) &&
    ["accepted", "queued", "started", "completed", "rejected", "uncertain"].includes(value.state) &&
    Number.isInteger(value.revision) && value.revision > 0 && typeof value.ownerId === "string" &&
    Number.isFinite(value.createdAt) && Number.isFinite(value.updatedAt) && Number.isFinite(value.expiresAt);
  if (!base || value.version === 1) return base;
  return typeof value.providerCommandId === "string" && Boolean(value.providerCommandId) &&
    typeof value.catalogRevision === "string" && Boolean(value.catalogRevision) &&
    (value.expectedExecutionMode === "passthrough" || value.expectedExecutionMode === "structured") &&
    typeof value.argumentText === "string";
}

function messageFromRecord(record: SessionCommandReceiptRecord): InvokeSessionCommandMessage | null {
  if (record.version !== 2 || !record.providerCommandId || !record.catalogRevision ||
      !record.expectedExecutionMode || record.argumentText === undefined) return null;
  return {
    type: "invoke_session_command",
    requestId: record.requestId,
    invocationId: record.invocationId,
    submissionId: record.submissionId,
    payloadDigest: record.payloadDigest,
    expiresAt: record.expiresAt,
    sessionId: record.sessionId,
    providerCommandId: record.providerCommandId,
    catalogRevision: record.catalogRevision,
    expectedExecutionMode: record.expectedExecutionMode,
    argumentText: record.argumentText,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
