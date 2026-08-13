import { invoke, isTauri } from "@tauri-apps/api/core";

export interface InstanceProfile {
  id: string;
  serverInstanceId: string;
  kind: "local" | "remote";
  label: string;
  origin: string;
  createdAt: string;
  lastConnectedAt?: string;
}

export interface InstanceRegistrySnapshot {
  profiles: InstanceProfile[];
  activeInstanceId: string;
}

export interface NativeRuntimeHandle {
  profileId: string;
  runtimeKey: string;
  publicOrigin: string;
}

export interface DesktopInstanceRuntime {
  isTauri(): boolean;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const runtime: DesktopInstanceRuntime = { isTauri, invoke };

function requireDesktop(desktop: DesktopInstanceRuntime): void {
  if (!desktop.isTauri()) throw new Error("Remote instances are available only in the Wollipog desktop app.");
}

export async function readInstanceRegistry(desktop: DesktopInstanceRuntime = runtime): Promise<InstanceRegistrySnapshot | null> {
  if (!desktop.isTauri()) return null;
  return desktop.invoke("instance_registry");
}

export async function addRemoteInstance(
  input: { label: string; origin: string; token: string },
  desktop: DesktopInstanceRuntime = runtime,
): Promise<InstanceRegistrySnapshot> {
  requireDesktop(desktop);
  return desktop.invoke("add_remote_instance", input);
}

export async function editRemoteInstance(
  input: { profileId: string; label: string; origin: string; token?: string },
  desktop: DesktopInstanceRuntime = runtime,
): Promise<InstanceRegistrySnapshot> {
  requireDesktop(desktop);
  return desktop.invoke("edit_remote_instance", input);
}

export async function repairRemoteInstance(
  profileId: string,
  token: string,
  desktop: DesktopInstanceRuntime = runtime,
): Promise<InstanceRegistrySnapshot> {
  requireDesktop(desktop);
  return desktop.invoke("repair_remote_instance", { profileId, token });
}

export async function removeRemoteInstance(
  profileId: string,
  desktop: DesktopInstanceRuntime = runtime,
): Promise<InstanceRegistrySnapshot> {
  requireDesktop(desktop);
  return desktop.invoke("remove_remote_instance", { profileId });
}

export async function setActiveInstance(
  profileId: string,
  desktop: DesktopInstanceRuntime = runtime,
): Promise<InstanceRegistrySnapshot> {
  requireDesktop(desktop);
  return desktop.invoke("set_active_instance", { profileId });
}

export async function openRemoteTransport(
  profileId: string,
  desktop: DesktopInstanceRuntime = runtime,
): Promise<NativeRuntimeHandle> {
  requireDesktop(desktop);
  return desktop.invoke("remote_transport_open", { profileId });
}
