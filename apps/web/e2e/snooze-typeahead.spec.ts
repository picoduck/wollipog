import { expect, test, type Locator, type Page } from "@playwright/test";
import { pinWidestFace } from "./font-geometry";

const EVIDENCE_CAPTURE = Boolean(process.env.EVIDENCE_CAPTURE);
test.use({ video: EVIDENCE_CAPTURE ? "on" : "off" });

async function openNewSnoozeDialog(page: Page) {
  await page.goto("/sessions-board-e2e.html");
  await expect(page.locator(".inbox-list-pane > .toolbar")).toBeVisible();
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
  await expression.fill("fri aft");
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

  await listbox.getByRole("option").filter({ hasText: "Friday Afternoon" }).click();
  await expect(expression).toHaveValue("Friday Afternoon");
  await expect(listbox).toHaveCount(0);
  await expect(page.getByText("Schedule Source: Autocomplete")).toBeVisible();
  await expect(page.getByRole("button", { name: "Snooze Session", exact: true })).toBeEnabled();
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("mobile-selected.png") });
  await pause(4_000);
});

test.describe("a short suggestions list on a phone", () => {
  // The dates below are fixed so their length is too: a Wednesday in September is the longest one.
  test.use({ locale: "en-US", timezoneId: "UTC" });

  async function listFit(list: Locator) {
    return list.evaluate((element) => {
      const lineCount = (node: Element) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      };
      return {
        dateLines: [...element.querySelectorAll("[role=option] small")].map(lineCount),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        lastBottom: element.querySelector("[role=option]:last-child")!.getBoundingClientRect().bottom,
        listBottom: element.getBoundingClientRect().bottom,
      };
    });
  }

  test("grows to its wrapped dates instead of scrolling", async ({ page }) => {
    // Each suggestion's date was counted as one line. At 390px a date that wraps renders taller, so
    // a one- or two-suggestion list scrolled to show its last line and clipped it at the bottom edge.
    // A 150% browser text size in the widest verified face wraps it on any machine that has one.
    await page.clock.setFixedTime(new Date("2026-09-29T10:00:00Z"));
    await page.setViewportSize({ width: 390, height: 844 });
    await openNewSnoozeDialog(page);
    await page.addStyleTag({ content: "html { font-size: 150%; }" });
    const face = await pinWidestFace(page, page.locator("body"));
    // The sheet's entrance ends with a placement pass of its own, which would hide a list that is
    // not placed again when its suggestions change.
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));

    const expression = page.getByRole("combobox", { name: "Natural Language" });
    const list = page.getByRole("listbox", { name: "Schedule Suggestions" });

    await expression.fill("tomorrow at 3:30");
    await expect(list.getByRole("option")).toHaveCount(2);
    let fit = await listFit(list);
    expect(fit.dateLines, `each date wraps in ${face}`).toEqual([2, 2]);
    expect(fit.scrollHeight, "the list sizes to its content").toBeLessThanOrEqual(fit.clientHeight + 1);
    expect(fit.lastBottom, "the last suggestion sits inside the list").toBeLessThanOrEqual(fit.listBottom);

    // One short suggestion, then one long one: the count stays the same while the content grows.
    await expression.fill("some");
    await expect(list.getByRole("option")).toHaveCount(1);
    expect((await listFit(list)).dateLines, "the Someday note fits on one line").toEqual([1]);
    await expression.fill("wednesday aft");
    await expect(list.getByRole("option")).toHaveText(/Wednesday Afternoon/);
    fit = await listFit(list);
    expect(fit.dateLines, `the date wraps in ${face}`).toEqual([2]);
    expect(fit.scrollHeight, "the list sizes to its new content").toBeLessThanOrEqual(fit.clientHeight + 1);
    expect(fit.lastBottom, "the suggestion sits inside the list").toBeLessThanOrEqual(fit.listBottom);
  });
});

test("calendar-relative presets and weekday clocks use the same authoritative preview", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openNewSnoozeDialog(page);

  await page.getByRole("radio", { name: "Next Month" }).click();
  await expect(page.getByText("Schedule Source: Preset — Next Month")).toBeVisible();
  await expect(page.getByRole("button", { name: "Snooze Session", exact: true })).toBeEnabled();

  const expression = page.getByRole("combobox", { name: "Natural Language" });
  await expression.fill("wed at 15:30");
  await expect(page.getByRole("listbox", { name: "Schedule Suggestions" })).toBeVisible();
  await expect(page.locator(".snooze-preview")).toContainText("Schedule Source: Natural Language");
  await expect(page.getByRole("button", { name: "Snooze Session", exact: true })).toBeEnabled();
});

test("Someday clearly has no timer on desktop and mobile", async ({ page }, testInfo) => {
  const verifySomeday = async (screenshotName: string) => {
    await openNewSnoozeDialog(page);
    await page.getByRole("radio", { name: "Someday", exact: true }).click();
    await expect(page.locator(".snooze-preview")).toContainText("Someday — no automatic return time.");
    await expect(page.locator(".snooze-preview")).toContainText("Time Zone: Not Applicable");
    await expect(page.getByRole("radio", { name: /Until Activity/ })).toContainText("There is no automatic return time");
    await page.getByRole("radio", { name: /Regardless/ }).click();
    await expect(page.getByRole("radio", { name: /Regardless/ })).toContainText("Stay snoozed until you reschedule or remove the reminder");
    await expect(page.getByRole("button", { name: "Snooze Session", exact: true })).toBeEnabled();
    if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath(screenshotName) });
    await page.getByRole("button", { name: "Snooze Session", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => window.__reminderWriteCalls)).toBe(1);
  };

  await page.setViewportSize({ width: 1280, height: 900 });
  await verifySomeday("desktop-someday.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await verifySomeday("mobile-someday.png");
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
