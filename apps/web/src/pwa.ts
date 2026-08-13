/**
 * Service-worker registration for the installed PWA. The worker (public/sw.js) intentionally
 * has no fetch handler — see its header comment — so registering it changes nothing about how
 * the app loads; it only makes the app installable everywhere and gives push a landing spot.
 */

/**
 * Whether to register the service worker — pure, so the policy is unit-tested:
 *  - the browser must support it (`supported`);
 *  - the context must be secure (registration throws otherwise): https, or the localhost
 *    loopback the local dashboard uses;
 *  - NOT the Tauri shell (`tauri.localhost`): it loads its own frontendDist and a worker
 *    would be pure noise there. `isSecureContext` is already true for it, so match the host.
 */
export function shouldRegisterServiceWorker(env: {
  supported: boolean;
  secureContext: boolean;
  hostname: string;
}): boolean {
  if (!env.supported || !env.secureContext) return false;
  return env.hostname !== "tauri.localhost";
}

/** Best-effort registration at boot (never blocks or breaks rendering). */
export function registerServiceWorker(): void {
  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  if (
    !shouldRegisterServiceWorker({
      supported,
      secureContext: typeof window !== "undefined" && window.isSecureContext,
      hostname: typeof location !== "undefined" ? location.hostname : "",
    })
  ) {
    return;
  }
  // After load, so the first paint never competes with the SW install.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* registration is an enhancement — the dashboard works identically without it */
    });
  });
}
