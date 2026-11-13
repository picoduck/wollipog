import { expect, test } from "@playwright/test";

for (const [name, viewport] of [["Desktop", { width: 1440, height: 1000 }], ["Phone", { width: 390, height: 844 }]] as const) {
  test(`${name}: campaign pause, scheduled resume, in-flight merge, and recorded resume`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&pause=timed");
    const section = page.locator(".campaign-detail-section").filter({ has: page.getByRole("heading", { name: "Campaign Pause", exact: true }) });
    await expect(page.locator(".campaign-status-summary")).toContainText("Paused");
    await expect(section).toContainText("Armed and queued merges stay in flight.");
    await expect(section).toContainText("Sam Owner");
    await page.locator(".campaign-status").hover();
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => page.locator(".campaign-status").evaluate(element => element.scrollTop)).toBe(0);
    await expect(section.getByRole("heading", { name: "Campaign Pause", exact: true })).toBeInViewport();
    if (process.env.CAMPAIGN_PAUSE_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.CAMPAIGN_PAUSE_EVIDENCE_DIR}/${name.toLowerCase()}-paused.png` });
    await section.getByRole("button", { name: "Resume Campaign", exact: true }).click();
    await expect(section).toContainText("Resumed");
    await expect(section.getByRole("button", { name: "Pause Campaign", exact: true })).toBeVisible();
    await page.locator(".campaign-status").hover();
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => page.locator(".campaign-status").evaluate(element => element.scrollTop)).toBe(0);
    await expect(section.getByRole("heading", { name: "Campaign Pause", exact: true })).toBeInViewport();
    if (process.env.CAMPAIGN_PAUSE_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.CAMPAIGN_PAUSE_EVIDENCE_DIR}/${name.toLowerCase()}-resumed.png` });
    await section.getByRole("button", { name: "Pause Campaign", exact: true }).click();
    await expect(section).toContainText("When the owner resumes");
    await page.locator(".campaign-status").hover();
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => page.locator(".campaign-status").evaluate(element => element.scrollTop)).toBe(0);
    await expect(section.getByRole("heading", { name: "Campaign Pause", exact: true })).toBeInViewport();
    if (process.env.CAMPAIGN_PAUSE_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.CAMPAIGN_PAUSE_EVIDENCE_DIR}/${name.toLowerCase()}-manual.png` });
    expect(await page.locator(".campaign-status").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });
}
