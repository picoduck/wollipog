import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { View } from "../navigation.js";
import { GLOBAL_VIEW_ITEMS, viewPath, type DestinationGroup, type GlobalViewItem, type GlobalViewName } from "../navigation.js";
import {
  ArchiveIcon,
  AutomationsIcon,
  CloseIcon,
  ConnectionsIcon,
  InboxIcon,
  MoreHorizontalIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PodsIcon,
  ProjectsIcon,
  RunsIcon,
  SearchIcon,
  SettingsIcon,
  SkillsIcon,
  UsageIcon,
} from "./Icons.js";
import { useRailTooltip } from "./RailTooltip.js";
import { shortcutAriaKeys, shortcutDisplay } from "../shortcuts.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuSeparator, MenuSurface } from "./Menu.js";
import { useIsMobile, useIsShortViewport } from "./useIsMobile.js";
import { useExperiments } from "../use-experiments.js";
import { useInstanceScope } from "../instance-scope.js";
import { sessionsDestination } from "../sessions-view-mode.js";
import { phoneBarViews, railDigits, setRailLabels, visibleRailViews } from "../rail-preferences.js";
import { useRailPreferences } from "../use-rail-preferences.js";
import { NO_MACHINE_ATTENTION, railAttention, type MachineAttention, type RailAttention } from "../rail-attention.js";
import { CountBadge } from "./CountBadge.js";

/** Shared with Settings → Appearance → Navigation, whose rows show the same glyphs (#385). */
export const VIEW_ICONS: Record<GlobalViewName, (props: { size?: number; className?: string }) => ReactNode> = {
  inbox: InboxIcon,
  projects: ProjectsIcon,
  runs: RunsIcon,
  pods: PodsIcon,
  automations: AutomationsIcon,
  usage: UsageIcon,
  runners: ConnectionsIcon,
  archived: ArchiveIcon,
  skills: SkillsIcon,
};

/** §4.1: the desktop rail's 20px outline glyphs. */
export const RAIL_ICON_SIZE = 20;
/** A phone tab's icon sits over its label (docs/design-system.md §15.1). */
const TAB_ICON_SIZE = 24;
/** More sheet rows are 48px with 20px icons (#1959). */
const SHEET_ICON_SIZE = 20;

/**
 * What follows an item's icon (#1968). In the labelled rail: the name, its attention inline after
 * it, and the keycap at the trailing edge, shown on hover or keyboard focus. The 64px rail puts the
 * attention on the icon's corner instead, and its tooltip carries the name and the keycap.
 */
export function RailItemText({
  labelled,
  name,
  keys,
  children,
}: {
  labelled: boolean;
  name: string;
  keys?: string | null;
  children?: ReactNode;
}) {
  if (!labelled) return <>{children}</>;
  return (
    <>
      <span className="rail-item-label">{name}</span>
      {children}
      {keys && <kbd className="rail-item-keys" aria-hidden="true">{keys}</kbd>}
    </>
  );
}

/**
 * A destination's one attention mark (§11.4, #1967): a count through the shared `CountBadge`, or
 * the 8px warning dot that says a machine needs the user. `onIcon` sets either on the icon's
 * top-right shoulder; otherwise it sits inline. Hidden from assistive technology: the item states
 * the same thing as its description.
 */
export function AttentionMark({ attention, onIcon = false }: { attention: RailAttention | null; onIcon?: boolean }) {
  if (!attention) return null;
  if (attention.kind === "count") return <CountBadge count={attention.count} tone={attention.tone} onIcon={onIcon} />;
  return <span className={onIcon ? "rail-attention-dot t-warning on-icon" : "rail-attention-dot t-warning"} aria-hidden="true" />;
}

/** The desktop rail's Search item: first in the Work group, and not a destination. */
type RailEntry = GlobalViewItem | "search";

function entryGroup(entry: RailEntry): DestinationGroup {
  return entry === "search" ? "work" : entry.group;
}

/**
 * Which entries a group separator precedes (§4.1). A hairline is drawn between neighbours of
 * different groups only while every group's entries are contiguous: a saved order that interleaves
 * groups has no groups left to separate, so it renders as one run with no separators at all.
 */
export function railSeparatorsBefore(groups: readonly DestinationGroup[]): boolean[] {
  const closed = new Set<DestinationGroup>();
  for (const [index, group] of groups.entries()) {
    const previous = groups[index - 1];
    if (previous === undefined || previous === group) continue;
    closed.add(previous);
    if (closed.has(group)) return groups.map(() => false);
  }
  return groups.map((group, index) => index > 0 && groups[index - 1] !== group);
}

function selectedRailView(view: View): GlobalViewName | null {
  // Board mode and an expanded session are both the Sessions destination.
  if (view.name === "session" || view.name === "board") return "inbox";
  if (view.name === "run") return "runs";
  if (view.name === "pod") return "pods";
  return GLOBAL_VIEW_ITEMS.some((item) => item.id === view.name) ? view.name as GlobalViewName : null;
}

export function Rail({
  view,
  blockedCount,
  stalledCount,
  machines = NO_MACHINE_ATTENTION,
  onNavigate,
  instanceControl,
  settingsControl,
  onSearch,
}: {
  view: View;
  blockedCount: number;
  stalledCount: number;
  /** Machines that need the user; Connections shows a dot while any does (#1967). */
  machines?: MachineAttention;
  onNavigate: (view: View) => void;
  /** Desktop app only: the current instance's tile, drawn in the brand's place at the top. */
  instanceControl?: ReactNode;
  /** Desktop only. On a phone Settings is a row in the More sheet (see the note by .rail-spacer). */
  settingsControl?: ReactNode;
  /** Desktop only: opens the command palette, as Ctrl/Cmd+K does. */
  onSearch?: () => void;
}) {
  const selected = selectedRailView(view);
  const instanceScope = useInstanceScope();
  // Read at activation time, not render time: the persisted mode may have changed since mount.
  const sessionsViewDestination = () => sessionsDestination(instanceScope);
  // Settings rides in the sheet on a phone but is deliberately absent from GLOBAL_VIEW_ITEMS: that
  // array numbers the desktop rail AND its bare-digit shortcuts, so adding an entry would rebind
  // every later destination and render a second Settings row beside the gear (see navigation.ts).
  // It is therefore tracked on its own rather than through selectedRailView.
  const settingsSelected = view.name === "settings";
  const isMobile = useIsMobile();
  const isShort = useIsShortViewport();
  const [moreOpen, setMoreOpen] = useState(false);
  // A tap opens the sheet focused on itself, so no row is ringed or filled; arrow keys still rove.
  const more = useAccessibleMenu(moreOpen, setMoreOpen, "rail-more-menu", "menu");

  // Leaving the phone breakpoint empties overflowItems but leaves moreOpen true, so returning to
  // mobile remounted the sheet and its backdrop with focus still on <body> — roving keys dead until
  // a pointer dismissal. Rotating a phone into landscape above 760px and back did exactly that.
  // Tracked continuously, because by the time any effect runs after a breakpoint change the mobile
  // subtree is already unmounted and document.activeElement is <body>. Reading focus ownership at
  // that point always reported "outside", so the handoff below never ran and the next Tab restarted
  // at the top of the document.
  const focusInsideRailRef = useRef(false);
  useEffect(() => {
    const track = () => {
      const active = document.activeElement;
      if (active && active !== document.body) {
        // The sheet is portalled to <body>, so it is found by its menu id, not inside the rail.
        focusInsideRailRef.current = active.closest?.('.rail-more, [id^="rail-more-menu-"]') != null;
      }
    };
    document.addEventListener("focusin", track);
    track();
    return () => document.removeEventListener("focusin", track);
  }, []);

  useLayoutEffect(() => {
    if (isMobile) return;
    // Both the focused sheet item and the trigger are removed on this crossing, so the menu
    // controller has no survivor to restore to. Hand focus to the rail's current destination,
    // which exists on both sides. This also covers a focused CLOSED trigger, which the previous
    // version skipped because it required moreOpen.
    // Close unconditionally: an open More whose focus had moved elsewhere (a toast action, an
    // assistive-technology jump) stayed open across the crossing and its sheet and backdrop
    // reappeared on the way back down. Only the focus handoff is conditional.
    const hadFocus = focusInsideRailRef.current;
    focusInsideRailRef.current = false;
    if (moreOpen) more.close(false);
    if (!hadFocus) return;
    // Settings has no rail-item on either side of the crossing, so the destination fallback has
    // nothing active to match and dropped focus on Inbox — a user who rotated a phone into
    // landscape while standing in Settings landed on a page they had not opened. The desktop gear
    // is the same page, so it is the correct survivor.
    //
    // Tried one selector at a time, NOT as a comma list: querySelector returns the first match in
    // DOCUMENT order, not the first selector that matches. `.rail-destinations` precedes both
    // `.rail-settings` and any active item, so a list silently resolved to the first destination
    // and the preference expressed by the ordering never applied.
    const survivors = settingsSelected
      ? [".rail-settings .rail-item", ".rail-destinations a.rail-item"]
      : [".rail-destinations .rail-item.active", ".rail-destinations a.rail-item"];
    window.requestAnimationFrame(() => {
      for (const selector of survivors) {
        const target = document.querySelector<HTMLElement>(selector);
        if (target) return target.focus();
      }
    });
  }, [isMobile, moreOpen, more, settingsSelected]);

  // The user's configured order, minus hidden and experiment-disabled destinations, IS the rail
  // (#385): digits, keycaps and the More sheet's order all derive from this one list, so hiding a
  // destination renumbers the survivors — position is the binding. The phone bar is chosen
  // separately (phoneBarViews), so the desktop order and experiments never decide its four slots.
  const { flags } = useExperiments();
  const preferences = useRailPreferences();
  // Desktop only: a stored preference never widens the phone tab bar (#1968).
  const labelled = !isMobile && preferences.labels;
  const visibleNames = visibleRailViews(preferences, flags);
  const digits = railDigits(visibleNames);
  const itemFor = (name: GlobalViewName) => GLOBAL_VIEW_ITEMS.find((item) => item.id === name)!;
  const barNames = isMobile ? phoneBarViews(preferences, flags) : visibleNames;
  const visibleItems = barNames.map(itemFor);
  const overflowItems = isMobile ? visibleNames.filter((name) => !barNames.includes(name)).map(itemFor) : [];
  // A destination hidden behind More still has to read as current, or the bar looks like nothing
  // is selected while the user is standing on Usage — or, now, in Settings.
  const overflowSelected = settingsSelected || overflowItems.some((item) => item.id === selected);
  const overflowSelectedTitle = settingsSelected
    ? "Settings"
    : GLOBAL_VIEW_ITEMS.find((item) => item.id === selected)?.name ?? "";
  // Search opens the palette rather than a page, so it takes no digit and renumbers nothing. It
  // leads the Work group wherever a saved order put that group.
  const entries: RailEntry[] = [...visibleItems];
  if (!isMobile && onSearch) {
    entries.splice(Math.max(0, entries.findIndex((entry) => entryGroup(entry) === "work")), 0, "search");
  }
  const separatorsBefore = isMobile ? entries.map(() => false) : railSeparatorsBefore(entries.map(entryGroup));
  const descriptionPrefix = useId();
  const attentionState = { blocked: blockedCount, stalled: stalledCount, machines };
  // The labelled rail already shows every name, so it shows no tooltip.
  const tooltip = useRailTooltip(!isMobile && !labelled);
  // The sheet is rendered for the whole phone breakpoint rather than only when a destination
  // overflows: Settings always lives there, so hiding every optional destination by experiment
  // must not strand it.
  const showMore = isMobile;

  /**
   * Focus returns to More only when the sheet was closed from the keyboard, so a keyboard user keeps
   * their place (#1959). After a tap it did too, and the next page showed More ringed or filled
   * beside the real current tab. Enter on a link or a button dispatches a click with no pointer
   * press behind it, which is how a keyboard activation is told from a tap.
   */
  const closeMoreFrom = (event: React.MouseEvent) => more.close(event.detail === 0);

  /**
   * The parts every sheet row shares. Extracted so the Settings row cannot drift from the
   * destination rows — both close the sheet the same way and both answer Space.
   */
  // `resolve` runs at ACTIVATION, not render: an overflowed Sessions row must open the persisted
  // list/board mode exactly like the bar item and the digit do, and that mode can change while
  // the sheet is open.
  const sheetItemProps = (destination: View, active: boolean, resolve: () => View = () => destination) => ({
    role: "menuitem" as const,
    href: viewPath(destination),
    "aria-current": active ? ("page" as const) : undefined,
    onClick: (event: React.MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      closeMoreFrom(event);
      onNavigate(resolve());
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      // An anchor activates on Enter natively but not on Space, and role="menuitem"
      // promises both. Unhandled, Space scrolled the sheet instead of navigating.
      if (event.key !== " " && event.key !== "Spacebar") return;
      event.preventDefault();
      more.close(true);
      onNavigate(resolve());
    },
  });

  const renderEntry = (entry: RailEntry) => {
    if (entry === "search") {
      return (
        <button
          type="button"
          className="rail-item"
          aria-label="Search"
          aria-keyshortcuts={shortcutAriaKeys("search")}
          data-rail-tip="Search"
          data-rail-keys={shortcutDisplay("search")}
          onClick={(event) => {
            // Safari does not focus a clicked button, and the palette returns focus to whatever
            // held it when it opened.
            event.currentTarget.focus();
            onSearch?.();
          }}
        >
          <SearchIcon size={RAIL_ICON_SIZE} />
          <RailItemText labelled={labelled} name="Search" keys={shortcutDisplay("search")} />
        </button>
      );
    }
    const item = entry;
    const shortcutDigit = isMobile ? null : digits.get(item.id) ?? null;
    const Icon = VIEW_ICONS[item.id];
    const active = selected === item.id;
    const destination = { name: item.id } as View;
    const attention = railAttention(item.id, attentionState);
    const descriptionId = `${descriptionPrefix}-${item.id}`;
    const glyph = <Icon size={isMobile ? TAB_ICON_SIZE : RAIL_ICON_SIZE} />;
    return (
      <a
        className={`rail-item${active ? " active" : ""}`}
        href={viewPath(destination)}
        aria-current={active ? "page" : undefined}
        // The name is the destination alone on every surface; the attention is its description
        // and, on the desktop rail, the tooltip's second line (#1967).
        aria-label={item.name}
        aria-describedby={attention ? descriptionId : undefined}
        aria-keyshortcuts={shortcutDigit ?? undefined}
        data-rail-tip={isMobile ? undefined : item.name}
        data-rail-keys={shortcutDigit ?? undefined}
        data-rail-note={isMobile ? undefined : attention?.note}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          // Activating Sessions opens its persisted list/board mode; the href stays the
          // canonical "/" so copied links deep-link the explicit list mode.
          onNavigate(item.id === "inbox" ? sessionsViewDestination() : destination);
        }}
      >
        {isMobile ? (
          railTab(true, item.name, (
            <span className="rail-icon">
              {glyph}
              <AttentionMark attention={attention} onIcon />
            </span>
          ))
        ) : labelled ? (
          <>
            {glyph}
            <RailItemText labelled name={item.name} keys={shortcutDigit}>
              <AttentionMark attention={attention} />
            </RailItemText>
          </>
        ) : (
          <span className="rail-icon">
            {glyph}
            <AttentionMark attention={attention} onIcon />
          </span>
        )}
        {attention && <span id={descriptionId} className="sr-only">{attention.note}</span>}
      </a>
    );
  };

  return (
    <nav className={`app-rail${labelled ? " labelled" : ""}`} aria-label="Primary Navigation" data-focus-zone="rail" tabIndex={-1} {...tooltip.handlers}>
      {/* In the desktop app the current instance's tile takes the brand's place (§4.1, #1970).
          Elsewhere the brand is decoration, not a second link to Sessions directly below it (#1958). */}
      {!isMobile && instanceControl ? (
        <div className="rail-instance">{instanceControl}</div>
      ) : (
        <div className="rail-brand" aria-hidden="true">
          <img src="/icons/icon-192.png" alt="" />
        </div>
      )}
      <div className="rail-destinations">
        {entries.map((entry, index) => (
          <React.Fragment key={entry === "search" ? "search" : entry.id}>
            {separatorsBefore[index] && <span className="rail-separator" aria-hidden="true" />}
            {renderEntry(entry)}
          </React.Fragment>
        ))}
        {showMore && (
          <div className="rail-more">
            <button
              ref={more.triggerRef}
              type="button"
              className={`rail-item rail-more-trigger${overflowSelected ? " active" : ""}`}
              onClick={more.toggle}
              onKeyDown={more.onTriggerKeyDown}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-controls={more.menuId}
              /* The link carrying aria-current is unmounted while the sheet is closed, so without
                 this the navigation exposes no current page at all on an overflow destination —
                 a screen-reader user on Usage hears only a collapsed "More" button. */
              aria-current={overflowSelected && !moreOpen ? "page" : undefined}
              aria-label={overflowSelected && !moreOpen
                ? `More Destinations, ${overflowSelectedTitle} selected`
                : "More Destinations"}
              title="More Destinations"
            >
              {railTab(true, "More", <MoreHorizontalIcon size={TAB_ICON_SIZE} />)}
            </button>
            {moreOpen && (
              // The shared menu, a bottom sheet at this width (§15.1). Its backdrop is the scrim:
              // a tap on it closes the sheet without handing focus back to More. It is also what
              // the shell's Escape ladder clicks to peel one layer.
              <MenuSurface
                surfaceRef={more.menuRef}
                anchor={{ trigger: more.triggerRef }}
                id={more.menuId}
                label="More Destinations"
                className={`rail-more-sheet${isShort ? " two-column" : ""}`}
                tabIndex={-1}
                // Close is a menuitem like the Model Settings sheet's, so every element the menu
                // owns keeps a menu role.
                head={
                  <div className="menu-head persistent" role="presentation">
                    <span className="menu-head-title">More</span>
                    <button
                      type="button"
                      role="menuitem"
                      className="icon-btn rail-more-close"
                      aria-label="Close More"
                      data-menu-label="Close More"
                      title="Close More"
                      onClick={closeMoreFrom}
                    >
                      <CloseIcon size={SHEET_ICON_SIZE} />
                    </button>
                  </div>
                }
                onDismiss={() => more.close(false)}
                onKeyDown={more.onMenuKeyDown}
              >
                {overflowItems.map((item) => {
                  const Icon = VIEW_ICONS[item.id];
                  const destination = { name: item.id } as View;
                  // A reordered rail can push a destination into the sheet; its attention must
                  // overflow WITH it, or moving Sessions fifth silently hides what is waiting.
                  const attention = railAttention(item.id, attentionState);
                  const descriptionId = `${descriptionPrefix}-more-${item.id}`;
                  return (
                    <a
                      key={item.id}
                      className={`menu-item${selected === item.id ? " is-active" : ""}`}
                      aria-label={item.name}
                      aria-describedby={attention ? descriptionId : undefined}
                      {...sheetItemProps(
                        destination,
                        selected === item.id,
                        item.id === "inbox" ? sessionsViewDestination : undefined,
                      )}
                    >
                      <span className="menu-icon" aria-hidden="true"><Icon size={SHEET_ICON_SIZE} /></span>
                      <span className="menu-body"><span className="menu-text">{item.name}</span></span>
                      {attention && (
                        <span className="menu-trail" aria-hidden="true"><AttentionMark attention={attention} /></span>
                      )}
                      {attention && <span id={descriptionId} className="sr-only">{attention.note}</span>}
                    </a>
                  );
                })}
                {/* Settings closes the sheet, separated from the destinations above it. On a
                    phone this is the only Settings entry point in the chrome: the header gear
                    is gone (see the note by .rail-spacer). Safe here now that Settings is a
                    route — the layer-nesting defect that evicted it belonged to the dialog. */}
                <MenuSeparator />
                <a
                  className={`menu-item${settingsSelected ? " is-active" : ""}`}
                  {...sheetItemProps({ name: "settings" }, settingsSelected)}
                >
                  <span className="menu-icon" aria-hidden="true"><SettingsIcon size={SHEET_ICON_SIZE} /></span>
                  <span className="menu-body"><span className="menu-text">Settings</span></span>
                </a>
              </MenuSurface>
            )}
          </div>
        )}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          Sessions: {blockedCount} Blocked, {stalledCount} Stalled
        </span>
      </div>
      <div className="rail-spacer" />
      {/* On a phone Settings is the trailing item of the More sheet above, and there is no instance
          switcher: the desktop app's 940px minimum width never reaches the phone layout (#1970).

          Settings once lived in the sheet with the switcher and was evicted with it: nested inside
          a role="menu", InstanceSelector and the then-SettingsDialog bubbled their own Tab/Escape
          into the outer roving controller, so one Tab tore down both layers and one Escape peeled
          two. Settings is a plain route now, so it carries menuitem like any other sheet row and
          opens no layer to nest.

          Floating buttons were rejected: that band is occupied by the shell dock and the toast
          stack. */}
      {!isMobile && <div className="rail-settings">{settingsControl}</div>}
      {!isMobile && (
        <div className="rail-foot">
          {/* One of three switches for the labelled rail, with Settings › Appearance › Navigation
              and the palette (#1968). Its name is the action it takes, so it has no pressed state. */}
          <button
            type="button"
            className="icon-btn"
            aria-label={labelled ? "Collapse Navigation" : "Expand Navigation"}
            data-rail-tip={labelled ? undefined : "Expand Navigation"}
            title={labelled ? "Collapse navigation" : undefined}
            onClick={() => setRailLabels(!labelled, instanceScope)}
          >
            {labelled ? <PanelLeftCloseIcon size={16} /> : <PanelLeftOpenIcon size={16} />}
          </button>
        </div>
      )}
      {/* Last in the DOM, so the first child stays the brand or tile: it is placed absolutely. */}
      <RailDragStrip />
      {tooltip.tooltip}
    </nav>
  );
}

/**
 * A phone tab: the icon in its pill over a one-line label (docs/design-system.md §15.1). The label
 * ellipsizes; the accessible name stays the tab's full name. The desktop rail is icon-only unless
 * the user turns on its labels (RailItemText).
 */
function railTab(labelled: boolean, name: string, icon: ReactNode): ReactNode {
  if (!labelled) return icon;
  return (
    <>
      <span className="rail-tab-pill">{icon}</span>
      <span className="rail-tab-label">{name}</span>
    </>
  );
}

/**
 * The strip at the top of the rail that the macOS desktop app's traffic lights sit in, and that
 * drags the window (#1979). styles.css shows it only under `.macos-title-bar`: everywhere else the
 * rail starts at its first item, and a browser ignores the attribute.
 */
export function RailDragStrip() {
  return <div className="rail-drag-strip" data-tauri-drag-region="" aria-hidden="true" />;
}
