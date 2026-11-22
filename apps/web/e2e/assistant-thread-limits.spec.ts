import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const THREAD = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const SETTINGS = "/settings/assistant";
const OLD_SETTINGS = "/settings/behavior/assistant-threads";
const EVIDENCE = process.env.ASSISTANT_LIMITS_EVIDENCE_DIR;

async function openDetails(page: Page) {
  const panel = page.locator("#right-panel");
  if (!(await panel.isVisible())) await page.getByRole("button", { name: /Side Panel/ }).click();
  await panel.getByRole("tab", { name: "Details", exact: true }).click();
  return panel.getByRole("tabpanel", { name: "Details", exact: true });
}

async function closeDetails(page: Page) {
  await page.locator("#right-panel").getByRole("button", { name: "Close Panel" }).click();
}

async function open(page: Page, path: string, theme: "dark" | "light" = "dark", state = "enabled", delegation = "", evidence = "") {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/assistants-e2e.html?limits=${state}&accounts=stress&delegation=${delegation}&evidence=${evidence}&path=${encodeURIComponent(path)}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function editThread(page: Page) {
  // Thread Settings is in Thread Actions (⋯), as the session bar keeps its settings (#4776).
  await page.getByRole("button", { name: "Thread Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Thread Settings", exact: true }).click();
  return page.getByRole("dialog", { name: "Thread Settings", exact: true });
}

async function editDefault(page: Page, name: string) {
  const group = page.getByRole("region", { name: "Thread Defaults" });
  await group.getByRole("button", { name: new RegExp(name + "$") }).click();
  return page.getByRole("dialog", { name, exact: true });
}

test("the owner edits future defaults from Settings and an existing thread from its header", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, SETTINGS);
  const budget = await editDefault(page, "Budget per Thread");
  await budget.getByRole("radio", { name: "Custom…" }).click();
  await budget.getByRole("textbox", { name: "Custom Budget (USD)" }).fill("40");
  await budget.getByRole("button", { name: "Save Default" }).click();
  const launches = await editDefault(page, "Session Launches per Thread");
  await launches.getByRole("textbox", { name: "Session Launch Limit" }).fill("4");
  await launches.getByRole("button", { name: "Save Default" }).click();
  await expect(launches).toHaveCount(0);
  const defaults = page.getByRole("region", { name: "Thread Defaults" });
  await expect(defaults.getByRole("button", { name: "$40.00 Budget per Thread" })).toBeVisible();
  await expect(defaults.getByRole("button", { name: "4 Session Launches per Thread" })).toBeVisible();

  await page.getByRole("link", { name: "Assistants", exact: true }).click();
  await page.getByRole("button", { name: "New Thread", exact: true }).first().click();
  await page.getByRole("dialog", { name: "New Thread" }).getByRole("button", { name: "Start Thread" }).click();
  await expect(await openDetails(page)).toContainText("$0.00 of $40.00 spent");
  await closeDetails(page);
  await page.getByText("Triage Open Issues", { exact: true }).click();
  await expect(await openDetails(page)).toContainText("$8.13 of $25.00 spent");
  await closeDetails(page);

  const limits = await editThread(page);
  await limits.getByRole("button", { name: "Change… Account" }).click();
  const picker = page.getByRole("dialog", { name: "Change Account" });
  await picker.getByRole("radio", { name: "Studio Subscription", exact: true }).check();
  await picker.getByRole("button", { name: "Use Account", exact: true }).click();
  await expect(limits).toContainText("Studio Subscription");
  await expect(page.locator("body")).not.toHaveAttribute("data-changed-account", /.+/);
  await limits.getByRole("radio", { name: "Custom…" }).click();
  await limits.getByRole("textbox", { name: "Custom Budget (USD)" }).fill("12");
  await limits.getByRole("button", { name: "Save Changes" }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm Conversation Change" });
  await confirmation.getByRole("button", { name: "Confirm and Save" }).click();
  await expect(confirmation.getByRole("alert")).toContainText("already spent or committed $15.00");
  await expect(page.locator("body")).not.toHaveAttribute("data-changed-account", /.+/);
  await confirmation.getByRole("button", { name: "Keep Editing", exact: true }).click();
  await limits.getByRole("radiogroup", { name: "Budget Presets" }).getByRole("radio", { name: "No Limit" }).click();
  await limits.getByRole("switch", { name: "Pause New Launches" }).click();
  await limits.getByRole("button", { name: "Save Changes" }).click();
  await confirmation.getByRole("button", { name: "Confirm and Save" }).click();
  await expect(limits).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-changed-account", /acct:/);
  await expect(await openDetails(page)).toContainText("$8.13 spent · No Budget");
  await expect(await openDetails(page)).toContainText("2 launched · Launches Paused");
});

test("a new thread uses the saved harness, provider account and both unlimited defaults", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, SETTINGS);
  const harness = await editDefault(page, "Harness");
  await harness.getByRole("radio", { name: "Codex", exact: true }).check();
  await harness.getByRole("button", { name: "Save Default" }).click();
  const account = await editDefault(page, "Account");
  await account.getByRole("radio", { name: "Codex Studio", exact: true }).check();
  await account.getByRole("button", { name: "Save Default" }).click();
  const budget = await editDefault(page, "Budget per Thread");
  await budget.getByRole("radio", { name: "No Limit" }).click();
  await budget.getByRole("button", { name: "Save Default" }).click();
  const launches = await editDefault(page, "Session Launches per Thread");
  await launches.getByRole("checkbox", { name: "No Limit" }).check();
  await launches.getByRole("button", { name: "Save Default" }).click();
  await expect(launches).toHaveCount(0);
  const defaults = page.getByRole("region", { name: "Thread Defaults" });
  await expect(defaults.getByRole("button", { name: /^No Limit/ })).toHaveCount(2);
  await expect(defaults.getByText("Existing Threads", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Assistants", exact: true }).click();
  await page.getByRole("button", { name: "New Thread" }).first().click();
  const newThread = page.getByRole("dialog", { name: "New Thread" });
  await expect(newThread.getByRole("radio", { name: /^Codex$/, exact: true })).toBeChecked();
  await expect(newThread.getByRole("radio", { name: "Codex Studio", exact: true })).toBeChecked();
  await newThread.getByRole("button", { name: "Start Thread" }).click();
  await expect(await openDetails(page)).toContainText("No Budget");
  await expect(await openDetails(page)).toContainText("No Launch Limit");
});

for (const [layout, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
  for (const theme of ["light", "dark"] as const) {
    const capture = async (page: Page, view: string) => {
      if (!EVIDENCE) return;
      mkdirSync(EVIDENCE, { recursive: true });
      await page.screenshot({ path: join(EVIDENCE, `${view}-${layout}-${theme}.png`), animations: "disabled" });
    };

    test(`the thread's launch usage and header controls remain reachable on ${layout} in ${theme}`, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2025-11-19T18:00:00Z"));
      await page.setViewportSize({ width, height });
      await open(page, THREAD, theme);
      const details = await openDetails(page);
      await expect(details).toContainText("2 of 10 sessions launched");
      await closeDetails(page);
      await expectFullyInViewport(page.getByRole("button", { name: "Thread Actions", exact: true }), "Thread Actions, which holds Thread Settings");
      await expectFullyInViewport(page.locator(".composer"), "The thread composer");
      await expectPageNoHorizontalOverflow(page);
      await capture(page, "thread-header");
      if (layout === "phone") {
        const title = page.getByRole("heading", { name: "Triage Open Issues", exact: true });
        await expect.poll(() => title.evaluate((heading) => heading.clientWidth), {
          message: "The phone thread title keeps room for the short name beside its actions",
        }).toBeGreaterThanOrEqual(145);
        await expect(page.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);
        await page.getByRole("button", { name: "Thread Actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Search", exact: true }).click();
        const search = page.getByRole("dialog", { name: "Search", exact: true });
        await expect(search).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(search).toHaveCount(0);
      }
    });

    test(`Assistant settings and long names stay usable on ${layout} in ${theme}`, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2025-11-19T18:00:00Z"));
      await page.setViewportSize({ width, height });
      await open(page, THREAD, theme, "stress");
      await expect(await openDetails(page)).toContainText("40 launched · No Launch Limit");
      await closeDetails(page);
      await expectFullyInViewport(page.locator(".composer"), "The thread composer");
      await expectPageNoHorizontalOverflow(page);
      await open(page, OLD_SETTINGS, theme, "stress");
      expect(new URL(page.url()).searchParams.get("path")).toBe(SETTINGS);
      const group = page.getByRole("region", { name: "Thread Defaults" });
      const action = group.getByRole("button", { name: /Budget per Thread/ });
      await action.scrollIntoViewIfNeeded();
      await expectFullyInViewport(action, "Edit Default Thread Limits");
      await expect(page.getByRole("region", { name: "Active Delegations" })).toContainText("No Delegation Grants");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expectPageNoHorizontalOverflow(page);
      await capture(page, "assistant-settings");
      if (layout === "desktop" && theme === "light") await capture(page, "redirected-assistant-settings");
      const defaults = await editDefault(page, "Budget per Thread");
      await expect(defaults.getByRole("radio", { name: "No Limit" })).toBeVisible();
      await expectFullyInViewport(defaults.getByRole("button", { name: "Save Default" }), "Save Default Thread Limits");
      if (layout === "phone" && theme === "light") await capture(page, "default-no-limit-choices");
      await defaults.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: /^All Connections/ }).click();
      await expect(page.getByRole("heading", { name: "Assistant Connections", exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get("path")).toBe("/settings/assistant/connections");
      const connections = page.getByRole("region", { name: "Connections", exact: true });
      const rows = connections.getByRole("button");
      await expect(rows).toHaveCount(9);
      if (layout === "phone") {
        const title = rows.first().locator(".setting-row-title");
        await expect(title).toHaveCSS("-webkit-line-clamp", "2");
        expect(await title.evaluate(element => {
          const line = Number.parseFloat(getComputedStyle(element).lineHeight);
          return element.clientHeight === Math.round(line * 2) && element.scrollHeight > element.clientHeight;
        })).toBe(true);
      }
      const create = page.getByRole("button", { name: "New Connection", exact: true });
      await expectFullyInViewport(create, "New Connection");
      await expectNoHorizontalOverflow(connections, "Assistant Connections");
      await expectPageNoHorizontalOverflow(page);
      if (theme === "dark") await capture(page, "assistant-connections-stress");
      await rows.last().scrollIntoViewIfNeeded();
      await expectFullyInViewport(rows.last(), "The final connection");
      await expectFullyInViewport(create, "New Connection after scrolling");

      if (layout === "phone") {
        await open(page, "/settings", theme);
        const index = page.getByRole("navigation", { name: "Settings Sections" });
        const assistant = index.getByRole("link", { name: /^Assistant\b/ });
        await expect(assistant).toContainText("Thread defaults and connections.");
        await assistant.scrollIntoViewIfNeeded();
        await expectFullyInViewport(assistant, "The Assistant settings row");
        await capture(page, "assistant-settings-index");
        await assistant.click();
        await expect(page.getByRole("region", { name: "Thread Defaults" })).toBeVisible();
      }
    });

    test(`Thread Settings opens the shared delegation editor on ${layout} in ${theme}`, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2025-11-19T18:00:00Z"));
      await page.setViewportSize({ width, height });
      const editor = page.getByRole("dialog", { name: "Decision Delegation" });
      const approval = editor.getByRole("checkbox", { name: "Approve UI Evidence", exact: true });
      const checkedCategories = editor.locator(".delegation-category").getByRole("checkbox", { checked: true });
      await open(page, THREAD, theme, "enabled", "many", "available");
      const threadSettings = await editThread(page);
      const manage = threadSettings.getByRole("button", { name: "Manage… Decision Delegation" });
      await manage.scrollIntoViewIfNeeded();
      await expectFullyInViewport(manage, "Manage Decision Delegation in Thread Settings");
      await manage.click();
      await expect(editor.getByRole("checkbox", { name: "Answer Owner Questions" })).toBeChecked();
      await expect(editor.getByRole("checkbox", { name: "Merge Pull Requests" })).toBeChecked();
      await expect(checkedCategories).toHaveCount(2);
      await expect(approval).not.toBeChecked();
      await approval.check();
      await expect(approval).toHaveAccessibleDescription(/Claude Code.*claude-opus-5-5.*provider may retain/);
      await expectNoHorizontalOverflow(editor, "Decision Delegation opened from Thread Settings");
      await expectFullyInViewport(editor.getByRole("button", { name: "Use Delegation Settings" }), "Save the selected approval grant");
      await capture(page, "thread-delegation-editor");
    });

    test(`budget warnings and editors link to one another on ${layout} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, THREAD, theme, "budget");
      const warning = page.getByRole("status").filter({ hasText: "whole $25 budget" });
      await expect(warning.getByRole("link", { name: "Assistant Defaults" })).toHaveAttribute("href", SETTINGS);
      if (theme === "dark") await capture(page, "thread-limit-warning");
      await warning.getByRole("link", { name: "Thread Settings", exact: true }).click();
      const thread = page.getByRole("dialog", { name: "Thread Settings", exact: true });
      await expect(thread.getByRole("radio", { name: "$25", exact: true })).toBeChecked();
      await expect(thread.getByRole("link", { name: "Session Guardrails" })).toHaveCount(0);
      await expect(thread.getByRole("link", { name: "Settings › Assistant" })).toHaveAttribute("href", SETTINGS);
      await open(page, "/sessions/~cwBlAHMAcwAtAHQAcgBpAGEAZwBlAA/guardrails", theme, "budget");
      const guardrails = page.getByRole("dialog", { name: "Guardrails", exact: true });
      const budget = guardrails.getByRole("textbox", { name: "Assistant Thread Cost Budget" });
      await expect(budget).toHaveValue("25"); // The fixture's derived runtime cap is $15.
      await budget.fill("20");
      await guardrails.getByRole("button", { name: "Save Guardrails" }).click();
      await expect(guardrails.getByRole("alert")).toContainText("already spent or committed $25.00");
      await budget.fill("250");
      await guardrails.getByRole("button", { name: "Save Guardrails" }).click();
      await expect(guardrails).toHaveCount(0);

    });

    test(`Behavior stays separate on ${layout} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, "/settings/behavior", theme);
      await expect(page.getByRole("region", { name: "Input" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Assistant Threads" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Thread Defaults" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Assistant Connections" })).toHaveCount(0);
      if (layout === "desktop" && theme === "dark" && EVIDENCE) {
        const body = page.locator(".main-body");
        const overflow = await body.evaluate((node) => node.scrollHeight - node.clientHeight);
        await page.setViewportSize({ width, height: height + overflow + 8 });
        await expectFullyInViewport(page.getByText("About Artifact Uploads", { exact: true }), "The last row in Behavior");
        await capture(page, "behavior-without-assistant-settings");
      }
    });
  }
}
