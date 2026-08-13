import { invoke, isTauri } from "@tauri-apps/api/core";

export interface TailnetAccessStatus {
  available: boolean;
  enabled: boolean;
  managed: boolean;
}

/**
 * What the Network panel needs to know, which is more than a status.
 *
 * `status === null` used to mean four different things — still reading, not a desktop app, no
 * Tailscale, or the read failed — and the panel rendered one sentence for all four. Two of them
 * were false statements about the user's machine.
 */
export interface TailnetAccessSetting {
  status: TailnetAccessStatus | null;
  /** True until the first read settles, either way. */
  loading: boolean;
  /** False in a browser or PWA, where the desktop sidecar this manages does not exist. */
  desktop: boolean;
  busy: boolean;
  error: string | null;
  toggle: () => void;
}

export interface TailnetDesktopRuntime {
  isTauri: () => boolean;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

const runtime: TailnetDesktopRuntime = { isTauri, invoke };

/** Whether this window is the desktop app at all, which is a different fact from "Tailscale is
 *  installed" — the Network panel has to say which of the two is missing. */
export function isTauriRuntime(desktop: TailnetDesktopRuntime = runtime): boolean {
  return desktop.isTauri();
}

/** Browser/PWA dashboards do not own the desktop sidecar and therefore never show this setting. */
export async function readTailnetAccess(
  desktop: TailnetDesktopRuntime = runtime,
): Promise<TailnetAccessStatus | null> {
  if (!desktop.isTauri()) return null;
  return desktop.invoke<TailnetAccessStatus>("tailnet_access_status");
}

export async function writeTailnetAccess(
  enabled: boolean,
  desktop: TailnetDesktopRuntime = runtime,
): Promise<TailnetAccessStatus> {
  if (!desktop.isTauri()) throw new Error("Tailnet access is available only in the Wollipog desktop app.");
  return desktop.invoke<TailnetAccessStatus>("set_tailnet_access", { enabled });
}

export function tailnetAccessDescription(status: TailnetAccessStatus): string {
  if (!status.managed) return "Unavailable while another control plane owns port 4317.";
  return status.enabled
    ? "Paired browsers can connect through this machine's Tailscale address."
    : "Allow paired browsers on this machine's tailnet.";
}
