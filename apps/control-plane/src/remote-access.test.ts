import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteAccess, remoteHttpsOrigin, tailscaleAuthorizationUrl, type RemoteAccessDeps } from "./remote-access.js";

type Serve = { TCP: Record<string, { HTTPS: boolean }>; Web: Record<string, { Handlers: Record<string, { Proxy: string }> }>; AllowFunnel: Record<string, boolean> };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "remote-access-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "remote.json");
  const calls: string[][] = [];
  const events: unknown[] = [];
  const requests: Array<{ url: string; token?: string }> = [];
  const config: Serve = { TCP: {}, Web: {}, AllowFunnel: {} };
  let authorize = false;
  let unavailable = false;
  let wrongProof = false;
  let wrongApi = false;
  let failLive = false;
  let stamp = 1_000;
  let service!: RemoteAccess;
  const deps: RemoteAccessDeps = {
    statePath, port: 4317, instanceId: "instance-fixture", configuredOrigin: null,
    now: () => stamp,
    log: (event) => events.push(event),
    exec: async (args) => {
      calls.push(args);
      if (unavailable) return { ok: false, stdout: "", stderr: "secret external diagnostic" };
      if (args[0] === "status") return { ok: true, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "fixture.example.ts.net." } }), stderr: "" };
      if (args[1] === "status") return { ok: true, stdout: JSON.stringify(config), stderr: "" };
      const port = args.find((arg) => arg.startsWith("--https="))!.split("=")[1]!;
      const key = `fixture.example.ts.net:${port}`;
      if (args.includes("off")) { delete config.TCP[port]; delete config.Web[key]; }
      else {
        if (authorize) return { ok: false, stdout: "Enable HTTPS at https://login.tailscale.com/f/fixture", stderr: "" };
        config.TCP[port] = { HTTPS: true };
        config.Web[key] = { Handlers: { "/": { Proxy: args.at(-1)! } } };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    fetch: (async (raw, options) => {
      const url = new URL(String(raw));
      const token = (options?.headers as Record<string, string> | undefined)?.authorization;
      requests.push({ url: url.href, ...(token ? { token } : {}) });
      assert.equal(options?.redirect, "error");
      if (url.pathname.startsWith("/remote-access-proof/")) {
        return Response.json(wrongProof ? { instanceId: "other", response: "unrelated" } : service.proof(url.pathname.split("/").at(-1)!)!);
      }
      if (url.pathname === "/") return new Response('<html><script>window.__WOLLIPOG_SAME_ORIGIN__=1</script></html>');
      assert.ok(service.isProbeRequest({ method: "GET", url: "/api/instance", headers: { authorization: token! } }));
      assert.equal(service.isProbeRequest({ method: "GET", url: "/api/devices", headers: { authorization: token! } }), false);
      assert.equal(service.isProbeRequest({ method: "POST", url: "/api/instance", headers: { authorization: token! } }), false);
      return Response.json({ instanceId: wrongApi ? "different" : "instance-fixture" });
    }) as typeof fetch,
    live: async (origin, token) => {
      assert.ok(service.isProbeRequest({ method: "GET", url: `/ui?token=${token}`, headers: {} }));
      assert.match(origin, /^https:\/\//u);
      if (failLive) throw Error("secret network error");
    },
  };
  service = new RemoteAccess(deps);
  return {
    get service() { return service; }, deps, config, calls, requests, events, statePath,
    authorize: (value: boolean) => { authorize = value; },
    wrongProof: () => { wrongProof = true; }, wrongApi: () => { wrongApi = true; },
    failLive: (value: boolean) => { failLive = value; }, unavailable: () => { unavailable = true; },
    tick: () => { stamp += 31_000; },
    reload: () => { service = new RemoteAccess(deps); return service; },
  };
}

test("setup discovers HTTPS, verifies this instance before using a scoped capability, and persists without secrets", async (t) => {
  const f = fixture(t);
  const result = await f.service.setup({ provider: "tailscale" });
  assert.equal(result.phase, "ready");
  assert.equal(result.origin, "https://fixture.example.ts.net");
  assert.equal(f.service.publicOrigin(), result.origin);
  assert.deepEqual(f.calls.find((args) => args.includes("--bg")), ["serve", "--bg", "--https=443", "--yes", "http://127.0.0.1:4317"]);
  assert.equal(f.requests.filter((req) => req.token).length, 1);
  const temporary = f.requests.find((req) => req.token)!.token!;
  assert.equal(f.service.isProbeRequest({ method: "GET", url: "/api/instance", headers: { authorization: temporary } }), false, "capability is revoked when verification finishes");
  assert.ok(!readFileSync(f.statePath, "utf8").includes(temporary));
  assert.ok(!JSON.stringify(f.events).includes(temporary));
  assert.equal(statSync(f.statePath).mode & 0o777, 0o600);
  const reloaded = f.reload();
  assert.equal(reloaded.publicOrigin(), null, "a restarted process must reverify first");
  assert.equal((await reloaded.status(true)).phase, "ready");
});

test("consent is resumable, repeated setup is idempotent, and disabling removes only an owned listener", async (t) => {
  const f = fixture(t);
  f.authorize(true);
  const pending = await f.service.setup({ provider: "tailscale" });
  assert.equal(pending.phase, "needs_authorization");
  assert.equal(pending.authorizationUrl, "https://login.tailscale.com/f/fixture");
  assert.equal(f.service.view(false).authorizationUrl, undefined);
  f.authorize(false);
  assert.equal((await f.reload().setup({ provider: "tailscale" })).phase, "ready");
  const count = f.calls.filter((args) => args.includes("--bg")).length;
  await f.service.setup({ provider: "tailscale" });
  assert.equal(f.calls.filter((args) => args.includes("--bg")).length, count);
  assert.equal((await f.service.disable()).phase, "not_configured");
  assert.deepEqual(f.config.TCP, {});
});

test("occupied or public listeners are preserved and the external alternative port reaches every generated address", async (t) => {
  const f = fixture(t);
  f.config.TCP["443"] = { HTTPS: true };
  f.config.Web["fixture.example.ts.net:443"] = { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } };
  const original = structuredClone(f.config.Web["fixture.example.ts.net:443"]);
  const result = await f.service.setup({ provider: "tailscale" });
  assert.equal(result.origin, "https://fixture.example.ts.net:8443");
  await f.service.disable();
  assert.deepEqual(f.config.Web["fixture.example.ts.net:443"], original);
  f.config.Web["fixture.example.ts.net:443"]!.Handlers["/"]!.Proxy = "http://127.0.0.1:4317";
  f.config.AllowFunnel["fixture.example.ts.net:443"] = true;
  assert.equal((await f.service.setup({ provider: "tailscale" })).origin, "https://fixture.example.ts.net:8443");
  assert.equal(f.config.AllowFunnel["fixture.example.ts.net:443"], true);
});

test("status revokes a ready private origin when Funnel exposes its owned listener without changing Tailscale", async (t) => {
  const f = fixture(t);
  const ready = await f.service.setup({ provider: "tailscale" });
  assert.equal(ready.phase, "ready");
  assert.equal(f.service.publicOrigin(), "https://fixture.example.ts.net");
  assert.deepEqual(f.config.Web["fixture.example.ts.net:443"], {
    Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } },
  });
  assert.ok(f.calls.some((args) => args.includes("--bg")), "setup created the owned listener");

  f.config.AllowFunnel["fixture.example.ts.net:443"] = true;
  const exposed = structuredClone(f.config);
  const callsBeforeStatus = f.calls.length;
  f.tick();
  const result = await f.service.status(true);
  assert.deepEqual({ phase: result.phase, origin: f.service.publicOrigin() }, {
    phase: "needs_repair", origin: null,
  });
  assert.equal(result.origin, null);
  assert.equal(result.message, "This listener now allows public access. Review it in Tailscale before retrying private remote access.");
  assert.deepEqual(f.config, exposed, "status preserves the listener and its Funnel setting");
  assert.deepEqual(f.calls.slice(callsBeforeStatus), [["serve", "status", "--json"]], "status only reads Tailscale configuration");
});

test("a reused operator listener is not owned, and externally changed owned services are never removed", async (t) => {
  const f = fixture(t);
  f.config.TCP["443"] = { HTTPS: true };
  f.config.Web["fixture.example.ts.net:443"] = { Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } } };
  await f.service.setup({ provider: "tailscale" });
  await f.service.disable();
  assert.ok(f.config.TCP["443"]);
  delete f.config.TCP["443"]; delete f.config.Web["fixture.example.ts.net:443"];
  await f.service.setup({ provider: "tailscale" });
  f.config.Web["fixture.example.ts.net:443"]!.Handlers["/other"] = { Proxy: "http://127.0.0.1:9000" };
  const blocked = await f.service.disable();
  assert.equal(blocked.phase, "ready", "failed removal preserves the working address");
  assert.equal(blocked.setupPhase, "needs_repair");
  assert.ok(f.config.Web["fixture.example.ts.net:443"]!.Handlers["/other"]);
});

test("wrong identity never receives a verification credential, and API/live failures cannot become ready", async (t) => {
  const f = fixture(t);
  f.wrongProof();
  assert.equal((await f.service.setup({ provider: "https", origin: "https://wrong.example.test" })).phase, "needs_repair");
  assert.equal(f.requests.filter((req) => req.token).length, 0);
  const g = fixture(t); g.wrongApi();
  assert.equal((await g.service.setup({ provider: "tailscale" })).phase, "needs_repair");
  assert.equal(g.service.publicOrigin(), null);
  const h = fixture(t); h.failLive(true);
  assert.equal((await h.service.setup({ provider: "tailscale" })).phase, "needs_repair");
  assert.equal(h.service.publicOrigin(), null);
});

test("stale setup revokes ready status; a failed replacement preserves the previous working origin", async (t) => {
  const f = fixture(t);
  await f.service.setup({ provider: "https", origin: "https://working.example.test" });
  f.failLive(true);
  await f.service.setup({ provider: "https", origin: "https://broken.example.test" });
  assert.equal(f.service.publicOrigin(), "https://working.example.test");
  f.tick();
  const stale = await f.service.status(false);
  assert.equal(stale.phase, "needs_repair");
  assert.equal(stale.origin, null);
  assert.equal(f.service.publicOrigin(), null);
  assert.ok(!stale.message.includes("secret"));
});

test("unavailable Tailscale has an actionable failure and no mutation", async (t) => {
  const f = fixture(t); f.unavailable();
  const view = await f.service.setup({ provider: "tailscale" });
  assert.match(view.message, /Install or open Tailscale/u);
  assert.deepEqual(f.calls, [["status", "--json"]]);
});

test("origin and consent validation refuse unsafe or unrelated addresses", () => {
  for (const origin of ["http://example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test/#pair=secret", "javascript:alert(1)"]) {
    assert.throws(() => remoteHttpsOrigin(origin));
  }
  assert.equal(tailscaleAuthorizationUrl("https://evil.test/?url=https://login.tailscale.com/a"), undefined);
  assert.equal(tailscaleAuthorizationUrl("https://login.tailscale.com.evil.test/a"), undefined);
});

test("cancelling during verification removes only the pending listener and keeps local access", async (t) => {
  const f = fixture(t);
  let reached!: () => void;
  const verifying = new Promise<void>((resolve) => { reached = resolve; });
  f.deps.live = async (_origin, _token, signal) => {
    reached();
    await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  };
  const attempt = f.service.setup({ provider: "tailscale" });
  await verifying;
  const cancelled = await f.service.cancel();
  await attempt;
  assert.equal(cancelled.phase, "not_configured");
  assert.equal(f.service.publicOrigin(), null);
  assert.deepEqual(f.config.TCP, {});
});


test("malformed optional settings leave local access available and are never overwritten", async (t) => {
  const f = fixture(t);
  writeFileSync(f.statePath, "broken settings", { mode: 0o600 });
  const reloaded = f.reload();
  assert.equal(reloaded.view(true).phase, "needs_repair");
  assert.equal((await reloaded.setup({ provider: "tailscale" })).phase, "needs_repair");
  assert.equal(readFileSync(f.statePath, "utf8"), "broken settings");
  assert.equal(f.calls.length, 0);
});

test("concurrent status reads wait for one verification and closing setup does not cancel a read", async (t) => {
  const f = fixture(t);
  await f.service.setup({ provider: "https", origin: "https://working.example.test" });
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => { arrived = resolve; });
  f.deps.live = async () => { arrived(); await new Promise<void>((resolve) => { release = resolve; }); };
  const reloaded = f.reload();
  const first = reloaded.status(true);
  await reached;
  let secondReturned = false;
  const second = reloaded.status(true).then((view) => { secondReturned = true; return view; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const returnedBeforeVerification = secondReturned;
  const closing = reloaded.cancel();
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  assert.equal((await first).phase, "ready");
  assert.equal((await second).phase, "ready");
  assert.equal((await closing).phase, "ready");
  assert.equal(returnedBeforeVerification, false, "a concurrent reader must not publish an unverified view");
});

test("a failed replacement leaves the previous verified address available to every consumer", async (t) => {
  const f = fixture(t);
  await f.service.setup({ provider: "https", origin: "https://working.example.test" });
  f.failLive(true);
  const view = await f.service.setup({ provider: "https", origin: "https://replacement.example.test" });
  assert.equal(view.phase, "ready");
  assert.equal(view.origin, "https://working.example.test");
  assert.equal(view.setupPhase, "needs_repair");
  assert.ok(view.setupMessage);
  assert.equal(f.service.view(false).setupMessage, undefined, "remote consumers see only active availability");
});


test("cancel follows a queued setup after a background status check without leaving it provisioning", async (t) => {
  const f = fixture(t);
  await f.service.setup({ provider: "https", origin: "https://working.example.test" });
  f.tick();
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => { arrived = resolve; });
  let first = true;
  f.deps.live = async () => {
    if (first) { first = false; arrived(); await new Promise<void>((resolve) => { release = resolve; }); }
  };
  const reading = f.service.status(true);
  await reached;
  const changing = f.service.setup({ provider: "https", origin: "https://replacement.example.test" });
  const closing = f.service.cancel();
  const results = Promise.allSettled([reading, changing, closing]);
  release();
  const settled = await results;
  assert.equal(settled[2]!.status, "fulfilled", "one Cancel Setup must wait and cancel the queued mutation");
  assert.equal(f.service.publicOrigin(), "https://working.example.test", "the canceled replacement cannot become active");
  assert.equal(f.service.view(true).phase, "ready");
});
