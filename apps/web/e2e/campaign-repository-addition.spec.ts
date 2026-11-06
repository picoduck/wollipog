import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

for (const width of [1440, 390]) {
  for (const outcome of ["approve", "deny"]) {
    test(`a repository addition shows the inspected Location and the Orchestrator's quoted reason, then sends ${outcome} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/request-surfaces-e2e.html?scenario=repository-addition");
      const details = page.getByRole("region", { name: "Add Repository Details" });
      await expect(details).toBeVisible();
      for (const text of ["Location", "Docs Site", "Repository", "acme/docs", "Follow-Up", "Fix the Broken Install Link", "Orchestrator's Reason",
        "Approving adds this repository to the campaign"]) await expect(details).toContainText(text);
      await expect(details.locator("q")).toHaveText("The follow-up fixes the install link in the documentation repository.");
      if (evidenceDir && outcome === "approve") {
        await page.screenshot({ path: join(evidenceDir, `repository-addition-${width}.png`), fullPage: true });
        // A tall window gives the docked card room to show its whole body in one capture.
        await page.setViewportSize({ width, height: 1400 });
        await page.screenshot({ path: join(evidenceDir, `repository-addition-tall-${width}.png`), fullPage: true });
      }
      const foot = page.locator(".request-dock .request-card-foot");
      await foot.getByRole("button", { name: outcome === "approve" ? /^Approve/ : /^Deny/ }).click();
      await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([
        { requestId: "evidence-occurrence", optionId: outcome },
      ]);
    });
  }
}
