import { expect, test } from "@playwright/test";

test("workspace paths and exact diff lines become inspectable prompt attachments", async ({ page }) => {
  await page.goto("/workspace-references-e2e.html?state=after&theme=dark");
  await expect(page.getByRole("listbox", { name: "Workspace Paths" })).toBeVisible();
  await page.getByRole("option", { name: /src\/session\.ts/ }).click();
  await expect(page.getByRole("button", { name: /Inspect Workspace Reference src\/session\.ts$/ })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select worktree line 19 for prompt" }).check();
  await page.getByRole("checkbox", { name: "Select worktree line 20 for prompt" }).check();
  await page.getByRole("button", { name: "Attach Selected (2)" }).click();
  await expect(page.getByRole("button", { name: /Inspect Workspace Reference src\/session\.ts:19-20 · Worktree/ })).toBeVisible();
});
