import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
});

test("Vite native build bindings cover every supported desktop release target", () => {
  const lockfile = readFileSync(resolve(process.cwd(), "pnpm-lock.yaml"), "utf8");

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
