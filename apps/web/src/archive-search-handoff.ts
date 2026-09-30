/**
 * The palette's "Search Archived Sessions" hands its query to Archived Sessions (#1978).
 *
 * Not a route parameter: the archive's search field is not reflected in its URL, so a `?q=` would
 * go stale on the first keystroke there. The query waits here until Archived Sessions takes it, on
 * mount or, when it is already open under the palette, on the event.
 */

export const ARCHIVE_SEARCH_EVENT = "wollipog:archive-search";

let pending: string | null = null;

export function requestArchiveSearch(query: string): void {
  pending = query;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ARCHIVE_SEARCH_EVENT));
}

/** The waiting query, left in place; read during render, where a side effect would run twice. */
export function pendingArchiveSearch(): string | null {
  return pending;
}

/** Take the waiting query, once. */
export function takeArchiveSearch(): string | null {
  const query = pending;
  pending = null;
  return query;
}
