import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { carriesTokenParam, redactTokenInUrl } from "./auth.js";
import { appShellSecurityHeaders, injectSameOriginMarker, isIndexHtmlPath, isSpaNavigation } from "./web-dist.js";

const INDEX = "<!doctype html><html><head><title>t</title></head><body><div id=root></div></body></html>";

/**
 * The REAL serving wiring from index.ts — @fastify/static, the explicit shell routes, and the
 * SPA-fallback notFound handler — over a temp bundle. `http-auth.test.ts` stubs static with a
 * plain wildcard; this exercises the plugin itself, which is where the `/index.html` and `/ui/`
 * holes lived.
 */
function buildServingApp(t: { after: (fn: () => void) => void }): { app: FastifyInstance; logged: string[] } {
  const root = mkdtempSync(join(tmpdir(), "wollipog-webdist-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "index.html"), INDEX);
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(root, "secret.txt"), "not a navigation target");
  // The PWA assets the web build now emits (public/ passthrough).
  writeFileSync(join(root, "manifest.webmanifest"), JSON.stringify({ name: "t", start_url: "/" }));
  writeFileSync(join(root, "sw.js"), "self.addEventListener('install', () => {});");
  mkdirSync(join(root, "icons"), { recursive: true });
  writeFileSync(join(root, "icons", "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const logged: string[] = [];
  const app = Fastify();
  app.register(fastifyStatic, {
    root,
    prefix: "/",
    index: false,
    allowedPath: (pathname) => !isIndexHtmlPath(pathname),
  });

  const html = injectSameOriginMarker(INDEX);
  const serveShell = async (req: FastifyRequest, reply: FastifyReply) => {
    const rawUrl = req.raw.url ?? "";
    if (carriesTokenParam(rawUrl)) return reply.redirect(rawUrl.split("?")[0] || "/", 303);
    return reply.headers(appShellSecurityHeaders(html)).type("text/html; charset=utf-8").send(html);
  };
  app.get("/", serveShell);
  app.get("/index.html", serveShell);
  app.get("/ui", async () => ({ socket: "ui" }));
  app.get("/api/runners", async () => ({ runners: [] }));

  app.setNotFoundHandler((req, reply) => {
    const rawUrl = req.raw.url ?? "";
    const pathname = rawUrl.split("?")[0] ?? "";
    if (!carriesTokenParam(rawUrl) && isSpaNavigation(req.method, pathname)) {
      return reply.headers(appShellSecurityHeaders(html)).type("text/html; charset=utf-8").send(html);
    }
    logged.push(redactTokenInUrl(rawUrl));
    reply.code(404).send({ error: "not found" });
  });
  t.after(() => app.close());
  return { app, logged };
}

const isShell = (res: { statusCode: number; body: string; headers: Record<string, unknown> }) =>
  res.statusCode === 200 && String(res.headers["content-type"]).startsWith("text/html");

test("every app-shell route carries the same-origin marker", async (t) => {
  const { app } = buildServingApp(t);
  await app.ready();
  for (const url of [
    "/", "/index.html", "/sessions/~YQBiAGMA", "/sessions/~ZgBvAG8ALgB0AHgAdAA",
    "/sessions/~bgBlAHMAdABlAGQALwByAGUAcABvAHIAdAAuAGoAcwBvAG4A",
    "/sessions/~YQAvAC4ALgAvAGYAbwBvAC4AdAB4AHQA",
    "/runs", "/runs/~cgB1AG4AXwBhAGIAYwA", "/pods", "/pods/~cABvAGQAXwBhAGIAYwA",
    "/automations", "/runners",
  ]) {
    const res = await app.inject({ method: "GET", url });
    assert.ok(isShell(res), `${url} should render the shell`);
    assert.ok(res.body.includes("window.__WOLLIPOG_SAME_ORIGIN__=1"), `${url} must carry the marker`);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    const csp = String(res.headers["content-security-policy"]);
    assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
  }
});

// Static's wildcard would otherwise serve index.html straight off disk — unmarked — so a phone
// opening /index.html#pair=<token> would point its API calls at 127.0.0.1, i.e. itself. The
// explicit route only covers the exact string, so `allowedPath` refuses every other spelling.
test("REGRESSION: no spelling of index.html is served raw from disk", async (t) => {
  const { app } = buildServingApp(t);
  await app.ready();
  for (const url of ["/index.html", "/INDEX.HTML", "/./index.html", "/index.html/", "/index.html?x=1"]) {
    const res = await app.inject({ method: "GET", url });
    assert.ok(isShell(res), `${url} must render HTML, got ${res.statusCode}`);
    assert.ok(res.body.includes("window.__WOLLIPOG_SAME_ORIGIN__=1"), `${url} must carry the marker`);
  }

  // Fastify 5.12 rejects an authority-form-looking path before the static wildcard or SPA
  // fallback can run. Rejection is the safe outcome: the raw, unmarked entry document is not sent.
  const duplicateSlash = await app.inject({ method: "GET", url: "//index.html" });
  assert.equal(duplicateSlash.statusCode, 403);
  assert.ok(!isShell(duplicateSlash));
  assert.ok(!duplicateSlash.body.includes(INDEX));
});

// `/ui/` misses the exact `/ui` route; the shell would leave the token in history/referrers.
test("REGRESSION: /ui/?token=… is a redacted 404, never the shell", async (t) => {
  const { app, logged } = buildServingApp(t);
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/ui/?token=SECRET" });
  assert.equal(res.statusCode, 404);
  assert.ok(!isShell(res), "must not render the app shell");
  assert.ok(logged.some((u) => u.includes("<redacted>")), "the 404 log line redacts the token");
  assert.ok(!logged.some((u) => u.includes("SECRET")), "the raw token never reaches the log");

  // Sibling reserved paths behave the same.
  assert.equal((await app.inject({ method: "GET", url: "/runner/" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/%75i/" })).statusCode, 404, "encoded /ui/");

  // Any token-bearing URL refuses the shell, even on an otherwise ordinary client route.
  const client = await app.inject({ method: "GET", url: "/board?token=SECRET" });
  assert.equal(client.statusCode, 404);
});

// The explicit shell routes bypass the notFound guard, so they must strip a token themselves.
test("REGRESSION: a token-bearing shell URL is redirected to the clean path, never served with the token", async (t) => {
  const { app } = buildServingApp(t);
  await app.ready();
  for (const url of ["/?token=SECRET", "/index.html?token=SECRET", "/?to%6ben=SECRET"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 303, `${url} should redirect, not serve`);
    const loc = String(res.headers.location);
    assert.ok(!/token/i.test(loc) && !loc.includes("SECRET"), `redirect target must be token-free: ${loc}`);
  }
});

// `to%6ben=` decodes to `token=` (what URLSearchParams — and thus /ui auth — accepts), so a raw
// regex guard missed it and rendered the shell with the token in the URL.
test("REGRESSION: an encoded token key on a client route is a redacted 404, not the shell", async (t) => {
  const { app, logged } = buildServingApp(t);
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/board?to%6ben=SECRET" });
  assert.equal(res.statusCode, 404);
  assert.ok(!isShell(res));
  assert.ok(logged.some((u) => u.includes("<redacted>")) && !logged.some((u) => u.includes("SECRET")));
});

test("assets serve; a missing asset 404s instead of returning HTML", async (t) => {
  const { app } = buildServingApp(t);
  await app.ready();

  const asset = await app.inject({ method: "GET", url: "/assets/app-abc.js" });
  assert.equal(asset.statusCode, 200);
  assert.ok(!String(asset.headers["content-type"]).startsWith("text/html"));

  // A browser would try to parse an HTML body as JavaScript — fail loudly instead.
  const missing = await app.inject({ method: "GET", url: "/assets/gone.js" });
  assert.equal(missing.statusCode, 404);
  assert.ok(!isShell(missing));
});

// The PWA depends on these being real files, never the SPA shell: a manifest or worker served
// as HTML would break install/registration with a baffling parse error, and a MISSING worker
// must 404 (browsers treat non-JS/404 sw.js as registration failure, not a hijacked shell).
test("PWA assets serve as themselves; missing ones 404 instead of returning the shell", async (t) => {
  const { app } = buildServingApp(t);
  await app.ready();

  const manifest = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
  assert.equal(manifest.statusCode, 200);
  assert.ok(!isShell(manifest), "manifest must not be the app shell");
  assert.equal(JSON.parse(manifest.body).start_url, "/");

  const sw = await app.inject({ method: "GET", url: "/sw.js" });
  assert.equal(sw.statusCode, 200);
  assert.ok(!isShell(sw), "sw.js must not be the app shell");
  assert.ok(String(sw.headers["content-type"]).includes("javascript"), "sw.js must serve as JS");

  const icon = await app.inject({ method: "GET", url: "/icons/icon-192.png" });
  assert.equal(icon.statusCode, 200);
  assert.ok(String(icon.headers["content-type"]).includes("image/png"));

  // File-shaped misses 404 honestly (isSpaNavigation refuses extensions).
  for (const url of ["/icons/gone.png", "/gone.webmanifest", "/gone-sw.js"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404, `${url} must 404`);
    assert.ok(!isShell(res), `${url} must not render the shell`);
  }
});

test("the API and sockets never fall back to the shell", async (t) => {
  const { app } = buildServingApp(t);
  await app.ready();
  for (const url of ["/api/nonexistent", "/api/", "/ui/x"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404, `${url} must 404`);
    assert.ok(!isShell(res), `${url} must not render the shell`);
  }
  // A non-navigation method on a client route is a 404, not the shell.
  assert.equal((await app.inject({ method: "POST", url: "/board" })).statusCode, 404);
});

test("static cannot escape the bundle root", async (t) => {
  const { app } = buildServingApp(t);
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/../package.json" });
  assert.ok(res.statusCode >= 400, `traversal must be refused, got ${res.statusCode}`);
});
