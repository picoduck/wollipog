export const VIRTUAL_VIEWPORT_INTENT_EVENT = "wollipog:virtual-viewport-intent";

export type VirtualViewportIntentDirection = "up" | "down";

export interface VirtualViewportIntentDetail {
  /** Which way the programmatic scroll that follows will move, when the caller knows. */
  direction?: VirtualViewportIntentDirection;
}

/** Claim viewport ownership immediately before a deliberate programmatic scroll. Session Reading
 * keys and Inbox paging own their viewport this way; the transcript treats the claim as reader
 * intent, so the direction lets an upward claim at the head ask for earlier activity even though
 * the scroll it precedes cannot move. */
export function dispatchVirtualViewportIntent(
  target: Partial<Pick<EventTarget, "dispatchEvent">> | null | undefined,
  direction?: VirtualViewportIntentDirection,
): void {
  if (!target?.dispatchEvent) return;
  const detail: VirtualViewportIntentDetail = direction ? { direction } : {};
  // Build the event from the target's own window: a DOM implementation rejects an event whose
  // constructor belongs to a different realm (a Node global against a test document).
  const view = (target as Partial<Node>).ownerDocument?.defaultView;
  const EventConstructor = view?.CustomEvent ?? CustomEvent;
  target.dispatchEvent(new EventConstructor(VIRTUAL_VIEWPORT_INTENT_EVENT, { detail }));
}

export function virtualViewportIntentDirection(event: Event): VirtualViewportIntentDirection | null {
  const detail = (event as Partial<CustomEvent<VirtualViewportIntentDetail>>).detail;
  return detail?.direction ?? null;
}
