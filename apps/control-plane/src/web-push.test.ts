import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerify, createPublicKey, createECDH, createDecipheriv, hkdfSync } from "node:crypto";
import {
  b64url,
  b64urlDecode,
  decodeSubscriptionKeys,
  encryptPushPayload,
  generateVapidKeys,
  GENERIC_PUSH_NOTIFICATION_KEY,
  isValidP256Point,
  redactEndpoint,
  validateSubscription,
  vapidAuthHeader,
  WebPushSender,
  type StoredPushSubscription,
  type VapidKeys,
} from "./web-push.js";
import { pushDecision } from "./push-decision.js";
import type { SessionView } from "@wollipog/protocol";

/* ----------------------- RFC 8291 Appendix A test vector ---------------------- */
// Every value below is verbatim from the RFC. The vector pins the whole pipeline: ECDH
// direction, both HKDF info strings, the aes128gcm header layout, and the record delimiter.

const V = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  authSecret: ["BTBZMqHH6r4", "Tts7J_aSIgg"].join(""),
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("generic push coalescing uses the Wollipog fallback identity", () => {
  assert.equal(GENERIC_PUSH_NOTIFICATION_KEY, "wollipog");
});

test("encryptPushPayload reproduces the RFC 8291 Appendix A message byte-for-byte", () => {
  const out = encryptPushPayload(
    Buffer.from(V.plaintext, "utf8"),
    { p256dh: V.uaPublic, auth: V.authSecret },
    { ephemeralPrivate: b64urlDecode(V.asPrivate), salt: b64urlDecode(V.salt) },
  );
  assert.equal(b64url(out), V.body);
});

test("RFC 8291 intermediates: IKM / CEK / nonce derive exactly as specified", () => {
  // Recompute the intermediates the same way the implementation must, and pin them to the
  // RFC's published values — if a refactor changes an info string, this names the stage.
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(b64urlDecode(V.asPrivate));
  const ecdhSecret = ecdh.computeSecret(b64urlDecode(V.uaPublic));
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    b64urlDecode(V.uaPublic),
    b64urlDecode(V.asPublic),
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, b64urlDecode(V.authSecret), keyInfo, 32));
  assert.equal(b64url(ikm), V.ikm);
  const salt = b64urlDecode(V.salt);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  assert.equal(b64url(cek), V.cek);
  assert.equal(b64url(nonce), V.nonce);
});

test("a freshly-encrypted payload decrypts with the subscriber's private key (random path)", () => {
  // No overrides: exercises the production randomness path end-to-end by playing the browser.
  const payload = Buffer.from(JSON.stringify({ title: "t", body: "b" }));
  const out = encryptPushPayload(payload, { p256dh: V.uaPublic, auth: V.authSecret });
  const salt = out.subarray(0, 16);
  const rs = out.readUInt32BE(16);
  assert.equal(rs, 4096);
  const idlen = out[20]!;
  assert.equal(idlen, 65);
  const asPublic = out.subarray(21, 21 + 65);
  const sealed = out.subarray(21 + 65);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(b64urlDecode(V.uaPrivate));
  const ecdhSecret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), b64urlDecode(V.uaPublic), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, b64urlDecode(V.authSecret), keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const record = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  assert.equal(record[record.length - 1], 0x02); // last-record delimiter
  assert.deepEqual(record.subarray(0, record.length - 1), payload);
});

test("encryptPushPayload rejects malformed keys and oversized payloads", () => {
  assert.throws(() => encryptPushPayload(Buffer.from("x"), { p256dh: "AAAA", auth: V.authSecret }));
  assert.throws(() =>
    encryptPushPayload(Buffer.alloc(5000), { p256dh: V.uaPublic, auth: V.authSecret }),
    /too large/,
  );
});

/* --------------------------------- VAPID ---------------------------------- */

test("vapidAuthHeader emits a verifiable ES256 JWT with endpoint-origin aud", () => {
  const keys = generateVapidKeys();
  const header = vapidAuthHeader("https://fcm.googleapis.com/fcm/send/abc123", keys, 1_700_000_000_000);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, "header shape");
  const [, jwt, k] = m!;
  assert.equal(k, keys.publicKey);
  const [h, c, sig] = jwt!.split(".");
  assert.deepEqual(JSON.parse(b64urlDecode(h!).toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(b64urlDecode(c!).toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com"); // origin, not the full endpoint
  assert.equal(claims.exp, 1_700_000_000 + 12 * 3600);
  assert.ok(typeof claims.sub === "string" && claims.sub.length > 0);
  // Verify the signature against the public JWK half.
  const jwk = JSON.parse(keys.privateJwk) as { x: string; y: string };
  const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
  const ok = createVerify("SHA256")
    .update(`${h}.${c}`)
    .verify({ key: pub, dsaEncoding: "ieee-p1363" }, b64urlDecode(sig!));
  assert.equal(ok, true);
});

test("generateVapidKeys: public key is a 65-byte uncompressed point; private stays in the JWK", () => {
  const keys = generateVapidKeys();
  const pub = b64urlDecode(keys.publicKey);
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 0x04);
  const jwk = JSON.parse(keys.privateJwk);
  assert.ok(jwk.d, "private scalar present server-side");
  assert.ok(!keys.publicKey.includes(jwk.d), "public half never embeds the private scalar");
});

/* ---------------------------- subscription intake --------------------------- */

test("validateSubscription accepts a real-shaped subscription and rejects junk", () => {
  const good = validateSubscription({
    endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x",
    keys: { p256dh: V.uaPublic, auth: V.authSecret },
  });
  assert.ok(!("error" in good));
  // A 65-byte blob that is NOT on the P-256 curve (0x04 || 64 zero bytes) — right shape,
  // wrong math; storing it would make every send throw and prune.
  const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)]).toString("base64url");
  for (const bad of [
    null,
    {},
    { endpoint: "http://updates.push.example/x", keys: { p256dh: V.uaPublic, auth: V.authSecret } }, // not https
    { endpoint: "not a url", keys: { p256dh: V.uaPublic, auth: V.authSecret } },
    { endpoint: "https://x.example/" + "a".repeat(1100), keys: { p256dh: V.uaPublic, auth: V.authSecret } },
    { endpoint: ["https://user:", "pass@x.example/y"].join(""), keys: { p256dh: V.uaPublic, auth: V.authSecret } }, // credentials
    { endpoint: "https://x.example/y", keys: { p256dh: "AAAA", auth: V.authSecret } }, // not a point
    { endpoint: "https://x.example/y", keys: { p256dh: offCurve, auth: V.authSecret } }, // off-curve
    { endpoint: "https://x.example/y", keys: { p256dh: V.uaPublic, auth: "AAAA" } }, // wrong auth len
    // Node's decoder would accept whitespace-padded base64url — canonical round-trip must not.
    { endpoint: "https://x.example/y", keys: { p256dh: V.uaPublic + " ".repeat(200), auth: V.authSecret } },
    { endpoint: "https://x.example/y", keys: { p256dh: " " + V.uaPublic.slice(1), auth: V.authSecret } },
    { endpoint: "https://x.example/y" }, // no keys
  ]) {
    assert.ok("error" in (validateSubscription(bad) as object), JSON.stringify(bad)?.slice(0, 60));
  }
});

test("isValidP256Point: real points pass, off-curve and truncated blobs fail", () => {
  assert.equal(isValidP256Point(b64urlDecode(V.uaPublic)), true);
  assert.equal(isValidP256Point(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)])), false);
  assert.equal(isValidP256Point(Buffer.alloc(10)), false);
});

test("decodeSubscriptionKeys never throws on garbage", () => {
  assert.equal(decodeSubscriptionKeys({ p256dh: "!!!", auth: "%%%" })?.constructor, undefined);
});

test("redactEndpoint keeps the origin, drops the capability path", () => {
  assert.equal(redactEndpoint("https://fcm.googleapis.com/fcm/send/SECRET"), "https://fcm.googleapis.com/…");
  assert.equal(redactEndpoint(":::"), "(malformed endpoint)");
});

/* --------------------------------- sender ---------------------------------- */

function senderHarness(
  subs: StoredPushSubscription[],
  statuses: Record<string, number>,
  opts: { delayMs?: number; throwFor?: Record<string, Error>; throwingLog?: boolean } = {},
) {
  const state = {
    subs: [...subs],
    deleted: [] as string[],
    requests: [] as { url: string; headers: Record<string, string>; body: Uint8Array }[],
    logs: [] as string[],
    vapid: null as VapidKeys | null,
    vapidWrites: 0,
    inFlight: 0,
    maxInFlight: 0,
  };
  const matches = (s: StoredPushSubscription, sub: StoredPushSubscription) =>
    s.endpoint === sub.endpoint && s.p256dh === sub.p256dh && s.auth === sub.auth;
  const db = {
    listPushSubscriptions: () => state.subs,
    getPushSubscription: (endpoint: string) => state.subs.find((s) => s.endpoint === endpoint) ?? null,
    // Keys-conditional delete, mirroring the real sqlite semantics.
    deletePushSubscriptionMatching: (sub: StoredPushSubscription) => {
      const before = state.subs.length;
      state.subs = state.subs.filter((s) => !matches(s, sub));
      if (state.subs.length < before) state.deleted.push(sub.endpoint);
      return state.subs.length < before;
    },
    getVapidKeys: () => state.vapid,
    setVapidKeys: (k: VapidKeys) => {
      state.vapid = k;
      state.vapidWrites++;
    },
  };
  const record = (m: string) => {
    state.logs.push(m);
    if (opts.throwingLog) throw new Error("logger exploded");
  };
  const log = { info: record, warn: record };
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const err = opts.throwFor?.[url];
      if (err) throw err;
      state.requests.push({ url, headers: init.headers, body: init.body });
      return { status: statuses[url] ?? 201, arrayBuffer: async () => new ArrayBuffer(0) };
    } finally {
      state.inFlight--;
    }
  };
  return { state, db, sender: new WebPushSender(db, log, fetchImpl) };
}

const SUB = (n: number): StoredPushSubscription => ({
  endpoint: `https://push.example/ep${n}`,
  p256dh: V.uaPublic,
  auth: V.authSecret,
});

async function settle(ms = 20) {
  // send() fans out fire-and-forget promises; let the queue drain.
  await new Promise((r) => setTimeout(r, ms));
}

test("send: encrypts per subscription, sets vapid/urgency headers, persists one VAPID keypair", async () => {
  const { state, sender } = senderHarness([SUB(1), SUB(2)], {});
  sender.send({ title: "t", body: "b", sessionId: "s_1", urgency: "high" });
  await settle();
  assert.equal(state.requests.length, 2);
  assert.equal(state.vapidWrites, 1); // lazily generated once, then cached
  for (const r of state.requests) {
    assert.match(r.headers.authorization!, /^vapid t=.+, k=.+$/);
    assert.equal(r.headers["content-encoding"], "aes128gcm");
    assert.equal(r.headers.urgency, "high");
    assert.ok(r.body.length > 100); // header(21) + key(65) + ciphertext+tag
  }
});

test("send: 404/410 prunes that subscription; other statuses keep it", async () => {
  const { state, sender } = senderHarness([SUB(1), SUB(2), SUB(3)], {
    "https://push.example/ep1": 410,
    "https://push.example/ep2": 429,
  });
  sender.send({ title: "t", body: "b", sessionId: "s_1", urgency: "normal" });
  await settle();
  assert.deepEqual(state.deleted, ["https://push.example/ep1"]);
  assert.equal(state.subs.length, 2);
});

test("send: a subscription with malformed stored keys is dropped, others still deliver", async () => {
  const bad: StoredPushSubscription = { endpoint: "https://push.example/bad", p256dh: "AAAA", auth: "BBBB" };
  const { state, sender } = senderHarness([bad, SUB(1)], {});
  sender.send({ title: "t", body: "b", sessionId: "s_1", urgency: "normal" });
  await settle();
  assert.deepEqual(state.deleted, ["https://push.example/bad"]);
  assert.equal(state.requests.length, 1);
});

test("send: no subscriptions → no fetches and no key generation", async () => {
  const { state, sender } = senderHarness([], {});
  sender.send({ title: "t", body: "b", sessionId: "s_1", urgency: "normal" });
  await settle();
  assert.equal(state.requests.length, 0);
  assert.equal(state.vapidWrites, 0);
});

// REGRESSION (review): an oversized payload used to throw inside the per-subscription loop
// and be misread as bad keys — deleting EVERY valid subscription in one send.
test("send: an oversized payload is skipped and logged, never pruning subscriptions", async () => {
  const { state, sender } = senderHarness([SUB(1), SUB(2)], {});
  sender.send({ title: "t", body: "x".repeat(5000), sessionId: "s_1", urgency: "high" });
  await settle();
  assert.equal(state.requests.length, 0, "no delivery attempted");
  assert.deepEqual(state.deleted, [], "no subscription pruned");
  assert.equal(state.subs.length, 2);
  assert.ok(state.logs.some((l) => l.includes("oversized")));
});

/** Poll until a condition holds — timing-margin waits flake on loaded machines. */
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
}

// REGRESSION (review): deliveries are serialized — a slow push service must not let a big
// subscription table pile up concurrent sockets/encryptions.
test("send: deliveries are strictly sequential across subscriptions AND across send() calls", async () => {
  const { state, sender } = senderHarness([SUB(1), SUB(2), SUB(3)], {}, { delayMs: 10 });
  sender.send({ title: "a", body: "b", sessionId: "s_1", urgency: "normal" });
  sender.send({ title: "c", body: "d", sessionId: "s_2", urgency: "normal" });
  await waitFor(() => state.requests.length >= 6);
  await settle(30); // catch any overshoot beyond the expected six
  assert.equal(state.requests.length, 6);
  assert.equal(state.maxInFlight, 1, "never more than one in-flight push request");
});

// REGRESSION (review): a browser can refresh the SAME endpoint with new keys while an old
// send is in flight; the old request's 410 must not delete the refreshed row.
test("send: a stale 410 does not delete a subscription whose keys were refreshed mid-flight", async () => {
  const { state, sender } = senderHarness([SUB(1)], { "https://push.example/ep1": 410 }, { delayMs: 15 });
  sender.send({ title: "t", body: "b", sessionId: "s_1", urgency: "normal" });
  // While the request is in flight, the browser re-subscribes the endpoint with NEW keys.
  state.subs = [{ endpoint: "https://push.example/ep1", p256dh: SUB(1).p256dh, auth: "REFRESHED_AUTH" }];
  await settle(80);
  assert.deepEqual(state.deleted, [], "the refreshed row must survive the stale 410");
  assert.equal(state.subs.length, 1);
  assert.equal(state.subs[0]!.auth, "REFRESHED_AUTH");
});

// REGRESSION (review): fetch errors embed the full capability-bearing URL in their message —
// the sender must log only the origin plus an error code, never the path or credentials.
test("send: a throwing fetch never leaks the endpoint path into logs", async () => {
  const secretUrl = "https://push.example/capability/SECRET-PATH";
  const err = Object.assign(new Error(`request to ${secretUrl} failed`), { code: "ECONNRESET" });
  const sub: StoredPushSubscription = { endpoint: secretUrl, p256dh: V.uaPublic, auth: V.authSecret };
  const { state, sender } = senderHarness([sub], {}, { throwFor: { [secretUrl]: err } });
  sender.send({ title: "t", body: "b", sessionId: "s_1", urgency: "normal" });
  await settle(50);
  assert.ok(state.logs.length > 0, "the failure is logged");
  for (const line of state.logs) {
    assert.ok(!line.includes("SECRET-PATH"), `log line leaks the capability path: ${line}`);
    assert.ok(line.includes("ECONNRESET") || !line.includes("failed") || line.includes("push.example"), "origin+code only");
  }
  assert.deepEqual(state.deleted, [], "a transport error is not a prune signal");
});

/** Decrypt a captured request body as the browser would (test-side twin of sw delivery). */
function decryptBody(
  body: Uint8Array,
  authSecret: string = V.authSecret,
): { title: string; body: string; sessionId?: string; view?: "automations"; notificationKey?: string; ts: number } {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const asPublic = buf.subarray(21, 86);
  const sealed = buf.subarray(86);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(b64urlDecode(V.uaPrivate));
  const ecdhSecret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), b64urlDecode(V.uaPublic), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, b64urlDecode(authSecret), keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const record = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  return JSON.parse(record.subarray(0, record.length - 1).toString("utf8"));
}

// REGRESSION (round 2): a burst of transitions for one session coalesces to its NEWEST
// state instead of queueing unbounded closures.
test("send: rapid same-session messages coalesce — only the in-flight and the newest deliver", async () => {
  const { state, sender } = senderHarness([SUB(1)], {}, { delayMs: 15 });
  sender.send({ title: "state1", body: "b", sessionId: "s_1", urgency: "normal" });
  sender.send({ title: "state2", body: "b", sessionId: "s_1", urgency: "normal" });
  sender.send({ title: "state3", body: "b", sessionId: "s_1", urgency: "normal" });
  await settle(120);
  assert.equal(state.requests.length, 2, "intermediate state2 coalesced away");
  assert.equal(decryptBody(state.requests[0]!.body).title, "state1");
  assert.equal(decryptBody(state.requests[1]!.body).title, "state3");
});

test("send: generic sessionless messages coalesce under the Wollipog fallback key", async () => {
  const { state, sender } = senderHarness([SUB(1)], {}, { delayMs: 15 });
  sender.send({ title: "state1", body: "b", urgency: "normal" });
  sender.send({ title: "state2", body: "b", urgency: "normal" });
  sender.send({ title: "state3", body: "b", urgency: "normal" });
  await settle(120);
  assert.equal(state.requests.length, 2, "the intermediate generic state coalesced away");
  assert.equal(decryptBody(state.requests[0]!.body).title, "state1");
  assert.equal(decryptBody(state.requests[1]!.body).title, "state3");
});

test("send: sessionless automation messages coalesce by their explicit notification key", async () => {
  const { state, sender } = senderHarness([SUB(1)], {}, { delayMs: 15 });
  sender.send({ title: "started", body: "b", view: "automations", notificationKey: "automation:a1", urgency: "normal" });
  sender.send({ title: "running", body: "b", view: "automations", notificationKey: "automation:a1", urgency: "normal" });
  sender.send({ title: "failed", body: "b", view: "automations", notificationKey: "automation:a1", urgency: "high" });
  await settle(120);
  assert.equal(state.requests.length, 2);
  const newest = decryptBody(state.requests[1]!.body);
  assert.equal(newest.title, "failed");
  assert.equal(newest.view, "automations");
  assert.equal(newest.sessionId, undefined);
});

// REGRESSION (round 2): a device revoked while earlier deliveries drained must not be
// notified — subscriptions are re-listed per message and re-checked per row.
test("send: a subscription removed while the queue drains is never POSTed", async () => {
  const { state, sender } = senderHarness([SUB(1), SUB(2)], {}, { delayMs: 15 });
  sender.send({ title: "t", body: "b", sessionId: "s_1", urgency: "normal" });
  await settle(5); // ep1's request is in flight; ep2 hasn't started
  state.subs = state.subs.filter((s) => s.endpoint !== "https://push.example/ep2"); // revoke
  await settle(100);
  assert.deepEqual(
    state.requests.map((r) => r.url),
    ["https://push.example/ep1"],
    "the revoked ep2 must be skipped",
  );
});

// REGRESSION (round 3): a subscription whose keys were refreshed while earlier deliveries
// drained must still receive the message — encrypted to its NEW keys — not lose it.
test("send: a mid-drain key refresh delivers to the refreshed keys instead of dropping the message", async () => {
  const newAuth = Buffer.from("sixteen-bytes-ok").toString("base64url");
  const { state, sender } = senderHarness([SUB(1), SUB(2)], {}, { delayMs: 15 });
  sender.send({ title: "the-ask", body: "b", sessionId: "s_1", urgency: "high" });
  await settle(5); // ep1 in flight; ep2 not started
  state.subs = state.subs.map((s) =>
    s.endpoint === "https://push.example/ep2" ? { ...s, auth: newAuth } : s,
  );
  await settle(100);
  const ep2 = state.requests.find((r) => r.url === "https://push.example/ep2");
  assert.ok(ep2, "the refreshed subscription still receives the message");
  // Decryptable with the NEW auth secret → it was encrypted to the refreshed keys.
  assert.equal(decryptBody(ep2!.body, newAuth).title, "the-ask");
});

// REGRESSION (round 3): 401/403 means the push service rejected OUR VAPID credential — the
// subscription is bound to a different applicationServerKey (e.g. after a DB reset) and can
// never succeed; prune it so the device's next reconcile re-subscribes on the new key.
test("send: 401/403 prunes the VAPID-orphaned subscription", async () => {
  const { state, sender } = senderHarness([SUB(1), SUB(2)], {
    "https://push.example/ep1": 403,
    "https://push.example/ep2": 401,
  });
  sender.send({ title: "t", body: "b", sessionId: "s_1", urgency: "normal" });
  await settle(50);
  assert.deepEqual(state.deleted.sort(), ["https://push.example/ep1", "https://push.example/ep2"]);
  assert.ok(state.logs.some((l) => l.includes("VAPID rejected")));
});

// REGRESSION (round 2): nothing — a throwing logger included — may wedge the drainer.
test("send: a throwing logger cannot stop later deliveries", async () => {
  const err = Object.assign(new Error("boom"), { code: "ECONNRESET" });
  const { state, sender } = senderHarness(
    [SUB(1)],
    {},
    { throwFor: { "https://push.example/ep1": err }, throwingLog: true },
  );
  sender.send({ title: "a", body: "b", sessionId: "s_1", urgency: "normal" });
  await settle(50);
  // The failure was logged (and the logger threw); a later send must still deliver.
  state.subs = [SUB(3)];
  sender.send({ title: "c", body: "d", sessionId: "s_2", urgency: "normal" });
  await settle(50);
  assert.deepEqual(state.requests.map((r) => r.url), ["https://push.example/ep3"]);
});

// REGRESSION (round 2): send stamps must be STRICTLY increasing — two transitions in the
// same millisecond must still order correctly in the service worker's newest-wins check.
test("send: payload timestamps are strictly increasing across same-millisecond sends", async () => {
  const { state, sender } = senderHarness([SUB(1)], {});
  sender.send({ title: "a", body: "b", sessionId: "s_1", urgency: "normal" });
  sender.send({ title: "c", body: "d", sessionId: "s_2", urgency: "normal" });
  sender.send({ title: "e", body: "f", sessionId: "s_3", urgency: "normal" });
  await settle(50);
  const ts = state.requests.map((r) => decryptBody(r.body).ts);
  assert.equal(ts.length, 3);
  assert.ok(ts[0]! < ts[1]! && ts[1]! < ts[2]!, `not strictly increasing: ${ts.join(", ")}`);
});

test("encryptPushPayload: two production-path encryptions use fresh salt and ephemeral key", () => {
  const keys = { p256dh: V.uaPublic, auth: V.authSecret };
  const a = encryptPushPayload(Buffer.from("x"), keys);
  const b = encryptPushPayload(Buffer.from("x"), keys);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), "salts must differ");
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), "ephemeral keys must differ");
});

/* ------------------------------ push decision ------------------------------- */

function view(status: SessionView["status"], extra: Partial<SessionView> = {}): SessionView {
  return { id: "s_1", title: "Fix the bug", status, ...extra } as SessionView;
}
/** prev shorthand: a view carrying just what the decision reads. */
const prev = (status: SessionView["status"], requestId?: string) =>
  view(status, requestId ? ({ pendingApproval: { requestId, title: "t", options: [] } } as Partial<SessionView>) : {});

test("pushDecision fires on the attention transitions and stays quiet otherwise", () => {
  // Needs input (approval): high urgency, carries the ask.
  const ask = pushDecision(prev("running"), view("input_required", {
    pendingApproval: { requestId: "r", title: "Run npm install?", options: [] },
  } as Partial<SessionView>));
  assert.equal(ask?.urgency, "high");
  assert.match(ask!.body, /Run npm install\?/);
  // Question kind is labeled as a question.
  const q = pushDecision(prev("running"), view("input_required", {
    pendingApproval: { requestId: "r", title: "Which DB?", options: [], kind: "question" },
  } as Partial<SessionView>));
  assert.match(q!.body, /^Question/);
  const auth = pushDecision(prev("running"), view("input_required", {
    pendingApproval: { requestId: "auth", title: "Sign in to Gemini CLI", options: [], kind: "authentication" },
  } as Partial<SessionView>));
  assert.match(auth!.body, /^Sign-in required/);
  // Turn settle + completion + failure.
  assert.match(pushDecision(prev("running"), view("idle"))!.title, /ready/);
  assert.match(pushDecision(prev("running"), view("completed"))!.title, /completed/);
  assert.match(pushDecision(prev("idle"), view("failed"))!.title, /failed/);
  // Quiet: no transition, non-busy→idle, non-busy→completed, busy→busy, →stopped.
  assert.equal(pushDecision(prev("idle"), view("idle")), null);
  assert.equal(pushDecision(prev("input_required"), view("idle")), null);
  assert.equal(pushDecision(prev("stopped"), view("completed")), null);
  assert.equal(pushDecision(prev("queued"), view("running")), null);
  assert.equal(pushDecision(prev("running"), view("stopped")), null);
});

// REGRESSION (review): input_required→input_required with a DIFFERENT ask is a new attention
// moment (a permission/question displacing a guardrail card, or vice versa) — only the exact
// same requestId (the runner's trailing status frame) stays silent.
test("pushDecision: a displaced ask re-notifies; the same ask's trailing frame does not", () => {
  const guardrail = view("input_required", {
    pendingApproval: { requestId: "pol_1", title: "Cost budget reached", options: [], kind: "cost_budget" },
  } as Partial<SessionView>);
  const permission = view("input_required", {
    pendingApproval: { requestId: "perm_1", title: "Run rm -rf?", options: [] },
  } as Partial<SessionView>);
  // Guardrail parked, then a permission displaces it → new push carrying the NEW ask.
  const displaced = pushDecision(guardrail, permission);
  assert.ok(displaced, "a different ask must re-notify");
  assert.match(displaced!.body, /Run rm -rf\?/);
  // Same requestId (trailing status frame) → silent.
  assert.equal(pushDecision(permission, permission), null);
});

test("pushDecision clamps runaway titles and ask bodies inside the payload budget", () => {
  const huge = view("input_required", {
    title: "T".repeat(500),
    pendingApproval: { requestId: "r", title: "Q".repeat(5000), options: [] },
  } as Partial<SessionView>);
  const msg = pushDecision(prev("running"), huge)!;
  assert.ok(msg.title.length <= 130, `title clamped (got ${msg.title.length})`);
  assert.ok(msg.body.length <= 401, `body clamped (got ${msg.body.length})`);
});
