import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";

/**
 * The Automation editor's When to Run fields (#2971) in a real browser, at the widths and themes the
 * issue names: Schedule's preview, its Examples menu, its error, the Time Zone list and the About
 * Time Zones popover. `AutomationsView.dom.test.tsx` covers the logic against a fake DOM; this is
 * real layout and CSS. The clock and the zone are pinned, so every time it words is fixed. With
 * `WOLLIPOG_EVIDENCE_DIR` set, each state is also captured as UI evidence.
 */

// Friday, October 23, 2026 at 5:00 PM in Chicago: the next weekday 9:00 AM is Monday's.
const FRIDAY_EVENING = new Date("2026-10-23T22:00:00Z");

test.use({ timezoneId: "America/Chicago" });

/** The viewport, once every animation (a menu's entrance, a sheet's slide) has finished. */
async function capture(page: Page, name: string) {
  const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
  if (!evidenceDir) return;
  await page.evaluate(() => Promise.all(document.getAnimations()
    // A cancelled animation (an error replacing its helper) rejects; it has nothing left to settle.
    .map((animation) => animation.finished.catch(() => undefined))));
  await page.screenshot({ path: join(evidenceDir, `${name}.png`) });
}

async function openNew(page: Page, theme: string) {
  await page.clock.setFixedTime(FRIDAY_EVENING);
  await page.goto(`/automations-e2e.html?theme=${theme}&route=${encodeURIComponent("/automations/new")}`);
  await expect(page.locator(".automation-cron-input")).toBeVisible();
}

/** A phone's menu or popover is a bottom sheet (§9.2): wait until it has slid onto the bottom edge. */
async function expectBottomSheet(sheet: Locator, height: number) {
  await expect.poll(async () => {
    const box = await sheet.boundingBox();
    return box ? Math.round(box.y + box.height) : null;
  }).toBe(height);
}

/** Scroll When to Run to the top of the page, so a capture shows it and what opens from it. */
async function showWhenToRun(page: Page) {
  await page.getByRole("heading", { name: "When to Run" }).evaluate((heading) => heading.scrollIntoView({ block: "start" }));
}

for (const { label, viewport } of [
  { label: "1440", viewport: { width: 1440, height: 900 } },
  { label: "390", viewport: { width: 390, height: 844 } },
]) for (const theme of ["dark", "light"] as const) {
  const phone = label === "390";
  test.describe(`${label}px ${theme} When to Run`, () => {
    test.use({ viewport });

    test("a valid schedule previews in words with its next run, beside an Examples button as tall as the field", async ({ page }) => {
      await openNew(page, theme);
      const schedule = page.locator(".automation-cron-input");
      await schedule.fill("0 9 * * 1-5");
      const preview = page.locator(".automation-schedule-preview");
      // The browser's own zone is the new automation's, so the zone is not named.
      await expect(preview).toHaveText("Weekdays at 9:00 AM · Next Mon, 9:00 AM");
      await expect(preview).toHaveAttribute("aria-live", "polite");
      expect(await schedule.evaluate((input) => getComputedStyle(input).fontFamily)).toMatch(/Cascadia Code|monospace/);

      const examples = page.getByRole("button", { name: "Examples" });
      const [field, button] = [await schedule.boundingBox(), await examples.boundingBox()];
      expect(button!.height).toBeCloseTo(field!.height, 0);
      expect(button!.y).toBeCloseTo(field!.y, 0);
      expect(button!.x).toBeGreaterThan(field!.x + field!.width);
      // The helper sits 4px under the field and the preview 4px under the helper (§8.1).
      const helper = await page.locator(".field-helper", { hasText: "Minute, hour, day of month, month, weekday." }).boundingBox();
      expect(helper!.y - (field!.y + field!.height)).toBeCloseTo(4, 0);
      expect((await preview.boundingBox())!.y - (helper!.y + helper!.height)).toBeCloseTo(4, 0);
      const zone = await page.getByRole("combobox", { name: "Time Zone" }).inputValue();
      expect(zone).toBe("Chicago (UTC−5)");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await showWhenToRun(page);
      await capture(page, `${label}-${theme}-valid-preview`);
    });

    test("the Examples menu lists six schedules with their expressions and fills the one chosen", async ({ page }) => {
      await openNew(page, theme);
      await page.getByRole("button", { name: "Examples" }).click();
      const menu = page.getByRole("menu", { name: "Schedule Examples" });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem")).toHaveCount(6);
      await expect(menu.locator(".menu-text")).toHaveText([
        "Every Hour", "Every Day at 9:00 AM", "Weekdays at 9:00 AM", "Every Monday at 9:00 AM",
        "Monthly on the 1st at 9:00 AM", "Quarterly on the 1st at 9:00 AM",
      ]);
      if (phone) await expectBottomSheet(menu, viewport.height);
      else expect((await menu.boundingBox())!.x + (await menu.boundingBox())!.width).toBeLessThanOrEqual(viewport.width);
      await showWhenToRun(page);
      await capture(page, `${label}-${theme}-examples-menu`);
      await menu.getByRole("menuitem", { name: "Monthly on the 1st at 9:00 AM" }).click();
      await expect(menu).toHaveCount(0);
      await expect(page.locator(".automation-cron-input")).toHaveValue("0 9 1 * *");
      await expect(page.locator(".automation-cron-input")).toBeFocused();
      await expect(page.locator(".automation-schedule-preview")).toHaveText("Monthly on the 1st at 9:00 AM · Next Nov 1, 9:00 AM");
    });

    test("an invalid schedule shows its error under the field on blur, hides the preview, and Save focuses it", async ({ page }) => {
      await openNew(page, theme);
      const schedule = page.locator(".automation-cron-input");
      await schedule.fill("0 9 * *");
      await schedule.blur();
      const error = page.locator(".field-error", { hasText: "Use five fields: minute, hour, day of month, month, weekday." });
      await expect(error).toBeVisible();
      await expect(schedule).toHaveAttribute("aria-invalid", "true");
      await expect(page.locator(".automation-schedule-preview")).toHaveText("");
      const field = (await schedule.boundingBox())!;
      expect((await error.boundingBox())!.y - (field.y + field.height)).toBeCloseTo(4, 0);
      // The DOM test proves no request is sent; here, the field takes focus and the editor stays.
      await page.getByRole("button", { name: "Create Automation" }).click();
      await expect(schedule).toBeFocused();
      await expect(page.locator(".automation-editor")).toBeVisible();
      await showWhenToRun(page);
      await capture(page, `${label}-${theme}-invalid`);
    });

    test("Time Zone filters by city and names each zone with its offset over its IANA name", async ({ page }) => {
      await openNew(page, theme);
      const zone = page.getByRole("combobox", { name: "Time Zone" });
      await zone.click();
      await zone.fill("york");
      const options = page.getByRole("option");
      await expect(options).toHaveCount(1);
      await expect(options.first()).toContainText("New York (UTC−4)");
      await expect(options.first()).toContainText("America/New_York");
      await showWhenToRun(page);
      await capture(page, `${label}-${theme}-time-zone-filtered`);
      await options.first().click();
      await expect(zone).toHaveValue("New York (UTC−4)");
      await expect(page.locator(".automation-schedule-preview"))
        .toHaveText("Weekdays at 9:00 AM · Next Mon, 9:00 AM (Eastern Time)");
    });

    test("About Time Zones sits beside the label and opens the daylight-saving rules", async ({ page }) => {
      await openNew(page, theme);
      const about = page.getByRole("button", { name: "About Time Zones" });
      const labelBox = (await page.locator(".automation-zone-label > label").boundingBox())!;
      const aboutBox = (await about.boundingBox())!;
      expect(aboutBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
      expect(aboutBox.x - (labelBox.x + labelBox.width)).toBeLessThanOrEqual(8);
      await expect(page.getByText(/When clocks skip forward/)).toHaveCount(0);
      await about.click();
      const popover = page.getByRole("dialog", { name: "About Time Zones" });
      await expect(popover).toContainText(
        "When clocks skip forward, a time that doesn't exist is skipped. When they fall back, a repeated time runs once.");
      if (phone) await expectBottomSheet(popover, viewport.height);
      await showWhenToRun(page);
      await capture(page, `${label}-${theme}-about-time-zones`);
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);
      await expect(about).toBeFocused();
    });
  });
}
