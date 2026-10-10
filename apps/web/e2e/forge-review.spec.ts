import { expect, test } from "@playwright/test";

test("GitLab review surfaces use merge-request terminology and provenance", async ({ page }) => {
  await page.goto("/forge-review-e2e.html?theme=dark");
  const commitBar = page.getByRole("region", { name: "Commit" });
  await expect(commitBar.getByRole("button", { name: "Open Merge Request…" })).toBeVisible();
  await commitBar.getByRole("button", { name: "Open Merge Request…" }).click();
  const dialog = page.getByRole("dialog", { name: "Open Merge Request" });
  await expect(dialog.getByRole("button", { name: "Open Merge Request" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Sync GitLab" })).toBeVisible();
  // Provenance in words (#2850): the forge login and its forge, never a scope or a diff side.
  const findings = page.getByRole("region", { name: "Findings" });
  await expect(findings.locator(".review-finding-meta").first()).toHaveText("reviewer on GitLab · 1h ago");
  await expect(findings).not.toContainText("All Branch");
  await expect(findings).not.toContainText("Right");
  await expect(findings.getByText("Merge request discussion", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Remote Discussion" })).toBeVisible();
  await expect(findings.getByRole("link", { name: "Resolve on GitLab" }).first()).toHaveAttribute(
    "href",
    "https://gitlab.example.test/team/sub/wollipog/-/merge_requests/19#note_119",
  );
  await expect(findings).not.toContainText("Remote-Owned");
});

test("a pre-v106 runner retains the legacy generic-Git action surface", async ({ page }) => {
  await page.goto("/forge-review-e2e.html?legacy=1");
  await expect(page.getByRole("region", { name: "Commit" }).getByRole("button", { name: "Open Pull Request…" })).toBeVisible();
  // That runner reports no forge, and a self-hosted remote is plain Git to it: nothing to sync (#2850).
  await expect(page.getByRole("region", { name: "Findings" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Sync / })).toHaveCount(0);
});
