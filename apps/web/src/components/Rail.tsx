import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { View } from "../navigation.js";
import { GLOBAL_VIEW_ITEMS, viewPath, type GlobalViewName } from "../navigation.js";
import {
  AutomationsIcon,
  BoardIcon,
  ConnectionsIcon,
  GearIcon,
  InboxIcon,
  FolderSolidIcon,
  MoreHorizontalIcon,
  PodsIcon,
  ProjectsIcon,
  RunsIcon,
  SkillsIcon,
  UsageIcon,
} from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { useIsMobile } from "./useIsMobile.js";
import { experimentForViewName } from "../experiments.js";
import { useExperiments } from "../use-experiments.js";

/**
 * The four destinations that stay on the phone tab bar. Everything else moves behind "More".
 *
 * Eight destinations at 44px plus the instance and Settings controls exceeded a 375px viewport.
 * Five items is the platform convention; creation is owned by the Inbox toolbar.
 */
export const MOBILE_PRIMARY_VIEWS: readonly GlobalViewName[] = ["inbox", "projects", "board", "runners"];

const VIEW_ICONS: Record<GlobalViewName, (props: { size?: number; className?: string }) => ReactNode> = {
  inbox: InboxIcon,
  projects: ProjectsIcon,
  board: BoardIcon,
  runs: RunsIcon,
  pods: PodsIcon,
  automations: AutomationsIcon,
  usage: UsageIcon,
  runners: ConnectionsIcon,
  archived: FolderSolidIcon,
  skills: SkillsIcon,
};

/** The bare digit shortcuts stop at 9. A destination past that limit gets no number, because the
 * number IS the advertised binding and a "(10)" keycap names a key that cannot be pressed. */
const RAIL_SHORTCUT_DIGITS = 9;

const RAIL_ICON_SIZE = 26;

function selectedRailView(view: View): GlobalViewName | null {
  if (view.name === "session") return "inbox";
  if (view.name === "run") return "runs";
  if (view.name === "pod") return "pods";
  return GLOBAL_VIEW_ITEMS.some((item) => item.name === view.name) ? view.name as GlobalViewName : null;
}

export function Rail({
  view,
  blockedCount,
  stalledCount,
  onlineConnections,
  onNavigate,
  instanceControl,
  settingsControl,
}: {
  view: View;
  blockedCount: number;
  stalledCount: number;
  onlineConnections: number;
  onNavigate: (view: View) => void;
  instanceControl?: ReactNode;
  /** Desktop only. On a phone Settings is a row in the More sheet (see the note by .rail-spacer). */
  settingsControl?: ReactNode;
}) {
  const selected = selectedRailView(view);
  const isMobile = useIsMobile();
  const [moreOpen, setMoreOpen] = useState(false);
  const more = useAccessibleMenu(moreOpen, setMoreOpen, "rail-more-menu");

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
        focusInsideRailRef.current = active.closest?.(".rail-more") != null;
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
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".rail-destinations .rail-item.active, .rail-destinations .rail-item")?.focus();
    });
  }, [isMobile, moreOpen, more]);

  // Filtered before the mobile split so a hidden experiment is absent from BOTH the primary bar
  // and the More sheet. The Ctrl+N numbers stay anchored to the canonical list below, so hiding
  // a destination never renumbers the survivors' advertised shortcuts.
  const { flags } = useExperiments();
  const enabledItems = GLOBAL_VIEW_ITEMS.filter((item) => {
    const experiment = experimentForViewName(item.name);
    return experiment === null || flags[experiment];
  });
  const visibleItems = isMobile
    ? enabledItems.filter((item) => MOBILE_PRIMARY_VIEWS.includes(item.name))
    : enabledItems;
  const overflowItems = isMobile
    ? enabledItems.filter((item) => !MOBILE_PRIMARY_VIEWS.includes(item.name))
    : [];
  // Settings rides in the sheet on a phone but is deliberately absent from GLOBAL_VIEW_ITEMS: that
  // array numbers the desktop rail AND its bare-digit shortcuts, so adding an entry would rebind
  // every later destination and render a second Settings row beside the gear (see navigation.ts).
  // It is therefore tracked on its own rather than through selectedRailView.
  const settingsSelected = view.name === "settings";
  // A destination hidden behind More still has to read as current, or the bar looks like nothing
  // is selected while the user is standing on Usage — or, now, in Settings.
  const overflowSelected = settingsSelected || overflowItems.some((item) => item.name === selected);
  const overflowSelectedTitle = settingsSelected
    ? "Settings"
    : GLOBAL_VIEW_ITEMS.find((item) => item.name === selected)?.title ?? "";
  // The sheet is rendered for the whole phone breakpoint rather than only when a destination
  // overflows: Settings always lives there, so hiding every optional destination by experiment
  // must not strand it.
  const showMore = isMobile;

  /**
   * The parts every sheet row shares. Extracted so the Settings row cannot drift from the
   * destination rows — both close the sheet the same way and both answer Space.
   */
  const sheetItemProps = (destination: View, active: boolean) => ({
    role: "menuitem" as const,
    href: viewPath(destination),
    "aria-current": active ? ("page" as const) : undefined,
    onClick: (event: React.MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      // close(true) restores focus to the trigger, which survives the
      // teardown; close(false) left keyboard position on <body>.
      more.close(true);
      onNavigate(destination);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      // An anchor activates on Enter natively but not on Space, and role="menuitem"
      // promises both. Unhandled, Space scrolled the sheet instead of navigating.
      if (event.key !== " " && event.key !== "Spacebar") return;
      event.preventDefault();
      more.close(true);
      onNavigate(destination);
    },
  });

  return (
    <nav className="app-rail" aria-label="Primary Navigation" data-focus-zone="rail" tabIndex={-1}>
      <a
        className="rail-brand"
        href={viewPath({ name: "inbox" })}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onNavigate({ name: "inbox" });
        }}
        title="Wollipog Inbox"
        aria-label="Wollipog Inbox"
      >
        <img src="/icons/icon-192.png" alt="" aria-hidden="true" />
      </a>
      <div className="rail-destinations">
        {visibleItems.map((item) => {
          // Anchored to the canonical list, not the filtered one: the number IS the Ctrl+N
          // shortcut, so renumbering it on mobile would advertise a binding that does not exist.
          const index = GLOBAL_VIEW_ITEMS.findIndex((entry) => entry.name === item.name);
          const shortcutDigit = index < RAIL_SHORTCUT_DIGITS ? index + 1 : null;
          const shortcutSuffix = isMobile || shortcutDigit === null ? "" : ` (${shortcutDigit})`;
          const Icon = VIEW_ICONS[item.name];
          const active = selected === item.name;
          const badge = item.name === "runners" ? onlineConnections : 0;
          const destination = { name: item.name } as View;
          const countLabel = item.name === "inbox"
            ? `${blockedCount > 0 ? `, ${blockedCount} Blocked` : ""}${stalledCount > 0 ? `, ${stalledCount} Stalled` : ""}`
            : item.name === "runners" && badge > 0
              ? `, ${badge} Online`
              : "";
          return (
            <a
              key={item.name}
              className={`rail-item${active ? " active" : ""}`}
              href={viewPath(destination)}
              aria-current={active ? "page" : undefined}
              aria-label={`${item.label}${shortcutSuffix}${countLabel}`}
              title={`${item.title}${shortcutSuffix}`}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onNavigate(destination);
              }}
            >
              <Icon size={RAIL_ICON_SIZE} />
              {item.name === "inbox" && blockedCount > 0 && (
                <span className="rail-badge blocked" aria-hidden="true">{blockedCount}</span>
              )}
              {item.name === "inbox" && stalledCount > 0 && (
                <span className="rail-badge stalled" aria-hidden="true">{stalledCount}</span>
              )}
              {item.name === "runners" && badge > 0 && <span className="rail-badge" aria-hidden="true">{badge}</span>}
              {!isMobile && shortcutDigit !== null && (
                <span className="rail-number" aria-hidden="true">{shortcutDigit}</span>
              )}
            </a>
          );
        })}
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
              <MoreHorizontalIcon size={RAIL_ICON_SIZE} />
            </button>
            {moreOpen && (
              <>
                {/* .menu-backdrop is what the shell's Escape ladder clicks to peel one layer. */}
                <div className="menu-backdrop" onClick={() => more.close(true)} aria-hidden="true" />
                <div
                  className="rail-more-sheet"
                  id={more.menuId}
                  ref={more.menuRef}
                  role="menu"
                  aria-label="More Destinations"
                  onKeyDown={more.onMenuKeyDown}
                >
                  {overflowItems.map((item) => {
                    const Icon = VIEW_ICONS[item.name];
                    const destination = { name: item.name } as View;
                    return (
                      <a
                        key={item.name}
                        className={`rail-more-item${selected === item.name ? " active" : ""}`}
                        {...sheetItemProps(destination, selected === item.name)}
                      >
                        <Icon size={20} />
                        <span>{item.title}</span>
                      </a>
                    );
                  })}
                  {/* Settings closes the sheet, separated from the destinations above it. On a
                      phone this is the only Settings entry point in the chrome: the header gear
                      is gone (see the note by .rail-spacer). Safe here now that Settings is a
                      route — the layer-nesting defect that evicted it belonged to the dialog. */}
                  <a
                    className={`rail-more-item rail-more-settings${settingsSelected ? " active" : ""}`}
                    {...sheetItemProps({ name: "settings" }, settingsSelected)}
                  >
                    <GearIcon size={20} />
                    <span>Settings</span>
                  </a>
                </div>
              </>
            )}
          </div>
        )}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          Inbox: {blockedCount} Blocked, {stalledCount} Stalled
        </span>
      </div>
      <div className="rail-spacer" />
      {/* On a phone the instance switcher moves to the TOPBAR (see App.tsx), and Settings is the
          trailing item of the More sheet above.

          Both once lived in the sheet and were evicted together: nested inside a role="menu",
          InstanceSelector and the then-SettingsDialog bubbled their own Tab/Escape into the outer
          roving controller, so one Tab tore down both layers and one Escape peeled two — and
          neither was reachable by keyboard at all, since only the destination links carried a
          menuitem role. That reasoning is about owning a nested layer, and only the instance
          switcher still does. Settings is a plain route now, so it carries menuitem like any other
          sheet row and opens no layer to nest. The topbar keeps the switcher because it is a
          fixed, uncontested strip that no overlay occupies.

          Floating buttons were rejected for both: that band is occupied by the shell dock and the
          toast stack. */}
      {!isMobile && instanceControl && <div className="rail-instance">{instanceControl}</div>}
      {!isMobile && <div className="rail-settings">{settingsControl}</div>}
    </nav>
  );
}
