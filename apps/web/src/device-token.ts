/**
 * Dashboard credential storage + pairing-link parsing for local and remote dashboards.
 * The token rides every REST call (Authorization: Bearer) and the /ui socket (?token=).
 * Pairing links carry the token in the URL FRAGMENT (`#pair=<token>`) so it never reaches
 * server logs; the app adopts it at boot and strips it from the address bar.
 */

import { loadBrowserStorageValue, saveBrowserStorageValue } from "./instance-storage.js";

const KEY = "wollipog.deviceToken";

/** Fired on window after storeDeviceToken() so the live /ui socket reconnects with the new
 * token IN-PROCESS. A reload would lose the in-memory fallback below (the only copy when
 * localStorage is blocked), stranding the pairing flow in a loop. */
export const DEVICE_TOKEN_CHANGED_EVENT = "wollipog:device-token-changed";

/**
 * Token shape: the control plane mints 32-byte base64url tokens (43 chars, auth.ts). Accept a
 * generous band around that, but reject unbounded input — a pasted multi-KB string would
 * otherwise persist, ride the WS upgrade URL past header limits, and close with an abnormal
 * 1006 (not the pairing-flow 1008), wedging an installed app that has no address bar to
 * recover from.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
/** A whole address-bar fragment: nothing but the pair token. */
const FRAGMENT_RE = /^#pair=([A-Za-z0-9_-]{16,256})$/;
/** A pasted pairing LINK: the same fragment at the end of a URL. */
const LINK_RE = /#pair=([A-Za-z0-9_-]{16,256})$/;

// In-memory fallback so a token adopted from a pairing link still authenticates the current
// session even when localStorage is blocked (iOS private mode, storage-partitioned webview).
// It's shown-once, so we must not lose it just because it can't persist.
let memToken: string | null = null;

export function deviceToken(): string | null {
  return loadBrowserStorageValue(KEY) ?? memToken;
}

export function storeDeviceToken(token: string): void {
  memToken = token;
  try {
    saveBrowserStorageValue(KEY, token);
  } catch {
    /* localStorage unavailable — memToken keeps the session authenticated until reload */
  }
}

/** The token from a `#pair=<token>` fragment, or null. Pure — unit-tested. */
export function parsePairingFragment(hash: string): string | null {
  const m = FRAGMENT_RE.exec(hash);
  return m ? m[1]! : null;
}

export interface PairingReach {
  /** Addresses the control plane is actually reachable at (server-computed from its bind host). */
  hosts: string[];
  port: number;
  /** The control plane has a web bundle to serve (else the link 404s). */
  webServed: boolean;
  /** The control plane is bound past loopback (else the phone can't reach it). */
  boundBeyondLoopback: boolean;
  /**
   * Operator-configured dashboard origin (`CONTROL_PLANE_PUBLIC_ORIGIN`, protocol v114+): the
   * address remote clients actually reach, typically an HTTPS reverse proxy or Tailscale Serve in
   * front of a loopback-bound control plane. When set it is the pairing link.
   */
  publicOrigin?: string | null;
  remoteAccess?: { phase: string; message: string };
}

/** A usable http(s) origin from the operator's public-origin setting, or null. */
function publicOriginLink(publicOrigin: string | null | undefined, token: string): string | null {
  if (!publicOrigin) return null;
  try {
    const url = new URL(publicOrigin);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) return null;
    const path = url.pathname.replace(/\/+$/u, "");
    return `${url.origin}${path}/#pair=${token}`;
  } catch {
    return null;
  }
}

/**
 * Why a freshly-minted token has no link another device can open. A code, not a sentence: Pair
 * Device owns the words (#2999), so they stay in the person's language and the operator's detail
 * stays behind Show Details.
 * - `not-web-served`: the control plane has no web bundle to serve, so a link would 404;
 * - `remote-access`: secure remote access is set up but not ready;
 * - `loopback`: bound to this computer only, with no public origin configured;
 * - `no-address`: bound past loopback, but no network address was found.
 */
export type PairingBlocker = "not-web-served" | "remote-access" | "loopback" | "no-address";

/**
 * Clickable pairing links for a freshly-minted token, or the reason none can be offered. Pure so
 * the "don't show a dead link" rule is unit-tested rather than re-litigated in JSX. IPv6 literals
 * are bracketed so the URL stays valid.
 */
export function pairingLinks(token: string, reach: PairingReach): { links: string[]; blocked: PairingBlocker | null } {
  if (!reach.webServed) return { links: [], blocked: "not-web-served" };
  // The operator said where remote clients reach the dashboard; that beats guessing from the bind
  // address, and it is the only link that works for a loopback bind behind a reverse proxy.
  if (reach.remoteAccess && reach.remoteAccess.phase !== "ready") return { links: [], blocked: "remote-access" };
  const configured = publicOriginLink(reach.publicOrigin, token);
  if (configured) return { links: [configured], blocked: null };
  if (!reach.boundBeyondLoopback) return { links: [], blocked: "loopback" };
  if (reach.hosts.length === 0) return { links: [], blocked: "no-address" };
  const host = (h: string) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);
  return { links: reach.hosts.map((h) => `http://${host(h)}:${reach.port}/#pair=${token}`), blocked: null };
}

/**
 * The pairing link for another browser on this computer, at the page's own origin, for when no
 * other device can reach one. Null where no browser could open it: a page not served over http(s),
 * or the packaged desktop app's `tauri.localhost`, which exists only inside that process (the rule
 * `resolveDashboardOrigin` in config.ts applies).
 */
export function sameComputerPairingLink(token: string, origin: string): string | null {
  try {
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "tauri.localhost") return null;
    return `${url.origin}/#pair=${token}`;
  } catch {
    return null;
  }
}

/**
 * A token from whatever the user pastes into the pairing card: a bare token, a `#pair=<token>`
 * fragment, or a whole pairing link. Needed because an INSTALLED iOS PWA gets storage
 * partitioned from Safari — a token adopted in the browser tab does not carry into the
 * home-screen app, and a standalone app has no address bar to open a link in. Pure — unit-tested.
 */
export function parsePairingInput(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 2048) return null;
  if (TOKEN_RE.test(t)) return t;
  const m = LINK_RE.exec(t);
  return m ? m[1]! : null;
}

/** Adopt a pairing link at boot: store the token and scrub it from the address bar (it must
 * not linger in the URL where a screenshot/share would leak it). Returns true when adopted. */
export function adoptPairingFragment(): boolean {
  const token = parsePairingFragment(window.location.hash);
  if (!token) return false;
  storeDeviceToken(token);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return true;
}
