import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import viteConfig, { WOLLIPOG_WEBVIEW_TARGETS } from "../apps/web/vite.config.ts";

const SUPPORTED_NATIVE_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-arm64-msvc",
  "win32-x64-msvc",
];

test("Vite production output pins the supported desktop webview floor", () => {
  assert.deepEqual(
    WOLLIPOG_WEBVIEW_TARGETS,
    ["chrome107", "edge107", "firefox104", "safari16"],
  );
  assert.equal(typeof viteConfig, "function");
  const config = viteConfig({ command: "build", mode: "production", isSsrBuild: false, isPreview: false });
  assert.deepEqual(config.build?.target, WOLLIPOG_WEBVIEW_TARGETS);
  assert.deepEqual(config.build?.cssTarget, WOLLIPOG_WEBVIEW_TARGETS);
  assert.equal(config.build?.outDir, undefined);

  const sameOriginConfig = viteConfig({ command: "build", mode: "same-origin-dev", isSsrBuild: false, isPreview: false });
  assert.deepEqual(sameOriginConfig.build?.target, WOLLIPOG_WEBVIEW_TARGETS);
  assert.deepEqual(sameOriginConfig.build?.cssTarget, WOLLIPOG_WEBVIEW_TARGETS);
  assert.equal(sameOriginConfig.build?.emptyOutDir, false);

  const e2eConfig = viteConfig({ command: "build", mode: "production-e2e", isSsrBuild: false, isPreview: false });
  assert.deepEqual(e2eConfig.build?.target, WOLLIPOG_WEBVIEW_TARGETS);
  assert.deepEqual(e2eConfig.build?.cssTarget, WOLLIPOG_WEBVIEW_TARGETS);
  assert.equal(e2eConfig.build?.outDir, "dist-e2e");
  assert.deepEqual(Object.keys(e2eConfig.build?.rolldownOptions?.input ?? {}).sort(), [
    "settingsRows",
    "timelineReflow",
    "xtermSmoke",
  ]);
});

test("Vite production browser coverage cannot silently lose a selected check", () => {
  const timelineSpec = readFileSync(new URL("../apps/web/e2e/timeline-reflow.spec.ts", import.meta.url), "utf8");
  const settingsSpec = readFileSync(new URL("../apps/web/e2e/settings-rows.spec.ts", import.meta.url), "utf8");
  const xtermSpec = readFileSync(new URL("../apps/web/e2e/xterm-smoke.spec.ts", import.meta.url), "utf8");
  const productionConfig = readFileSync(new URL("../playwright.production.config.ts", import.meta.url), "utf8");
  const markers = `${timelineSpec}\n${settingsSpec}\n${xtermSpec}`.match(/@production/g) ?? [];
  const requiredDeclarations = [
    [timelineSpec, "continuous panel resizing keeps long wrapped rows disjoint in every painted frame @production"],
    [timelineSpec, "mounting and unmounting a preceding notice preserves the anchor in every painted frame @production"],
    [timelineSpec, "mounting and unmounting a preceding notice during a list rerender preserves the anchor in every painted frame @production"],
    [settingsSpec, "every affordance is painted in ${theme} @production"],
    [settingsSpec, "the reduced topology production can render is covered too @production"],
    [xtermSpec, "renders initial and incremental raw output once, including split ANSI input @production"],
    [xtermSpec, "sends interactive input once and keeps the read-only terminal inert @production"],
    [xtermSpec, "reports fitted dimensions, refits on resize, and preserves usable scrollback @production"],
    [xtermSpec, "applies search entered while the terminal font is still loading @production"],
  ];

  // Nine tagged declarations discover ten tests because the painted-affordance case runs in two themes.
  assert.equal(markers.length, 9);
  for (const [source, title] of requiredDeclarations) {
    assert.ok(source.includes(title), `missing required production browser declaration: ${title}`);
  }
  assert.match(
    productionConfig,
    /testMatch:\s*\["timeline-reflow\.spec\.ts",\s*"settings-rows\.spec\.ts",\s*"xterm-smoke\.spec\.ts"\]/,
    "production browser selection must retain all validated fixtures",
  );
  assert.match(
    productionConfig,
    /grep:\s*\/@production\//,
    "production browser selection must retain the exact tag filter",
  );
});

test("Vite native build bindings cover every supported desktop release target", () => {
  const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");

  for (const target of SUPPORTED_NATIVE_TARGETS) {
    assert.match(
      lockfile,
      new RegExp(`^  '@rolldown/binding-${target}@[0-9]`, "m"),
      `missing Rolldown binding for ${target}`,
    );
    assert.match(
      lockfile,
      new RegExp(`^  lightningcss-${target}@[0-9]`, "m"),
      `missing Lightning CSS binding for ${target}`,
    );
  }
});
