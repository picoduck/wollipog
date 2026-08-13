export const VIRTUAL_VIEWPORT_INTENT_EVENT = "wollipog:virtual-viewport-intent";

export function dispatchVirtualViewportIntent(
  target: Partial<Pick<EventTarget, "dispatchEvent">> | null | undefined,
): void {
  target?.dispatchEvent?.(new Event(VIRTUAL_VIEWPORT_INTENT_EVENT));
}
