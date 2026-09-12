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
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  validatePromptImageInputs,
  type DurableSessionCommand,
  type DurableSessionCommandErrorCode,
  type DurableSessionCommandMessage,
  type DurableSessionCommandState,
} from "@wollipog/protocol";

const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const MAX_RECEIPTS = 10_000;
const MAX_ERROR = 512;
const OWNER_STALE_MS = 60_000;
const COMMAND_LOCK_STALE_MS = 30_000;

interface DurableCommandRecord {
  version: 1;
  commandId: string;
  executionId: string;
  kind: DurableSessionCommand["type"];
  sessionId: string;
  payloadHmac: string;
  state: DurableSessionCommandState;
  revision: number;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  error?: string;
  code?: DurableSessionCommandErrorCode;
  userEventSeq?: number;
}

export interface DurableCommandReceipt {
  commandId: string;
  sessionId: string;
  state: DurableSessionCommandState;
  revision: number;
  duplicate: boolean;
  error?: string;
  code?: DurableSessionCommandErrorCode;
  userEventSeq?: number;
}

export type DurableCommandClaim =
  | { kind: "new" | "reclaimed"; handle: DurableCommandHandle; receipt: DurableCommandReceipt }
  | { kind: "duplicate" | "conflict"; receipt: DurableCommandReceipt }
  | { kind: "busy" };

export interface DurableCommandStoreOptions {
  ownerId?: string;
  now?: () => number;
  maxReceipts?: number;
  ownerStaleMs?: number;
}

export function durableCommandPayloadDigest(command: DurableSessionCommand): string {
  return createHash("sha256").update(canonicalJson(command), "utf8").digest("hex");
}

export class DurableCommandStore {
  readonly ownerId: string;
  private readonly now: () => number;
  private readonly maxReceipts: number;
  private readonly ownerStaleMs: number;
  private readonly key: Buffer;
  private readonly activeHandles = new Set<string>();
  private readonly heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly root: string, options: DurableCommandStoreOptions = {}) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.maxReceipts = options.maxReceipts ?? MAX_RECEIPTS;
    this.ownerStaleMs = options.ownerStaleMs ?? OWNER_STALE_MS;
    const rootExisted = existsSync(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!rootExisted) this.fsyncDirectory(dirname(root));
    this.key = this.loadOrCreateKey();
    this.heartbeatOwner();
    if (!options.now) {
      this.heartbeatTimer = setInterval(() => {
        try { this.heartbeatOwner(); } catch { /* the next command operation retries the lease */ }
      }, Math.max(1_000, Math.floor(this.ownerStaleMs / 3)));
      this.heartbeatTimer.unref?.();
    }
  }

  claim(message: DurableSessionCommandMessage): DurableCommandClaim {
    const now = this.now();
    const validation = validateMessage(message, now);
    if (validation) {
      return { kind: "conflict", receipt: failedReceipt(message, validation.code, validation.error) };
    }
    const payload = canonicalJson(message.command);
    if (durableCommandPayloadDigest(message.command) !== message.payloadDigest) {
      return {
        kind: "conflict",
        receipt: failedReceipt(message, "INVALID_COMMAND", "durable command payload digest does not match"),
      };
    }
    const payloadHmac = createHmac("sha256", this.key).update(payload, "utf8").digest("hex");
    const file = this.recordPath(message.commandId);
    const record: DurableCommandRecord = {
      version: 1,
      commandId: message.commandId,
      executionId: message.executionId,
      kind: message.command.type,
      sessionId: commandSessionId(message.command),
      payloadHmac,
      state: "accepted",
      revision: 1,
      ownerId: this.ownerId,
      createdAt: now,
      updatedAt: now,
      expiresAt: message.expiresAt,
    };

    this.heartbeatOwner();
    const claimed = this.withCommandLock(message.commandId, () => {
      const existing = this.read(message.commandId);
      if (!existing) {
        if (existsSync(file)) {
          return {
            kind: "conflict" as const,
            receipt: failedReceipt(
              message,
              "INVALID_COMMAND",
              "durable command receipt is malformed; refusing to overwrite its identity",
            ),
          };
        }
        // Capacity is relevant only for a new identity. A full journal must continue serving
        // duplicate acknowledgements, otherwise harmless retries fail closed under load.
        if (this.countRecords() >= this.maxReceipts) {
          this.prune(now);
          if (this.countRecords() >= this.maxReceipts) {
            return {
              kind: "conflict" as const,
              receipt: failedReceipt(message, "RECEIPT_STORE_FULL", "durable command receipt store is full"),
            };
          }
        }
        const shard = dirname(file);
        const shardExisted = existsSync(shard);
        mkdirSync(shard, { recursive: true, mode: 0o700 });
        if (!shardExisted) this.fsyncDirectory(this.root);
        const temp = `${file}.${this.ownerId}.${randomBytes(6).toString("hex")}.tmp`;
        const fd = openSync(temp, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify(record), "utf8");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        try {
          // Publish only a fully written record, without replacing any identity that appeared
          // concurrently. A crash can leave at most an unreferenced temp file.
          linkSync(temp, file);
          this.fsyncDirectory(dirname(file));
        } finally {
          rmSync(temp, { force: true });
        }
        return {
          kind: "new" as const,
          handle: new DurableCommandHandle(this, record),
          receipt: receipt(record, false),
        };
      }
      if (existing.payloadHmac !== payloadHmac || existing.executionId !== message.executionId ||
          existing.kind !== message.command.type || existing.sessionId !== record.sessionId) {
        return {
          kind: "conflict" as const,
          receipt: {
            ...receipt(existing, true),
            state: "failed" as const,
            error: "command id is already bound to a different payload",
            code: "COMMAND_ID_CONFLICT" as const,
          },
        };
      }
      if (isTerminal(existing.state)) return { kind: "duplicate" as const, receipt: receipt(existing, true) };
      if (existing.ownerId === this.ownerId) {
        if (this.activeHandles.has(existing.commandId)) {
          return { kind: "duplicate" as const, receipt: receipt(existing, true) };
        }
        if (existing.state === "started") {
          const uncertain = this.transitionLocked(existing, "uncertain", {
            error: "runner lost the local command handle after provider submission began; command was not replayed",
          }, true);
          return { kind: "duplicate" as const, receipt: receipt(uncertain, true) };
        }
        const reclaimed = this.transitionLocked(existing, "accepted", {}, true);
        return {
          kind: "reclaimed" as const,
          handle: new DurableCommandHandle(this, reclaimed),
          receipt: receipt(reclaimed, true),
        };
      }
      if (this.ownerIsLive(existing.ownerId, now)) {
        return { kind: "duplicate" as const, receipt: receipt(existing, true) };
      }
      if (existing.state === "started") {
        const uncertain = this.transitionLocked(existing, "uncertain", {
          error: "runner restarted after provider submission began; command was not replayed",
        }, true);
        return { kind: "duplicate" as const, receipt: receipt(uncertain, true) };
      }
      const reclaimed = this.transitionLocked(existing, "accepted", {}, true);
      return {
        kind: "reclaimed" as const,
        handle: new DurableCommandHandle(this, reclaimed),
        receipt: receipt(reclaimed, true),
      };
    });
    if (!claimed) {
      // Contention is transport-transient, not a command verdict. Emitting a revision-zero failed
      // receipt here could beat the real owner's accepted ACK and terminalize work that is running.
      return { kind: "busy" };
    }
    return claimed;
  }

  recentUpdates(now = this.now()): DurableCommandReceipt[] {
    const updates: DurableCommandReceipt[] = [];
    for (const file of this.recordFiles()) {
      const record = this.readFile(file);
      if (!record || record.expiresAt < now) continue;
      updates.push(receipt(record, true));
    }
    return updates.sort((a, b) => a.commandId.localeCompare(b.commandId));
  }

  prune(now = this.now()): number {
    let removed = 0;
    for (const file of this.recordFiles()) {
      const record = this.readFile(file);
      if (!record) continue;
      // The CP never retries after this explicit dedupe horizon. Before it, even active receipts
      // are non-evictable; after it, removing a stranded nonterminal record prevents permanent
      // capacity loss if the control plane itself disappeared.
      if (record.expiresAt >= now) continue;
      rmSync(file, { force: true });
      this.fsyncDirectory(dirname(file));
      removed += 1;
    }
    return removed;
  }

  read(commandId: string): DurableCommandRecord | null {
    return this.readFile(this.recordPath(commandId));
  }

  transition(
    prior: DurableCommandRecord,
    state: DurableSessionCommandState,
    patch: { error?: string; code?: DurableSessionCommandErrorCode; userEventSeq?: number },
    takeOwnership = false,
  ): DurableCommandRecord {
    const next = this.withCommandLock(prior.commandId, () =>
      this.transitionLocked(prior, state, patch, takeOwnership));
    if (!next) throw new Error("durable command receipt is busy; retry shortly");
    return next;
  }

  activateHandle(commandId: string): void {
    this.activeHandles.add(commandId);
  }

  releaseHandle(commandId: string): void {
    this.activeHandles.delete(commandId);
  }

  private transitionLocked(
    prior: DurableCommandRecord,
    state: DurableSessionCommandState,
    patch: { error?: string; code?: DurableSessionCommandErrorCode; userEventSeq?: number },
    takeOwnership = false,
  ): DurableCommandRecord {
    const current = this.read(prior.commandId);
    if (!current || current.revision !== prior.revision) throw new Error("durable command receipt changed concurrently");
    if (!takeOwnership && current.ownerId !== this.ownerId) throw new Error("durable command receipt is owned by another runner process");
    const replayReset = takeOwnership && current.state === "queued" && state === "accepted";
    if (!replayReset && !transitionAllowed(current.state, state)) {
      throw new Error(`invalid durable command transition ${current.state} -> ${state}`);
    }
    const next: DurableCommandRecord = {
      ...current,
      state,
      revision: current.revision + 1,
      ownerId: this.ownerId,
      updatedAt: this.now(),
      ...(patch.error ? { error: patch.error.slice(0, MAX_ERROR) } : {}),
      ...(patch.code ? { code: patch.code } : {}),
      ...(patch.userEventSeq !== undefined ? { userEventSeq: patch.userEventSeq } : {}),
    };
    this.writeAtomic(this.recordPath(next.commandId), next);
    return next;
  }

  private loadOrCreateKey(): Buffer {
    const file = join(this.root, "receipt-hmac.key");
    if (existsSync(file)) {
      const key = readFileSync(file);
      if (key.length !== 32) throw new Error("durable command receipt key is malformed");
      return key;
    }
    const key = randomBytes(32);
    const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, key);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // Hard-link publication is no-replace and atomic: a concurrent process can observe only a
      // complete 32-byte key, never the empty/in-progress target of an `open("wx")` writer.
      linkSync(temp, file);
      this.fsyncDirectory(this.root);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readFileSync(file);
      if (existing.length !== 32) throw new Error("durable command receipt key is malformed");
      return existing;
    } finally {
      rmSync(temp, { force: true });
    }
  }

  private recordPath(commandId: string): string {
    const digest = createHash("sha256").update(commandId, "utf8").digest("hex");
    return join(this.root, digest.slice(0, 2), `${digest}.json`);
  }

  private writeAtomic(file: string, record: DurableCommandRecord): void {
    const directory = dirname(file);
    const directoryExisted = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!directoryExisted) this.fsyncDirectory(this.root);
    const temp = `${file}.${this.ownerId}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    this.fsyncDirectory(dirname(file));
  }

  private ownerLeasePath(ownerId: string): string {
    const digest = createHash("sha256").update(ownerId, "utf8").digest("hex");
    return join(this.root, "owners", `${digest}.lease`);
  }

  private heartbeatOwner(): void {
    const file = this.ownerLeasePath(this.ownerId);
    const directory = dirname(file);
    const directoryExisted = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!directoryExisted) this.fsyncDirectory(this.root);
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ ownerId: this.ownerId, pid: process.pid, updatedAt: this.now() }), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    this.fsyncDirectory(dirname(file));
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

  private withCommandLock<T>(commandId: string, run: () => T): T | null {
    const file = `${this.recordPath(commandId)}.lock`;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const token = JSON.stringify({ ownerId: this.ownerId, nonce: randomUUID() });
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(file).mtimeMs <= COMMAND_LOCK_STALE_MS) return null;
        const ownerId = (JSON.parse(readFileSync(file, "utf8")) as { ownerId?: unknown }).ownerId;
        if (typeof ownerId === "string" && this.ownerIsLive(ownerId, this.now())) return null;
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
      } catch { /* a stale-owner takeover already replaced this lock */ }
    }
  }

  private fsyncDirectory(directory: string): void {
    let fd: number | undefined;
    try {
      fd = openSync(directory, "r");
      fsyncSync(fd);
    } catch (error) {
      // Windows does not consistently permit directory handles to be flushed. File handles are
      // still flushed above; POSIX failures remain fatal because directory fsync is the contract.
      if (process.platform !== "win32") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private readFile(file: string): DurableCommandRecord | null {
    if (!existsSync(file)) return null;
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as DurableCommandRecord;
      return validRecord(value) ? value : null;
    } catch {
      return null;
    }
  }

  private recordFiles(): string[] {
    if (!existsSync(this.root)) return [];
    const files: string[] = [];
    for (const shard of readdirSync(this.root, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
      for (const item of readdirSync(join(this.root, shard.name), { withFileTypes: true })) {
        if (item.isFile() && item.name.endsWith(".json")) files.push(join(this.root, shard.name, item.name));
      }
    }
    return files;
  }

  private countRecords(): number {
    return this.recordFiles().length;
  }
}

export class DurableCommandHandle {
  constructor(private readonly store: DurableCommandStore, private record: DurableCommandRecord) {
    this.store.activateHandle(record.commandId);
  }

  get commandId(): string { return this.record.commandId; }
  get state(): DurableSessionCommandState { return this.record.state; }
  get current(): DurableCommandReceipt { return receipt(this.record, false); }

  queued(): DurableCommandReceipt {
    return this.nonterminal(() => this.store.transition(this.record, "queued", {}));
  }

  started(userEventSeq?: number): DurableCommandReceipt {
    return this.nonterminal(() => this.store.transition(this.record, "started", { userEventSeq }));
  }

  completed(): DurableCommandReceipt {
    return this.terminal(() => this.store.transition(this.record, "completed", {}));
  }

  failed(error: string, code?: DurableSessionCommandErrorCode): DurableCommandReceipt {
    return this.terminal(() => this.store.transition(this.record, "failed", { error, code }));
  }

  uncertain(error: string): DurableCommandReceipt {
    return this.terminal(() => this.store.transition(this.record, "uncertain", { error }));
  }

  private nonterminal(run: () => DurableCommandRecord): DurableCommandReceipt {
    try {
      this.record = run();
      return this.current;
    } catch (error) {
      // The caller may have already removed this command from its in-memory queue. Relinquish the
      // local handle so a sender retry can safely reclaim accepted/queued work in this process.
      this.store.releaseHandle(this.record.commandId);
      throw error;
    }
  }

  private terminal(run: () => DurableCommandRecord): DurableCommandReceipt {
    try {
      this.record = run();
      return this.current;
    } finally {
      this.store.releaseHandle(this.record.commandId);
    }
  }
}

function validateMessage(
  message: DurableSessionCommandMessage,
  now: number,
): { code: DurableSessionCommandErrorCode; error: string } | null {
  if (!isDurableSessionCommandMessage(message)) {
    return { code: "INVALID_COMMAND", error: "durable command envelope is malformed" };
  }
  if (!COMMAND_ID.test(message.commandId) || !COMMAND_ID.test(message.executionId)) {
    return { code: "INVALID_COMMAND", error: "durable command identity is invalid" };
  }
  if (!Number.isFinite(message.expiresAt) || message.expiresAt <= now) {
    return { code: "COMMAND_EXPIRED", error: "durable command has expired" };
  }
  if (!/^[a-f0-9]{64}$/.test(message.payloadDigest)) {
    return { code: "INVALID_COMMAND", error: "durable command payload digest is invalid" };
  }
  if (message.command.type !== "start_session" && message.command.type !== "prompt_session" &&
      message.command.type !== "answer_recovered_question") {
    return { code: "INVALID_COMMAND", error: "durable command kind is unsupported" };
  }
  return null;
}

function failedReceipt(
  message: DurableSessionCommandMessage,
  code: DurableSessionCommandErrorCode,
  error: string,
): DurableCommandReceipt {
  return {
    commandId: typeof message?.commandId === "string" ? message.commandId : "invalid",
    sessionId: safeCommandSessionId(message?.command),
    state: "failed",
    revision: 0,
    duplicate: false,
    code,
    error: error.slice(0, MAX_ERROR),
  };
}

function receipt(record: DurableCommandRecord, duplicate: boolean): DurableCommandReceipt {
  return {
    commandId: record.commandId,
    sessionId: record.sessionId,
    state: record.state,
    revision: record.revision,
    duplicate,
    ...(record.error ? { error: record.error } : {}),
    ...(record.code ? { code: record.code } : {}),
    ...(record.userEventSeq !== undefined ? { userEventSeq: record.userEventSeq } : {}),
  };
}

function transitionAllowed(from: DurableSessionCommandState, to: DurableSessionCommandState): boolean {
  if (from === to) return true;
  if (isTerminal(from)) return false;
  if (to === "failed" || to === "uncertain") return true;
  if (from === "accepted") return to === "queued" || to === "started" || to === "completed";
  if (from === "queued") return to === "started" || to === "completed";
  return from === "started" && to === "completed";
}

function isTerminal(state: DurableSessionCommandState): boolean {
  return state === "completed" || state === "failed" || state === "uncertain";
}

function validRecord(value: DurableCommandRecord): boolean {
  return value?.version === 1 && COMMAND_ID.test(value.commandId) && COMMAND_ID.test(value.executionId) &&
    (value.kind === "start_session" || value.kind === "prompt_session" ||
      value.kind === "answer_recovered_question") && typeof value.sessionId === "string" &&
    /^[a-f0-9]{64}$/.test(value.payloadHmac) && Number.isInteger(value.revision) && value.revision > 0 &&
    typeof value.ownerId === "string" && Number.isFinite(value.createdAt) && Number.isFinite(value.updatedAt) &&
    Number.isFinite(value.expiresAt) && ["accepted", "queued", "started", "completed", "failed", "uncertain"].includes(value.state);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function commandSessionId(command: DurableSessionCommand): string {
  return command.type === "start_session" ? command.spec.sessionId : command.sessionId;
}

function safeCommandSessionId(command: unknown): string {
  if (!isObject(command)) return "";
  if (command.type === "start_session" && isObject(command.spec) && typeof command.spec.sessionId === "string") {
    return command.spec.sessionId;
  }
  return (command.type === "prompt_session" || command.type === "answer_recovered_question") &&
    typeof command.sessionId === "string" ? command.sessionId : "";
}

export function isDurableSessionCommandMessage(value: unknown): value is DurableSessionCommandMessage {
  if (!isObject(value) || value.type !== "durable_session_command" ||
      typeof value.requestId !== "string" || !value.requestId ||
      typeof value.commandId !== "string" || typeof value.executionId !== "string" ||
      typeof value.payloadDigest !== "string" || typeof value.expiresAt !== "number" ||
      !isObject(value.command)) return false;
  const command = value.command;
  if (command.type === "prompt_session") {
    return typeof command.sessionId === "string" && Boolean(command.sessionId) &&
      typeof command.text === "string" &&
      (command.images === undefined || (Array.isArray(command.images) && validatePromptImageInputs(command.images as never[]).ok)) &&
      (command.slashCommand === undefined || typeof command.slashCommand === "string") &&
      (command.config === undefined || isObject(command.config));
  }
  if (command.type === "answer_recovered_question") {
    return typeof command.sessionId === "string" && Boolean(command.sessionId) &&
      typeof command.requestId === "string" && Boolean(command.requestId) &&
      typeof command.recoveryId === "string" && Boolean(command.recoveryId) &&
      isQuestionAnswerMap(command.answers);
  }
  if (command.type !== "start_session" || !isObject(command.spec)) return false;
  const spec = command.spec;
  return typeof spec.sessionId === "string" && Boolean(spec.sessionId) &&
    (spec.workspaceId === null || typeof spec.workspaceId === "string") &&
    typeof spec.workspacePath === "string" && typeof spec.agentId === "string" &&
    typeof spec.command === "string" && Array.isArray(spec.args) && spec.args.every((arg) => typeof arg === "string") &&
    isObject(spec.env) && Object.values(spec.env).every((item) => typeof item === "string") &&
    typeof spec.useWorktree === "boolean" &&
    (spec.title === undefined || typeof spec.title === "string") &&
    (spec.initialPrompt === undefined || typeof spec.initialPrompt === "string") &&
    (command.initialPrompt === undefined || typeof command.initialPrompt === "string") &&
    (command.initialImages === undefined || (Array.isArray(command.initialImages) && validatePromptImageInputs(command.initialImages as never[]).ok)) &&
    (spec.config === undefined || isObject(spec.config)) &&
    (spec.context === undefined || isObject(spec.context)) &&
    (spec.acpSessionContext === undefined || isObject(spec.acpSessionContext));
}

function isQuestionAnswerMap(value: unknown): value is Record<string, string | string[]> {
  if (!isObject(value) || Object.keys(value).length > 100) return false;
  return Object.entries(value).every(([key, answer]) =>
    Boolean(key) && key.length <= 4_096 && (
      typeof answer === "string"
        ? answer.length <= 4_000
        : Array.isArray(answer) && answer.length <= 100 &&
          answer.every((item) => typeof item === "string" && item.length <= 4_000)
    ));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
