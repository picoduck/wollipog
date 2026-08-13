import { expect, test, type Page } from "@playwright/test";

async function expectProgressFacts(page: Page) {
  // The progress facts live in the transcript's merged Working row, not a separate card.
  const progress = page.getByRole("region", { name: "Active Turn Progress" });
  await expect(progress).toBeVisible();
  await expect(progress.getByRole("status").filter({ hasText: "Waiting" })).toHaveText("Waiting for Approval");
  await expect(progress.getByRole("button", { name: "Coordinate Release Audit" })).toBeVisible();
  await expect(progress).toContainText("Plan StepValidate compatibility release");
  await expect(progress).toContainText("Elapsed7m 0s");
  await expect(progress).toContainText("Last Activity1m Ago");
  await expect(progress).toContainText("Completed1");
  await expect(progress).toContainText("Failed3");
  await expect(progress).toContainText("Retried 2 Times");
  await expect(progress.getByRole("button", { name: "Open Subagent" })).toBeVisible();
  return progress;
}

async function expectRetryTruncated(page: Page) {
  const retry = page.locator(".tl-working-retry");
  const error = retry.locator("span");
  await expect(error).toBeVisible();
  await expect(retry).toHaveAttribute("title", /compatibility marker/);
  await expect.poll(() => error.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(() => page.getByTestId("reader").evaluate((reader) => reader.scrollWidth <= reader.clientWidth + 1)).toBe(true);
}

test("the merged working row shows observable progress and links to transcript and Subagents", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/active-turn-progress-e2e.html");
  const progress = await expectProgressFacts(page);
  await expectRetryTruncated(page);
  await expectNoHorizontalOverflow(page);

  await progress.getByRole("button", { name: "Coordinate Release Audit" }).click();
  const target = page.locator("[aria-current='location']");
  await expect(target).toBeVisible();
  await expect(target).toContainText("Coordinate Release Audit");
  await expect.poll(() => target.evaluate((element) => element === document.activeElement)).toBe(true);
  await expect(target).toBeInViewport();

  await progress.getByRole("button", { name: "Open Subagent" }).click();
  await expect(page.getByTestId("opened-subagent")).toHaveText("release-audit-agent");
});

test("the merged working row remains compact and readable in a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/active-turn-progress-e2e.html");
  const progress = await expectProgressFacts(page);
  await expectRetryTruncated(page);
  await expectNoHorizontalOverflow(page);

  const bounds = await progress.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeLessThanOrEqual(366);
  expect(bounds!.height).toBeLessThan(250);

  await progress.getByRole("button", { name: "Coordinate Release Audit" }).click();
  await expect(page.locator("[aria-current='location']")).toBeInViewport();
  await progress.getByRole("button", { name: "Open Subagent" }).click();
  await expect(page.getByTestId("opened-subagent")).toHaveText("release-audit-agent");
});
