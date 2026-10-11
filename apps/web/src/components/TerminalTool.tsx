import { useId, useState } from "react";
import { MoreHorizontalIcon, PanelBottomIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { PanelHeaderActions } from "./RightPanel.js";
import { TerminalNewTab, TerminalSearchButton, TerminalSearchControls, TerminalTabs, terminalTabId } from "./TerminalHead.js";
import { TerminalSurface, useTerminalHost } from "./TerminalSurface.js";
import { useOptionalTheme } from "./ThemeProvider.js";
import { holdFieldFocus } from "./requests/hold-field-focus.js";

export const MOVE_TO_BOTTOM_DOCK_DESCRIPTION =
  "Show the terminal in the dock below the conversation on this device. Running shells keep running.";

/**
 * The side panel's Terminal tool (#2868; docs/design-system.md §4.6, §4.9), shown while this device
 * places the terminal in the right panel. It hosts the session's terminals (`useTerminalHost`) as the
 * bottom dock does, with the same tabs, search and surface, laid out on the panel's frame:
 *
 * - Header actions: Search Output (pressed while the search row is open), New Tab, and More Terminal
 *   Actions, whose one item is Move to Bottom Dock. The frame adds Expand Panel and Close Panel, and
 *   closing keeps every shell running, as Hide Terminal does.
 * - Body (`.rpanel-body.term-host`, on --terminal-bg): the 40px tab strip (48px on touch), the open
 *   search on its own row under it at every width, then the terminal surface, which refits to the
 *   panel as it is dragged, expanded or overlaid.
 *
 * Escape typed into a shell stays with the shell (the panel ignores Escape from `.xterm`).
 */
export function TerminalTool({ sessionId, onMoveToDock }: {
  sessionId: string;
  /** Move to Bottom Dock: writes the placement, closes the panel and opens the dock. */
  onMoveToDock: () => void;
}) {
  const tabsetId = `terminal-tool-${useId().replace(/:/g, "")}`;
  const theme = useOptionalTheme();
  const host = useTerminalHost(sessionId, tabsetId, {
    searchPlacement: "row",
    fallbackFocusIds: [`${tabsetId}-new`, `${tabsetId}-more`],
  });
  if (!host) return null;
  const { terminals, active, busy, searchOpen, tabs } = host;

  return (
    <>
      <PanelHeaderActions>
        {/* On a touch phone a focused field (the shell, search) is the keyboard; these keep it focused
            until a tap lands, so the returning tab bar never moves the sheet under the finger. */}
        <span className="term-tool-actions" onMouseDown={holdFieldFocus}>
          <TerminalSearchButton
            size="md"
            disabled={!active}
            pressed={searchOpen}
            onClick={searchOpen ? host.closeSearch : terminals.openSearch}
          />
          <TerminalNewTab
            id={`${tabsetId}-new`}
            size="md"
            kinds={host.newTabKinds}
            busy={busy}
            disabledReason={host.offlineReason}
          />
          <MoreTerminalActions id={`${tabsetId}-more`} onMoveToDock={onMoveToDock} />
        </span>
      </PanelHeaderActions>
      {tabs.length > 0 && (
        <div className="term-tabs">
          <TerminalTabs
            tabsetId={tabsetId}
            panelId={`${tabsetId}-panel`}
            tabs={tabs}
            activeId={active}
            onSelect={terminals.select}
            onClose={host.closeShell}
          />
        </div>
      )}
      {searchOpen && (
        <div className="rpanel-toolbar term-search" onMouseDown={holdFieldFocus}>
          <TerminalSearchControls {...host.searchControls} />
        </div>
      )}
      <div
        className="term-body"
        id={`${tabsetId}-panel`}
        role="tabpanel"
        aria-labelledby={active ? terminalTabId(tabsetId, active) : undefined}
      >
        <TerminalSurface host={host} theme={theme?.resolved ?? "dark"} scheme={theme?.scheme ?? ""} />
      </div>
    </>
  );
}

/** More Terminal Actions (⋯, §9.1): Move to Bottom Dock, with its second line. A sheet on a phone. */
function MoreTerminalActions({ id, onMoveToDock }: { id: string; onMoveToDock: () => void }) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "terminal-more-actions", "item");
  return (
    <>
      <button
        id={id}
        ref={menu.triggerRef}
        type="button"
        className="icon-btn"
        aria-label="More Terminal Actions"
        title="More Terminal Actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <MoreHorizontalIcon />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="More Terminal Actions"
          align="end"
          tabIndex={-1}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuItem
            icon={<PanelBottomIcon />}
            description={MOVE_TO_BOTTOM_DOCK_DESCRIPTION}
            onClick={() => {
              menu.close(false);
              onMoveToDock();
            }}
          >
            Move to Bottom Dock
          </MenuItem>
        </MenuSurface>
      )}
    </>
  );
}
