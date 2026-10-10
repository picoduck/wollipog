import React, { useEffect, useRef, useState } from "react";
import {
  terminalSearchCountLabel,
  type ShellTabView,
  type TerminalSearchResults,
} from "../shells-panel.js";
import { statusMeta } from "../status-meta.js";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, PlusIcon, SearchIcon } from "./Icons.js";
import { handleRovingChoiceKeyDown, useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { StatusBadge } from "./StatusBadge.js";
import { TabList } from "./Tabs.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * The terminal head's controls (#2864; docs/design-system.md §4.6): the shell tabs, Search Output and
 * New Tab. They hold no placement logic, so the bottom dock and the right panel's Terminal tool render
 * the same controls, each in its own head.
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

/**
 * Search Output (#2864, refs #1265): an icon button that opens, in the head, a field with the match
 * count, Previous Match, Next Match and Close Search. Enter goes to the next match, Shift+Enter to the
 * previous, and Escape closes search; the host returns focus to its terminal. There is no global key:
 * Ctrl+F stays the shell's own key inside the terminal.
 */
export function TerminalSearch({
  open,
  term,
  results,
  disabled = false,
  onOpen,
  onTermChange,
  onNext,
  onPrevious,
  onClose,
}: {
  open: boolean;
  term: string;
  /** The addon's counts for `term`; null before the first count arrives. */
  results: TerminalSearchResults | null;
  /** No terminal to search (no tab open). */
  disabled?: boolean;
  onOpen: () => void;
  onTermChange: (term: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) inputRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        className="icon-btn sm"
        aria-label="Search Output"
        title="Search Output"
        disabled={disabled}
        onClick={onOpen}
      >
        <SearchIcon size={14} />
      </button>
    );
  }
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
export function TerminalNewTab({ id, kinds, busy, disabledReason }: {
  /** The button's id, so a host can return focus to it. */
  id: string;
  kinds: readonly TerminalTabKind[];
  busy: boolean;
  /** Why nothing can open at all (the machine is offline); only used without a menu. */
  disabledReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "terminal-new-tab", "item", { reachUnavailable: true });
  const single = kinds.length === 1 ? kinds[0] : null;

  if (single) {
    return (
      <BusyButton
        id={id}
        className="icon-btn sm"
        icon={<PlusIcon size={14} />}
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
        className="icon-btn sm"
        icon={<PlusIcon size={14} />}
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
