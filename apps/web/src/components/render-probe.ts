import type { ProfilerOnRenderCallback } from "react";

/**
 * Commits that rendered the session view or its transcript (#2764).
 *
 * Two `<Profiler>`s report here. `SESSION_VIEW_PROBE` wraps the transcript from outside the
 * timeline's props compare, so it renders whenever the session view around it does.
 * `TRANSCRIPT_PROBE` sits inside that compare, so it renders only when the timeline itself does.
 * Tests observe them to prove that typing in the composer renders neither. A production build of
 * React never calls a Profiler's `onRender`, so outside development and tests this reports nothing
 * and costs nothing.
 */
export const SESSION_VIEW_PROBE = "session-view";
export const TRANSCRIPT_PROBE = "session-transcript";
/** The session view itself, not the transcript inside it: the view renders it whenever the view
 * renders, and a streamed chunk that renders only the transcript does not (#2763). */
export const SESSION_DETAIL_PROBE = "session-detail";
/** One transcript row (#2763). Each row reports as `timeline-row:<item id>`; observing the bare
 * prefix receives every row with its full id, so a test can tell which rows rendered. */
export const TIMELINE_ROW_PROBE = "timeline-row";

const listeners = new Map<string, Set<(id: string) => void>>();

export const reportRenderProbe: ProfilerOnRenderCallback = (id) => {
  for (const listener of [...(listeners.get(id) ?? [])]) listener(id);
  const prefix = id.indexOf(":");
  if (prefix > 0) for (const listener of [...(listeners.get(id.slice(0, prefix)) ?? [])]) listener(id);
};

export function observeRenderProbe(id: string, listener: (id: string) => void): () => void {
  const forId = listeners.get(id) ?? new Set<(id: string) => void>();
  forId.add(listener);
  listeners.set(id, forId);
  return () => {
    forId.delete(listener);
    if (forId.size === 0 && listeners.get(id) === forId) listeners.delete(id);
  };
}
