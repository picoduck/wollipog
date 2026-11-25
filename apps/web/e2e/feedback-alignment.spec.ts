import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const EVIDENCE_DIR = process.env.FEEDBACK_ALIGNMENT_EVIDENCE_DIR;
const TOAST = { first: ".toast-message", content: ".toast-copy", icon: ".toast-icon svg", controls: ".toast-actions button" };
const NOTICE = { first: ".notice-title, .notice-body", content: ".notice-content", icon: ".notice-icon svg", controls: ".notice-trailing button" };
const WRAPPED = "The session was archived after its queued messages were cancelled. You can still read the transcript and reopen the worktree from Archived Sessions.";

async function checkRows(rows: Locator, parts: typeof TOAST, touch: boolean, wraps = false) {
  const measurements = [];
  for (const row of await rows.all()) {
    await expect(row).toBeInViewport({ ratio: 1 });
    const layout = await row.evaluate((element, selectors) => {
      const first = element.querySelector(selectors.first)!;
      const firstRect = first.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(first).lineHeight);
      const center = firstRect.top + lineHeight / 2;
      const card = element.getBoundingClientRect();
      const copy = element.querySelector(selectors.content)!.getBoundingClientRect();
      const icon = element.querySelector(selectors.icon)!.getBoundingClientRect();
      const style = getComputedStyle(element);
      const buttons = Array.from(element.querySelectorAll(selectors.controls));
      const controls = buttons.map((control) => {
        const box = control.getBoundingClientRect();
        const style = getComputedStyle(control);
        const after = getComputedStyle(control, "::after");
        // The positioned pseudo-element extends from the padding box inside the button border.
        const targetStart = box.left + parseFloat(style.borderLeftWidth) + parseFloat(after.left);
        const targetEnd = box.right - parseFloat(style.borderRightWidth) - parseFloat(after.right);
        const targetHeight = box.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)
          - parseFloat(after.top) - parseFloat(after.bottom);
        return {
          offset: Math.abs(box.top + box.height / 2 - center),
          height: box.height, targetHeight, targetStart, targetEnd,
        };
      });
      return {
        lineCount: firstRect.height / lineHeight,
        iconOffset: Math.abs(icon.top + icon.height / 2 - center),
        top: copy.top - card.top - parseFloat(style.borderTopWidth),
        bottom: card.bottom - copy.bottom - parseFloat(style.borderBottomWidth),
        left: icon.left - card.left - parseFloat(style.borderLeftWidth),
        right: card.right - buttons.at(-1)!.getBoundingClientRect().right - parseFloat(style.borderRightWidth),
        controls,
      };
    }, parts);
    expect(layout.lineCount, "message line count").toBeGreaterThanOrEqual(wraps ? 2 : 1);
    if (parts === TOAST && !wraps) expect(layout.lineCount).toBe(1);
    expect(layout.iconOffset, "icon center against first text line").toBeLessThanOrEqual(1);
    const padding = Math.abs(layout.top - layout.bottom);
    expect(padding, "space above and below the copy").toBeLessThanOrEqual(1);
    if (parts === TOAST) {
      const sides = [layout.top, layout.right, layout.bottom, layout.left];
      expect(Math.max(...sides) - Math.min(...sides), "equal space on all four sides").toBeLessThanOrEqual(1);
    }
    expect(layout.controls.length).toBeGreaterThan(0);
    for (const [index, control] of layout.controls.entries()) {
      expect(control.offset, "control center against first text line").toBeLessThanOrEqual(1);
      expect(control.height, "visible button height").toBe(touch ? 36 : 28);
      if (touch) {
        expect(control.targetHeight).toBeGreaterThanOrEqual(44);
        expect(control.targetEnd - control.targetStart).toBeGreaterThanOrEqual(44);
        if (index > 0) expect(control.targetStart).toBeGreaterThanOrEqual(layout.controls[index - 1]!.targetEnd - 0.1);
      }
    }
    measurements.push({
      offsets: layout.controls.map((control) => control.offset),
      padding,
      target: touch ? Math.min(...layout.controls.map((control) => Math.min(control.targetHeight, control.targetEnd - control.targetStart))) : undefined,
    });
  }
  return measurements;
}

const mouse = { viewport: { width: 1440, height: 900 }, hasTouch: false };
const { defaultBrowserType: _browser, ...iphone } = devices["iPhone 13"];
const phone = { ...iphone, viewport: { width: 390, height: 844 } };
for (const profile of [mouse, phone]) {
  for (const theme of ["light", "dark"] as const) {
    const dimensions = `${profile.viewport.width}x${profile.viewport.height}`;
    test.describe(`${dimensions} ${theme} feedback`, () => {
      test.use({ ...profile, colorScheme: theme, reducedMotion: "reduce" });

      async function check(page: Page, rows: Locator, surface: "toast" | "notice", state: string, wraps = false) {
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expectPageNoHorizontalOverflow(page);
        const measurements = await checkRows(rows, surface === "toast" ? TOAST : NOTICE, profile.hasTouch, wraps);
        if (EVIDENCE_DIR) {
          mkdirSync(EVIDENCE_DIR, { recursive: true });
          const round = (value: number) => Number(value.toFixed(2));
          const offsets = measurements.flatMap(({ offsets }) => offsets).map(round).join("_");
          const padding = round(Math.max(...measurements.map((row) => row.padding)));
          const target = profile.hasTouch ? `-target${round(Math.min(...measurements.map((row) => row.target!)))}csspx` : "";
          await page.screenshot({ scale: "css", path: join(EVIDENCE_DIR,
            `4801-${surface}-${dimensions}-${theme}-${state}-centre${offsets}px-padding${padding}px${target}.png`) });
        }
      }

      test("toast icons and trailing controls share the first line without adding vertical space", async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem("wollipog.theme", value), theme);
        await page.goto("/command-inbox-projects-e2e.html?fullShell=1");
        await page.waitForFunction(() => Boolean(window.__WOLLIPOG_TOASTS_E2E__));
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(profile.hasTouch);
        const rows = page.locator(".toast-region .toast");
        const show = (message: string, options: Parameters<NonNullable<Window["__WOLLIPOG_TOASTS_E2E__"]>["show"]>[1] = {}) =>
          page.evaluate(({ message, options }) => window.__WOLLIPOG_TOASTS_E2E__!.show(message, { ...options, durationMs: 0 }), { message, options });

        await show("A new update is available.", { tone: "info" });
        await show("The session was archived.", { tone: "success" });
        await show("The runner is offline.", { tone: "warning" });
        await show("The upload failed.", { tone: "error" });
        await page.locator(".toast-more").click();
        await expect(rows).toHaveCount(4);
        for (const tone of ["info", "success", "warning", "danger"]) {
          await expect(rows.and(page.locator(`.t-${tone}`))).toHaveCount(1);
        }
        await check(page, rows, "toast", "all-tones");

        for (let remaining = 4; remaining > 0; remaining -= 1) {
          await rows.first().getByRole("button", { name: "Dismiss Notification" }).click();
        }

        await show("The session was archived.", { detail: "Its transcript is still available in Archived Sessions." });
        await expect(rows.locator(".toast-detail")).toBeVisible();
        await check(page, rows, "toast", "detail");
        await rows.getByRole("button", { name: "Dismiss Notification" }).click();

        await show("Session archived.", { actionLabel: "Undo" });
        await expect(rows.getByRole("button", { name: "Undo" })).toBeVisible();
        await check(page, rows, "toast", "action");
        await rows.getByRole("button", { name: "Dismiss Notification" }).click();

        await show(WRAPPED, { actionLabel: "Undo" });
        await expect(rows.getByRole("button", { name: "Undo" })).toBeVisible();
        await check(page, rows, "toast", "wrapped", true);
      });

      test("notice trailing controls share the title or message's first line", async ({ page }) => {
        await page.goto(`/primitives-e2e.html?view=notice-trailing&theme=${theme}`);
        const notices = page.locator(".notice");
        await expect(notices).toHaveCount(2);
        await expect(notices.first().getByRole("button", { name: "+2 More" })).toBeVisible();
        await expect(notices.first().getByRole("button", { name: "Dismiss" })).toBeVisible();
        await check(page, notices, "notice", "title-and-trailing");
      });

      if (profile.hasTouch && theme === "light") {
        test("phone panel notices borrow the trailing hit area and keep the resolving action full size", async ({ page }) => {
          await page.goto("/agents-e2e.html?mixed=1&registry-retry=exhaust");
          const notice = page.locator(".panel-notice-slot .notice");
          await expect(notice.locator(".notice-title")).toHaveText("Couldn't Load Recorded Workers");
          await notice.getByRole("button", { name: "+1 More" }).tap();
          await page.getByRole("menuitem", { name: "3 Workers Need You", exact: true }).tap();
          const resolve = notice.getByRole("button", { name: "Review in Session", exact: true });
          await expect(resolve).toBeVisible();
          expect((await resolve.boundingBox())!.height).toBe(44);
          await checkRows(notice, NOTICE, true);
        });
      }

      test("Approve Once shows the aligned confirmation toast in the Assistant thread", async ({ page }) => {
        await page.goto(`/assistants-e2e.html?theme=${theme}&confirm=1&path=%2Fassistants%2F~dABoAHIAXwB0AHIAaQBhAGcAZQA`);
        const approve = page.getByRole("list", { name: "Pending Requests" }).getByRole("button", { name: "Approve Once" });
        if (profile.hasTouch) await approve.tap();
        else await approve.click();
        const toast = page.locator(".toast").filter({ hasText: "Stop Session ran once." });
        await expect(toast).toBeVisible();
        await check(page, toast, "toast", "owner-confirmation");
      });
    });
  }
}
