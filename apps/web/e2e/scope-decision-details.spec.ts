import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`settled scope decisions survive refresh in Inbox and session dock at ${width}px (#4601)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1200 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=scope-decisions&fullShell=1&settled=1");
    await page.reload();
    await page.getByText("Review Campaign Scope", { exact: true }).first().click();
    let card = page.locator(".request-card").filter({ hasText: "Decisions to Revoke" }).first();
    if (width < 600) await card.getByRole("button", { name: "Expand Decision", exact: true }).click();
    else await page.getByRole("radio", { name: "Preview Right", exact: true }).click();
    const check = async () => {
      await expect(card).toContainText("Merge: picoduck/wollipog#4481 at ce64f53 — Already Settled (consumed); approval no longer affects it");
      await expect(card).toContainText("Publication: picoduck/wollipog: Preserve Merge Approval History — Pending approval");
      await expect(card).not.toContainText("refresh before approving");
      await expect(card).not.toContainText("armed for the merge queue");
      await expect(card.locator("details").filter({ hasText: "Raw Decision IDs" })).not.toHaveAttribute("open");
      await card.locator(".request-card-body").hover();
      await page.mouse.wheel(0, -10000);
      await expect.poll(() => card.locator(".request-card-body").evaluate(element => element.scrollTop)).toBe(0);
    };
    await check();
    // Phones open the session directly from Inbox; only desktop has an Inbox preview.
    if (width > 600) {
      await page.screenshot({ path: info.outputPath(`settled-inbox-${width}.png`) });
      await page.getByRole("button", { name: "Open Session", exact: true }).click();
    }
    card = page.locator(".request-dock .request-card").filter({ hasText: "Decisions to Revoke" }).first();
    const expand = card.getByRole("button", { name: "Expand Decision", exact: true });
    if (await expand.isVisible()) await expand.click();
    await check();
    await page.screenshot({ path: info.outputPath(`settled-dock-${width}.png`) });
  });
}

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
