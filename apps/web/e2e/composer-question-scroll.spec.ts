import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 1709, height: 1389 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test(`over-height composer questions stay readable at ${viewport.width}×${viewport.height} (#3256)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/agent-questions-e2e.html?set=issue-drafts&style=composer&shell=1");
    const input = page.locator(".composer-answer-input");
    await input.focus();
    await input.fill("Keep as Drafts");
    const bounds = await page.locator(".composer").boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, Math.min(viewport.height - 20, Math.max(20, bounds!.y + 40)));
    await page.mouse.wheel(0, -10000);
    const first = page.locator(".answer-title .md > p").first();
    await expect(first).toBeInViewport();
    await page.locator(".composer-answer").focus();
    await page.keyboard.press("Home");
    await expect.poll(() => page.locator(".composer").evaluate((element) => element.scrollTop)).toBe(0);
    await expect(first).toBeInViewport();
    await page.keyboard.press("End");
    await expect(input).toBeInViewport();
    await expect.poll(() => page.locator(".composer").evaluate((element) => element.scrollTop >= element.scrollHeight - element.clientHeight - 1)).toBe(true);
    await page.keyboard.press("Home");
    await expect.poll(() => page.locator(".composer").evaluate((element) => element.scrollTop)).toBe(0);
    await page.mouse.wheel(0, 10000);
    await expect(page.getByText("End of proposed issues.", { exact: true })).toBeInViewport();
    await expect(input).toBeInViewport();
    await expect(input).toHaveValue("Keep as Drafts");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator(".answer-step")).toHaveText("Question 2 of 2");
    await input.fill("Preserve this note");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(input).toHaveValue("Keep as Drafts");
    await page.setViewportSize({ width: viewport.width, height: Math.max(300, viewport.height - 200) });
    await input.focus();
    await page.getByRole("button", { name: "Show Context", exact: true }).click();
    await page.getByRole("button", { name: "Show Answer", exact: true }).click();
    await expect(input).toHaveValue("Keep as Drafts");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(input).toHaveValue("Preserve this note");
    await page.getByRole("button", { name: "Exit Answer Mode", exact: true }).click();
    await expect(page.locator(".composer-answer")).toHaveCount(0);
    expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
  });
}

test("a touch swipe can recover the beginning after the answer field takes focus (#3256)", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto("/agent-questions-e2e.html?set=issue-drafts&style=composer&shell=1");
  await page.locator(".composer-answer-input").fill("Keep as Drafts");
  await page.locator(".composer-answer-input").blur();
  const touch = await context.newCDPSession(page);
  // Real touch events exercise the browser's scroll handling, rather than assigning scrollTop.
  for (let swipe = 0; swipe < 8; swipe++) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 180, y: 150 }] });
    for (let y = 200; y <= 700; y += 100) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 180, y }] });
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  await expect(page.locator(".answer-title .md > p").first()).toBeInViewport();
  await expect(page.locator(".composer-answer-input")).toHaveValue("Keep as Drafts");
  expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
  await context.close();
});
