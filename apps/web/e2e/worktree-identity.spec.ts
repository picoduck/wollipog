import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const capture = process.env.CAPTURE_ISSUE_583 === "1";
const evidenceDir = "test-results/issue-583-evidence";

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
}

/** The session bar holds the session's status; its branch and pull request are summary facts (#2160). */
const sessionBar = (page: Page) => page.locator(".session-bar");
const summary = (page: Page) => page.getByRole("complementary", { name: "Pinned Summary" });

for (const viewport of [
  { name: "desktop", width: 1280, height: 760 },
  { name: "mobile", width: 390, height: 720 },
] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`active worktree identity is visible in Inbox and the Pinned Summary (${viewport.name}, ${theme})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/command-inbox-projects-e2e.html?scenario=worktree-identity");
      await setTheme(page, theme);
      const row = page.getByRole("row", { name: /Alpha Session/ });
      // The row's own line for this (#664). `origin/main` is the conventional default base, so the
      // row omits it and spends the width on the branch.
      const rowWorktree = row.locator(".inbox-row-git");
      await expect(rowWorktree.locator(".inbox-row-branch-name")).toHaveText("fix/session-worktree-identity");
      await expect(rowWorktree.locator(".inbox-row-base")).toHaveCount(0);
      // #2209: a neutral meta item, its icon and its state word.
      await expect(rowWorktree.locator(".inbox-row-pr")).toHaveText("Pull Request: Open");
      await expect(rowWorktree.locator(".inbox-row-pr svg")).toHaveCount(1);
      if (capture) {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: `${evidenceDir}/after-inbox-${viewport.name}-${theme}.png`, fullPage: true });
      }
      await row.click();
      if (viewport.name === "desktop") await page.getByRole("button", { name: "Expand Session" }).click();
      await expect(sessionBar(page)).toBeVisible();
      await expect(sessionBar(page).locator(".session-worktree-identity, .tag-wt")).toHaveCount(0);
      await expect(sessionBar(page).getByRole("link")).toHaveCount(0);
      // The session record's pull request, with its state as the row's value.
      const pullRequest = summary(page).getByRole("link", { name: /Pull Request/ });
      await expect(pullRequest).toHaveAttribute("href", "https://github.com/picoduck/wollipog/pull/600");
      await expect(pullRequest.locator(".v")).toHaveText("Open");
      if (capture) {
        await page.screenshot({ path: `${evidenceDir}/after-header-${viewport.name}-${theme}.png`, fullPage: true });
      }
    });

    test(`baseline omits worktree identity (${viewport.name}, ${theme})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/command-inbox-projects-e2e.html");
      await setTheme(page, theme);
      const row = page.getByRole("row", { name: /Alpha Session/ });
      // #2209: the branch shows only when there is one; no row says "No Branch".
      await expect(row.locator(".inbox-row-git")).toHaveCount(0);
      await expect(row).not.toContainText("No Branch");
      if (capture) {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: `${evidenceDir}/before-inbox-${viewport.name}-${theme}.png`, fullPage: true });
      }
      await row.click();
      if (viewport.name === "desktop") await page.getByRole("button", { name: "Expand Session" }).click();
      await expect(sessionBar(page)).toBeVisible();
      await expect(sessionBar(page).locator(".session-worktree-identity, .tag-wt")).toHaveCount(0);
      if (capture) {
        await page.screenshot({ path: `${evidenceDir}/before-header-${viewport.name}-${theme}.png`, fullPage: true });
      }
    });
  }
}

test("an unsafe worktree PR URL is shown as a fact without a link", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=unsafe-worktree-pr");
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Expand Session" }).click();
  const pullRequest = summary(page).locator(".ps-row", { hasText: "Pull Request" });
  await expect(pullRequest.locator(".v")).toHaveText("Open");
  await expect(summary(page).getByRole("link", { name: /Pull Request/ })).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
});
