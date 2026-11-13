import { expect, test } from "@playwright/test";

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 1000 }]] as const) {
  test(`uncertain closure recovery names its occurrence and opens an owner question, ${label}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.clock.install({ time: new Date("2026-01-01T12:00:00Z") });
    await page.goto("/campaign-status-e2e.html?scenario=campaign&owners=after&closureRecovery=owner");
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    const waiting = page.locator(".campaign-status section", { has: page.getByRole("heading", { name: "Waiting for You" }) });
    await expect(waiting).toContainText("picoduck/wollipog#4398 (occurrence closure_4398)");
    await expect(waiting.getByRole("button", { name: /Open Request/ })).toHaveCount(1);
    await waiting.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`closure-waiting-${label}.png`) });
    await waiting.getByRole("button", { name: /Open Request: Review the uncertain closure/ }).click();
    const detail = page.locator(".request-dock");
    await expect(detail).toContainText("acknowledge the uncertainty and clear this recovery record");
    await expect(detail).toContainText("does not close the issue, post a comment, or authorize another attempt");
    await expect(page.getByRole("radio", { name: "Acknowledge Outcome", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
    await expect(detail.getByRole("link", { name: "picoduck/wollipog/issues/4398", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss", exact: true }).scrollIntoViewIfNeeded();
    const actionRect = await page.getByRole("button", { name: "Dismiss", exact: true }).boundingBox();
    expect(actionRect!.y + actionRect!.height).toBeLessThan(viewport.height - (label === "phone" ? 50 : 0));
    await page.screenshot({ path: info.outputPath(`closure-owner-${label}.png`) });
    // One typed request has a suggested-answer step and an optional-note step on main.
    await page.getByRole("radio", { name: "Acknowledge Outcome", exact: true }).check();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Anything to add for the Orchestrator?", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit Answers", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Submit Answers", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`closure-optional-note-${label}.png`) });
    const geometry = await detail.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&activity=complete&closureRecovery=settled");
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    await expect(page.locator(".campaign-status-summary")).toContainText("Campaign Complete");
    await expect(page.getByRole("heading", { name: "Waiting for You" })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`closure-settled-${label}.png`) });
  });
}
