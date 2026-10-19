import { expect, test } from "@playwright/test";

test("Cross-Model Reviews lists each review with its round, state, staleness and findings", async ({ page }) => {
  await page.goto("/review-runs-e2e.html?theme=dark");
  const reviews = page.getByRole("region", { name: "Cross-Model Reviews" });
  await expect(reviews).toBeVisible();
  await expect(reviews.locator(".review-findings-head")).toContainText("Reviewing");
  const newest = reviews.getByRole("article", { name: "Codex Review, Round 2 · Epoch 1 · Changes Since Last Round" });
  await expect(newest).toContainText("Reviewing");
  const downvoted = reviews.getByRole("article", { name: "Codex Review, Round 1 · Epoch 1 · Attempt 2 · Full Review" });
  await expect(downvoted).toContainText("Downvote");
  await expect(downvoted).toContainText("Stale");
  const invalid = reviews.getByRole("article", { name: "Codex Review, Round 1 · Epoch 1 · Full Review" });
  await expect(invalid).toContainText("Invalid");
  await expect(invalid).toContainText("is not classified exactly once");
  // The valid report's findings follow it; the file-level one names only its file.
  await expect(reviews.getByRole("button", { name: "charge.ts:48" })).toBeVisible();
  await expect(reviews.getByRole("button", { name: "cart.ts", exact: true })).toBeVisible();
  await expect(reviews.getByText("Charge runs before the empty-cart guard")).toBeVisible();
  await newest.getByRole("button", { name: "Open Transcript" }).click();
  await expect(page.getByTestId("opened-session")).toHaveText("Opened s_review_3");
});

test("a settled newest review summarizes the section with its verdict", async ({ page }) => {
  await page.goto("/review-runs-e2e.html?theme=light&state=settled");
  const reviews = page.getByRole("region", { name: "Cross-Model Reviews" });
  await expect(reviews.locator(".review-findings-head")).toContainText("Upvote");
  await expect(reviews.locator(".review-findings-head")).not.toContainText("Reviewing");
});
