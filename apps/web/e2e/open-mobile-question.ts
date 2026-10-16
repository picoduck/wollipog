import { expect, type Page } from "@playwright/test";

/** Open the mobile question strip before testing its answer controls. */
export async function openMobileQuestion(page: Page, requestId?: string) {
  if (requestId) {
    await page.locator(`.request-dock [data-session-request-id="${requestId}"], .composer-answer`).first().waitFor({ state: "attached" });
  }
  const strip = page.locator('.request-dock[data-collapsed] .dock-strip');
  if (!await strip.isVisible()) return;
  await strip.getByRole("button", { name: "Expand Request", exact: true }).click();
  await expect(page.locator(".request-dock .question-card")).toBeVisible();
}
