import { expect, test } from "@playwright/test";

/** Campaign Status's Decision Model Checks (#4104): each Decision Model verdict beside the request it
 * affected, and the owner's classification of one the model could not screen. */

for (const [label, viewport] of [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]] as const) {
  test(`the owner classifies a question the Decision Model could not screen (${label}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&screen=1&owner=1");
    const section = page.getByRole("region", { name: "Decision Model Checks" });
    await expect(section).toBeVisible();
    const items = section.locator("li");
    await expect(items).toHaveCount(4);
    // Each screened request is its own group, ruled off from the next.
    for (let index = 0; index < 4; index += 1) {
      await expect(items.nth(index)).toHaveCSS("border-top-style", "solid");
    }
    await expect(items.nth(0)).toContainText("Only Discusses");
    await expect(items.nth(0)).toContainText("The Orchestrator decides it.");
    await expect(items.nth(1)).toContainText("Asks for Access");
    await expect(items.nth(1)).toContainText("Declined and recorded as blocked work.");
    await expect(items.nth(2)).toContainText("Timed Out");
    await expect(items.nth(2).getByRole("button")).toHaveText(["Decline", "Let the Orchestrator Answer", "Open Session"]);
    await expect(items.nth(3)).toContainText("Owner Decision");
    await expect(items.nth(3).getByRole("button")).toHaveText(["Decline", "Let Me Answer", "Open Session"]);
    // Every group's first button starts on the same edge as the facts above it.
    for (const index of [0, 2]) {
      const factsLeft = await items.nth(index).locator("dl").evaluate((element) => element.getBoundingClientRect().left);
      const buttonLeft = await items.nth(index).getByRole("button").first().evaluate((element) => element.getBoundingClientRect().left);
      expect(Math.abs(buttonLeft - factsLeft)).toBeLessThanOrEqual(1);
    }
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`question-screen-${label}-before.png`) });
    await items.nth(2).getByRole("button", { name: "Let the Orchestrator Answer" }).click();
    await expect(items.nth(2)).toContainText("You let the Orchestrator answer it.");
    await expect(items.nth(2).getByRole("button")).toHaveText(["Open Session"]);
    expect(await page.evaluate(() => (window as unknown as { __CLASSIFIED__: unknown }).__CLASSIFIED__))
      .toEqual({ occurrenceId: "dec_sessions", classification: "orchestrator" });
    await page.screenshot({ path: testInfo.outputPath(`question-screen-${label}-after.png`) });
    const geometry = await section.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });
}

for (const [label, viewport] of [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]] as const) {
  test(`follow-up relatedness and closure-reason checks read beside their request (${label}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&checks=1");
    const section = page.getByRole("region", { name: "Decision Model Checks" });
    const items = section.locator("li");
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toContainText("Follow-Up Publication");
    await expect(items.nth(0)).toContainText("Related");
    await expect(items.nth(0)).toContainText("The Orchestrator may publish it.");
    await expect(items.nth(1)).toContainText("Unrelated");
    await expect(items.nth(1)).toContainText("Refused back to the Orchestrator.");
    await expect(items.nth(2)).toContainText("Issue Closure");
    await expect(items.nth(2)).toContainText("Reason Doesn't Fit");
    await expect(items.nth(3)).toContainText("Waiting for you to decide the closure.");
    await expect(items.nth(3)).toContainText("Timed Out");
    // These checks are decided on their own request: nothing here classifies them.
    for (let index = 0; index < 4; index += 1) await expect(items.nth(index).getByRole("button")).toHaveText(["Open Session"]);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`decision-checks-${label}.png`) });
    const geometry = await section.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });
}

for (const [label, viewport] of [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]] as const) {
  test(`a Custom campaign's epic seed reads beside the other checks (${label}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&checks=1&seed=1");
    const section = page.getByRole("region", { name: "Decision Model Checks" });
    const items = section.locator("li");
    await expect(items).toHaveCount(6);
    await expect(items.nth(4)).toContainText("Epic Seed");
    await expect(items.nth(4)).toContainText("Message Read");
    await expect(items.nth(4)).toContainText("An epic it names seeds the issue scope you approve; otherwise nothing waits.");
    await expect(items.nth(5)).toContainText("Waiting for you to approve the campaign's issue scope.");
    await expect(items.nth(5)).toContainText("Provider Overloaded");
    for (const index of [4, 5]) await expect(items.nth(index).getByRole("button")).toHaveText(["Open Session"]);
    await items.nth(4).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`epic-seed-${label}.png`) });
    const geometry = await section.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });
}

test("Campaign Status shows no Decision Model Checks before the Decision Model screens anything", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=campaign");
  await expect(page.locator(".campaign-status-summary")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Decision Model Checks" })).toHaveCount(0);
});
