import { expect, test, type Page } from "@playwright/test";
import { pinWidestFace } from "./font-geometry";
import { expectTextFits } from "./text-fit";

test.use({ reducedMotion: "reduce" });

const QUESTION_RESPONSE_STYLES = ["Interactive Form", "Composer Response"];
const ENTER_KEY_OPTIONS = ["Send Message", "Insert New Line"];

/**
 * Each Question Response Style option in the listbox and, once chosen, in the trigger; and each
 * Enter Key pill, which shares the row's value column.
 */
async function expectBehaviorChoicesFit(page: Page, where: string) {
  const trigger = page.getByRole("button", { name: /^Question Response Style:/ });
  for (const label of QUESTION_RESPONSE_STYLES) {
    await trigger.click();
    const listbox = page.getByRole("listbox", { name: "Question Response Style" });
    await expect(listbox).toBeVisible();
    const options = listbox.getByRole("option");
    await expect(options).toHaveCount(QUESTION_RESPONSE_STYLES.length);
    for (const option of await options.all()) {
      await expectTextFits(option, `the ${await option.getAttribute("aria-labelledby")} option ${where}`);
    }
    await listbox.getByRole("option", { name: label, exact: true }).click();
    await expect(listbox).toBeHidden();
    await expect(trigger).toHaveAccessibleName(`Question Response Style: ${label}`);
    await expect(trigger.locator(".ui-select-value")).toHaveText(label);
    await expectTextFits(trigger, `the ${label} trigger ${where}`);
  }

  const enterKey = page.getByRole("radiogroup", { name: "Enter Key" });
  await expect(enterKey.getByRole("radio")).toHaveCount(ENTER_KEY_OPTIONS.length);
  for (const label of ENTER_KEY_OPTIONS) {
    await expectTextFits(enterKey.getByRole("radio", { name: label, exact: true }), `the ${label} pill ${where}`);
  }
  await expectTextFits(enterKey, `the Enter Key group ${where}`);
}

// #2506: as two equal pills in the shared 220px value column, each 106px wide, "Composer Response"
// (about 126px of text) ran past its pill and the control's border at every desktop width. The
// margin depends on text advance width, so each width is measured again in the widest verified face.
for (const theme of ["dark", "light"]) {
  for (const width of [1440, 1100, 900, 390]) {
    test(`every Question Response Style and Enter Key option fits its own box at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/settings-rows-e2e.html?theme=${theme}&section=behavior`);
      await expect(page.locator("#settings-panel-heading")).toHaveText("Behavior");
      await expectBehaviorChoicesFit(page, `at ${width}px in ${theme}`);
      const face = await pinWidestFace(page, page.locator("body"));
      await expectBehaviorChoicesFit(page, `at ${width}px in ${theme} with ${face}`);
    });
  }
}
