/**
 * Service worker for the installed PWA.
 *
 * DELIBERATELY NO fetch/cache handler: the control plane injects the same-origin marker
 * (`window.__WOLLIPOG_SAME_ORIGIN__`) into index.html AT REQUEST TIME (see web-dist.ts). A cached
 * shell would drop that marker on a later load and point the app at 127.0.0.1 — which, on a
 * phone, is the phone itself. Installability no longer requires an offline handler (and a live
 * dashboard is useless offline anyway); this worker exists so the app can install cleanly and
 * so push has somewhere to land (below).
 */

self.addEventListener("install", () => {
  // Take over from any previous worker version immediately — there is no cache to migrate.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* ------------------------------- Web Push -------------------------------- */
// Payloads arrive already decrypted by the browser (RFC 8291); the JSON body is
// { title, body, sessionId?, view?, notificationKey? } from the control plane.

// Newest shown state per tag, kept for this worker instance's lifetime: a live notification
// carries its ts in data, but a DISMISSED one leaves no trace — without this memory, a
// delayed out-of-order push arriving after a dismiss would resurrect stale state. (A
// terminated worker forgets; a push that late shows a stale-but-tappable card, and the tap
// lands on the live session state. Accepted residual — persisting would need IndexedDB.)
const newestShown = new Map();

function encodeRouteId(value) {
  let binary = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    binary += String.fromCharCode(code & 0xff, code >>> 8);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function acknowledgePushReceipt(receipt, stage) {
  if (!receipt || typeof receipt.deliveryId !== "string" || typeof receipt.token !== "string") return;
  try {
    await fetch("/api/public/push-receipt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId: receipt.deliveryId, token: receipt.token, stage }),
    });
  } catch {
    // Display/navigation must not fail because the receipt connection is unavailable. The
    // control plane keeps service acceptance distinct and surfaces a missing display receipt.
  }
}

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    /* not JSON — show the generic card below */
  }
  const sessionId = data && typeof data.sessionId === "string" ? data.sessionId : null;
  const view = data && data.view === "automations" ? "automations" : null;
  const incoming = {
    title: (data && data.title) || "Wollipog",
    body: (data && data.body) || "A session needs attention.",
    ts: data && typeof data.ts === "number" ? data.ts : 0,
    sessionId,
    view,
    receipt: data && data.receipt && typeof data.receipt === "object" ? data.receipt : null,
  };
  // Explicit notification/session keys are stable across worker versions. During an old/new worker
  // handoff only a fully generic card can momentarily use two local tags; payload delivery and
  // navigation remain compatible, and the new worker converges on the Wollipog tag.
  const tag = (data && typeof data.notificationKey === "string" && data.notificationKey) || sessionId || "wollipog";
  event.waitUntil(
    (async () => {
      // Same tag = one live card per session; but push services can deliver out of order
      // and "last arrival wins" would let an older state replace a newer card. Keep the
      // NEWEST by send-time ts, remembering dismissed cards' stamps too (a notification
      // must still be shown — re-show the newest known state).
      const existing = await self.registration.getNotifications({ tag });
      const candidates = existing
        .map((n) => n.data)
        .filter((d) => d && typeof d.ts === "number")
        .concat(newestShown.has(tag) ? [newestShown.get(tag)] : [], [incoming]);
      const show = candidates.reduce((a, b) => (b.ts > a.ts ? b : a));
      newestShown.set(tag, {
        title: show.title, body: show.body, ts: show.ts,
        sessionId: show.sessionId || null, view: show.view || null,
        receipt: show.receipt || null,
      });
      if (newestShown.size > 500) newestShown.delete(newestShown.keys().next().value); // bound it
      await self.registration.showNotification(show.title, {
        body: show.body,
        tag,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: {
          sessionId: show.sessionId || null,
          view: show.view || null,
          ts: show.ts,
          title: show.title,
          body: show.body,
          receipt: show.receipt || null,
        },
      });
      await acknowledgePushReceipt(show.receipt, "shown");
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  const view = event.notification.data && event.notification.data.view;
  const receipt = event.notification.data && event.notification.data.receipt;
  event.waitUntil(
    (async () => {
      const acknowledgement = acknowledgePushReceipt(receipt, "clicked");
      // Prefer focusing a live dashboard and deep-linking it in place; only open a new
      // window when none exists. Canonical paths survive reload and browser history.
      try {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const client = windows[0];
        if (client) {
          await client.focus();
          if (sessionId) client.postMessage({ type: "wollipog:open-session", sessionId });
          else if (view === "automations") client.postMessage({ type: "wollipog:open-automations" });
        } else {
          await self.clients.openWindow(sessionId ? `/sessions/~${encodeRouteId(sessionId)}` : view === "automations" ? "/automations" : "/");
        }
      } finally {
        // The click is already a fact even if focusing/navigation fails.
        await acknowledgement;
      }
    })(),
  );
});
