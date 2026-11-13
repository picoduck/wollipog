import { expect, test } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

for (const viewport of [{ name: "desktop", width: 1440, height: 1100 }, { name: "phone", width: 390, height: 844 }]) {
  for (const [kind, title] of [["landed", "Unapproved Issue Closures"], ["unverified", "Merge Could Not Be Verified"], ["not_dequeued", "Merge Could Not Be Dequeued"]]) {
    test(`${viewport.name} ${kind} report can be acknowledged without a running root`, async ({ page }) => {
      await page.setViewportSize(viewport);
      let acknowledgedAt: number | null = null;
      const material = "Pull request: https://github.com/picoduck/wollipog/pull/4610\nIssues: picoduck/wollipog#4551\nForge description: \"Closes #4551\"";
      await page.route("**/api/campaign-closure-reports", route => route.fulfill({ json: { reports: [{
        occurrenceId: "merge_4610", campaignId: "campaign_owner", kind, createdAt: Date.parse("2026-11-13T16:30:00Z"),
        acknowledgedAt, question: kind === "landed" ? "The merge closed picoduck/wollipog#4551 without approval."
          : kind === "unverified" ? "The merge could not be verified. Review the pull request and issues."
          : "The changed merge could not be removed from the queue. Review the pull request and issues.", material,
      }] } }));
      await page.route("**/api/campaign-closure-reports/*/*/acknowledge", route => {
        acknowledgedAt = Date.parse("2026-11-13T16:45:00Z");
        return route.fulfill({ json: { ok: true } });
      });
      await page.goto("/command-inbox-projects-e2e.html?fullShell=1&scenario=closure-reports");
      const entry = page.getByRole("region", { name: "Campaign Reports" });
      await expect(entry.getByRole("button", { name: title, exact: true })).toBeVisible();
      await entry.getByRole("button", { name: title, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toContainText("picoduck/wollipog#4551");
      await expect(dialog.getByRole("button", { name: "Acknowledge", exact: true })).toBeVisible();
      await dialogMotionSettled(page);
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.mouse.wheel(0, -10000);
      if (process.env.CAPTURE_4551) await page.screenshot({ path: `evidence/4551-${viewport.name}-${kind}.png` });
      await dialog.getByRole("button", { name: "Acknowledge", exact: true }).click();
      await expect(dialog.getByRole("status")).toHaveText("Acknowledged");
      if (process.env.CAPTURE_4551) await page.screenshot({ path: `evidence/4551-${viewport.name}-${kind}-acknowledged.png` });
      await expect(dialog.getByRole("button", { name: "Acknowledge", exact: true })).toHaveCount(0);
    });
  }
}
