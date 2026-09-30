import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useApi } from "../api-context.js";
import { useStoreActions, useStoreSelector, type View } from "../store.js";
import {
  paletteSections,
  transcriptQueryTooShort,
  TRANSCRIPT_QUERY_MIN,
  type PaletteEntry,
  type TranscriptHit,
} from "../palette.js";
import { destination, EXTRA_PALETTE_DESTINATIONS } from "../navigation.js";
import { useExperiments } from "../use-experiments.js";
import { useInstanceScope } from "../instance-scope.js";
import { loadSessionsViewMode, sessionsDestination } from "../sessions-view-mode.js";
import { railDigits, setRailLabels, visibleRailViews } from "../rail-preferences.js";
import { useRailPreferences } from "../use-rail-preferences.js";
import { loadRecentSessions } from "../recent-sessions.js";
import { requestArchiveSearch } from "../archive-search-handoff.js";
import { matchesShortcut, shortcutDisplay, shortcutLayerActive } from "../shortcuts.js";
import { useIsMobile } from "./useIsMobile.js";
import { VIEW_ICONS } from "./Rail.js";
import { StatusBadge } from "./StatusBadge.js";
import { Spinner } from "./common.js";
import {
  BoardIcon,
  ListIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
  SettingsIcon,
  TranscriptHitIcon,
} from "./Icons.js";

export function useCommandPaletteFocus(
  inputRef: RefObject<HTMLInputElement | null>,
  returnFocusRef: RefObject<HTMLElement | null>,
): void {
  const restoreFocusTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (restoreFocusTimerRef.current != null) window.clearTimeout(restoreFocusTimerRef.current);
    restoreFocusTimerRef.current = null;
    inputRef.current?.focus();
    return () => {
      // An opener that a breakpoint crossing removed (the phone app bar's Search) hands focus to the
      // page title, the shell's rescue target, rather than leaving it on <body>.
      const target = returnFocusRef.current?.isConnected
        ? returnFocusRef.current
        : returnFocusRef.current ? document.getElementById("page-title") : null;
      if (target) {
        restoreFocusTimerRef.current = window.setTimeout(() => {
          restoreFocusTimerRef.current = null;
          target.focus();
        }, 0);
      }
    };
  }, [inputRef, returnFocusRef]);
}

function xtermOwnsKey(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".xterm"));
}

/**
 * Ctrl+K / Cmd+K toggles the palette. Deliberately ALSO from inputs/textareas (the Slack/Linear
 * convention — jumping mid-typing is the point) but NOT from a terminal: Ctrl+K is a real control
 * sequence inside xterm. Other layers (dialogs, menus) keep the key; the palette itself does not.
 */
export function useSearchShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || shortcutLayerActive(document, true)) return;
      if (matchesShortcut(e, "search")) {
        if (xtermOwnsKey(e.target)) return;
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}

const ICON_SIZE = 16;

function EntryIcon({ entry }: { entry: PaletteEntry }): ReactNode {
  switch (entry.kind) {
    case "session":
      // The dot alone: the second line already names the status, so the badge's label is dropped.
      return <StatusBadge meta={entry.status} label="" inline />;
    case "transcript":
      return <TranscriptHitIcon size={ICON_SIZE} />;
    case "destination": {
      if (entry.icon === "settings") return <SettingsIcon size={ICON_SIZE} />;
      const Icon = VIEW_ICONS[entry.icon];
      return <Icon size={ICON_SIZE} />;
    }
    case "action":
      return entry.icon === "board" ? <BoardIcon size={ICON_SIZE} />
        : entry.icon === "list" ? <ListIcon size={ICON_SIZE} />
          : entry.icon === "labels-on" ? <PanelLeftOpenIcon size={ICON_SIZE} />
            : <PanelLeftCloseIcon size={ICON_SIZE} />;
  }
}

/**
 * Cmd/Ctrl+K palette (#1978; docs/design-system.md §4.1 Search): one listbox of labelled sections.
 * An empty query shows Recent, Go To and Actions; a query shows matching sessions, debounced
 * full-text TRANSCRIPT hits from the control plane's FTS index once it is 3+ chars, and the
 * destinations and actions it names. A meta-harness aggregating N machines is unusable without
 * global search.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const instanceScope = useInstanceScope();
  const isMobile = useIsMobile();
  const { navigate, loadSession } = useStoreActions();
  const sessions = useStoreSelector((s) => s.sessions);
  const view = useStoreSelector((s) => s.view);
  const railPreferences = useRailPreferences();
  const [catalogSessions, setCatalogSessions] = useState(() => new Map(sessions));
  const [recent] = useState(() => loadRecentSessions(instanceScope));
  const [q, setQ] = useState("");
  // The active row by key, so a section arriving above it (late transcript hits) does not move it.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // The hits and the query they answer. Earlier hits stay on screen until the next ones replace them.
  const [hits, setHits] = useState<{ query: string; results: TranscriptHit[] }>({ query: "", results: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const listboxId = `command-palette-${useId().replace(/:/g, "")}`;
  useCommandPaletteFocus(inputRef, returnFocusRef);
  // Crossing 760px removes Cancel. If it held focus, focus stays in the dialog, on the field, so Tab
  // and Escape still reach the palette.
  const dialogRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) inputRef.current?.focus();
  }, [isMobile]);

  useEffect(() => {
    let cancelled = false;
    api.listAllSessions().then(({ sessions: allSessions }) => {
      if (!cancelled) setCatalogSessions(new Map(allSessions.map((session) => [session.id, session])));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api]);

  const query = q.trim();
  const transcriptQuery = query.length >= TRANSCRIPT_QUERY_MIN ? query : "";
  // Debounced transcript search: each keystroke restarts the wait, and only the latest query's
  // answer is kept. A query too short to search clears the hits (the hint row says why).
  useEffect(() => {
    if (!transcriptQuery) {
      setHits({ query: "", results: [] });
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .search(transcriptQuery)
        .then((r) => {
          if (!cancelled) setHits({ query: transcriptQuery, results: r.results });
        })
        .catch(() => {
          if (!cancelled) setHits({ query: transcriptQuery, results: [] });
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, transcriptQuery]);
  const searching = transcriptQuery !== "" && hits.query !== transcriptQuery;

  const { flags } = useExperiments();
  const sessionsMode = view.name === "board" || (view.name !== "inbox" && loadSessionsViewMode(instanceScope) === "board")
    ? "board" : "list";
  const sections = useMemo(() => {
    // Every visible destination with its digit, in rail order. A hidden or turned-off destination
    // is not listed: a palette hit that lands on the "turned off" notice would advertise a
    // destination the rail says does not exist. Digits are desktop bindings, so phones show none.
    const visible = visibleRailViews(railPreferences, flags);
    const digits = railDigits(visible);
    const destinations: PaletteEntry[] = [
      ...visible.map((id) => {
        const item = destination(id);
        return {
          kind: "destination" as const,
          key: `go-to:${item.id}`,
          label: item.name,
          icon: item.id,
          view: { name: item.id } as View,
          ...(isMobile ? {} : { keys: digits.get(item.id) }),
        };
      }),
      ...EXTRA_PALETTE_DESTINATIONS.map((entry) => ({
        kind: "destination" as const,
        key: `go-to:${entry.view.name}:${entry.label}`,
        label: entry.label,
        ...(entry.detail ? { detail: entry.detail } : { keys: isMobile ? undefined : shortcutDisplay("open-settings") }),
        icon: "settings" as const,
        view: entry.view,
      })),
    ];
    const actions: PaletteEntry[] = [
      {
        kind: "action",
        key: "action:toggle-sessions-view",
        action: "toggle-sessions-view",
        label: sessionsMode === "board" ? "Switch to List View" : "Switch to Board View",
        icon: sessionsMode === "board" ? "list" : "board",
        // `b` flips the mode only where Sessions is on screen, so the keycap is shown only there.
        ...(!isMobile && (view.name === "inbox" || view.name === "board") ? { keys: shortcutDisplay("toggle-sessions-view") } : {}),
      },
      // The labelled rail never applies at 760px and below (#1968), so it is not offered there.
      ...(isMobile ? [] : [{
        kind: "action" as const,
        key: "action:toggle-rail-labels",
        action: "toggle-rail-labels" as const,
        label: railPreferences.labels ? "Hide Navigation Labels" : "Show Navigation Labels",
        icon: railPreferences.labels ? "labels-off" as const : "labels-on" as const,
      }]),
    ];
    const merged = new Map(catalogSessions);
    for (const session of sessions.values()) merged.set(session.id, session);
    return paletteSections({ query: q, sessions: merged, recent, hits: hits.results, destinations, actions });
  }, [catalogSessions, sessions, q, hits, flags, railPreferences, isMobile, sessionsMode, view.name, recent]);

  const entries = useMemo(() => sections.flatMap((section) => section.entries), [sections]);
  const found = entries.findIndex((entry) => entry.key === activeKey);
  const sel = found >= 0 ? found : 0;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  // Keep the active row in view as the arrow keys walk past the list's edge.
  useEffect(() => {
    document.getElementById(optionId(sel))?.scrollIntoView?.({ block: "nearest" });
  }, [sel, listboxId]);

  const pick = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    if (entry.kind === "action") {
      if (entry.action === "toggle-rail-labels") setRailLabels(!railPreferences.labels, instanceScope);
      else navigate({ name: sessionsMode === "board" ? "inbox" : "board" });
      onClose();
      return;
    }
    if (entry.view.name === "session") {
      const session = catalogSessions.get(entry.view.id);
      if (session) loadSession(session);
    }
    // "Sessions" is a destination pick, so it opens the persisted list/board mode.
    navigate(entry.view.name === "inbox" ? sessionsDestination(instanceScope) : entry.view);
    onClose();
  };

  const clearSearch = () => {
    setQ("");
    setActiveKey(null);
    inputRef.current?.focus();
  };

  const searchArchive = () => {
    requestArchiveSearch(query);
    navigate({ name: "archived" });
    onClose();
  };

  const noResults = query !== "" && entries.length === 0 && !searching;
  let index = -1;

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Consume the press: the shell's layered-Escape handler would otherwise ALSO
            // close a popover sitting under the palette — violating the one-layer-per-press contract.
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          // Focus stays inside: the field, Cancel on phones, and the no-results actions. Rows are
          // reached with the arrow keys, not Tab.
          event.preventDefault();
          const stops = [...event.currentTarget.querySelectorAll<HTMLElement>("input, button:not([tabindex='-1'])")];
          const at = stops.indexOf(document.activeElement as HTMLElement);
          const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length;
          stops[next]?.focus();
        }}
      >
        <div className="palette-bar">
          <SearchIcon size={ICON_SIZE} className="palette-bar-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            role="combobox"
            aria-label="Search"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={entries[sel] ? optionId(sel) : undefined}
            placeholder="Search sessions and transcripts"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActiveKey(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveKey(entries[Math.min(sel + 1, entries.length - 1)]?.key ?? null);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveKey(entries[Math.max(sel - 1, 0)]?.key ?? null);
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                pick(entries[sel]);
              }
            }}
          />
          {isMobile && (
            <button type="button" className="btn ghost palette-cancel" onClick={onClose}>Cancel</button>
          )}
        </div>
        <div className="palette-results">
          <div role="listbox" id={listboxId} aria-label="Results">
            {sections.map((section) => (
              <div key={section.id} className="palette-section" role="group" aria-labelledby={`${listboxId}-${section.id}`}>
                <div className="palette-section-label" id={`${listboxId}-${section.id}`} role="presentation">
                  {section.label}
                </div>
                {section.entries.map((entry) => {
                  index += 1;
                  const i = index;
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === sel}
                      tabIndex={-1}
                      className={`palette-item${i === sel ? " on" : ""}`}
                      onMouseEnter={() => setActiveKey(entry.key)}
                      onClick={() => pick(entry)}
                    >
                      <span className="palette-icon" aria-hidden="true"><EntryIcon entry={entry} /></span>
                      <span className="palette-body">
                        <span className="palette-label">{entry.label}</span>
                        {entry.detail && <span className="palette-detail">{entry.detail}</span>}
                        {entry.snippet && <span className="palette-detail palette-snippet">{renderSnippet(entry.snippet)}</span>}
                      </span>
                      {entry.keys && <kbd aria-hidden="true">{entry.keys}</kbd>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div role="status">
            {searching && (
              <div className="palette-note">
                <Spinner decorative />
                <span>Searching transcripts…</span>
              </div>
            )}
            {transcriptQueryTooShort(q) && (
              <div className="palette-note">
                <SearchIcon size={ICON_SIZE} />
                <span>Type {TRANSCRIPT_QUERY_MIN} or more characters to search transcripts.</span>
              </div>
            )}
          </div>
          {noResults && (
            <div className="palette-empty">
              <p>
                <SearchIcon size={ICON_SIZE} />
                <span>No sessions, transcripts or pages match “{query}”.</span>
              </p>
              <div className="palette-empty-actions">
                <button type="button" className="btn sm" onClick={clearSearch}>Clear Search</button>
                <button type="button" className="btn sm" onClick={searchArchive}>Search Archived Sessions</button>
              </div>
            </div>
          )}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span className="shortcut-hint"><kbd>↑</kbd><kbd>↓</kbd><span className="shortcut-hint-label">Move</span></span>
          <span className="shortcut-hint"><kbd>Enter</kbd><span className="shortcut-hint-label">Open</span></span>
          <span className="shortcut-hint"><kbd>Esc</kbd><span className="shortcut-hint-label">Close</span></span>
        </div>
      </div>
    </div>
  );
}

/** FTS snippets mark matches with ⟪⟫ (chosen server-side; never valid HTML) — render them bold. */
function renderSnippet(s: string) {
  const parts = s.split(/⟪|⟫/);
  return parts.map((p, i) => (i % 2 === 1 ? <b key={i}>{p}</b> : <Fragment key={i}>{p}</Fragment>));
}
