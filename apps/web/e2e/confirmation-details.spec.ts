import { expect, test, type Locator } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #1950: a confirmation lists what it affects as one surface of dense rows, can name its safe choice,
 * and can offer a harmless extra action on desktop only (docs/design-system.md §7.4, §7.5).
 */

async function footButtons(dialog: Locator) {
  return dialog.locator(".modal-foot > button").evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    return { text: button.textContent, className: button.className, left: box.left, width: box.width };
  }));
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the update confirmation shows five session rows on one token-radius surface, then the overflow", async ({ page }) => {
    await page.goto("/confirmation-details-e2e.html");
    const dialog = page.getByRole("dialog", { name: "Interrupt Sessions and Update" });
    await expect(dialog).toBeVisible();
    await dialogMotionSettled(page);
    const rows = dialog.locator(".confirmation-rows > li");
    await expect(rows).toHaveCount(5);
    await expect(rows.locator(".status.inline")).toHaveText(["Running", "Awaiting Input", "Awaiting Prompt", "Running", "Starting"]);
    await expect(dialog.locator(".confirmation-rows-more")).toHaveText("and 4 more");
    // The rows are part of the description a screen reader announces with the dialog.
    await expect(dialog).toHaveAccessibleDescription(/Updating this runner will interrupt 9 active sessions\..*Review the migration plan.*and 4 more/);

    const surface = await dialog.locator(".confirmation-rows").evaluate((element) => {
      const probe = document.createElement("div");
      probe.style.borderRadius = "var(--radius-md)";
      document.body.append(probe);
      const token = getComputedStyle(probe).borderTopLeftRadius;
      probe.remove();
      return { radius: getComputedStyle(element).borderTopLeftRadius, token };
    });
    expect(surface.radius, "the surface uses the --radius-md token").toBe(surface.token);

    // A long title truncates on one line, and its tooltip holds the full text.
    const title = rows.first().locator(".row-title");
    await expect(title).toHaveAttribute("title", "Fix the half-cent rounding bug in invoice totals before the quarterly close");
    const truncation = await title.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth, lines: element.getClientRects().length }));
    expect(truncation.scroll).toBeGreaterThan(truncation.client);
    expect(truncation.lines).toBe(1);

    const heights = await rows.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    expect(new Set(heights.map((height) => Math.round(height))).size, "every row is the same height").toBe(1);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  });

  test("a secondary action sits after the spacer and before the named cancel button, and closes as not confirmed", async ({ page }) => {
    await page.goto("/confirmation-details-e2e.html?surface=secondary");
    const dialog = page.getByRole("dialog", { name: "Quit Wollipog" });
    await expect(dialog).toBeVisible();
    await dialogMotionSettled(page);
    const buttons = await footButtons(dialog);
    expect(buttons.map(({ text, className }) => [text, className])).toEqual([
      ["Show Sessions", "btn ghost"],
      ["Keep Open", "btn"],
      ["Quit Wollipog", "btn danger"],
    ]);
    const foot = await dialog.locator(".modal-foot").evaluate((element) => ({
      left: element.getBoundingClientRect().left,
      gap: Number.parseFloat(getComputedStyle(element).columnGap),
    }));
    expectGeometry(buttons[0]!.left - foot.left, "the spacer holds the footer's leading space").toBeGreaterThan(40);
    expectGeometry(Math.abs(buttons[1]!.left - (buttons[0]!.left + buttons[0]!.width) - foot.gap),
      "the ghost button sits one footer gap before Keep Open").toBeLessThanOrEqual(0.61);
    await expect(dialog.getByRole("button", { name: "Keep Open" })).toBeFocused();

    await dialog.getByRole("button", { name: "Show Sessions" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("shown")).toHaveText("1");
    await expect(page.getByTestId("outcome")).toHaveText("false");
  });

  test("narrowing to a phone while the secondary action has focus keeps focus in the dialog", async ({ page }) => {
    await page.goto("/confirmation-details-e2e.html?surface=secondary");
    const dialog = page.getByRole("dialog", { name: "Quit Wollipog" });
    await dialog.getByRole("button", { name: "Show Sessions" }).focus();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog.getByRole("button", { name: "Show Sessions" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Keep Open" })).toBeFocused();
  });

  test("Escape and the scrim choose the named cancel button", async ({ page }) => {
    await page.goto("/confirmation-details-e2e.html?surface=secondary");
    await expect(page.getByRole("dialog", { name: "Quit Wollipog" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("outcome")).toHaveText("false");

    await page.goto("/confirmation-details-e2e.html?surface=secondary");
    await expect(page.getByRole("dialog", { name: "Quit Wollipog" })).toBeVisible();
    await dialogMotionSettled(page);
    await page.mouse.click(8, 8);
    await expect(page.getByTestId("outcome")).toHaveText("false");
    await expect(page.getByTestId("shown")).toHaveText("0");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the secondary action is left out, and the footer holds two equal-width buttons", async ({ page }) => {
    await page.goto("/confirmation-details-e2e.html?surface=secondary");
    const dialog = page.getByRole("dialog", { name: "Quit Wollipog" });
    await expect(dialog).toBeVisible();
    await dialogMotionSettled(page);
    const buttons = await footButtons(dialog);
    expect(buttons.map(({ text }) => text)).toEqual(["Keep Open", "Quit Wollipog"]);
    expectGeometry(Math.abs(buttons[0]!.width - buttons[1]!.width), "the two footer buttons are equal width").toBeLessThanOrEqual(0.61);
  });

  test("the update confirmation's rows fit the sheet", async ({ page }) => {
    await page.goto("/confirmation-details-e2e.html");
    const dialog = page.getByRole("dialog", { name: "Interrupt Sessions and Update" });
    await expect(dialog).toBeVisible();
    await dialogMotionSettled(page);
    await expect(dialog.locator(".confirmation-rows > li")).toHaveCount(5);
    const overflow = await dialog.locator(".confirmation-rows").evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow, "no row spills sideways").toBe(0);
    const buttons = await footButtons(dialog);
    expect(buttons.map(({ text }) => text)).toEqual(["Cancel", "Interrupt Sessions and Update"]);
  });
});
