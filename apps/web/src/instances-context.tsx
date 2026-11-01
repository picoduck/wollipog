import React, { createContext, useContext, type ReactNode } from "react";
import type { InstanceProfile, InstanceRegistrySnapshot } from "./desktop-instances.js";
import type { InstanceRuntime } from "./instance-runtime.js";
import type { ViewNavigation } from "./navigation.js";
import type { ConnState } from "./store.js";
import { CONTROL_PLANE_HTTP, DASHBOARD_ORIGIN } from "./config.js";
import { statusMeta, type StatusMeta } from "./status-meta.js";

export type InstanceAvailability =
  | "saved"
  | "connecting"
  | "online"
  | "offline"
  | "authentication-required"
  | "incompatible"
  | "missing-credential";

/** An instance's availability in the shared machine vocabulary (§11.2): a missing or rejected
 * credential needs the user to sign in again, and an incompatible instance needs an update. */
export function instanceAvailabilityMeta(status: InstanceAvailability): StatusMeta {
  return statusMeta("machine", status === "authentication-required" || status === "missing-credential"
    ? "sign_in_required"
    : status === "incompatible" ? "update_required" : status);
}

/**
 * The instance tile's monogram (§4.1): the first letter or digit of each of the label's first two
 * words, so "Home Studio" is "HS" and "Studio" is "S". Words with neither, such as "·", are skipped.
 */
export function instanceMonogram(label: string): string {
  const initials = label.trim().split(/\s+/)
    .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0])
    .filter((initial): initial is string => Boolean(initial))
    .slice(0, 2)
    .join("");
  return (initials || Array.from(label.trim())[0] || "").toLocaleUpperCase();
}

/**
 * What the shell's connection banner says about the active instance, which the rail tile and the
 * Instances card must agree with (#1970, #2102): a lost connection is "reconnecting" from its first offline report until it is back,
 * and a rejected credential needs signing in again. Null while the connection is live or first
 * opening. The banner shows only in these states, so neither is ever Online beside it.
 */
export type ActiveInstanceConnection = "reconnecting" | "sign-in-required";

export function activeInstanceConnection(input: {
  conn: ConnState;
  authRequired: boolean;
  /** The connection has been lost since its last online state (useConnectionLostFor). */
  connectionLost: boolean;
}): ActiveInstanceConnection | null {
  if (input.conn === "online") return null;
  if (input.authRequired) return "sign-in-required";
  return input.connectionLost || input.conn === "offline" ? "reconnecting" : null;
}

/** The active instance while the banner says its connection is lost: hollow and neutral, as Offline is (§11.2). */
const RECONNECTING: StatusMeta = { label: "Reconnecting…", tone: "neutral", pulse: false, hollow: true };

/**
 * The active instance's status on every surface that shows it: the rail tile, the instance menu and
 * the Instances card (#1970, #2102). What the shell's banner says wins over the status the instance
 * manager last recorded, which is kept only for remote profiles and can still read Online for a
 * moment after the socket drops.
 */
export function activeInstanceStatusMeta(
  connection: ActiveInstanceConnection | null,
  availability: InstanceAvailability,
): StatusMeta {
  return connection === "reconnecting" ? RECONNECTING
    : instanceAvailabilityMeta(connection === "sign-in-required" ? "authentication-required" : availability);
}

/** What the shell's banner says about the active instance. Null outside the shell (the recovery shell). */
const ActiveInstanceConnectionContext = createContext<ActiveInstanceConnection | null>(null);

export function ActiveInstanceConnectionProvider({
  value,
  children,
}: {
  value: ActiveInstanceConnection | null;
  children: ReactNode;
}) {
  return <ActiveInstanceConnectionContext.Provider value={value}>{children}</ActiveInstanceConnectionContext.Provider>;
}

export function useActiveInstanceConnection(): ActiveInstanceConnection | null {
  return useContext(ActiveInstanceConnectionContext);
}

export type InstanceShellPhase = "loading" | "opening" | "ready" | "failed" | "missing";

export interface InstanceStatus {
  availability: InstanceAvailability;
  message?: string;
}

/** Which form of the one instance dialog to open (#3003): Add Remote Instance, or Edit Instance or
 * Re-Pair Instance for a saved remote profile. */
export type InstanceDialogRequest =
  | { mode: "add" }
  | { mode: "edit" | "repair"; profileId: string };

export type OpenInstanceDialogOptions = InstanceDialogRequest & {
  /**
   * Where focus returns when the dialog closes. Defaults to the element that has focus when
   * `openInstanceDialog` is called, which is the button that opened it. A menu item unmounts as its
   * menu closes, so a menu passes its trigger instead.
   */
  returnFocus?: HTMLElement | null;
};

export interface InstanceManager {
  readonly desktopMultiInstance: boolean;
  readonly registry: InstanceRegistrySnapshot;
  readonly activeProfile: InstanceProfile;
  readonly runtime: InstanceRuntime | null;
  readonly navigation: ViewNavigation | undefined;
  readonly phase: InstanceShellPhase;
  readonly error: string | null;
  readonly statusByProfile: Readonly<Record<string, InstanceStatus>>;
  switchInstance(profileId: string): Promise<void>;
  retryActive(): Promise<void>;
  /** Saves a remote profile. With `switchTo`, the switch to it has started when this resolves; its
   * connection then opens as any switch does. */
  addInstance(input: { label: string; origin: string; token: string; switchTo: boolean }): Promise<void>;
  editInstance(input: { profileId: string; label: string; origin: string; token?: string }): Promise<void>;
  repairInstance(profileId: string, token: string): Promise<void>;
  removeInstance(profileId: string): Promise<void>;
  manageInstances(): void;
  /**
   * Opens the instance dialog (#3003). The provider mounts the one `RemoteInstanceDialog`, so the
   * Instances tab, the rail's instance menu, the recovery screen and the remote banner all open the
   * same dialog and it survives the page under it changing (a switch, or a re-pair that reconnects
   * the shell). Opening it again replaces the open one; a profile that is not a saved remote is
   * ignored. Outside the desktop app it does nothing.
   */
  openInstanceDialog(options: OpenInstanceDialogOptions): void;
  goToThisMachine(): Promise<void>;
  reportActiveStatus(status: InstanceStatus): void;
}

const localProfile: InstanceProfile = {
  id: "local",
  serverInstanceId: "local",
  kind: "local",
  label: "This Machine",
  origin: DASHBOARD_ORIGIN ?? CONTROL_PLANE_HTTP,
  createdAt: "",
};

export const browserInstanceManager: InstanceManager = {
  desktopMultiInstance: false,
  registry: { profiles: [localProfile], activeInstanceId: "local" },
  activeProfile: localProfile,
  runtime: null,
  navigation: undefined,
  phase: "ready",
  error: null,
  statusByProfile: { local: { availability: "online" } },
  async switchInstance() {},
  async retryActive() {},
  async addInstance() {
    throw new Error("Remote instances are available only in the Wollipog desktop app.");
  },
  async editInstance() {
    throw new Error("Remote instances are available only in the Wollipog desktop app.");
  },
  async repairInstance() {
    throw new Error("Remote instances are available only in the Wollipog desktop app.");
  },
  async removeInstance() {
    throw new Error("Remote instances are available only in the Wollipog desktop app.");
  },
  manageInstances() {},
  openInstanceDialog() {},
  async goToThisMachine() {},
  reportActiveStatus() {},
};

const InstancesContext = createContext<InstanceManager>(browserInstanceManager);

export function InstancesContextProvider({
  value,
  children,
}: {
  value: InstanceManager;
  children: ReactNode;
}) {
  return <InstancesContext.Provider value={value}>{children}</InstancesContext.Provider>;
}

export function useInstances(): InstanceManager {
  return useContext(InstancesContext);
}

/** A URL that another browser can actually use for the active control plane. */
export function instancePublicOrigin(
  manager: Pick<InstanceManager, "activeProfile">,
  localDashboardOrigin: string | null = DASHBOARD_ORIGIN,
): string | null {
  return manager.activeProfile.kind === "remote" ? manager.activeProfile.origin : localDashboardOrigin;
}
