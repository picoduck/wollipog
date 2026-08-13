/**
 * Tracks the runner-side materialization of a session so commands delivered immediately after
 * start_session cannot observe the transient "pending worktree" state.
 */
export class SessionStartFence {
  private readonly starts = new Map<string, {
    generation: number;
    result: Promise<boolean>;
    cancel: () => void;
    expiry?: ReturnType<typeof setTimeout>;
  }>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly retentionMs = 60_000) {}

  track(sessionId: string, start: Promise<boolean>): Promise<boolean> {
    const previous = this.starts.get(sessionId);
    previous?.cancel();
    if (previous?.expiry) clearTimeout(previous.expiry);
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    let cancel!: () => void;
    const cancelled = new Promise<boolean>((resolve) => {
      cancel = () => resolve(false);
    });
    const result = Promise.race([start, cancelled]).catch(() => false);
    const record = { generation, result, cancel, expiry: undefined as ReturnType<typeof setTimeout> | undefined };
    this.starts.set(sessionId, record);
    const retainBoundedly = () => {
      record.expiry = setTimeout(() => {
        if (this.starts.get(sessionId) === record) {
          this.starts.delete(sessionId);
          this.generations.delete(sessionId);
        }
      }, this.retentionMs);
      record.expiry.unref?.();
    };
    void result.then(retainBoundedly, retainBoundedly);
    return result;
  }

  async wait(sessionId: string): Promise<boolean | null> {
    const start = this.starts.get(sessionId);
    if (!start) return null;
    const result = await start.result;
    if (this.starts.get(sessionId)?.generation === start.generation) {
      if (start.expiry) clearTimeout(start.expiry);
      this.starts.delete(sessionId);
      this.generations.delete(sessionId);
    }
    return result;
  }

  /** Cancel the current generation synchronously. A waiter still consumes the retained failure. */
  cancel(sessionId: string): void {
    this.starts.get(sessionId)?.cancel();
  }
}
