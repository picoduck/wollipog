import { setHideAccountEmails, useAccountEmailPrivacy } from "../account-email-privacy.js";
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArtifactUploadSettings } from "./ArtifactUploadSettings.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { useApi } from "../api-context.js";
import { tailnetAccessDescription, type TailnetAccessSetting } from "../tailnet-access.js";
import { type PushSetting } from "../push.js";
import {
  AppearanceIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  ExperimentIcon,
  InfoIcon,
  KeyboardIcon,
  NetworkIcon,
  NotificationsIcon,
  OrchestratorControlsIcon,
  ShieldCheckIcon,
  TuningIcon,
} from "./Icons.js";
import { VIEW_ICONS } from "./Rail.js";
import { DetailBar, PageHeader } from "./PageHeader.js";
import { TabList } from "./Tabs.js";
import {
  REQUIRED_RAIL_VIEWS,
  moveRailView,
  railDigits,
  railPreferencesAreDefault,
  resetRailPreferences,
  setRailLabels,
  setRailViewHidden,
  visibleRailViews,
} from "../rail-preferences.js";
import { useRailPreferences } from "../use-rail-preferences.js";
import { useInstanceScope } from "../instance-scope.js";
import { instancePublicOrigin, useInstances } from "../instances-context.js";
import { useIsCompact, useIsMobile, useIsTouchOnly } from "./useIsMobile.js";
import { EXPERIMENT_COPY, experimentForViewName } from "../experiments.js";
import { useExperiments } from "../use-experiments.js";
import { destination } from "../navigation.js";
import { ActionRow, LinkRow, SAVED_MS, SegmentedRow, SelectRow, SettingRow, SettingsGroup, StaticRow, SwitchRow, ValueRow } from "./ui/SettingsRows.js";
import { SCHEME_SWATCHES, type ColorScheme, type ResolvedTheme } from "../theme.js";
import type { SessionsPreviewLayout } from "../sessions-preview-layout.js";
import { useSessionsPreviewLayout } from "../use-sessions-preview-layout.js";
import { setTerminalPlacement, useTerminalPlacement, type TerminalPlacement } from "../terminal-placement.js";
import { setEnterKeyBehavior, useEnterKeyBehavior, type EnterKeyBehavior } from "../enter-key.js";
import { setShowAgentLogs, useShowAgentLogs } from "../agent-logs.js";
import { EXPERIMENT_OFF_EFFECT, SETTINGS_SECTIONS, viewPath, type SettingsFocus, type SettingsSection, type SettingsSectionEntry, type View } from "../navigation.js";
import { SHOW_SHORTCUTS_ID, shortcutDisplay } from "../shortcuts.js";
import type { ExperimentFlags, ExperimentId } from "../experiments.js";

/**
 * Settings as a ROUTE, not a dialog.
 *
 * §11.3's argument, and every part of it was a live defect: a dialog cannot be linked to, so
 * "see Settings → Appearance" is not a thing you can send anyone; it cannot be opened in a second
 * tab; it loses its place on every 760px crossing, which is why `App` had to hoist its open state
 * out of both layouts; and the shortcut reference had to CLOSE it and open a second modal, because
 * a dialog inside a dialog is a focus trap inside a focus trap.
 *
 * The master/detail shape is the one Agent Skills established (§6, #1987) — the sections are the
 * list, and a phone gets the list and each section as two routes — so this is a layout the app
 * already knows rather than a new one.
 */

export interface SettingsViewProps {
  /** Absent for `/settings` itself: the index on a phone, the first section elsewhere. */
  section?: SettingsSection;
  onNavigate: (view: View) => void;
  /** Each section's content, supplied by the shell that owns the underlying state. */
  panels: Record<SettingsSection, ReactNode>;
}

/**
 * What an open section's panel puts in the section's head in place of its entry's: a longer
 * description than the 38 characters a phone's index row allows, and a meta label (§11.3) that
 * depends on what the panel loaded, such as Orchestrator's "Your Defaults". `meta` replaces the
 * entry's scope; `null` shows none, while the panel does not know yet.
 */
export interface SettingsPanelHead {
  description?: string;
  meta?: string | null;
}

const SettingsPanelHeadContext = createContext<(head: SettingsPanelHead | null) => void>(() => undefined);

/** Sets the open section's head (see `SettingsPanelHead`) for as long as the calling panel is open. */
export function useSettingsPanelHead({ description, meta }: SettingsPanelHead): void {
  const setHead = useContext(SettingsPanelHeadContext);
  // Before paint, so the head never shows the entry's line for a frame and then changes.
  useLayoutEffect(() => {
    setHead({ description, meta });
    return () => setHead(null);
  }, [setHead, description, meta]);
}

/** The page header's one line (§4.2), hidden on phones as every page description is. */
export const SETTINGS_DESCRIPTION = "Preferences for this device and your account.";

/** Each section's 16px glyph, one per meaning (§18, docs/icon-system.md). */
const SECTION_ICONS: Record<SettingsSection, (props: { size?: number }) => ReactNode> = {
  appearance: AppearanceIcon,
  notifications: NotificationsIcon,
  behavior: TuningIcon,
  approvals: ShieldCheckIcon,
  orchestrator: OrchestratorControlsIcon,
  network: NetworkIcon,
  experimental: ExperimentIcon,
  about: InfoIcon,
};

/** The sections that start a new group in the phone index; the rest follow the section before. */
const INDEX_GROUP_STARTS: ReadonlySet<SettingsSection> = new Set(["approvals", "network"]);

/** The phone index's groups (§5.1): preferences, then decisions, then the machine and the app. */
export function settingsIndexGroups(): SettingsSectionEntry[][] {
  const groups: SettingsSectionEntry[][] = [];
  for (const entry of SETTINGS_SECTIONS) {
    if (groups.length === 0 || INDEX_GROUP_STARTS.has(entry.id)) groups.push([]);
    groups[groups.length - 1]!.push(entry);
  }
  return groups;
}

/**
 * Settings is a master-detail destination (§6): the sections are the list, and each section is a
 * route of its own. The list takes the shape of the width (§15):
 *
 * - **Desktop** (1100px and wider): a 192px column of section items beside the panel, the current
 *   one in the §5.2 selected state.
 * - **Compact** (761–1099px): link tabs in the page header (§10.1), so the panel keeps the width.
 * - **Phone** (760px and below): two routes (§6.2). `/settings` is the section index, and each
 *   section opens under a detail bar whose Back returns to the index where it was left.
 *
 * Without a section, desktop and compact widths open the first one (§6.1 rule 2), and the URL stays
 * `/settings` so the same link shows a phone its index.
 */
export function SettingsView({ section, onNavigate, panels }: SettingsViewProps) {
  const phone = useIsMobile();
  const compact = useIsCompact();
  const showIndex = phone && section === undefined;
  const current = SETTINGS_SECTIONS.find((entry) => entry.id === section) ?? SETTINGS_SECTIONS[0]!;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [panelHead, setPanelHead] = useState<SettingsPanelHead | null>(null);
  const scope = panelHead && panelHead.meta !== undefined ? panelHead.meta : current.scope;
  // Back/Forward between sections swaps `panels[current.id]`. If the focused control was inside the
  // outgoing panel it is now detached and focus is on <body>. Focusing the heading only in that
  // case keeps link-driven navigation as it is — the link keeps focus, and its `aria-current`
  // change is what announces the move. Where the panel's heading is hidden (the current tab or the
  // detail bar names the section), the page title takes it instead.
  //
  // And only on an actual section CHANGE. Arriving at /settings/network directly leaves focus on
  // <body> legitimately; focusing the heading there put the first Tab after all the section links.
  const previousSection = useRef(section);
  useEffect(() => {
    if (previousSection.current === section) return;
    previousSection.current = section;
    const active = document.activeElement;
    if (active && active !== document.body && (active as HTMLElement).isConnected) return;
    const heading = headingRef.current;
    // Back to a phone's index restores where it was scrolled (below), which focusing its title must
    // not undo.
    (heading && heading.getClientRects().length > 0 ? heading : document.getElementById("page-title"))
      ?.focus({ preventScroll: section === undefined });
  }, [section]);
  // Crossing a breakpoint swaps the side nav, the header's tabs and the index, so a focused link in
  // the one that goes leaves focus on <body>; the shell's own rescue watches only the phone
  // breakpoint, not 1100px. Focus moves to the current section's link in whatever replaced it, else
  // to the page title.
  const previousLayout = useRef({ phone, compact });
  useEffect(() => {
    const before = previousLayout.current;
    if (before.phone === phone && before.compact === compact) return;
    previousLayout.current = { phone, compact };
    const active = document.activeElement;
    if (active && active !== document.body && (active as HTMLElement).isConnected) return;
    (rootRef.current?.querySelector<HTMLElement>('a[aria-current="page"]') ?? document.getElementById("page-title"))
      ?.focus({ preventScroll: true });
  }, [phone, compact]);
  // On a phone the index and a section are two screens in one scroller, the shell's `.main-body`. A
  // section opens at its top, and Back puts the index where it was left (§6.2). The position is
  // recorded while the index is on screen, since by the time a section has replaced it the scroller
  // has already clamped to the shorter page. Scroll events arrive a frame late, so one can land after
  // a section has replaced the index; only a position the index itself was scrolled to counts.
  const indexScrollTop = useRef(0);
  useEffect(() => {
    const scroller = rootRef.current?.closest(".main-body");
    if (!showIndex || !scroller) return;
    const record = () => {
      if (scroller.querySelector(".settings-index")) indexScrollTop.current = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", record, { passive: true });
    return () => scroller.removeEventListener("scroll", record);
  }, [showIndex]);
  const previousShowIndex = useRef(showIndex);
  useLayoutEffect(() => {
    if (previousShowIndex.current === showIndex) return;
    previousShowIndex.current = showIndex;
    const scroller = rootRef.current?.closest(".main-body");
    if (scroller) scroller.scrollTop = showIndex ? indexScrollTop.current : 0;
  }, [showIndex]);

  // These are ROUTES, and each one is a link a person can copy, bookmark, or open in a new tab: a
  // plain click navigates in place, and any modified click is left to the browser.
  const linkTo = (view: View) => ({
    href: viewPath(view),
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onNavigate(view);
    },
  });

  // A phone's section is a detail page (§4.3): its bar is full-bleed and the panel sits in the
  // gutter under it. Every other screen is a page under the page header.
  const phoneSection = phone && !showIndex;
  return (
    // One tree at every width: crossing a breakpoint swaps the header and the list beside the panel,
    // but the panel keeps its place, so whatever is open or half-typed in it survives the crossing.
    // One scroll container per column (§4.5): the shell's `.main-body` scrolls Settings, so this root
    // neither reuses that class nor scrolls on its own.
    <div ref={rootRef} className={phoneSection ? "settings-detail" : "page full"}>
      {phoneSection ? (
        <DetailBar title={current.title} backLabel="Back to Settings" onBack={() => onNavigate({ name: "settings" })} />
      ) : (
        <PageHeader
          title="Settings"
          description={SETTINGS_DESCRIPTION}
          tabs={compact ? (
            // Link tabs (§10.1): they change the URL, so they are links marked `aria-current`, not a
            // `tablist`. A tab swaps a panel in place; these navigate.
            <TabList label="Settings Sections" links>
              {SETTINGS_SECTIONS.map((entry) => (
                <a
                  key={entry.id}
                  className="tab"
                  aria-current={entry.id === current.id ? "page" : undefined}
                  {...linkTo({ name: "settings", section: entry.id })}
                >
                  {entry.title}
                </a>
              ))}
            </TabList>
          ) : undefined}
        />
      )}
      {showIndex && (
        // No row is ever selected here (§5.2): each one opens a page of its own.
        <nav className="settings-index" aria-label="Settings Sections">
          {settingsIndexGroups().map((group) => (
            <div key={group[0]!.id} className="surface">
              {group.map((entry) => {
                const Icon = SECTION_ICONS[entry.id];
                return (
                  <a key={entry.id} className="row row-2" {...linkTo({ name: "settings", section: entry.id })}>
                    <span className="row-icon" aria-hidden="true"><Icon /></span>
                    <span className="row-body">
                      <span className="row-title">{entry.title}</span>
                      <span className="row-sub">{entry.description}</span>
                    </span>
                    <span className="settings-index-chevron" aria-hidden="true"><ChevronRightIcon /></span>
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
      )}
      {/* Hidden rather than removed under the index: `/settings` shows Appearance at wider widths,
          and a window narrowed past 760px and widened again gets it back as it was left. */}
      <div className="settings-view" hidden={showIndex}>
        {!phone && !compact && (
          <nav className="settings-nav" aria-label="Settings Sections">
            {SETTINGS_SECTIONS.map((entry) => {
              const Icon = SECTION_ICONS[entry.id];
              const selected = entry.id === current.id;
              return (
                <a
                  key={entry.id}
                  className={`row settings-nav-item${selected ? " is-selected" : ""}`}
                  aria-current={selected ? "page" : undefined}
                  {...linkTo({ name: "settings", section: entry.id })}
                >
                  <span className="row-icon" aria-hidden="true"><Icon /></span>
                  <span className="row-title">{entry.title}</span>
                </a>
              );
            })}
          </nav>
        )}
        <section className="settings-panel" aria-labelledby="settings-panel-heading">
          {/* About opens with Wollipog's name and version in place of its head (#3028). The heading
              stays in the tree, hidden, so it still names the section and the focus rescue above
              falls through to the page title. */}
          <div className="settings-panel-head" hidden={current.id === "about"}>
            <div className="settings-panel-heading">
              <h2 id="settings-panel-heading" ref={headingRef} tabIndex={-1}>{current.title}</h2>
              <p className="settings-panel-desc">{panelHead?.description ?? current.panelDescription ?? current.description}</p>
            </div>
            {scope && <span className="settings-panel-scope">{scope}</span>}
          </div>
          <SettingsPanelHeadContext.Provider value={setPanelHead}>{panels[current.id]}</SettingsPanelHeadContext.Provider>
        </section>
      </div>
    </div>
  );
}

/**
 * The palette itself, rather than its name, so the five schemes can be told apart before you have
 * learned which one "Monokai" is.
 *
 * Hidden from assistive technology: the option's label already carries the name, and three
 * unlabelled colours announced beside it would be noise. The colours are the CURRENT theme's — a
 * dark-mode reader is choosing between the dark palettes, and showing them Wollipog's light ground
 * would be a swatch of a screen they are not looking at.
 */
function SchemeSwatch({ scheme, theme }: { scheme: string; theme: ResolvedTheme }) {
  const colours = SCHEME_SWATCHES[scheme as ColorScheme]?.[theme];
  if (!colours) return null;
  return (
    <span className="ui-swatch" aria-hidden="true">
      {colours.map((colour, index) => (
        <span key={index} className="ui-swatch-dot" style={{ background: colour }} />
      ))}
    </span>
  );
}

export function AppearancePanel({
  options,
  value,
  disabled = false,
  disabledReason,
  onChange,
  schemes,
  scheme,
  onSchemeChange,
  onSchemePreview,
  resolvedTheme,
  densities,
  density,
  onDensityChange,
}: {
  options: ReadonlyArray<{ value: string; label: string; description?: string }>;
  value: string;
  /** Production never disables these; the Playwright harness renders the state to measure it. */
  disabled?: boolean;
  /** And a disabled control that cannot say who took it away is a control the reader cannot act on. */
  disabledReason?: string;
  onChange: (value: string) => void;
  schemes: ReadonlyArray<{ value: string; label: string; description?: string }>;
  scheme: string;
  onSchemeChange: (value: string) => void;
  /**
   * The scheme the list is browsing, or null. The shell renders it without committing it, so a
   * palette can be judged against the actual app rather than against three dots.
   */
  onSchemePreview: (value: string | null) => void;
  /** Which palette the swatches should show, since every scheme has a light and a dark one. */
  resolvedTheme: ResolvedTheme;
  densities: ReadonlyArray<{ value: string; label: string; description?: string }>;
  density: string;
  onDensityChange: (value: string) => void;
}) {
  // A phone never shows the Sessions preview beside or below its list, so the layout does nothing there.
  const phone = useIsMobile();
  const [saved, flashSaved] = useSavedRow();
  // Every row here saves the moment it changes (§8.6), so each says so. Choosing the value it
  // already has changes nothing and says nothing.
  const instant = (row: string, current: string, apply: (next: string) => void) => (next: string) => {
    apply(next);
    if (next !== current) flashSaved(row);
  };
  /* ONE group, where there were three.
     A heading per setting made the panel read as three sections that happened to contain one
     control each, and repeated every title immediately below itself — "Theme" over a row called
     "Theme". These are three axes of one thing, which is what the group now says once. It is named
     Display rather than Appearance because the panel is already called Appearance, and a group
     heading that restates its panel's is the same duplication one level up. The panel head carries
     the scope, This Device, for every group on it. */
  return (
    <SettingsGroup title="Display" foot="Motion follows your system's reduce-motion setting.">
      <SegmentedRow
        title="Theme"
        options={options}
        value={value}
        disabled={disabled}
        disabledReason={disabledReason}
        onChange={instant("theme", value, onChange)}
        saved={saved === "theme"}
      />
      {/* A SEPARATE axis from light/dark: every scheme has both, so choosing Dracula does not
          choose dark. A listbox rather than pills because five names need their descriptions and
          their swatches to choose between, which a pill cannot carry. Its width is the described
          list's default (§8.3). Browsing previews without changing anything, so only a commit saves. */}
      <SelectRow
        title="Color Scheme"
        description="Applies to both light and dark themes."
        options={schemes.map((option) => ({
          ...option,
          swatch: <SchemeSwatch scheme={option.value} theme={resolvedTheme} />,
        }))}
        value={scheme}
        disabled={disabled}
        onChange={instant("scheme", scheme, onSchemeChange)}
        onPreview={onSchemePreview}
        estimatedOptionHeight={58}
        saved={saved === "scheme"}
      />
      {/* A THIRD axis, and about spacing rather than colour: every scheme and theme has both
          densities. Compact is the default because it is what the app already renders. */}
      <SegmentedRow
        title="Density"
        options={densities}
        value={density}
        disabled={disabled}
        disabledReason={disabledReason}
        onChange={instant("density", density, onDensityChange)}
        saved={saved === "density"}
      />
      {/* Where the Sessions preview sits (§6.3, #2219). The Sessions header's Preview Layout control
          writes the same per-device key, and each follows the other live. */}
      {!phone && (
        <SessionsLayoutRow
          disabled={disabled}
          disabledReason={disabledReason}
          saved={saved === "sessions-layout"}
          onSaved={() => flashSaved("sessions-layout")}
        />
      )}
      {/* Where terminal tabs open (§4.6, #2869). The dock's and the side panel tool's More Terminal
          Actions write the same per-device key, and each follows the others live. Kept on phones,
          which have both placements. */}
      <TerminalPlacementRow
        disabled={disabled}
        disabledReason={disabledReason}
        saved={saved === "terminal-placement"}
        onSaved={() => flashSaved("terminal-placement")}
      />
    </SettingsGroup>
  );
}

/** Which Display row shows its Saved check (§8.6): the one changed last, for `SAVED_MS`. */
function useSavedRow(): [string | null, (row: string) => void] {
  const [saved, setSaved] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback((row: string) => {
    clearTimeout(timer.current);
    setSaved(row);
    timer.current = setTimeout(() => setSaved(null), SAVED_MS);
  }, []);
  return [saved, flash];
}

/** A Display row that reads and writes its own per-device store. */
interface DeviceRowProps {
  disabled: boolean;
  disabledReason?: string;
  saved: boolean;
  /** The row's value changed and is stored. */
  onSaved: () => void;
}

const SESSIONS_LAYOUT_OPTIONS: ReadonlyArray<{ value: SessionsPreviewLayout; label: string; description: string }> = [
  { value: "below", label: "Preview Below", description: "The session list across the top, with the preview under it." },
  {
    value: "right",
    label: "Preview Right",
    description: "The session list on the left, with the preview beside it, in windows 1100px and wider.",
  },
];

function SessionsLayoutRow({ disabled, disabledReason, saved, onSaved }: DeviceRowProps) {
  const [layout, setLayout] = useSessionsPreviewLayout();
  return (
    <SegmentedRow
      title="Sessions Layout"
      options={SESSIONS_LAYOUT_OPTIONS}
      value={layout}
      disabled={disabled}
      disabledReason={disabledReason}
      onChange={(value) => {
        const next = value === "right" ? "right" : "below";
        setLayout(next);
        if (next !== layout) onSaved();
      }}
      saved={saved}
    />
  );
}

const TERMINAL_PLACEMENT_OPTIONS: ReadonlyArray<{ value: TerminalPlacement; label: string; description: string }> = [
  { value: "dock", label: "Bottom Dock", description: "Terminal tabs open in a dock under the composer." },
  { value: "panel", label: "Right Panel", description: "Terminal tabs open as the Terminal tool in the right panel." },
];

function TerminalPlacementRow({ disabled, disabledReason, saved, onSaved }: DeviceRowProps) {
  const placement = useTerminalPlacement();
  return (
    <SegmentedRow
      title="Terminal Placement"
      options={TERMINAL_PLACEMENT_OPTIONS}
      value={placement}
      disabled={disabled}
      disabledReason={disabledReason}
      onChange={(value) => {
        const next = value === "panel" ? "panel" : "dock";
        setTerminalPlacement(next);
        if (next !== placement) onSaved();
      }}
      saved={saved}
    />
  );
}

/**
 * Settings → Appearance → Navigation (#385): visibility and order for the rail's destinations.
 *
 * The read-only digit chips are the derived bindings — position IS the shortcut, so there is no
 * digit editor to drift from the rail. Sessions is required (hiding it would leave the rail with
 * no home destination), and Settings is absent on purpose: it is not a rail destination, and on
 * a phone it is the only Settings entry point, pinned as the More sheet's trailing row (#458).
 * Reordering uses Move buttons rather than drag-and-drop: one interaction that works for
 * pointer, touch, and keyboard alike, with the effect announced by the updated digit chips.
 *
 * Show Labels in Rail is the desktop rail's 208px labelled form (#1968). It is not offered on a
 * phone, whose tab bar is always labelled and never takes the rail's width.
 */
export function NavigationRailPanel() {
  const instanceScope = useInstanceScope();
  const preferences = useRailPreferences();
  const { flags } = useExperiments();
  const isMobile = useIsMobile();
  const digits = railDigits(visibleRailViews(preferences, flags));
  return (
    <SettingsGroup
      title="Navigation"
      // The group's one action and its foot line (§8.2): every child of its surface is a row.
      action={(
        <button
          type="button"
          className="btn ghost sm"
          disabled={railPreferencesAreDefault(preferences)}
          onClick={() => resetRailPreferences(instanceScope)}
        >
          Reset to Default
        </button>
      )}
      foot="The visible order assigns the digit shortcuts. Hidden destinations stay reachable from search and direct links, and keep their place here for when they return."
    >
      {!isMobile && (
        <SwitchRow
          title="Show Labels in Rail"
          description="Shows each destination's name beside its icon. The rail widens to fit them."
          checked={preferences.labels}
          onClick={() => setRailLabels(!preferences.labels, instanceScope)}
        />
      )}
      <ul className="rail-order-list" aria-label="Navigation Destinations">
        {preferences.order.map((name, index) => {
          const item = destination(name);
          const Icon = VIEW_ICONS[name];
          const required = REQUIRED_RAIL_VIEWS.has(name);
          const hidden = preferences.hidden.has(name);
          const experiment = experimentForViewName(name);
          const experimentOff = experiment !== null && !flags[experiment];
          const digit = digits.get(name);
          const state = hidden
            ? "Hidden"
            : experimentOff
              ? "Off in Experimental"
              : digit === undefined
                ? "No Digit"
                : null;
          return (
            <li className={`rail-order-row${hidden || experimentOff ? " is-inactive" : ""}`} key={name}>
              <span className="rail-order-icon" aria-hidden="true"><Icon size={16} /></span>
              <span className="rail-order-title">{item.name}</span>
              <span className="rail-order-state">
                {digit !== undefined && <kbd aria-label={`Shortcut ${digit}`}>{digit}</kbd>}
                {state !== null && <span className="rail-order-note">{state}</span>}
              </span>
              <span className="rail-order-controls">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={index === 0}
                  aria-label={`Move ${item.name} Up`}
                  onClick={() => moveRailView(name, "up", instanceScope)}
                >
                  <ArrowUpIcon size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={index === preferences.order.length - 1}
                  aria-label={`Move ${item.name} Down`}
                  onClick={() => moveRailView(name, "down", instanceScope)}
                >
                  <ArrowDownIcon size={14} />
                </button>
                {required ? (
                  <span className="rail-order-required" title="Sessions is the rail's home destination and cannot be hidden.">
                    Required
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setRailViewHidden(name, !hidden, instanceScope)}
                  >
                    {hidden ? "Show" : "Hide"}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </SettingsGroup>
  );
}

/**
 * Settings › Behavior (#3023): six groups, each naming once where its settings are kept (§11.3), so
 * no row repeats "Stored on this device." Keyboard is not a section of its own: its one row is here,
 * under Input, and `/settings/keyboard` lands on it (`focus`).
 *
 * Agent Defaults and Session Titles are slots, so the order is one decision here. Agent Defaults is a
 * whole group (`AgentDefaultsPanel`, #3024): its head carries Refresh and its notices. So is Session
 * Titles (`SessionTitlesPanel`, #3025), whose load failure is a notice above the group's surface.
 */
export function BehaviorPanel({
  agentHarnessDefaults,
  sessionNaming,
  onOpenShortcuts,
  focus,
}: {
  agentHarnessDefaults?: ReactNode;
  sessionNaming?: ReactNode;
  /** Opens the Keyboard Shortcuts reference, which returns focus to the element it is given. */
  onOpenShortcuts?: (returnFocus: HTMLElement | null) => void;
  /** Set by a redirect: the control to focus. Each arrival is a new object, so it focuses again. */
  focus?: SettingsFocus;
} = {}) {
  const privacy = useAccountEmailPrivacy();
  const enterKey = useEnterKeyBehavior();
  const agentLogs = useShowAgentLogs();
  // Shortcuts need a hardware keyboard (§15.1, §15.3): not offered on a phone or a touch-only
  // device. `?` still opens the reference wherever a keyboard is attached.
  const phone = useIsMobile();
  const touchOnly = useIsTouchOnly();
  const showShortcuts = !phone && !touchOnly;
  const shortcutsRef = useRef<HTMLButtonElement>(null);
  const inputHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus?.target !== "keyboard-shortcuts") return;
    // A dialog open over the page keeps its focus: Back onto an old Keyboard entry with the
    // reference open must not move focus behind the dialog, where Tab would wander the page.
    if (document.activeElement?.closest('[aria-modal="true"]')) return;
    // Where the row is withheld, the group it would be in.
    (shortcutsRef.current ?? inputHeadingRef.current)?.focus();
  }, [focus]);
  return (
    <>
      <SettingsGroup title="Input" scope="This Device" headingRef={inputHeadingRef}>
        {/* Stored per device and only on an explicit choice; the unstored default derives from the
            device class (touch phones get newline, everything else send), so this row shows each
            device's own effective behavior. The pair swaps as a unit — see enter-key.ts. */}
        <SegmentedRow
          title="Enter Key"
          options={[
            { value: "send", label: "Send Message", description: "Shift+Enter adds a new line." },
            { value: "newline", label: "New Line", description: "Shift+Enter sends the message." },
          ]}
          value={enterKey}
          onChange={(value) => setEnterKeyBehavior(value as EnterKeyBehavior)}
        />
        {showShortcuts && (
          <ActionRow
            title="Keyboard Shortcuts"
            description={`Press ${shortcutDisplay("shortcut-reference")} anywhere to see them.`}
            actionLabel="Show Shortcuts"
            actionIcon={<KeyboardIcon size={14} />}
            actionId={SHOW_SHORTCUTS_ID}
            hasPopup="dialog"
            buttonRef={shortcutsRef}
            onAction={() => onOpenShortcuts?.(shortcutsRef.current)}
          />
        )}
      </SettingsGroup>
      <SettingsGroup title="Transcript" scope="This Device">
        <SwitchRow
          title="Show Agent Logs"
          description={agentLogs
            ? "Work that only holds agent startup logs is shown."
            : "Work that only holds agent startup logs stays hidden."}
          checked={agentLogs}
          onClick={() => setShowAgentLogs(!agentLogs)}
        />
      </SettingsGroup>
      <SettingsGroup title="Privacy" scope="This Device">
        <SwitchRow
          title="Hide Account Emails"
          description={privacy.persistent
            ? "Hide account emails until you choose Show."
            : "This choice lasts until reload because this device could not save it."}
          checked={privacy.hide}
          onClick={() => setHideAccountEmails(!privacy.hide)}
        />
      </SettingsGroup>
      {agentHarnessDefaults}
      {sessionNaming}
      <ArtifactUploadSettings />
    </>
  );
}

/**
 * Early features, each behind its own switch.
 *
 * These gate UI EXPOSURE on this device and this instance, never capability: the control
 * plane keeps serving the underlying APIs, and turning a feature back on restores every
 * surface without a reload. The exception to "never hide a setting that could exist" is
 * deliberate here — hiding is the setting. The section's description says once what turning one
 * off does, so each row says only what its feature is. A phone hides that description under its
 * detail bar (§4.2), so there the group says it instead, above the rows (#3139).
 */
export function ExperimentalPanel({
  flags,
  onToggle,
}: {
  flags: ExperimentFlags;
  onToggle: (id: ExperimentId, enabled: boolean) => void;
}) {
  const phone = useIsMobile();
  return (
    <SettingsGroup intro={phone ? EXPERIMENT_OFF_EFFECT : undefined}>
      <SwitchRow
        title={EXPERIMENT_COPY.multiAgent.name}
        description="Runs that coordinate several agents in a workflow graph."
        checked={flags.multiAgent}
        onClick={() => onToggle("multiAgent", !flags.multiAgent)}
      />
      <SwitchRow
        title={EXPERIMENT_COPY.pods.name}
        description="Shared-context groups of sessions."
        checked={flags.pods}
        onClick={() => onToggle("pods", !flags.pods)}
      />
    </SettingsGroup>
  );
}

/**
 * Which Wollipog this window talks to, and whether other devices can reach this machine.
 *
 * Connection is about this window and shows everywhere. Tailnet is about the machine the desktop
 * app runs on, so a browser has no Tailnet group, only a foot line saying where it is turned on.
 */
export function NetworkPanel({ tailnet, onNavigate }: { tailnet: TailnetAccessSetting; onNavigate: (view: View) => void }) {
  const instances = useInstances();
  const phone = useIsMobile();
  // Null for the packaged desktop app's own server, which has no address another device could use;
  // the row then names it as the instance menu does, with nothing to copy.
  const address = instancePublicOrigin(instances);
  return (
    <>
      <SettingsGroup
        title="Connection"
        scope="This Window"
        foot={tailnet.desktop ? undefined : "Tailnet access is turned on in the Wollipog desktop app, on the machine that runs the server."}
      >
        <ValueRow
          title="Connected To"
          description="The Wollipog server this window uses."
          value={address ?? instances.activeProfile.label}
          mono={address !== null}
          copy={address ?? undefined}
          copyLabel="Copy Address"
        />
        {/* Where Connections › Instances exists: the desktop app with more than one instance
            allowed, and not on a phone, whose Connections has no Instances tab (#2984). */}
        {instances.desktopMultiInstance && !phone && (
          <LinkRow
            title="Manage Instances"
            description="Add, rename or switch Wollipog servers."
            trailing="Connections"
            onClick={() => onNavigate({ name: "runners", section: "instances" })}
          />
        )}
      </SettingsGroup>
      {tailnet.desktop && (
        <SettingsGroup title="Tailnet" scope="This Machine">
          <TailnetAccessRow tailnet={tailnet} />
        </SettingsGroup>
      )}
    </>
  );
}

const TAILNET_ACCESS = "Tailnet Access";
/** The row's frame in every state, so focus can be found again when the row changes shape. */
const TAILNET_ACCESS_ROW_ID = "settings-tailnet-access";
const CHECKING_FOR_TAILSCALE = "Checking for Tailscale…";

/**
 * The desktop app's Tailnet Access, in one of its states (§8.2, §8.4, §8.5).
 *
 * Until a status has been read there is no switch: a disabled switch announces
 * `aria-checked="false"`, which CLAIMS the setting is off, and for a network-exposure setting that
 * claim would be made precisely when its value is unknown. Checking and a failed read are a row
 * with no control; Try Again after a failed read checks again.
 */
function TailnetAccessRow({ tailnet }: { tailnet: TailnetAccessSetting }) {
  const status = tailnet.status;
  const frameRef = useRef<HTMLDivElement>(null);
  // Set when Try Again moved focus into the frame: a read that then succeeds replaces the frame with
  // the switch, and focus goes to the switch unless it has since moved somewhere else. A disabled
  // switch (Tailscale missing, another server on the port) cannot hold focus, so the row's frame
  // takes it instead, as the checking frame did.
  const holdingFocus = useRef(false);
  useLayoutEffect(() => {
    if (!status || !holdingFocus.current) return;
    holdingFocus.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const row = document.getElementById(TAILNET_ACCESS_ROW_ID);
    const control = row?.querySelector<HTMLButtonElement>('[role="switch"]');
    if (control && !control.disabled) {
      control.focus();
    } else if (row) {
      row.tabIndex = -1;
      row.focus();
    }
  }, [status]);
  if (!status) {
    const failure = tailnet.loading || !tailnet.error ? null : {
      message: "Couldn't check for Tailscale.",
      detail: tailnet.error,
      // Try Again is replaced by the checking line, so focus is kept in the row rather than dropped.
      onRetry: () => {
        frameRef.current?.focus();
        holdingFocus.current = true;
        tailnet.retry();
      },
    };
    return (
      <div ref={frameRef} id={TAILNET_ACCESS_ROW_ID} className="setting-row-frame" tabIndex={-1}>
        <SettingRow
          title={TAILNET_ACCESS}
          busy={tailnet.loading}
          busyLabel={CHECKING_FOR_TAILSCALE}
          failure={failure}
        />
        <span className="sr-only" role="status">{failure ? failure.message : tailnet.loading ? CHECKING_FOR_TAILSCALE : ""}</span>
      </div>
    );
  }
  return (
    <SwitchRow
      title={TAILNET_ACCESS}
      description={tailnetAccessDescription(status)}
      // The confirmed value, also while busy: SwitchRow disables a busy control itself and keeps
      // showing what is live until the write settles.
      checked={status.enabled}
      busy={tailnet.busy}
      busyLabel="Restarting Wollipog on this machine…"
      disabled={!status.available || !status.managed}
      failure={tailnet.error ? { message: "Couldn't change Tailnet Access.", detail: tailnet.error, onRetry: tailnet.retry } : null}
      onClick={tailnet.toggle}
      anchorId={TAILNET_ACCESS_ROW_ID}
    />
  );
}

export { AboutPanel } from "./AboutSettingsPanel.js";

/**
 * Desktop alerts (the Notification API, while a tab is open) as injected state.
 *
 * A prop rather than a direct read of the `notifier` singleton, for the same reason push is one:
 * the Playwright fixture cannot drive a singleton, so it copied a `SwitchRow` that looked like this
 * one — and a copy is a second description that drifts. Both callers mount the same component now.
 */
export { useNotifySetting, type NotifySetting } from "../use-notify-setting.js";
import type { NotifySetting } from "../use-notify-setting.js";

/** The browser refuses alerts from this site, which only its own settings can change. */
function alertsBlocked(notify: NotifySetting): boolean {
  return notify.supported && notify.permission === "denied";
}

export function NotifyRow({ notify }: { notify: NotifySetting }) {
  if (!notify.supported) return null;
  const blocked = alertsBlocked(notify);
  return (
    <SwitchRow
      title="Desktop Alerts"
      description={blocked ? "Your browser blocks alerts from Wollipog." : "Approvals and finished turns, while Wollipog is open."}
      checked={notify.on}
      disabled={notify.disabled || blocked}
      onClick={notify.toggle}
    />
  );
}

/**
 * Web Push (outlives the tab) as a settings switch — a pure view of the shell-mounted
 * usePushSetting state, so reconciliation runs whether or not the dialog ever opens. Hidden where
 * push can't work (insecure origin, no SW registration, Tauri).
 */
export function PushRow({ push, disabled }: { push: PushSetting; disabled?: boolean }) {
  const { state, confirmed, toggle } = push;
  // Rendering checked={state === "on"} moved the switch to off — and announced
  // aria-checked="false" — while disablePush() had not yet unregistered the subscription, so
  // notifications could still arrive. `confirmed` comes from the shell-mounted hook so it also
  // survives closing and reopening Settings mid-request.
  if (state === "unavailable") return null;
  return (
    <SwitchRow
      title="Push Notifications"
      description="Get alerts even when Wollipog is closed."
      checked={confirmed}
      busy={state === "busy"}
      // Turning on subscribes this browser with the server, which can take a moment; turning off
      // keeps the spinner before the description.
      busyLabel={confirmed ? undefined : "Turning on push for this browser…"}
      disabled={disabled}
      onClick={() => void toggle()}
    />
  );
}

/**
 * Alerts, in the order production renders them: desktop first, push last.
 *
 * Each row hides where it cannot work, so a window with neither says so rather than showing an empty
 * surface, and a browser that refuses alerts says how to allow them.
 */
export function NotificationsPanel({
  notify,
  push,
  disabled,
}: {
  notify: NotifySetting;
  push: PushSetting;
  /** Production never disables these; the Playwright harness renders the state to measure it. */
  disabled?: boolean;
}) {
  if (!notify.supported && push.state === "unavailable") {
    return (
      <div className="surface settings-state-surface">
        <State compact headingLevel={3} title="Alerts Aren't Available Here">
          This window can't show system notifications. Anything that needs you still shows a count on Sessions.
        </State>
      </div>
    );
  }
  return (
    <>
      {alertsBlocked(notify) && (
        <Notice
          tone="warning"
          compact
          // A refusal in the browser's own prompt brings this in while the person is on the page.
          role="status"
          actions={<button type="button" className="btn sm" onClick={notify.recheck}>Try Again</button>}
        >
          Allow notifications for this site in your browser's settings, then turn Desktop Alerts on.
        </Notice>
      )}
      <SettingsGroup>
        <NotifyRow notify={{ ...notify, disabled }} />
        <PushRow push={push} disabled={disabled} />
      </SettingsGroup>
    </>
  );
}
