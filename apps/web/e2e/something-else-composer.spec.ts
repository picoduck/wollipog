import { expect, test } from "@playwright/test";
import { openMobileQuestion } from "./open-mobile-question.js";

// A Something Else answer is often a sentence or two of context (#4714).
const ANSWER = "I stopped and restarted the session and I think it's running now. Check again on your next wake " +
  "before replacing anything, and if it is still stuck after that, go ahead and replace the child.";

test.describe("Something Else on a touch phone (#4714)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Something Else is typed in the composer, in a field that wraps, grows and stays in view, and is sent as the card's would be", async ({ page }) => {
    await page.goto("/agent-questions-e2e.html?set=something-else&composer=1");
    await openMobileQuestion(page);
    const card = page.locator(".request-dock .question-card");
    await card.getByRole("radio", { name: "Something Else…" }).tap();

    // The card leaves the dock and the composer takes the answer, focused, so the keyboard opens for it.
    await expect(card).toHaveCount(0);
    const answer = page.locator(".composer-answer");
    await expect(answer.locator(".answer-kind")).toHaveText("Answering Question 1 of 2");
    await expect(answer.locator(".answer-own")).toHaveText("Something Else");
    const field = answer.locator("textarea.composer-answer-input");
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("enterkeyhint", "next");
    await expect(answer.locator(".answer-options")).toBeHidden();
    await expect(answer.locator(".answer-context")).toBeHidden();
    const oneLine = (await field.boundingBox())!.height;

    await field.fill(ANSWER);
    await expect.poll(async () => (await field.boundingBox())!.height, { message: "the field grows with its text" })
      .toBeGreaterThan(oneLine * 2);
    expect(await field.evaluate((element) => element.scrollWidth <= element.clientWidth), "nothing scrolls sideways").toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // A software keyboard leaves the page a short viewport: the field and Next stay in it.
    await page.setViewportSize({ width: 390, height: 420 });
    await field.focus();
    await expect(field).toBeInViewport();
    await expect(answer.getByRole("button", { name: "Next", exact: true })).toBeInViewport();
    await expect(answer.locator(".answer-title")).toBeInViewport();

    // Show Options brings the options and context back above the field, with Something Else chosen.
    await answer.getByRole("button", { name: "Show Options", exact: true }).tap();
    await expect(answer.locator(".answer-options")).toBeVisible();
    await expect(answer.getByRole("radio", { name: "Something Else…" })).toBeChecked();
    await answer.getByRole("button", { name: "Hide Options", exact: true }).tap();
    await expect(answer.locator(".answer-options")).toBeHidden();

    // Leaving keeps the answer: the card comes back with Something Else chosen and the answer so far.
    await page.setViewportSize({ width: 390, height: 844 });
    await answer.getByRole("button", { name: "Exit Answer Mode", exact: true }).tap();
    await openMobileQuestion(page);
    await expect(card.getByRole("radio", { name: "Something Else…" })).toBeChecked();
    const handoff = card.locator(".question-handoff");
    await expect(handoff).toContainText("I stopped and restarted the session");
    await expect(card.locator(".question-input")).toHaveCount(0);

    // Tapping it goes on in the composer; Enter is the keyboard's Next.
    await handoff.tap();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(ANSWER);
    await field.press("Enter");
    await expect(answer.locator(".answer-step")).toHaveText("Question 2 of 2");
    await answer.getByRole("radio", { name: "No, Ask Me First" }).tap();
    await answer.getByRole("button", { name: "Submit Answers", exact: true }).tap();
    await expect.poll(() => page.evaluate(() => window.agentQuestionCalls)).toEqual([{
      sessionId: expect.any(String),
      requestId: "ask-1",
      answers: { runner: ANSWER, after: "No, Ask Me First" },
      action: "submit",
    }]);
  });

  test("without a composer to answer in, the card keeps its own Something Else field", async ({ page }) => {
    await page.goto("/agent-questions-e2e.html?set=something-else");
    await openMobileQuestion(page);
    const card = page.locator(".request-dock .question-card");
    await card.getByRole("radio", { name: "Something Else…" }).tap();
    await expect(card.locator(".question-input")).toBeVisible();
    await expect(page.locator(".composer-answer")).toHaveCount(0);
  });
});

test("a fine pointer keeps the card's Something Else field (#4714)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/agent-questions-e2e.html?set=something-else&composer=1");
  const card = page.locator(".request-dock .question-card");
  await card.getByRole("radio", { name: "Something Else…" }).click();
  await expect(card.locator(".question-input")).toBeVisible();
  await expect(page.locator(".composer-answer")).toHaveCount(0);
});
