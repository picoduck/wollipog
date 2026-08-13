import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  injectSameOriginMarker,
  isIndexHtmlPath,
  isPackagedExec,
  isSpaNavigation,
  looksLikeBuiltBundle,
  normalizeRequestPath,
  resolveWebDist,
  webDistCandidates,
} from "./web-dist.js";

/** Only `index.html` exists in `dir` — a well-formed built bundle. */
const bundleAt =
  (...dirs: string[]) =>
  (p: string) =>
    dirs.some((d) => p === join(d, "index.html"));

test("isPackagedExec: true only for a packaged binary, not a plain node/tsx run", () => {
  assert.equal(isPackagedExec("/opt/app/control-plane"), true);
  assert.equal(isPackagedExec("C:\\app\\control-plane.exe"), true);
  assert.equal(isPackagedExec("/usr/bin/node"), false);
  assert.equal(isPackagedExec("C:\\Program Files\\nodejs\\node.exe"), false);
  assert.equal(isPackagedExec("C:\\Program Files\\nodejs\\NODE.EXE"), false); // case-insensitive
});

test("webDistCandidates: env override wins, then execDir (packaged only), then the cwd layouts", () => {
  const c = webDistCandidates({ WOLLIPOG_WEB_DIST: "/custom/dist" }, "/repo", "/opt/app/cp");
  assert.equal(c[0], "/custom/dist");
  assert.equal(c[1], join("/opt/app", "web"));
  assert.equal(c[2], join("/repo", "apps", "web", "dist"));
  assert.equal(c[3], join("/repo", "..", "web", "dist"));

  // No override, packaged → the packaged location leads.
  const d = webDistCandidates({}, "/repo", "/opt/app/cp");
  assert.equal(d[0], join("/opt/app", "web"));
  assert.equal(d.length, 3);
});

test("webDistCandidates prefers the Wollipog override and warns only on legacy fallback", () => {
  const warnings: string[] = [];
  assert.equal(
    webDistCandidates(
      { WOLLIPOG_WEB_DIST: "/current", MAM_WEB_DIST: "/legacy" },
      "/repo",
      "/opt/app/cp",
      (warning) => warnings.push(warning),
    )[0],
    "/current",
  );
  assert.deepEqual(warnings, []);
  assert.equal(
    webDistCandidates(
      { MAM_WEB_DIST: "/legacy" },
      "/repo",
      "/opt/app/cp",
      (warning) => warnings.push(warning),
    )[0],
    "/legacy",
  );
  assert.deepEqual(warnings, ["MAM_WEB_DIST is deprecated; use WOLLIPOG_WEB_DIST"]);
  assert.equal(
    webDistCandidates({ WOLLIPOG_WEB_DIST: "", MAM_WEB_DIST: "/legacy" }, "/repo", "/opt/app/cp")[0],
    join("/opt/app", "web"),
    "an explicitly empty new value suppresses the legacy override",
  );
});

// Under `node`/`tsx`, execPath is the shared Node binary — a `web/` folder beside it is not ours,
// and serving it would grant a stale/planted page same-origin trust over the API.
test("webDistCandidates: a node/tsx run never consults <dirname(node)>/web", () => {
  const c = webDistCandidates({}, "/repo", "C:\\Program Files\\nodejs\\node.exe");
  assert.ok(!c.some((p) => p.toLowerCase().includes("nodejs")), "the node bin dir must not be a candidate");
  assert.equal(c[0], join("/repo", "apps", "web", "dist"), "the repo build leads in dev");
});

test("resolveWebDist: under node, the repo dist wins over a planted web/ beside the node binary", () => {
  const nodeExe = "C:\\Program Files\\nodejs\\node.exe";
  const planted = join("C:\\Program Files\\nodejs", "web");
  const repo = join("/repo", "apps", "web", "dist");
  assert.equal(resolveWebDist({}, "/repo", nodeExe, bundleAt(planted, repo)), repo);
  // With nothing in the repo, the planted dir is still NOT served.
  assert.equal(resolveWebDist({}, "/repo", nodeExe, bundleAt(planted)), null);
});

test("resolveWebDist: picks the first candidate holding a built bundle, else null", () => {
  const present = join("/repo", "apps", "web", "dist");
  assert.equal(resolveWebDist({}, "/repo", "/opt/app/cp", bundleAt(present)), present);

  // An override that exists outranks the repo build.
  assert.equal(resolveWebDist({ WOLLIPOG_WEB_DIST: "/custom" }, "/repo", "/opt/app/cp", bundleAt(present, "/custom")), "/custom");

  // An override pointing at nothing falls through rather than breaking serving.
  assert.equal(resolveWebDist({ WOLLIPOG_WEB_DIST: "/gone" }, "/repo", "/opt/app/cp", bundleAt(present)), present);

  // Nothing built anywhere → null (API-only; the UI just isn't browser-served).
  assert.equal(resolveWebDist({}, "/repo", "/opt/app/cp", () => false), null);
});

// `WOLLIPOG_WEB_DIST=apps/web` (missing `/dist`) would publish src/, package.json and configs.
test("looksLikeBuiltBundle rejects a source root; resolveWebDist skips past it", () => {
  const srcRoot = join("/repo", "apps", "web");
  const dist = join("/repo", "apps", "web", "dist"); // must match webDistCandidates' join() exactly
  const exists = (p: string) =>
    p === join(srcRoot, "index.html") ||
    p === join(srcRoot, "package.json") ||
    p === join(srcRoot, "src") ||
    p === join(dist, "index.html");

  assert.equal(looksLikeBuiltBundle(srcRoot, exists), false, "package.json + src ⇒ source root");
  assert.equal(looksLikeBuiltBundle(dist, exists), true);
  assert.equal(looksLikeBuiltBundle("/nowhere", exists), false, "no index.html at all");

  // A misconfigured override is ignored rather than publishing the source tree.
  assert.equal(resolveWebDist({ WOLLIPOG_WEB_DIST: srcRoot }, "/repo", "/opt/app/cp", exists), dist);
});

test("isSpaNavigation: client routes render the shell; assets and the API 404 honestly", () => {
  assert.equal(isSpaNavigation("GET", "/"), true);
  assert.equal(isSpaNavigation("GET", "/sessions/~YQBiAGMA"), true);
  assert.equal(isSpaNavigation("GET", "/runs/~cgB1AG4AXwBhAGIAYwA"), true);
  assert.equal(isSpaNavigation("GET", "/pods/~cABvAGQAXwBhAGIAYwA"), true);
  assert.equal(isSpaNavigation("GET", "/sessions/~ZgBvAG8ALgB0AHgAdAA"), true);
  assert.equal(isSpaNavigation("HEAD", "/sessions/~YQAvAC4ALgAvAGYAbwBvAC4AdAB4AHQA"), true);
  assert.equal(isSpaNavigation("GET", "/automations"), true);
  assert.equal(isSpaNavigation("HEAD", "/board"), true);

  // A missing asset must 404, not return HTML the browser would parse as JS.
  assert.equal(isSpaNavigation("GET", "/assets/index-abc.js"), false);
  assert.equal(isSpaNavigation("GET", "/favicon.ico"), false);
  assert.equal(isSpaNavigation("GET", "/sessions/~YQBiAGMA/nested.js"), false);
  assert.equal(isSpaNavigation("GET", "/runs/~cgB1AG4AXwBhAGIAYwA/chunk.css"), false);

  // The API and sockets never fall back to the shell.
  assert.equal(isSpaNavigation("GET", "/api"), false);
  assert.equal(isSpaNavigation("GET", "/api/nonexistent"), false);
  assert.equal(isSpaNavigation("GET", "/ui"), false);
  assert.equal(isSpaNavigation("GET", "/runner"), false);
  assert.equal(isSpaNavigation("GET", "/hooks"), false);

  // Only navigations — a stray POST/DELETE to an unknown path is a 404, not the shell.
  assert.equal(isSpaNavigation("POST", "/board"), false);
  assert.equal(isSpaNavigation("DELETE", "/board"), false);
});

test("normalizeRequestPath: alternate spellings collapse to one canonical path", () => {
  assert.equal(normalizeRequestPath("/"), "/");
  assert.equal(normalizeRequestPath("//"), "/");
  assert.equal(normalizeRequestPath("//index.html"), "/index.html");
  assert.equal(normalizeRequestPath("/./index.html"), "/index.html");
  assert.equal(normalizeRequestPath("/index.html/"), "/index.html");
  assert.equal(normalizeRequestPath("/a/../index.html"), "/index.html");
  assert.equal(normalizeRequestPath("\\index.html"), "/index.html"); // backslashes fold
  assert.equal(normalizeRequestPath("/%75i/"), "/ui"); // percent-decoded
  assert.equal(normalizeRequestPath("/ui//"), "/ui");
  assert.equal(normalizeRequestPath("/../package.json"), "/package.json"); // can't escape upward
  assert.equal(normalizeRequestPath("/%zz"), "/%zz"); // malformed escape survives
});

// The exact-string `/index.html` route only beats the wildcard for that exact spelling; every
// other spelling reached the RAW file. An unmarked shell makes a phone target 127.0.0.1 — itself.
test("isIndexHtmlPath: matches every spelling of the entry document, and nothing else", () => {
  for (const p of ["/index.html", "/INDEX.HTML", "/Index.Html", "//index.html", "/./index.html", "/index.html/"]) {
    assert.equal(isIndexHtmlPath(p), true, `${p} must be treated as the entry document`);
  }
  for (const p of ["/", "/board", "/assets/index.html", "/index.htmlx", "/notindex.html"]) {
    assert.equal(isIndexHtmlPath(p), false, `${p} must not be`);
  }
});

test("isSpaNavigation: every entry-document spelling renders the (marked) shell", () => {
  for (const p of ["/", "/index.html", "/INDEX.HTML", "//index.html", "/./index.html", "/index.html/"]) {
    assert.equal(isSpaNavigation("GET", p), true, `${p} should render the shell`);
  }
});

// `/ui/` misses the exact `/ui` socket route. An exact-match check served the SHELL for
// `GET /ui/?token=<device token>`, stranding a reusable credential in history/referrers.
test("isSpaNavigation: reserved paths are prefix-matched, including trailing slash and encoding", () => {
  assert.equal(isSpaNavigation("GET", "/ui/"), false);
  assert.equal(isSpaNavigation("GET", "/runner/"), false);
  assert.equal(isSpaNavigation("GET", "/api/"), false);
  assert.equal(isSpaNavigation("GET", "/hooks/"), false);
  assert.equal(isSpaNavigation("GET", "/ui/anything"), false);

  // Percent-encoded spellings decode to the same reserved prefixes.
  assert.equal(isSpaNavigation("GET", "/%75i/"), false, "/ui/ encoded");
  assert.equal(isSpaNavigation("GET", "/%61pi/x"), false, "/api/x encoded");
  assert.equal(isSpaNavigation("GET", "/%68ooks/v1"), false, "/hooks/v1 encoded");

  // A malformed escape must not throw — it simply isn't a reserved path.
  assert.equal(isSpaNavigation("GET", "/%zz"), true);

  // Lookalikes are still ordinary client routes.
  assert.equal(isSpaNavigation("GET", "/uix"), true);
  assert.equal(isSpaNavigation("GET", "/apix"), true);
  assert.equal(isSpaNavigation("GET", "/hooksx"), true);
});

test("injectSameOriginMarker: inserts before </head> and is idempotent", () => {
  const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
  const out = injectSameOriginMarker(html);
  assert.ok(out.includes("window.__WOLLIPOG_SAME_ORIGIN__=1"));
  assert.ok(out.includes("window.__MAM_SAME_ORIGIN__=1"), "a stale pre-rename bundle still detects same-origin serving");
  assert.ok(out.indexOf("__WOLLIPOG_SAME_ORIGIN__") < out.indexOf("</head>"), "marker lands inside <head>");
  // Re-injecting a served page must not stack duplicate scripts.
  assert.equal(injectSameOriginMarker(out), out);
  // No </head> (unexpected minifier output) → prepend rather than silently drop the marker.
  assert.ok(injectSameOriginMarker("<body>hi</body>").startsWith("<script>"));

  const legacy = "<head><script>window.__MAM_SAME_ORIGIN__=1</script></head>";
  const upgraded = injectSameOriginMarker(legacy);
  assert.equal(upgraded.match(/__MAM_SAME_ORIGIN__/g)?.length, 1, "legacy marker is not duplicated");
  assert.ok(upgraded.includes("window.__WOLLIPOG_SAME_ORIGIN__=1"), "new bundles also work with legacy-marked HTML");

  const renamed = "<head><script>window.__WOLLIPOG_SAME_ORIGIN__=1</script></head>";
  const bridged = injectSameOriginMarker(renamed);
  assert.equal(bridged.match(/__WOLLIPOG_SAME_ORIGIN__/g)?.length, 1, "renamed marker is not duplicated");
  assert.ok(bridged.includes("window.__MAM_SAME_ORIGIN__=1"), "stale bundles also work with renamed-marked HTML");
});
