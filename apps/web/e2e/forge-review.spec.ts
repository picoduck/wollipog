import { expect, test } from "@playwright/test";

test("GitLab review surfaces use merge-request terminology and provenance", async ({ page }) => {
  await page.goto("/forge-review-e2e.html?theme=dark");
  await expect(page.getByRole("group", { name: "Open a Merge Request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Push & Open Merge Request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync GitLab" })).toBeVisible();
  await expect(page.getByText("GitLab · reviewer · All Branch · Right").first()).toBeVisible();
  await expect(page.getByText("Remote Discussion", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Remote Discussion" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open on GitLab" }).first()).toHaveAttribute(
    "href",
    "https://gitlab.example.test/team/sub/wollipog/-/merge_requests/19#note_119",
  );
});

test("a pre-v106 runner retains the legacy generic-Git action surface", async ({ page }) => {
  await page.goto("/forge-review-e2e.html?legacy=1");
  await expect(page.getByRole("group", { name: "Open a Pull Request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync GitHub" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Push & Open Pull Request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync GitLab" })).toHaveCount(0);
});
