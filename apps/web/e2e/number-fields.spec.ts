import { expect, test, type Page } from "@playwright/test";
import { expectNumberFieldsWhole, numberFields } from "./number-field-fit.js";

/**
 * The shared 96px number field (§8.3, #3185): `NumberRow` with each short unit, holding the largest
 * value its field allows, in a wide system face at 13px field text and at the 16px the coarse-pointer
 * guard sets. The shared affix rule reserved 2em of the field's font for any unit, which left 40px
 * for digits at 13px and 34px at 16px, and a number field's spin buttons took about 15px more:
 * "30000 ms" showed "300", and even "3650 d" showed "365".
 */

const PAGE = "/settings-rows-e2e.html?theme=dark&view=numbers";

async function open(page: Page) {
  await page.goto(PAGE);
  await expect(numberFields(page)).toHaveCount(6);
}

async function fieldWidths(page: Page) {
  return numberFields(page).evaluateAll((wraps) => wraps.map((wrap) => wrap.getBoundingClientRect().width));
}

test.describe("13px fields", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("every 96px number field shows its largest value whole beside its unit", async ({ page }) => {
    await open(page);
    expect(await numberFields(page).locator("input").first().evaluate((input) => getComputedStyle(input).fontSize)).toBe("13px");
    expect(await fieldWidths(page)).toEqual([96, 96, 96, 96, 96, 96]);
    await expectNumberFieldsWhole(page, page, "every value whole at 13px");
  });

  test("a typed five-digit value stays whole while the field has focus", async ({ page }) => {
    await open(page);
    const field = page.getByRole("spinbutton", { name: /^Idle Timeout/ });
    await field.fill("99999");
    await field.hover();
    await expectNumberFieldsWhole(page, page, "a focused, hovered field keeps its digits");
  });

  test("a number field with a unit has no spin buttons, and the arrow keys still step it", async ({ page }) => {
    await open(page);
    const appearance = (name: RegExp) => page.getByRole("spinbutton", { name }).evaluate((input) => getComputedStyle(input).appearance);
    expect(await appearance(/^Retention/)).toBe("textfield");
    expect(await appearance(/^Port/), "a field without a unit keeps its spin buttons").not.toBe("textfield");
    const field = page.getByRole("spinbutton", { name: /^Retention/ });
    await field.focus();
    await page.keyboard.press("ArrowDown");
    await expect(field).toHaveValue("3649");
    await page.keyboard.press("ArrowUp");
    await expect(field).toHaveValue("3650");
    await page.keyboard.press("ArrowUp");
    await expect(field, "the field's max still holds").toHaveValue("3650");
  });
});

test.describe("16px fields on a coarse pointer", () => {
  test.use({ viewport: { width: 1024, height: 900 }, hasTouch: true });

  test("every number field shows its largest value whole beside its unit", async ({ page }) => {
    await open(page);
    expect(await numberFields(page).locator("input").first().evaluate((input) => getComputedStyle(input).fontSize)).toBe("16px");
    // A field with a unit grows to 120px for 16px digits; Port has no unit and stays 96px.
    expect(await fieldWidths(page)).toEqual([120, 120, 120, 120, 120, 96]);
    await expectNumberFieldsWhole(page, page, "every value whole at 16px");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("every number field shows its largest value whole beside its unit", async ({ page }) => {
    await open(page);
    await expectNumberFieldsWhole(page, page, "every value whole on a phone");
  });
});
