import type { Ref } from "react";
import { shortcutAriaKeys, shortcutDisplay } from "../shortcuts.js";
import { CommandLineIcon, InfoIcon, PanelRightIcon } from "./Icons.js";
import { useIsCoarsePointer } from "./useIsMobile.js";

/** The Terminal toggle's tooltip and description while its runner predates session shells. */
export const TERMINAL_UPDATE_NOTE = "Update the runner to use the terminal.";
const TERMINAL_UPDATE_NOTE_ID = "session-terminal-update-note";

export interface SessionPanelTogglesProps {
  /** The phone app bar's small controls. */
  small: boolean;
  pinnedSummaryOpen: boolean;
  pinnedSummaryRef?: Ref<HTMLButtonElement>;
  onPinnedSummary: () => void;
  /** False while the session's runner predates session shells: the toggle opens the launcher. */
  terminalSupported: boolean;
  terminalOpen: boolean;
  onTerminal: () => void;
  sidePanelOpen: boolean;
  onSidePanel: () => void;
}

/**
 * The session bar's panel toggles (docs/design-system.md §3.1): one name each in both states, with
 * `aria-pressed` carrying the state and a glyph that matches the panel it opens. Each tooltip repeats
 * the name, with the chord on a fine pointer where a shortcut exists (§11.5).
 */
export function SessionPanelToggles({
  small,
  pinnedSummaryOpen,
  pinnedSummaryRef,
  onPinnedSummary,
  terminalSupported,
  terminalOpen,
  onTerminal,
  sidePanelOpen,
  onSidePanel,
}: SessionPanelTogglesProps) {
  const coarsePointer = useIsCoarsePointer();
  const className = small ? "icon-btn sm" : "icon-btn";
  return (
    <div className="panel-toggles" role="group" aria-label="Panels">
      <button
        type="button"
        className={className}
        ref={pinnedSummaryRef}
        onClick={onPinnedSummary}
        title="Pinned Summary"
        aria-label="Pinned Summary"
        aria-pressed={pinnedSummaryOpen}
      >
        <InfoIcon size={16} />
      </button>
      <button
        type="button"
        className={className}
        onClick={onTerminal}
        title={!terminalSupported
          ? TERMINAL_UPDATE_NOTE
          : coarsePointer ? "Terminal" : `Terminal (${shortcutDisplay("toggle-terminal")})`}
        aria-label="Terminal"
        aria-describedby={terminalSupported ? undefined : TERMINAL_UPDATE_NOTE_ID}
        aria-keyshortcuts={terminalSupported ? shortcutAriaKeys("toggle-terminal") : undefined}
        aria-pressed={terminalSupported && terminalOpen}
      >
        <CommandLineIcon size={16} />
      </button>
      {!terminalSupported && <span id={TERMINAL_UPDATE_NOTE_ID} hidden>{TERMINAL_UPDATE_NOTE}</span>}
      <button
        type="button"
        className={className}
        onClick={onSidePanel}
        title="Side Panel"
        aria-label="Side Panel"
        aria-pressed={sidePanelOpen}
      >
        <PanelRightIcon size={16} />
      </button>
    </div>
  );
}
