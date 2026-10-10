/**
 * Ctrl/⌘+; puts focus in Side Chat (#2862): its message field, or Start Side Chat when there is no
 * side chat yet. A mounted panel takes the request at once, waiting for its first load if it is still
 * loading; otherwise the next panel to mount takes it, provided it mounts within a second, so a
 * request can never surface on an unrelated later visit.
 */
const sideChatFocusListeners = new Set<() => void>();
let sideChatFocusRequestedAt: number | null = null;
const SIDE_CHAT_FOCUS_WINDOW_MS = 1000;

export function requestSideChatFocus(): void {
  if (sideChatFocusListeners.size > 0) {
    sideChatFocusRequestedAt = null;
    for (const listener of sideChatFocusListeners) listener();
    return;
  }
  sideChatFocusRequestedAt = Date.now();
}

export function takeSideChatFocusRequest(): boolean {
  const requestedAt = sideChatFocusRequestedAt;
  sideChatFocusRequestedAt = null;
  return requestedAt !== null && Date.now() - requestedAt <= SIDE_CHAT_FOCUS_WINDOW_MS;
}

export function subscribeSideChatFocus(listener: () => void): () => void {
  sideChatFocusListeners.add(listener);
  return () => { sideChatFocusListeners.delete(listener); };
}
