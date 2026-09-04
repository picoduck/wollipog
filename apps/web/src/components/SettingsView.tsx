import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { notifier } from "../notify.js";
import { tailnetAccessDescription, type TailnetAccessSetting } from "../tailnet-access.js";
import { type PushSetting } from "../push.js";
import { ArrowDownIcon, ArrowUpIcon, KeyboardIcon } from "./Icons.js";
import { VIEW_ICONS } from "./Rail.js";
import {
  REQUIRED_RAIL_VIEWS,
  moveRailView,
  railDigits,
  railPreferencesAreDefault,
  resetRailPreferences,
  setRailViewHidden,
  visibleRailViews,
} from "../rail-preferences.js";
import { useRailPreferences } from "../use-rail-preferences.js";
import { useInstanceScope } from "../instance-scope.js";
import { experimentForViewName } from "../experiments.js";
import { useExperiments } from "../use-experiments.js";
import { GLOBAL_VIEW_ITEMS } from "../navigation.js";
import { NavRow, SegmentedRow, SelectRow, StaticRow, SwitchRow } from "./ui/SettingsRows.js";
import { Select } from "./ui/ChoiceControls.js";
import { SCHEME_SWATCHES, type ColorScheme, type ResolvedTheme } from "../theme.js";
import { setEnterKeyBehavior, useEnterKeyBehavior, type EnterKeyBehavior } from "../enter-key.js";
import {
  setQuestionResponseStyle,
  useQuestionResponseStyle,
  type QuestionResponseStyle,
} from "../question-response-style.js";
import { SETTINGS_SECTIONS, type SettingsSection, type View } from "../navigation.js";
import type { ExperimentFlags, ExperimentId } from "../experiments.js";
import { effortLabel, permissionModeLabel, titleCaseLabel } from "../format.js";

/**
 * Settings as a ROUTE, not a dialog.
 *
 * §11.3's argument, and every part of it was a live defect: a dialog cannot be linked to, so
 * "see Settings → Appearance" is not a thing you can send anyone; it cannot be opened in a second
 * tab; it loses its place on every 760px crossing, which is why `App` had to hoist its open state
 * out of both layouts; and the shortcut reference had to CLOSE it and open a second modal, because
 * a dialog inside a dialog is a focus trap inside a focus trap.
 *
 * The master/detail shape is the one `ProjectsView` already establishes — a section list beside the
 * content, collapsing to a stack on a phone — so this is a layout the app already knows rather than
 * a new one.
 */

export interface SettingsViewProps {
  section: SettingsSection;
  onNavigate: (view: View) => void;
  onOpenShortcuts: (returnFocus: HTMLElement | null) => void;
  /** Each section's content, supplied by the shell that owns the underlying state. */
  panels: Record<SettingsSection, ReactNode>;
}

export function SettingsView({ section, onNavigate, panels }: SettingsViewProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Back/Forward between sections swaps `panels[current.id]`. If the focused control was inside the
  // outgoing panel it is now detached and focus is on <body>. Focusing the heading only in that
  // case keeps link-driven navigation as it is — the link keeps focus, and its `aria-current`
  // change is what announces the move.
  //
  // And only on an actual section CHANGE. Arriving at /settings/network directly leaves focus on
  // <body> legitimately; focusing the heading there put the first Tab after all six section links.
  const previousSection = useRef(section);
  useEffect(() => {
    if (previousSection.current === section) return;
    previousSection.current = section;
    const active = document.activeElement;
    if (active && active !== document.body && (active as HTMLElement).isConnected) return;
    headingRef.current?.focus();
  }, [section]);
  const current = SETTINGS_SECTIONS.find((entry) => entry.id === section) ?? SETTINGS_SECTIONS[0]!;
  return (
    <div className="settings-view main-body">
      {/* A `tablist` would be wrong: these are ROUTES, and each one is a link a person can copy,
          bookmark, or open in a new tab. A tab swaps a panel; this navigates. */}
      <nav className="settings-sections" aria-label="Settings Sections">
        {SETTINGS_SECTIONS.map((entry) => (
          <a
            key={entry.id}
            className={`settings-section-link${entry.id === current.id ? " active" : ""}`}
            href={`/settings/${entry.id}`}
            aria-current={entry.id === current.id ? "page" : undefined}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onNavigate({ name: "settings", section: entry.id });
            }}
          >
            {entry.title}
          </a>
        ))}
      </nav>
      <section className="settings-panel" aria-labelledby="settings-panel-heading">
        <h2 id="settings-panel-heading" ref={headingRef} tabIndex={-1}>{current.title}</h2>
        {panels[current.id]}
      </section>
    </div>
  );
}

/** One group of rows inside a panel, with its own heading. */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = `settings-group-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section className="settings-group" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <div className="settings-options">{children}</div>
    </section>
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
        title="Colour Scheme"
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
    </SettingsGroup>
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
 */
export function NavigationRailPanel() {
  const instanceScope = useInstanceScope();
  const preferences = useRailPreferences();
  const { flags } = useExperiments();
  const digits = railDigits(visibleRailViews(preferences, flags));
  return (
    <SettingsGroup title="Navigation">
      <ul className="rail-order-list" aria-label="Navigation Destinations">
        {preferences.order.map((name, index) => {
          const item = GLOBAL_VIEW_ITEMS.find((candidate) => candidate.name === name)!;
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
              <span className="rail-order-icon" aria-hidden="true"><Icon size={18} /></span>
              <span className="rail-order-title">{item.title}</span>
              <span className="rail-order-state">
                {digit !== undefined && <kbd aria-label={`Shortcut ${digit}`}>{digit}</kbd>}
                {state !== null && <span className="rail-order-note">{state}</span>}
              </span>
              <span className="rail-order-controls">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={index === 0}
                  aria-label={`Move ${item.title} Up`}
                  onClick={() => moveRailView(name, "up", instanceScope)}
                >
                  <ArrowUpIcon size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={index === preferences.order.length - 1}
                  aria-label={`Move ${item.title} Down`}
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
      <p className="rail-order-hint">
        The visible order assigns the digit shortcuts. Hidden destinations stay reachable from search
        and direct links, and keep their place here for when they return.
      </p>
      <div className="rail-order-actions">
        <button
          type="button"
          className="btn ghost sm"
          disabled={railPreferencesAreDefault(preferences)}
          onClick={() => resetRailPreferences(instanceScope)}
        >
          Reset to Default
        </button>
      </div>
    </SettingsGroup>
  );
}

export function KeyboardPanel({
  shortcutLabel,
  disabled = false,
  onOpenShortcuts,
}: {
  shortcutLabel: string;
  /** Production never disables this; the Playwright harness renders the state to measure it. */
  disabled?: boolean;
  onOpenShortcuts: (returnFocus: HTMLElement | null) => void;
}) {
  return (
    <SettingsGroup title="Shortcuts">
      <NavRow
        title="Keyboard Shortcuts"
        description={shortcutLabel}
        icon={<KeyboardIcon size={15} />}
        disabled={disabled}
        // Resolved from the DOM rather than a ref, as the dialog version did: the reference dialog
        // returns focus here, and this row is the thing to return it to.
        onClick={() => onOpenShortcuts(document.querySelector<HTMLElement>(".settings-view .ui-row-nav"))}
      />
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
      description={<>{description} <small className="settings-pending-reason">{reason}</small></>}
    />
  );
}

export function BehaviorPanel({
  agentHarnessDefaults,
  sessionNaming,
}: { agentHarnessDefaults?: ReactNode; sessionNaming?: ReactNode } = {}) {
  const enterKey = useEnterKeyBehavior();
  const questionResponseStyle = useQuestionResponseStyle();
  return (
    <>
      <SettingsGroup title="Defaults">
      {/* Stored per device and only on an explicit choice; the unstored default derives from the
          device class (touch phones get newline, everything else send), so this row shows each
          device's own effective behavior. The pair swaps as a unit — see enter-key.ts. */}
      <SegmentedRow
        title="Enter Key"
        options={[
          {
            value: "send",
            label: "Send Message",
            description: "Enter sends; Shift+Enter inserts a new line. Stored on this device.",
          },
          {
            value: "newline",
            label: "Insert New Line",
            description: "Enter inserts a new line; Shift+Enter sends. Stored on this device.",
          },
        ]}
        value={enterKey}
        onChange={(value) => setEnterKeyBehavior(value as EnterKeyBehavior)}
      />
      <SegmentedRow
        title="Question Response Style"
        options={[
          {
            value: "interactive",
            label: "Interactive Form",
            description: "Choose options directly with keyboard-accessible form controls. Stored on this device.",
          },
          {
            value: "composer",
            label: "Composer Response",
            description: "Answer pending questions through a distinct mode in the Session composer. Stored on this device.",
          },
        ]}
        value={questionResponseStyle}
        onChange={(value) => setQuestionResponseStyle(value as QuestionResponseStyle)}
      />
      <PendingSetting
        title="Reduce Motion"
        description="Follows your system setting."
        reason="Change it in your operating system's accessibility settings; an in-app override is not built yet."
      />
      <PendingSetting
        title="Confirm Before Deleting"
        description="Ask before removing a session, project, or connection."
        reason="Not built yet."
      />
      {agentHarnessDefaults ?? (
        <PendingSetting
          title="Default Models, Efforts, and Permissions"
          description="What each Agent Harness uses for a new session."
          reason="Chosen per session when you create it; defaults are not available in this client."
        />
      )}
      </SettingsGroup>
      {sessionNaming}
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
      message: "This control plane does not support Agent Harness defaults. Update or restart it so it matches this dashboard, then try again.",
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
      ? loadError.endpointMissing ? "Control plane update required." : "Agent Harness defaults could not be loaded."
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
      <NavRow
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
          title={loadError.endpointMissing ? "Control Plane Update Required" : "Load Failed"}
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
          <div className="agent-defaults-toolbar">
            {loadError && (
              <span
                className="settings-inline-error"
                role={mutationError ? undefined : "alert"}
                aria-hidden={mutationError ? true : undefined}
              >
                {refreshFailure}
              </span>
            )}
            {mutationError && !editing && (
              <span className="settings-inline-error" role="alert">
                {mutationError}
                {mutationRecoveryAnnouncement && <span className="sr-only">{mutationRecoveryAnnouncement}</span>}
              </span>
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
            <p className="ui-row-desc agent-defaults-empty">No discovered Agent Harnesses are available yet.</p>
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
                <NavRow
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
                      <p className="ui-row-desc">This Agent Harness advertises no configurable models, efforts, or permission modes.</p>
                    )}
                    {option.installations.length === 0 && (
                      <p className="settings-inline-error" role="status">This saved Agent Harness is no longer discovered. Reset it to use the Wollipog default.</p>
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
                      <p className="settings-inline-error" role="alert">
                        {mutationError}
                        {mutationRecoveryAnnouncement && <span className="sr-only">{mutationRecoveryAnnouncement}</span>}
                      </p>
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
  const deleteApiKey = () => {
    if (busy || customBusy || !window.confirm("Delete the runner-local API key? Endpoints that require it will stop working.")) return;
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

  return (
    <SettingsGroup title="Session Naming">
      <NavRow
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
            <p className="ui-row-desc">Organization owner or admin permission is required to change this setting.</p>
          )}
          {draftMode === "session_agent_account" && legacyFollowAvailable && (
            <p className="ui-row-desc">
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
              <input
                aria-label="Timeout"
                type="number"
                min={250}
                max={30000}
                value={customTimeout}
                disabled={!settings.canManage || busy || customBusy}
                onChange={(event) => setCustomTimeout(event.target.value)}
              />
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
          <p className="ui-row-desc">
            The API key is sent once to the selected Machine and is never returned to this browser or stored by the control plane.
            {" "}When this mode is active, bounded session text is sent through that Machine to the configured provider.
          </p>
          {custom?.configurationSource === "runner" && customDraftChanged && !customEndpoint && (
            <p className="ui-row-desc">Re-enter the complete endpoint URL to change this saved configuration.</p>
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
              onClick={deleteApiKey}
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
          {customStatus && <p role="status" className="ui-row-desc">{customStatus}</p>}
            </>
          )}
          {error?.action === "save" && <p role="alert" className="ui-row-desc">{summaryStatus}</p>}
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
    </SettingsGroup>
  );
}

/**
 * Untested features, each behind its own switch.
 *
 * These gate UI EXPOSURE on this device and this instance, never capability: the control
 * plane keeps serving the underlying APIs, and turning a feature back on restores every
 * surface without a reload. The exception to "never hide a setting that could exist" is
 * deliberate here — hiding is the setting.
 */
export function ExperimentalPanel({
  flags,
  onToggle,
  conductorAvailable,
}: {
  flags: ExperimentFlags;
  onToggle: (id: ExperimentId, enabled: boolean) => void;
  /** Whether any connected runner advertises an available conductor agent. */
  conductorAvailable: boolean;
}) {
  return (
    <SettingsGroup title="Untested Features">
      <SwitchRow
        title="Multi-Agent Runs"
        description="Runs and workflow graphs that coordinate several agents. Off hides Multi-Agent from navigation and search on this device."
        checked={flags.multiAgent}
        onClick={() => onToggle("multiAgent", !flags.multiAgent)}
      />
      <SwitchRow
        title="Collaboration Pods"
        description="Shared-context groups of sessions. Off hides Pods from navigation and search on this device."
        checked={flags.pods}
        onClick={() => onToggle("pods", !flags.pods)}
      />
      {/* The switch stays operable even with no runner able to supply a conductor: it is the
          feature's only gate now, and the preference must be settable before the runner that
          can host one connects. The pending reason says what is missing and that it self-heals. */}
      <SwitchRow
        title="Conductor-Led Work"
        description={conductorAvailable
          ? "The Conductor preset when creating a session. This switch is the feature's only gate on this device."
          : <>The Conductor preset when creating a session.{" "}
            <small className="settings-pending-reason">
              No online runner can host a conductor yet; the preset appears once a runner with a native Claude Code installation connects.
            </small></>}
        checked={flags.conductor}
        onClick={() => onToggle("conductor", !flags.conductor)}
      />
    </SettingsGroup>
  );
}

export function NetworkPanel({ tailnet }: { tailnet: TailnetAccessSetting }) {
  // ONE row is conditional, not the whole group. An early return here dropped Control-Plane Origin
  // and Manage Instances in every browser — the exact discoverability rule this panel was fixed to
  // satisfy a commit earlier, undone by the shape of the fix.
  const status = tailnet.status;
  const tailnetRow = status?.available ? (
    <SwitchRow
      title="Enable Tailnet Access for This Machine"
      description={
        <span className={tailnet.error ? "error-text" : undefined}>
          {tailnet.busy ? "Restarting the local control plane…" : tailnet.error ?? tailnetAccessDescription(status)}
        </span>
      }
      checked={status.enabled}
      // `busy`, not folded into `disabled`. SwitchRow disables a busy control itself and keeps
      // showing the confirmed value; passing only `disabled` left the row announcing nothing about
      // the write in flight while its own description said the control plane was restarting.
      busy={tailnet.busy}
      disabled={!status.managed}
      onClick={tailnet.toggle}
    />
  ) : (
    // Four different situations used to render the same sentence — "Tailscale is not installed or
    // not detected" — including "we have not finished asking yet" and "the read failed". Two of
    // those are false statements about the user's machine, and the third told them a transient
    // state was a permanent one.
    //
    // `desktop` is tested BEFORE `loading`: in a browser the answer is already known synchronously,
    // and the first paint claimed a check was running that this runtime cannot perform.
    <PendingSetting
      title="Enable Tailnet Access for This Machine"
      description="Reach this control plane from your other devices."
      reason={!tailnet.desktop
        ? "Tailnet access is managed by the Wollipog desktop app; this is a browser."
        : tailnet.loading
        ? "Checking whether Tailscale is available on this machine…"
        : tailnet.error
        ? `Could not read the Tailscale status: ${tailnet.error}`
        : "Tailscale is not installed or not detected on this machine."}
    />
  );
  return (
    <SettingsGroup title="Tailnet">
      {tailnetRow}
      <PendingSetting
        title="Control-Plane Origin"
        description="Which control plane this window talks to."
        reason="Switch it from the instance menu in the sidebar; an editable field here is not built yet."
      />
      <PendingSetting
        title="Manage Instances"
        description="Add, rename, or remove the control planes you connect to."
        reason="Managed from the instance menu in the sidebar for now."
      />
    </SettingsGroup>
  );
}

export function AboutPanel() {
  return (
    <SettingsGroup title="Versions">
      {/* The protocol version is a compile-time constant the web app already imports. The APP
          version is not sent to the client at all, so it is named as missing rather than rendered
          as "Unknown", which would read as a failure rather than as a gap. */}
      <dl className="settings-about">
        <dt>Protocol</dt><dd>{PROTOCOL_VERSION}</dd>
      </dl>
      <PendingSetting
        title="Application Version"
        description="Which build of Wollipog this is."
        reason="The control plane does not send its version to the client yet."
      />
      <PendingSetting
        title="Updates"
        description="Whether this build is current."
        reason="The desktop app updates itself; there is no in-app update check yet."
      />
      <PendingSetting
        title="Open-Source Licenses"
        description="What Wollipog is built on."
        reason="Not compiled into the app yet; see THIRD-PARTY-NOTICES in the repository."
      />
    </SettingsGroup>
  );
}

/** Desktop alerts (Notification API while a tab is open) as a settings switch. */
/**
 * Desktop alerts (the Notification API, while a tab is open) as injected state.
 *
 * A prop rather than a direct read of the `notifier` singleton, for the same reason push is one:
 * the Playwright fixture cannot drive a singleton, so it copied a `SwitchRow` that looked like this
 * one — and a copy is a second description that drifts. Both callers mount the same component now.
 */
export interface NotifySetting {
  supported: boolean;
  on: boolean;
  disabled?: boolean;
  toggle: () => void;
}

export function useNotifySetting(): NotifySetting {
  const [on, setOn] = useState(notifier.enabled);
  return {
    supported: notifier.supported,
    on,
    toggle: () => {
      if (on) {
        notifier.disable();
        setOn(false);
      } else {
        void notifier.enable().then(setOn);
      }
    },
  };
}

export function NotifyRow({ notify }: { notify: NotifySetting }) {
  if (!notify.supported) return null;
  return (
    <SwitchRow
      title="Desktop Alerts"
      description="Approvals and finished turns, while Wollipog is open"
      checked={notify.on}
      disabled={notify.disabled}
      onClick={notify.toggle}
    />
  );
}

/**
 * Web Push (push-to-wake, outlives the tab) as a settings switch — a pure view of the
 * shell-mounted usePushSetting state, so reconciliation runs whether or not the dialog ever
 * opens. Hidden where push can't work (insecure origin, no SW registration, Tauri).
 */export function PushRow({ push, disabled }: { push: PushSetting; disabled?: boolean }) {
  const { state, confirmed, toggle } = push;
  // Rendering checked={state === "on"} moved the switch to off — and announced
  // aria-checked="false" — while disablePush() had not yet unregistered the subscription, so
  // notifications could still arrive. `confirmed` comes from the shell-mounted hook so it also
  // survives closing and reopening Settings mid-request.
  if (state === "unavailable") return null;
  return (
    <SwitchRow
      title="Push Notifications"
      description="Push-to-wake — works with the app closed"
      checked={confirmed}
      busy={state === "busy"}
      disabled={disabled}
      onClick={() => void toggle()}
    />
  );
}

/** Alerts, in the order production renders them: desktop first, push last. */
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
  return (
    <SettingsGroup title="Alerts">
      <NotifyRow notify={{ ...notify, disabled }} />
      <PushRow push={push} disabled={disabled} />
    </SettingsGroup>
  );
}
