import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import type { SkillVersionSummary } from "../skills.js";

/**
 * A skill's versions, newest first, read a page at a time (#1984). Version History and Machine
 * Version both list them, and both read the next page when the list's end scrolls into view
 * (`SkillVersionListEnd`) rather than behind a Load Older Versions button.
 */
export function useSkillVersionPages(skillId: string) {
  const api = useApi();
  const [versions, setVersions] = useState<SkillVersionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  /** The first page is still being read. */
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  /** The newest versions couldn't be read: the list, if any, is from an earlier read. */
  const [error, setError] = useState<string | null>(null);
  /** An older page couldn't be read; the list's end offers Retry. */
  const [moreError, setMoreError] = useState<string | null>(null);
  // Bumped by every reload, so a page that answers after a reload is dropped.
  const generation = useRef(0);
  const busy = useRef(false);

  /** Reads the newest page again. Resolves to the fresh list, or null when it failed or was superseded. */
  const reload = useCallback(async (): Promise<SkillVersionSummary[] | null> => {
    const current = ++generation.current;
    busy.current = true;
    // An older page still being read belongs to the generation this one replaces, and its own
    // settling is fenced off, so its flag is cleared here.
    setLoading(true); setLoadingMore(false); setError(null); setMoreError(null);
    try {
      const result = await api.listSkillVersions(skillId);
      if (generation.current !== current) return null;
      setVersions(result.versions); setCursor(result.nextCursor);
      return result.versions;
    } catch (cause) {
      if (generation.current === current) setError((cause as Error).message);
      return null;
    } finally {
      if (generation.current === current) { busy.current = false; setLoading(false); }
    }
  }, [api, skillId]);

  useEffect(() => {
    void reload();
    return () => { generation.current++; };
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (!cursor || busy.current) return;
    const current = generation.current;
    busy.current = true;
    setLoadingMore(true); setMoreError(null);
    try {
      const result = await api.listSkillVersions(skillId, cursor);
      if (generation.current !== current) return;
      setVersions((prior) => [...prior, ...result.versions]); setCursor(result.nextCursor);
    } catch (cause) {
      if (generation.current === current) setMoreError((cause as Error).message);
    } finally {
      if (generation.current === current) { busy.current = false; setLoadingMore(false); }
    }
  }, [api, skillId, cursor]);

  return { versions, cursor, loading, loadingMore, error, moreError, reload, loadMore };
}

/**
 * The end of a version list. While older versions remain it reads the next page as soon as it is
 * scrolled into view, showing skeleton rows meanwhile (§12.3); a failed read shows Retry in place.
 * It watches whichever box scrolls the list, the pane on desktop or the sheet on a phone, so the
 * dialog needs no scroll box of its own for the list.
 */
export function SkillVersionListEnd({ pages }: { pages: ReturnType<typeof useSkillVersionPages> }) {
  const { cursor, loading, loadingMore, error, moreError, loadMore, versions } = pages;
  const ref = useRef<HTMLDivElement>(null);
  const waiting = !!cursor && !loading && !loadingMore && !error && !moreError;
  useEffect(() => {
    const element = ref.current;
    if (!element || !waiting) return;
    // Without an observer (an old browser, a test DOM) every page is read in turn.
    if (typeof IntersectionObserver !== "function") { void loadMore(); return; }
    // A new observer for every page: observing reports the end's position at once, so a page too
    // short to scroll still reads the next one.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "0px 0px 120px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [waiting, loadMore, versions.length]);
  if (!cursor && !loadingMore) return null;
  return <div ref={ref} className="skill-version-list-end">
    {moreError
      ? <p className="skill-version-list-error" role="alert">
        Older versions couldn't be loaded. <button type="button" className="btn sm" onClick={() => void loadMore()}>Retry</button>
      </p>
      : <div role="status"><span className="sr-only">{loadingMore ? "Loading older versions…" : ""}</span>
        <div className="skeleton-row" /><div className="skeleton-row" /></div>}
  </div>;
}
