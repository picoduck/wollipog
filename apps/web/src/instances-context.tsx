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
 * What the shell's connection banner says about the active instance, which the rail tile must agree
 * with (#1970): a lost connection is "reconnecting" from its first offline report until it is back,
 * and a rejected credential needs signing in again. Null while the connection is live or first
 * opening. The banner shows only in these states, so the tile is never Online beside it.
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

export type InstanceShellPhase = "loading" | "opening" | "ready" | "failed" | "missing";

export interface InstanceStatus {
  availability: InstanceAvailability;
  message?: string;
}

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
  addAndSwitch(input: { label: string; origin: string; token: string }): Promise<void>;
  editInstance(input: { profileId: string; label: string; origin: string; token?: string }): Promise<void>;
  repairInstance(profileId: string, token: string): Promise<void>;
  removeInstance(profileId: string): Promise<void>;
  manageInstances(): void;
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
  async addAndSwitch() {
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
