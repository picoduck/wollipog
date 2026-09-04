import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const capture = process.env.CAPTURE_ISSUE_583 === "1";
const evidenceDir = "test-results/issue-583-evidence";

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 760 },
  { name: "mobile", width: 390, height: 720 },
] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`active worktree identity is visible in Inbox and Session header (${viewport.name}, ${theme})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/command-inbox-projects-e2e.html?scenario=worktree-identity");
      await setTheme(page, theme);
      const row = page.getByRole("row", { name: /Alpha Session/ });
      // The row's own line for this (#664). `origin/main` is the conventional default base, so the
      // row omits it and spends the width on the branch; the header below still spells it out.
      const rowWorktree = row.locator(".inbox-row-worktree");
      await expect(rowWorktree.locator(".inbox-row-branch")).toHaveText("fix/session-worktree-identity");
      await expect(rowWorktree.locator(".inbox-row-base")).toHaveCount(0);
      await expect(rowWorktree.locator(".inbox-row-pr-pill")).toHaveText("Open PR");
      if (capture) {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: `${evidenceDir}/after-inbox-${viewport.name}-${theme}.png`, fullPage: true });
      }
      await row.click();
      if (viewport.name === "desktop") await page.getByRole("button", { name: "Expand Session" }).click();
      const identity = page.locator(".detail-head > .session-worktree-identity");
      await expect(identity).toHaveText("fix/session-worktree-identity ← origin/main · Open PR");
      await expect(identity).toHaveAttribute("href", "https://github.com/picoduck/wollipog/pull/600");
      await expect(identity).toHaveAttribute("title", /Base: origin\/main.*PR: https:\/\/github\.com\/picoduck\/wollipog\/pull\/600/);
      if (capture) {
        await page.screenshot({ path: `${evidenceDir}/after-header-${viewport.name}-${theme}.png`, fullPage: true });
      }
    });

    test(`baseline omits worktree identity (${viewport.name}, ${theme})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/command-inbox-projects-e2e.html");
      await setTheme(page, theme);
      const row = page.getByRole("row", { name: /Alpha Session/ });
      await expect(row.locator(".inbox-row-worktree")).toHaveCount(0);
      if (capture) {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: `${evidenceDir}/before-inbox-${viewport.name}-${theme}.png`, fullPage: true });
      }
      await row.click();
      if (viewport.name === "desktop") await page.getByRole("button", { name: "Expand Session" }).click();
      await expect(page.locator(".detail-head > .session-worktree-identity")).toHaveCount(0);
      if (capture) {
        await page.screenshot({ path: `${evidenceDir}/before-header-${viewport.name}-${theme}.png`, fullPage: true });
      }
    });
  }
}

test("an unsafe worktree PR URL is shown as identity text without a link", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=unsafe-worktree-pr");
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Expand Session" }).click();
  const identity = page.locator(".detail-head > .session-worktree-identity");
  await expect(identity).toHaveText("fix/session-worktree-identity ← origin/main · Open PR");
  await expect(identity).not.toHaveAttribute("href", /.+/u);
});
