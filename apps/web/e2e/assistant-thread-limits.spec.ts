import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectTextContrast, expectTouchTargets } from "./layout-invariants.js";

const THREAD = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const SETTINGS = "/settings/assistant";
const OLD_SETTINGS = "/settings/behavior/assistant-threads";
const EVIDENCE = process.env.ASSISTANT_LIMITS_EVIDENCE_DIR;

const SPENDING_CASES = [
  { scenario: "near", title: "Near Budget", badge: "Near Budget", state: "86percent",
    copy: "$21.40 of $25.00 used. At $25.00 the assistant can't launch more sessions.", meter: "$21.40 of $25.00 spent" },
  { scenario: "used-up", title: "Budget Used Up", badge: "Budget Used Up", state: "100percent",
    copy: "This thread has spent its $25.00 budget, so the assistant can't launch more sessions. It can still answer you.", meter: "$25.00 of $25.00 spent" },
  { scenario: "over", title: "Over Budget by $54.93", badge: "Over Budget", state: "320percent",
    copy: "Sessions this thread launched kept running after its $25.00 budget ran out, and their cost counts toward it. The assistant can't launch more until you raise the budget.", meter: "$79.93 of $25.00 spent" },
  { scenario: "launch-limit", title: "Launch Limit Reached", badge: "Launch Limit Reached", state: "10of10",
    copy: "10 of 10 session launches used. The assistant can't start more.", meter: "10 of 10 session launches used" },
] as const;

const spendingNotice = (page: Page) => page.locator(".composer .session-notice-slot .assistant-spending-notice");
const threadRow = (page: Page, id = "thr_triage") => page.locator('[data-thread-id="' + id + '"]');
const threadBar = (page: Page) => page.locator(".assistant-thread-bar, .page > .detail-bar");

async function openSpending(page: Page, scenario: string, path = THREAD) {
  await page.clock.setFixedTime(Date.UTC(2026, 10, 20, 17));
  await page.goto("/assistants-e2e.html?limits=budget&launched=many&accounts=stress&spending=" + scenario +
    "&path=" + encodeURIComponent(path));
}

async function captureSpending(page: Page, surface: string, theme: string, state: string) {
  if (process.env.ASSISTANT_SPENDING_EVIDENCE !== "1") return;
  const { width, height } = page.viewportSize()!;
  const name = ["4810", surface, width + "x" + height, theme, state].join("-");
  await page.screenshot({ path: join("playwright-report", "4810", name + ".png"), animations: "disabled" });
}

for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const phone = width === 390;
    test.describe("spending on " + width + "px in " + theme, () => {
      test.use({ viewport: { width, height }, hasTouch: phone, isMobile: phone, colorScheme: theme, locale: "en-US", timezoneId: "UTC" });
      for (const { scenario, title, badge, state, copy, meter } of SPENDING_CASES) {
        test("shows " + badge + " above the composer with matching badges", async ({ page }) => {
          await openSpending(page, scenario);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          const notice = spendingNotice(page);
          await expect(notice).toHaveRole("status");
          await expect(notice.locator(".notice-title")).toHaveText(title);
          await expect(notice.getByText(copy, { exact: true })).toBeVisible();
          await expect(notice.getByRole("meter")).toHaveAttribute("aria-valuetext", meter);
          await expect(page.getByText("Thread Limit Reached", { exact: true })).toHaveCount(0);
          const composerBox = page.locator(".composer-box");
          await expect(composerBox).not.toHaveClass(/is-disabled/);
          await expectFullyInViewport(page.locator(".composer"), "The composer and its spending notice");
          await expectFullyInViewport(composerBox, "The composer input");
          await expect(page.getByText("Last night's CI had two failures.")).toBeVisible();
          expect((await notice.boundingBox())!.y + (await notice.boundingBox())!.height).toBeLessThanOrEqual((await composerBox.boundingBox())!.y);
          await expectPageNoHorizontalOverflow(page);
          await expectNoHorizontalOverflow(notice);
          await expectTextContrast(notice);

          await expect(threadBar(page).locator(".status")).toHaveText(badge);
          await expectTextContrast(threadBar(page).locator(".status"));
          await expectFullyInViewport(threadBar(page).locator(".status"), "The spending badge");
          await expect(threadBar(page).locator(".detail-bar-title")).toHaveCSS("text-overflow", "ellipsis");
          expect((await threadBar(page).boundingBox())!.height).toBe(48);
          expect((await threadBar(page).getByRole("heading").textContent())!.length).toBe(120);
          const raise = notice.getByRole("button", { name: scenario === "launch-limit" ? "Raise Limit…" : "Raise Budget…" });
          for (const button of await notice.getByRole("button").all()) {
            await expectFullyInViewport(button, "A notice action");
            if (!phone) expect((await button.boundingBox())!.height).toBe(28);
          }
          if (phone) await expectTouchTargets(notice);
          if (scenario === "over") {
            await expect(notice.locator(".assistant-spending-overflow")).toHaveCSS("background-image", /repeating-linear-gradient/);
          } else {
            await expect(notice.locator(".assistant-spending-overflow")).toHaveCount(0);
          }
          if (!phone) {
            await expect(threadRow(page).locator(".status")).toHaveText(badge);
            await expectTextContrast(threadRow(page).locator(".status"));
          }
          await captureSpending(page, phone ? "notice-title-bar" : "notice-and-badges", theme,
            state + "-bar48csspx" + (phone ? "-target44csspx" : ""));

          await raise.click();
          const settings = page.getByRole("dialog", { name: "Thread Settings", exact: true });
          await expect(settings.getByRole("heading", { name: "Spending" })).toBeFocused();
          await expectFullyInViewport(settings.getByRole("heading", { name: "Spending" }), "Spending settings");
          await settings.getByRole("button", { name: "Cancel", exact: true }).click();
          if (scenario === "over") {
            await notice.getByRole("button", { name: "Show Breakdown" }).click();
            const details = page.getByRole("tabpanel", { name: "Details", exact: true });
            await expect(details).toBeVisible();
            await expect(details).toContainText("$79.93 of $25.00 spent");
            await closeDetails(page);
          }
          if (phone) {
            await page.getByRole("button", { name: "Back to Assistants" }).click();
            await expect(threadRow(page).locator(".status")).toHaveText(badge);
            await expectTextContrast(threadRow(page).locator(".status"));
            await expectTouchTargets(page.getByRole("complementary", { name: "Assistants", exact: true }));
            await captureSpending(page, "list-row", theme, state + "-target44csspx");
          }
        });
      }

      test("confirms the named running sessions and stops only those that are still running", async ({ page }) => {
        await openSpending(page, "over");
        const stop = spendingNotice(page).getByRole("button", { name: "Stop Launched Sessions…" });
        await expect(stop).toBeEnabled();
        await stop.click();
        const dialog = page.getByRole("dialog", { name: "Stop Launched Sessions" });
        const rows = dialog.locator(".confirmation-rows .row-title");
        await expect(rows).toHaveCount(9);
        await expect(rows.first()).toHaveAttribute("title", /.{100,}/);
        await expect(rows.first()).toHaveCSS("text-overflow", "ellipsis");
        await expect(dialog.getByText("Unrelated Running Session")).toHaveCount(0);
        await expect(page.locator("body")).not.toHaveAttribute("data-stopped-sessions", /./);
        const cancel = dialog.getByRole("button", { name: "Cancel" });
        await expect(cancel).toBeFocused();
        const confirm = dialog.getByRole("button", { name: "Stop Sessions" });
        await expectFullyInViewport(confirm, "The stop confirmation action");
        await expectFullyInViewport(cancel, "Cancel");
        await expectPageNoHorizontalOverflow(page);
        await expectNoHorizontalOverflow(dialog);
        await expectTextContrast(dialog);
        if (phone) await expectTouchTargets(dialog);
        await captureSpending(page, "stop-confirmation", theme, "9running-sessions" + (phone ? "-target44csspx" : ""));
        await cancel.click();
        await expect(page.locator("body")).not.toHaveAttribute("data-stopped-sessions", /./);
        await stop.click();
        await page.evaluate(() => (window as unknown as { assistantsAdvance(): void }).assistantsAdvance());
        await confirm.click();
        await expect(dialog).toHaveCount(0);
        await expect(page.locator("body")).toHaveAttribute("data-stopped-sessions", "sess-many-5,sess-many-10,sess-many-15,sess-many-20,sess-many-25,sess-many-30,sess-many-35,sess-many-40");
        await expect(stop).toBeDisabled();
      });
    });
  }
}

test("Near Budget dismissal is per thread and the next threshold still warns", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSpending(page, "near");
  const notice = spendingNotice(page);
  await notice.getByRole("button", { name: "Dismiss Near Budget" }).click();
  await expect(notice).toHaveCount(0);
  await threadRow(page, "thr_release").click();
  await expect(notice.locator(".notice-title")).toHaveText("Near Budget");
  await threadRow(page).click();
  await expect(notice).toHaveCount(0);
  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await page.getByRole("link", { name: "Assistants", exact: true }).click();
  await threadRow(page).click();
  await expect(notice).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { assistantsSpend(used: number): void }).assistantsSpend(25));
  await expect(notice.locator(".notice-title")).toHaveText("Budget Used Up");
  await expect(notice.getByRole("button", { name: "Dismiss Near Budget" })).toHaveCount(0);
  await page.locator(".composer-input").fill("Summarize the work so far");
  await page.locator(".composer-input").press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-assistant-prompt", "sess-triage:Summarize the work so far");
  await expect(notice.locator(".notice-title")).toHaveText("Budget Used Up");
});

test("a control plane without thread usage shows no spending notice", async ({ page }) => {
  await open(page, THREAD, "light", "");
  await expect(threadBar(page).getByRole("heading")).toBeVisible();
  await expect(spendingNotice(page)).toHaveCount(0);
  await expect(threadBar(page).locator(".status")).toHaveText("Needs You");
});

test("a committed budget explains the launch refusal without overstating the spend", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, THREAD, "light", "budget");
  const notice = spendingNotice(page);
  await expect(notice.locator(".notice-title")).toHaveText("Budget Committed");
  await expect(notice).toContainText("has spent or committed its whole $25 budget, so it cannot launch another session.");
  await expect(notice.getByRole("meter")).toHaveAttribute("aria-valuetext", "$8.13 of $25.00 spent");
  await expect(threadRow(page).locator(".status")).toHaveText("Budget Committed");
  await expect(threadBar(page).locator(".status")).toHaveText("Budget Committed");
  await expect(notice.getByRole("button", { name: "Dismiss Near Budget" })).toHaveCount(0);
});

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
  await page.getByRole("menuitem", { name: "Thread Settings…", exact: true }).click();
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
  await page.getByRole("textbox", { name: "First Message" }).fill("Check the current budget.");
  await page.getByRole("button", { name: "Start Thread" }).click();
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
  const newThread = page.getByRole("form", { name: "What should the assistant work on?" });
  await expect(newThread.getByRole("button", { name: "Harness Codex", exact: true })).toBeVisible();
  await expect(newThread.getByRole("button", { name: "Account Codex Studio", exact: true })).toBeVisible();
  await newThread.getByRole("textbox", { name: "First Message" }).fill("Check the launch limit.");
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
        await page.getByRole("button", { name: "Back to Assistants", exact: true }).click();
        await page.getByRole("button", { name: "Search", exact: true }).click();
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
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`/assistants-e2e.html?limits=budget&spending=used-up&accounts=stress&path=${encodeURIComponent(THREAD)}`);
      const warning = page.locator(".composer .session-notice-slot").getByRole("status");
      await expect(warning).toContainText("Budget Used Up");
      if (theme === "dark") await capture(page, "thread-limit-warning");
      await warning.getByRole("button", { name: "Thread Settings", exact: true }).click();
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
