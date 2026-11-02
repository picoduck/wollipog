/** Processing credits for regenerable reconnect metadata only. Live sends never enter this class. */
export const RUNNER_WINDOW_BYTES = 2 * 1024 * 1024;
export const RUNNER_WINDOW_FRAMES = 128;

export class ProcessingWindow {
  get complete(): boolean { return this.closed && this.index === this.ids.length; }
  private index = 0;
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private waiting: { id: number; since: number; bytes: number; frames: number } | undefined;
  private nextId = 1;
  private closed = false;
  private watchdog: ReturnType<typeof setInterval>;

  constructor(
    private readonly ids: readonly string[],
    private readonly read: (id: string) => string | null,
    private readonly write: (wire: string) => void,
    private readonly fail: () => void,
    private readonly diagnostic: (details: { event: string; barrierId: number; durationMs: number; bytes: number; frames: number }) => void,
  ) {
    let reported = false;
    this.watchdog = setInterval(() => {
      if (!this.waiting || reported || performance.now() - this.waiting.since < 2000) return;
      reported = true;
      this.diagnostic({ event: "runner_processing_barrier_stalled", barrierId: this.waiting.id, durationMs: Math.round(performance.now() - this.waiting.since),
        bytes: this.waiting.bytes, frames: this.waiting.frames });
    }, 1000);
    this.watchdog.unref();
    this.schedule();
  }

  acknowledge(id: number): void {
    if (this.closed || !this.waiting || id !== this.waiting.id) return;
    this.waiting = undefined;
    if (this.index === this.ids.length) this.close();
    else this.schedule();
  }

  /** Unsent inventory is regenerated next registration, never restored to the live outbox. */
  close(): void {
    this.closed = true;
    clearInterval(this.watchdog);
    if (this.scheduled) clearImmediate(this.scheduled);
    this.waiting = undefined;
  }

  private schedule(): void {
    if (this.closed || this.waiting || this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      let bytes = 0;
      let frames = 0;
      let visited = 0;
      try {
        while (this.index < this.ids.length && visited++ < RUNNER_WINDOW_FRAMES) {
          // No snapshot survives a yield. A frame that did not fit is read again after the ACK,
          // so a newer live update cannot be followed by cached older state.
          const wire = this.read(this.ids[this.index]!);
          if (wire === null) { this.index++; continue; }
          const size = Buffer.byteLength(wire);
          // A single legal oversized snapshot still uses the existing receive-pressure backstop.
          if (frames && bytes + size > RUNNER_WINDOW_BYTES) break;
          this.write(wire);
          this.index++;
          bytes += size;
          frames++;
        }
        if (frames) {
          const id = this.nextId++;
          this.waiting = { id, since: performance.now(), bytes, frames };
          this.write(JSON.stringify({ type: "runner_processing_barrier", barrierId: id }));
        } else if (this.index === this.ids.length) this.close();
        else this.schedule();
      } catch {
        this.close();
        this.fail();
      }
    });
  }
}
