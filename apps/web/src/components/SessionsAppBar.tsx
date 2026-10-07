import React, { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { flushSync } from "react-dom";
import type { InboxSplit, InboxSplitKey } from "../inbox.js";
import type { ReminderInboxMode } from "../session-reminders.js";
import { sessionGroupAttentionWords, sessionGroupFullName, type SessionGroupLabel } from "../session-groups.js";
import type { SessionsViewMode } from "../sessions-view-mode.js";
import { windowDragRegion } from "../desktop-window.js";
import { CountBadge } from "./CountBadge.js";
import { ChevronDownIcon, MoreHorizontalIcon, PlusIcon, SearchIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "./Menu.js";
import {
  ProjectMenuItems,
  useProjectSplitActions,
  type ProjectSplitActions,
  type ProjectSplitActionsProps,
} from "./ProjectSplitMenu.js";
import { SessionGroupMenuItem, SessionGroupName } from "./SessionGroupTabs.js";
import { SessionsSearchField } from "./SessionsSearch.js";

/**
 * The phone Sessions app bar (#2211, docs/design-system.md §15.1): one 48px bar in place of the
 * page header, its action row and the group tabs. The title is the group picker, which opens the
 * Session Groups sheet (more than four tabs become a picker, §10.1); then Search, which swaps the
 * bar for a full-width search field and Cancel; ⋯, a sheet with View, Show, New Project… and the
 * current project's actions; and New Session as the 44px `+`. While Snoozed is on, a strip under the
 * bar says so and offers Show Active.
 */

export interface SessionsAppBarProps {
  /** The page's name: the visually hidden `h1`, which the shell's focus rescue lands on. */
  title: string;
  /** Every group, with counts that follow a search (#2200). */
  splits: readonly InboxSplit[];
  labels: ReadonlyMap<InboxSplitKey, SessionGroupLabel>;
  activeKey: InboxSplitKey;
  /** The Snoozed view: counts are snoozed sessions and no attention badge is drawn. */
  snoozed: boolean;
  onSelectGroup: (key: InboxSplitKey) => void;
  search: {
    /** Search mode: the bar is the field and Cancel. */
    open: boolean;
    query: string;
    onOpen: () => void;
    onChange: (value: string) => void;
    /** Clears the query and restores the bar. */
    onCancel: () => void;
  };
  /** New Session's key, announced though its keycap is not drawn on the 44px `+` (§11.5). */
  newSessionShortcut?: string;
  viewMode: SessionsViewMode;
  onViewModeChange: (mode: SessionsViewMode) => void;
  /** The Show group; null where this connection has no reminders. */
  reminders: { snoozedCount: number; onModeChange: (mode: ReminderInboxMode) => void } | null;
  /** Why New Project is unavailable, or null when it is. */
  newProjectUnavailableReason: string | null;
  onNewProject: () => void;
  /** The current group's project actions (#2199), or null for All and No Project. */
  projectActions: ProjectSplitActionsProps | null;
  onNewSession: () => void;
}

const labelFor = (labels: ReadonlyMap<InboxSplitKey, SessionGroupLabel>, split: InboxSplit): SessionGroupLabel =>
  labels.get(split.key) ?? { name: split.name };

/** The bar's title: the current group, a caret and its attention badges; it opens Session Groups. */
function GroupPicker({ splits, labels, activeKey, snoozed, onSelectGroup }: Pick<SessionsAppBarProps,
  "splits" | "labels" | "activeKey" | "snoozed" | "onSelectGroup">) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "session-groups-sheet");
  const active = splits.find((split) => split.key === activeKey) ?? splits[0];
  if (!active) return <span className="sessions-group-picker" />;
  const label = labelFor(labels, active);
  const attention = snoozed ? "" : sessionGroupAttentionWords(active);
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="sessions-group-picker"
        // The name may be cut short in the bar.
        title={sessionGroupFullName(label)}
        // The badges are aria-hidden, so the attention joins the name in words.
        aria-label={[sessionGroupFullName(label), attention].filter(Boolean).join(", ")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <SessionGroupName label={label} />
        <ChevronDownIcon size={16} className="sessions-group-picker-caret" />
        {!snoozed && (
          <>
            <CountBadge count={active.blockedCount} />
            <CountBadge count={active.stalledCount} tone="danger" />
          </>
        )}
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Session Groups"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {splits.map((split) => (
            <SessionGroupMenuItem
              key={split.key ?? "all"}
              split={split}
              label={labelFor(labels, split)}
              current={split.key === activeKey}
              snoozed={snoozed}
              onChoose={() => {
                menu.close(true);
                onSelectGroup(split.key);
              }}
            />
          ))}
        </MenuSurface>
      )}
    </>
  );
}

/** ⋯: View, Show, New Project… and the current project's actions under its name (§9.1). */
function MoreSheet({ open, setOpen, actions, viewMode, onViewModeChange, reminders, snoozed,
  newProjectUnavailableReason, onNewProject }: Pick<SessionsAppBarProps,
  "viewMode" | "onViewModeChange" | "reminders" | "snoozed" | "newProjectUnavailableReason" | "onNewProject"> & {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  actions: ProjectSplitActions | null;
}) {
  const menu = useAccessibleMenu(open, setOpen, "sessions-more-sheet");
  /** Choosing hands focus back to ⋯ before the action runs, so a dialog it opens snapshots ⋯ as
   * where focus returns, not the menu item that is going away. */
  const choose = (run: () => void, restoreFocus = true) => {
    menu.close(false);
    if (restoreFocus) menu.triggerRef.current?.focus();
    run();
  };
  const snoozedCount = reminders?.snoozedCount ?? 0;
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn"
        title="More Actions"
        aria-label="More Actions"
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
          label="More Actions"
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <div role="group" aria-label="View">
            <MenuLabel>View</MenuLabel>
            {(["list", "board"] as const).map((mode) => (
              <MenuItem
                key={mode}
                role="menuitemradio"
                checked={viewMode === mode}
                onClick={() => choose(() => onViewModeChange(mode))}
              >
                {mode === "list" ? "List" : "Board"}
              </MenuItem>
            ))}
          </div>
          {reminders && (
            <>
              <MenuSeparator />
              <div role="group" aria-label="Show">
                <MenuLabel>Show</MenuLabel>
                <MenuItem
                  role="menuitemradio"
                  checked={!snoozed}
                  onClick={() => choose(() => reminders.onModeChange("ordinary"))}
                >
                  Active Sessions
                </MenuItem>
                <MenuItem
                  role="menuitemradio"
                  checked={snoozed}
                  // The trailing slot is decorative, so the count joins the name in words.
                  aria-label={snoozedCount > 0 ? `Snoozed Sessions, ${snoozedCount}` : undefined}
                  trail={snoozedCount > 0 ? <span className="count">{snoozedCount}</span> : undefined}
                  onClick={() => choose(() => reminders.onModeChange("snoozed"))}
                >
                  Snoozed Sessions
                </MenuItem>
              </div>
            </>
          )}
          <MenuSeparator />
          <MenuItem
            disabled={newProjectUnavailableReason !== null}
            description={newProjectUnavailableReason ?? undefined}
            onClick={() => choose(onNewProject)}
          >
            New Project…
          </MenuItem>
          {actions && (
            <>
              <MenuSeparator />
              <div role="group" aria-label={actions.label}>
                <MenuLabel>{actions.name}</MenuLabel>
                <ProjectMenuItems groups={actions.groups} onChoose={(action) => choose(action.run, !action.navigates)} />
              </div>
            </>
          )}
        </MenuSurface>
      )}
    </>
  );
}

export function SessionsAppBar({
  title,
  splits,
  labels,
  activeKey,
  snoozed,
  onSelectGroup,
  search,
  viewMode,
  onViewModeChange,
  reminders,
  newProjectUnavailableReason,
  onNewProject,
  projectActions,
  onNewSession,
  newSessionShortcut,
}: SessionsAppBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const actions = useProjectSplitActions(projectActions && {
    ...projectActions,
    // The archive confirmation replaces the ⋯ sheet, and Back brings the sheet back (§7.5).
    confirmBack: { label: "Back to More Actions", run: () => setMoreOpen(true) },
  });
  const fieldRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  // Focus moves in the same task as the tap, so a phone raises its keyboard for the field.
  const openSearch = () => {
    flushSync(search.onOpen);
    fieldRef.current?.focus();
  };
  const cancelSearch = () => {
    flushSync(search.onCancel);
    searchButtonRef.current?.focus();
  };
  const more = (
    <MoreSheet
      open={moreOpen}
      setOpen={setMoreOpen}
      actions={actions}
      viewMode={viewMode}
      onViewModeChange={onViewModeChange}
      reminders={reminders}
      snoozed={snoozed}
      newProjectUnavailableReason={newProjectUnavailableReason}
      onNewProject={onNewProject}
    />
  );
  const bar = search.open ? (
    <div className="page-header-row sessions-app-bar-search">
      <SessionsSearchField
        ref={fieldRef}
        value={search.query}
        onChange={search.onChange}
        onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          cancelSearch();
        }}
      />
      <button type="button" className="btn ghost" onClick={cancelSearch}>Cancel</button>
    </div>
  ) : (
    <div className="page-header-row">
      <GroupPicker splits={splits} labels={labels} activeKey={activeKey} snoozed={snoozed} onSelectGroup={onSelectGroup} />
      <div className="page-actions">
        <button
          ref={searchButtonRef}
          type="button"
          className="icon-btn"
          title="Search Sessions"
          aria-label="Search Sessions"
          onClick={openSearch}
        >
          <SearchIcon />
        </button>
        {more}
        <button type="button" className="btn primary page-primary" aria-keyshortcuts={newSessionShortcut} onClick={onNewSession}>
          <PlusIcon />
          <span className="page-primary-label">New Session</span>
        </button>
      </div>
    </div>
  );
  return (
    <header ref={headerRef} className="page-header sessions-app-bar" {...windowDragRegion()}>
      <h1 id="page-title" className="sr-only" tabIndex={-1}>{title}</h1>
      {bar}
      {actions?.dialogs}
      {snoozed && (
        <div className="sessions-snoozed-strip">
          <span>Showing snoozed sessions.</span>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              // The strip leaves with Snoozed, so focus moves to the group picker rather than <body>.
              flushSync(() => reminders?.onModeChange("ordinary"));
              headerRef.current?.querySelector<HTMLElement>(".sessions-group-picker")?.focus();
            }}
          >
            Show Active
          </button>
        </div>
      )}
    </header>
  );
}
