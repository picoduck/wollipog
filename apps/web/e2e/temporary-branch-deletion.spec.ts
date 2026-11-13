import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  for (const state of ["receipted", "unproven", "owner-kept", "unavailable", "boundary"] as const) {
    const missing = state === "unproven";
    test(`temporary branch deletion ${viewport.width}px ${state}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.goto(`/request-surfaces-e2e.html?scenario=temporary-branch${missing ? "&missing=1" : state === "owner-kept" ? "&owner=1" : state === "unavailable" ? "&unavailable=1" : state === "boundary" ? "&boundary=1" : ""}`);
      await page.getByRole("button", { name: "Expand Decision", exact: true }).click();
      const summary = page.locator(".request-card-body");
      await expect(summary.getByText(missing ? "Requested Tip" : "Created Tip", { exact: true })).toBeVisible();
      await expect(summary.getByText("b587f97abc0ff007a1620f7c5385388e251b9860", { exact: true })).toBeVisible();
      await expect(summary.getByText("Merge Commit", { exact: true })).toHaveCount(0);
      if (missing) await expect(summary.getByText(/Orchestrator cannot delete/)).toBeVisible();
      else {
        await expect(summary.getByText(/Contained in main at/)).toBeVisible();
        await expect(summary.locator("dd").filter({ hasText: "Campaign Worktree Retirement" })).toBeVisible();
        await expect(summary.getByText(state === "owner-kept" ? /This campaign keeps branch deletion with you/
          : state === "unavailable" ? /campaign runner is too old/
            : state === "boundary" ? /outside the campaign's current approved boundary/ : /Orchestrator may delete/)).toBeVisible();
        if (state === "owner-kept") await expect(page.getByRole("heading", { name: "Owner Decision: Delete Temporary Branch", exact: true })).toBeVisible();
        if (state === "unavailable" || state === "boundary") {
          await expect(page.getByRole("heading", { name: "Delegation Unavailable: Delete Temporary Branch", exact: true })).toBeVisible();
          await expect(summary.getByText(/This campaign keeps branch deletion with you/)).toHaveCount(0);
        }
      }
      await expect(page.getByText("Request Details", { exact: true })).toBeVisible();
      if (viewport.width === 390) await expect(page.getByRole("navigation", { name: "Primary Navigation" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: process.env.CAMPAIGN_UI_EVIDENCE_DIR
        ? `${process.env.CAMPAIGN_UI_EVIDENCE_DIR}/temporary-${viewport.width}-${state}.png`
        : info.outputPath("temporary-deletion.png"), fullPage: true });
    });
  }
}
