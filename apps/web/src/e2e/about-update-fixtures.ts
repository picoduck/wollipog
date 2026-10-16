import type { DesktopUpdateSetting, DesktopUpdateStatus } from "../desktop-updates.js";

/**
 * Settings › About's update states (#1646, #3028), injected the way the shell's hook would report
 * them. Shared by the settings-rows harness, which shows them in the Settings frame, and the
 * desktop-updates harness, whose spec checks each one.
 */
export const ABOUT_UPDATE_STATES = [
  "unchecked",
  "checking",
  "current",
  "available",
  "release-page",
  "installing",
  "disabled",
  "failed",
] as const;
export type AboutUpdateState = (typeof ABOUT_UPDATE_STATES)[number];

export function isAboutUpdateState(value: string | null): value is AboutUpdateState {
  return value !== null && (ABOUT_UPDATE_STATES as readonly string[]).includes(value);
}

export const ABOUT_FIXTURE_VERSIONS = { desktop: "0.27.0", available: "0.28.0" } as const;

export const RELEASE_PAGE_REASON = "This app was installed from a .deb package. Install the new package from the release page.";
export const CHECK_FAILURE = "Could not check for updates: error sending request for url (https://github.com/picoduck/wollipog/releases/latest/download/latest.json)";

export function aboutUpdateFixture(
  state: AboutUpdateState,
  handlers: Partial<Pick<DesktopUpdateSetting, "check" | "install" | "openRelease" | "toggleAutomatic" | "togglePrerelease">> = {},
): DesktopUpdateSetting {
  const checkedAt = Date.UTC(2026, 8, 23, 16, 5);
  const available = {
    state: "available" as const,
    version: ABOUT_FIXTURE_VERSIONS.available,
    releaseUrl: `https://github.com/picoduck/wollipog/releases/tag/v${ABOUT_FIXTURE_VERSIONS.available}`,
    checkedAt,
  };
  const status: DesktopUpdateStatus = {
    currentVersion: ABOUT_FIXTURE_VERSIONS.desktop,
    install: state === "release-page" ? { mode: "releasePage", reason: RELEASE_PAGE_REASON } : { mode: "inPlace" },
    automaticChecks: state !== "disabled",
    prereleaseUpdates: false,
    checksAllowed: state !== "disabled",
    releasesUrl: "https://github.com/picoduck/wollipog/releases",
    lastCheck: state === "current"
      ? { state: "current", checkedAt }
      : state === "available" || state === "release-page" || state === "installing" ? available : null,
  };
  return {
    desktop: true,
    status,
    loading: false,
    checking: state === "checking",
    installing: state === "installing",
    savingAutomatic: false,
    savingPrerelease: false,
    failure: state === "failed" ? { action: "check", message: CHECK_FAILURE } : null,
    check: () => undefined,
    install: () => undefined,
    openRelease: () => undefined,
    toggleAutomatic: () => undefined,
    togglePrerelease: () => undefined,
    ...handlers,
  };
}
