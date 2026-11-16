import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/** #604: the gated Enqueue for Merge / Merge Pull Request action in the Review panel's request summary. */
const capture = process.env.CAPTURE_604 === "1";
// Playwright clears test-results/ between runs, so evidence goes beside the report.
const evidenceDir = "playwright-report/issue-604-action-evidence";

const request = (page: Page, name = "Pull Request") => page.getByRole("group", { name, exact: true });

async function shoot(page: Page, name: string, target = request(page)) {
  if (!capture) return;
  await mkdir(evidenceDir, { recursive: true });
  await target.screenshot({ path: `${evidenceDir}/${name}.png` });
}

test("an open gate enqueues after confirming the exact head, then reads back as queued", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/forge-review-e2e.html?merge=ready&theme=dark");
  const action = request(page).getByRole("button", { name: "Enqueue for Merge", exact: true });
  await expect(action).toBeEnabled();
  await shoot(page, "action-ready-dark");
  await action.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("GitHub adds pull request #4601 to the main merge queue at this head");
  await expect(dialog).toContainText("The branch is not deleted.");
  await expect(dialog).toContainText("4601c0de".padEnd(40, "0"));
  await shoot(page, "action-confirm-dark", dialog);
  await dialog.getByRole("button", { name: "Enqueue for Merge", exact: true }).click();
  await expect(request(page).getByRole("status")).toHaveText("Added to the merge queue at position 3.");
  await expect(action).toBeDisabled();
  await expect(request(page)).toContainText("This pull request is already in the merge queue.");
  await shoot(page, "action-enqueued-dark");
});

test("a failing gate disables the action and lists every reason", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/forge-review-e2e.html?merge=blocked&theme=light");
  const action = request(page).getByRole("button", { name: "Enqueue for Merge", exact: true });
  await expect(action).toBeDisabled();
  for (const reason of [
    "Merging requires an Admin or Owner role.",
    "Resolve the open Required finding first.",
    "Required checks haven't passed on the current head yet: Typecheck, Test & Sidecar Bundle.",
  ]) await expect(request(page)).toContainText(reason);
  await shoot(page, "action-blocked-light");
});

test("without a merge queue the action merges directly with the repository's method", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/forge-review-e2e.html?merge=direct&theme=dark");
  await expect(request(page).locator(".review-pr-meta .status")).toHaveCount(0);
  const action = request(page).getByRole("button", { name: "Merge Pull Request", exact: true });
  await action.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("GitHub merges pull request #4601 into main at this head with the repository's squash method.");
  await shoot(page, "action-direct-confirm-dark", dialog);
  await dialog.getByRole("button", { name: "Merge Pull Request", exact: true }).click();
  await expect(request(page).getByRole("status")).toHaveText("Merged with the repository's squash method.");
});

test("a GitLab merge request says Wollipog cannot merge it yet", async ({ page }) => {
  await page.goto("/forge-review-e2e.html?request=1&theme=dark");
  const mr = request(page, "Merge Request");
  await expect(mr.getByRole("button", { name: /Merge|Enqueue/u })).toHaveCount(0);
  await expect(mr).toContainText("Merging from Wollipog supports GitHub pull requests only; merge this merge request on GitLab.");
  await shoot(page, "action-gitlab-dark", mr);
});
