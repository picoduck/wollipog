/** Bounded tombstones for shell_close frames that arrive before a fenced shell_open can run. */
export class PendingShellOpenCancellations {
  private readonly cancelled = new Map<string, ReturnType<typeof setTimeout> | null>();
  private readonly active = new Set<string>();

  constructor(
    private readonly retentionMs = 60_000,
    private readonly maxEntries = 10_000,
  ) {}

  register(shellId: string): void {
    this.active.add(shellId);
    const prior = this.cancelled.get(shellId);
    if (prior) clearTimeout(prior);
    if (this.cancelled.has(shellId)) this.cancelled.set(shellId, null);
  }

  unregister(shellId: string): void {
    this.active.delete(shellId);
    const cancellation = this.cancelled.get(shellId);
    if (cancellation) clearTimeout(cancellation);
    this.cancelled.delete(shellId);
  }

  cancel(shellId: string): void {
    const prior = this.cancelled.get(shellId);
    if (prior) clearTimeout(prior);
    if (this.active.has(shellId)) {
      this.cancelled.set(shellId, null);
      return;
    }
    const timer = setTimeout(() => this.cancelled.delete(shellId), this.retentionMs);
    timer.unref?.();
    this.cancelled.delete(shellId);
    this.cancelled.set(shellId, timer);
    while (this.cancelled.size > this.maxEntries) {
      const oldest = [...this.cancelled.keys()].find((candidate) => !this.active.has(candidate));
      if (!oldest) break;
      const expiry = this.cancelled.get(oldest);
      if (expiry) clearTimeout(expiry);
      this.cancelled.delete(oldest);
    }
  }

  has(shellId: string): boolean {
    return this.cancelled.has(shellId);
  }

  consume(shellId: string): boolean {
    if (!this.cancelled.has(shellId)) return false;
    const timer = this.cancelled.get(shellId);
    if (timer) clearTimeout(timer);
    this.cancelled.delete(shellId);
    return true;
  }
}
