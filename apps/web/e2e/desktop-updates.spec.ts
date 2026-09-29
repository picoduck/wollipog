import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #1975 (and #1682's browser coverage): the desktop update toast in both install modes, the held-update
 * confirmation, and the two link-error toasts, through the real FeedbackProvider with a fake desktop
 * runtime (docs/design-system.md §7.4, §7.5, §13.1).
 *
 * These are desktop features, so the phone width runs only here, in the harness: it checks that the
 * shared primitives still hold there — the dialog becomes a bottom sheet, and the toast clears the
 * bottom edge.
 */

const FAILED_LINK = "https://github.com/picoduck/wollipog/pull/2040/files#diff-4f8c2d1e9b7a6035c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4";
const BLOCKED_LINK = "file:///Users/avery/Projects/wollipog/docs/design-system.md";
const LONG_LINK = `https://example.com/report?filters=${Array.from({ length: 200 }, (_, index) => `session-${index}`).join(",")}`;

/** Every line of `text` is inside the toast and the viewport: it wraps, and nothing is cut off. */
async function expectFullyVisible(toast: Locator, text: Locator) {
  const fit = await text.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const card = element.closest(".toast")!.getBoundingClientRect();
    return {
      spill: element.scrollWidth - element.clientWidth,
      left: box.left - card.left,
      right: card.right - box.right,
      top: box.top,
      bottom: window.innerHeight - box.bottom,
    };
  });
  expect(fit.spill, "the text wraps instead of spilling sideways").toBeLessThanOrEqual(0);
  expectGeometry(fit.left, "the text starts inside the toast").toBeGreaterThanOrEqual(0);
  expectGeometry(fit.right, "the text ends inside the toast").toBeGreaterThanOrEqual(0);
  expectGeometry(fit.top, "the text is below the top of the window").toBeGreaterThanOrEqual(0);
  expectGeometry(fit.bottom, "the text is above the bottom of the window").toBeGreaterThanOrEqual(0);
  await expect(toast).toBeInViewport({ ratio: 1 });
}

/** Tab from the page into the toast reaches its controls in reading order, ending on the close. */
async function expectKeyboardOrder(page: Page, toast: Locator, names: string[]) {
  await page.locator("body").focus();
  for (const name of names) {
    await page.keyboard.press("Tab");
    await expect(toast.getByRole(name === "What's New" ? "link" : "button", { name, exact: true })).toBeFocused();
  }
}

/** On desktop the stack is bottom right (§13.1); on a phone it spans the width above the bottom edge. */
async function expectPlacement(page: Page, phone: boolean) {
  const region = await page.locator(".toast-region").evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: window.innerWidth - box.right, bottom: window.innerHeight - box.bottom, width: box.width };
  });
  if (phone) {
    expectGeometry(Math.abs(region.left - 8), "8px from the left edge").toBeLessThanOrEqual(0.61);
    expectGeometry(Math.abs(region.right - 8), "8px from the right edge").toBeLessThanOrEqual(0.61);
    expectGeometry(Math.abs(region.bottom - 8), "8px above the bottom edge").toBeLessThanOrEqual(0.61);
  } else {
    expectGeometry(Math.abs(region.right - 16), "16px from the right edge").toBeLessThanOrEqual(0.61);
    expectGeometry(Math.abs(region.bottom - 16), "16px above the bottom edge").toBeLessThanOrEqual(0.61);
    expectGeometry(Math.abs(region.width - 360), "the 360px toast column").toBeLessThanOrEqual(0.61);
  }
}

for (const { width, height, phone } of [
  { width: 1440, height: 900, phone: false },
  { width: 390, height: 844, phone: true },
]) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`${width}px ${theme}`, () => {
      test.use({ viewport: { width, height }, ...(phone ? { hasTouch: true, isMobile: true } : {}) });

      test("the update toast offers Install and Restart, with What's New, and holds the install as a confirmation", async ({ page }) => {
        await page.goto(`/desktop-updates-e2e.html?state=in-place&theme=${theme}`);
        const toast = page.locator(".toast");
        await expect(toast).toHaveCount(1);
        await expect(toast).toHaveClass(/t-info/);
        await expect(toast.locator(".toast-message")).toHaveText("Wollipog 0.29.0 is ready to install.");
        await expect(toast.locator(".toast-detail")).toHaveText("Restarting takes a few seconds. You can also install it later from Settings.");
        await expect(toast.getByRole("link", { name: "What's New" })).toHaveAttribute("href", "https://github.com/picoduck/wollipog/releases/tag/v0.29.0");
        await expect(toast.getByRole("button")).toHaveText(["Install and Restart", ""]);
        await expectFullyVisible(toast, toast.locator(".toast-message"));
        await expectFullyVisible(toast, toast.locator(".toast-detail"));
        await expectPlacement(page, phone);
        await expectKeyboardOrder(page, toast, ["What's New", "Install and Restart", "Dismiss Notification"]);

        await toast.getByRole("button", { name: "Install and Restart" }).click();
        const dialog = page.getByRole("dialog", { name: "Restart to Install Update" });
        await expect(dialog).toBeVisible();
        await dialogMotionSettled(page);
        await expect(page.locator(".toast.t-danger")).toHaveCount(0);
        await expect(dialog.locator(".confirmation-message")).toHaveText(
          "Installing Wollipog 0.29.0 restarts the app, which stops 2 sessions that are still working. You can install later from Settings.",
        );
        await expect(dialog.locator(".confirmation-rows .row-title")).toHaveText([
          "Fix the half-cent rounding bug in invoice totals before the quarterly close",
          "Review the migration plan",
        ]);
        await expect(dialog.getByRole("button", { name: "Install Later" })).toBeFocused();

        const buttons = await dialog.locator(".modal-foot > button").evaluateAll((items) => items.map((item) => {
          const box = item.getBoundingClientRect();
          return { text: item.textContent, className: item.className, width: box.width };
        }));
        expect(buttons.map(({ text, className }) => [text, className])).toEqual([
          ["Install Later", "btn"],
          ["Restart Anyway", "btn danger"],
        ]);
        const sheet = await page.locator(".modal").filter({ has: dialog }).evaluate((element) => {
          const box = element.getBoundingClientRect();
          return { width: box.width, left: box.left, bottom: window.innerHeight - box.bottom, css: getComputedStyle(element).width };
        });
        if (phone) {
          // A bottom sheet (§7.5): the full width, on the bottom edge, with two equal buttons.
          expectGeometry(Math.abs(sheet.width - width), "the sheet spans the width").toBeLessThanOrEqual(0.61);
          expectGeometry(Math.abs(sheet.bottom), "the sheet sits on the bottom edge").toBeLessThanOrEqual(0.61);
          expectGeometry(Math.abs(buttons[0]!.width - buttons[1]!.width), "the two buttons are equal width").toBeLessThanOrEqual(0.61);
        } else {
          expect(sheet.css, "the 400px confirmation size").toBe("400px");
        }

        await dialog.getByRole("button", { name: "Restart Anyway" }).click();
        await expect(page.getByTestId("installs")).toHaveText("unconfirmed,confirmed");
        const restart = dialog.getByRole("button", { name: "Restart Anyway" });
        await expect(restart).toHaveAttribute("aria-busy", "true");
        await expect(restart).toHaveText("Restart Anyway");
      });

      test("the release-page toast offers Open Release Page and nothing that restarts", async ({ page }) => {
        await page.goto(`/desktop-updates-e2e.html?state=release-page&theme=${theme}`);
        const toast = page.locator(".toast");
        await expect(toast).toHaveCount(1);
        await expect(toast).toHaveClass(/t-info/);
        await expect(toast.locator(".toast-message")).toHaveText("Wollipog 0.29.0 is available.");
        await expect(toast.locator(".toast-detail")).toHaveText("You can also open it later from Settings.");
        await expect(toast.getByRole("button")).toHaveText(["Open Release Page", ""]);
        await expectFullyVisible(toast, toast.locator(".toast-message"));
        await expectPlacement(page, phone);
        await expectKeyboardOrder(page, toast, ["What's New", "Open Release Page", "Dismiss Notification"]);
        await toast.getByRole("button", { name: "Open Release Page" }).click();
        await expect(page.getByTestId("opened")).toHaveText("https://github.com/picoduck/wollipog/releases/tag/v0.29.0");
        await expect(page.getByTestId("installs")).toHaveText("");
      });

      for (const { state, message, tone, url } of [
        { state: "link-failure", message: "Couldn't open the link in your browser.", tone: /t-danger/, url: FAILED_LINK },
        { state: "link-policy", message: "Wollipog only opens web links in your browser.", tone: /t-warning/, url: BLOCKED_LINK },
      ]) {
        test(`the ${state} toast shows the whole URL in mono, with Copy Link and no Retry`, async ({ page }) => {
          await page.goto(`/desktop-updates-e2e.html?state=${state}&theme=${theme}`);
          const toast = page.locator(".toast");
          await expect(toast).toHaveCount(1);
          await expect(toast).toHaveClass(tone);
          await expect(toast.locator(".toast-message")).toHaveText(message);
          const detail = toast.locator(".toast-detail.mono");
          await expect(detail).toHaveText(url);
          expect(await detail.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/monospace/);
          await expect(toast).not.toContainText(/os error|blocked|system browser could not/);
          await expect(toast.getByRole("button")).toHaveText(["Copy Link", ""]);
          await expectFullyVisible(toast, toast.locator(".toast-message"));
          await expectFullyVisible(toast, detail);
          await expectPlacement(page, phone);
          await expectKeyboardOrder(page, toast, ["Copy Link", "Dismiss Notification"]);

          await toast.getByRole("button", { name: "Copy Link" }).click();
          await expect(page.getByTestId("copied")).toHaveText(url);
        });
      }

      test("a URL several kilobytes long scrolls inside the toast, which stays on screen", async ({ page }) => {
        await page.goto(`/desktop-updates-e2e.html?state=link-long&theme=${theme}`);
        const toast = page.locator(".toast");
        await expect(toast).toHaveCount(1);
        await expect(toast).toBeInViewport({ ratio: 1 });
        const detail = toast.locator(".toast-detail.mono");
        await expect(detail).toHaveText(LONG_LINK);
        const box = await detail.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }));
        expect(box.client, "eight lines at most").toBeLessThanOrEqual(8 * 16);
        expect(box.scroll, "the rest of the URL scrolls, rather than being cut off").toBeGreaterThan(box.client);
        await toast.getByRole("button", { name: "Copy Link" }).click();
        await expect(page.getByTestId("copied")).toHaveText(LONG_LINK);
      });
    });
  }
}
