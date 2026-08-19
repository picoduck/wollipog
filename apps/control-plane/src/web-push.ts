/**
 * Web Push (RFC 8030) over VAPID (RFC 8292) with aes128gcm payload encryption (RFC 8291 /
 * RFC 8188), implemented directly on node:crypto — no dependencies, matching this repo's
 * zero-native-module stance. The encryption path is pinned to RFC 8291's Appendix A test
 * vector in web-push.test.ts (every intermediate: IKM, CEK, nonce, final body).
 *
 * Key handling: the VAPID keypair is generated once and persisted server-side (sqlite, like
 * the paired-device hashes); ONLY the public key is ever sent to a browser. The private key
 * signs short-lived JWTs — it must never ride a bundle, a URL, or a log line.
 *
 * Why pushes are safe to send blind: the payload is encrypted to the subscription's own
 * P-256 key (`p256dh`) + auth secret, so the push service (FCM/Mozilla/APNs relay) sees only
 * opaque bytes. Losing a subscription row leaks nothing but an endpoint URL.
 */

import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/* ------------------------------ base64url ------------------------------- */

export function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/* ------------------------------ VAPID keys ------------------------------ */

export interface VapidKeys {
  /** base64url of the 65-byte uncompressed P-256 public point — what the browser subscribes with. */
  publicKey: string;
  /** JSON of the private key JWK (d/x/y). Server-side secret. */
  privateJwk: string;
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  const publicPoint = Buffer.concat([Buffer.from([0x04]), b64urlDecode(jwk.x), b64urlDecode(jwk.y)]);
  return { publicKey: b64url(publicPoint), privateJwk: JSON.stringify(jwk) };
}

/**
 * The `Authorization: vapid t=<jwt>, k=<pub>` header for one push-service origin.
 * exp is 12h (the RFC 8292 ceiling is 24h); aud is the ENDPOINT'S origin, not ours.
 */
export function vapidAuthHeader(
  endpoint: string,
  keys: VapidKeys,
  nowMs: number,
  subject = "https://github.com/picoduck/wollipog",
): string {
  const aud = new URL(endpoint).origin;
  const seg = (o: object) => b64url(Buffer.from(JSON.stringify(o)));
  const input = `${seg({ typ: "JWT", alg: "ES256" })}.${seg({
    aud,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    sub: subject,
  })}`;
  const key = createPrivateKey({ key: JSON.parse(keys.privateJwk), format: "jwk" });
  // JWT ES256 wants the raw 64-byte r||s form, not ASN.1 DER.
  const sig = createSign("SHA256").update(input).sign({ key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${b64url(sig)}, k=${keys.publicKey}`;
}

/* ----------------------- RFC 8291 payload encryption --------------------- */

export interface PushSubscriptionKeys {
  /** base64url, 65-byte uncompressed P-256 point from PushSubscription.getKey("p256dh"). */
  p256dh: string;
  /** base64url, 16-byte auth secret from PushSubscription.getKey("auth"). */
  auth: string;
}

/** A subscription's keys decoded + shape-checked. Returns null (not throw) on any malformed
 * input — subscriber-supplied bytes must not be able to crash the send path. */
export function decodeSubscriptionKeys(keys: PushSubscriptionKeys): { uaPublic: Buffer; authSecret: Buffer } | null {
  try {
    const uaPublic = b64urlDecode(keys.p256dh);
    const authSecret = b64urlDecode(keys.auth);
    if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) return null;
    if (authSecret.length !== 16) return null;
    return { uaPublic, authSecret };
  } catch {
    return null;
  }
}

const RECORD_SIZE = 4096;

/**
 * Encrypt one push message body (RFC 8291 §3 + RFC 8188 aes128gcm, single record).
 * `testOverrides` injects the ephemeral key/salt so the RFC test vector can pin the output;
 * production callers omit it and get fresh randomness per message.
 */
export function encryptPushPayload(
  plaintext: Buffer,
  keys: PushSubscriptionKeys,
  testOverrides?: { ephemeralPrivate?: Buffer; salt?: Buffer },
): Buffer {
  const decoded = decodeSubscriptionKeys(keys);
  if (!decoded) throw new Error("malformed push subscription keys");
  const { uaPublic, authSecret } = decoded;
  // 16 bytes of header+delimiter+tag overhead; keep well inside one record.
  if (plaintext.length > RECORD_SIZE - 120) throw new Error("push payload too large");

  const ecdh = createECDH("prime256v1");
  if (testOverrides?.ephemeralPrivate) ecdh.setPrivateKey(testOverrides.ephemeralPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // 65-byte uncompressed
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.3–3.4: combine the ECDH secret with the auth secret, binding both public keys.
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));

  const salt = testOverrides?.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  // RFC 8188 body: header (salt | rs | idlen | keyid=as_public), then the sealed record.
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (only) record.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final()]);
  return Buffer.concat([header, asPublic, sealed, cipher.getAuthTag()]);
}

/* --------------------------- subscription intake -------------------------- */

export interface PushSubscriptionInput {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

/** Canonical, size-bounded base64url: decodes to exactly `bytes` AND re-encodes to the same
 * string. Node's decoder ignores whitespace/junk, so without the round-trip a valid encoding
 * padded toward the body limit would still "decode fine" and bloat every later send. */
function canonicalB64url(s: string, bytes: number): Buffer | null {
  // 4/3 with no padding: 65 bytes → 87 chars, 16 → 22.
  if (s.length !== Math.ceil((bytes * 4) / 3)) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  if (buf.length !== bytes || buf.toString("base64url") !== s) return null;
  return buf;
}

/** Is this 65-byte uncompressed encoding actually a point ON the P-256 curve? computeSecret
 * validates the peer point during oct2point — an off-curve blob (e.g. 0x04 || 64 zero bytes)
 * would otherwise persist and then throw on every send. */
export function isValidP256Point(point: Buffer): boolean {
  try {
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(point);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a subscribe request body. Note the trust model: only authenticated callers
 * (loopback or paired devices) reach the route at all, and a paired device already holds
 * full mutating API access — so this is shape/robustness validation, not a trust boundary.
 * https-only: every real push service is https, and it rules out plaintext delivery of the
 * (already end-to-end-encrypted) bodies plus obvious junk endpoints. Credentials in the URL
 * are refused — they would ride fetch error messages into logs.
 */
export function validateSubscription(body: unknown): PushSubscriptionInput | { error: string } {
  const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!b || typeof b.endpoint !== "string" || b.endpoint.length > 1024) {
    return { error: "endpoint (string, ≤1024 chars) is required" };
  }
  let url: URL;
  try {
    url = new URL(b.endpoint);
  } catch {
    return { error: "endpoint is not a valid URL" };
  }
  if (url.protocol !== "https:") return { error: "endpoint must be https" };
  if (url.username || url.password) return { error: "endpoint must not carry credentials" };
  if (typeof b.keys?.p256dh !== "string" || typeof b.keys?.auth !== "string") {
    return { error: "keys.p256dh and keys.auth are required" };
  }
  const point = canonicalB64url(b.keys.p256dh, 65);
  const auth = canonicalB64url(b.keys.auth, 16);
  if (!point || point[0] !== 0x04 || !auth) {
    return { error: "keys are not canonical base64url of a 65-byte point + 16-byte auth secret" };
  }
  if (!isValidP256Point(point)) return { error: "p256dh is not a point on the P-256 curve" };
  return { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } };
}

/* -------------------------------- sender --------------------------------- */

export interface StoredPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushAudience =
  | { kind: "session"; sessionId: string }
  | { kind: "organization_admin"; organizationId: string };

export interface PushMessage {
  title: string;
  body: string;
  /** Session to open on tap. Automation messages instead use `view: "automations"`. */
  sessionId?: string;
  view?: "automations";
  /** Coalescing key. Defaults to the session id for backward compatibility. */
  notificationKey?: string;
  urgency: "high" | "normal";
  /** Send-time stamp; the service worker keeps the NEWEST state when push services deliver
   * out of order (same tag = one card, but last-arrival would otherwise win). */
  ts?: number;
}

export interface DurableBackgroundPushDelivery {
  deliveryId: string;
  sessionId: string;
  continuationId: string;
  endpoint: string;
  message: PushMessage;
  ackToken: string;
  attemptCount: number;
}

export type PushServiceOutcome =
  | { kind: "service_accepted"; status: number }
  | { kind: "retry"; status?: number; error?: string }
  | { kind: "permanent_failure"; status?: number; error?: string };

interface SenderDb {
  listPushSubscriptions(audience?: PushAudience): StoredPushSubscription[];
  /** Liveness read right before a POST: returns the endpoint's CURRENT row (or null when
   * revoked/unsubscribed). Delivering to the current row — not the captured snapshot —
   * means a same-endpoint key refresh mid-drain still receives the message (encrypted to
   * its new keys) instead of silently losing it. */
  getPushSubscription(endpoint: string, audience?: PushAudience): StoredPushSubscription | null;
  /** Conditional prune: delete only if the row still holds the keys the send used — a
   * browser can refresh the SAME endpoint with new keys while an old request is in flight,
   * and a stale 404/410 must not take the fresh row with it. */
  deletePushSubscriptionMatching(sub: StoredPushSubscription): boolean;
  getVapidKeys(): VapidKeys | null;
  setVapidKeys(keys: VapidKeys, now: number): void;
  claimDueBackgroundPushDeliveries?(now: number, limit?: number): DurableBackgroundPushDelivery[];
  settleBackgroundPushDelivery?(deliveryId: string, outcome: PushServiceOutcome, now: number): boolean;
}

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
  signal?: AbortSignal;
}) => Promise<{ status: number; arrayBuffer?: () => Promise<ArrayBuffer> }>;

/** Push services accept 4 KB bodies; keep the plaintext comfortably inside after the
 * encryption overhead. pushDecision clamps its fields, so tripping this means a bug —
 * the send is SKIPPED (never a subscription prune: the payload is at fault, not the keys). */
export const MAX_PUSH_PAYLOAD_BYTES = 3000;
export const GENERIC_PUSH_NOTIFICATION_KEY = "wollipog";

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fans one message out to every stored subscription. Failures are per-endpoint and
 * best-effort: 404/410 means the subscription is gone (browser unsubscribed, PWA
 * uninstalled) and the row is dropped; anything else is logged and left for next time.
 *
 * Backpressure model (review-shaped):
 *  - Pending work is a per-notification-key LATEST-MESSAGE map, drained by a single loop — never
 *    more than one in-flight request or one encryption at a time, and a burst of
 *    transitions for one target COALESCES to its newest state instead of queueing
 *    closures. Memory is bounded by the number of notification targets with pending pushes.
 *  - Subscriptions are re-read from the database when a message is actually delivered
 *    (not when it was queued), and re-checked per row right before each POST — so a device
 *    revoked or unsubscribed while earlier work drained is never notified.
 *  - Each fetch carries a timeout; the drain loop's try/finally means nothing (a throwing
 *    logger included) can wedge the drainer permanently.
 */
export class WebPushSender {
  /** notification key → newest pending message+payload (coalesced; see class comment). */
  private readonly pending = new Map<string, { message: PushMessage; payload: Buffer; audience?: PushAudience }>();
  private draining = false;
  private durableBackgroundDraining = false;
  /** Strictly-increasing send stamp: same-millisecond transitions and (in-process) clock
   * steps still order correctly in the service worker's newest-wins check. */
  private lastTs = 0;

  constructor(
    private readonly db: SenderDb,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  /** Lazily create-and-persist the VAPID keypair; the public half feeds the subscribe route. */
  vapidPublicKey(): string {
    return this.keys().publicKey;
  }

  private cachedKeys: VapidKeys | null = null;
  private keys(): VapidKeys {
    if (this.cachedKeys) return this.cachedKeys;
    let keys = this.db.getVapidKeys();
    if (!keys) {
      // setVapidKeys is first-write-wins (ON CONFLICT DO NOTHING) — re-read instead of
      // trusting our candidate, so a keypair that lost the write is never signed with.
      this.db.setVapidKeys(generateVapidKeys(), Date.now());
      keys = this.db.getVapidKeys();
      if (!keys) throw new Error("VAPID keypair could not be persisted");
      this.log.info("web-push: generated a new VAPID keypair");
    }
    this.cachedKeys = keys;
    return keys;
  }

  /** Fire-and-forget fan-out (callers do not await notification delivery on the hot path). */
  send(message: PushMessage, audience?: PushAudience): void {
    if (this.db.listPushSubscriptions(audience).length === 0) return;
    this.lastTs = Math.max(Date.now(), this.lastTs + 1);
    const payload = Buffer.from(JSON.stringify({ ...message, ts: message.ts ?? this.lastTs }));
    // Size-guard ONCE, outside the per-subscription loop: an oversized payload is a message
    // bug and must never masquerade as a per-subscription key failure (which prunes rows).
    if (payload.length > MAX_PUSH_PAYLOAD_BYTES) {
      this.log.warn(`web-push: dropping oversized payload (${payload.length} bytes) for ${message.notificationKey ?? message.sessionId ?? "general"}`);
      return;
    }
    // Coalesce: only one target's NEWEST state matters on a lock screen. This fallback is an
    // in-memory queue key, not a payload field, so it has no old/new service-worker dependency.
    this.pending.set(message.notificationKey ?? message.sessionId ?? GENERIC_PUSH_NOTIFICATION_KEY,
      { message, payload, audience });
    void this.drain();
  }

  /** Drain the durable background-notification lane. Each endpoint has an independent lease and
   * receipt; retrying this encrypted notification never replays a provider prompt or side effect. */
  async retryDurableBackground(now = Date.now()): Promise<number> {
    if (this.durableBackgroundDraining) return 0;
    this.durableBackgroundDraining = true;
    try {
      const deliveries = this.db.claimDueBackgroundPushDeliveries?.(now, 16) ?? [];
      let settled = 0;
      for (const delivery of deliveries) {
        let outcome: PushServiceOutcome;
        try {
          const live = this.db.getPushSubscription(delivery.endpoint, {
            kind: "session",
            sessionId: delivery.sessionId,
          });
          if (!live) {
            outcome = { kind: "permanent_failure", error: "subscription_revoked" };
          } else {
            const payload = Buffer.from(JSON.stringify({
              ...delivery.message,
              receipt: { deliveryId: delivery.deliveryId, token: delivery.ackToken },
            }));
            outcome = payload.length > MAX_PUSH_PAYLOAD_BYTES
              ? { kind: "permanent_failure", error: "payload_too_large" }
              : await this.sendOne(live, delivery.message, payload);
          }
        } catch (error) {
          const code = (error as { code?: string; name?: string }).code ??
            (error as { name?: string }).name ?? "network_error";
          outcome = { kind: "retry", error: String(code).slice(0, 120) };
        }
        if (this.db.settleBackgroundPushDelivery?.(delivery.deliveryId, outcome, Date.now())) settled++;
      }
      return settled;
    } finally {
      this.durableBackgroundDraining = false;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const next = this.pending.entries().next();
        if (next.done) return;
        const [notificationKey, { message, payload, audience }] = next.value;
        this.pending.delete(notificationKey);
        // Subscriptions are read at DELIVERY time (queue-time snapshots would still notify
        // a device revoked while earlier work drained)...
        for (const sub of this.db.listPushSubscriptions(audience)) {
          try {
            // ...and re-read per row right before the POST: revoked → skip; keys refreshed
            // mid-drain → deliver to the CURRENT keys (the message must not be lost).
            const live = this.db.getPushSubscription(sub.endpoint, audience);
            if (!live) continue;
            await this.sendOne(live, message, payload);
          } catch (err) {
            try {
              // NEVER log err.message: fetch errors embed the full capability-bearing URL.
              const code = (err as { code?: string; name?: string }).code ?? (err as Error).name ?? "error";
              this.log.warn(`web-push: send failed for ${redactEndpoint(sub.endpoint)} (${code})`);
            } catch {
              /* even a throwing logger must not stop the drain */
            }
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async sendOne(
    sub: StoredPushSubscription,
    message: PushMessage,
    payload: Buffer,
  ): Promise<PushServiceOutcome> {
    let body: Buffer;
    try {
      body = encryptPushPayload(payload, { p256dh: sub.p256dh, auth: sub.auth });
    } catch {
      // The payload was pre-validated, so a throw here is key-shaped (stored garbage /
      // off-curve point) — drop THIS row (conditionally) rather than failing forever.
      this.db.deletePushSubscriptionMatching(sub);
      this.log.warn(`web-push: dropped subscription with malformed keys (${redactEndpoint(sub.endpoint)})`);
      return { kind: "permanent_failure", error: "malformed_subscription_keys" };
    }
    const res = await this.fetchImpl(sub.endpoint, {
      method: "POST",
      headers: {
        authorization: vapidAuthHeader(sub.endpoint, this.keys(), Date.now()),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: message.urgency === "high" ? "300" : "120",
        urgency: message.urgency,
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Drain the response so the socket returns to the pool (bodies are tiny/empty).
    await res.arrayBuffer?.().then(
      () => {},
      () => {},
    );
    if (res.status === 404 || res.status === 410) {
      // The push service says this subscription no longer exists — self-clean, but only if
      // the row still holds the keys THIS send used (see deletePushSubscriptionMatching).
      this.db.deletePushSubscriptionMatching(sub);
      this.log.info(`web-push: pruned expired subscription (${redactEndpoint(sub.endpoint)})`);
      return { kind: "permanent_failure", status: res.status, error: "subscription_expired" };
    } else if (res.status === 401 || res.status === 403) {
      // The push service rejected OUR credential: the subscription is bound to a different
      // applicationServerKey (e.g. the CP database — and with it the VAPID pair — was
      // reset). It can never succeed with the current key; prune so the device's next
      // reconcile re-subscribes against the new key instead of failing silently forever.
      this.db.deletePushSubscriptionMatching(sub);
      this.log.warn(
        `web-push: ${res.status} (VAPID rejected) for ${redactEndpoint(sub.endpoint)} — dropped; the device re-subscribes on its next reconcile`,
      );
      return { kind: "permanent_failure", status: res.status, error: "vapid_rejected" };
    } else if (res.status >= 400 || res.status < 200 || res.status >= 300) {
      this.log.warn(`web-push: ${res.status} from push service for ${redactEndpoint(sub.endpoint)}`);
      return { kind: "retry", status: res.status, error: "push_service_rejected" };
    }
    return { kind: "service_accepted", status: res.status };
  }
}

/** Endpoint URLs embed a per-subscription capability token in the path — log the origin only. */
export function redactEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).origin + "/…";
  } catch {
    return "(malformed endpoint)";
  }
}
