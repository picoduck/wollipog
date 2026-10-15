import { killTreeAndWait, type AgentProcess } from "../spawn.js";

/** Only the opt-in probe owns this process-wide signal policy. Never used by the runner. */
export class CodexProbeLifecycle {
  private readonly cancellation = new AbortController();
  private readonly children = new Map<AgentProcess, Promise<boolean> | undefined>();
  private readonly handlers = new Map<NodeJS.Signals, () => void>();
  private failures = 0;
  interruptedBy: "SIGINT" | "SIGTERM" | undefined;

  constructor() {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        // Repeated signals cannot preempt the bounded teardown or change the first exit status.
        this.interruptedBy ??= signal;
        this.cancellation.abort();
      };
      this.handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  get cleanupFailed(): boolean { return this.failures > 0; }

  async run<T>(operation: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
    this.cancellation.signal.throwIfAborted();
    if (this.cleanupFailed) throw new Error("probe_cleanup_failed");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("probe_interrupted"));
          this.cancellation.signal.addEventListener("abort", onAbort, { once: true });
          // An injected operation may synchronously deliver a signal before listener registration.
          if (this.cancellation.signal.aborted) onAbort();
          timer = setTimeout(() => reject(new Error("probe_timeout")), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.cancellation.signal.removeEventListener("abort", onAbort);
    }
  }

  own(child: AgentProcess): AgentProcess {
    this.children.set(child, undefined);
    return child;
  }

  stop(child: AgentProcess): Promise<boolean> {
    // Never accept a PID or sweep another probe/session's global pending-kill registry.
    if (!this.children.has(child)) return Promise.resolve(false);
    let stopped = this.children.get(child);
    if (!stopped) {
      stopped = killTreeAndWait(child);
      this.children.set(child, stopped);
    }
    return stopped;
  }

  async attempt(action: () => unknown | Promise<unknown>, timeoutMs = 6_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("probe_cleanup_timeout")), timeoutMs);
        }),
      ]);
      if (result === false) this.failures++;
    } catch { this.failures++; }
    finally { clearTimeout(timer); }
  }

  async stopOwned(): Promise<void> {
    // All owned children begin shutdown together, with one shared finite wait window.
    await this.attempt(async () => (await Promise.all([...this.children.keys()].map(child => this.stop(child))))
      .every(Boolean));
  }

  releaseSignals(): void {
    for (const [signal, handler] of this.handlers) process.removeListener(signal, handler);
    this.handlers.clear();
  }
}
