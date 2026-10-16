import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { claudeProviderPipeHelper } from "./claude-provider-pipe-helper.js";
import type { AgentProcess, BwrapSpawnIsolation, SpawnAgentOptions } from "./spawn.js";

const HEADER = 26;
const MAX_FRAME = 1024 * 1024;
const MAX_ARG_BYTES = 128 * 1024 - 1;
const INPUT_CHUNK = 16 * 1024;
const TARGET = "/tmp/wollipog-claude-provider-pipe";
const owners = new WeakMap<object, ClaudeNamespace>();
const namespaces = new Set<ClaudeNamespace>();
const virtualKills = new WeakMap<AgentProcess, () => Promise<boolean>>();
const virtualNamespaces = new WeakMap<AgentProcess, ClaudeNamespace>();
const TASK_PREFIX = "wollipog-claude-tasks-";

function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  } catch { return undefined; }
}

function reconcileStaleTaskRoots(sessionKey: string): void {
  const prefix = `${TASK_PREFIX}${sessionKey}-`;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(prefix)) continue;
    const path = join(tmpdir(), name);
    let info;
    try { info = lstatSync(path); } catch { continue; }
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o700) continue;
    let owner: { pid?: number; startTime?: string } | undefined;
    try { owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as typeof owner; }
    catch {
      // Another runner may be between mkdtemp and writing its owner identity.
      if (Date.now() - info.mtimeMs < 60_000) continue;
    }
    if (owner && Number.isSafeInteger(owner.pid) && owner.pid! > 0 &&
        owner.startTime && processStartTime(owner.pid!) === owner.startTime) continue;
    try { rmSync(path, { recursive: true, force: true }); }
    catch (error) {
      throw new Error(`stale Claude task root could not be reconciled: ${(error as Error).message}`);
    }
  }
}

function frame(kind: number, token: Buffer, generation: number, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(HEADER);
  header[0] = 1;
  header[1] = kind;
  token.copy(header, 2);
  header.writeUInt32BE(generation, 18);
  header.writeUInt32BE(payload.length, 22);
  return Buffer.concat([header, payload]);
}

function providerStart(command: string, args: string[], env: NodeJS.ProcessEnv): Buffer {
  const words = [command, ...args];
  if (words.length > 128) throw new Error("Claude provider argv exceeds supervisor limit");
  const parts = [Buffer.alloc(2)];
  parts[0]!.writeUInt16BE(words.length);
  for (const word of words) {
    const data = Buffer.from(word);
    if (data.length === 0 || data.length > MAX_ARG_BYTES || data.includes(0)) {
      throw new Error("Claude provider argv contains an invalid argument");
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    parts.push(size, data);
  }
  const entries = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 512) throw new Error("Claude provider environment exceeds supervisor limit");
  const count = Buffer.alloc(2);
  count.writeUInt16BE(entries.length);
  parts.push(count);
  for (const [key, value] of entries) {
    if (!key || key.includes("=") || key.includes("\0") || value.includes("\0")) {
      throw new Error("Claude provider environment contains an invalid entry");
    }
    const data = Buffer.from(`${key}=${value}`);
    if (data.length > 32768) throw new Error("Claude provider environment entry exceeds supervisor limit");
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    parts.push(size, data);
  }
  const payload = Buffer.concat(parts);
  if (payload.length > MAX_FRAME) throw new Error("Claude provider launch exceeds supervisor frame");
  return payload;
}

/** Preserve the C supervisor's absolute-executable invariant for configured PATH commands. */
function absoluteCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const paths = isAbsolute(command) ? [command] : command.includes("/") ? [resolve(cwd, command)] :
    (env.PATH ?? "/usr/bin:/bin").split(delimiter).filter(Boolean)
      .map((directory) => resolve(cwd, directory, command));
  for (const candidate of paths) {
    try {
      // Validate the target, but execute the installation entry point: shims
      // such as Volta and mise dispatch based on the name used to invoke them.
      const target = realpathSync(candidate);
      if (!isAbsolute(target) || !statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* try next PATH entry */ }
  }
  throw new Error("Claude provider executable could not be resolved to an absolute file");
}

class VirtualProvider extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  closeObserved = false;
  closed = false;
  started = false;
  private pendingInput: ((error?: Error | null) => void) | undefined;
  private queuedInput: Buffer | undefined;
  private pendingEnd = false;

  constructor(readonly session: ClaudeNamespace, readonly generation: number) {
    super();
    this.pid = session.outer.pid;
    this.stdin = new Writable({
      write: (data: Buffer, _encoding, done) => this.writeInput(Buffer.from(data), done),
      final: (done) => {
        if (!this.closed) {
          if (this.started) session.send(4, generation);
          else this.pendingEnd = true;
        }
        done();
      },
    });
    this.stdin.on("error", () => { /* callers observe the virtual child error */ });
  }

  private writeInput(data: Buffer, done: (error?: Error | null) => void): void {
    if (this.closed) { done(new Error("Claude provider has closed")); return; }
    if (data.length === 0) { done(); return; }
    let offset = 0;
    const sendNext = () => {
      if (this.closed) { done(new Error("Claude provider has closed")); return; }
      const chunk = data.subarray(offset, offset + INPUT_CHUNK);
      offset += chunk.length;
      this.pendingInput = (error) => {
        this.queuedInput = undefined;
        if (error) done(error);
        else if (offset < data.length) sendNext();
        else done();
      };
      if (this.started) this.session.send(3, this.generation, chunk);
      else this.queuedInput = chunk;
    };
    sendNext();
  }

  startAcknowledged(): void {
    this.started = true;
    // A write queued before START_ACK has one pending chunk but no control frame yet.
    if (this.queuedInput) this.session.send(3, this.generation, this.queuedInput);
    else if (this.pendingEnd) {
      this.pendingEnd = false;
      this.session.send(4, this.generation);
    }
  }

  inputAck(): void {
    const next = this.pendingInput;
    this.pendingInput = undefined;
    next?.();
  }

  inputRejected(): void {
    const next = this.pendingInput;
    this.pendingInput = undefined;
    next?.(new Error("Claude provider closed its input pipe"));
  }

  output(kind: number, payload: Buffer): void {
    if (this.closed) return;
    const stream = kind === 7 ? this.stdout : this.stderr;
    if (!stream.write(payload)) {
      this.session.outer.stdout.pause();
      stream.once("drain", () => this.session.outer.stdout.resume());
    }
  }

  finish(code: number, signal: number): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code < 0 ? null : code;
    this.signalCode = signal === 0 ? null :
      (Object.entries(osConstants.signals).find(([, number]) => number === signal)?.[0] as NodeJS.Signals | undefined) ?? null;
    this.pendingInput?.(new Error("Claude provider exited before consuming input"));
    this.pendingInput = undefined;
    this.emit("exit", this.exitCode, this.signalCode);
    let remaining = 2;
    const ended = () => {
      if (--remaining === 0) {
        this.closeObserved = true;
        this.emit("close", this.exitCode, this.signalCode);
      }
    };
    this.stdout.once("end", ended);
    this.stderr.once("end", ended);
    this.stdout.end();
    this.stderr.end();
    this.stdout.resume();
    this.stderr.resume();
    // A final output frame may have paused the outer control stream in this
    // same receive batch. Ending the virtual streams can suppress their drain
    // events; keep later generations' control frames readable.
    this.session.outer.stdout.resume();
  }

  fail(error: Error): void {
    if (this.closed) return;
    if (this.listenerCount("error") > 0) this.emit("error", error);
    this.finish(125, 0);
  }
}

/** What a provider process ledger may observe about the namespace a virtual provider runs in. */
export interface ClaudeNamespaceLifetime {
  /** The outer bwrap process has closed. */
  readonly ended: boolean;
  /** The outer closed after this runner's TERMINATE frame without the SIGKILL fallback. Only then
   * did the in-namespace supervisor stop every process itself. A SIGKILLed outer can close a moment
   * before the kernel has finished tearing down its PID namespace, and an outer that closed on its
   * own proves nothing about the work it hosted, so neither counts. */
  readonly endedGracefully: boolean;
  /** Memoized TERMINATE, bounded SIGKILL fallback and task-root cleanup; true when it closed and
   * its task root was removed. */
  dispose(): Promise<boolean>;
}

class ClaudeNamespace implements ClaudeNamespaceLifetime {
  readonly token = randomBytes(16);
  readonly outer: ChildProcessWithoutNullStreams;
  readonly tempRoot: string;
  readonly taskDirectory: string;
  ready = false;
  ended = false;
  cleaned = false;
  private terminateSent = false;
  private controlFailed = false;
  private killed = false;
  private closedAfterTerminate = false;
  generation = 0;
  private finishedGeneration = 0;
  active: VirtualProvider | undefined;
  private buffered = Buffer.alloc(0);
  private errorText = "";
  private disposal: Promise<boolean> | undefined;

  constructor(
    readonly owner: object,
    readonly fingerprint: string,
    opts: SpawnAgentOptions & { isolation: BwrapSpawnIsolation },
    env: NodeJS.ProcessEnv,
    buildBwrapArgs: (opts: Pick<SpawnAgentOptions, "command" | "args" | "cwd">, isolation: BwrapSpawnIsolation) => string[],
  ) {
    const helper = claudeProviderPipeHelper(opts.isolation.claudePipeHelperDataDir);
    helper.verify();
    const sessionKey = createHash("sha256").update(opts.claudeNamespaceSessionId ?? "unnamed").digest("hex").slice(0, 16);
    reconcileStaleTaskRoots(sessionKey);
    this.tempRoot = mkdtempSync(join(tmpdir(), `${TASK_PREFIX}${sessionKey}-`));
    this.taskDirectory = join(this.tempRoot, "claude");
    try {
      const startTime = processStartTime(process.pid);
      if (!startTime) throw new Error("runner process identity unavailable");
      writeFileSync(join(this.tempRoot, "owner.json"), JSON.stringify({
        pid: process.pid, startTime,
      }), { flag: "wx", mode: 0o600 });
      mkdirSync(this.taskDirectory, { mode: 0o700 });
    } catch (error) {
      rmSync(this.tempRoot, { recursive: true, force: true });
      throw error;
    }
    try {
      const isolation: BwrapSpawnIsolation = {
        ...opts.isolation,
        claudeNamespace: { helperPath: helper.path, taskDirectory: this.taskDirectory },
      };
      const args = buildBwrapArgs({
        command: TARGET, args: ["--supervisor", this.token.toString("hex")], cwd: opts.cwd,
      }, isolation);
      this.outer = spawn(isolation.command, args, {
        cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true,
      });
    } catch (error) {
      rmSync(this.tempRoot, { recursive: true, force: true });
      throw error;
    }
    this.outer.stdout.on("data", (data: Buffer) => this.receive(data));
    this.outer.stdin.on("error", (error) => {
      this.controlFailed = true;
      this.fail(error);
    });
    namespaces.add(this);
    this.outer.stderr.on("data", (data: Buffer) => {
      if (this.errorText.length < 8192) this.errorText += data.toString().slice(0, 8192 - this.errorText.length);
    });
    this.outer.once("error", (error) => this.fail(error));
    this.outer.once("close", (code) => {
      this.ended = true;
      this.closedAfterTerminate = this.terminateSent && !this.controlFailed;
      this.fail(new Error(`Claude namespace ended${code == null ? "" : ` with code ${code}`}: ${this.errorText.trim()}`));
      try {
        rmSync(this.tempRoot, { recursive: true, force: true });
        this.cleaned = true;
      } catch (error) {
        process.stderr.write(`Claude namespace task cleanup failed: ${(error as Error).message}\n`);
      } finally {
        owners.delete(this.owner);
        namespaces.delete(this);
      }
    });
  }

  send(kind: number, generation: number, payload?: Buffer): void {
    // TERMINATE closes the control pipe. Any launch/input ACK already queued
    // by the supervisor may arrive after that point; those frames cannot
    // require a new host write while disposal owns the namespace lifetime.
    if (this.disposal && kind !== 6) return;
    if (this.ended || this.outer.stdin.destroyed) throw new Error("Claude namespace control channel closed");
    this.outer.stdin.write(frame(kind, this.token, generation, payload));
  }

  start(command: string, args: string[], env: NodeJS.ProcessEnv): AgentProcess {
    if (this.disposal) throw new Error("Claude namespace is disposing");
    if (this.ended || this.active) throw new Error("Claude namespace cannot start concurrent providers");
    const payload = providerStart(command, args, env);
    const generation = ++this.generation;
    const virtual = new VirtualProvider(this, generation);
    this.active = virtual;
    virtualNamespaces.set(virtual as unknown as AgentProcess, this);
    virtualKills.set(virtual as unknown as AgentProcess, async () => {
      // Before READY, this namespace has never accepted a provider. There can
      // be no retained work in it, so a failed first launch may close it.
      if (!this.ready) return generation === 1 ? this.dispose() : false;
      if (!virtual.closed) this.send(5, generation);
      return new Promise<boolean>((resolve) => {
        if (virtual.closed) { resolve(true); return; }
        // A stalled generation must not tear down earlier generations' tasks.
        // Report incomplete cancellation and keep the session fenced until
        // this exact worker eventually emits EXIT or session disposal begins.
        const timer = setTimeout(() => resolve(false), 2000);
        virtual.once("close", () => { clearTimeout(timer); resolve(true); });
      });
    });
    if (this.ready) this.send(2, generation, payload);
    else this.pendingStart = payload;
    return virtual as unknown as AgentProcess;
  }

  private pendingStart: Buffer | undefined;

  private receive(data: Buffer): void {
    if (this.disposal || this.ended) return;
    try { this.receiveFrames(data); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private receiveFrames(data: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, data]);
    if (this.buffered.length > MAX_FRAME + HEADER) { this.fail(new Error("Claude namespace frame overflow")); return; }
    while (this.buffered.length >= HEADER) {
      if (this.disposal) return;
      const size = this.buffered.readUInt32BE(22);
      if (this.buffered[0] !== 1 || size > MAX_FRAME ||
          !this.buffered.subarray(2, 18).equals(this.token)) {
        this.fail(new Error("Claude namespace frame authentication failed"));
        return;
      }
      if (this.buffered.length < HEADER + size) return;
      const kind = this.buffered[1]!;
      const generation = this.buffered.readUInt32BE(18);
      const payload = this.buffered.subarray(HEADER, HEADER + size);
      this.buffered = this.buffered.subarray(HEADER + size);
      if (kind === 1 && generation === 0 && !this.ready) {
        this.ready = true;
        if (this.disposal) continue;
        if (this.active && this.pendingStart) {
          this.send(2, this.active.generation, this.pendingStart);
          this.pendingStart = undefined;
        }
        continue;
      }
      // A worker can already have completed this generation when a queued
      // cancel reaches it. A duplicate EXIT is not authority to dispose older
      // retained tasks; keep all other stale frames as protocol errors.
      if (kind === 9 && size === 8 && generation > 0 && generation === this.finishedGeneration) continue;
      const active = this.active;
      if (!active || generation !== active.generation) {
        this.fail(new Error("Claude namespace emitted a stale provider generation"));
        return;
      }
      if (kind === 12 && size === 0 && !active.started) active.startAcknowledged();
      else if (kind === 7 || kind === 8) active.output(kind, Buffer.from(payload));
      else if (kind === 11) active.inputAck();
      else if (kind === 13 && size === 0) {
        active.inputRejected();
        // The provider may remain alive after closing stdin. Stop only this
        // generation so its caller gets a bounded close and prior tasks live.
        this.send(5, generation);
      }
      else if (kind === 9 && size === 8) {
        active.finish(payload.readInt32BE(0), payload.readInt32BE(4));
        this.finishedGeneration = generation;
        this.active = undefined;
      } else if (kind === 10) {
        const reason = payload.toString();
        if (!active.started && (reason === "retained provider drainer limit" || reason === "invalid provider start")) {
          active.fail(new Error(reason === "retained provider drainer limit"
            ? "Claude namespace retained provider drainer limit reached"
            : "Claude namespace provider could not start"));
          this.active = undefined;
        } else {
          this.fail(new Error(`Claude namespace rejected provider control: ${reason.slice(0, 256)}`));
          return;
        }
      } else {
        this.fail(new Error("Claude namespace emitted an invalid provider frame"));
        return;
      }
    }
  }

  private fail(error: Error): void {
    this.active?.fail(error);
    this.active = undefined;
    if (!this.ended) void this.dispose();
  }

  get endedGracefully(): boolean {
    return this.ended && this.closedAfterTerminate && !this.killed;
  }

  dispose(): Promise<boolean> {
    if (this.disposal) return this.disposal;
    this.disposal = new Promise<boolean>((resolve) => {
      if (this.ended) { resolve(this.cleaned); return; }
      const timer = setTimeout(() => {
        if (this.outer.pid) {
          this.killed = true;
          try { process.kill(-this.outer.pid, "SIGKILL"); } catch { /* already dead */ }
        }
      }, 2000);
      const deadline = setTimeout(() => { clearTimeout(timer); resolve(false); }, 4500);
      this.outer.once("close", () => {
        clearTimeout(timer); clearTimeout(deadline); resolve(this.cleaned);
      });
      try {
        this.send(6, 0);
        this.terminateSent = true;
      } catch { /* kill timer handles a broken pipe */ }
      try { this.outer.stdin.end(); } catch { /* kill timer handles a broken pipe */ }
    });
    return this.disposal;
  }
}

export function spawnClaudeNamespaceProvider(
  opts: SpawnAgentOptions & { isolation: BwrapSpawnIsolation; descendantOwner: object },
  env: NodeJS.ProcessEnv,
  buildBwrapArgs: (opts: Pick<SpawnAgentOptions, "command" | "args" | "cwd">, isolation: BwrapSpawnIsolation) => string[],
): AgentProcess {
  const namespaceEnv = { ...env, TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" };
  const fingerprint = createHash("sha256").update(JSON.stringify({
    isolation: opts.isolation, cwd: opts.cwd,
  })).digest("hex");
  let namespace = owners.get(opts.descendantOwner);
  if (namespace && namespace.fingerprint !== fingerprint) {
    throw new Error("Claude namespace launch profile changed within a live session");
  }
  if (!namespace) {
    namespace = new ClaudeNamespace(opts.descendantOwner, fingerprint, opts, namespaceEnv, buildBwrapArgs);
    owners.set(opts.descendantOwner, namespace);
  }
  return namespace.start(absoluteCommand(opts.command, opts.cwd, namespaceEnv), opts.args, namespaceEnv);
}

export function claudeNamespaceTempRoot(owner: object): string | undefined {
  return owners.get(owner)?.tempRoot;
}

export function claudeNamespaceHostTaskPath(owner: object, providerPath: string): string {
  const namespace = owners.get(owner);
  if (!namespace) return providerPath;
  if (providerPath.startsWith(namespace.taskDirectory + sep)) {
    const candidate = resolve(providerPath);
    return candidate.startsWith(namespace.taskDirectory + sep) ? candidate : "";
  }
  if (!providerPath.startsWith("/tmp/claude/")) return "";
  const candidate = resolve(namespace.tempRoot, providerPath.slice("/tmp/".length));
  return candidate.startsWith(namespace.taskDirectory + sep) ? candidate : "";
}

export function cancelClaudeNamespaceProvider(child: AgentProcess): Promise<boolean> | undefined {
  return virtualKills.get(child)?.();
}

/** The namespace a virtual provider runs in. Non-destructive, and unlike the owner lookups it keeps
 * answering after the namespace has closed. */
export function claudeNamespaceFor(child: AgentProcess): ClaudeNamespaceLifetime | undefined {
  return virtualNamespaces.get(child);
}

export function terminateClaudeNamespaces(owner?: object): Promise<boolean>[] {
  if (!owner) return [...namespaces].map((namespace) => namespace.dispose());
  const namespace = owners.get(owner);
  return namespace ? [namespace.dispose()] : [];
}
