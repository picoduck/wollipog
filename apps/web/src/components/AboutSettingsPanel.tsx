import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import type { DesktopUpdateSetting, DesktopUpdateStatus } from "../desktop-updates.js";
import { CONTROL_PLANE_HTTP } from "../config.js";
import { useInstances } from "../instances-context.js";
import { CopyButton } from "./common.js";
import { BanIcon, ErrorIcon, ExternalLinkIcon, InfoIcon, SuccessIcon, UpdateIcon } from "./Icons.js";
import type { NoticeTone } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { SettingsGroup, SwitchRow, ValueRow, type RowFailure } from "./ui/SettingsRows.js";

/**
 * Settings › About (#3028): what you are running and whether it is current.
 *
 * The section opens with Wollipog's own name and version in place of its heading, lists the versions
 * as rows, and in the desktop app gives updates one status block whose primary action is last
 * (docs/design-system.md §3.2, §8.2). The protocol number and the environment variable that turns
 * checks off are never on the page (§17.2): the first is only copied, the second is behind Show
 * Details.
 *
 * `update` is the shell's state (see `useDesktopUpdateSetting`); absent, or not `desktop`, this is a
 * browser, which is updated by upgrading its server and so has no Updates group.
 */
export function AboutPanel({ update }: { update?: DesktopUpdateSetting } = {}) {
  const serverVersion = useServerVersion();
  const instances = useInstances();
  // The server that answers this window's requests: the open instance's API origin, else the API
  // origin this build was configured with. Not the dashboard's origin, which a split deployment
  // serves from elsewhere, and which is the address Network's Connected To shares with other devices.
  const address = instances.runtime?.publicOrigin ?? CONTROL_PLANE_HTTP;
  const desktop = update?.desktop === true ? update : null;
  const appVersion = desktop ? desktop.status?.currentVersion ?? (desktop.loading ? undefined : null) : undefined;
  const shown = desktop ? appVersion : serverVersion;
  return (
    <>
      <header className="about-identity">
        <img className="about-identity-icon" src="/icons/icon-192.png" alt="" aria-hidden="true" />
        <div className="about-identity-text">
          <p className="about-identity-name">Wollipog</p>
          <p className="about-identity-version">{identityVersion(shown)}</p>
        </div>
      </header>
      <SettingsGroup
        // Titled in a browser too, where it is the only group: About's head is the identity header,
        // which does not name the group the way a section heading would (§8.2's one-group rule).
        title="Versions"
        action={(
          <CopyButton
            text={versionInfoText({ desktop: desktop !== null, appVersion, serverVersion, address })}
            label="Copy Version Info"
            className="btn sm ghost"
          />
        )}
        foot={desktop ? undefined : "This window updates when its Wollipog server is upgraded."}
      >
        {desktop && <ValueRow title="Desktop App" value={versionValue(appVersion)} mono={typeof appVersion === "string"} />}
        <ValueRow
          title="Server"
          description={`The Wollipog server at ${address}.`}
          value={versionValue(serverVersion)}
          mono={typeof serverVersion === "string"}
        />
      </SettingsGroup>
      {desktop && <DesktopUpdates update={desktop} />}
    </>
  );
}

/** `undefined` is still reading, `null` did not say. */
type Reported = string | null | undefined;

/** The identity header's line under the name: a meta line, not a control. */
function identityVersion(version: Reported): string {
  if (version === undefined) return "Reading the version…";
  return version === null ? "Version not reported" : `Version ${version}`;
}

/** A version row's value: a value, not a button, so "Reading…" is not a busy label. */
function versionValue(version: Reported): string {
  if (version === undefined) return "Reading…";
  return version ?? "Not reported";
}

/**
 * What Copy Version Info puts on the clipboard: plain text a person can paste into a bug report. It
 * carries the protocol number, which the page itself never shows.
 */
export function versionInfoText({ desktop, appVersion, serverVersion, address }: {
  desktop: boolean;
  appVersion: Reported;
  serverVersion: Reported;
  address: string;
}): string {
  const reported = (version: Reported) => version ?? (version === undefined ? "not read yet" : "not reported");
  return [
    ...(desktop ? [`Wollipog Desktop App: ${reported(appVersion)}`] : []),
    `Wollipog Server: ${reported(serverVersion)}`,
    `Protocol: ${PROTOCOL_VERSION}`,
    `Server Address: ${address}`,
  ].join("\n");
}

/**
 * The version of the server this window talks to, from its authenticated instance probe.
 *
 * `undefined` while reading and `null` when it did not say — an older server without the probe, or
 * a failed read. The desktop app and the server can differ: a desktop window may be connected to a
 * remote server, and updating the app never updates that server.
 */
function useServerVersion(): Reported {
  const api = useApi();
  const [version, setVersion] = useState<Reported>(undefined);
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
 * Why a check failed, in one plain sentence that says what to do (§12.4, §17.2). The shell's words
 * ("Could not check for updates: error sending request for url (…)") restate the title and then the
 * library's error, so they stay behind Show Details and this names the cause instead. The patterns
 * are the shell's own messages (apps/desktop/src-tauri/src/updates.rs) and the network errors its
 * HTTP client appends.
 */
export function checkFailureReason(message: string): string {
  if (/timed out|timeout/iu.test(message)) return "The release server took too long to answer. Try again in a moment.";
  if (/HTTP (?:403|429)\b|rate limit/iu.test(message)) return "The release server is limiting requests right now. Try again later.";
  if (/Could not reach|error sending request|connection|dns|resolve|network|offline/iu.test(message)) {
    return "Wollipog couldn't reach the release server. Check the connection, then try again.";
  }
  if (/HTTP \d{3}\b/u.test(message)) return "The release server couldn't answer right now. Try again later.";
  if (/invalid release metadata|Could not read GitHub releases|size limit|page limit|does not match its release tag/iu.test(message)) {
    return "The release server's answer couldn't be used. Try again later.";
  }
  if (/Could not prepare/iu.test(message)) return "This copy of Wollipog couldn't set up the check. Restart Wollipog, then try again.";
  return "Wollipog couldn't finish the check. Try again in a moment.";
}

/** Why the desktop app's update status could not be read, in one sentence. */
const UNREADABLE_REASON = "The desktop app didn't answer. Restart Wollipog if this keeps happening.";

/** The Updates group: the status block, then the two switches, unchanged in behavior. */
function DesktopUpdates({ update }: { update: DesktopUpdateSetting }) {
  const { status, failure } = update;
  const blockTitle = useRef<HTMLParagraphElement>(null);
  // Retrying an install or a release page clears the failure, which removes the group's notice and
  // the Retry that was pressed. Focus goes to the block's title first, so it stays in Updates. A
  // switch's Try Again needs none of this: its row hands focus to the switch, which keeps it while
  // it saves (#3190).
  const retry = (action: () => void) => () => {
    blockTitle.current?.focus();
    action();
  };
  // A switch fails in place (§8.2); an install or a release page that did not open is the group's.
  const groupFailure: RowFailure | null = failure?.action === "install"
    ? { message: "Couldn't install the update.", detail: failure.message, onRetry: retry(update.install) }
    : failure?.action === "openRelease"
      ? { message: "Couldn't open the release page.", detail: failure.message, onRetry: retry(update.openRelease) }
      : null;
  return (
    <SettingsGroup title="Updates" failure={groupFailure}>
      <UpdateStatusBlock update={update} titleRef={blockTitle} />
      {status && (
        <SwitchRow
          title="Check for Updates Automatically"
          description={status.checksAllowed
            ? "Look for a newer published release while Wollipog is open."
            : "Turned off for this installation."}
          checked={status.automaticChecks && status.checksAllowed}
          busy={update.savingAutomatic}
          disabled={!status.checksAllowed}
          failure={failure?.action === "automatic"
            ? { message: "Couldn't change automatic checks.", detail: failure.message, onRetry: update.toggleAutomatic }
            : null}
          onClick={update.toggleAutomatic}
        />
      )}
      {status?.prereleaseUpdates !== undefined && (
        <SwitchRow
          title="Pre-Release Updates"
          description="Include early versions that may be less reliable. Turning this off waits for a newer stable release; it does not downgrade Wollipog."
          checked={status.prereleaseUpdates}
          busy={update.savingPrerelease}
          disabled={update.checking || update.installing}
          failure={failure?.action === "prerelease"
            ? { message: "Couldn't change the update channel.", detail: failure.message, onRetry: update.togglePrerelease }
            : null}
          onClick={update.togglePrerelease}
        />
      )}
    </SettingsGroup>
  );
}

/** Every state the block can be in. The issue's eight, plus reading the status and failing to. */
export type UpdateBlockState =
  | "reading"
  | "unreadable"
  | "off"
  | "installing"
  | "failed"
  | "available"
  | "releasePage"
  | "current"
  | "notChecked";

export function updateBlockState(update: DesktopUpdateSetting): UpdateBlockState {
  const { status, failure } = update;
  if (!status) return update.loading ? "reading" : "unreadable";
  if (!status.checksAllowed) return "off";
  if (update.installing) return "installing";
  if (failure?.action === "check") return "failed";
  const lastCheck = status.lastCheck;
  if (lastCheck?.state === "available") return status.install.mode === "inPlace" ? "available" : "releasePage";
  if (lastCheck?.state === "current") return "current";
  // Checking keeps the state it started from, with its button busy.
  return "notChecked";
}

interface BlockContent {
  tone: NoticeTone;
  icon: ReactNode;
  title: string;
  description?: string;
  /** Behind Show Details: the whole failure, or what turned checks off. */
  details?: string;
  /** The check button's label and variant, when the state offers one. */
  check?: { label: string; variant: "btn" | "btn ghost" };
  /** The state's one primary action, last. */
  primary?: ReactNode;
  /** A failure to announce: the block is rewritten in place, so nothing else would say it. */
  alert?: string;
}

function blockContent(state: UpdateBlockState, update: DesktopUpdateSetting, status: DesktopUpdateStatus | null): BlockContent {
  const lastCheck = status?.lastCheck ?? null;
  const offered = lastCheck?.state === "available" ? lastCheck.version : null;
  const failure = update.failure;
  switch (state) {
    case "reading":
      return { tone: "neutral", icon: <InfoIcon />, title: "Reading the Update Status" };
    case "unreadable": {
      return {
        tone: "danger",
        icon: <ErrorIcon />,
        title: "Couldn't Read the Update Status",
        description: UNREADABLE_REASON,
        details: failure?.message,
        alert: `Couldn't read the update status. ${UNREADABLE_REASON}`,
      };
    }
    case "off":
      return {
        tone: "neutral",
        icon: <BanIcon />,
        title: "Update Checks Are Off",
        description: "This installation turns update checks off.",
        details: "WOLLIPOG_DISABLE_UPDATE_CHECK is set where Wollipog runs, which stops every update check.",
      };
    case "installing":
      return {
        tone: "info",
        icon: <UpdateIcon />,
        title: offered ? `Installing Wollipog ${offered}` : "Installing the Update",
        description: "Downloading and verifying. Wollipog restarts when it's installed.",
      };
    case "failed": {
      const reason = checkFailureReason(failure?.message ?? "");
      return {
        tone: "danger",
        icon: <ErrorIcon />,
        title: "Couldn't Check for Updates",
        description: reason,
        // The shell's own words, for a report or a search.
        details: failure?.message || undefined,
        check: { label: "Retry", variant: "btn" },
        alert: `Couldn't check for updates. ${reason}`,
      };
    }
    case "available":
      return {
        tone: "info",
        icon: <UpdateIcon />,
        title: `Wollipog ${offered} Is Available`,
        description: "Installing restarts Wollipog.",
        check: { label: "Check Again", variant: "btn ghost" },
        primary: <button type="button" className="btn primary" disabled={update.checking} onClick={update.install}>Install and Restart</button>,
      };
    case "releasePage":
      return {
        tone: "info",
        icon: <UpdateIcon />,
        title: `Wollipog ${offered} Is Available`,
        description: status?.install.mode === "releasePage" ? status.install.reason : undefined,
        check: { label: "Check Again", variant: "btn ghost" },
        primary: (
          <button type="button" className="btn primary" onClick={update.openRelease}>
            Open Release Page
            <ExternalLinkIcon size={14} aria-hidden="true" />
          </button>
        ),
      };
    case "current":
      return {
        tone: "success",
        icon: <SuccessIcon />,
        title: `Wollipog ${status?.currentVersion ?? ""} Is Up to Date`,
        description: lastCheck
          ? `Checked ${formatCheckedAt(lastCheck.checkedAt)} on the ${status?.prereleaseUpdates ? "pre-release" : "stable"} channel.`
          : undefined,
        check: { label: "Check Again", variant: "btn ghost" },
      };
    case "notChecked":
      return { tone: "neutral", icon: <InfoIcon />, title: "Not Checked Yet", check: { label: "Check for Updates", variant: "btn" } };
  }
}

/**
 * #1646, #3028. What the shell last learned about published releases, as one status block: a 32px
 * tone tile, a title, one sentence, and the actions after them with the primary last. Under 560px of
 * group the actions drop under the text at full width, each 44px tall.
 *
 * The block is rewritten in place as its state changes, never remounted: the actions keep fixed
 * slots (Show Details, the check, the primary), so the check button a person pressed is the same
 * element when its answer arrives and keeps their focus. Where the pressed button goes away
 * (Install and Restart becomes Installing), focus moves to the block's title rather than the page.
 *
 * Installing restarts the app, so a first attempt while work is in flight is held by the shell and
 * becomes the Restart to Install Update confirmation the update toast opens too (#1975). Nothing
 * here shows the hold: Install Later leaves this block offering Install and Restart as it was.
 */
function UpdateStatusBlock({ update, titleRef }: { update: DesktopUpdateSetting; titleRef: RefObject<HTMLParagraphElement | null> }) {
  const state = updateBlockState(update);
  const content = blockContent(state, update, update.status);
  // Details close whenever what they describe changes: another state, or another failure. Keyed on
  // the transition rather than on the state opened in, so a failure that comes back after a success
  // starts collapsed too.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const shown = `${state}\u0000${update.failure?.message ?? ""}`;
  useLayoutEffect(() => { setDetailsOpen(false); }, [shown]);
  const id = useId();
  const detailsId = `${id}-details`;
  const blockRef = useRef<HTMLDivElement>(null);
  /** Whether focus was last inside the block. A removed button takes focus with it silently. */
  const focusInside = useRef(false);
  useLayoutEffect(() => {
    if (!focusInside.current) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    (blockRef.current?.querySelector<HTMLElement>(".update-block-actions > button") ?? titleRef.current)?.focus();
  }, [state]);
  const check = content.check && (
    <BusyButton
      className={content.check.variant}
      busy={update.checking}
      progress="Checking for updates…"
      disabled={update.installing || update.savingPrerelease}
      onClick={update.check}
    >
      {content.check.label}
    </BusyButton>
  );
  const toggle = content.details !== undefined && (
    <button
      type="button"
      className="btn ghost"
      aria-expanded={detailsOpen}
      aria-controls={detailsOpen ? detailsId : undefined}
      onClick={() => setDetailsOpen((open) => !open)}
    >
      {detailsOpen ? "Hide Details" : "Show Details"}
    </button>
  );
  return (
    <div
      ref={blockRef}
      className={`update-block t-${content.tone}`}
      data-state={state}
      onFocus={() => { focusInside.current = true; }}
      onBlur={(event) => {
        // A removed element blurs with no next target: that is the drop the effect above repairs.
        if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) focusInside.current = false;
      }}
    >
      <span className="update-block-tile" aria-hidden="true">{content.icon}</span>
      <div className="update-block-text">
        <p ref={titleRef} className="update-block-title" tabIndex={-1}>{content.title}</p>
        {content.description && <p className="update-block-desc">{content.description}</p>}
        {detailsOpen && content.details && <p className="update-block-details" id={detailsId}>{content.details}</p>}
      </div>
      {(toggle || check || content.primary) && (
        <div className="update-block-actions">
          {toggle}
          {check}
          {content.primary}
        </div>
      )}
      {/* Always mounted, so a failure that arrives is announced as it arrives. Emptied while a check
          runs, so a retry that fails with the same words is announced again. */}
      <span className="sr-only" role="alert">{update.checking ? "" : content.alert ?? ""}</span>
    </div>
  );
}
