import { expect, test } from "@playwright/test";

for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }]) {
  test(`a child question accepts an alternative and note without an approval card (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/agent-questions-e2e.html?set=child-question&style=composer");
    const card = page.locator(".composer-answer");
    await expect(card.locator(".answer-title")).toHaveText("Which approach should the child session use?");
    await expect(card.getByRole("radio", { name: /^Retry with Backoff \(Recommended\)/u })).toBeVisible();
    await expect(page.getByText("Approval Required")).toHaveCount(0);
    await expect(page.getByText("Do Not Proceed")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Session Status" }).getByText("Needs Your Input")).toBeVisible();
    await card.locator("input.composer-answer-input").fill("Use both approaches.");
    await card.getByRole("button", { name: "Next", exact: true }).click();
    await expect(card.locator(".answer-title")).toHaveText("Anything to add for the session?");
    await card.locator("input.composer-answer-input").fill("Keep the existing API.");
    await card.getByRole("button", { name: "Submit Answers", exact: true }).click();
    expect(await page.evaluate(() => window.agentQuestionCalls.map(({ action, answers }) => ({ action, answers })))).toEqual([
      { action: "submit", answers: { owner_question_answer: "Use both approaches.", owner_question_note: "Keep the existing API." } },
    ]);
  });
}
