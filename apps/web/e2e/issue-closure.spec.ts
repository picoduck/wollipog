import { expect, test } from "@playwright/test";
for (const width of [1440, 390]) {
  test(`issue closure approval shows exact action and conflicts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/request-surfaces-e2e.html?scenario=issue-closure");
    await page.getByRole("button", { name: "Review Request" }).click();
    const details = page.getByRole("region", { name: "Issue Closure Details" });
    await expect(details).toBeVisible();
    await expect(details.getByRole("link", { name: "#123: Obsolete Task" })).toHaveAttribute("href", "https://github.com/team/repo/issues/123");
    for (const text of ["Not Planned", "The replacement design makes this task obsolete.",
      "Replacement issue #124 covers the current design.", "Retired in favor of #124.",
      "#77: Earlier Implementation", "Implement Issue 123", "Work is still associated with this issue."]) {
      await expect(details).toContainText(text);
    }
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([
      { requestId: "evidence-occurrence", optionId: "deny" },
    ]);
    // The resolved request is its Decision Record (#2204): a past-tense outcome, never the option id.
    const record = page.locator("details.tl-decision");
    await expect(record.locator(".tl-decision-outcome")).toHaveText("Rejected");
    await expect(record).not.toContainText(/→|\bdeny\b/);
  });
}
