import React, { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { InboxSplit, InboxSplitKey } from "../inbox.js";
import {
  SESSION_GROUP_TAB_HINT,
  sessionGroupAttentionWords,
  sessionGroupFullName,
  sessionGroupSummary,
  type SessionGroupLabel,
} from "../session-groups.js";
import { CountBadge } from "./CountBadge.js";
import { ChevronDownIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { TabList } from "./Tabs.js";

/**
 * The Sessions group tabs (#2180): a full-width tab bar in the page header's tab slot (§4.2,
 * §10.1). The tab row, then All Groups, then `.tabs-tools` for the row's trailing tools.
 */

const labelFor = (labels: ReadonlyMap<InboxSplitKey, SessionGroupLabel>, split: InboxSplit): SessionGroupLabel =>
  labels.get(split.key) ?? { name: split.name };

/** The name, capped by its container, with a shared name's machine as quiet text after it. */
export function SessionGroupName({ label }: { label: SessionGroupLabel }) {
  return (
    <span className="group-name">
      {label.name}
      {label.machine && <span className="group-name-machine"> on {label.machine}</span>}
    </span>
  );
}

/**
 * Attention counts as count badges (§10.1, §11.4): amber for blocked, red for stalled. The badges
 * are aria-hidden, so the owner says them in words. The Snoozed view draws none.
 */
function GroupBadges({ split, snoozed }: { split: InboxSplit; snoozed: boolean }) {
  if (snoozed) return null;
  return (
    <>
      <CountBadge count={split.blockedCount} />
      <CountBadge count={split.stalledCount} tone="danger" />
    </>
  );
}

/** One group as a menu row: the name, the plain count and the badges, checked when current (§9.1). */
export function SessionGroupMenuItem({
  split,
  label,
  current,
  snoozed,
  onChoose,
}: {
  split: InboxSplit;
  label: SessionGroupLabel;
  current: boolean;
  snoozed: boolean;
  onChoose: () => void;
}) {
  const name = sessionGroupFullName(label);
  const attention = snoozed ? "" : sessionGroupAttentionWords(split);
  return (
    <MenuItem
      role="menuitemradio"
      checked={current}
      title={name}
      data-menu-label={name}
      // The trailing slot is decorative, so the counts join the name in words.
      aria-label={[name, String(split.count), attention].filter(Boolean).join(", ")}
      trail={<><span className="count">{split.count}</span><GroupBadges split={split} snoozed={snoozed} /></>}
      onClick={onChoose}
    >
      <SessionGroupName label={label} />
    </MenuItem>
  );
}

/** Every group in tab order, for when the tab row overflows (§9.1). */
export function AllGroupsMenu({
  splits,
  labels,
  activeKey,
  snoozed,
  onSelect,
}: {
  splits: readonly InboxSplit[];
  labels: ReadonlyMap<InboxSplitKey, SessionGroupLabel>;
  activeKey: InboxSplitKey;
  snoozed: boolean;
  onSelect: (key: InboxSplitKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "all-groups-menu");
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn sm tabs-all"
        title="All Groups"
        aria-label="All Groups"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <ChevronDownIcon />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="All Groups"
          align="end"
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
                menu.close(false);
                menu.triggerRef.current?.focus();
                // The tab row scrolls the newly selected tab into view.
                onSelect(split.key);
              }}
            />
          ))}
        </MenuSurface>
      )}
    </>
  );
}

export function SessionGroupTabs({
  splits,
  labels,
  activeKey,
  snoozed,
  onSelect,
  onTabKeyDown,
  tabRef,
  tabMenu,
  tools,
}: {
  splits: readonly InboxSplit[];
  labels: ReadonlyMap<InboxSplitKey, SessionGroupLabel>;
  activeKey: InboxSplitKey;
  /** The Snoozed view: tabs count snoozed sessions and draw no attention badges. */
  snoozed: boolean;
  onSelect: (key: InboxSplitKey) => void;
  onTabKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, key: InboxSplitKey) => void;
  tabRef: (key: InboxSplitKey, node: HTMLButtonElement | null) => void;
  /** A group's actions, drawn beside its tab. */
  tabMenu?: (split: InboxSplit, active: boolean) => ReactNode;
  /** The row's trailing tools (search, filters). */
  tools?: ReactNode;
}) {
  return (
    <div className="tabs-bar">
      <TabList label="Session Groups">
        {splits.map((split) => {
          const active = split.key === activeKey;
          const label = labelFor(labels, split);
          const attention = snoozed ? "" : sessionGroupAttentionWords(split);
          const menu = tabMenu?.(split, active);
          return (
            <div className="inbox-tab-group" role="presentation" key={split.key ?? "all"}>
              <button
                type="button"
                ref={(node) => tabRef(split.key, node)}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className="tab"
                onClick={() => onSelect(split.key)}
                onKeyDown={(event) => onTabKeyDown(event, split.key)}
                // The full name (the label may be cut short), the counts, then the shortcut.
                title={[sessionGroupFullName(label), sessionGroupSummary(split, snoozed), SESSION_GROUP_TAB_HINT].join("\n")}
              >
                <SessionGroupName label={label} />
                <span className="count">{split.count}</span>
                <GroupBadges split={split} snoozed={snoozed} />
                {attention && <span className="sr-only">, {attention}</span>}
              </button>
              {menu}
            </div>
          );
        })}
      </TabList>
      <AllGroupsMenu splits={splits} labels={labels} activeKey={activeKey} snoozed={snoozed} onSelect={onSelect} />
      {tools && <div className="tabs-tools">{tools}</div>}
    </div>
  );
}
