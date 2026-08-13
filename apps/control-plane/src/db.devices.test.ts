import assert from "node:assert/strict";
import { test } from "node:test";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

test("device lifecycle: create → lookup by token hash → touch → revoke", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createDevice({ id: "dev_1", name: "Pixel 9", tokenHash: hashToken("tok-a"), now: 1000 });
  db.createDevice({ id: "dev_2", name: "iPad", tokenHash: hashToken("tok-b"), now: 2000 });

  // Auth lookup matches only the exact token hash.
  assert.equal(db.deviceByTokenHash(hashToken("tok-a"))?.id, "dev_1");
  assert.equal(db.deviceByTokenHash(hashToken("tok-b"))?.id, "dev_2");
  assert.equal(db.deviceByTokenHash(hashToken("tok-c")), null);

  // Fresh devices report never-seen; touch updates it.
  assert.equal(db.deviceByTokenHash(hashToken("tok-a"))?.lastSeenAt, null);
  db.touchDevice("dev_1", 5000);
  assert.equal(db.deviceByTokenHash(hashToken("tok-a"))?.lastSeenAt, 5000);

  // Listing is stable (creation order) and never exposes token hashes.
  const listed = db.listDevices();
  assert.deepEqual(
    listed.map((d) => [d.deviceId, d.name, d.lastSeenAt]),
    [
      ["dev_1", "Pixel 9", 5000],
      ["dev_2", "iPad", null],
    ],
  );
  assert.ok(!Object.keys(listed[0]!).some((k) => k.toLowerCase().includes("token")));

  // Revocation kills the token immediately; deleting again reports not-found.
  assert.equal(db.deleteDevice("dev_1"), true);
  assert.equal(db.deviceByTokenHash(hashToken("tok-a")), null);
  assert.equal(db.deleteDevice("dev_1"), false);
});

test("duplicate token hashes are rejected (UNIQUE)", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createDevice({ id: "dev_1", name: "a", tokenHash: hashToken("same"), now: 1 });
  assert.throws(() => db.createDevice({ id: "dev_2", name: "b", tokenHash: hashToken("same"), now: 2 }));
});

test("push subscriptions: upsert refreshes keys/owner; revoking a device silences its pushes", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createDevice({ id: "dev_1", name: "phone", tokenHash: hashToken("t1"), now: 1 });

  db.upsertPushSubscription({ endpoint: "https://p.example/a", p256dh: "P1", auth: "A1", deviceId: "dev_1", now: 10 });
  db.upsertPushSubscription({ endpoint: "https://p.example/b", p256dh: "P2", auth: "A2", deviceId: null, now: 20 });
  assert.equal(db.countPushSubscriptions(), 2);

  // Re-subscribing the same endpoint UPDATES in place (browsers refresh keys) — no dup row.
  db.upsertPushSubscription({ endpoint: "https://p.example/a", p256dh: "P1x", auth: "A1x", deviceId: "dev_1", now: 30 });
  assert.equal(db.countPushSubscriptions(), 2);
  const a = db.listPushSubscriptions().find((s) => s.endpoint === "https://p.example/a");
  assert.deepEqual([a?.p256dh, a?.auth], ["P1x", "A1x"]);

  // Revoking the device drops ITS subscription; the loopback (unowned) one survives.
  assert.equal(db.deleteDevice("dev_1"), true);
  assert.deepEqual(db.listPushSubscriptions().map((s) => s.endpoint), ["https://p.example/b"]);

  // Explicit unsubscribe; second delete reports not-found.
  assert.equal(db.deletePushSubscription("https://p.example/b"), true);
  assert.equal(db.deletePushSubscription("https://p.example/b"), false);
  assert.equal(db.countPushSubscriptions(), 0);
});

test("push subscriptions: matching checks/deletes are keyed by endpoint AND keys", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.upsertPushSubscription({ endpoint: "https://p.example/a", p256dh: "P1", auth: "A1", deviceId: null, now: 1 });
  const old = { endpoint: "https://p.example/a", p256dh: "P1", auth: "A1" };
  assert.equal(db.hasPushSubscription("https://p.example/a"), true);
  assert.equal(db.hasPushSubscriptionMatching(old), true);

  // The browser refreshes the endpoint with new keys → the OLD identity no longer matches,
  // so a stale in-flight send can neither see it as live nor delete it.
  db.upsertPushSubscription({ endpoint: "https://p.example/a", p256dh: "P2", auth: "A2", deviceId: null, now: 2 });
  assert.equal(db.hasPushSubscriptionMatching(old), false);
  assert.equal(db.deletePushSubscriptionMatching(old), false);
  assert.equal(db.countPushSubscriptions(), 1, "the refreshed row survives");
  assert.equal(db.deletePushSubscriptionMatching({ endpoint: "https://p.example/a", p256dh: "P2", auth: "A2" }), true);
});

test("push subscriptions: a scoped unsubscribe cannot delete another device's endpoint", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createDevice({ id: "dev_1", name: "one", tokenHash: hashToken("t1"), now: 1 });
  db.createDevice({ id: "dev_2", name: "two", tokenHash: hashToken("t2"), now: 2 });
  db.upsertPushSubscription({ endpoint: "https://p.example/one", p256dh: "P1", auth: "A1", deviceId: "dev_1", now: 3 });
  db.upsertPushSubscription({ endpoint: "https://p.example/two", p256dh: "P2", auth: "A2", deviceId: "dev_2", now: 4 });

  assert.equal(db.deletePushSubscriptionForDevice("https://p.example/two", "dev_1"), false);
  assert.equal(db.hasPushSubscription("https://p.example/two"), true);
  assert.equal(db.deletePushSubscriptionForDevice("https://p.example/one", "dev_1"), true);
  assert.equal(db.hasPushSubscription("https://p.example/one"), false);
  db.close();
});

test("VAPID keypair persistence is first-write-wins", () => {
  const db = ControlPlaneDb.open(":memory:");
  assert.equal(db.getVapidKeys(), null);
  db.setVapidKeys({ publicKey: "PUB1", privateJwk: "{JWK1}" }, 1);
  // A losing concurrent generation must not replace the persisted pair (subscriptions are
  // bound to the applicationServerKey — replacing it would orphan all of them).
  db.setVapidKeys({ publicKey: "PUB2", privateJwk: "{JWK2}" }, 2);
  assert.deepEqual(db.getVapidKeys(), { publicKey: "PUB1", privateJwk: "{JWK1}" });
});
