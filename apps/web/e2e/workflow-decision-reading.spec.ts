import { expect, test, type Page } from "@playwright/test";

const card = (page: Page) => page.locator(".request-dock .request-card");
const submissions = (page: Page) => page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions());

async function expectReadingMode(page: Page) {
  await expect(page.locator(".request-dock")).toHaveAttribute("data-reading", "");
  await expect(card(page)).toHaveAttribute("data-decision-expanded", "");
  await expect(page.locator(".detail-main")).toHaveCSS("visibility", "hidden");
  const geometry = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const reading = box(".chat-reading");
    const slot = box(".chat-reading > .session-notice-slot");
    const body = document.querySelector<HTMLElement>(".request-card-body")!;
    return {
      heightDifference: Math.abs(reading.height - slot.height),
      topDifference: Math.abs(reading.top - slot.top),
      head: { top: box(".request-card-head").top, bottom: box(".request-card-head").bottom },
      foot: { top: box(".request-card-foot").top, bottom: box(".request-card-foot").bottom },
      reading: { top: reading.top, bottom: reading.bottom },
      bodyHeight: body.clientHeight,
      bodyOverflow: getComputedStyle(body).overflowY,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geometry.heightDifference).toBeLessThanOrEqual(1);
  expect(geometry.topDifference).toBeLessThanOrEqual(1);
  expect(geometry.head.top).toBeGreaterThanOrEqual(geometry.reading.top);
  expect(geometry.foot.bottom).toBeLessThanOrEqual(geometry.reading.bottom);
  expect(geometry.head.bottom).toBeLessThanOrEqual(geometry.foot.top);
  expect(geometry.bodyHeight).toBeGreaterThan(20);
  expect(geometry.bodyOverflow).toBe("auto");
  expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
  for (const name of ["Collapse Decision", "Approve", "Deny"]) {
    const button = card(page).getByRole("button", { name, exact: true });
    const box = await button.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(geometry.reading.top);
    expect(box!.y + box!.height).toBeLessThanOrEqual(geometry.reading.bottom);
  }
}

test.describe("workflow decision reading mode (#2874)", () => {
  test.use({ hasTouch: true });
  test("a short expanded question still fills a 300–480px reading column", async ({ page }) => {
    await page.setViewportSize({ width: 740, height: 530 });
    await page.goto("/agent-questions-e2e.html?set=paragraph&style=composer");
    await page.getByRole("button", { name: "Exit Answer Mode", exact: true }).click();
    const question = page.locator(".request-dock .question-card");
    await question.getByRole("button", { name: "Show Full Question" }).click();
    await expect(page.locator(".request-dock")).toHaveAttribute("data-reading", "");
    const geometry = await page.evaluate(() => ({
      column: document.querySelector(".chat-reading")!.getBoundingClientRect().height,
      dock: document.querySelector(".request-dock")!.getBoundingClientRect().height,
      wrapper: document.querySelector(".request-dock-card")!.getBoundingClientRect().height,
    }));
    expect(geometry.column).toBeGreaterThanOrEqual(300);
    expect(geometry.column).toBeLessThanOrEqual(480);
    expect(geometry.wrapper).toBeGreaterThanOrEqual(geometry.dock - 1);
  });
  for (const viewport of [
    { name: "phone", width: 390, height: 844, keyboard: false },
    { name: "phone keyboard", width: 390, height: 600, keyboard: true },
    { name: "landscape", width: 844, height: 390, keyboard: false },
    { name: "landscape keyboard", width: 844, height: 390, keyboard: true },
    { name: "desktop", width: 1440, height: 900, keyboard: false },
  ]) {
    test(`a long campaign decision expands, keeps new requests waiting, and restores reading position on ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/request-surfaces-e2e.html?scenario=issue-scope&tall=1&follow=1&keyboard=${viewport.keyboard ? 1 : 0}`);
      const reader = page.getByRole("region", { name: "Session Activity" });
      await reader.hover();
      await page.mouse.wheel(0, -400);
      await expect(page.locator(".dock-strip")).toBeVisible();
      await page.getByRole("button", { name: "Expand Request", exact: true }).click();
      await expect(card(page)).toBeVisible();
      const before = await page.locator(".detail-scroll").evaluate((element) => element.scrollTop);
      const toggle = card(page).getByRole("button", { name: "Expand Decision", exact: true });
      await toggle.focus();
      await toggle.click();
      await expect(card(page).getByRole("button", { name: "Collapse Decision" })).toBeFocused();
      await expectReadingMode(page);
      await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.setKeyboard(true));
      await expect(page.locator(".request-dock")).toHaveAttribute("data-keyboard-open", "");
      await expectReadingMode(page);
      await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.setKeyboard(false));
      await expect(page.locator(".request-dock")).not.toHaveAttribute("data-keyboard-open", "");
      await expectReadingMode(page);
      await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.addRequest("budget"));
      await expect(page.locator(".request-dock-more")).toContainText("+1 More Request");
      await expect(card(page).getByRole("heading")).toHaveText("Campaign Issue Scope Approval Required");
      await expectReadingMode(page);
      // The full rationale is reached within the card; its actions stay still.
      await card(page).locator(".request-card-body").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(card(page)).toContainText("Review scope item 12");
      await expectReadingMode(page);
      if (viewport.name === "phone") {
        await page.setViewportSize({ width: 844, height: 390 });
        await expectReadingMode(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await expectReadingMode(page);
      }
      await card(page).getByRole("button", { name: "Collapse Decision" }).click();
      await expect(card(page).getByRole("button", { name: "Expand Decision" })).toBeFocused();
      await expect(page.locator(".detail-main")).toHaveCSS("visibility", "visible");
      await expect(page.locator(".request-dock")).not.toHaveAttribute("data-reading", "");
      await expect.poll(async () => Math.abs(await page.locator(".detail-scroll").evaluate((element) => element.scrollTop) - before)).toBeLessThanOrEqual(1);
      await expect.poll(() => submissions(page)).toEqual([]);
      // Collapse restores the ordinary capped layout while keeping the selected decision.
      const heights = await page.evaluate(() => ({
        column: document.querySelector(".chat-reading")!.getBoundingClientRect().height,
        slot: document.querySelector(".chat-reading > .session-notice-slot")!.getBoundingClientRect().height,
      }));
      expect(heights.slot).toBeLessThanOrEqual(heights.column * 0.6 + 1);
    });
  }

  for (const width of [390, 1440]) {
    test(`evidence review progress and approval requirements survive expansion and collapse at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/request-surfaces-e2e.html?scenario=evidence&items=2");
      await card(page).getByRole("button", { name: "Expand Decision" }).click();
      await expectReadingMode(page);
      const tiles = card(page).locator(".ev-tile");
      await expect(card(page).getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
      await tiles.first().getByRole("link", { name: "Open Link" }).click();
      await tiles.first().locator(".ev-mark").click();
      await expect(card(page).locator(".ev-progress")).toHaveText("1 of 2 reviewed");
      await card(page).getByRole("button", { name: "Collapse Decision" }).click();
      await card(page).getByRole("button", { name: "Expand Decision" }).click();
      await expect(tiles.first().locator('input[type="checkbox"]')).toBeChecked();
      await expect(card(page).locator(".ev-progress")).toHaveText("1 of 2 reviewed");
      await expect(card(page).getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
      await expect.poll(() => submissions(page)).toEqual([]);
      await tiles.last().getByRole("link", { name: "Open Link" }).click();
      await tiles.last().locator(".ev-mark").click();
      await card(page).getByRole("button", { name: "Approve", exact: true }).click();
      await expect(card(page)).toHaveCount(0);
      await expect(page.locator(".detail-main")).toHaveCSS("visibility", "visible");
      await expect.poll(() => submissions(page)).toEqual([{
        requestId: "evidence-occurrence", optionId: "approve", evidenceReviewed: ["viewport-1", "viewport-2"],
      }]);
    });
  }
});
