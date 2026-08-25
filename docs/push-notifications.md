# Push notifications (Web Push / push-to-wake)

> Shipped 2026-07-10 (the second half of the mobile arc; the responsive/installable PWA is the
> first). Design: live socket while foregrounded, push-to-wake otherwise; Web Push first because
> it needs no app and no relay.

The control plane now notifies subscribed browsers **out-of-band** — with the tab closed, the
phone locked, or the PWA backgrounded — at the attention moments:

- **needs your input** — a permission request, an agent question (AskUserQuestion), or a
  guardrail pause (cost budget / tool-call limit), carrying the ask's title (urgency `high`);
- **ready** — a turn settled to idle after running;
- **completed / failed** — terminal outcomes;
- **managed background result ready** — a durable, per-subscription outbox created from the
  structured continuation event.

The decision policy is `apps/control-plane/src/push-decision.ts` — deliberately the twin of the
web app's in-tab `notifyDecision` (apps/web/src/notify.ts), so a phone and an open dashboard
alert on the same moments. Emission happens at the status-transition points in
`SessionsService` (runner status changes, permission/question requests, mid-turn guardrail
parks); runner reconnect/hydration paths deliberately do not emit, so a flapping box can't spam
phones. Session notifications are tagged by session id; automation notifications use their
automation id. In both cases a newer state replaces the older card instead of stacking. Selected
automation started/succeeded/failed/expired events open the Automations view. See
[durable automations](./automations.md) for schedule and laptop-off guarantees.

## Stack (zero dependencies)

`apps/control-plane/src/web-push.ts` implements the full protocol stack on `node:crypto`:

- **RFC 8291 / RFC 8188** payload encryption (`aes128gcm`): ECDH P-256 against the
  subscription's `p256dh` key + 16-byte `auth` secret, double HKDF, AES-128-GCM, single
  record. Pinned to RFC 8291 Appendix A's test vector **byte-for-byte** (including the IKM /
  CEK / nonce intermediates) in web-push.test.ts.
- **RFC 8292 VAPID**: ES256 JWT (`aud` = the push service's origin, 12 h expiry), sent as
  `Authorization: vapid t=…, k=…`.
- The push service (FCM, Mozilla autopush, Apple's relay) sees only opaque ciphertext.

**Keys:** the VAPID keypair is generated once, lazily, and persisted in sqlite (`push_vapid`,
first-write-wins). Only the PUBLIC key ever leaves the server (`GET /api/push/vapid-public-key`
— it's what `pushManager.subscribe()` needs). Regenerating the pair would orphan every
subscription, which is why it's persisted rather than derived per boot.

**Subscriptions** live in `push_subscriptions`, keyed by endpoint, tied to the paired device
that created them (`NULL` for the authenticated local-bootstrap dashboard) — **revoking a device
also silences its pushes**. Rows self-prune when the push service answers 404/410 (browser unsubscribed, PWA
uninstalled) or when stored keys can't encrypt.

Managed-background notifications use `background_push_deliveries`, separate from the legacy
best-effort status notifier. Each row has a stable delivery id, lease, retry schedule, expiry, and
privacy-safe endpoint hash. A 2xx response records only **Push Service Accepted**. The encrypted
payload carries a high-entropy HMAC capability; after `showNotification()` resolves the service
worker records **Notification Displayed**, and a notification click records **Notification
Clicked**. Neither a WebSocket enqueue nor a push-service response is described as user-visible.
Restart recovery claims expired leases and retries only the notification card.
The capability-bearing endpoint is erased from an outbox row once retry is no longer possible;
only its hash and stage evidence remain.

## Routes

Normal `/api/*` gating requires the local startup credential or a paired-device bearer:

- `GET /api/push/vapid-public-key` → `{ publicKey }`
- `POST /api/push/subscriptions` `{ endpoint, keys: { p256dh, auth } }` — validated
  (https-only, real P-256 point, 16-byte auth), upserted
- `POST /api/push/unsubscribe` `{ endpoint }`

The service worker also uses `POST /api/public/push-receipt` with its per-delivery capability. The
route is content-bounded, rate-admitted, origin-checked, and returns no delivery-existence oracle.

## Client

The 📳 **Push** toggle (sidebar footer) renders only where push can work: a **secure context**
(localhost or HTTPS — plain `http://<lan-ip>` cannot subscribe; put the CP behind
`tailscale serve` for phones) with a registered service worker (so never in the Tauri shell).
On iOS the PWA must be **installed to the home screen** (Web Push exists there since 16.4,
installed-only). The service worker (`apps/web/public/sw.js`) shows the notification and, on
tap, focuses a live dashboard and deep-links it (`postMessage`) or opens `/#open=<sessionId>`;
automation notifications similarly open `/#view=automations`. The store adopts and scrubs the
fragment at boot — the same pattern as `#pair=`. The worker still has
**no fetch handler** (see its header comment: caching the shell would strip the request-time
same-origin marker).

## Sequel

Signed webhook and provider-neutral chat-ops automation triggers are now shipped; see
[signed automation triggers](./automation-triggers.md). They are inbound channels and, like Web
Push, still require an online control plane. The remaining research steps are an outbound relay for
the laptop-asleep case and a Capacitor wrapper if store presence or native push ever matters.
