import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`scope decision details in the real Inbox and request panel at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1200 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=scope-decisions&fullShell=1");
    await expect(page.getByText("Review Campaign Scope", { exact: true }).first()).toBeVisible();
    await page.getByText("Review Campaign Scope", { exact: true }).first().click();
    const card = page.locator('.request-card').filter({ hasText: "Decisions to Revoke" }).first();
    if (width < 600) await card.getByRole("button", { name: "Expand Decision", exact: true }).click();
    else await page.getByRole("radio", { name: "Preview Right", exact: true }).click();
    await expect(card).toContainText("Merge: picoduck/wollipog#4481 at ce64f53");
    await expect(card).toContainText("Publication: picoduck/wollipog: Preserve Merge Approval History");
    await expect(card.locator("details").filter({ hasText: "Raw Decision IDs" })).not.toHaveAttribute("open");
    await page.mouse.move(width / 2, 250);
    await page.mouse.wheel(0, -10000);
    await page.screenshot({ path: info.outputPath(`inbox-${width}-closed.png`) });
    await card.getByText("Raw Decision IDs", { exact: true }).click();
    await expect(card.getByText("workflow_merge_4481, workflow_publish_retry", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`inbox-${width}-open.png`) });
    if (width > 600) {
      await page.getByRole("button", { name: "Open Session", exact: true }).click();
      await card.getByRole("button", { name: "Expand Decision", exact: true }).click();
      await page.mouse.move(width / 2, 250);
      await page.mouse.wheel(0, -10000);
      await page.screenshot({ path: info.outputPath(`scope-card-${width}.png`) });
    }
  });
}
