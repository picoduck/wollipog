import type { ArchiveBrowserFilters } from "./archive-browser.js";
import { SESSION_LIFECYCLE_STATES } from "./archive-browser.js";
import { ARCHIVE_BROWSE_HISTORY_KEY as KEY } from "./history-position.js";

export interface ArchiveBrowseContext {
  filters: ArchiveBrowserFilters;
  page: number;
  cursors: Array<string | null>;
  scrollTop: number;
  rowId: string | null;
}

/** History is untrusted input (including entries left by older clients). No URL or storage copy. */
export function readArchiveBrowse(): ArchiveBrowseContext | null {
  const value = window.history.state?.[KEY] as Partial<ArchiveBrowseContext> | undefined;
  const f = value?.filters;
  if (!value || !f || typeof f.query !== "string" ||
      ![f.project, f.location, f.agent].every((v) => v === null || typeof v === "string") ||
      !["archived", "unarchived", "all"].includes(f.archive) ||
      !(f.lifecycle === "all" || SESSION_LIFECYCLE_STATES.includes(f.lifecycle)) ||
      !Number.isSafeInteger(value.page) || value.page! < 1 ||
      !Array.isArray(value.cursors) || value.cursors[0] !== null ||
      value.cursors.length < value.page! ||
      !value.cursors.every((v, i) => i === 0 ? v === null : typeof v === "string") ||
      typeof value.scrollTop !== "number" || !Number.isFinite(value.scrollTop) || value.scrollTop < 0 ||
      !(value.rowId === null || typeof value.rowId === "string")) return null;
  return value as ArchiveBrowseContext;
}

export function writeArchiveBrowse(context: ArchiveBrowseContext): void {
  window.history.replaceState({ ...window.history.state, [KEY]: context }, "");
}
