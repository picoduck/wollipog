import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { providerHomeLeaseTarget, type ProviderHomeLeaseOptions, type ProviderHomeLeaseRequest } from "./provider-home-lease.js";
import { boundedLeaseWorkerFrame, leaseWorkerFrameKeys, LEASE_WORKER_ASSET, LEASE_WORKER_ERRORS, LEASE_WORKER_LIMITS, validLeaseWorkerOperation, type LeaseWorkerOperation, type LeaseWorkerReply } from "./provider-home-lease-worker-protocol.js";

type Diagnostic = Parameters<NonNullable<ProviderHomeLeaseOptions["onDiagnostic"]>>[0];
type WorkerDiagnostic = Diagnostic |
  { event: "provider_home_worker_unavailable"; reason: string; epoch: string; requestId?: string } |
  { event: "provider_home_worker_operation"; epoch: string; requestId: string; method: LeaseWorkerOperation["method"];
    queueWaitMs: number; operationDurationMs: number; outcome: "completed" | "cancelled" | "refused" };
interface WorkerPort {
  on(event: string, listener: (...args: any[]) => void): unknown;
  postMessage(value: unknown): void;
  ref(): unknown;
  unref(): unknown;
  terminate(): Promise<number>;
}
export interface AsyncLeaseOptions {
  helperDataDir?: string;
  onDiagnostic?: (diagnostic: WorkerDiagnostic) => void;
  /** Private test seams; no configuration or agent RPC can select code or enlarge a budget. */
  workerFactoryForTest?: (data: Record<string, unknown>) => WorkerPort;
  deadlineMsForTest?: number;
  pendingLimitForTest?: number;
  engineOptionsForTest?: Pick<ProviderHomeLeaseOptions, "nativeCheckpointBarrierForTest" | "disableCompactionForTest">;
}
export interface LeaseCancellation { signal?: AbortSignal; isCurrent?: () => boolean }
interface Pending {
  id: string;
  operation: LeaseWorkerOperation;
  deadline: number;
  enqueuedAt: number;
  startedAt?: number;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
  isCurrent?: () => boolean;
  cancelled: boolean;
  acceptedCancel: boolean;
  compensation: boolean;
  phase: "queued" | "executing" | "accepting";
  receipt?: Extract<LeaseWorkerReply, { kind: "receipt" | "done" }>;
  resolve: (value: boolean) => void;
  reject: (error: Error) => void;
}
const unavailable = (reason: string) => new Error(`Provider-HOME lease worker unavailable (${reason}); preserve all evidence and retry only after runner lifecycle recovery.`);

/** The runner's main event loop does only bounded control messages. Authority stays in one worker. */
export class AsyncProviderHomeLeaseRegistry {
  private readonly epoch = randomUUID();
  private readonly queue: Pending[] = [];
  private worker?: WorkerPort;
  private ready = false;
  private active?: Pending;
  private poisonReason?: string;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<boolean>;
  private readonly deadlineMs: number;
  private readonly pendingLimit: number;

  constructor(private readonly ownerHash: string, private readonly options: AsyncLeaseOptions = {}) {
    if (!/^[a-f0-9]{64}$/u.test(ownerHash)) throw new Error("provider-home lease requires an attested owner hash");
    this.deadlineMs = options.deadlineMsForTest ?? LEASE_WORKER_LIMITS.deadlineMs;
    this.pendingLimit = options.pendingLimitForTest ?? LEASE_WORKER_LIMITS.pending;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > LEASE_WORKER_LIMITS.deadlineMs ||
        !Number.isSafeInteger(this.pendingLimit) || this.pendingLimit < 1 || this.pendingLimit > LEASE_WORKER_LIMITS.pending) throw new Error("invalid lease worker test budget");
  }

  async acquire(request: ProviderHomeLeaseRequest, cancellation: LeaseCancellation = {}): Promise<void> {
    const target = providerHomeLeaseTarget(request);
    if (target) await this.acquireHome(target.home, target.provider, cancellation);
  }

  acquireHome(home: string, provider = "skills", cancellation: LeaseCancellation = {}): Promise<boolean> {
    if (this.closing) return Promise.reject(unavailable("shutdown admission closed"));
    return this.enqueue({ method: "acquire", home, provider }, cancellation);
  }

  releaseHome(home: string): Promise<boolean> {
    if (this.closePromise) return Promise.reject(unavailable("shutdown release already queued"));
    return this.enqueue({ method: "release", home });
  }

  /** Close admission immediately; the caller must reap every provider tree before calling this. */
  close(): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    if (this.poisonReason) return Promise.resolve(false);
    if (this.closePromise) return this.closePromise;
    this.stopAcquisitions();
    if (!this.worker && !this.active && this.queue.length === 0) { this.closed = true; return Promise.resolve(true); }
    this.closePromise = this.enqueue({ method: "close" }).then(value => {
      if (value) this.closed = true;
      this.closePromise = undefined;
      return value;
    }, () => { this.closePromise = undefined; return false; });
    return this.closePromise;
  }

  stopAcquisitions(): void {
    this.closing = true;
    for (const pending of [...this.queue]) if (pending.operation.method === "acquire") this.cancel(pending);
    if (this.active?.operation.method === "acquire") this.cancel(this.active);
  }

  private enqueue(operation: LeaseWorkerOperation, cancellation: LeaseCancellation = {}): Promise<boolean> {
    const { signal, isCurrent } = cancellation;
    if (this.poisonReason || this.closed) return Promise.reject(unavailable(this.poisonReason ?? "closed"));
    if (!validLeaseWorkerOperation(operation) || !boundedLeaseWorkerFrame(operation, LEASE_WORKER_LIMITS.requestBytes - 512)) return Promise.reject(new Error("invalid or oversized provider-HOME lease request"));
    try {
      if (signal?.aborted || (isCurrent && !isCurrent())) return Promise.reject(new Error(LEASE_WORKER_ERRORS.cancelled));
    } catch { return Promise.reject(new Error(LEASE_WORKER_ERRORS.cancelled)); }
    if (this.queue.length + (this.active ? 1 : 0) >= this.pendingLimit) return Promise.reject(new Error("Provider-HOME lease queue is full; retry later."));
    return new Promise((resolve, reject) => {
      const pending: Pending = { id: randomUUID(), operation, deadline: Date.now() + this.deadlineMs, timer: undefined!, signal, isCurrent,
        enqueuedAt: performance.now(),
        cancelled: false, acceptedCancel: false, compensation: false, phase: "queued", resolve, reject };
      pending.timer = setTimeout(() => {
        if (pending === this.active) this.poison("active deadline or ambiguous completion");
        else { this.remove(pending); pending.reject(new Error(LEASE_WORKER_ERRORS.expired)); }
      }, this.deadlineMs);
      pending.abort = () => this.cancel(pending);
      signal?.addEventListener("abort", pending.abort, { once: true });
      this.queue.push(pending);
      try { this.startWorker(); this.worker?.ref(); this.pump(); } catch { this.poison("initialization failed"); }
    });
  }

  private startWorker(): void {
    if (this.worker) return;
    const data = { epoch: this.epoch, ownerHash: this.ownerHash, helperDataDir: this.options.helperDataDir, tests: this.options.engineOptionsForTest };
    if (this.options.workerFactoryForTest) this.worker = this.options.workerFactoryForTest(data);
    else {
      let code: string;
      if (isSea()) {
        code = getAsset(LEASE_WORKER_ASSET, "utf8");
        if (Buffer.byteLength(code) > 1024 * 1024) throw new Error("packaged lease worker byte limit");
      } else {
        const url = import.meta.url ?? pathToFileURL(__filename).href;
        const source = fileURLToPath(url).endsWith(".ts");
        const entry = fileURLToPath(new URL(source ? "./provider-home-lease-worker.ts" : "./provider-home-lease-worker.js", url));
        const loader = source ? createRequire(url).resolve("tsx/cjs") : undefined;
        code = `${loader ? `require(${JSON.stringify(loader)});` : ""}require(${JSON.stringify(entry)});`;
      }
      this.worker = new Worker(code, { eval: true, execArgv: [], workerData: data });
    }
    this.worker.on("message", (reply: unknown) => this.receive(reply));
    this.worker.on("error", () => this.poison("worker error"));
    this.worker.on("exit", () => { if (!this.closed) this.poison("worker exited without proved shutdown"); });
  }

  private pump(): void {
    if (this.active || !this.ready || this.poisonReason) return;
    const pending = this.queue.shift();
    if (!pending) { this.worker?.unref(); return; }
    if (!this.current(pending)) { this.cancel(pending); this.pump(); return; }
    if (pending.deadline <= Date.now()) {
      this.remove(pending); pending.reject(new Error(LEASE_WORKER_ERRORS.expired)); this.pump(); return;
    }
    this.active = pending; pending.phase = "executing";
    pending.startedAt = performance.now();
    this.post({ kind: "execute", epoch: this.epoch, id: pending.id, deadline: pending.deadline, operation: pending.operation });
  }

  private post(message: unknown): void {
    try { this.worker!.postMessage(message); } catch { this.poison("control transport failed"); }
  }

  private receive(value: unknown): void {
    if (this.poisonReason) return;
    if (!value || typeof value !== "object" || !boundedLeaseWorkerFrame(value, LEASE_WORKER_LIMITS.responseBytes)) return this.poison("invalid response");
    const reply = value as LeaseWorkerReply;
    const keys = reply.kind === "ready" ? ["kind", "epoch", "pid"] : reply.kind === "diagnostic"
      ? ["kind", "epoch", "event", "leaseId", "message"] : ["kind", "epoch", "id", "ok", "value", "error"];
    if (!leaseWorkerFrameKeys(reply, keys)) return this.poison("unexpected response fields");
    if (reply.epoch !== this.epoch) return this.poison("wrong worker epoch");
    if (reply.kind === "ready") {
      if (this.ready || reply.pid !== process.pid) return this.poison("unproved worker parent identity");
      this.ready = true; this.pump(); return;
    }
    if (reply.kind === "diagnostic") {
      if (!this.active || !["provider_home_checkpoint_unavailable", "provider_home_release_unpublished"].includes(reply.event) ||
          typeof reply.leaseId !== "string" || !/^[a-f0-9-]{36}$/u.test(reply.leaseId) || typeof reply.message !== "string" || reply.message.length > 1536) return this.poison("invalid diagnostic");
      this.diagnostic({ event: reply.event, leaseId: reply.leaseId, message: reply.message }); return;
    }
    const pending = this.active;
    if (!pending || reply.id !== pending.id || typeof reply.ok !== "boolean" || typeof reply.value !== "boolean" ||
        (reply.ok ? reply.error !== undefined : typeof reply.error !== "string" || !Object.hasOwn(LEASE_WORKER_ERRORS, reply.error))) return this.poison("unmatched completion receipt");
    if (pending.deadline <= Date.now()) return this.poison("late completion receipt");
    if (reply.kind === "receipt" && pending.phase === "executing") {
      if (!this.current(pending)) pending.cancelled = true;
      pending.receipt = reply; pending.phase = "accepting";
      pending.acceptedCancel = pending.cancelled && pending.operation.method === "acquire";
      this.post({ kind: "accept", epoch: this.epoch, id: pending.id, cancel: pending.acceptedCancel }); return;
    }
    if (reply.kind !== "done" || pending.phase !== "accepting" || !pending.receipt) return this.poison("unexpected completion phase");
    const receipt = pending.receipt;
    if (pending.acceptedCancel && receipt.ok) {
      if (reply.ok || reply.value || !["cancelled", "cancel_release_failed"].includes(reply.error ?? "")) return this.poison("unproved cancellation completion");
    } else if (reply.ok !== receipt.ok || reply.value !== receipt.value || reply.error !== receipt.error) return this.poison("changed completion receipt");
    if (reply.error === "cancel_release_failed") return this.poison("unproved cancelled reference release");
    if (!this.current(pending)) pending.cancelled = true;
    // An abort can arrive after accept was sent. Compensate before dispatching any other work.
    if (pending.cancelled && !pending.acceptedCancel && pending.operation.method === "acquire" && reply.ok) {
      pending.operation = { method: "cancel", home: pending.operation.home, completedId: pending.id };
      pending.id = randomUUID(); pending.compensation = true; pending.phase = "executing"; pending.receipt = undefined;
      this.post({ kind: "execute", epoch: this.epoch, id: pending.id, deadline: pending.deadline, operation: pending.operation }); return;
    }
    if (pending.compensation && (!reply.ok || !reply.value)) return this.poison("unproved late cancellation release");
    if (pending.operation.method === "close" && reply.ok && reply.value) this.closed = true;
    this.active = undefined; this.remove(pending);
    const finishedAt = performance.now();
    this.diagnostic({ event: "provider_home_worker_operation", epoch: this.epoch, requestId: pending.id,
      method: pending.operation.method, queueWaitMs: Math.round(pending.startedAt! - pending.enqueuedAt),
      operationDurationMs: Math.round(finishedAt - pending.startedAt!),
      outcome: pending.cancelled ? "cancelled" : reply.ok ? "completed" : "refused" });
    if (pending.cancelled) pending.reject(new Error(LEASE_WORKER_ERRORS.cancelled));
    else if (!reply.ok) pending.reject(new Error(LEASE_WORKER_ERRORS[reply.error!]));
    else pending.resolve(reply.value);
    this.pump();
  }

  private current(pending: Pending): boolean {
    try { return !pending.cancelled && (pending.isCurrent?.() ?? true); } catch { return false; }
  }

  private cancel(pending: Pending): void {
    pending.cancelled = true;
    if (pending === this.active) return;
    this.remove(pending); pending.reject(new Error(LEASE_WORKER_ERRORS.cancelled));
  }

  private remove(pending: Pending): void {
    clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
    const index = this.queue.indexOf(pending); if (index >= 0) this.queue.splice(index, 1);
  }

  private poison(reason: string): void {
    if (this.poisonReason) return;
    this.poisonReason = reason;
    this.diagnostic({ event: "provider_home_worker_unavailable", reason, epoch: this.epoch,
      ...(this.active ? { requestId: this.active.id } : {}) });
    for (const pending of [...this.queue, ...(this.active ? [this.active] : [])]) {
      this.remove(pending); pending.reject(unavailable(reason));
    }
    this.active = undefined;
    // Stop computation without inferring rollback, release, or canonical cleanup from termination.
    void this.worker?.terminate().catch(() => {});
  }

  private diagnostic(value: WorkerDiagnostic): void {
    try { this.options.onDiagnostic?.(value); } catch { /* Logging cannot confer or revoke authority. */ }
  }
}
