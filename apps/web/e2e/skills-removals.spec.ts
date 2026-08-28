import { expect, test } from "@playwright/test";

async function openRemovalHistory(page: import("@playwright/test").Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/skills-removals-e2e.html");
  await page.getByRole("button", { name: /code-review/i }).click();
  await expect(page.getByRole("heading", { name: "Recent Link Removals" })).toBeVisible();
}

test("skill link removals show path, reason, and state timestamp on desktop", async ({ page }) => {
  await openRemovalHistory(page, 1280);

  const history = page.locator(".skills-removals");
  await expect(history).toContainText("~/.codex/skills/retired-skill-with-a-long-name");
  await expect(history).toContainText("No longer in the desired skill list.");
  await expect(history).toContainText("~/.claude/skills/conflicted-canonical-skill");
  await expect(history).toContainText("The canonical location it routes through is conflicted.");
  const reportedAt = await page.evaluate((timestamp) => new Date(timestamp).toLocaleString(), 1_699_999_000_000);
  await expect(history).toContainText(`Reported ${reportedAt}`);
  const inventoryAt = await page.evaluate((timestamp) => new Date(timestamp).toLocaleString(), 1_700_000_000_000);
  await expect(history).not.toContainText(`Reported ${inventoryAt}`);
});

test("skill link removal history wraps without horizontal overflow on mobile", async ({ page }) => {
  await openRemovalHistory(page, 320);

  const geometry = await page.locator(".skills-view").evaluate((view) => ({
    viewRight: view.getBoundingClientRect().right,
    historyRight: view.querySelector(".skills-removals")!.getBoundingClientRect().right,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(geometry.historyRight).toBeLessThanOrEqual(geometry.viewRight + 0.5);
  expect(geometry.documentWidth).toBe(geometry.viewportWidth);
});

test("a healthy long-running manual sync remains visibly in progress", async ({ page }) => {
  await openRemovalHistory(page, 1280);

  const sync = page.locator(".skills-machine").getByRole("button", { name: "Sync Now" });
  await sync.click();
  const progress = page.locator(".skills-machine").getByRole("button", { name: "Syncing…" });
  await expect(progress).toBeVisible();
  await page.waitForTimeout(350);
  await expect(progress).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Recent Link Removals" })).toBeVisible();
  await expect(page.locator(".skills-machine").getByRole("button", { name: "Sync Now" })).toBeVisible({ timeout: 2_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});
