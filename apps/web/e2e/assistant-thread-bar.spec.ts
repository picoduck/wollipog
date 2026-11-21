import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const TRIAGE = "thr_triage";
const TRUNCATED_TITLE = "Triage every open issue labelled flaky-test and fix what you can in the upload, terminal and session-list suites tonight";
const BAR = ".assistant-thread-bar, .page > .detail-bar";

async function open(page: Page, theme: string, thread: string, query = "") {
  await page.clock.setFixedTime(Date.UTC(2026, 10, 20, 17));
  const path = viewPath({ name: "assistants", threadId: thread });
  await page.goto(`/assistants-e2e.html?theme=${theme}&path=${encodeURIComponent(path)}${query}`);
  await expect(page.locator(BAR).locator(".assistant-bar-title")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** Composite the status badge's translucent tint over the bar before measuring contrast. */
async function expectTextContrast(label: Locator) {
  const ratio = await label.evaluate((element) => {
    const context = document.createElement("canvas").getContext("2d")!;
    const fill = (color: string) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    };
    const luminance = () => Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3))
      .map((channel) => channel / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    fill(getComputedStyle(element.closest("header")!).backgroundColor);
    fill(getComputedStyle(element).backgroundColor);
    const background = luminance();
    fill(getComputedStyle(element).color);
    const text = luminance();
    return (Math.max(background, text) + 0.05) / (Math.min(background, text) + 0.05);
  });
  expect(ratio, "Text contrast against its computed background").toBeGreaterThanOrEqual(4.5);
}

async function checkBar(page: Page, phone: boolean, badge: string | null) {
  const bar = page.locator(BAR);
  const title = bar.locator(".detail-bar-title");
  await expect(title).toHaveCSS("white-space", "nowrap");
  await expect(title).toHaveCSS("text-overflow", "ellipsis");
  await expect(title).toHaveCSS("font-size", "16px");
  await expectTextContrast(title);
  const status = bar.locator(".status");
  if (badge === null) await expect(status).toHaveCount(0);
  else {
    await expect(status).toHaveText(badge);
    await expectFullyInViewport(status, "The thread status badge");
    await expectTextContrast(status);
  }
  expect((await bar.boundingBox())!.height, "The thread bar height in CSS pixels").toBe(48);
  await expect(bar.getByRole("button")).toHaveCount(phone ? 4 : 3);
  await expect(bar.getByRole("button", { name: "Back to Assistants" })).toHaveCount(phone ? 1 : 0);
  await expect(bar.getByRole("button", { name: "Thread Actions", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: /Side Panel/ })).toBeVisible();
  await expect(bar.locator(".detail-actions-divider")).toHaveCount(phone ? 0 : 1);
  await expect(page.locator(".assistant-launched-toggle, .assistant-thread-facts")).toHaveCount(0);
  await expect(page.getByText("Wollipog Assistant", { exact: true })).toHaveCount(0);
  await expect(page.locator(".assistant-thread-head").getByText(/Full access\.|sessions launched|of \$\d+\.\d+ spent/)).toHaveCount(0);
  await expectNoHorizontalOverflow(bar, "The thread bar");
  await expectPageNoHorizontalOverflow(page);
  await expectFullyInViewport(page.locator(".composer"), "The thread composer");
  await expect(page.locator(".detail-body")).toBeVisible();

  const controls = await bar.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const { x, y, width, height } = button.getBoundingClientRect();
    return { x, y, width, height, name: button.getAttribute("aria-label") ?? button.textContent };
  }));
  for (const [index, control] of controls.entries()) {
    expect(control.height, control.name + " height in CSS pixels").toBe(phone ? 44 : 32);
    expect(control.width, control.name + " width in CSS pixels").toBeGreaterThanOrEqual(phone ? 44 : 32);
    if (index > 0) {
      const previous = controls[index - 1]!;
      expect(control.x, control.name + " starts after " + previous.name).toBeGreaterThanOrEqual(previous.x + previous.width);
    }
  }
  expect(controls.at(-1)!.name).toMatch(phone ? /^Thread Actions$/ : /Side Panel/);
}

async function capture(page: Page, theme: string, state: string) {
  if (process.env.ASSISTANT_BAR_EVIDENCE !== "1") return;
  const { width, height } = page.viewportSize()!;
  const id = `4807-thread-bar-${width}x${height}-${theme}-${state}-bar48csspx${width === 390 ? "-target44csspx" : ""}`;
  await page.screenshot({ path: join("playwright-report", "4807", id + ".png"), animations: "disabled" });
}

for (const theme of ["light", "dark"] as const) {
  for (const phone of [false, true]) {
    test.describe(`${theme} ${phone ? "phone" : "desktop"}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        hasTouch: phone, isMobile: phone, colorScheme: theme, locale: "en-US", timezoneId: "UTC" });

      for (const { state, thread, badge } of [
        { state: "idle", thread: "thr_cleanup", badge: null },
        { state: "working", thread: "thr_release", badge: "Working" },
        { state: "over-budget", thread: TRIAGE, badge: null },
        { state: "archived", thread: "thr_retired", badge: "Archived" },
      ]) {
        test(`the ${state} thread has one detail bar`, async ({ page }) => {
          const overBudget = state === "over-budget";
          await open(page, theme, thread, overBudget ? "&limits=budget&thread-bar=over-budget" : "");
          await checkBar(page, phone, badge);
          await expect(page.locator(BAR).locator(".assistant-side-panel-dot")).toHaveCount(0);
          if (overBudget) {
            const notice = page.getByRole("status").filter({ hasText: "whole $25 budget" });
            await expect(notice).toContainText("Thread Limit Reached");
            await expectFullyInViewport(notice.getByRole("link", { name: "Thread Settings", exact: true }), "Budget notice action");
          }
          await capture(page, theme, state);
        });
      }

      test("the waiting dot and accessible count follow live launched sessions", async ({ page }) => {
        await open(page, theme, TRIAGE, "&launched=many&accounts=stress");
        await checkBar(page, phone, "Needs You");
        const toggle = page.locator(BAR).getByRole("button", { name: /Side Panel/ });
        const dot = toggle.locator(".assistant-side-panel-dot");
        await expect(toggle).toHaveAccessibleName("Show Side Panel, 1 Session Needs You");
        await expect(dot).toBeVisible();
        await expect(dot).toHaveCSS("width", "6px");
        await capture(page, theme, "needs-you");
        await toggle.click();
        const panel = page.getByRole("complementary", { name: "Side Panel" });
        await expect(panel.getByRole("tab", { name: "Work 42", selected: true })).toBeVisible();
        await panel.getByRole("tab", { name: "Details" }).click();
        await panel.getByRole("button", { name: "Close Panel" }).click();
        await toggle.click();
        await expect(panel.getByRole("tab", { name: "Details", selected: true })).toBeVisible();
        await panel.getByRole("tab", { name: "Work 42" }).click();
        await expect(panel.getByRole("region", { name: "Needs You", exact: true })).toContainText("Bump the Vite Group");
        await panel.getByRole("button", { name: "Close Panel" }).click();

        const waiting = page.getByRole("list", { name: "Pending Requests" });
        await waiting.getByRole("button", { name: "Approve Once" }).click();
        await expect(toggle).toHaveAccessibleName("Side Panel");
        await expect(dot).toHaveCount(0);
        await page.evaluate(() => Reflect.get(window, "assistantsWaitOnLaunch")());
        await expect(toggle).toHaveAccessibleName("Show Side Panel, 1 Session Needs You");
        await expect(dot).toBeVisible();
        await expect(waiting).toContainText("Fix the Flaky Upload Test");
        await waiting.getByRole("button", { name: "Approve Once" }).click();
        await expect(toggle).toHaveAccessibleName("Side Panel");
        await expect(dot).toHaveCount(0);
      });

      test("the one-line title ellipsizes and its tooltip shows all 120 characters", async ({ page }) => {
        await open(page, theme, TRIAGE, "&threads=long");
        const bar = page.locator(BAR);
        await page.evaluate(([id, title]) => Reflect.get(window, "assistantsRenameElsewhere")(id, title), [TRIAGE, TRUNCATED_TITLE]);
        const title = bar.locator(".detail-bar-title");
        await expect(title).toHaveText(TRUNCATED_TITLE);
        expect(TRUNCATED_TITLE).toHaveLength(120);
        await checkBar(page, phone, "Needs You");
        expect(await title.evaluate((element) => element.scrollWidth - element.clientWidth), "The title is clipped").toBeGreaterThan(0);
        const tooltip = bar.getByRole("tooltip");
        await expect(tooltip).toHaveCount(0);
        if (phone) await title.tap();
        else await title.hover();
        await expect(tooltip).toHaveText(TRUNCATED_TITLE);
        await expectFullyInViewport(tooltip, "The full title tooltip");
        await expectTextContrast(tooltip);
        await capture(page, theme, "title120-tooltip");
        await page.keyboard.press("Escape");
        await expect(tooltip).toHaveCount(0);
        await expect(title).toBeVisible();

        if (phone) {
          // Model engines that deliver the press without giving a tapped button focus.
          await title.evaluate((button) => button.addEventListener("pointerdown", (event) => event.preventDefault(), { once: true }));
          await page.locator(".detail-body").tap();
          await title.tap();
          await expect(title).not.toBeFocused();
          await expect(tooltip).toBeVisible();
          await page.locator(".detail-body").tap();
          await expect(tooltip).toHaveCount(0);
        }
      });
    });
  }
}
