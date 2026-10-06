import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion";

/**
 * #2181: Snooze leads with six preset tiles that show their time, one Snooze Until field with its
 * error under it, one Return Early checkbox and one summary line. These are the measurements the
 * issue sets: the desktop dialog's height, the phone sheet's tiles, the UI font and no uppercase.
 * With EVIDENCE_DIR set, each state is also captured for review.
 */

type Theme = "dark" | "light";
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

async function evidence(page: Page, name: string) {
  if (!EVIDENCE_DIR) return;
  await dialogMotionSettled(page);
  await page.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` });
}

/** Open Snooze for the row named `row`, from its direct button or the More Actions menu. */
async function openSnooze(page: Page, theme: Theme, { row = "Running Session", query = "" } = {}): Promise<Locator> {
  await page.goto(`/sessions-board-e2e.html${query}`);
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  await expect(page.locator(".page-tabs .tabs-bar")).toBeVisible();
  if (row === "Snoozed Session") {
    // A phone folds the Snoozed toggle into the page header's ⋯ menu.
    const snoozed = page.getByRole("button", { name: "Snoozed, 1", exact: true });
    if (await snoozed.isVisible()) {
      await snoozed.click();
    } else {
      await page.locator(".page-header").getByRole("button", { name: "More Actions" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Show Snoozed Sessions, 1" }).click();
    }
  }
  await page.locator(".inbox-row-shell", { hasText: row }).getByRole("button").first().click();
  const direct = page.getByRole("button", { name: "Snooze", exact: true }).first();
  if (await direct.isVisible()) {
    await direct.click();
  } else {
    await page.getByRole("button", { name: "More Actions" }).click();
    await page.getByRole("menuitem", { name: /^(Snooze…|Change Reminder…)$/ }).click();
  }
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialogMotionSettled(page);
  return dialog;
}

/** Every element in the dialog whose computed text-transform is not none. */
async function transformedText(dialog: Locator): Promise<string[]> {
  return dialog.evaluate((root) => [root, ...root.querySelectorAll("*")]
    .filter((element) => getComputedStyle(element).textTransform !== "none")
    .map((element) => element.outerHTML.slice(0, 80)));
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} at 1440×900`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("the default dialog is at most 480px and shows the title, six tiles, the checkbox and the footer", async ({ page }) => {
      const dialog = await openSnooze(page, theme);
      const card = page.locator(".modal").filter({ has: dialog });
      const box = (await card.boundingBox())!;
      expect(box.height, "the default dialog's height").toBeLessThanOrEqual(480);

      await expect(dialog.locator(".modal-desc")).toHaveText("Running Session");
      const tiles = dialog.getByRole("radiogroup", { name: "Return Time" }).getByRole("radio");
      await expect(tiles).toHaveText([/^Later Today/, /^Tomorrow Morning/, /^Next Week/, /^Next Month/, /^Someday/, /^Custom…/]);
      for (const tile of await tiles.all()) await expect(tile).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("checkbox", { name: "Return Early If It Needs Me" })).toBeChecked();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: "Snooze Session" })).toBeInViewport({ ratio: 1 });
      const body = dialog.locator(".modal-body");
      expect(await body.evaluate((element) => element.scrollHeight <= element.clientHeight + 1), "nothing scrolls").toBe(true);
      // Three equal tiles to a row.
      const rows = await tiles.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: Math.round(rect.top), width: Math.round(rect.width) };
      }));
      expect(new Set(rows.map((row) => row.top)).size, "two rows").toBe(2);
      expect(new Set(rows.map((row) => row.width)).size, "one width").toBe(1);
      expect(await transformedText(dialog), "no text is transformed to capitals").toEqual([]);
      await evidence(page, `desktop-${theme}-snooze-session`);

      await dialog.getByRole("radio", { name: "Tomorrow Morning" }).click();
      await expect(dialog.locator(".snooze-summary")).toHaveText(/^Returns \w+day, .+ at 9:00 AM\.$/);
      await evidence(page, `desktop-${theme}-tomorrow-morning`);
    });

    test("Custom… shows Snooze Until in the UI font, its suggestions and its error", async ({ page }) => {
      const dialog = await openSnooze(page, theme);
      await dialog.getByRole("radio", { name: "Custom…" }).click();
      const field = dialog.getByRole("combobox", { name: "Snooze Until" });
      await expect(field).toBeFocused();
      const fonts = await field.evaluate((input) => ({
        input: getComputedStyle(input).fontFamily,
        ui: getComputedStyle(document.body).fontFamily,
      }));
      expect(fonts.input, "every input uses the UI font").toBe(fonts.ui);

      await field.fill("tomorrow at 3:30");
      await expect(page.getByRole("listbox", { name: "Schedule Suggestions" }).getByRole("option")).toHaveCount(2);
      await evidence(page, `desktop-${theme}-custom-suggestions`);

      await field.fill("dec 10 9am");
      await expect(dialog.locator(".snooze-summary")).toHaveText(/^Returns \w+day, Dec 10(?:, \d{4})? at 9:00 AM\.$/);
      await evidence(page, `desktop-${theme}-custom-named-date`);

      await field.fill("12/10/26");
      await dialog.getByRole("button", { name: "Snooze Session" }).click();
      await expect(field).toBeFocused();
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(field).toHaveAccessibleDescription(
        "“12/10/26” could be December 10 or October 12. Write the month, like “Dec 10”.");
      const red = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--red)";
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      });
      // Polled: the edge eases from the focus colour to red.
      await expect.poll(() => field.evaluate((input) => getComputedStyle(input).borderTopColor),
        { message: "the invalid field draws the red edge" }).toBe(red);
      expect(await page.evaluate(() => window.__reminderWriteCalls)).toBe(0);
      await evidence(page, `desktop-${theme}-invalid`);
    });

    test("Edit Reminder and its conflict", async ({ page }) => {
      const dialog = await openSnooze(page, theme, { row: "Snoozed Session", query: "?reminder-conflict=1" });
      await expect(dialog.getByRole("heading", { name: "Edit Reminder" })).toBeVisible();
      await expect(dialog.getByRole("radio", { name: "Custom…" })).toHaveAttribute("aria-checked", "true");
      await expect(dialog.getByRole("button", { name: "Remove Reminder" })).toBeVisible();
      await evidence(page, `desktop-${theme}-edit-reminder`);

      await dialog.getByRole("combobox", { name: "Snooze Until" }).fill("tomorrow 3pm");
      await dialog.getByRole("button", { name: "Update Reminder" }).click();
      await expect(dialog.getByRole("alert").filter({ hasText: "Reminder Changed" })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Reload Reminder" })).toBeVisible();
      await expect(dialog.locator(".snooze-blocked-reason")).toHaveText("Reload the reminder before saving.");
      await evidence(page, `desktop-${theme}-conflict`);
    });
  });

  test.describe(`${theme} at 390×844`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the dialog is a bottom sheet with 2×3 tiles of at least 48px and a two-button footer", async ({ page }) => {
      const dialog = await openSnooze(page, theme);
      const sheet = (await page.locator(".modal").filter({ has: dialog }).boundingBox())!;
      expect(Math.round(sheet.x), "the sheet spans the width").toBe(0);
      expect(Math.round(sheet.width)).toBe(390);
      expect(Math.round(sheet.y + sheet.height), "the sheet sits on the bottom edge").toBe(844);

      const tiles = await dialog.getByRole("radio").evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: Math.round(rect.left), top: Math.round(rect.top), height: rect.height };
      }));
      expect(tiles).toHaveLength(6);
      expect(new Set(tiles.map((tile) => tile.left)).size, "two columns").toBe(2);
      expect(new Set(tiles.map((tile) => tile.top)).size, "three rows").toBe(3);
      for (const tile of tiles) expect(tile.height, "each tile is at least 48px").toBeGreaterThanOrEqual(48);

      const buttons = await dialog.locator(".modal-foot > .btn").evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { text: element.textContent, width: Math.round(rect.width), height: rect.height };
      }));
      expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Snooze Session"]);
      expect(buttons[0]!.width).toBe(buttons[1]!.width);
      expect(buttons[0]!.height).toBeGreaterThanOrEqual(48);
      expect(await transformedText(dialog)).toEqual([]);
      await evidence(page, `phone-${theme}-snooze-session`);

      await dialog.getByRole("radio", { name: "Custom…" }).click();
      await dialog.getByRole("combobox", { name: "Snooze Until" }).fill("tomorrow at 3:30");
      await expect(page.getByRole("listbox", { name: "Schedule Suggestions" }).getByRole("option")).toHaveCount(2);
      await evidence(page, `phone-${theme}-custom-suggestions`);

      await dialog.getByRole("combobox", { name: "Snooze Until" }).fill("12/10/26");
      await dialog.getByRole("button", { name: "Snooze Session" }).click();
      await expect(dialog.getByRole("combobox", { name: "Snooze Until" })).toHaveAttribute("aria-invalid", "true");
      await evidence(page, `phone-${theme}-invalid`);
    });

    test("Edit Reminder moves Remove Reminder to the end of the body, and its conflict", async ({ page }) => {
      const dialog = await openSnooze(page, theme, { row: "Snoozed Session", query: "?reminder-conflict=1" });
      await expect(dialog.getByRole("heading", { name: "Edit Reminder" })).toBeVisible();
      const remove = dialog.getByRole("button", { name: "Remove Reminder" });
      expect(await remove.evaluate((button) => button.closest(".modal-body") !== null
        && button.closest(".modal-body")!.lastElementChild!.contains(button)), "Remove Reminder ends the body").toBe(true);
      await expect(dialog.locator(".modal-foot > .btn")).toHaveText(["Cancel", "Update Reminder"]);
      await evidence(page, `phone-${theme}-edit-reminder`);

      await dialog.getByRole("combobox", { name: "Snooze Until" }).fill("tomorrow 3pm");
      await dialog.getByRole("button", { name: "Update Reminder" }).click();
      await expect(dialog.getByRole("alert").filter({ hasText: "Reminder Changed" })).toBeVisible();
      await evidence(page, `phone-${theme}-conflict`);
    });
  });
}
