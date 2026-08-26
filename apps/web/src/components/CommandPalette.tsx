import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { useApi } from "../api-context.js";
import { useStoreActions, useStoreSelector, type View } from "../store.js";
import { matchSessions, type PaletteEntry } from "../palette.js";
import { EXTRA_PALETTE_DESTINATIONS, GLOBAL_VIEW_ITEMS } from "../navigation.js";
import { sessionArchiveSearchDetail } from "../archive-browser.js";
import { experimentForViewName } from "../experiments.js";
import { useExperiments } from "../use-experiments.js";

export function useCommandPaletteFocus(
  inputRef: RefObject<HTMLInputElement>,
  returnFocusRef: RefObject<HTMLElement>,
): void {
  const restoreFocusTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (restoreFocusTimerRef.current != null) window.clearTimeout(restoreFocusTimerRef.current);
    restoreFocusTimerRef.current = null;
    inputRef.current?.focus();
    return () => {
      const target = returnFocusRef.current;
      if (target?.isConnected) {
        restoreFocusTimerRef.current = window.setTimeout(() => {
          restoreFocusTimerRef.current = null;
          target.focus();
        }, 0);
      }
    };
  }, [inputRef, returnFocusRef]);
}

/**
 * Cmd/Ctrl+K palette: local fuzzy match over sessions (title/workspace/agent) + fixed views,
 * plus debounced full-text TRANSCRIPT hits from the control plane's FTS index once the query
 * is 3+ chars. A meta-harness aggregating N machines is unusable without global search.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const { navigate, loadSession } = useStoreActions();
  const sessions = useStoreSelector((s) => s.sessions);
  const [catalogSessions, setCatalogSessions] = useState(() => new Map(sessions));
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [hits, setHits] = useState<{ sessionId: string; snippet: string; title: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const listboxId = `command-palette-${useId().replace(/:/g, "")}`;
  useCommandPaletteFocus(inputRef, returnFocusRef);

  useEffect(() => {
    let cancelled = false;
    api.listAllSessions().then(({ sessions: allSessions }) => {
      if (!cancelled) setCatalogSessions(new Map(allSessions.map((session) => [session.id, session])));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api]);

  // Debounced transcript search — cancelled per keystroke, skipped for short queries.
  useEffect(() => {
    const query = q.trim();
    if (query.length < 3) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .search(query)
        .then((r) => {
          if (!cancelled) setHits(r.results);
        })
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, q]);

  const { flags } = useExperiments();
  const entries = useMemo<PaletteEntry[]>(() => {
    const views: PaletteEntry[] = [
      // A hidden experiment is hidden from search too: a palette hit that lands on the
      // "turned off" notice would advertise a destination the rail says does not exist.
      ...GLOBAL_VIEW_ITEMS.filter((item) => {
        const experiment = experimentForViewName(item.name);
        return experiment === null || flags[experiment];
      }).map((item) => ({
        kind: "view" as const,
        label: item.paletteLabel,
        view: { name: item.name } as View,
      })),
      // Settings has no rail row, so deriving the fixed list from GLOBAL_VIEW_ITEMS alone left the
      // one destination a keyboard user is most likely to search for unreachable from the palette.
      ...EXTRA_PALETTE_DESTINATIONS.map((entry) => ({
        kind: "view" as const,
        label: entry.label,
        view: entry.view,
      })),
    ];
    const mergedSessions = new Map(catalogSessions);
    for (const session of sessions.values()) mergedSessions.set(session.id, session);
    const sess = matchSessions([...mergedSessions.values()], q, 8);
    // Transcript hits dedupe by session (top snippet wins — rank order from the server).
    const seen = new Set<string>();
    const transcript: PaletteEntry[] = [];
    for (const h of hits) {
      if (seen.has(h.sessionId)) continue;
      seen.add(h.sessionId);
      transcript.push({
        kind: "transcript",
        label: h.title || h.sessionId,
        snippet: h.snippet,
        detail: mergedSessions.get(h.sessionId) ? sessionArchiveSearchDetail(mergedSessions.get(h.sessionId)!) : "Session State Unavailable",
        view: { name: "session", id: h.sessionId },
      });
    }
    const viewMatches = q.trim()
      ? views.filter((v) => v.label.toLowerCase().includes(q.trim().toLowerCase()))
      : views;
    return [...sess, ...transcript, ...viewMatches];
  }, [catalogSessions, sessions, q, hits, flags]);

  useEffect(() => {
    // Clamp BOTH bounds: ArrowDown on an empty list would park sel at -1 and leave Enter
    // dead even after async transcript hits arrive.
    const clamped = entries.length === 0 ? 0 : Math.max(0, Math.min(sel, entries.length - 1));
    if (clamped !== sel) setSel(clamped);
  }, [entries.length, sel]);

  const pick = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    if (entry.view.name === "session") {
      const session = catalogSessions.get(entry.view.id);
      if (session) loadSession(session);
    }
    navigate(entry.view as View);
    onClose();
  };

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <input
          ref={inputRef}
          className="palette-input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={entries[sel] ? `${listboxId}-option-${sel}` : undefined}
          placeholder="Search sessions, transcripts, views…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
            // Clear transcript hits IMMEDIATELY: stale hits from the previous query stay
            // clickable through the debounce window and would navigate somewhere unrelated
            // to the visible text.
            setHits([]);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              // Consume the press: the shell's layered-Escape handler would otherwise ALSO
              // close a popover sitting under the palette —
              // violating the one-layer-per-press contract.
              e.stopPropagation();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.max(0, Math.min(s + 1, entries.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              pick(entries[sel]);
            }
          }}
        />
        <div className="palette-list" role="listbox" id={listboxId}>
          {entries.length === 0 && <div className="palette-empty">No Matches</div>}
          {entries.map((entry, i) => (
            <button
              key={`${entry.kind}-${entry.label}-${i}`}
              id={`${listboxId}-option-${i}`}
              role="option"
              aria-selected={i === sel}
              tabIndex={-1}
              className={`palette-item${i === sel ? " on" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(entry)}
            >
              <span className="palette-kind">
                {entry.kind === "session" ? "▤" : entry.kind === "transcript" ? "❞" : "→"}
              </span>
              <span className="palette-body">
                <span className="palette-label">{entry.label}</span>
                {entry.detail && <span className="palette-detail">{entry.detail}</span>}
                {entry.snippet && <span className="palette-detail">{renderSnippet(entry.snippet)}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** FTS snippets mark matches with ⟪⟫ (chosen server-side; never valid HTML) — render them bold. */
function renderSnippet(s: string) {
  const parts = s.split(/⟪|⟫/);
  return parts.map((p, i) => (i % 2 === 1 ? <b key={i}>{p}</b> : <span key={i}>{p}</span>));
}
