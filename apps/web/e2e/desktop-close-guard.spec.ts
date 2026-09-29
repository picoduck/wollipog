import { expect, test, type Locator } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #1965: a close the desktop shell holds becomes a confirmation — Keep Open, Show Sessions, Quit
 * Anyway — naming the working sessions the local instance knows (docs/design-system.md §7.4, §13.1).
 *
 * The dialog is Tauri-only, so it is checked at the desktop sizes it can have: a wide window and the
 * 940px minimum window width. The harness stands in for the shell, which CI cannot screenshot.
 */

async function footer(dialog: Locator) {
  const buttons = await dialog.locator(".modal-foot > button").evaluateAll((items) => items.map((item) => {
    const box = item.getBoundingClientRect();
    return { text: item.textContent, className: item.className, top: box.top, left: box.left, right: box.right };
  }));
  const foot = await dialog.locator(".modal-foot").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { left: box.left + Number.parseFloat(style.paddingLeft), right: box.right - Number.parseFloat(style.paddingRight) };
  });
  return { buttons, foot };
}

for (const width of [1440, 940]) {
  test.describe(`${width}px window`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the dialog is the 400px confirmation, with its three buttons on one line, opening on Keep Open", async ({ page }) => {
      await page.goto("/desktop-close-guard-e2e.html");
      const dialog = page.getByRole("dialog", { name: "Quit Wollipog" });
      await expect(dialog).toBeVisible();
      await dialogMotionSettled(page);
      await expect(page.locator(".toast")).toHaveCount(0);

      // The confirmation size, not squeezed by the window: 400px inside its 1px border.
      const modal = page.locator(".modal.sm").filter({ has: dialog });
      await expect(modal).toHaveCount(1);
      await expect(modal).toHaveCSS("width", "400px");

      const { buttons, foot } = await footer(dialog);
      expect(buttons.map(({ text, className }) => [text, className])).toEqual([
        ["Show Sessions", "btn ghost"],
        ["Keep Open", "btn"],
        ["Quit Anyway", "btn danger"],
      ]);
      expect(new Set(buttons.map(({ top }) => Math.round(top))).size, "the three buttons share one line").toBe(1);
      expectGeometry(buttons[0]!.left - foot.left, "the ghost button stays inside the footer").toBeGreaterThanOrEqual(0);
      expectGeometry(Math.abs(foot.right - buttons.at(-1)!.right), "Quit Anyway ends at the footer's trailing edge")
        .toBeLessThanOrEqual(0.61);
      await expect(dialog.getByRole("button", { name: "Keep Open" })).toBeFocused();

      const rows = dialog.locator(".confirmation-rows > li");
      await expect(rows.locator(".row-title")).toHaveText([
        "Fix the half-cent rounding bug in invoice totals before the quarterly close",
        "Review the migration plan",
      ]);
      await expect(rows.locator(".status.inline")).toHaveText(["Running", "Awaiting Input"]);
      await expect(dialog).toHaveAccessibleDescription(
        /^2 sessions are still working\. Quitting stops their current turns; you can continue them after you reopen Wollipog\..*Review the migration plan/,
      );
    });
  });
}

test.describe("choices", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an id the local instance does not know is counted in \"and 1 more\"", async ({ page }) => {
    await page.goto("/desktop-close-guard-e2e.html?state=more");
    const dialog = page.getByRole("dialog", { name: "Quit Wollipog" });
    await expect(dialog.locator(".confirmation-rows > li")).toHaveCount(2);
    await expect(dialog.locator(".confirmation-rows-more")).toHaveText("and 1 more");
  });

  test("a count the shell could not get says so, and names no one", async ({ page }) => {
    await page.goto("/desktop-close-guard-e2e.html?state=unknown");
    const dialog = page.getByRole("dialog", { name: "Quit Wollipog" });
    await expect(dialog.locator(".confirmation-message")).toHaveText(
      "Wollipog couldn't check whether agents are still working. Quitting stops any turn that is in progress.",
    );
    await expect(dialog.locator(".confirmation-rows")).toHaveCount(0);
  });

  test("Quit Anyway asks the shell to quit once", async ({ page }) => {
    await page.goto("/desktop-close-guard-e2e.html");
    const dialog = page.getByRole("dialog", { name: "Quit Wollipog" });
    await dialogMotionSettled(page);
    await dialog.getByRole("button", { name: "Quit Anyway" }).click();
    await expect(page.getByTestId("quits")).toHaveText("1");
    await expect(page.getByTestId("shown")).toHaveText("0");
  });

  test("Show Sessions closes the dialog and opens Sessions without quitting", async ({ page }) => {
    await page.goto("/desktop-close-guard-e2e.html");
    const dialog = page.getByRole("dialog", { name: "Quit Wollipog" });
    await dialogMotionSettled(page);
    await dialog.getByRole("button", { name: "Show Sessions" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("shown")).toHaveText("1");
    await expect(page.getByTestId("quits")).toHaveText("0");
  });
});
