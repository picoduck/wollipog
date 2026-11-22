import { expect, test } from "@playwright/test";

test.use({ reducedMotion: "reduce" });
const SHOT = "test-results/service-tier";

for (const viewport of [
  { name: "desktop", width: 1200, height: 820 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name}: Speed reveals its choices, explains pricing, and restores focus on selection`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height - 40}&tiers=legacy`);
    if (viewport.name === "mobile") await page.locator(".composer-idle-preview").click();
    const legacyTrigger = page.getByRole("button", { name: /^Model Settings:/ });
    await legacyTrigger.click();
    await expect(page.getByRole("button", { name: /^Speed:/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `${SHOT}/${viewport.name}-before.png` });

    await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height - 40}&tiers=1`);
    if (viewport.name === "mobile") await page.locator(".composer-idle-preview").click();

    const trigger = page.getByRole("button", { name: /^Model Settings:/ });
    await expect(trigger).toBeVisible();
    await expect(page.locator('.cbar-trigger[title^="Service Tier:"]')).toHaveCount(0);
    await trigger.click();

    const dialog = page.getByRole("dialog", { name: "Model Settings" });
    const speed = dialog.getByRole("button", { name: "Speed: Fast", exact: true });
    const group = dialog.getByRole("radiogroup", { name: "Speed" });
    await expect(speed).toBeInViewport();
    await expect(dialog.getByRole("searchbox", { name: "Search Models" })).toBeInViewport();
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    await expect(group).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/${viewport.name}-after-menu.png` });
    await speed.click();
    await expect(dialog.getByRole("button", { name: "Back to Model Settings" })).toBeFocused();
    await expect(dialog.getByRole("radiogroup", { name: "Model" })).toHaveCount(0);
    await expect(group.getByRole("radio", { name: /Standard/ })).toHaveAttribute("aria-checked", "false");
    await expect(group.getByRole("radio", { name: /Fast/ })).toHaveAttribute("aria-checked", "true");
    // When a change applies is said once, in the footer, not under every tier (#2191).
    await expect(group).toContainText("Standard response speed.");
    await expect(group).toContainText("Faster responses that use more ChatGPT credits.");
    await expect(group).not.toContainText("Applies to the next turn.");
    await expect(dialog).toContainText("Changes apply from the next turn.");
    await page.screenshot({ path: `${SHOT}/${viewport.name}-speed.png` });
    await page.keyboard.press("Escape");
    await expect(speed).toBeFocused();
    await speed.press("Enter");
    await group.getByRole("radio", { name: "Standard", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Speed: Standard", exact: true })).toBeFocused();
    await expect(group).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __configPatches?: unknown[] }).__configPatches))
      .toEqual([{ serviceTier: "default" }]);
  });
}
