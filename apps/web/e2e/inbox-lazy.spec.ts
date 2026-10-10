import { expect, test } from "@playwright/test";
import { installInboxFixture } from "./inbox-production-fixture.js";
import { encodeResourceId } from "../src/navigation.js";

test("phone inbox defers secondary views and shows loading while Settings arrives @production", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installInboxFixture(page);
  const scripts: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(request.url()); });
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  await page.route("**/assets/SettingsView-*.js", async (route) => { await pending; await route.continue(); });
  await page.goto("/index.html");
  await expect(page.getByText("Synthetic Session 1", { exact: true })).toBeVisible();
  expect(scripts.some((url) => /(?:SessionDetail|ShellDock|SettingsView|RunnersView|NewSessionDialog|qrcode)-/.test(url))).toBe(false);
  await page.keyboard.press("Shift+Comma");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Loading…" })).toBeVisible();
  if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/settings-loading-390.png` });
  release();
  await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
  if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/settings-ready-390.png` });
});

test("lazy New Session can be cancelled before its script arrives and opened again @production", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installInboxFixture(page);
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  await page.route("**/assets/NewSessionDialog-*.js", async (route) => { await pending; await route.continue(); });
  await page.goto("/index.html");
  await expect(page.getByText("Synthetic Session 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New Session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New Session", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("Loading…");
  if (process.env.EVIDENCE_DIR) {
    // Capture pacing only: wait for the finite phone-sheet entry animation, excluding spinners.
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {}))));
    await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/new-session-loading-390.png` });
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "New Session", exact: true })).toBeFocused();
  release();
  await page.getByRole("button", { name: "New Session", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Loading…" })).toBeHidden();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "New Session", exact: true })).toBeFocused();
});

test("an offline New Session import stays dismissible without reloading the inbox @production", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installInboxFixture(page);
  await page.route("**/assets/NewSessionDialog-*.js", (route) => route.abort("internetdisconnected"));
  await page.goto("/index.html");
  await expect(page.getByText("Synthetic Session 1", { exact: true })).toBeVisible();
  const trigger = page.getByRole("button", { name: "New Session", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New Session", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("This Dialog Couldn't Be Shown");
  if (process.env.EVIDENCE_DIR) {
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {}))));
    await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/new-session-offline-error-390.png` });
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.getByText("Synthetic Session 1", { exact: true })).toBeVisible();
  // The cached import rejection remains recoverable with Close on another attempted open.
  await trigger.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("a delayed search palette focuses its input and returns focus to its opener @production", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installInboxFixture(page);
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  await page.route("**/assets/CommandPalette-*.js", async (route) => { await pending; await route.continue(); });
  await page.goto("/index.html");
  const trigger = page.getByRole("navigation", { name: "Primary Navigation" }).getByRole("button", { name: "Search", exact: true });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Search", exact: true }).getByRole("status")).toHaveText("Loading…");
  release();
  await expect(page.getByRole("combobox", { name: "Search", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("offline lazy script failure keeps the shell recoverable and service worker fetch policy intact @production", async ({ page }) => {
  await installInboxFixture(page);
  await page.route("**/assets/SettingsView-*.js", (route) => route.abort("internetdisconnected"));
  await page.goto("/index.html");
  await expect(page.getByText("Synthetic Session 1", { exact: true })).toBeVisible();
  await page.keyboard.press("Shift+Comma");
  await expect(page.getByRole("alert").filter({ hasText: "Settings Couldn't Be Shown" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload Page", exact: true })).toBeVisible();
  if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/settings-offline-error.png` });
  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await expect(page.getByRole("grid", { name: "Sessions", exact: true }).getByText("Synthetic Session 1", { exact: true })).toBeVisible();
  const worker = await page.request.get("/sw.js");
  expect(worker.ok()).toBe(true);
  expect(await worker.text()).not.toMatch(/addEventListener\(["']fetch["']/);
});

test("desktop session loads xterm on demand and restores shell output after the chunk arrives @production", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installInboxFixture(page);
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  await page.route("**/assets/ShellDock-*.js", async (route) => { await pending; await route.continue(); });
  await page.goto(`/sessions/~${encodeResourceId("synthetic-1")}`);
  await expect(page.locator(".composer-input")).toBeVisible();
  await expect(page.getByText("Start the Conversation", { exact: true })).toBeVisible();
  await page.keyboard.press("Control+Backquote");
  await expect(page.getByRole("status").filter({ hasText: "Loading terminal…" })).toBeVisible();
  release();
  await expect(page.locator(".xterm-screen")).toBeVisible();
  await expect(page.locator(".xterm-rows")).toContainText("Synthetic terminal output");
  if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/terminal-ready-1440.png` });
  await page.getByRole("button", { name: "Detach Terminal Panel; Shells Keep Running", exact: true }).click();
  await expect(page.locator(".xterm-screen")).toBeHidden();
});
