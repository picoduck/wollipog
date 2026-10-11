import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  terminalSearchCountLabel,
  type ShellTabView,
  type TerminalSearchResults,
} from "../shells-panel.js";
import { statusMeta } from "../status-meta.js";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, MoreHorizontalIcon, PlusIcon, SearchIcon } from "./Icons.js";
import { handleRovingChoiceKeyDown, useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { StatusBadge } from "./StatusBadge.js";
import { TabList } from "./Tabs.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * The terminal head's controls (#2864; docs/design-system.md §4.6): the shell tabs, Search Output,
 * New Tab and More Terminal Actions. They hold no placement logic, so the bottom dock and the right
 * panel's Terminal tool render the same controls, each in its own head, and each passes the move to
 * the other place as its More Terminal Actions item.
 */

/** The id of one terminal tab, which its tab panel names in `aria-labelledby`. */
export function terminalTabId(tabsetId: string, shellId: string): string {
  return `${tabsetId}-tab-${encodeURIComponent(shellId)}`;
}

/**
 * The shell tabs (§10.1): "Shell 1" then the working folder's name in --text-dim, with the full
 * directory as the tooltip, and an inline Exited or Reconnecting status. Each tab's Close follows it,
 * outside the tab, shown on hover, focus and the selected tab with a fine pointer and only on the
 * selected tab with touch.
 */
export function TerminalTabs({ tabsetId, panelId, tabs, activeId, onSelect, onClose }: {
  tabsetId: string;
  panelId: string;
  tabs: readonly ShellTabView[];
  activeId: string | null;
  onSelect: (shellId: string) => void;
  onClose: (shellId: string) => void;
}) {
  return (
    <TabList
      label="Terminal Tabs"
      className="shell-tabs"
      onKeyDown={(event) => handleRovingChoiceKeyDown(event, "tab")}
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        return (
          <span key={tab.id} className={selected ? "shell-tab is-active" : "shell-tab"} role="presentation">
            <button
              id={terminalTabId(tabsetId, tab.id)}
              type="button"
              role="tab"
              className="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              title={tab.folderPath ?? undefined}
              onClick={() => onSelect(tab.id)}
            >
              {tab.label}
              {tab.folder && <>{" "}<span className="shell-tab-folder">{tab.folder}</span></>}
              {tab.status && <>{" "}<StatusBadge meta={statusMeta("shell", tab.status)} inline /></>}
            </button>
            <button
              type="button"
              className="icon-btn sm shell-tab-close"
              aria-label={`Close ${tab.label}`}
              title={`Close ${tab.label}`}
              onClick={() => onClose(tab.id)}
            >
              <CloseIcon size={14} />
            </button>
          </span>
        );
      })}
    </TabList>
  );
}

interface TerminalSearchControlsProps {
  term: string;
  /** The addon's counts for `term`; null before the first count arrives. */
  results: TerminalSearchResults | null;
  onTermChange: (term: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

/**
 * Search Output (#2864, refs #1265): an icon button that opens, in the head, a field with the match
 * count, Previous Match, Next Match and Close Search. Enter goes to the next match, Shift+Enter to the
 * previous, and Escape closes search; the host returns focus to its terminal. There is no global key:
 * Ctrl+F stays the shell's own key inside the terminal.
 */
export function TerminalSearch({
  open,
  disabled = false,
  onOpen,
  ...controls
}: TerminalSearchControlsProps & {
  open: boolean;
  /** No terminal to search (no tab open). */
  disabled?: boolean;
  onOpen: () => void;
}) {
  const focus = useSearchFocus(open, "head");
  if (!open) return <TerminalSearchButton disabled={disabled} onClick={onOpen} />;
  return <TerminalSearchControls {...controls} autoFocus={focus.autoFocus} onFieldFocus={focus.onFieldFocus} />;
}

/**
 * Whether search controls mounting now take focus. Search opened while the host showed it puts the
 * caret in the field. A host mounted with search already open (the dock shown again, #2867) leaves
 * focus where it was. Controls that move to another `placement` while open (the phone dock's own row,
 * across the 760px breakpoint, #2866) take focus only if their field had it, so rotating a phone
 * neither drops the caret nor steals it from the terminal. The controls report their field's focus
 * through `onFieldFocus`.
 */
export function useSearchFocus(open: boolean, placement: string): {
  autoFocus: boolean;
  onFieldFocus: (focused: boolean) => void;
} {
  // The last committed state, read during render, so a render React repeats decides the same way.
  const committed = useRef<{ open: boolean; placement: string } | null>(null);
  const fieldFocused = useRef(false);
  useLayoutEffect(() => {
    committed.current = { open, placement };
    if (!open) fieldFocused.current = false;
  });
  const last = committed.current;
  const autoFocus = last !== null && open &&
    (!last.open || (last.placement !== placement && fieldFocused.current));
  const onFieldFocus = useRef((focused: boolean) => { fieldFocused.current = focused; }).current;
  return { autoFocus, onFieldFocus };
}

/**
 * A head's icon buttons: "sm" in the dock's 40px head (28px), "md" in the side panel's 48px header
 * (32px, #2868), each 44px on touch.
 */
export type TerminalHeadButtonSize = "sm" | "md";
const headButton = (size: TerminalHeadButtonSize) => ({
  className: size === "sm" ? "icon-btn sm" : "icon-btn",
  iconSize: size === "sm" ? 14 : 16,
});

/**
 * The Search Output button alone, for a host that shows the open search on a row of its own (the phone
 * dock, #2866, and the side panel's Terminal tool, #2868): there it stays in the head, pressed while
 * the row is open, and a press closes it.
 */
export function TerminalSearchButton({ disabled = false, pressed, size = "sm", onClick }: {
  disabled?: boolean;
  /** Set only by a host whose button stays while search is open. */
  pressed?: boolean;
  size?: TerminalHeadButtonSize;
  onClick: () => void;
}) {
  const { className, iconSize } = headButton(size);
  return (
    <button
      type="button"
      className={className}
      aria-label="Search Output"
      title="Search Output"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <SearchIcon size={iconSize} />
    </button>
  );
}

/**
 * The open search: the field, its match count, Previous Match, Next Match and Close Search. The field
 * takes focus when the controls appear unless `autoFocus` is false (`useSearchFocus` decides).
 */
export function TerminalSearchControls({
  term,
  results,
  onTermChange,
  onNext,
  onPrevious,
  onClose,
  autoFocus = true,
  onFieldFocus,
}: TerminalSearchControlsProps & {
  autoFocus?: boolean;
  /** Told when the field gains and loses focus (`useSearchFocus`). */
  onFieldFocus?: (focused: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const focusOnMount = useRef(autoFocus);
  useEffect(() => {
    if (focusOnMount.current) inputRef.current?.focus();
  }, []);

  const canStep = term !== "" && (results?.count ?? 0) > 0;
  return (
    <div
      className="shell-search"
      role="group"
      aria-label="Search Output"
      onKeyDown={(event) => {
        // Escape closes search from any of its controls, ahead of the app's Escape ladder, which
        // would otherwise leave the session.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <label className="input-affix shell-search-field">
        <span className="input-affix-text" aria-hidden="true"><SearchIcon size={14} /></span>
        <input
          ref={inputRef}
          type="text"
          value={term}
          aria-label="Search Output"
          placeholder="Search output"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onTermChange(event.target.value)}
          onFocus={() => onFieldFocus?.(true)}
          onBlur={() => onFieldFocus?.(false)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          }}
        />
      </label>
      <span className="shell-search-count" role="status">
        {term && results ? terminalSearchCountLabel(results) : ""}
      </span>
      <button
        type="button"
        className="icon-btn sm"
        aria-label="Previous Match"
        title="Previous Match (Shift+Enter)"
        disabled={!canStep}
        onClick={onPrevious}
      >
        <ChevronUpIcon size={14} />
      </button>
      <button
        type="button"
        className="icon-btn sm"
        aria-label="Next Match"
        title="Next Match (Enter)"
        disabled={!canStep}
        onClick={onNext}
      >
        <ChevronDownIcon size={14} />
      </button>
      <button type="button" className="icon-btn sm" aria-label="Close Search" title="Close Search" onClick={onClose}>
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

/** One kind of tab New Tab can open. An unavailable kind stays listed with its reason (§9.1). */
export interface TerminalTabKind {
  label: string;
  description?: string;
  unavailableReason?: string | null;
  open: () => void;
}

/**
 * New Tab: one icon button. With more than one kind of tab (a shell and the agent's own TUI) it opens
 * a menu above the head, so it covers the content over a bottom dock rather than the output under it
 * (below only when there is no room above), each item with its second line; with only a shell it
 * opens one directly. It is busy while a tab opens.
 */
export function TerminalNewTab({ id, kinds, busy, disabledReason, size = "sm" }: {
  /** The button's id, so a host can return focus to it. */
  id: string;
  kinds: readonly TerminalTabKind[];
  busy: boolean;
  /** Why nothing can open at all (the machine is offline); only used without a menu. */
  disabledReason?: string | null;
  size?: TerminalHeadButtonSize;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "terminal-new-tab", "item", { reachUnavailable: true });
  const single = kinds.length === 1 ? kinds[0] : null;
  const { className, iconSize } = headButton(size);

  if (single) {
    return (
      <BusyButton
        id={id}
        className={className}
        icon={<PlusIcon size={iconSize} />}
        busy={busy}
        progress="Opening a shell…"
        aria-label="New Tab"
        title={disabledReason ?? "New Tab"}
        disabled={Boolean(disabledReason)}
        onClick={single.open}
      >
        {null}
      </BusyButton>
    );
  }

  const choose = (kind: TerminalTabKind) => {
    // A menu opened before a tab started opening (the dock's automatic first shell) stays open, so it
    // refuses a second open while busy, as the busy trigger does.
    if (busy || kind.unavailableReason) return;
    menu.triggerRef.current?.focus();
    menu.close(false);
    kind.open();
  };
  return (
    <>
      <BusyButton
        id={id}
        ref={menu.triggerRef}
        className={className}
        icon={<PlusIcon size={iconSize} />}
        busy={busy}
        progress="Opening a tab…"
        aria-label="New Tab"
        title="New Tab"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={busy ? undefined : menu.onTriggerKeyDown}
      >
        {null}
      </BusyButton>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="New Tab"
          align="end"
          prefer="above"
          tabIndex={-1}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {kinds.map((kind) => (
            <MenuItem
              key={kind.label}
              data-menu-label={kind.label}
              aria-disabled={kind.unavailableReason ? true : undefined}
              description={kind.unavailableReason || kind.description}
              onClick={() => choose(kind)}
            >
              {kind.label}
            </MenuItem>
          ))}
        </MenuSurface>
      )}
    </>
  );
}

/** Each place's More Terminal Actions item: the move to the other place (§4.6). */
export interface TerminalMoveAction {
  label: string;
  icon: ReactNode;
  /** The item's second line (§9.1). */
  description: string;
  onChoose: () => void;
}

/**
 * More Terminal Actions (⋯, §9.1): one item, the move to the terminal's other place (Move to Right
 * Panel in the dock, #2869; Move to Bottom Dock in the panel's Terminal tool, #2868), with its second
 * line. From the dock's head it opens above, as New Tab does; on a phone it is a sheet.
 */
export function TerminalMoreActions({ id, size = "sm", prefer, action }: {
  /** The button's id, so a host can return focus to it. */
  id: string;
  size?: TerminalHeadButtonSize;
  prefer?: "below" | "above";
  action: TerminalMoveAction;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "terminal-more-actions", "item");
  const { className, iconSize } = headButton(size);
  return (
    <>
      <button
        id={id}
        ref={menu.triggerRef}
        type="button"
        className={className}
        aria-label="More Terminal Actions"
        title="More Terminal Actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <MoreHorizontalIcon size={iconSize} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="More Terminal Actions"
          align="end"
          prefer={prefer}
          tabIndex={-1}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuItem
            icon={action.icon}
            description={action.description}
            onClick={() => {
              menu.close(false);
              action.onChoose();
            }}
          >
            {action.label}
          </MenuItem>
        </MenuSurface>
      )}
    </>
  );
}
