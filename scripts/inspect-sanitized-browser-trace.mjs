// Inspection helper for the pinned Playwright version; this does not upload anything.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const require = createRequire(import.meta.url);
const corePath = require.resolve("playwright-core/package.json", { paths: [require.resolve("playwright/package.json")] });
const { server: { startTraceViewerServer } } = require(join(dirname(corePath), "lib/coreBundle.js"));
const trace = resolve(process.argv[2]);
const server = await startTraceViewerServer({ host: "127.0.0.1", port: 0, allowedFileRoots: () => [dirname(trace)] });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const traceUrl = `${server.urlPrefix("precise")}/trace/file?path=${encodeURIComponent(trace)}`;
  await page.goto(`${server.urlPrefix("precise")}/trace/index.html?trace=${encodeURIComponent(traceUrl)}`);
  const action = page.getByRole("treeitem", { name: /^Click \d/ }).first();
  await expect(action).toBeVisible({ timeout: 15_000 });
  await action.click();
  await page.getByRole("tab", { name: "Before", exact: true }).click();
  const snapshot = page.frameLocator("iframe:visible").first();
  await expect(snapshot.getByRole("button", { name: "Synthetic Button" })).toBeVisible({ timeout: 15_000 });
  await expect(snapshot.locator("output")).toHaveText("Synthetic Ready");
  await page.getByRole("tab", { name: "After", exact: true }).click();
  await expect(snapshot.locator("output")).toHaveText("Synthetic Complete");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ inspectable: true, interaction: "locator.click", before: "Synthetic Ready", after: "Synthetic Complete", pageErrors: 0 }));
} finally {
  await browser?.close();
  await server.stop();
}
