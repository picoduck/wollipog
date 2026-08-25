/**
 * Outbound event buffer for the runner→control-plane transport. While the control-plane socket is
 * down or mid-reconnect, terminal statuses and permission requests produced during the blip must not
 * be lost, so `sendUp` buffers them here and `flushOutbox` drains them in order once registered.
 *
 * This module owns ONLY the pure buffering policy — coalescing, the overflow cap, and drain order.
 * The live "is the socket open and registered?" decision and the actual `ws.send` (with protocol
 * projection) stay in the daemon; the buffer never touches the transport.
 */

/** Oldest-drop cap. A sustained outage can produce unbounded status/queue churn; keep only the most
 * recent MAX_OUTBOX events so a blip cannot grow the buffer without bound. */
export const MAX_OUTBOX = 1000;

/** The buffer only needs a message's discriminant and (for coalescing) its session id. */
export interface CoalescableMessage {
  type: string;
  sessionId?: string;
}

export class Outbox<T extends CoalescableMessage> {
  private readonly buffer: T[] = [];

  constructor(private readonly max: number = MAX_OUTBOX) {}

  /** Number of currently buffered messages. */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * Buffer one message while the transport is unavailable.
   *
   * Coalesces redundant `session_status` / `session_queue` for the same session — only the LATEST of
   * either matters (a queue snapshot fully replaces the previous one, and snapshots carry prompt
   * previews, so letting them stack during a blip wastes the buffer on payloads a flush would
   * immediately supersede). The surviving entry is re-appended at the tail so it flushes in the
   * newest position. Past the cap, the oldest entries are dropped.
   */
  enqueue(msg: T): void {
    if (msg.type === "session_status" || msg.type === "session_queue") {
      const i = this.buffer.findIndex((m) => m.type === msg.type && m.sessionId === msg.sessionId);
      if (i !== -1) this.buffer.splice(i, 1);
    }
    this.buffer.push(msg);
    if (this.buffer.length > this.max) this.buffer.splice(0, this.buffer.length - this.max);
  }

  /** Restore an unsent suffix at the front without re-coalescing or reordering it. */
  restoreFront(messages: readonly T[]): void {
    if (!messages.length) return;
    this.buffer.unshift(...messages);
    if (this.buffer.length > this.max) this.buffer.splice(this.max);
  }
  /** Remove and return every buffered message in send order (oldest first). */
  drain(): T[] {
    return this.buffer.splice(0);
  }
}
export function flushProjectedOutbox<T extends CoalescableMessage, U>(
  outbox: Outbox<T>,
  project: (message: T) => U | null,
  send: (message: U) => void,
  onProjectionError: (error: unknown, message: T) => void,
  onSendError: (error: unknown, message: T) => void,
): void {
  const messages = outbox.drain();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    let projected: U | null;
    try {
      projected = project(message);
    } catch (error) {
      onProjectionError(error, message);
      continue;
    }
    if (projected === null) continue;
    try {
      send(projected);
    } catch (error) {
      outbox.restoreFront(messages.slice(index));
      onSendError(error, message);
      return;
    }
  }
}
