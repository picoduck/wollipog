export const MARKDOWN_HIGHLIGHT_MAX_BYTES = 64 * 1024;
export const MARKDOWN_HIGHLIGHT_STABILITY_MS = 150;
export const MARKDOWN_HIGHLIGHT_IDLE_TIMEOUT_MS = 1_000;
export const MARKDOWN_HIGHLIGHT_JOBS_PER_TURN = 2;

export interface IdleDeadlineLike {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

export interface IdleDriver {
  request(callback: (deadline: IdleDeadlineLike) => void, timeoutMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface TimerDriver {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface IdleTaskQueueLike {
  enqueue(task: () => void): () => void;
}

interface QueuedTask {
  cancelled: boolean;
  run: () => void;
}

/** Globally bounds independently mounted Markdown rows to two highlight jobs per idle turn. */
export class CancelableIdleTaskQueue implements IdleTaskQueueLike {
  private readonly tasks: QueuedTask[] = [];
  private scheduled: unknown | null = null;

  constructor(
    private readonly driver: IdleDriver,
    private readonly timeoutMs = MARKDOWN_HIGHLIGHT_IDLE_TIMEOUT_MS,
    private readonly jobsPerTurn = MARKDOWN_HIGHLIGHT_JOBS_PER_TURN,
  ) {}

  enqueue(run: () => void): () => void {
    const task: QueuedTask = { cancelled: false, run };
    this.tasks.push(task);
    this.ensureScheduled();
    return () => {
      task.cancelled = true;
      const index = this.tasks.indexOf(task);
      if (index >= 0) this.tasks.splice(index, 1);
      if (!this.hasPendingTasks() && this.scheduled !== null) {
        this.driver.cancel(this.scheduled);
        this.scheduled = null;
      }
    };
  }

  private ensureScheduled(): void {
    if (this.scheduled !== null || !this.hasPendingTasks()) return;
    this.scheduled = this.driver.request((deadline) => this.drain(deadline), this.timeoutMs);
  }

  private drain(deadline: IdleDeadlineLike): void {
    this.scheduled = null;
    let completed = 0;
    while (completed < this.jobsPerTurn) {
      const task = this.takeNextPendingTask();
      if (!task) break;
      // Timeout callbacks make bounded progress even if the page never reports spare idle time.
      if (!deadline.didTimeout && deadline.timeRemaining() <= 0) {
        this.tasks.unshift(task);
        break;
      }
      task.run();
      completed += 1;
    }
    this.ensureScheduled();
  }

  private takeNextPendingTask(): QueuedTask | undefined {
    while (this.tasks.length > 0) {
      const task = this.tasks.shift()!;
      if (!task.cancelled) return task;
    }
    return undefined;
  }

  private hasPendingTasks(): boolean {
    return this.tasks.some((task) => !task.cancelled);
  }
}

interface StableTask {
  timer: unknown | null;
  cancelIdle: (() => void) | null;
}

/** Coalesces changing content by key before handing only the latest job to the idle queue. */
export class StableIdleTaskCoordinator<Key> {
  private readonly tasks = new Map<Key, StableTask>();

  constructor(
    private readonly queue: IdleTaskQueueLike,
    private readonly timers: TimerDriver,
    private readonly stabilityMs = MARKDOWN_HIGHLIGHT_STABILITY_MS,
  ) {}

  schedule(key: Key, run: () => void): void {
    this.cancel(key);
    const task: StableTask = { timer: null, cancelIdle: null };
    task.timer = this.timers.set(() => {
      task.timer = null;
      task.cancelIdle = this.queue.enqueue(() => {
        if (this.tasks.get(key) !== task) return;
        this.tasks.delete(key);
        task.cancelIdle = null;
        run();
      });
    }, this.stabilityMs);
    this.tasks.set(key, task);
  }

  cancel(key: Key): void {
    const task = this.tasks.get(key);
    if (!task) return;
    this.tasks.delete(key);
    if (task.timer !== null) this.timers.clear(task.timer);
    task.cancelIdle?.();
  }
}

/** Timer-backed idle behavior for browsers without requestIdleCallback. */
export function createTimerIdleDriver(timers: TimerDriver): IdleDriver {
  return {
    request(callback) {
      return timers.set(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 0);
    },
    cancel(handle) {
      timers.clear(handle);
    },
  };
}

type IdleCapableGlobal = typeof globalThis & {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadlineLike) => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export const browserTimerDriver: TimerDriver = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createBrowserIdleDriver(): IdleDriver {
  const root = globalThis as IdleCapableGlobal;
  if (root.requestIdleCallback && root.cancelIdleCallback) {
    return {
      request: (callback, timeoutMs) => root.requestIdleCallback!(callback, { timeout: timeoutMs }),
      cancel: (handle) => root.cancelIdleCallback!(handle as number),
    };
  }
  return createTimerIdleDriver(browserTimerDriver);
}

/** Exact UTF-8 byte accounting without allocating a second buffer for a potentially large row. */
export function utf8ByteLengthExceeds(text: string, limit: number): boolean {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > limit) return true;
  }
  return false;
}

export function hasFencedCode(text: string): boolean {
  return /(^|\n)[\t ]{0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)/.test(text);
}

export function markdownHighlightEligible(text: string, visible: boolean): boolean {
  return visible && hasFencedCode(text) && !utf8ByteLengthExceeds(text, MARKDOWN_HIGHLIGHT_MAX_BYTES);
}
