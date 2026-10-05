import { expect, test, type Page } from "@playwright/test";
import { pinWidestFace } from "./font-geometry";
import { expectTextFits } from "./text-fit";

test.use({ reducedMotion: "reduce" });

/**
 * Each pill of a two-option row in the shared value column: Answer Questions In (Settings ›
 * Approvals, #2158) and Enter Key (Behavior).
 */
async function expectPillsFit(page: Page, group: string, labels: string[], where: string) {
  const radios = page.getByRole("radiogroup", { name: group });
  await expect(radios.getByRole("radio")).toHaveCount(labels.length);
  for (const label of labels) {
    await expectTextFits(radios.getByRole("radio", { name: label, exact: true }), `the ${label} pill ${where}`);
  }
  await expectTextFits(radios, `the ${group} group ${where}`);
}

// #2506: as two equal pills in the shared 220px value column, "Composer Response" ran past its pill.
// The row moved to Approvals as Answer Questions In with the short labels Form and Composer, which
// fit as pills again. The margin depends on text advance width, so each width is measured again in
// the widest verified face.
for (const theme of ["dark", "light"]) {
  for (const width of [1440, 1100, 900, 390]) {
    test(`every Answer Questions In and Enter Key option fits its own box at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const [section, heading, group, labels] of [
        ["approvals", "Approvals", "Answer Questions In", ["Form", "Composer"]],
        ["behavior", "Behavior", "Enter Key", ["Send Message", "Insert New Line"]],
      ] as const) {
        await page.goto(`/settings-rows-e2e.html?theme=${theme}&section=${section}`);
        await expect(page.locator("#settings-panel-heading")).toHaveText(heading);
        await expectPillsFit(page, group, [...labels], `at ${width}px in ${theme}`);
        const face = await pinWidestFace(page, page.locator("body"));
        await expectPillsFit(page, group, [...labels], `at ${width}px in ${theme} with ${face}`);
      }
    });
  }
}

test("Behavior no longer carries the question settings that moved to Approvals", async ({ page }) => {
  await page.goto("/settings-rows-e2e.html?theme=dark&section=behavior");
  await expect(page.locator("#settings-panel-heading")).toHaveText("Behavior");
  await expect(page.locator(".settings-panel")).not.toContainText(/Question Response Style|Routine Question/);
});
