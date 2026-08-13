import { invoke, isTauri } from "@tauri-apps/api/core";
import { parsePairingInput, storeDeviceToken } from "./device-token.js";

export interface DesktopLocalPairingRuntime {
  isTauri(): boolean;
  invoke<T>(command: string): Promise<T>;
}

const runtime: DesktopLocalPairingRuntime = { isTauri, invoke };
let lastPairingFailure: string | null = null;

export function desktopLocalPairingFailure(): string | null {
  return lastPairingFailure;
}

/**
 * Adopt the credential for the desktop-owned sidecar before the first API request or WebSocket.
 * The native command returns null when another control plane owns the port; in that case the
 * ordinary pairing banner remains the recovery path and no stale app-data credential is tried.
 */
export async function adoptManagedDesktopPairing(
  desktop: DesktopLocalPairingRuntime = runtime,
  store: (token: string) => void = storeDeviceToken,
): Promise<boolean> {
  if (!desktop.isTauri()) {
    lastPairingFailure = null;
    return false;
  }
  try {
    const pairingUrl = await desktop.invoke<string | null>("local_pairing_url");
    if (!pairingUrl) {
      lastPairingFailure = null;
      return false;
    }
    const token = parsePairingInput(pairingUrl);
    if (!token) throw new Error("the desktop returned an invalid local pairing credential");
    store(token);
    lastPairingFailure = null;
    return true;
  } catch (error) {
    lastPairingFailure = error instanceof Error ? error.message : "the desktop could not read its local pairing credential";
    throw error;
  }
}
