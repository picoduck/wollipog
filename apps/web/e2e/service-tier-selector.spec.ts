import { expect, test } from "@playwright/test";

test.use({ reducedMotion: "reduce" });
const SHOT = "test-results/service-tier";

for (const viewport of [
  { name: "desktop", width: 1200, height: 820 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name}: Fast is visible before opening and the menu explains every tier`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height - 40}&tiers=legacy`);
    await expect(page.locator('.cbar-trigger[title^="Service Tier:"]')).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/${viewport.name}-before.png` });

    await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height - 40}&tiers=1`);

    const trigger = page.locator('.cbar-trigger[title^="Service Tier: Fast"]');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("Fast");
    await trigger.click();

    const group = page.getByRole("group", { name: "Service Tier" });
    await expect(group.getByRole("menuitemradio", { name: /Standard/ })).toHaveAttribute("aria-checked", "false");
    await expect(group.getByRole("menuitemradio", { name: /Fast/ })).toHaveAttribute("aria-checked", "true");
    await expect(group).toContainText("Standard response speed. Applies to the next turn.");
    await expect(group).toContainText("Faster responses that use more ChatGPT credits. Applies to the next turn.");
    await page.screenshot({ path: `${SHOT}/${viewport.name}-after-menu.png` });
  });
}
