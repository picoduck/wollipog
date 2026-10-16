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
  await f.stop();
  await launch(true);
  assert.equal((await api("/api/remote-access", "POST", { provider: "https", origin }, { "x-forwarded-for": "192.0.2.10" })).status, 401);
  const configured = await api("/api/remote-access", "POST", { provider: "https", origin });
  const ready = await configured.json() as RemoteAccessView;
  assert.equal(ready.phase, "ready", JSON.stringify(ready));
  assert.equal(ready.origin, origin); assert.equal(f.forwarded, 1);
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
