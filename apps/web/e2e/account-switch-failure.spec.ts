import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
test.use({ video: evidenceDir ? "on" : "off" });

for (const width of [390, 1280]) for (const theme of ["dark", "light"] as const) {
  test(`a failed account switch can be dismissed and the composer edited at ${width}px in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/session-usage-e2e.html?composer=claude&account-switch-failure=1");
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);

    const banner = page.getByRole("status", { name: "Account Switch Failed" });
    const composer = page.locator(".composer-input");
    await expect(banner).toBeVisible();
    await expect(composer).toBeDisabled();
    if (evidenceDir) {
      await page.waitForTimeout(2_000);
      await page.screenshot({ path: join(evidenceDir, `before-${width}-${theme}.png`), fullPage: true });
      await page.waitForTimeout(1_000);
    }

    await banner.getByRole("button", { name: "Dismiss Notice" }).click();
    await expect(banner).toHaveCount(0);
    await expect(composer).toBeEnabled();
    if (width < 768) await page.getByRole("button", { name: /^Edit Message:/ }).click();
    await composer.fill("Continue the campaign");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Continue the campaign");
    if (evidenceDir) {
      await page.waitForTimeout(2_000);
      await page.screenshot({ path: join(evidenceDir, `after-${width}-${theme}.png`), fullPage: true });
      await page.waitForTimeout(3_000);
    }
  });
}
