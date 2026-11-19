import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectFullyInViewport, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const THREAD = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const SETTINGS = "/settings/behavior";
const EVIDENCE = process.env.ASSISTANT_LIMITS_EVIDENCE_DIR;

async function open(page: Page, path: string, theme: "dark" | "light" = "dark", state = "enabled") {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/assistants-e2e.html?limits=${state}&path=${encodeURIComponent(path)}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function editThread(page: Page) {
  await page.getByRole("button", { name: "Thread Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Thread Limits" }).click();
  return page.getByRole("dialog", { name: "Thread Limits", exact: true });
}

async function editDefaults(page: Page) {
  const group = page.getByRole("region", { name: "Assistant Threads" });
  await group.getByRole("button", { name: /Edit Limits/ }).click();
  return page.getByRole("dialog", { name: "Default Thread Limits" });
}

test("the owner edits future defaults from Settings and an existing thread from Thread Actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, SETTINGS);
  const defaults = await editDefaults(page);
  await defaults.getByRole("textbox", { name: "Cost Budget (USD)" }).fill("40");
  await defaults.getByRole("textbox", { name: "Session Launch Limit" }).fill("4");
  await defaults.getByRole("button", { name: "Save Limits" }).click();
  await expect(defaults).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Assistant Threads" })).toContainText("$40.00 budget · 4 session launches");

  await page.getByRole("link", { name: "Assistants", exact: true }).click();
  await page.getByRole("button", { name: "New Thread", exact: true }).first().click();
  await page.getByRole("dialog", { name: "New Thread" }).getByRole("button", { name: "Start Thread" }).click();
  await expect(page.getByLabel("Thread Details")).toContainText("$0.00 of $40.00 spent");
  await page.getByText("Triage Open Issues", { exact: true }).click();
  await expect(page.getByLabel("Thread Details")).toContainText("$8.13 of $25.00 spent");

  const limits = await editThread(page);
  await limits.getByRole("textbox", { name: "Cost Budget (USD)" }).fill("12");
  await limits.getByRole("button", { name: "Save Limits" }).click();
  await expect(limits.getByRole("alert")).toContainText("already spent or committed $15.00");
  await limits.getByRole("textbox", { name: "Cost Budget (USD)" }).fill("");
  await limits.getByRole("textbox", { name: "Session Launch Limit" }).fill("0");
  await limits.getByRole("button", { name: "Save Limits" }).click();
  await expect(limits).toHaveCount(0);
  await expect(page.getByLabel("Thread Details")).toContainText("$8.13 spent · No Budget");
  await expect(page.getByLabel("Thread Details")).toContainText("2 launched · Launches Paused");
});

test("an older control plane shows its fixed limits without offering edits", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, THREAD, "dark", "old");
  await expect(page.getByLabel("Thread Details")).toContainText("$8.13 of $25.00 spent");
  await page.getByRole("button", { name: "Thread Actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Thread Limits" })).toHaveCount(0);
});

for (const [layout, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
  for (const theme of ["light", "dark"] as const) {
    const capture = async (page: Page, view: string) => {
      if (!EVIDENCE) return;
      mkdirSync(EVIDENCE, { recursive: true });
      await page.screenshot({ path: join(EVIDENCE, `${view}-${layout}-${theme}.png`), animations: "disabled" });
    };

    test(`a finite limit, a budget refusal, and the paused state are readable on ${layout} in ${theme}`, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2025-11-19T18:00:00Z"));
      await page.setViewportSize({ width, height });
      await open(page, THREAD, theme);
      const details = page.getByLabel("Thread Details");
      await expect(details).toContainText("2 of 10 sessions launched");
      await expectFullyInViewport(page.locator(".composer"), "The thread composer");
      await expectPageNoHorizontalOverflow(page);
      await capture(page, "thread-finite-launch-limit");

      const limits = await editThread(page);
      await limits.getByRole("textbox", { name: "Cost Budget (USD)" }).fill("12");
      await limits.getByRole("button", { name: "Save Limits" }).click();
      const refusal = limits.getByRole("alert");
      await expect(refusal).toHaveText("The thread has already spent or committed $15.00. Choose a budget at least that high.");
      await expectFullyInViewport(refusal, "The budget refusal");
      await expectFullyInViewport(limits.getByRole("button", { name: "Save Limits" }), "Save Thread Limits");
      await expectPageNoHorizontalOverflow(page);
      await capture(page, "thread-budget-refusal");

      await limits.getByRole("textbox", { name: "Cost Budget (USD)" }).fill("25");
      await limits.getByRole("textbox", { name: "Session Launch Limit" }).fill("0");
      await limits.getByRole("button", { name: "Save Limits" }).click();
      await expect(limits).toHaveCount(0);
      await expect(details).toContainText("2 launched · Launches Paused");
      await expectFullyInViewport(page.locator(".composer"), "The thread composer");
      await capture(page, "thread-launches-paused");
    });

    test(`limits stay usable with long titles and many launches on ${layout} in ${theme}`, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2025-11-19T18:00:00Z"));
      await page.setViewportSize({ width, height });
      await open(page, THREAD, theme, "stress");
      await expect(page.getByLabel("Thread Details")).toContainText("40 launched · No Launch Limit");
      await expectFullyInViewport(page.locator(".composer"), "The thread composer");
      await expectPageNoHorizontalOverflow(page);
      await capture(page, "thread-usage");
      const thread = await editThread(page);
      await expectFullyInViewport(thread.getByRole("button", { name: "Save Limits" }), "Save Thread Limits");
      await capture(page, "thread-limits-edit");

      await open(page, SETTINGS, theme);
      const group = page.getByRole("region", { name: "Assistant Threads" });
      const action = group.getByRole("button", { name: /Edit Limits/ });
      await action.scrollIntoViewIfNeeded();
      await expectFullyInViewport(action, "Edit Default Thread Limits");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expectPageNoHorizontalOverflow(page);
      await capture(page, "settings-behavior");
      const defaults = await editDefaults(page);
      await expectFullyInViewport(defaults.getByRole("button", { name: "Save Limits" }), "Save Default Thread Limits");
      await capture(page, "default-limits-edit");
    });
  }
}
