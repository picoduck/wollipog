import { expect, test, type Page } from "@playwright/test";

async function assertNoHorizontalOverflow(page: Page, selector: string) {
  const geometry = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

test("legacy inline evidence fixture reproduces the mobile over-height review", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/request-surfaces-e2e.html?scenario=legacy");
  await page.getByRole("button", { name: "Details" }).click();
  const approval = page.locator(".approval-bar");
  await expect(approval).toBeVisible();
  const bounds = await approval.boundingBox();
  expect(bounds!.height).toBeGreaterThan(844 * 0.7);
  const transcriptHeight = await page.getByRole("region", { name: "Session Activity" })
    .evaluate((element) => element.clientHeight);
  expect(transcriptHeight).toBeLessThan(120);
});

for (const viewport of [
  { name: "mobile portrait", width: 390, height: 844 },
  { name: "mobile landscape", width: 844, height: 390 },
  { name: "desktop", width: 1280, height: 800 },
  { name: "desktop split pane", width: 900, height: 700 },
]) {
  test(`eight-item evidence review remains reachable at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=evidence");
    const transcript = page.getByRole("region", { name: "Session Activity" });
    await expect(transcript).toBeVisible();
    const initialHeight = await transcript.evaluate((element) => element.clientHeight);
    expect(initialHeight).toBeGreaterThan(Math.min(220, viewport.height * 0.35));
    await expect(page.locator(".approval-bar")).toHaveCount(0);

    const trigger = page.getByRole("button", { name: "Review Evidence" });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const panel = page.getByRole("complementary", { name: "Requests" });
    await expect(panel).toBeVisible();
    await expect(page.getByRole("button", { name: "Close Panel" })).toBeVisible();
    await expect(page.getByRole("status", { name: "" })).toContainText("0 of 8 Reviewed");
    await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
    await expect(page.locator(".evidence-review-item")).toHaveCount(8);
    await expect(page.locator(".approval-context")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("signature=hidden");
    await assertNoHorizontalOverflow(page, ".request-panel");

    if (viewport.width <= 760) {
      const overflow = await page.locator(".request-panel").evaluate((element) => ({
        own: getComputedStyle(element).overflowY,
        list: getComputedStyle(element.querySelector(".evidence-review-list")!).overflowY,
      }));
      expect(overflow.own).toBe("auto");
      expect(overflow.list).toBe("visible");
    } else {
      const bounds = await page.locator(".detail-chat, .right-panel").evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().toJSON()));
      expect(bounds[0]!.width).toBeGreaterThan(300);
      expect(bounds[1]!.width).toBeLessThanOrEqual(Math.floor(viewport.width * 0.4) + 1);
    }

    const checks = page.locator('.evidence-review-item input[type="checkbox"]');
    for (let index = 0; index < 3; index += 1) await checks.nth(index).check();
    await expect(page.locator(".evidence-review-summary").getByRole("status")).toContainText("3 of 8 Reviewed");
    await page.getByRole("button", { name: "Close Panel" }).click();
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.setViewportSize(viewport.width <= 760
      ? { width: viewport.height, height: viewport.width }
      : viewport);
    await trigger.click();
    await expect(page.locator(".evidence-review-summary").getByRole("status")).toContainText("3 of 8 Reviewed");
    for (let index = 3; index < 8; index += 1) await checks.nth(index).check();
    await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => page.evaluate(() =>
      window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([{
        requestId: "evidence-occurrence",
        optionId: "approve",
        evidenceReviewed: Array.from({ length: 8 }, (_, index) => `viewport-${index + 1}`),
      }]);
  });
}

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
]) {
  test(`high-count descendant requests use one inbox on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=descendants");
    await expect(page.locator(".descendant-request-region")).toHaveCount(0);
    const trigger = page.getByRole("button", { name: "Needs Your Input: 8 Requests" });
    await expect(trigger).toBeVisible();
    await expect(page.getByRole("button", { name: "Orchestrator Action: 4 Requests" })).toBeVisible();
    await trigger.click();
    await expect(page.locator(".request-panel-row")).toHaveCount(12);
    await expect(page.locator(".request-panel-count")).toContainText("Needs Your Input 8");
    await expect(page.locator(".request-panel-count")).toContainText("Orchestrator Action 4");
    await assertNoHorizontalOverflow(page, ".request-panel");

    const rows = page.locator(".request-panel-row");
    await rows.nth(8).scrollIntoViewIfNeeded();
    await rows.nth(8).click();
    await expect(page.locator(".request-owner")).toHaveText("Assigned to Orchestrator");
    await expect(page.locator(".request-readonly")).toContainText(
      "must respond through its session-management tools",
    );
    await expect(page.locator(".request-readonly .approval-actions")).toHaveCount(0);
    await page.getByRole("button", { name: "Open Child Session" }).click();
    await expect.poll(() => page.evaluate(() =>
      window.__WOLLIPOG_REQUEST_SURFACES_E2E__.openedChild()?.sessionId)).toBe("child-3");

    await rows.nth(11).scrollIntoViewIfNeeded();
    await expect(rows.nth(11)).toBeVisible();
    await page.getByRole("button", { name: "Close Panel" }).click();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(rows.nth(8)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: "Requests" })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}
