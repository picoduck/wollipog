import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";
import { browserFiles } from "./playwright.shards.ts";
import { validateBrowserFiles } from "./scripts/ci-pr-browser-policy.mjs";

const inventory = browserFiles().map((file) => `apps/web/e2e/${file}`);
const selected = validateBrowserFiles(process.env.PR_BROWSER_FILES ?? "", inventory);
export default defineConfig({
  ...base,
  snapshotPathTemplate: "{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}",
  testMatch: selected.map((file: string) => new RegExp(`(?:^|/)${file.slice("apps/web/e2e/".length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)),
});
