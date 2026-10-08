/**
 * Runner-side coalescing of streamed text deltas (#2762).
 *
 * Providers stream assistant text and reasoning as many small deltas per second, and every driver
 * turns each one into its own `agent_message` / `agent_thought` event. Each event is a separate
 * history append, runner frame, control-plane transaction, broadcast, and client render, so every
 * downstream cost scales with token granularity rather than with what a reader can perceive.
 *
 * The coalescer sits between a driver and the session manager. It merges consecutive deltas of one
 * stream (same kind, message, and parent) into a single event, and emits at most one text event per
 * window: the first delta after a quiet window goes out immediately, so time to first visible text
 * does not grow, and later deltas wait at most one window. Anything that is not a mergeable delta,
 * including a delta of another stream, first flushes the pending text, so the resulting event
 * sequence is exactly the uncoalesced one with adjacent same-stream deltas concatenated. The client
 * already folds those adjacent deltas into one bubble, so what a reader sees is unchanged.
 */

import type { SessionEventPayload } from "@wollipog/protocol";
import type { DriverCallbacks } from "./drivers/driver.js";

/** One emission per 75 ms caps a message at about 13 streamed text events per second. */
export const TEXT_DELTA_WINDOW_MS = 75;
/** A merge never grows an event past this many UTF-16 units; pending text flushes first instead.
 * That keeps merged text within the control plane's 8,192-character search document and far below
 * its 16 KiB inline-text boundary, even when a provider sends large bursts. */
export const TEXT_DELTA_MAX_PENDING_CHARS = 4 * 1024;

type StreamedText = Extract<SessionEventPayload, { kind: "agent_message" | "agent_thought" }>;

/** Exactly the fields a streamed delta carries. Any other field could carry meaning that a merge
 * would lose or duplicate, so such an event passes through unmerged. */
const DELTA_FIELDS = new Set(["kind", "text", "final", "messageId", "parentToolUseId"]);

/** A non-final text delta of the plain streaming shape. A `final` event is a complete message that
 * replaces the streamed text, so it is never merged. */
export function isCoalescibleTextDelta(payload: SessionEventPayload): payload is StreamedText {
  if (payload.kind !== "agent_message" && payload.kind !== "agent_thought") return false;
  if (payload.final || typeof payload.text !== "string") return false;
  for (const key of Object.keys(payload)) if (!DELTA_FIELDS.has(key)) return false;
  return true;
}

function sameStream(a: StreamedText, b: StreamedText): boolean {
  return a.kind === b.kind && (a.messageId ?? "") === (b.messageId ?? "") &&
    (a.parentToolUseId ?? "") === (b.parentToolUseId ?? "");
}

export interface TextDeltaCoalescerOptions {
  windowMs?: number;
  maxPendingChars?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** Receives a failure to emit flushed text. A flush runs on behalf of whatever came next (a timer,
   * another event, an exit or shutdown), so it must not throw into that caller. */
  onError?: (error: unknown) => void;
}

export class TextDeltaCoalescer {
  private readonly windowMs: number;
  private readonly maxPendingChars: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly onError: (error: unknown) => void;
  private pending: StreamedText | null = null;
  private pendingChunks: string[] = [];
  private pendingChars = 0;
  private lastTextEmitAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private closed = false;

  constructor(
    private readonly emit: (payload: SessionEventPayload) => void,
    options: TextDeltaCoalescerOptions = {},
  ) {
    this.windowMs = options.windowMs ?? TEXT_DELTA_WINDOW_MS;
    this.maxPendingChars = options.maxPendingChars ?? TEXT_DELTA_MAX_PENDING_CHARS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.onError = options.onError ?? ((error) => console.warn(`streamed text flush failed: ${String(error)}`));
  }

  /** Route one driver event: merge a text delta, or flush pending text and then emit the event. */
  push(payload: SessionEventPayload): void {
    if (this.closed || !isCoalescibleTextDelta(payload)) {
      this.flush();
      this.emit(payload);
      return;
    }
    if (this.pending && (!sameStream(this.pending, payload) ||
        this.pendingChars + payload.text.length > this.maxPendingChars)) this.flush();
    if (this.pending) {
      this.pendingChunks.push(payload.text);
      this.pendingChars += payload.text.length;
      return;
    }
    const now = this.now();
    if (now - this.lastTextEmitAt >= this.windowMs) {
      this.lastTextEmitAt = now;
      this.emit(payload);
      return;
    }
    this.pending = payload;
    this.pendingChunks = [payload.text];
    this.pendingChars = payload.text.length;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, Math.max(0, this.lastTextEmitAt + this.windowMs - now));
  }

  /** Emit pending text now. Call before anything that must observe or follow it: another event,
   * a status change, turn settlement, interruption, provider exit, or runner shutdown. Never
   * throws: an emit failure goes to `onError`, and the caller's own step still runs. */
  flush(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const pending = this.pending;
    if (!pending) return;
    const text = this.pendingChunks.length === 1 ? this.pendingChunks[0]! : this.pendingChunks.join("");
    // Clear before emitting: the emit path re-enters flush() before every event it appends.
    this.pending = null;
    this.pendingChunks = [];
    this.pendingChars = 0;
    this.lastTextEmitAt = this.now();
    try {
      this.emit({ ...pending, text });
    } catch (error) {
      this.onError(error);
    }
  }

  /** Flush, then pass every later event straight through. A retiring or shut-down provider can
   * still emit late output, and nothing would flush text it left pending. */
  close(): void {
    this.closed = true;
    this.flush();
  }
}

/** Route a driver's callbacks through a new coalescer: text deltas merge, and every other callback
 * first flushes pending text, so nothing it records can observe or overtake an unsent delta. */
export function coalesceDriverTextDeltas(
  callbacks: DriverCallbacks,
  options?: TextDeltaCoalescerOptions,
): { callbacks: DriverCallbacks; coalescer: TextDeltaCoalescer } {
  const coalescer = new TextDeltaCoalescer(callbacks.onEvent, options);
  const routed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(callbacks)) {
    // A capability query records nothing, and drivers may ask it mid-stream.
    routed[name] = typeof value !== "function" || name === "supportsWorkerAttention"
      ? value
      : (...args: unknown[]) => {
          coalescer.flush();
          return (value as (...args: unknown[]) => unknown)(...args);
        };
  }
  return {
    callbacks: { ...routed, onEvent: (payload: SessionEventPayload) => coalescer.push(payload) } as DriverCallbacks,
    coalescer,
  };
}
