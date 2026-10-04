import { expect, test } from "@playwright/test";

test.use({ reducedMotion: "reduce" });
const SHOT = "test-results/service-tier";

for (const viewport of [
  { name: "desktop", width: 1200, height: 820 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name}: Service Tier lives in Model Settings and explains every tier`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height - 40}&tiers=legacy`);
    if (viewport.name === "mobile") await page.locator(".composer-idle-preview").click();
    const legacyTrigger = page.getByRole("button", { name: /^Model Settings:/ });
    await legacyTrigger.click();
    await expect(page.getByRole("radiogroup", { name: "Service Tier" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `${SHOT}/${viewport.name}-before.png` });

    await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height - 40}&tiers=1`);
    if (viewport.name === "mobile") await page.locator(".composer-idle-preview").click();

    const trigger = page.getByRole("button", { name: /^Model Settings:/ });
    await expect(trigger).toBeVisible();
    await expect(page.locator('.cbar-trigger[title^="Service Tier:"]')).toHaveCount(0);
    await trigger.click();

    const group = page.getByRole("radiogroup", { name: "Service Tier" });
    await expect(group.getByRole("radio", { name: /Standard/ })).toHaveAttribute("aria-checked", "false");
    await expect(group.getByRole("radio", { name: /Fast/ })).toHaveAttribute("aria-checked", "true");
    // When a change applies is said once, in the footer, not under every tier (#2191).
    await expect(group).toContainText("Standard response speed.");
    await expect(group).toContainText("Faster responses that use more ChatGPT credits.");
    await expect(group).not.toContainText("Applies to the next turn.");
    const dialog = page.getByRole("dialog", { name: "Model Settings" });
    await expect(dialog).toContainText("Changes apply from the next turn.");
    // A column with an icon keeps the slot on every row, so the model lines up with the tiers (§9.1).
    const [modelText, tierText] = await Promise.all([
      dialog.getByRole("radiogroup", { name: "Model" }).locator(".menu-text").first().boundingBox(),
      group.locator(".menu-text").first().boundingBox(),
    ]);
    expect(Math.abs(modelText!.x - tierText!.x)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${SHOT}/${viewport.name}-after-menu.png` });
  });
}
