import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const THREAD = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const SETTINGS = "/settings/assistant";
const OLD_SETTINGS = "/settings/behavior/assistant-threads";
const EVIDENCE = process.env.ASSISTANT_LIMITS_EVIDENCE_DIR;

async function open(page: Page, path: string, theme: "dark" | "light" = "dark", state = "enabled") {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/assistants-e2e.html?limits=${state}&accounts=stress&path=${encodeURIComponent(path)}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function editThread(page: Page) {
  await page.getByRole("button", { name: "Thread Settings", exact: true }).click();
  return page.getByRole("dialog", { name: "Thread Settings", exact: true });
}

async function editDefaults(page: Page) {
  const group = page.getByRole("region", { name: "Thread Defaults" });
  await group.getByRole("button", { name: /Edit Limits/ }).click();
  return page.getByRole("dialog", { name: "Default Thread Limits" });
}

test("the owner edits future defaults from Settings and an existing thread from its header", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, SETTINGS);
  const defaults = await editDefaults(page);
  await defaults.getByRole("textbox", { name: "Cost Budget (USD)" }).fill("40");
  await defaults.getByRole("textbox", { name: "Session Launch Limit" }).fill("4");
  await defaults.getByRole("button", { name: "Save Limits" }).click();
  await expect(defaults).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Thread Defaults" })).toContainText("$40.00 budget · 4 session launches");

  await page.getByRole("link", { name: "Assistants", exact: true }).click();
  await page.getByRole("button", { name: "New Thread", exact: true }).first().click();
  await page.getByRole("dialog", { name: "New Thread" }).getByRole("button", { name: "Start Thread" }).click();
  await expect(page.getByLabel("Thread Details")).toContainText("$0.00 of $40.00 spent");
  await page.getByText("Triage Open Issues", { exact: true }).click();
  await expect(page.getByLabel("Thread Details")).toContainText("$8.13 of $25.00 spent");

  const limits = await editThread(page);
  await limits.getByRole("button", { name: /^Change Account…/ }).click();
  await limits.getByRole("radio", { name: "Studio Subscription", exact: true }).check();
  await limits.getByRole("button", { name: "Change Account", exact: true }).click();
  await expect(limits).toContainText("Studio Subscription");
  await limits.getByRole("textbox", { name: "Cost Budget (USD)" }).fill("12");
  await limits.getByRole("button", { name: "Save Limits" }).click();
  await expect(limits.getByRole("alert")).toContainText("already spent or committed $15.00");
  await limits.getByRole("group", { name: "Cost Budget" }).getByRole("checkbox", { name: "No Limit" }).check();
  await limits.getByRole("textbox", { name: "Session Launch Limit" }).fill("0");
  await limits.getByRole("button", { name: "Save Limits" }).click();
  await expect(limits).toContainText("2 launched.");
  await limits.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByLabel("Thread Details")).toContainText("$8.13 spent · No Budget");
  await expect(page.getByLabel("Thread Details")).toContainText("2 launched · Launches Paused");
});

test("a new thread uses the saved harness, provider account and both unlimited defaults", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, SETTINGS);
  await page.getByRole("button", { name: /Edit Harness and Account/ }).click();
  const launch = page.getByRole("dialog", { name: "Default Harness and Account" });
  await launch.getByRole("radio", { name: "Codex", exact: true }).check();
  await launch.getByRole("radio", { name: "Codex Studio", exact: true }).check();
  await launch.getByRole("button", { name: "Save Defaults" }).click();
  const limits = await editDefaults(page);
  await limits.getByRole("checkbox", { name: "No Limit" }).first().check();
  await limits.getByRole("checkbox", { name: "No Limit" }).last().check();
  await limits.getByRole("button", { name: "Save Limits" }).click();
  await expect(page.getByRole("region", { name: "Thread Defaults" })).toContainText("No Budget · No Launch Limit");
  await page.getByRole("button", { name: /^Existing Threads/ }).click();
  await page.getByRole("button", { name: "New Thread" }).first().click();
  const newThread = page.getByRole("dialog", { name: "New Thread" });
  await expect(newThread.getByRole("radio", { name: /^Codex$/, exact: true })).toBeChecked();
  await expect(newThread.getByRole("radio", { name: "Codex Studio", exact: true })).toBeChecked();
  await newThread.getByRole("button", { name: "Start Thread" }).click();
  await expect(page.getByLabel("Thread Details")).toContainText("No Budget");
  await expect(page.getByLabel("Thread Details")).toContainText("No Launch Limit");
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
      await expectFullyInViewport(page.getByRole("button", { name: "Thread Settings", exact: true }), "The Thread Settings header action");
      await expectFullyInViewport(page.locator(".composer"), "The thread composer");
      await expectPageNoHorizontalOverflow(page);
      await capture(page, "thread-header");

      const limits = await editThread(page);
      await expect(limits).toContainText("This thread's conversation belongs to this harness.");
      await expect(limits.getByRole("button", { name: /^New Thread/ })).toBeVisible();
      await expect(limits.getByRole("button", { name: /^Change Account/ })).toBeEnabled();
      await expectFullyInViewport(limits.getByRole("button", { name: "Save Limits" }), "Save Thread Limits");
      await capture(page, "thread-settings");
      await limits.getByRole("textbox", { name: "Cost Budget (USD)" }).fill("12");
      await limits.getByRole("button", { name: "Save Limits" }).click();
      const refusal = limits.getByRole("alert");
      await expect(refusal).toHaveText("The thread has already spent or committed $15.00. Choose a budget at least that high.");
      await expectFullyInViewport(refusal, "The budget refusal");
      await expectFullyInViewport(limits.getByRole("button", { name: "Save Limits" }), "Save Thread Limits");
      await expectPageNoHorizontalOverflow(page);
      if (layout === "desktop" && theme === "dark") await capture(page, "thread-edit-refusal");

      await limits.getByRole("textbox", { name: "Cost Budget (USD)" }).fill("25");
      await limits.getByRole("textbox", { name: "Session Launch Limit" }).fill("0");
      await limits.getByRole("button", { name: "Save Limits" }).click();
      await expect(limits.getByRole("alert")).toHaveCount(0);
      await limits.getByRole("button", { name: "Done", exact: true }).click();
      await expect(details).toContainText("2 launched · Launches Paused");
      await expectFullyInViewport(page.locator(".composer"), "The thread composer");
    });

    test(`Assistant settings and long names stay usable on ${layout} in ${theme}`, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2025-11-19T18:00:00Z"));
      await page.setViewportSize({ width, height });
      await open(page, THREAD, theme, "stress");
      await expect(page.getByLabel("Thread Details")).toContainText("40 launched · No Launch Limit");
      await expectFullyInViewport(page.locator(".composer"), "The thread composer");
      await expectPageNoHorizontalOverflow(page);
      const thread = await editThread(page);
      await expectFullyInViewport(thread.getByRole("button", { name: "Save Limits" }), "Save Thread Limits");
      await expect(thread).toContainText("DesignResearchAndEngineeringSubscription");
      await expectNoHorizontalOverflow(thread, "Thread Settings");
      await expectPageNoHorizontalOverflow(page);
      if (theme === "dark") await capture(page, "thread-settings-long-account");

      await open(page, OLD_SETTINGS, theme, "stress");
      expect(new URL(page.url()).searchParams.get("path")).toBe(SETTINGS);
      const group = page.getByRole("region", { name: "Thread Defaults" });
      const action = group.getByRole("button", { name: /Edit Limits/ });
      await action.scrollIntoViewIfNeeded();
      await expectFullyInViewport(action, "Edit Default Thread Limits");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expectPageNoHorizontalOverflow(page);
      await capture(page, "assistant-settings");
      if (layout === "desktop" && theme === "light") await capture(page, "redirected-assistant-settings");
      const defaults = await editDefaults(page);
      await expect(defaults.getByRole("checkbox", { name: "No Limit" })).toHaveCount(2);
      await expectFullyInViewport(defaults.getByRole("button", { name: "Save Limits" }), "Save Default Thread Limits");
      if (layout === "phone" && theme === "light") await capture(page, "default-no-limit-choices");
      await defaults.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: /Manage Assistant Connections/ }).click();
      const connections = page.getByRole("dialog", { name: "Assistant Connections" });
      await expect(connections.getByRole("region", { name: "Your Connections" }).getByRole("button")).toHaveCount(10);
      await expectFullyInViewport(connections.getByRole("button", { name: "Done", exact: true }), "Done with Assistant Connections");
      await expectNoHorizontalOverflow(connections, "Assistant Connections");
      await expectPageNoHorizontalOverflow(page);
      if (theme === "dark") await capture(page, "assistant-connections-stress");
    });

    test(`budget warnings and editors link to one another on ${layout} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, THREAD, theme, "budget");
      const warning = page.getByRole("status").filter({ hasText: "whole $25 budget" });
      await expect(warning.getByRole("link", { name: "Assistant Defaults" })).toHaveAttribute("href", SETTINGS);
      if (theme === "dark") await capture(page, "thread-limit-warning");
      await warning.getByRole("link", { name: "Thread Settings", exact: true }).click();
      const thread = page.getByRole("dialog", { name: "Thread Settings", exact: true });
      await expect(thread.getByRole("textbox", { name: "Cost Budget (USD)" })).toHaveValue("25");
      if (theme === "dark") await capture(page, "one-click-remove-budget");
      await thread.getByRole("link", { name: "Session Guardrails" }).click();
      const guardrails = page.getByRole("dialog", { name: "Guardrails", exact: true });
      const budget = guardrails.getByRole("textbox", { name: "Assistant Thread Cost Budget" });
      await expect(budget).toHaveValue("25"); // The fixture's derived runtime cap is $15.
      if (theme === "dark") await capture(page, "backing-session-guardrails");
      await budget.fill("20");
      await guardrails.getByRole("button", { name: "Save Guardrails" }).click();
      await expect(guardrails.getByRole("alert")).toContainText("already spent or committed $25.00");
      if (theme === "dark") await capture(page, "guardrails-edit-refusal");
      await budget.fill("250");
      await guardrails.getByRole("button", { name: "Save Guardrails" }).click();
      await expect(guardrails).toHaveCount(0);
      await page.goBack();
      await expect(thread.getByRole("textbox", { name: "Cost Budget (USD)" })).toHaveValue("250");
      await thread.getByRole("group", { name: "Cost Budget" }).getByRole("checkbox", { name: "No Limit" }).check();
      await thread.getByRole("button", { name: "Save Limits" }).click();
      await expect(thread.getByRole("textbox", { name: "Cost Budget (USD)" })).toBeDisabled();
      await thread.getByRole("link", { name: "Session Guardrails" }).click();
      await expect(guardrails.getByRole("textbox", { name: "Assistant Thread Cost Budget" })).toHaveValue("");
      await guardrails.getByRole("link", { name: "Thread Settings", exact: true }).click();
      await expect(thread.getByRole("textbox", { name: "Cost Budget (USD)" })).toHaveAttribute("placeholder", "No Limit");
      if (theme === "dark") await capture(page, "thread-settings-no-limit");
    });

    test(`a $25 thread's cost limit can be removed in one action on ${layout} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, `${THREAD}/settings`, theme, "budget");
      const thread = page.getByRole("dialog", { name: "Thread Settings" });
      const remove = thread.getByRole("button", { name: "Remove Cost Limit" });
      await remove.scrollIntoViewIfNeeded();
      if (layout === "desktop" && theme === "light") await capture(page, "remove-legacy-cost-limit");
      await remove.click();
      await expect(remove).toHaveCount(0);
      await expect(thread.getByRole("group", { name: "Cost Budget" }).getByRole("checkbox", { name: "No Limit" })).toBeChecked();
      await thread.getByRole("button", { name: "Done", exact: true }).click();
      await expect(page.getByLabel("Thread Details")).toContainText("$8.13 spent · No Budget");
    });

    test(`fixed budgets remain readable on ${layout} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, THREAD, theme, "old");
      const thread = await editThread(page);
      await expect(thread.getByRole("textbox", { name: "Cost Budget (USD)" })).toHaveValue("25");
      await expect(thread.getByText(/uses fixed thread limits/)).toBeVisible();
      await expect(thread.getByRole("button", { name: "Save Limits" })).toBeDisabled();
      if (theme === "dark") await capture(page, "thread-settings-read-only");
    });

    test(`Behavior stays separate on ${layout} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, "/settings/behavior", theme);
      await expect(page.getByRole("region", { name: "Input" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Thread Defaults" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Assistant Connections" })).toHaveCount(0);
      if (layout === "desktop" && theme === "dark") await capture(page, "behavior-without-assistant-settings");
    });
  }
}
