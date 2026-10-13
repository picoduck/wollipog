import { setHideAccountEmails, useAccountEmailPrivacy } from "../account-email-privacy.js";
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArtifactUploadSettings } from "./ArtifactUploadSettings.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import {
  PROTOCOL_VERSION,
  type AgentDriverKind,
  type AgentHarnessDefaultConfig,
  type AgentHarnessDefaultOption,
  type AgentHarnessDefaultsView,
  type AgentModel,
  type SessionNamingMode,
  type SessionNamingSettingsView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { tailnetAccessDescription, type TailnetAccessSetting } from "../tailnet-access.js";
import { availableUpdateMessage, type DesktopUpdateSetting } from "../desktop-updates.js";
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
import { ActionRow, LinkRow, SegmentedRow, SelectRow, SettingRow, SettingsGroup, StaticRow, SwitchRow, ValueRow } from "./ui/SettingsRows.js";
import { Select } from "./ui/ChoiceControls.js";
import { SCHEME_SWATCHES, type ColorScheme, type ResolvedTheme } from "../theme.js";
import type { SessionsPreviewLayout } from "../sessions-preview-layout.js";
import { useSessionsPreviewLayout } from "../use-sessions-preview-layout.js";
import { setTerminalPlacement, useTerminalPlacement, type TerminalPlacement } from "../terminal-placement.js";
import { setEnterKeyBehavior, useEnterKeyBehavior, type EnterKeyBehavior } from "../enter-key.js";
import { setShowAgentLogs, useShowAgentLogs } from "../agent-logs.js";
import { SETTINGS_SECTIONS, viewPath, type SettingsFocus, type SettingsSection, type SettingsSectionEntry, type View } from "../navigation.js";
import { SHOW_SHORTCUTS_ID, shortcutDisplay } from "../shortcuts.js";
import type { ExperimentFlags, ExperimentId } from "../experiments.js";
import { effortLabel, permissionModeLabel, titleCaseLabel } from "../format.js";
import { useFeedback } from "./FeedbackProvider.js";

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
          <div className="settings-panel-head">
            <div className="settings-panel-heading">
              <h2 id="settings-panel-heading" ref={headingRef} tabIndex={-1}>{current.title}</h2>
              <p className="settings-panel-desc">{current.panelDescription ?? current.description}</p>
            </div>
            {current.scope && <span className="settings-panel-scope">{current.scope}</span>}
          </div>
          {panels[current.id]}
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
  /* ONE group, where there were three.
     A heading per setting made the panel read as three sections that happened to contain one
     control each, and repeated every title immediately below itself — "Theme" over a row called
     "Theme". These are three axes of one thing, which is what the group now says once. It is named
     Display rather than Appearance because the panel is already called Appearance, and a group
     heading that restates its panel's is the same duplication one level up. */
  return (
    <SettingsGroup title="Display">
      <SegmentedRow
        title="Theme"
        options={options}
        value={value}
        disabled={disabled}
        disabledReason={disabledReason}
        onChange={onChange}
      />
      {/* A SEPARATE axis from light/dark: every scheme has both, so choosing Dracula does not
          choose dark. A listbox rather than pills because five names need their descriptions and
          their swatches to choose between, which a pill cannot carry. */}
      <SelectRow
        title="Color Scheme"
        description="Applies to both the light and the dark theme."
        options={schemes.map((option) => ({
          ...option,
          swatch: <SchemeSwatch scheme={option.value} theme={resolvedTheme} />,
        }))}
        value={scheme}
        disabled={disabled}
        onChange={onSchemeChange}
        onPreview={onSchemePreview}
        menuWidth={400}
        estimatedOptionHeight={58}
      />
      {/* A THIRD axis, and about spacing rather than colour: every scheme and theme has both
          densities. Compact is the default because it is what the app already renders. */}
      <SegmentedRow
        title="Density"
        options={densities}
        value={density}
        disabled={disabled}
        disabledReason={disabledReason}
        onChange={onDensityChange}
      />
      {/* Where the Sessions preview sits (§6.3, #2219). The Sessions header's Preview Layout control
          writes the same per-device key, and each follows the other live. */}
      <SessionsLayoutRow disabled={disabled} disabledReason={disabledReason} />
      {/* Where terminal tabs open (§4.6, #2869). The dock's and the side panel tool's More Terminal
          Actions write the same per-device key, and each follows the others live. */}
      <TerminalPlacementRow disabled={disabled} disabledReason={disabledReason} />
    </SettingsGroup>
  );
}

const SESSIONS_LAYOUT_OPTIONS: ReadonlyArray<{ value: SessionsPreviewLayout; label: string }> = [
  { value: "below", label: "Preview Below" },
  { value: "right", label: "Preview Right" },
];

function SessionsLayoutRow({ disabled, disabledReason }: { disabled: boolean; disabledReason?: string }) {
  const [layout, setLayout] = useSessionsPreviewLayout();
  return (
    <SegmentedRow
      title="Sessions Layout"
      description="Preview Right applies in windows 1100px and wider."
      options={SESSIONS_LAYOUT_OPTIONS}
      value={layout}
      disabled={disabled}
      disabledReason={disabledReason}
      onChange={(value) => setLayout(value === "right" ? "right" : "below")}
    />
  );
}

const TERMINAL_PLACEMENT_OPTIONS: ReadonlyArray<{ value: TerminalPlacement; label: string }> = [
  { value: "dock", label: "Bottom Dock" },
  { value: "panel", label: "Right Panel" },
];

function TerminalPlacementRow({ disabled, disabledReason }: { disabled: boolean; disabledReason?: string }) {
  const placement = useTerminalPlacement();
  return (
    <SegmentedRow
      title="Terminal Placement"
      description="Where terminal tabs open on this device. Running shells keep running when you switch."
      options={TERMINAL_PLACEMENT_OPTIONS}
      value={placement}
      disabled={disabled}
      disabledReason={disabledReason}
      onChange={(value) => setTerminalPlacement(value === "panel" ? "panel" : "dock")}
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
 * A setting that exists but cannot be changed here yet.
 *
 * §11.3: never hide a setting that could exist, and every disabled control carries a reason. A
 * missing section teaches a user it is not possible; a disabled one with a sentence teaches them
 * where it lives.
 */
export function PendingSetting({ title, description, reason }: { title: string; description: string; reason: string }) {
  return (
    <StaticRow
      title={title}
      description={<>{description} <Notice tone="neutral" compact>{reason}</Notice></>}
    />
  );
}

/**
 * Settings › Behavior (#3023): six groups, each naming once where its settings are kept (§11.3), so
 * no row repeats "Stored on this device." Keyboard is not a section of its own: its one row is here,
 * under Input, and `/settings/keyboard` lands on it (`focus`).
 *
 * Agent Defaults and Session Titles are slots: the shell supplies their panels' rows, and the head is
 * drawn here so the order and the scope labels are one decision.
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
      {agentHarnessDefaults && <SettingsGroup title="Agent Defaults" scope="Your Account">{agentHarnessDefaults}</SettingsGroup>}
      {sessionNaming && <SettingsGroup title="Session Titles" scope="Your Account">{sessionNaming}</SettingsGroup>}
      <ArtifactUploadSettings />
    </>
  );
}

function harnessIdentityKey(option: Pick<AgentHarnessDefaultOption, "agentId" | "driver" | "context">): string {
  return JSON.stringify([
    option.agentId,
    option.driver,
    option.context.kind,
    option.context.kind === "wsl" ? option.context.distro : "",
  ]);
}

function uniqueModels(option: AgentHarnessDefaultOption): AgentModel[] {
  const models = new Map<string, AgentModel>();
  for (const installation of option.installations) {
    for (const model of installation.models) {
      const current = models.get(model.id);
      models.set(model.id, current ? {
        ...current,
        efforts: [...new Set([...(current.efforts ?? []), ...(model.efforts ?? [])])],
      } : model);
    }
  }
  return [...models.values()].sort((left, right) =>
    (left.displayName ?? left.id).localeCompare(right.displayName ?? right.id) || left.id.localeCompare(right.id));
}

function effortsForModel(option: AgentHarnessDefaultOption, modelId: string): string[] {
  const efforts = new Set<string>();
  for (const installation of option.installations) {
    const model = installation.models.find((candidate) => candidate.id === modelId);
    if (!model) continue;
    for (const effort of model.efforts?.length ? model.efforts : installation.effortLevels) efforts.add(effort);
  }
  return [...efforts].sort();
}

function installationsSupportingDraft(
  option: AgentHarnessDefaultOption,
  draft: Pick<AgentHarnessDefaultConfig, "model" | "effort">,
): AgentHarnessDefaultOption["installations"] {
  return option.installations.filter((installation) => {
    const model = draft.model
      ? installation.models.find((candidate) => candidate.id === draft.model)
      : undefined;
    if (draft.model && !model) return false;
    const efforts = model?.efforts?.length ? model.efforts : installation.effortLevels;
    return !draft.effort || efforts.includes(draft.effort);
  });
}

function permissionModesForDraft(
  option: AgentHarnessDefaultOption,
  draft: Pick<AgentHarnessDefaultConfig, "model" | "effort">,
): string[] {
  return [...new Set(installationsSupportingDraft(option, draft)
    .flatMap((installation) => installation.permissionModes))].sort();
}

function permissionModeDisplayLabel(mode: string, driver: AgentDriverKind): string {
  const label = permissionModeLabel(mode, driver);
  return label === mode ? titleCaseLabel(mode.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ")) : label;
}

function harnessEfforts(option: AgentHarnessDefaultOption): string[] {
  return [...new Set(option.installations.flatMap((installation) => installation.effortLevels))].sort();
}

function repairDraft(
  option: AgentHarnessDefaultOption,
  candidate: AgentHarnessDefaultConfig,
): AgentHarnessDefaultConfig {
  const next = { ...candidate };
  const models = uniqueModels(option);
  if (next.model && !models.some((model) => model.id === next.model)) {
    delete next.model;
    delete next.effort;
  }
  const efforts = next.model
    ? effortsForModel(option, next.model)
    : models.length === 0 ? harnessEfforts(option) : [];
  if (next.effort && !efforts.includes(next.effort)) delete next.effort;
  if (next.permissionMode && !permissionModesForDraft(option, next).includes(next.permissionMode)) {
    delete next.permissionMode;
  }
  return next;
}

function repairedDraftFields(
  candidate: AgentHarnessDefaultConfig,
  repaired: AgentHarnessDefaultConfig,
): string[] {
  const fields: string[] = [];
  if (candidate.model && candidate.model !== repaired.model) fields.push("Model");
  if (candidate.effort && candidate.effort !== repaired.effort) fields.push("Reasoning Effort");
  if (candidate.permissionMode && candidate.permissionMode !== repaired.permissionMode) fields.push("Permission Mode");
  return fields;
}

function draftRepairNotice(fields: string[]): string | null {
  if (fields.length === 0) return null;
  const names = fields.length === 1
    ? fields[0]
    : `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}`;
  return `Capabilities changed. Removed unavailable draft selections for ${names}.`;
}

interface AgentHarnessLoadFailure {
  message: string;
  endpointMissing: boolean;
}

function agentHarnessLoadFailure(caught: unknown): AgentHarnessLoadFailure {
  const endpointMissing = caught instanceof Error &&
    "status" in caught && (caught as Error & { status?: unknown }).status === 404;
  if (endpointMissing) {
    return {
      endpointMissing: true,
      message: "This version of Wollipog does not support Agent Harness defaults. Update or restart Wollipog so it matches this dashboard, then try again.",
    };
  }
  return {
    endpointMissing: false,
    message: caught instanceof Error ? caught.message : "Could not load Agent Harness defaults.",
  };
}

function agentHarnessRefreshFailure(failure: AgentHarnessLoadFailure): string {
  return failure.endpointMissing
    ? failure.message
    : `Could not refresh Agent Harness defaults: ${failure.message}`;
}

function repairableDraft(option: AgentHarnessDefaultOption): AgentHarnessDefaultConfig {
  return repairDraft(option, option.preference ?? {});
}

function harnessDefaultSummary(option: AgentHarnessDefaultOption): string {
  if (!option.preference) return "Wollipog Default";
  const models = uniqueModels(option);
  const parts = [
    option.preference.model
      ? models.find((model) => model.id === option.preference!.model)?.displayName ?? option.preference.model
      : undefined,
    option.preference.effort ? effortLabel(option.preference.effort) : undefined,
    option.preference.permissionMode
      ? permissionModeDisplayLabel(option.preference.permissionMode, option.driver)
      : undefined,
  ].filter((part): part is string => !!part);
  const summary = parts.join(" · ") || "Wollipog Default";
  if (option.compatibleInstallations === 0) return `${summary} · Unavailable`;
  if (option.compatibleInstallations < option.installations.length) {
    return `${summary} · ${option.compatibleInstallations} of ${option.installations.length} Machines`;
  }
  return summary;
}

/** Compact per-user defaults editor. The outer row and every harness return to summaries after a
 * decision, leaving the Behavior page inspectable without permanently exposing a large form. */
export function AgentHarnessDefaultsPanel({ discoveryRevision }: { discoveryRevision?: object } = {}) {
  const api = useApi();
  const activeApi = useRef(api);
  activeApi.current = api;
  const mounted = useRef(false);
  const loadGeneration = useRef(0);
  const previousDiscoveryRevision = useRef(discoveryRevision);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const harnessRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [view, setView] = useState<AgentHarnessDefaultsView | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [draft, setDraft] = useState<AgentHarnessDefaultConfig>({});
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<AgentHarnessLoadFailure | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const controlsId = "agent-harness-defaults-editor";

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const requestIsCurrent = useCallback((requestApi: typeof api, generation?: number) =>
    mounted.current && activeApi.current === requestApi &&
      (generation === undefined || loadGeneration.current === generation), []);

  const load = useCallback(async (reset: boolean): Promise<boolean> => {
    const requestApi = api;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    if (reset) setView(null);
    try {
      const next = await requestApi.agentHarnessDefaults();
      if (!requestIsCurrent(requestApi, generation)) return false;
      if (busyRef.current) return false;
      const editingKey = editingRef.current;
      setView(next);
      if (editingKey) {
        const refreshed = next.defaults.find((option) => harnessIdentityKey(option) === editingKey);
        if (refreshed) {
          const repaired = repairDraft(refreshed, draftRef.current);
          const notice = draftRepairNotice(repairedDraftFields(draftRef.current, repaired));
          setDraft(repaired);
          if (notice) setDraftNotice(notice);
        } else {
          const editor = document.getElementById(`agent-default-${encodeURIComponent(editingKey)}`);
          const restoreFocus = !!editor?.contains(document.activeElement) ||
            harnessRowRefs.current.get(editingKey) === document.activeElement;
          setEditing(null);
          setDraft({});
          setDraftNotice(null);
          if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
        }
      }
      return true;
    } catch (caught) {
      if (!requestIsCurrent(requestApi, generation)) return false;
      setLoadError(agentHarnessLoadFailure(caught));
      return false;
    } finally {
      if (requestIsCurrent(requestApi, generation)) setLoading(false);
    }
  }, [api, requestIsCurrent]);

  useEffect(() => {
    setView(null);
    setExpanded(false);
    setEditing(null);
    setDraft({});
    setDraftNotice(null);
    busyRef.current = false;
    setBusy(false);
    setMutationError(null);
    void load(true);
    return () => { loadGeneration.current += 1; };
  }, [api, load]);

  useEffect(() => {
    if (Object.is(previousDiscoveryRevision.current, discoveryRevision)) return;
    previousDiscoveryRevision.current = discoveryRevision;
    if (viewRef.current) void load(false);
  }, [discoveryRevision, load]);

  const customized = view?.defaults.filter((option) => option.preference).length ?? 0;
  const refreshFailure = loadError ? agentHarnessRefreshFailure(loadError) : null;
  const mutationRecoveryAnnouncement = mutationError && refreshFailure ? ` ${refreshFailure}` : null;
  const summary = !view
    ? loadError
      ? loadError.endpointMissing ? "Wollipog update required." : "Agent Harness defaults could not be loaded."
      : "Loading Agent Harness defaults…"
    : `${customized} Harness Default${customized === 1 ? "" : "s"} Configured`;
  const beginEdit = (option: AgentHarnessDefaultOption) => {
    setEditing(harnessIdentityKey(option));
    setDraft(repairableDraft(option));
    setDraftNotice(null);
    setMutationError(null);
  };
  const focusHarnessRow = (key: string) => {
    requestAnimationFrame(() => (harnessRowRefs.current.get(key) ?? triggerRef.current)?.focus());
  };
  const restoreFocusIfLost = (target: () => HTMLElement | null | undefined) => {
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) target()?.focus();
    });
  };
  const closeEditor = (key: string) => {
    setEditing(null);
    setDraft({});
    setDraftNotice(null);
    setMutationError(null);
    focusHarnessRow(key);
  };
  const invalidateLoads = () => {
    loadGeneration.current += 1;
    setLoading(false);
    setLoadError(null);
  };
  const finish = (next: AgentHarnessDefaultsView, key: string) => {
    const editor = document.getElementById(`agent-default-${encodeURIComponent(key)}`);
    const restoreFocus = document.activeElement === document.body || !!editor?.contains(document.activeElement);
    invalidateLoads();
    setView(next);
    busyRef.current = false;
    setBusy(false);
    setEditing(null);
    setDraft({});
    setDraftNotice(null);
    setMutationError(null);
    if (restoreFocus) focusHarnessRow(key);
  };
  const fail = (caught: unknown, action: HTMLButtonElement) => {
    busyRef.current = false;
    setBusy(false);
    setMutationError(caught instanceof Error ? caught.message : "Could not save the Agent Harness default.");
    restoreFocusIfLost(() => action);
    void load(false);
  };

  return (
    <>
      <LinkRow
        title="Default Models, Efforts, and Permissions"
        description={summary}
        expanded={expanded}
        controls={expanded && view ? controlsId : undefined}
        disabled={!view || busy}
        buttonRef={triggerRef}
        onClick={() => {
          setExpanded((current) => !current);
          setEditing(null);
          setDraft({});
          setDraftNotice(null);
          setMutationError(null);
        }}
      />
      {loadError && !view && (
        <StaticRow
          title={loadError.endpointMissing ? "Wollipog Update Required" : "Load Failed"}
          description={
            <>
              {loadError.endpointMissing ? loadError.message : "Agent Harness defaults could not be loaded."}{" "}
              <button ref={retryRef} type="button" className="btn ghost sm" disabled={loading} onClick={(event) => {
                const retry = event.currentTarget;
                const restoreFocus = document.activeElement === retry;
                void load(true).then((loaded) => {
                  if (restoreFocus) restoreFocusIfLost(() => loaded ? triggerRef.current : retryRef.current);
                });
              }}>
                {loading ? "Retrying…" : "Retry"}
              </button>
            </>
          }
        />
      )}
      {expanded && view && (
        <div id={controlsId} className="agent-defaults-list" aria-busy={loading || busy || undefined}>
          <div className="toolbar">
            {loadError && (
              <Notice tone="danger" compact role={mutationError ? undefined : "alert"} ariaHidden={Boolean(mutationError)}>
                {refreshFailure}
              </Notice>
            )}
            {mutationError && !editing && (
              <Notice tone="danger" compact role="alert">
                {mutationError}
                {mutationRecoveryAnnouncement && <span className="sr-only">{mutationRecoveryAnnouncement}</span>}
              </Notice>
            )}
            <span className="agent-defaults-action-spacer" />
            <button type="button" className="btn ghost sm" disabled={loading || busy} onClick={(event) => {
              const refresh = event.currentTarget;
              const restoreFocus = document.activeElement === refresh;
              void load(false).then(() => {
                if (restoreFocus) restoreFocusIfLost(() => refresh);
              });
            }}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {view.defaults.length === 0 && (
            <p className="field-helper agent-defaults-empty">No discovered Agent Harnesses are available yet.</p>
          )}
          {view.defaults.map((option) => {
            const key = harnessIdentityKey(option);
            const isEditing = editing === key;
            const models = uniqueModels(option);
            const efforts = draft.model
              ? effortsForModel(option, draft.model)
              : models.length === 0 ? harnessEfforts(option) : [];
            const permissionModes = permissionModesForDraft(option, draft);
            const configurable = models.length > 0 || permissionModes.length > 0 ||
              option.installations.some((installation) => installation.effortLevels.length > 0);
            const validDraft = !!(draft.model || draft.effort || draft.permissionMode) &&
              (!draft.model || efforts.length === 0 || !!draft.effort);
            return (
              <div className="agent-defaults-item" key={key}>
                <LinkRow
                  title={option.name}
                  description={harnessDefaultSummary(option)}
                  expanded={isEditing}
                  disabled={busy}
                  controls={isEditing ? `agent-default-${encodeURIComponent(key)}` : undefined}
                  buttonRef={(node) => {
                    if (node) harnessRowRefs.current.set(key, node);
                    else harnessRowRefs.current.delete(key);
                  }}
                  onClick={() => {
                    if (isEditing) {
                      setEditing(null);
                      setDraft({});
                      setDraftNotice(null);
                      setMutationError(null);
                    } else {
                      beginEdit(option);
                    }
                  }}
                />
                {isEditing && (
                  <div id={`agent-default-${encodeURIComponent(key)}`} className="agent-defaults-editor">
                    {!configurable && (
                      <p className="field-helper">This Agent Harness advertises no configurable models, efforts, or permission modes.</p>
                    )}
                    {option.installations.length === 0 && (
                      <Notice tone="warning" compact role="status">This saved Agent Harness is no longer discovered. Reset it to use the Wollipog default.</Notice>
                    )}
                    <p
                      className={`agent-defaults-draft-notice${draftNotice ? "" : " sr-only"}`}
                      role="status"
                      aria-atomic="true"
                    >
                      {draftNotice ?? ""}
                    </p>
                    {models.length > 0 && (
                      <label className="agent-defaults-field">
                        <span>Model</span>
                        <Select
                          label={`${option.name} Model`}
                          options={models.map((model) => ({ value: model.id, label: model.displayName ?? model.id }))}
                          value={draft.model ?? null}
                          placeholder="Choose Model…"
                          onChange={(model) => {
                            setDraftNotice(null);
                            const nextEfforts = effortsForModel(option, model);
                            setDraft((current) => {
                              const next = { ...current, model };
                              if (next.effort && !nextEfforts.includes(next.effort)) delete next.effort;
                              if (next.permissionMode && !permissionModesForDraft(option, next).includes(next.permissionMode)) {
                                delete next.permissionMode;
                              }
                              return next;
                            });
                          }}
                        />
                      </label>
                    )}
                    {(draft.model || models.length === 0) && efforts.length > 0 && (
                      <label className="agent-defaults-field">
                        <span>Reasoning Effort</span>
                        <Select
                          label={`${option.name} Reasoning Effort`}
                          options={efforts.map((effort) => ({ value: effort, label: effortLabel(effort) }))}
                          value={draft.effort ?? null}
                          placeholder="Choose Effort…"
                          onChange={(effort) => {
                            setDraftNotice(null);
                            setDraft((current) => {
                              const next = { ...current, effort };
                              if (next.permissionMode && !permissionModesForDraft(option, next).includes(next.permissionMode)) {
                                delete next.permissionMode;
                              }
                              return next;
                            });
                          }}
                        />
                      </label>
                    )}
                    {permissionModes.length > 0 && (
                      <label className="agent-defaults-field">
                        <span>Permission Mode</span>
                        <Select
                          label={`${option.name} Permission Mode`}
                          options={permissionModes.map((mode) => ({
                            value: mode,
                            label: permissionModeDisplayLabel(mode, option.driver),
                          }))}
                          value={draft.permissionMode ?? null}
                          placeholder="Choose Permission Mode…"
                          onChange={(permissionMode) => {
                            setDraftNotice(null);
                            setDraft((current) => ({ ...current, permissionMode }));
                          }}
                        />
                      </label>
                    )}
                    {mutationError && (
                      <Notice tone="danger" compact role="alert">
                        {mutationError}
                        {mutationRecoveryAnnouncement && <span className="sr-only">{mutationRecoveryAnnouncement}</span>}
                      </Notice>
                    )}
                    <div className="agent-defaults-actions">
                      {option.preference && (
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busy}
                          onClick={(event) => {
                            const action = event.currentTarget;
                            const requestApi = api;
                            invalidateLoads();
                            busyRef.current = true;
                            setBusy(true);
                            setMutationError(null);
                            void requestApi.deleteAgentHarnessDefault({
                              agentId: option.agentId,
                              driver: option.driver,
                              context: option.context,
                            }).then((next) => {
                              if (requestIsCurrent(requestApi)) finish(next, key);
                            }).catch((caught: unknown) => {
                              if (requestIsCurrent(requestApi)) fail(caught, action);
                            });
                          }}
                        >Use Wollipog Default</button>
                      )}
                      <span className="agent-defaults-action-spacer" />
                      <button type="button" className="btn sm" disabled={busy} onClick={() => closeEditor(key)}>Cancel</button>
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={busy || !validDraft || option.installations.length === 0}
                        onClick={(event) => {
                          const action = event.currentTarget;
                          const requestApi = api;
                          invalidateLoads();
                          busyRef.current = true;
                          setBusy(true);
                          setMutationError(null);
                          void requestApi.updateAgentHarnessDefault({
                            agentId: option.agentId,
                            driver: option.driver,
                            context: option.context,
                            config: draft,
                          }).then((next) => {
                            if (requestIsCurrent(requestApi)) finish(next, key);
                          }).catch((caught: unknown) => {
                            if (requestIsCurrent(requestApi)) fail(caught, action);
                          });
                        }}
                      >Save</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

const SESSION_NAMING_OPTIONS: ReadonlyArray<{
  value: SessionNamingMode;
  label: string;
  description: string;
}> = [
  {
    value: "prompt_text_only",
    label: "Prompt Text Only",
    description: "Use the first completed user message. No model or provider credentials are required.",
  },
  {
    value: "session_agent_account",
    label: "Agent Harness",
    description: "Use a selected Machine's authenticated Agent Harness, model, and reasoning effort.",
  },
  {
    value: "custom_model_endpoint",
    label: "Custom Model Endpoint",
    description: "Send selected session text to the operator-configured OpenAI-compatible endpoint.",
  },
];

/** Organization-scoped semantic naming choice. The API projection is deliberately secret-free:
 * the panel can report whether a bearer key exists but never receives its value. */
export function SessionNamingPanel() {
  const { confirm } = useFeedback();
  const api = useApi();
  const activeApi = useRef(api);
  activeApi.current = api;
  const mounted = useRef(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [settings, setSettings] = useState<SessionNamingSettingsView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ action: "load" | "save"; message: string } | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [draftMode, setDraftMode] = useState<SessionNamingMode>("prompt_text_only");
  const [runnerId, setRunnerId] = useState("");
  const [agentKey, setAgentKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const [customBusy, setCustomBusy] = useState(false);
  const [customStatus, setCustomStatus] = useState<string | null>(null);
  const [customRunnerId, setCustomRunnerId] = useState("");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [customTimeout, setCustomTimeout] = useState("5000");
  const timeoutUnitId = `${useId()}-timeout-unit`;
  const [customApiKey, setCustomApiKey] = useState("");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let disposed = false;
    setSettings(null);
    setBusy(false);
    setError(null);
    setCustomBusy(false);
    setCustomStatus(null);
    setCustomEndpoint("");
    setCustomApiKey("");
    void api.sessionNamingSettings().then((next) => {
      if (!disposed) {
        setSettings(next);
        setDraftMode(next.mode);
      }
    }).catch((cause: unknown) => {
      if (!disposed) setError({ action: "load", message: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { disposed = true; };
  }, [api, loadRevision]);

  const resetDraft = (next: SessionNamingSettingsView) => {
    setDraftMode(next.mode);
    setRunnerId(next.harnessTarget?.runnerId ?? "");
    setAgentKey(next.harnessTarget?.agentId ?? "");
    setModelId(next.harnessTarget?.model ?? "");
    setEffort(next.harnessTarget?.effort ?? "");
    setCustomRunnerId(next.customModel?.runnerId ?? next.customModelTargets?.find((target) => target.available)?.runnerId ?? "");
    setCustomModel(next.customModel?.configurationSource === "runner" ? next.customModel.model : "");
    setCustomTimeout(String(next.customModel?.configurationSource === "runner" ? next.customModel.timeoutMs : 5_000));
    setCustomEndpoint("");
    setCustomApiKey("");
    setCustomStatus(null);
  };

  const collapseEditor = () => {
    if (settings) resetDraft(settings);
    setExpanded(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const toggleEditor = () => {
    if (expanded) {
      collapseEditor();
      return;
    }
    if (!settings) return;
    resetDraft(settings);
    setError(null);
    setExpanded(true);
  };

  const options = SESSION_NAMING_OPTIONS.map((option) => {
    const availability = settings?.modes[option.value];
    const disabledReason = !settings
      ? error?.action === "load"
        ? "Session naming settings could not be loaded."
        : "Loading the organization setting."
      : !settings.canManage
        ? "Organization owner or admin permission is required."
        : availability?.reason;
    return {
      ...option,
      disabled: !settings || !settings.canManage || (
        option.value === "session_agent_account"
          ? !settings.harnessMachines?.length && !availability?.available
          : option.value === "custom_model_endpoint"
            ? !settings.customModelTargets?.length && !availability?.available
            : !availability?.available
      ),
      ...(disabledReason ? { disabledReason } : {}),
    };
  });
  const custom = settings?.customModel;
  const machine = settings?.harnessMachines?.find((candidate) => candidate.runnerId === runnerId);
  const harness = machine?.harnesses.find((candidate) => candidate.agentId === agentKey);
  const harnessModel = harness?.models.find((candidate) => candidate.id === modelId);
  const initialCustomRunnerId = custom?.configurationSource === "runner"
    ? custom.runnerId ?? ""
    : settings?.customModelTargets?.find((target) => target.available)?.runnerId ?? "";
  const initialCustomModel = custom?.configurationSource === "runner" ? custom.model : "";
  const initialCustomTimeout = String(custom?.configurationSource === "runner" ? custom.timeoutMs : 5_000);
  const customDraftChanged = customRunnerId !== initialCustomRunnerId || customEndpoint !== "" ||
    customModel !== initialCustomModel || customTimeout !== initialCustomTimeout || customApiKey !== "";
  const customTimeoutValue = Number(customTimeout);
  const customFormComplete = Boolean(customRunnerId && customEndpoint && customModel &&
    Number.isInteger(customTimeoutValue) && customTimeoutValue >= 250 && customTimeoutValue <= 30_000);
  const legacyFollowAvailable = draftMode === "session_agent_account" && !settings?.harnessTarget &&
    !settings?.harnessMachines?.length && settings?.modes.session_agent_account.available === true;
  const requestIsCurrent = (requestApi: typeof api) => mounted.current && activeApi.current === requestApi;
  const applyCustomSettings = (next: SessionNamingSettingsView, message: string) => {
    setSettings(next);
    setCustomRunnerId(next.customModel?.runnerId ?? customRunnerId);
    setCustomModel(next.customModel?.model ?? customModel);
    setCustomTimeout(String(next.customModel?.timeoutMs ?? customTimeout));
    setCustomApiKey("");
    setCustomStatus(message);
  };
  const finishSave = (next: SessionNamingSettingsView) => {
    setSettings(next);
    resetDraft(next);
    setExpanded(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const save = () => {
    if (!settings || !settings.canManage || busy || customBusy || !saveComplete) return;
    const requestApi = api;
    setBusy(true);
    setError(null);
    setCustomStatus(null);
    const operation = draftMode === "session_agent_account" && machine && harness && harnessModel && effort
      ? requestApi.configureSessionNamingHarness({
          runnerId: machine.runnerId,
          agentId: harness.agentId,
          driver: harness.driver,
          model: harnessModel.id,
          effort,
        })
      : draftMode === "custom_model_endpoint" && customDraftChanged && customFormComplete
        ? requestApi.configureSessionNamingCustomModel({
            runnerId: customRunnerId,
            endpoint: customEndpoint,
            model: customModel,
            timeoutMs: Number(customTimeout),
            ...(customApiKey ? { apiKey: customApiKey } : {}),
          })
        : requestApi.updateSessionNamingSettings({ mode: draftMode });
    void operation.then((next) => {
      if (!requestIsCurrent(requestApi)) return;
      finishSave(next);
    }).catch((cause: unknown) => {
      if (requestIsCurrent(requestApi)) {
        setError({ action: "save", message: cause instanceof Error ? cause.message : String(cause) });
      }
    }).finally(() => {
      if (requestIsCurrent(requestApi)) {
        setCustomApiKey("");
        setBusy(false);
      }
    });
  };
  const replaceApiKey = () => {
    if (busy || customBusy || !customApiKey) return;
    const requestApi = api;
    setCustomBusy(true);
    setCustomStatus(null);
    void requestApi.replaceSessionNamingCustomModelApiKey({ apiKey: customApiKey }).then((next) => {
      if (requestIsCurrent(requestApi)) applyCustomSettings(next, "API key replaced on the selected Machine.");
    }).catch((cause: unknown) => {
      if (requestIsCurrent(requestApi)) {
        setCustomStatus(`Could not replace the API key: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }).finally(() => {
      if (requestIsCurrent(requestApi)) {
        setCustomApiKey("");
        setCustomBusy(false);
      }
    });
  };
  const deleteApiKey = async () => {
    if (busy || customBusy) return;
    if (!await confirm({
      title: "Delete API Key",
      message: "The API key is deleted from the selected machine, and endpoints that require it stop working. This cannot be undone.",
      confirmLabel: "Delete API Key",
      tone: "danger",
    })) return;
    const requestApi = api;
    setCustomBusy(true);
    setCustomStatus(null);
    void requestApi.deleteSessionNamingCustomModelApiKey().then((next) => {
      if (requestIsCurrent(requestApi)) applyCustomSettings(next, "API key deleted from the selected Machine.");
    }).catch((cause: unknown) => {
      if (requestIsCurrent(requestApi)) {
        setCustomStatus(`Could not delete the API key: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }).finally(() => { if (requestIsCurrent(requestApi)) setCustomBusy(false); });
  };
  const testCustom = () => {
    if (busy || customBusy) return;
    const requestApi = api;
    setCustomBusy(true);
    setCustomStatus(null);
    void requestApi.testSessionNamingCustomModel().then((result) => {
      if (requestIsCurrent(requestApi)) {
        setCustomStatus(result.ok
          ? "Connection succeeded."
          : `Connection failed (${result.status.replace(/_/g, " ")}).`);
      }
    }).catch((cause: unknown) => {
      if (requestIsCurrent(requestApi)) {
        setCustomStatus(`Could not test the connection: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }).finally(() => { if (requestIsCurrent(requestApi)) setCustomBusy(false); });
  };
  const billingSourceLabel = (value: string) => value === "api"
    ? "API"
    : value.split("_").map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
  const summary = !settings
    ? "Loading…"
    : settings.mode === "prompt_text_only"
      ? "Prompt Text Only"
      : settings.mode === "custom_model_endpoint"
        ? `Custom Model Endpoint${settings.customModel ? ` · ${settings.customModel.endpointOrigin}` : " · Not Configured"}`
        : settings.harnessTarget
          ? `${settings.harnessTarget.harnessName} · ${settings.harnessTarget.modelName} · ${effortLabel(settings.harnessTarget.effort)}`
          : "Follow Session Agent";
  const summaryStatus = error
    ? `Could not ${error.action} session naming: ${error.message}`
    : settings?.mode !== settings?.effectiveMode
      ? `${settings?.mode === "session_agent_account"
          ? settings.harnessTarget?.reason ?? settings.modes.session_agent_account.reason
          : settings?.modes[settings.mode].reason ?? "The selected configuration is unavailable."} New sessions fall back to prompt-derived naming.`
      : summary;
  const saveComplete = draftMode === "prompt_text_only" ||
    (draftMode === "session_agent_account" && (legacyFollowAvailable || Boolean(machine && harness && harnessModel && effort))) ||
    (draftMode === "custom_model_endpoint" && (customDraftChanged ? customFormComplete : Boolean(custom)));

  // Rows only: Behavior draws the Session Titles group around them (#3023).
  return (
    <>
      <LinkRow
        title="Session Naming"
        description={summaryStatus}
        disabled={!settings || busy || customBusy}
        expanded={expanded}
        controls={expanded ? "session-naming-editor" : undefined}
        buttonRef={triggerRef}
        onClick={toggleEditor}
      />
      {error?.action === "load" && (
        <StaticRow
          title="Load Failed"
          description={
            <>
              The organization setting could not be loaded.{" "}
              <button type="button" className="btn ghost sm" onClick={() => setLoadRevision((value) => value + 1)}>
                Retry
              </button>
            </>
          }
        />
      )}
      {expanded && settings && (
        <div id="session-naming-editor" className="session-naming-editor" aria-busy={busy || customBusy || undefined}>
          <SelectRow
            title="Naming Mode"
            options={options}
            value={draftMode}
            disabled={busy || customBusy}
            onChange={(value) => {
              setDraftMode(value as SessionNamingMode);
              setRunnerId("");
              setAgentKey("");
              setModelId("");
              setEffort("");
              setCustomStatus(null);
            }}
            menuWidth={460}
            estimatedOptionHeight={72}
          />
          {!settings.canManage && (
            <p className="field-helper">Organization owner or admin permission is required to change this setting.</p>
          )}
          {draftMode === "session_agent_account" && legacyFollowAvailable && (
            <p className="field-helper">
              Each session will use its own Machine and authenticated Agent Harness without changing its billing boundary.
            </p>
          )}
          {draftMode === "session_agent_account" && !legacyFollowAvailable && (
            <SelectRow
              title="Machine"
              description="Bounded session text is sent to this Machine and its provider for title generation."
              options={(settings.harnessMachines ?? []).map((candidate) => ({
                value: candidate.runnerId,
                label: candidate.machineName,
              }))}
              value={runnerId}
              disabled={!settings.canManage || busy || customBusy}
              onChange={(value) => {
                setRunnerId(value);
                setAgentKey("");
                setModelId("");
                setEffort("");
              }}
            />
          )}
          {draftMode === "session_agent_account" && machine && (
            <SelectRow
              title="Agent Harness"
              options={machine.harnesses.map((candidate) => ({
                value: candidate.agentId,
                label: candidate.name,
                description: `${candidate.provider === "codex" ? "Codex" : "Claude"} · ${billingSourceLabel(candidate.billingSource)}`,
              }))}
              value={agentKey}
              disabled={!settings.canManage || busy || customBusy}
              onChange={(value) => {
                setAgentKey(value);
                setModelId("");
                setEffort("");
              }}
            />
          )}
          {draftMode === "session_agent_account" && harness && (
            <SelectRow
              title="Model"
              options={harness.models.map((candidate) => ({ value: candidate.id, label: candidate.displayName }))}
              value={modelId}
              disabled={!settings.canManage || busy || customBusy}
              onChange={(value) => {
                setModelId(value);
                setEffort("");
              }}
            />
          )}
          {draftMode === "session_agent_account" && harnessModel && (
            <SelectRow
              title="Reasoning Effort"
              options={harnessModel.efforts.map((value) => ({ value, label: effortLabel(value) }))}
              value={effort}
              disabled={!settings.canManage || busy || customBusy}
              onChange={setEffort}
            />
          )}
          {draftMode === "custom_model_endpoint" && (
            <>
          <div className="session-naming-custom-fields">
            <label className="field">
              <span>Machine</span>
              <Select
                label="Machine"
                value={customRunnerId || null}
                disabled={!settings.canManage || busy || customBusy}
                placeholder="Select a Machine"
                options={(settings.customModelTargets ?? []).map((target) => ({
                  value: target.runnerId,
                  label: target.machineName,
                  disabled: !target.available,
                  disabledReason: target.available ? undefined : target.reason ?? "Unavailable",
                }))}
                onChange={setCustomRunnerId}
              />
            </label>
            <label className="field">
              <span>Endpoint</span>
              <input
                aria-label="Endpoint"
                type="url"
                maxLength={2048}
                value={customEndpoint}
                placeholder={custom?.configurationSource === "runner" ? custom.endpointOrigin : "https://models.example/v1/chat/completions"}
                disabled={!settings.canManage || busy || customBusy}
                onChange={(event) => setCustomEndpoint(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Model</span>
              <input
                aria-label="Model"
                maxLength={200}
                value={customModel}
                disabled={!settings.canManage || busy || customBusy}
                onChange={(event) => setCustomModel(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Timeout</span>
              <span className="input-affix">
                <input
                  aria-label="Timeout"
                  aria-describedby={timeoutUnitId}
                  type="number"
                  min={250}
                  max={30000}
                  value={customTimeout}
                  disabled={!settings.canManage || busy || customBusy}
                  onChange={(event) => setCustomTimeout(event.target.value)}
                />
                <span className="input-affix-text" id={timeoutUnitId}>ms</span>
              </span>
            </label>
            <label className="field session-naming-key-field">
              <span>API Key</span>
              <input
                aria-label="API Key"
                type="password"
                autoComplete="off"
                value={customApiKey}
                placeholder={custom?.apiKeyConfigured ? "Enter a replacement key" : "Optional for endpoints without authentication"}
                disabled={!settings.canManage || busy || customBusy}
                onChange={(event) => setCustomApiKey(event.target.value)}
              />
            </label>
          </div>
          <p className="field-helper">
            The API key is sent once to the selected Machine and is never returned to this browser or stored by the control plane.
            {" "}When this mode is active, bounded session text is sent through that Machine to the configured provider.
          </p>
          {custom?.configurationSource === "runner" && customDraftChanged && !customEndpoint && (
            <p className="field-helper">Re-enter the complete endpoint URL to change this saved configuration.</p>
          )}
          <div className="session-naming-custom-actions">
            <button
              type="button"
              className="btn ghost sm"
              disabled={!settings.canManage || busy || customBusy || custom?.configurationSource !== "runner" ||
                custom.online === false || !customApiKey}
              onClick={replaceApiKey}
            >
              Replace API Key
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={!settings.canManage || busy || customBusy || custom?.configurationSource !== "runner" ||
                custom.online === false || !custom.apiKeyConfigured}
              onClick={() => void deleteApiKey()}
            >
              Delete API Key
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={!settings.canManage || busy || customBusy || custom?.configurationSource !== "runner" || custom.online === false}
              onClick={testCustom}
            >
              Test Connection
            </button>
          </div>
          {customStatus && <p role="status" className="field-helper">{customStatus}</p>}
            </>
          )}
          {error?.action === "save" && <p role="alert" className="field-helper">{summaryStatus}</p>}
          <div className="session-naming-actions">
            <button type="button" className="btn sm" disabled={!settings.canManage || !saveComplete || busy || customBusy} onClick={save}>
              Save Configuration
            </button>
            <button type="button" className="btn ghost sm" disabled={busy || customBusy} onClick={collapseEditor}>
              Cancel
            </button>
          </div>
        </div>
      )}
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
 * off does, so each row says only what its feature is.
 */
export function ExperimentalPanel({
  flags,
  onToggle,
}: {
  flags: ExperimentFlags;
  onToggle: (id: ExperimentId, enabled: boolean) => void;
}) {
  return (
    <SettingsGroup>
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

/** `update` is the shell's state (see `useDesktopUpdateSetting`); absent, this is a browser. */
export function AboutPanel({ update }: { update?: DesktopUpdateSetting } = {}) {
  const controlPlaneVersion = useControlPlaneVersion();
  return (
    <SettingsGroup>
      <dl className="facts">
        {update?.status && <><dt>Desktop App</dt><dd>{update.status.currentVersion}</dd></>}
        <dt>Control Plane</dt>
        <dd>{controlPlaneVersion === undefined ? "Reading…" : controlPlaneVersion ?? "Not reported"}</dd>
        <dt>Protocol</dt><dd>{PROTOCOL_VERSION}</dd>
      </dl>
      {update?.desktop ? (
        <DesktopUpdateRows update={update} />
      ) : (
        <PendingSetting
          title="Updates"
          description="Whether this build is current."
          reason="This dashboard is served by its control plane and updates when that control plane is upgraded."
        />
      )}
      <PendingSetting
        title="Open-Source Licenses"
        description="What Wollipog is built on."
        reason="Not compiled into the app yet; see THIRD-PARTY-NOTICES in the repository."
      />
    </SettingsGroup>
  );
}

/**
 * The version of the control plane this window talks to, from its authenticated instance probe.
 *
 * `undefined` while reading and `null` when it did not say — an older control plane without the
 * probe, or a failed read. The desktop app and the control plane can differ: a desktop window may be
 * connected to a remote server, and updating the app never updates that server.
 */
function useControlPlaneVersion(): string | null | undefined {
  const api = useApi();
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    setVersion(undefined);
    api.instanceInfo()
      .then((info) => { if (!disposed) setVersion(typeof info?.appVersion === "string" && info.appVersion ? info.appVersion : null); })
      .catch(() => { if (!disposed) setVersion(null); });
    return () => { disposed = true; };
  }, [api]);
  return version;
}

function formatCheckedAt(checkedAt: number): string {
  return new Date(checkedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * #1646. What the shell last learned about published releases, and the one action that fits it.
 *
 * Installing restarts the app, so a first attempt while work is in flight is held by the shell and
 * becomes the Restart to Install Update confirmation the update toast opens too (#1975). Nothing
 * here shows the hold: Install Later leaves this row offering Install and Restart as it was.
 */
function DesktopUpdateRows({ update }: { update: DesktopUpdateSetting }) {
  const { status } = update;
  if (!status) {
    return (
      <StaticRow
        title="Updates"
        description={update.loading
          ? "Reading the update status…"
          : `Could not read the update status: ${update.error ?? "the desktop app did not answer."}`}
      />
    );
  }
  const busy = update.checking || update.installing || update.savingPrerelease;
  const check = (label: string) => (
    <button type="button" className="btn ghost sm" disabled={busy} onClick={update.check}>
      {update.checking ? "Checking…" : label}
    </button>
  );
  const lastCheck = status.lastCheck;
  let description: ReactNode;
  if (!status.checksAllowed) {
    description = "Update checks are turned off for this installation by WOLLIPOG_DISABLE_UPDATE_CHECK.";
  } else if (update.installing) {
    description = "Downloading and verifying the update. Wollipog restarts when it is installed.";
  } else if (lastCheck?.state === "available") {
    description = status.install.mode === "inPlace" ? (
      <>
        {availableUpdateMessage(lastCheck.version)} Installing restarts Wollipog, which stops its local
        control plane and runner.{" "}
        <button type="button" className="btn sm" onClick={update.install}>Install and Restart</button>{" "}
        {check("Check Again")}
      </>
    ) : (
      <>
        {availableUpdateMessage(lastCheck.version)} {status.install.reason}{" "}
        <button type="button" className="btn sm" onClick={update.openRelease}>Open Release Page</button>{" "}
        {check("Check Again")}
      </>
    );
  } else if (lastCheck?.state === "current") {
    description = (
      <>
        {status.currentVersion.includes("-") || status.prereleaseUpdates
          ? `No newer release is available on the ${status.prereleaseUpdates ? "pre-release" : "stable"} channel.`
          : `Wollipog ${status.currentVersion} is the latest release.`} Checked {formatCheckedAt(lastCheck.checkedAt)}.{" "}
        {check("Check Again")}
      </>
    );
  } else {
    description = <>Not checked yet. {check("Check for Updates")}</>;
  }
  return (
    <>
      <StaticRow
        title="Updates"
        description={
          <>
            {description}
            {update.error && <Notice tone="danger" compact role="alert">{update.error}</Notice>}
          </>
        }
      />
      <SwitchRow
        title="Check for Updates Automatically"
        description={status.checksAllowed
          ? "Look for a newer published release while Wollipog is open."
          : "Turned off for this installation."}
        checked={status.automaticChecks && status.checksAllowed}
        busy={update.savingAutomatic}
        disabled={!status.checksAllowed}
        onClick={update.toggleAutomatic}
      />
      {status.prereleaseUpdates !== undefined && <SwitchRow
        title="Pre-Release Updates"
        description="Include early versions that may be less reliable. Turning this off waits for a newer stable release; it does not downgrade Wollipog."
        checked={status.prereleaseUpdates}
        busy={update.savingPrerelease}
        disabled={update.checking || update.installing}
        onClick={update.togglePrerelease}
      />}
    </>
  );
}

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
