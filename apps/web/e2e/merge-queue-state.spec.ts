import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

/** #604: merge-queue state in the Review panel's request summary and on Inbox rows. */
const capture = process.env.CAPTURE_604 === "1";
// Playwright clears test-results/ between runs, so evidence goes beside the report.
const evidenceDir = "playwright-report/issue-604-evidence";

for (const theme of ["dark", "light"] as const) {
  test(`the Review panel shows a queued and a removed pull request (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.goto(`/forge-review-e2e.html?queue=queued&theme=${theme}`);
    const request = page.getByRole("group", { name: "Pull Request", exact: true });
    await expect(request.locator(".review-pr-meta .status")).toHaveText("In Merge Queue");
    await expect(request).toContainText("In the merge queue at position 2; its merge-group checks are running.");
    await expect(request).toContainText("Queue Position");
    await expect(request).toContainText("Merge Group Checks");
    if (capture) {
      await mkdir(evidenceDir, { recursive: true });
      await request.screenshot({ path: `${evidenceDir}/review-queued-${theme}.png` });
    }
    await page.goto(`/forge-review-e2e.html?queue=removed&theme=${theme}`);
    const removed = page.getByRole("group", { name: "Pull Request", exact: true });
    await expect(removed.locator(".review-pr-meta .status")).toHaveText("Removed from Merge Queue");
    await expect(removed).toContainText("GitHub removed this pull request from the merge queue because a merge-group check failed.");
    await expect(removed).not.toContainText("Queue Position");
    if (capture) await removed.screenshot({ path: `${evidenceDir}/review-removed-${theme}.png` });
  });
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 760 },
  { name: "mobile", width: 390, height: 720 },
] as const) {
  test(`Inbox rows show a queued and a removed pull request without opening the session (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/command-inbox-projects-e2e.html?scenario=merge-queue");
    const pr = (title: RegExp) => page.getByRole("row", { name: title }).locator(".inbox-row-pr");
    await expect(pr(/Speed Up Checkout/)).toHaveText("Pull Request: In Merge Queue");
    await expect(pr(/Retry Flaky Uploads/)).toHaveText("Pull Request: Dequeued: Check Failed");
    // The reason fits a phone row, not just a desktop one: the row's Git line clips its overflow.
    const label = pr(/Retry Flaky Uploads/).locator(".status");
    expect(await label.evaluate((node) => {
      const line = node.closest(".inbox-row-git")!.getBoundingClientRect();
      return node.getBoundingClientRect().right <= line.right + 0.5;
    })).toBe(true);
    await expect(pr(/Retry Flaky Uploads/).locator(".status")).toHaveClass(/danger/u);
    await expect(pr(/Retry Flaky Uploads/)).toHaveAttribute("title", /because a merge-group check failed/u);
    await expect(pr(/Tidy Settings Copy/)).toHaveText("Pull Request: Open");
    if (capture) {
      await mkdir(evidenceDir, { recursive: true });
      await page.screenshot({ path: `${evidenceDir}/inbox-${viewport.name}.png` });
    }
  });
}
