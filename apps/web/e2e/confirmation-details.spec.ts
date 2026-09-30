import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #1950: a confirmation lists what it affects as one surface of dense rows, can name its safe choice,
 * and can offer a harmless extra action on desktop only (docs/design-system.md §7.4, §7.5).
 */

/** Opens a project split's archive confirmation from its actions menu, as the Command Inbox does. */
async function openProjectArchive(page: Page, variant: "stop" | "archive"): Promise<Locator> {
  await page.goto(`/confirmation-details-e2e.html?surface=project-archive${variant === "archive" ? "&variant=archive" : ""}`);
  // The trigger shows on the tab group's hover or focus, as in the Command Inbox tab strip.
  await page.getByRole("button", { name: "Workspace Actions for Invoicing" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: variant === "archive" ? "Archive All Sessions" : "Archive and Stop All Sessions" }).click();
  const dialog = page.getByRole("dialog", { name: variant === "archive" ? "Archive Sessions" : "Archive and Stop Sessions" });
  await expect(dialog).toBeVisible();
  await dialogMotionSettled(page);
  return dialog;
}

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
    const foot = await dialog.locator(".modal-foot").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        contentLeft: box.left + Number.parseFloat(style.paddingLeft),
        contentRight: box.right - Number.parseFloat(style.paddingRight),
        gap: Number.parseFloat(style.columnGap),
      };
    });
    const tops = await dialog.locator(".modal-foot > button").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top));
    expect(new Set(tops.map((top) => Math.round(top))).size, "the three buttons share one row").toBe(1);
    // End-aligned, so the footer's free space (the spacer) lies before the ghost button (§3.2).
    const last = buttons.at(-1)!;
    expectGeometry(Math.abs(foot.contentRight - (last.left + last.width)), "the primary ends at the footer's trailing edge")
      .toBeLessThanOrEqual(0.61);
    expectGeometry(buttons[0]!.left - foot.contentLeft, "free space lies before the ghost button").toBeGreaterThan(0);
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

  // #2051: a project split's archive lists the sessions it stops, in both of its variants.
  for (const variant of ["stop", "archive"] as const) {
    test(`the project split's ${variant === "stop" ? "Archive and Stop" : "Archive"} confirmation lists five of its seven sessions`, async ({ page }) => {
      const dialog = await openProjectArchive(page, variant);
      const rows = dialog.locator(".confirmation-rows > li");
      await expect(rows).toHaveCount(5);
      await expect(rows.locator(".status.inline")).toHaveText(["Running", "Awaiting Input", "Awaiting Prompt", "Approval Required", "Running"]);
      await expect(dialog.locator(".confirmation-rows-more")).toHaveText("and 2 more");
      await expect(dialog).toHaveAccessibleDescription(/All 7 sessions in “Invoicing”.*Review the migration plan.*and 2 more/);
    });
  }

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

  test("the project split's archive rows fit the sheet", async ({ page }) => {
    const dialog = await openProjectArchive(page, "stop");
    await expect(dialog.locator(".confirmation-rows > li")).toHaveCount(5);
    const overflow = await dialog.locator(".confirmation-rows").evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow, "no row spills sideways").toBe(0);
    await expect(dialog.locator(".confirmation-rows-more")).toHaveText("and 2 more");
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

  // #2050: the confirm label is wider than half a phone footer. It wraps inside its button instead of
  // spilling past both edges, and the pair stays equal in width and height.
  for (const [surface, label] of [["update", "Interrupt Sessions and Update"], ["adopt", "Interrupt Sessions and Adopt Legacy Data"]]) {
    test(`"${label}" fits inside its half of the footer`, async ({ page }) => {
      await page.goto(`/confirmation-details-e2e.html?surface=${surface}`);
      const dialog = page.getByRole("dialog", { name: label });
      await expect(dialog).toBeVisible();
      await dialogMotionSettled(page);
      const confirm = dialog.getByRole("button", { name: label, exact: true });
      await expect(confirm).toHaveAccessibleName(label);
      await expect(confirm).toHaveText(label);

      const fits = await dialog.locator(".modal-foot > button").evaluateAll((buttons) => buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const inner = {
          left: box.left + button.clientLeft,
          right: box.left + button.clientLeft + button.clientWidth,
          top: box.top + button.clientTop,
          bottom: box.top + button.clientTop + button.clientHeight,
        };
        const range = document.createRange();
        range.selectNodeContents(button);
        const spill = Math.max(...[...range.getClientRects()].flatMap((line) => [
          inner.left - line.left, line.right - inner.right, inner.top - line.top, line.bottom - inner.bottom,
        ]));
        return { text: button.textContent, width: box.width, height: box.height, spill, overflow: button.scrollWidth - button.clientWidth };
      }));
      expect(fits.map(({ text }) => text)).toEqual(["Cancel", label]);
      for (const { text, spill, overflow, height } of fits) {
        expectGeometry(spill, `every line of "${text}" stays inside its button`).toBeLessThanOrEqual(0);
        expect(overflow, `"${text}" does not overflow its button`).toBe(0);
        // At least the phone footer's 48px: a label that needs a third line grows the pair, never clips.
        expect(Math.round(height), `"${text}" is at least the 48px phone footer height`).toBeGreaterThanOrEqual(48);
      }
      expectGeometry(Math.abs(fits[0]!.width - fits[1]!.width), "the two footer buttons are equal width").toBeLessThanOrEqual(0.61);
      expectGeometry(Math.abs(fits[0]!.height - fits[1]!.height), "the two footer buttons are equal height").toBeLessThanOrEqual(0.61);
    });
  }
});
