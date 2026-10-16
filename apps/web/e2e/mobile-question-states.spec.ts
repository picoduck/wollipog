import { expect, test, type Page } from "@playwright/test";

test.use({ hasTouch: true });

const dock = (page: Page) => page.locator(".request-dock");
const card = (page: Page) => dock(page).locator(".question-card");
const expand = (page: Page) => dock(page).getByRole("button", { name: "Expand Request", exact: true });

async function expectCollapsed(page: Page) {
  await expect(dock(page)).toHaveAttribute("data-collapsed", "");
  await expect(dock(page).locator(".dock-strip")).toBeVisible();
  await expect(card(page)).toBeHidden();
  await expect(page.locator(".detail-main")).toHaveCSS("visibility", "visible");
  expect((await dock(page).locator(".dock-strip").boundingBox())!.height).toBeLessThanOrEqual(44);
}

async function expectExpanded(page: Page) {
  await expect(dock(page)).toHaveAttribute("data-reading", "");
  await expect(card(page)).toHaveAttribute("data-question-expanded", "");
  await expect(page.locator(".detail-main")).toHaveCSS("visibility", "hidden");
  const layout = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const column = box(".chat-reading");
    const slot = box(".chat-reading > .session-notice-slot");
    const question = box(".question-card");
    const head = box(".question-card > .request-card-head");
    const foot = box(".question-card > .request-card-foot");
    return {
      top: Math.abs(column.top - slot.top), height: Math.abs(column.height - slot.height),
      questionHeight: question.height, columnHeight: column.height,
      headTop: head.top, footBottom: foot.bottom, topEdge: column.top, bottomEdge: column.bottom,
      overlap: head.bottom > foot.top,
    };
  });
  expect(layout.top).toBeLessThanOrEqual(1);
  expect(layout.height).toBeLessThanOrEqual(1);
  expect(layout.questionHeight).toBeGreaterThan(layout.columnHeight * 0.8);
  expect(layout.headTop).toBeGreaterThanOrEqual(layout.topEdge);
  expect(layout.footBottom).toBeLessThanOrEqual(layout.bottomEdge);
  expect(layout.overlap).toBe(false);
  await expect(card(page).getByRole("button", { name: "Collapse Question" })).toBeInViewport();
}

for (const viewport of [
  { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 390, height: 500 },
]) {
  for (const set of ["short", "long-text"]) {
    test(`a ${set} question uses only strip and full reading mode at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/agent-questions-e2e.html?set=${set}&after=60`);
      await expectCollapsed(page);
      const reader = page.locator(".detail-scroll");
      await expect(page.getByText("Later reply 30: the agent explains what it did and why.", { exact: true })).toBeInViewport();
      await reader.hover();
      await page.mouse.wheel(0, -800);
      await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
      await expectCollapsed(page);
      const before = await reader.evaluate(element => element.scrollTop);
      await expand(page).focus();
      await page.keyboard.press("Enter");
      await expectExpanded(page);
      await expect(card(page).locator(".question-text p").first()).toBeInViewport();
      await card(page).getByRole("radio").first().check();
      await card(page).getByRole("radio").last().scrollIntoViewIfNeeded();
      await expect(card(page).getByRole("radio").last()).toBeInViewport();
      await page.evaluate(() => window.setAgentQuestionKeyboard(true));
      await expectExpanded(page);
      await card(page).getByRole("button", { name: "Collapse Question" }).tap();
      await expectCollapsed(page);
      await expect(expand(page)).toBeFocused();
      expect(await reader.evaluate(element => element.scrollTop)).toBeCloseTo(before, 0);
      await expand(page).tap();
      await expectExpanded(page);
      await expect(card(page).locator(".question-text p").first()).toBeInViewport();
      await expect(card(page).getByRole("radio").first()).toBeChecked();
      expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
    });
  }
}

test("a text draft and current step survive collapse, rotation, and keyboard changes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?set=notes");
  await expectCollapsed(page);
  await expand(page).tap();
  await card(page).locator(".question-input").fill("First draft");
  await card(page).getByRole("button", { name: "Next", exact: true }).tap();
  await card(page).locator(".question-input").fill("Second draft");
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => window.setAgentQuestionKeyboard(true));
  await expectExpanded(page);
  await card(page).getByRole("button", { name: "Collapse Question" }).tap();
  await expectCollapsed(page);
  await expand(page).tap();
  await expect(card(page).locator(".question-step-note")).toContainText("Question 2 of 2");
  await expect(card(page).locator(".question-input")).toHaveValue("Second draft");
  await card(page).getByRole("button", { name: "Back", exact: true }).tap();
  await expect(card(page).locator(".question-input")).toHaveValue("First draft");
  expect(await page.evaluate(() => window.agentQuestionCalls)).toEqual([]);
});

test("Jump to Question opens full reading mode and Show Where Asked returns to the strip", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?after=60");
  await expectCollapsed(page);
  await page.locator(".detail-scroll").hover();
  for (let count = 0; count < 12 && !await page.getByRole("button", { name: "Jump to Question", exact: true }).isVisible(); count++) {
    await page.mouse.wheel(0, -1200);
  }
  await page.getByRole("button", { name: "Jump to Question", exact: true }).click();
  await expectExpanded(page);
  await expect(card(page).locator(".question-text")).toBeFocused();
  await card(page).getByRole("button", { name: "Show Where Asked", exact: true }).tap();
  await expectCollapsed(page);
});

test("choosing another question opens it fully and collapsing preserves the selected request", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent-questions-e2e.html?more=1");
  await expand(page).tap();
  await dock(page).locator(".request-dock-more .disclosure-trigger").tap();
  await dock(page).getByRole("button", { name: /^Workflow Decision/ }).tap();
  await expectExpanded(page);
  await expect(card(page).locator(".question-text")).toHaveText("Which wave lands next?");
  await card(page).getByRole("button", { name: "Collapse Question" }).tap();
  await expectCollapsed(page);
  await expect(dock(page).locator(".dock-strip-title")).toHaveText("Workflow Decision");
});
