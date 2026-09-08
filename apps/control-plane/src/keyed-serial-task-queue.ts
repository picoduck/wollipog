/** Serialize asynchronous work for each key while allowing different keys to proceed independently. */
export class KeyedSerialTaskQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, queued);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === queued) this.tails.delete(key);
    }
  }
}
