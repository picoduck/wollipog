import { expect, test } from "@playwright/test";

/** Campaign Status's Question Screen (#4104): each Decision Model verdict beside the request it
 * affected, and the owner's classification of one the model could not screen. */

for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["narrow", { width: 420, height: 900 }]] as const) {
  test(`the owner classifies a question the Decision Model could not screen (${label})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&screen=1");
    const section = page.getByRole("region", { name: "Question Screen" });
    await expect(section).toBeVisible();
    const items = section.locator("li");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("Only Discusses");
    await expect(items.nth(0)).toContainText("The Orchestrator decides it.");
    await expect(items.nth(1)).toContainText("Asks for Access");
    await expect(items.nth(1)).toContainText("Declined and recorded as blocked work.");
    await expect(items.nth(2)).toContainText("Timed Out");
    await expect(items.nth(2).getByRole("button")).toHaveText(["Open Session", "Decline", "Let the Orchestrator Answer"]);
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: testInfo.outputPath(`question-screen-${label}-before.png`) });
    await items.nth(2).getByRole("button", { name: "Let the Orchestrator Answer" }).click();
    await expect(items.nth(2)).toContainText("You let the Orchestrator answer it.");
    await expect(items.nth(2).getByRole("button")).toHaveText(["Open Session"]);
    expect(await page.evaluate(() => (window as unknown as { __CLASSIFIED__: unknown }).__CLASSIFIED__))
      .toEqual({ occurrenceId: "dec_sessions", classification: "orchestrator" });
    await section.screenshot({ path: testInfo.outputPath(`question-screen-${label}-after.png`) });
    const geometry = await section.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });
}

test("Campaign Status shows no Question Screen before the Decision Model screens anything", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=campaign");
  await expect(page.locator(".campaign-status-summary")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Question Screen" })).toHaveCount(0);
});
