import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// WebKit is the engine of Safari, iOS and both desktop webviews (WKWebView on macOS, WebKitGTK on
// Linux), and the one whose spin buttons #3185 had to remove. The rest of the suite encodes
// Chromium-measured geometry, so WebKit runs only the specs listed here (#3214). A spec opts in by
// being added to this list; apps/web/e2e/README.md names the covered specs.
export const WEBKIT_SPECS = ["number-fields.spec.ts", "compact-notice-icon-alignment.spec.ts"];

export default defineConfig({
  ...base,
  testMatch: WEBKIT_SPECS,
  // CI's `github` reporter prints only a count; the list names each test that ran in WebKit.
  reporter: process.env.CI ? [["list"], ["github"], ["./scripts/ci-browser-timing-reporter.mjs"]] : "list",
  use: { ...base.use, browserName: "webkit" },
});
