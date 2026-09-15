import { expect, test, type Page } from "@playwright/test";

const EVIDENCE_CAPTURE = Boolean(process.env.EVIDENCE_CAPTURE);
test.use({ video: EVIDENCE_CAPTURE ? "on" : "off" });

async function openNewSnoozeDialog(page: Page) {
  await page.goto("/sessions-board-e2e.html");
  await expect(page.locator(".inbox-toolbar")).toBeVisible();
  const row = page.locator(".inbox-row-shell", { hasText: "Running Session" });
  await row.getByRole("button").first().click();
  const directSnooze = page.getByRole("button", { name: "Snooze", exact: true });
  if (await directSnooze.isVisible()) {
    await directSnooze.click();
  } else {
    await page.getByRole("button", { name: "More Actions" }).click();
    await page.getByRole("menuitem", { name: "Snooze Session…", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "Snooze Session" })).toBeVisible();
}

test("Snooze typeahead preserves the keyboard-first create flow", async ({ page }, testInfo) => {
  const pause = (milliseconds: number) => EVIDENCE_CAPTURE
    ? page.waitForTimeout(milliseconds)
    : Promise.resolve();
  await page.setViewportSize({ width: 1280, height: 900 });
  await openNewSnoozeDialog(page);

  const expression = page.getByRole("combobox", { name: "Natural Language" });
  const submit = page.getByRole("button", { name: "Snooze Session", exact: true });
  await expect(expression).toHaveValue("");
  await expect(expression).toBeFocused();
  await expect(submit).toBeDisabled();
  await expect(page.getByText("Choose a preset or enter a future schedule.")).toBeVisible();
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("desktop-empty.png") });
  await pause(2_500);

  await expression.fill("tomorrow at 3:30");
  const listbox = page.getByRole("listbox", { name: "Schedule Suggestions" });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option")).toHaveCount(2);
  await expect(expression).toHaveAttribute("aria-expanded", "true");
  await expect(expression).not.toHaveAttribute("aria-activedescendant", /.+/);
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("desktop-suggestions.png") });
  await pause(3_000);

  await expression.press("ArrowDown");
  await expect(expression).toHaveAttribute("aria-activedescendant", /suggestions-0$/);
  await expression.press("ArrowDown");
  await expect(expression).toHaveAttribute("aria-activedescendant", /suggestions-1$/);
  await pause(1_500);
  await expression.press("Escape");
  await expect(listbox).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  await pause(1_500);

  await expression.fill("in 2 hours");
  await expect(expression).toHaveAttribute("aria-expanded", "false");
  await expect(submit).toBeEnabled();
  await expression.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.__reminderWriteCalls)).toBe(1);
  await pause(3_000);
});

test("Snooze suggestions remain touch-sized and contained on mobile", async ({ page }, testInfo) => {
  const pause = (milliseconds: number) => EVIDENCE_CAPTURE
    ? page.waitForTimeout(milliseconds)
    : Promise.resolve();
  await page.setViewportSize({ width: 390, height: 844 });
  await openNewSnoozeDialog(page);

  const expression = page.getByRole("combobox", { name: "Natural Language" });
  await expression.fill("in 2");
  const listbox = page.getByRole("listbox", { name: "Schedule Suggestions" });
  await expect(listbox).toBeVisible();
  const geometry = await listbox.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const options = [...element.querySelectorAll<HTMLElement>('[role="option"]')];
    return {
      contained: bounds.left >= 0 && bounds.right <= window.innerWidth,
      touchSized: options.every((option) => option.getBoundingClientRect().height >= 44),
    };
  });
  expect(geometry).toEqual({ contained: true, touchSized: true });
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("mobile-suggestions.png") });
  await pause(3_000);

  await listbox.getByRole("option").filter({ hasText: "In 2 Hours" }).click();
  await expect(expression).toHaveValue("In 2 Hours");
  await expect(listbox).toHaveCount(0);
  await expect(page.getByText("Schedule Source: Autocomplete")).toBeVisible();
  await expect(page.getByRole("button", { name: "Snooze Session", exact: true })).toBeEnabled();
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("mobile-selected.png") });
  await pause(4_000);
});

test("a stationary pointer does not choose a suggestion for typed Enter submission", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openNewSnoozeDialog(page);

  const expression = page.getByRole("combobox", { name: "Natural Language" });
  const bounds = await expression.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + 24, bounds!.y + bounds!.height + 36);
  await expression.fill("tomorrow at 3 pm");
  await page.waitForTimeout(100);

  await expect(page.getByRole("listbox", { name: "Schedule Suggestions" })).toBeVisible();
  await expect(expression).not.toHaveAttribute("aria-activedescendant", /.+/);
});
