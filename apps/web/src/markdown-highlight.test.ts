import assert from "node:assert/strict";
import test from "node:test";
import {
  CancelableIdleTaskQueue,
  createTimerIdleDriver,
  hasFencedCode,
  markdownHighlightEligible,
  MARKDOWN_HIGHLIGHT_IDLE_TIMEOUT_MS,
  MARKDOWN_HIGHLIGHT_MAX_BYTES,
  MARKDOWN_HIGHLIGHT_STABILITY_MS,
  StableIdleTaskCoordinator,
  type IdleDeadlineLike,
  type IdleDriver,
  type TimerDriver,
  utf8ByteLengthExceeds,
} from "./markdown-highlight.js";

class FakeIdleDriver implements IdleDriver {
  readonly requests: Array<{
    callback: (deadline: IdleDeadlineLike) => void;
    timeoutMs: number;
    cancelled: boolean;
  }> = [];

  request(callback: (deadline: IdleDeadlineLike) => void, timeoutMs: number): unknown {
    const request = { callback, timeoutMs, cancelled: false };
    this.requests.push(request);
    return request;
  }

  cancel(handle: unknown): void {
    (handle as { cancelled: boolean }).cancelled = true;
  }

  fireNext(deadline: IdleDeadlineLike = { didTimeout: true, timeRemaining: () => 0 }): void {
    const request = this.requests.find((candidate) => !candidate.cancelled);
    if (!request) throw new Error("no pending idle request");
    request.cancelled = true;
    request.callback(deadline);
  }
}

class FakeTimers implements TimerDriver {
  private nextId = 1;
  readonly timers = new Map<number, { callback: () => void; delayMs: number }>();

  set(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  fire(id: number): void {
    const timer = this.timers.get(id);
    if (!timer) return;
    this.timers.delete(id);
    timer.callback();
  }
}

test("highlight eligibility requires a visible fenced block within the exact UTF-8 ceiling", () => {
  assert.equal(hasFencedCode("inline ```js code```"), false);
  assert.equal(hasFencedCode("  ```js\nconst answer = 42;\n```"), true);
  assert.equal(hasFencedCode("~~~ts\nconst answer = 42;\n~~~"), true);
  assert.equal(markdownHighlightEligible("```js\nconst answer = 42;\n```", false), false);
  assert.equal(markdownHighlightEligible("ordinary **Markdown**", true), false);

  const fenceBytes = "```js\n".length + "\n```".length;
  const atLimit = `\`\`\`js\n${"a".repeat(MARKDOWN_HIGHLIGHT_MAX_BYTES - fenceBytes)}\n\`\`\``;
  assert.equal(markdownHighlightEligible(atLimit, true), true);
  assert.equal(markdownHighlightEligible(`${atLimit}a`, true), false);
  assert.equal(utf8ByteLengthExceeds("é", 1), true);
  assert.equal(utf8ByteLengthExceeds("é", 2), false);
  assert.equal(utf8ByteLengthExceeds("😀", 3), true);
  assert.equal(utf8ByteLengthExceeds("😀", 4), false);
});

test("global idle queue runs at most two live jobs per turn and cancels stale jobs", () => {
  const idle = new FakeIdleDriver();
  const queue = new CancelableIdleTaskQueue(idle);
  const ran: number[] = [];
  queue.enqueue(() => ran.push(1));
  const cancelSecond = queue.enqueue(() => ran.push(2));
  queue.enqueue(() => ran.push(3));
  queue.enqueue(() => ran.push(4));
  queue.enqueue(() => ran.push(5));
  cancelSecond();

  assert.equal(idle.requests.length, 1, "all rows share one scheduled idle turn");
  assert.equal(idle.requests[0]!.timeoutMs, MARKDOWN_HIGHLIGHT_IDLE_TIMEOUT_MS);
  idle.fireNext();
  assert.deepEqual(ran, [1, 3]);
  assert.equal(idle.requests.length, 2, "remaining work receives another turn");
  idle.fireNext();
  assert.deepEqual(ran, [1, 3, 4, 5]);
});

test("a non-timeout callback with no idle budget defers every job", () => {
  const idle = new FakeIdleDriver();
  const queue = new CancelableIdleTaskQueue(idle);
  let ran = false;
  queue.enqueue(() => { ran = true; });
  idle.fireNext({ didTimeout: false, timeRemaining: () => 0 });
  assert.equal(ran, false);
  assert.equal(idle.requests.length, 2);
  idle.fireNext({ didTimeout: false, timeRemaining: () => 1 });
  assert.equal(ran, true);
});

test("stable coordinator coalesces changing text and cancellation works before or after stability", () => {
  const timers = new FakeTimers();
  const idle = new FakeIdleDriver();
  const queue = new CancelableIdleTaskQueue(idle);
  const coordinator = new StableIdleTaskCoordinator<string>(queue, timers);
  const ran: string[] = [];

  coordinator.schedule("row", () => ran.push("old"));
  const firstTimer = [...timers.timers.keys()][0]!;
  assert.equal(timers.timers.get(firstTimer)!.delayMs, MARKDOWN_HIGHLIGHT_STABILITY_MS);
  coordinator.schedule("row", () => ran.push("latest"));
  assert.equal(timers.timers.has(firstTimer), false, "new text cancels the old stability timer");
  const latestTimer = [...timers.timers.keys()][0]!;
  timers.fire(latestTimer);
  idle.fireNext();
  assert.deepEqual(ran, ["latest"]);

  coordinator.schedule("cancel-before-timer", () => ran.push("bad timer"));
  coordinator.cancel("cancel-before-timer");
  assert.equal(timers.timers.size, 0);

  coordinator.schedule("cancel-after-timer", () => ran.push("bad idle"));
  const timer = [...timers.timers.keys()][0]!;
  timers.fire(timer);
  coordinator.cancel("cancel-after-timer");
  assert.throws(() => idle.fireNext(), /no pending idle request/);
  assert.deepEqual(ran, ["latest"]);
});

test("timer fallback reports a timeout deadline and remains cancelable", () => {
  const timers = new FakeTimers();
  const fallback = createTimerIdleDriver(timers);
  let deadline: IdleDeadlineLike | undefined;
  const handle = fallback.request((value) => { deadline = value; }, 999);
  const timer = [...timers.timers.keys()][0]!;
  assert.equal(timers.timers.get(timer)!.delayMs, 0);
  timers.fire(timer);
  assert.equal(deadline?.didTimeout, true);
  assert.equal(deadline?.timeRemaining(), 0);

  const cancelled = fallback.request(() => assert.fail("cancelled fallback ran"), 999);
  fallback.cancel(cancelled);
  assert.equal(timers.timers.size, 0);
  assert.notEqual(handle, cancelled);
});
