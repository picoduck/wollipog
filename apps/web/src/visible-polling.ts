/** Poll only while visible, and refresh immediately when a hidden tab returns. Callers retain
 * their own in-flight guards so visibility changes cannot overlap an outstanding request. */
export function startVisiblePolling(refresh: () => void, intervalMs: number): () => void {
  const poll = () => {
    if (document.visibilityState !== "hidden") refresh();
  };
  poll();
  const timer = window.setInterval(poll, intervalMs);
  document.addEventListener("visibilitychange", poll);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", poll);
  };
}
