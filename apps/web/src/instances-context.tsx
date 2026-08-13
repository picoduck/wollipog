import React, { createContext, useContext, type ReactNode } from "react";
import type { InstanceProfile, InstanceRegistrySnapshot } from "./desktop-instances.js";
import type { InstanceRuntime } from "./instance-runtime.js";
import type { ViewNavigation } from "./navigation.js";
import { CONTROL_PLANE_HTTP, DASHBOARD_ORIGIN } from "./config.js";

export type InstanceAvailability =
  | "saved"
  | "connecting"
  | "online"
  | "offline"
  | "authentication-required"
  | "incompatible"
  | "missing-credential";

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
