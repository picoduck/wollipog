import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  DOCK_DEFAULT_HEIGHT,
  DOCK_MIN_HEIGHT,
  clampDockHeight,
  parseStoredHeight,
  resolveDockDrag,
} from "../dock.js";
import {
  TerminalNewTab,
  TerminalSearchButton,
  TerminalSearchControls,
  TerminalTabs,
} from "./TerminalHead.js";
import { TerminalSurface, useTerminalHost } from "./TerminalSurface.js";
import { holdFieldFocus } from "./requests/hold-field-focus.js";
import { ChevronDownIcon } from "./Icons.js";
import { useIsCoarsePointer, useIsMobile } from "./useIsMobile.js";
import { shortcutAriaKeys, shortcutDisplay } from "../shortcuts.js";
import type { ResolvedTheme } from "../theme.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";
import { useToastChrome } from "./useToastChrome.js";

/** Viewport-aware height ceiling: every height write (stored, drag, keyboard) goes through
 * this so the dock can never crush the transcript + composer, even after the window shrinks. */
function viewportDockMax(): number {
  return Math.floor(window.innerHeight * 0.6);
}

/**
 * Bottom shell dock (a compact terminal panel): spans the main pane under the
 * session view, drag-resizable on its top edge. Mounted ONLY while toggled on (topbar button /
 * Ctrl+` / the right panel's Terminal row) — there is no always-visible bar. Hosts the
 * session's shell tabs — each a shell running in the session's working directory (worktree or
 * repo, runner-resolved), so it still means "a shell where the agent works", including remote
 * boxes.
 *
 * POSIX/WSL shells are real PTYs (xterm pane IS the input); Windows-native shells are
 * pipe-based with a line-input row. Hide Terminal unmounts the dock and the shells keep running;
 * explicit tab close kills/forgets.
 *
 * The dock is a host (#2867): the tabs, the active tab, search, the pipe rows' drafts and history and
 * each shell's xterm terminal belong to the session's terminal store (`useSessionTerminals`), so
 * hiding and reopening the dock keeps all of them, scrollback and scroll position included. The dock
 * owns only its height.
 *
 * Its one 40px head (#2864; docs/design-system.md §4.6) is the tabs, then Search Output, New Tab and
 * Hide Terminal. The tabs, search and New Tab are TerminalHead's, which any terminal host renders.
 *
 * Its body (#2865; §4.6) is the flush terminal on --terminal-bg (`TerminalSurface`, which the side
 * panel's Terminal tool renders too, #2868): the terminal's one notice, one mounted `ShellTerminal`
 * per shell with the others hidden, then an exited shell's status row or a pipe shell's command row;
 * with no shell, an empty state.
 *
 * On a phone (#2866; §4.6, §15.1) the dock is a sheet in the composer's place, which the session hides
 * while it is open. Its head stays one row: Search Output stays in it, pressed while search is open,
 * and the open search takes its own row under the head (`.dock-search-row`). The stylesheet fits the
 * sheet between the session bar and the tab bar, or the keyboard while one of its fields has focus.
 */
export function ShellDock({
  sessionId,
  onClose,
  theme,
  scheme,
}: {
  sessionId: string;
  onClose: () => void;
  theme: ResolvedTheme;
  /** Passed through so a mounted terminal recolours when the SCHEME changes, not only the theme. */
  scheme: string;
}) {
  const tabsetId = `shell-dock-${useId().replace(/:/g, "")}`;
  const coarsePointer = useIsCoarsePointer();
  const phone = useIsMobile();
  const toastLayoutRef = useToastChrome<HTMLDivElement>();
  // On a phone the open search has its own row; elsewhere it replaces Search Output in the head.
  const host = useTerminalHost(sessionId, tabsetId, {
    searchPlacement: phone ? "row" : "head",
    fallbackFocusIds: [`${tabsetId}-new`, `${tabsetId}-hide`],
  });

  // `height` is the user's PREFERENCE — only explicit gestures (drag, keyboard, double-click)
  // change it, so a temporary viewport shrink while the dock is collapsed can never clobber
  // the size the user left it at. What actually renders is `effectiveHeight` below: the
  // preference clamped to `viewportMax` state, which the window-resize listener keeps fresh
  // (state, not a render-time window read, so the ARIA range re-renders too).
  const [height, setHeight] = useState(() => {
    try {
      return parseStoredHeight(loadBrowserStorageValue("wollipog.shelldock.height"));
    } catch {
      return DOCK_DEFAULT_HEIGHT;
    }
  });
  const [viewportMax, setViewportMax] = useState(() => viewportDockMax());
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // Persist prefs once values settle (not per pointermove). Visibility is persisted by the
  // app shell (which owns the mount); only the height pref lives here.
  useEffect(() => {
    if (dragging) return;
    try {
      saveBrowserStorageValue("wollipog.shelldock.height", String(height));
    } catch {
      /* best-effort */
    }
  }, [height, dragging]);

  // Track the viewport-aware ceiling as STATE: the rendered height and the separator's ARIA
  // range both re-derive from it, and the height PREFERENCE is left untouched (a shrink while
  // collapsed must not overwrite the user's restore size).
  useEffect(() => {
    const onWinResize = () => setViewportMax(viewportDockMax());
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, []);

  // Pointer capture lets a drag travel over the transcript/composer — suppress text selection
  // and keep the resize cursor across the whole app through the shared drag state.
  useEffect(() => {
    document.body.classList.toggle("shell-dock-dragging", dragging);
    return () => document.body.classList.remove("shell-dock-dragging");
  }, [dragging]);

  // What actually renders: the preference clamped to the live viewport ceiling. Gestures start
  // from THIS (what the user sees), and only gestures write the preference back.
  const effectiveHeight = clampDockHeight(height, viewportMax);

  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { startY: e.clientY, startHeight: effectiveHeight };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable — drag still works while over the handle */
    }
    setDragging(true);
  };
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (e.buttons === 0) {
      dragRef.current = null;
      setDragging(false);
      return;
    }
    setHeight(resolveDockDrag(d.startHeight, e.clientY - d.startY, viewportMax).height);
  };
  const onGripUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDragging(false);
    const r = resolveDockDrag(d.startHeight, e.clientY - d.startY, viewportMax);
    if (r.collapse) {
      onClose(); // snap-hide the dock; reopening restores the pre-drag size
      setHeight(d.startHeight);
    } else {
      setHeight(r.height);
    }
  };
  const onGripLostCapture = () => {
    dragRef.current = null;
    setDragging(false);
  };

  if (!host) return null;
  const { terminals, active, busy, searchOpen } = host;

  return (
    <div ref={toastLayoutRef} className={`shell-dock${dragging ? " is-dragging" : ""}`} role="region" aria-label="Terminal">
      <div
        className="shell-dock-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize Terminal"
        aria-valuemin={DOCK_MIN_HEIGHT}
        aria-valuemax={clampDockHeight(Number.MAX_SAFE_INTEGER, viewportMax)}
        aria-valuenow={effectiveHeight}
        title="Drag to resize. Double-click or press Home to reset."
        tabIndex={0}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onLostPointerCapture={onGripLostCapture}
        onKeyDown={(e) => {
          // Step from the VISIBLE height — stepping from a taller off-screen preference
          // would make the first ArrowUp jump instead of grow by one step.
          if (e.key === "ArrowUp") setHeight(clampDockHeight(effectiveHeight + 16, viewportMax));
          else if (e.key === "ArrowDown") setHeight(clampDockHeight(effectiveHeight - 16, viewportMax));
          else if (e.key === "Home") setHeight(clampDockHeight(DOCK_DEFAULT_HEIGHT, viewportMax));
          else return;
          e.preventDefault();
        }}
        onDoubleClick={() => setHeight(clampDockHeight(DOCK_DEFAULT_HEIGHT, viewportMax))}
      />
      <div className="shell-dock-head">
        <TerminalTabs
          tabsetId={tabsetId}
          panelId={`${tabsetId}-panel`}
          tabs={host.tabs}
          activeId={active}
          onSelect={terminals.select}
          onClose={host.closeShell}
        />
        {/* On a touch phone a focused field (the shell, search) is the keyboard, and its blur would bring
            the tab bar back and move the sheet between press and click: these controls keep it focused
            until the click lands (#2866). A tab still takes focus, so none stays in a hidden terminal. */}
        <div className="shell-dock-tools" onMouseDown={holdFieldFocus}>
          {phone ? (
            <TerminalSearchButton
              disabled={!active}
              pressed={searchOpen}
              onClick={searchOpen ? host.closeSearch : terminals.openSearch}
            />
          ) : searchOpen ? (
            <TerminalSearchControls {...host.searchControls} />
          ) : (
            <TerminalSearchButton disabled={!active} onClick={terminals.openSearch} />
          )}
          <TerminalNewTab
            id={`${tabsetId}-new`}
            kinds={host.newTabKinds}
            busy={busy}
            disabledReason={host.offlineReason}
          />
          <button
            id={`${tabsetId}-hide`}
            type="button"
            className="icon-btn sm"
            onClick={onClose}
            title={`${coarsePointer ? "Hide Terminal" : `Hide Terminal (${shortcutDisplay("toggle-terminal")})`}\nShells keep running.`}
            aria-label="Hide Terminal"
            aria-keyshortcuts={shortcutAriaKeys("toggle-terminal")}
          >
            <ChevronDownIcon size={14} />
          </button>
        </div>
      </div>
      {phone && searchOpen && (
        <div className="dock-search-row" onMouseDown={holdFieldFocus}>
          <TerminalSearchControls {...host.searchControls} />
        </div>
      )}

      <div
        className="shell-dock-body"
        id={`${tabsetId}-panel`}
        role="tabpanel"
        aria-labelledby={active ? `${tabsetId}-tab-${encodeURIComponent(active)}` : undefined}
        // The body's height on desktop; on a phone the terminal's, so a notice grows the sheet (#2866).
        style={{ "--dock-body-height": `${effectiveHeight}px` } as CSSProperties}
      >
        <TerminalSurface host={host} theme={theme} scheme={scheme} />
      </div>
    </div>
  );
}
