/**
 * Where the dashboard finds its control plane.
 *
 * Three deployments, one build:
 *  - **Served BY the control plane** (a phone/LAN browser at `http://<host>:<port>`): the CP
 *    injects `window.__WOLLIPOG_SAME_ORIGIN__` into the index.html it serves, so we talk to
 *    `location.origin`. Hardcoding 127.0.0.1 here would point the phone at ITSELF.
 *  - **Vite dev** (`localhost:5173`) and the **Tauri shell** (`tauri.localhost`): no marker —
 *    fall back to the loopback control plane.
 *  - Any of the above, overridden explicitly by `VITE_CONTROL_PLANE_*` at build time.
 */

declare global {
  interface Window {
    __WOLLIPOG_SAME_ORIGIN__?: number;
    /** Compatibility bridge for web bundles built before TODO-001 Stage 1. */
    __MAM_SAME_ORIGIN__?: number;
  }
}

export function hasSameOriginMarker(value: {
  __WOLLIPOG_SAME_ORIGIN__?: number;
  __MAM_SAME_ORIGIN__?: number;
} | undefined): boolean {
  return value?.__WOLLIPOG_SAME_ORIGIN__ === 1 || value?.__MAM_SAME_ORIGIN__ === 1;
}

const sameOrigin = typeof window !== "undefined" && hasSameOriginMarker(window);
// Vite supplies import.meta.env in browser builds. Direct Node tests import the store without a
// Vite transform, so keep the default deployment values available there too.
const buildEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

export function resolveDashboardOrigin(input: {
  configured?: string;
  pageOrigin: string;
  pageHostname: string;
  sameOriginServed: boolean;
}): string | null {
  const httpOrigin = (value: string): string | null => {
    try {
      const url = new URL(value);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
      return url.origin;
    } catch {
      return null;
    }
  };
  if (input.configured) {
    return httpOrigin(input.configured);
  }
  if (input.sameOriginServed) return httpOrigin(input.pageOrigin);
  // A packaged Tauri origin exists only inside that desktop process. A copied tauri.localhost or
  // implicit 127.0.0.1 URL is not a shareable dashboard destination, so require explicit config.
  if (input.pageHostname === "tauri.localhost") return null;
  return httpOrigin(input.pageOrigin); // Vite/browser development server
}

export const CONTROL_PLANE_HTTP =
  buildEnv.VITE_CONTROL_PLANE_HTTP ?? (sameOrigin ? window.location.origin : "http://127.0.0.1:4317");

export const CONTROL_PLANE_WS =
  buildEnv.VITE_CONTROL_PLANE_WS ??
  (sameOrigin
    ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`
    : "ws://127.0.0.1:4317");

export const DASHBOARD_ORIGIN = typeof window === "undefined"
  ? null
  : resolveDashboardOrigin({
      configured: buildEnv.VITE_DASHBOARD_ORIGIN,
      pageOrigin: window.location.origin,
      pageHostname: window.location.hostname,
      sameOriginServed: sameOrigin,
    });
