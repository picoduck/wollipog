import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { notifier } from "../notify.js";
import { tailnetAccessDescription, type TailnetAccessSetting } from "../tailnet-access.js";
import { type PushSetting } from "../push.js";
import { KeyboardIcon } from "./Icons.js";
import { NavRow, SegmentedRow, SelectRow, StaticRow, SwitchRow } from "./ui/SettingsRows.js";
import { SCHEME_SWATCHES, type ColorScheme, type ResolvedTheme } from "../theme.js";
import { SETTINGS_SECTIONS, type SettingsSection, type View } from "../navigation.js";

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

export function BehaviorPanel() {
  return (
    <SettingsGroup title="Defaults">
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
      <PendingSetting
        title="Default Approval Mode"
        description="Whether new sessions ask before running tools."
        reason="Chosen per session when you create it; a default is not built yet."
      />
      <PendingSetting
        title="Default Agent and Model"
        description="What a new session starts with."
        reason="Chosen per session when you create it; a default is not built yet."
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
