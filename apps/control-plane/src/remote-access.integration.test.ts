import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteAccessView } from "@wollipog/protocol";
import { remoteAccessFixture } from "./remote-access-test-fixture.js";

test("real TLS proxy proves identity, serves the dashboard, authenticates API and /ui, and supplies HTTPS pairing", { timeout: 60_000 }, async (t) => {
  const f = await remoteAccessFixture();
  t.after(() => f.close());
  const { api, launch, origin, probeTokens } = f;
  await launch(false);
  const invalid = await api("/api/remote-access", "POST", { provider: "https", origin });
  assert.equal((await invalid.json() as RemoteAccessView).phase, "needs_repair", "untrusted certificates never become ready");
  assert.equal(probeTokens.length, 0, "no capability is sent before TLS and identity verification");
  const before = await (await api("/api/devices")).json();
  assert.equal((await api("/api/devices", "POST", { name: "Undeliverable" })).status, 503);
  assert.deepEqual(await (await api("/api/devices")).json(), before, "broken guided setup never mints a device for legacy clients");
  await f.stop();
  await launch(true);
  assert.equal((await api("/api/remote-access", "POST", { provider: "https", origin }, { "x-forwarded-for": "192.0.2.10" })).status, 401);
  const duplicateFrames: string[] = [];
  let duplicate: WebSocket | undefined;
  let closed!: () => void;
  const duplicateClosed = new Promise<void>((resolve) => { closed = resolve; });
  const push = probeTokens.push;
  probeTokens.push = function (...tokens: string[]) {
    // Exercise a second socket admitted while the verification capability is valid.
    duplicate = new WebSocket(`${f.base.replace("http:", "ws:")}/ui?token=${tokens[0]!.slice(7)}`);
    duplicate.addEventListener("message", (event) => duplicateFrames.push(JSON.parse(String(event.data)).type));
    duplicate.addEventListener("close", closed, { once: true });
    duplicate.addEventListener("error", () => {}, { once: true });
    return push.apply(this, tokens);
  };
  t.after(() => duplicate?.close());
  const configured = await api("/api/remote-access", "POST", { provider: "https", origin });
  const ready = await configured.json() as RemoteAccessView;
  assert.equal(ready.phase, "ready", JSON.stringify(ready));
  assert.equal(ready.origin, origin); assert.equal(f.forwarded, 1);
  const timeout = setTimeout(() => { duplicate?.close(); closed(); }, 2_000);
  await duplicateClosed;
  clearTimeout(timeout);
  assert.deepEqual(duplicateFrames, ["remote_access_verified"], "probe capabilities receive no session snapshot");
  assert.equal(duplicate?.readyState, WebSocket.CLOSED, "probe sockets close immediately after acknowledgement");
  assert.equal(probeTokens.length, 1);
  assert.equal(f.log().includes(probeTokens[0]!.slice(7)), false, "verification credentials are redacted from logs");
  const dead = await fetch(`${f.base}/api/instance`, { headers: { authorization: probeTokens[0]! } });
  assert.equal(dead.status, 401, "verification capabilities expire immediately");
  const pairing = await api("/api/devices", "POST", { name: "Phone" });
  assert.equal(pairing.status, 201);
  const paired = await pairing.json() as { token: string; pairing: { publicOrigin: string; boundBeyondLoopback: boolean } };
  assert.equal(paired.pairing.publicOrigin, origin);
  assert.equal(paired.pairing.boundBeyondLoopback, false, "the backend stays on loopback");
  const remoteSetup = await fetch(`${f.base}/api/remote-access`, { method: "POST",
    headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json", "x-forwarded-for": "192.0.2.10" }, body: JSON.stringify({ provider: "tailscale" }) });
  assert.equal(remoteSetup.status, 403, "a paired remote administrator cannot configure the host");
});
