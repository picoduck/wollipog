import { invoke, isTauri } from "@tauri-apps/api/core";
import { deviceToken } from "./device-token.js";
import { suggestRunnerId } from "./onboarding.js";

export interface LocalRunnerStatus {
  available: boolean;
  enabled: boolean;
  running: boolean;
  runnerId: string | null;
  suggestedRunnerId?: string;
}

export interface LocalRunnerDesktopRuntime {
  isTauri: () => boolean;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

const runtime: LocalRunnerDesktopRuntime = { isTauri, invoke };

export function hasBundledLocalRunner(desktop: LocalRunnerDesktopRuntime = runtime): boolean {
  return desktop.isTauri();
}

export function isManagedLocalRunnerRepair(
  runnerId: string,
  status: LocalRunnerStatus | null,
  bundledLocalRunner: boolean,
  localInstanceActive: boolean,
): boolean {
  return bundledLocalRunner
    && localInstanceActive
    && status?.available === true
    && status.runnerId === runnerId;
}

/** Browser dashboards cannot install processes on the machine serving Wollipog. */
export async function readLocalRunnerStatus(
  desktop: LocalRunnerDesktopRuntime = runtime,
): Promise<LocalRunnerStatus | null> {
  if (!desktop.isTauri()) return null;
  return desktop.invoke<LocalRunnerStatus>("local_runner_status");
}

/** Provision a machine-bound credential and start the runner bundled with the desktop app. */
export async function connectLocalRunner(
  runnerId: string,
  desktop: LocalRunnerDesktopRuntime = runtime,
  authorizationToken: string | null = deviceToken(),
): Promise<LocalRunnerStatus> {
  if (!desktop.isTauri()) throw new Error("Local runner setup is available only in the Wollipog desktop app.");
  return desktop.invoke<LocalRunnerStatus>("connect_local_runner", {
    runnerId,
    localDeviceToken: authorizationToken,
  });
}

/** Keep a configured identity; otherwise deconflict this installation's stable suggestion. */
export function selectLocalRunnerId(
  status: LocalRunnerStatus,
  existingRunnerIds: string[],
): string {
  return status.runnerId ?? suggestRunnerId(existingRunnerIds, status.suggestedRunnerId || "this-machine");
}
