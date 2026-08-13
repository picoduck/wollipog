/**
 * Web Push client plumbing: subscribe this browser to the control plane's push fan-out.
 *
 * Support is narrower than desktop notifications: Web Push needs a secure context
 * (localhost or HTTPS — e.g. `tailscale serve`; plain http://<lan-ip> cannot subscribe), a
 * registered service worker (pwa.ts skips the Tauri shell), and on iOS the PWA must be
 * INSTALLED to the home screen. The toggle simply doesn't render where it can't work.
 */

export type PushSetting = {
  state: "unavailable" | "off" | "on" | "busy";
  /**
   * The last state the server confirmed, held across a pending toggle.
   *
   * Lives here rather than in the row because the row unmounts when the user leaves Settings: a
   * ref inside it re-initialised from "busy" on remount and reported off while the subscription
   * was still deliverable. `usePushSetting` is mounted by the shell and outlives the page.
   */
  confirmed: boolean;
  toggle: () => Promise<void>;
};

import type { ApiClient } from "./api.js";

type PushApi = Pick<ApiClient,
  "subscribePush" | "unsubscribePush" | "getVapidPublicKey"
>;

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined" &&
    window.isSecureContext
  );
}

/** applicationServerKey wants raw bytes; VAPID public keys travel base64url. Pure — tested. */
export function urlBase64ToUint8Array(b64url: string): Uint8Array {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The inverse, for comparing a subscription's bound applicationServerKey against the
 * server's current VAPID key. Pure — tested. */
export function bufferSourceToUrlBase64(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The `#open=<sessionId>` deep-link fragment a notification click lands on. Pure — tested. */
export function parseOpenFragment(hash: string): string | null {
  const m = /^#open=([A-Za-z0-9_-]{1,64})$/.exec(hash);
  return m ? m[1]! : null;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  // getRegistration (not .ready): where pwa.ts deliberately never registered (Tauri shell),
  // .ready would await forever and wedge the toggle.
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await registration();
  if (!reg) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** Can push actually work here? Support alone isn't enough — a secure browser where SW
 * registration failed (or was deliberately skipped, e.g. the Tauri shell) has the APIs but
 * no registration; a toggle there would be a dead button. On a FIRST visit registration
 * only starts after window load, so wait (bounded) for `.ready` before concluding "no" —
 * otherwise the toggle stays hidden until a reload. */
export async function pushAvailable(): Promise<boolean> {
  if (!pushSupported()) return false;
  if ((await registration()) !== null) return true;
  const settled = await Promise.race([
    navigator.serviceWorker.ready, // resolves once a registration activates; never rejects
    new Promise<null>((r) => setTimeout(() => r(null), 5000)),
  ]).catch(() => null);
  return settled !== null;
}

/** POST a subscription's keys to the control plane; false when it can't be registered. */
async function registerWithServer(api: PushApi, sub: PushSubscription): Promise<boolean> {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) return false;
  try {
    await api.subscribePush({ endpoint: sub.endpoint, keys: { p256dh, auth } });
    return true;
  } catch {
    // Offline CP, capacity 409, auth failure — the server will NOT send; report it honestly
    // (the next boot/token change retries).
    return false;
  }
}

/**
 * Boot/token-change reconciliation: the browser-local PushSubscription outlives the server
 * row (device revoked then re-paired, CP database reset, ownership change). If one exists,
 * idempotently re-register it (upsert server-side). `registered` reports whether the server
 * NOW holds a DELIVERABLE row — the toggle may claim "on" only when it does.
 *
 * VAPID drift: a reset control-plane database mints a new VAPID pair, but the local
 * subscription stays bound to the OLD applicationServerKey — registering it would look
 * healthy while every send bounces 401/403. When the bound key differs from the server's
 * current one, re-subscribe against the new key (permission is already granted — no
 * prompt) instead of registering a dead subscription.
 */
export async function reconcilePushSubscription(api: PushApi): Promise<{
  sub: PushSubscription | null;
  registered: boolean;
}> {
  let sub = await currentPushSubscription();
  if (!sub) return { sub: null, registered: false };
  try {
    const { publicKey } = await api.getVapidPublicKey();
    const bound = sub.options?.applicationServerKey;
    if (bound && bufferSourceToUrlBase64(bound) !== publicKey) {
      const reg = await registration();
      if (!reg) return { sub, registered: false };
      await sub.unsubscribe().catch(() => {});
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
    }
  } catch {
    // Couldn't fetch the server key (offline CP) — fall through and try a plain register;
    // it will report false and the next boot/token change retries.
  }
  return { sub, registered: await registerWithServer(api, sub) };
}

/** Ask permission, subscribe with the server's VAPID key, and register the subscription.
 * Returns whether push is now active. */
export async function enablePush(api: PushApi): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await registration();
  if (!reg) return false;
  if ((await Notification.requestPermission()) !== "granted") return false;
  const { publicKey } = await api.getVapidPublicKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) {
    // A subscription we can't encrypt to is useless server-side — roll it back.
    await sub.unsubscribe().catch(() => {});
    return false;
  }
  try {
    await api.subscribePush({ endpoint: sub.endpoint, keys: { p256dh, auth } });
  } catch (err) {
    await sub.unsubscribe().catch(() => {});
    throw err;
  }
  return true;
}

export async function disablePush(api: PushApi): Promise<void> {
  const sub = await currentPushSubscription();
  if (!sub) return;
  // Server first (best-effort — a dead row also self-prunes on the next 404/410), then local.
  await api.unsubscribePush(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
