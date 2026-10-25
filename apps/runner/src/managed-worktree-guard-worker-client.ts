import { createRequire } from "node:module";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import type { ManagedWorktreeProtection } from "./managed-worktree-protection.js";
import { parsePolicyHookRelayRequest, type PolicyHookRelayRequest } from "./policy-hook-relay.js";

export const GUARD_WORKER_ASSET = "wollipog/managed-worktree-guard-worker-v1";
export interface GuardSocketWorkerOptions {
  address: string;
  guardStateDirectory: string;
  platform: NodeJS.Platform;
  protectionsFile?: string;
}
export interface GuardSocketWorkerData { protocol: 1; }
export interface GuardSocketWorkerOpen extends GuardSocketWorkerOptions {
  kind: "open";
  listenerId: number;
  version: SharedArrayBuffer;
  updates: MessagePort;
}
export type GuardSocketWorkerFactory = (data: GuardSocketWorkerData, transferList: MessagePort[]) => Worker;

/** Fixed entry only: source, compiled JS, and SEA all run the same judge and socket framing. */
export const createGuardSocketWorker: GuardSocketWorkerFactory = (workerData, transferList) => {
  let code: string;
  if (isSea()) code = getAsset(GUARD_WORKER_ASSET, "utf8");
  else {
    const url = import.meta.url ?? pathToFileURL(__filename).href;
    const source = fileURLToPath(url).endsWith(".ts");
    const entry = fileURLToPath(new URL(source ? "./managed-worktree-guard-worker.ts" : "./managed-worktree-guard-worker.js", url));
    const loader = source ? createRequire(url).resolve("tsx/cjs") : undefined;
    code = `${loader ? `require(${JSON.stringify(loader)});` : ""}require(${JSON.stringify(entry)});`;
  }
  return new Worker(code, { eval: true, execArgv: [], workerData, transferList });
};

/** One fixed worker per runner/account host, with independent session listeners and list ports. */
export class GuardSocketWorkerHost {
  private epoch: GuardWorkerEpoch | undefined;
  constructor(private readonly factory = createGuardSocketWorker, private readonly startupTimeoutMs = 30_000) {}

  async listen(options: GuardSocketWorkerOptions, load: () => ManagedWorktreeProtection[],
    subscribe: (notify: () => void) => () => void,
    relay: (request: PolicyHookRelayRequest, signal: AbortSignal) => Promise<string>): Promise<GuardSocketWorker> {
    // Never overlap a replacement isolate with a failed one still terminating.
    while (this.epoch?.closed) {
      const previous = this.epoch;
      await previous.close();
      if (this.epoch === previous) this.epoch = undefined;
    }
    this.epoch ??= new GuardWorkerEpoch(this.factory, this.startupTimeoutMs);
    return this.epoch.listen(options, load, subscribe, relay);
  }

  async closeAll(): Promise<void> {
    const previous = this.epoch;
    if (!previous) return;
    await previous.close();
    if (this.epoch === previous) this.epoch = undefined;
  }
}

class GuardWorkerEpoch {
  readonly worker: Worker;
  readonly ready: Promise<void>;
  closed = false;
  private booted = false;
  private nextId = 0;
  private readonly listeners = new Map<number, GuardSocketWorker>();
  private closing: Promise<void> | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(factory: GuardSocketWorkerFactory, startupTimeoutMs: number) {
    this.worker = factory({ protocol: 1 }, []);
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.timer = setTimeout(() => this.fail(new Error("guard verdict worker startup timed out")), startupTimeoutMs);
    this.worker.on("error", () => this.fail(new Error("guard verdict worker failed")));
    this.worker.on("exit", () => this.fail(new Error("guard verdict worker exited")));
    this.worker.on("message", (message: unknown) => this.receive(message));
  }

  listen(options: GuardSocketWorkerOptions, load: () => ManagedWorktreeProtection[],
    subscribe: (notify: () => void) => () => void,
    relay: (request: PolicyHookRelayRequest, signal: AbortSignal) => Promise<string>): Promise<GuardSocketWorker> {
    if (this.closed) return Promise.reject(new Error("guard verdict worker closed"));
    const listenerId = ++this.nextId;
    if (!Number.isSafeInteger(listenerId)) { this.fail(new Error("guard listener id exhausted")); return Promise.reject(new Error("guard listener id exhausted")); }
    const listener = new GuardSocketWorker(this, listenerId, options, load, relay);
    this.listeners.set(listenerId, listener);
    listener.start(subscribe);
    return listener.ready.then(() => listener);
  }

  post(message: unknown, transferList: MessagePort[] = []): void {
    if (this.closed) throw new Error("guard verdict worker closed");
    try { this.worker.postMessage(message, transferList); }
    catch { this.fail(new Error("guard verdict worker channel failed")); throw new Error("guard verdict worker channel failed"); }
  }

  private receive(message: unknown): void {
    if (this.closed) return;
    try {
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid worker reply");
      const reply = message as { kind?: unknown; protocol?: unknown; listenerId?: unknown; address?: unknown; requestId?: unknown; request?: unknown };
      if (reply.kind === "booted" && reply.protocol === 1 && !this.booted) {
        this.booted = true;
        clearTimeout(this.timer);
        this.resolveReady();
        return;
      }
      if (!this.booted || !Number.isSafeInteger(reply.listenerId) || (reply.listenerId as number) <= 0) throw new Error("invalid listener reply");
      const listener = this.listeners.get(reply.listenerId as number);
      if (!listener) throw new Error("unknown guard listener reply");
      if (reply.kind === "listening" && reply.address === listener.options.address && !listener.listening && !listener.closed) {
        listener.markListening();
      } else if (reply.kind === "closed" && listener.closed) {
        this.listeners.delete(listener.listenerId);
        listener.acknowledgeClose();
      } else if ((reply.kind === "relay" || reply.kind === "abandon") &&
          Number.isSafeInteger(reply.requestId) && (reply.requestId as number) > 0) {
        if (listener.closed) return; // A request can cross a close; it must not reach main's relay.
        if (reply.kind === "relay") listener.relay(reply.requestId as number, reply.request);
        else listener.abandon(reply.requestId as number);
      } else throw new Error("invalid guard verdict worker reply");
    } catch { this.fail(new Error("invalid guard verdict worker reply")); }
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.rejectReady(error);
    this.closing = this.worker.terminate().then(() => {});
    for (const listener of this.listeners.values()) listener.fail(error);
    this.listeners.clear();
  }

  close(): Promise<void> {
    this.fail(new Error("guard verdict worker closed"));
    return this.closing!;
  }
}

/** A per-session listener handle. Only the internal worker channel carries its routing identity. */
export class GuardSocketWorker {
  listening = false;
  closed = false;
  readonly ready: Promise<void>;
  private readonly version = new Int32Array(new SharedArrayBuffer(4));
  private readonly channel = new MessageChannel();
  private unsubscribe = () => {};
  private closing: Promise<void> | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveClosed = () => {};
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly relays = new Map<number, AbortController>();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(private readonly epoch: GuardWorkerEpoch, readonly listenerId: number,
    readonly options: GuardSocketWorkerOptions, private readonly load: () => ManagedWorktreeProtection[],
    private readonly handler: (request: PolicyHookRelayRequest, signal: AbortSignal) => Promise<string>) {
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.timer = setTimeout(() => epoch.fail(new Error("guard verdict listener startup timed out")), 30_000);
  }

  start(subscribe: (notify: () => void) => () => void): void {
    try {
      if (!this.options.protectionsFile) {
        this.unsubscribe = subscribe(() => this.refresh());
        this.refresh();
      }
    } catch { this.epoch.fail(new Error("guard protection subscription failed")); }
    void this.epoch.ready.then(() => {
      if (this.closed) return;
      const open: GuardSocketWorkerOpen = { kind: "open", listenerId: this.listenerId, ...this.options,
        version: this.version.buffer as SharedArrayBuffer, updates: this.channel.port2 };
      this.epoch.post(open, [this.channel.port2]);
    }).catch(error => this.epoch.fail(error as Error));
  }

  markListening(): void { clearTimeout(this.timer); this.listening = true; this.resolveReady(); }
  acknowledgeClose(): void { clearTimeout(this.closeTimer); this.resolveClosed(); }

  refresh(): void {
    if (this.closed || this.options.protectionsFile) return;
    // Invalidate BEFORE posting. A reader that races publication refuses instead of allowing
    // from the prior list. Drain FIFO synchronously; never wrap or reuse a version.
    const next = Atomics.add(this.version, 0, 1) + 1;
    if (next <= 0 || next >= 0x7fffffff) { this.epoch.fail(new Error("guard protection version exhausted")); return; }
    let protections: ManagedWorktreeProtection[] | null;
    try { protections = this.load(); } catch { protections = null; }
    try { this.channel.port1.postMessage({ version: next, protections }); }
    catch { this.epoch.fail(new Error("guard protection channel failed")); }
  }

  relay(requestId: number, input: unknown): void {
    if (this.options.protectionsFile || this.relays.has(requestId)) throw new Error("invalid guard relay request");
    const request = parsePolicyHookRelayRequest(input);
    if (!request) throw new Error("invalid guard relay request");
    const abort = new AbortController();
    this.relays.set(requestId, abort);
    void Promise.resolve().then(() => this.handler(request, abort.signal)).then(
      output => this.answer(requestId, output), () => this.answer(requestId, null),
    );
  }
  private answer(requestId: number, output: string | null): void {
    if (!this.closed && this.relays.delete(requestId)) {
      try { this.epoch.post({ kind: "relayAnswer", listenerId: this.listenerId, requestId, output }); } catch { /* epoch already refused */ }
    }
  }
  abandon(requestId: number): void { this.relays.get(requestId)?.abort(); this.relays.delete(requestId); }

  private dispose(): void {
    this.closed = true;
    this.listening = false;
    clearTimeout(this.timer);
    clearTimeout(this.closeTimer);
    this.unsubscribe();
    this.channel.port1.close();
    this.channel.port2.close();
    for (const abort of this.relays.values()) abort.abort();
    this.relays.clear();
  }
  fail(error: Error): void {
    this.dispose();
    this.rejectReady(error);
    void this.epoch.close().then(() => this.resolveClosed());
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.dispose();
    if (this.epoch.closed) return this.closing = this.epoch.close();
    this.closing = new Promise<void>(resolve => { this.resolveClosed = resolve; });
    this.closeTimer = setTimeout(() => this.epoch.fail(new Error("guard verdict listener close timed out")), 30_000);
    try { this.epoch.post({ kind: "close", listenerId: this.listenerId }); }
    catch { return this.closing = this.epoch.close(); }
    return this.closing;
  }
}
