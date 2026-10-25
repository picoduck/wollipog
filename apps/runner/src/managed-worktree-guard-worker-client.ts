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
export interface GuardSocketWorkerData extends GuardSocketWorkerOptions {
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

/** One worker and one private list channel per session. Verdicts never round-trip through main. */
export class GuardSocketWorker {
  listening = false;
  private readonly version = new Int32Array(new SharedArrayBuffer(4));
  private readonly channel = new MessageChannel();
  private readonly worker: Worker;
  private unsubscribe = () => {};
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly relays = new Map<number, AbortController>();

  private constructor(
    private readonly options: GuardSocketWorkerOptions,
    private readonly load: () => ManagedWorktreeProtection[],
    factory: GuardSocketWorkerFactory,
  ) {
    try {
      this.worker = factory({ ...options, version: this.version.buffer as SharedArrayBuffer, updates: this.channel.port2 }, [this.channel.port2]);
    } catch (error) {
      this.channel.port1.close();
      this.channel.port2.close();
      throw error;
    }
  }

  static async listen(
    options: GuardSocketWorkerOptions,
    load: () => ManagedWorktreeProtection[],
    subscribe: (notify: () => void) => () => void,
    relay: (request: PolicyHookRelayRequest, signal: AbortSignal) => Promise<string>,
    factory: GuardSocketWorkerFactory = createGuardSocketWorker,
    startupTimeoutMs = 30_000,
  ): Promise<GuardSocketWorker> {
    const owner = new GuardSocketWorker(options, load, factory);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("guard verdict worker startup timed out")), startupTimeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
        void owner.close();
      };
      owner.worker.on("error", () => fail(new Error("guard verdict worker failed")));
      owner.worker.on("exit", () => fail(new Error("guard verdict worker exited")));
      owner.worker.on("message", (message: unknown) => {
        if (owner.closed) return;
        try {
          if (!message || typeof message !== "object") throw new Error("invalid worker reply");
          const reply = message as { kind?: unknown; address?: unknown; id?: unknown; request?: unknown };
          if (reply.kind === "ready" && !owner.listening && reply.address === options.address) {
            clearTimeout(timer);
            owner.listening = true;
            resolve();
          } else if (reply.kind === "relay" && owner.listening && !options.protectionsFile &&
              Number.isSafeInteger(reply.id) && (reply.id as number) > 0 && !owner.relays.has(reply.id as number)) {
            const request = parsePolicyHookRelayRequest(reply.request);
            if (!request) throw new Error("invalid guard relay request");
            const id = reply.id as number;
            const abort = new AbortController();
            owner.relays.set(id, abort);
            void Promise.resolve().then(() => relay(request, abort.signal)).then(
              output => { if (!owner.closed && owner.relays.delete(id)) owner.worker.postMessage({ kind: "relayAnswer", id, output }); },
              () => { if (!owner.closed && owner.relays.delete(id)) owner.worker.postMessage({ kind: "relayAnswer", id, output: null }); },
            );
          } else if (reply.kind === "abandon" && Number.isSafeInteger(reply.id)) {
            owner.relays.get(reply.id as number)?.abort();
            owner.relays.delete(reply.id as number);
          } else throw new Error("invalid guard verdict worker reply");
        } catch {
          fail(new Error("invalid guard verdict worker reply"));
        }
      });
      if (!options.protectionsFile) {
        owner.unsubscribe = subscribe(() => owner.refresh());
        owner.refresh();
      }
    });
    return owner;
  }

  refresh(): void {
    if (this.closed || this.options.protectionsFile) return;
    // Invalidate BEFORE posting. A reader that races a publication can refuse, never allow from
    // the prior list. MessagePort FIFO + synchronous draining gives the next call the new list,
    // even while main is blocked and cannot answer RPC. Never wrap/reuse a list version.
    const next = Atomics.add(this.version, 0, 1) + 1;
    if (next <= 0 || next >= 0x7fffffff) { void this.close(); return; }
    let protections: ManagedWorktreeProtection[] | null;
    try { protections = this.load(); } catch { protections = null; }
    try { this.channel.port1.postMessage({ version: next, protections }); }
    catch { void this.close(); }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.listening = false;
    this.unsubscribe();
    this.channel.port1.close();
    for (const abort of this.relays.values()) abort.abort();
    this.relays.clear();
    // Every close caller waits for actual termination, even if failure initiated it first.
    this.closing = this.worker.terminate().then(() => {});
    return this.closing; // Closes listeners and every pending connection, including asks.
  }
}
