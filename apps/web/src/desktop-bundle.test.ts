import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DESKTOP_BUILD_ENV, DESKTOP_EXCLUDED_ASSETS, isDesktopBuild, stripManifestLink } from "./desktop-bundle.js";

/**
 * §23.6 and §24's "add a check that the desktop bundle excludes sw.js / manifest.webmanifest".
 *
 * The check that matters runs a REAL build and looks at what came out. Asserting that the config
 * mentions a plugin, or that a pure helper returns the right list, would pass with the plugin wired
 * to nothing — and the whole class of bug here is a build step that silently stops running.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));

test("the excluded list is the two files that must not ship, named here independently", () => {
  // The build test below iterates DESKTOP_EXCLUDED_ASSETS, which is also what production uses —
  // so dropping an entry from that list would make the desktop ship the file while both build
  // tests stayed green. These names are written out once more, on purpose.
  assert.deepEqual([...DESKTOP_EXCLUDED_ASSETS].sort(), ["manifest.webmanifest", "sw.js"]);
});

test("the packaging flag is actually set by the packaging path", () => {
  // The build tests set WOLLIPOG_DESKTOP_BUILD themselves, which proves the plugin works and
  // proves nothing about whether anything sets it. Breaking the wiring would ship a desktop bundle
  // with a service worker in it and leave every other test here passing.
  const script = readFileSync(fileURLToPath(new URL("../../desktop/scripts/build-web-for-desktop.mjs", import.meta.url)), "utf8");
  // `\\s` — a template literal eats a single backslash, which would leave the regex matching a
  // literal "s" and passing only by accident.
  assert.match(script, new RegExp(`${DESKTOP_BUILD_ENV}:\\s*"1"`),
    "the desktop web build no longer sets the flag the Vite plugin reads");
  assert.match(script, /"--filter",\s*"@wollipog\/web",\s*"build"/, "and it must still be the web build it runs");

  const conf = JSON.parse(readFileSync(fileURLToPath(new URL("../../desktop/src-tauri/tauri.conf.json", import.meta.url)), "utf8")) as {
    build?: { beforeBuildCommand?: string };
  };
  assert.match(conf.build?.beforeBuildCommand ?? "", /@wollipog\/desktop web:build/,
    "the Tauri build must go through the script that sets the flag, not the plain web build");
});

test("desktop content security policies allow the Browser panel's supported external previews", () => {
  const conf = JSON.parse(readFileSync(fileURLToPath(new URL("../../desktop/src-tauri/tauri.conf.json", import.meta.url)), "utf8")) as {
    app?: { security?: { csp?: string; devCsp?: string } };
  };
  for (const [name, policy] of Object.entries({
    csp: conf.app?.security?.csp,
    devCsp: conf.app?.security?.devCsp,
  })) {
    assert.match(
      policy ?? "",
      /(?:^|;\s*)frame-src 'self' http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\* https:(?:;|$)/,
      `${name} must preserve same-origin frames and permit loopback HTTP and HTTPS without arbitrary HTTP frames`,
    );
    assert.match(policy ?? "", /(?:^|;\s*)img-src 'self' data: blob: https:(?:;|$)/,
      `${name} must permit HTTPS transcript images without permitting arbitrary HTTP images`);
    assert.match(policy ?? "", /(?:^|;\s*)media-src 'self' blob: https:(?:;|$)/,
      `${name} must permit HTTPS transcript videos without permitting arbitrary HTTP media`);
  }
});

test("the flag is read from the environment, exactly", () => {
  assert.equal(isDesktopBuild({ [DESKTOP_BUILD_ENV]: "1" }), true);
  assert.equal(isDesktopBuild({}), false, "an ordinary web build keeps its PWA assets");
  // Not truthiness: an empty or stray value must not silently select the desktop bundle, because
  // that would ship a browser build with no manifest and no way to install it.
  assert.equal(isDesktopBuild({ [DESKTOP_BUILD_ENV]: "" }), false);
  assert.equal(isDesktopBuild({ [DESKTOP_BUILD_ENV]: "0" }), false);
  assert.equal(isDesktopBuild({ [DESKTOP_BUILD_ENV]: "true" }), false);
});

test("stripping the manifest link leaves the rest of the head alone", () => {
  const head = '  <link rel="icon" href="/favicon.svg" />\n  <link rel="manifest" href="/manifest.webmanifest" />\n  <title>Wollipog</title>\n';
  const stripped = stripManifestLink(head);
  assert.doesNotMatch(stripped, /rel="manifest"/);
  assert.match(stripped, /rel="icon"/, "only the manifest link goes");
  assert.match(stripped, /<title>Wollipog<\/title>/);
  assert.equal(stripManifestLink("<p>no link here</p>"), "<p>no link here</p>");
});

test("a desktop build ships neither the service worker nor the manifest", { timeout: 300_000 }, () => {
  // A real build, because the failure this guards against is a build step that stops running.
  execFileSync("npx", ["vite", "build", "--outDir", "dist-desktop-check", "--emptyOutDir"], {
    cwd: WEB,
    env: { ...process.env, [DESKTOP_BUILD_ENV]: "1" },
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  const out = join(WEB, "dist-desktop-check");
  assert.ok(existsSync(join(out, "index.html")), "the build produced nothing, so it proves nothing");

  for (const asset of DESKTOP_EXCLUDED_ASSETS) {
    assert.equal(existsSync(join(out, asset)), false, `${asset} is meaningless in a Tauri webview and still shipped`);
  }
  const html = readFileSync(join(out, "index.html"), "utf8");
  assert.doesNotMatch(html, /rel="manifest"/,
    "the link would 404 on every launch now that the file is gone");
});

test("an ordinary web build keeps both, because the PWA is the point there", { timeout: 300_000 }, () => {
  // The other half. A plugin that deleted these unconditionally would pass the test above while
  // breaking installability everywhere, which is the failure that would not be noticed.
  const env = { ...process.env };
  delete env[DESKTOP_BUILD_ENV];
  execFileSync("npx", ["vite", "build", "--outDir", "dist-web-check", "--emptyOutDir"], {
    cwd: WEB, env, stdio: "pipe", shell: process.platform === "win32",
  });
  const out = join(WEB, "dist-web-check");
  for (const asset of DESKTOP_EXCLUDED_ASSETS) {
    assert.ok(existsSync(join(out, asset)), `${asset} is how the browser build installs; it must stay`);
  }
  assert.match(readFileSync(join(out, "index.html"), "utf8"), /rel="manifest"/);
});
