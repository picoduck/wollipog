import { expect, test } from "@playwright/test";
for (const width of [1440, 390]) {
  test(`issue closure approval shows exact action and conflicts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/request-surfaces-e2e.html?scenario=issue-closure");
    // The decision is on the Request Card docked above the composer (#2179).
    const foot = page.locator(".request-dock .request-card-foot");
    const details = page.getByRole("region", { name: "Issue Closure Details" });
    await expect(details).toBeVisible();
    await expect(details.getByRole("link", { name: "#123: Obsolete Task" })).toHaveAttribute("href", "https://github.com/team/repo/issues/123");
    for (const text of ["Not Planned", "The replacement design makes this task obsolete.",
      "Replacement issue #124 covers the current design.", "Retired in favor of #124.",
      "#77: Earlier Implementation", "Implement Issue 123", "Work is still associated with this issue."]) {
      await expect(details).toContainText(text);
    }
    await expect(foot.getByRole("button", { name: /^Approve/u })).toBeEnabled();
    await foot.getByRole("button", { name: /^Deny/u }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([
      { requestId: "evidence-occurrence", optionId: "deny" },
    ]);
    // The resolved request is its Decision Record (#2204): a past-tense outcome, never the option id.
    const record = page.locator("details.tl-decision");
    await expect(record.locator(".tl-decision-outcome")).toHaveText("Rejected");
    await expect(record).not.toContainText(/→|\bdeny\b/);
  });

  test(`an issue closure shows the children it excludes, apart from the bound ones, at ${width}px (#3237)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fact = (label: string) => page.getByRole("region", { name: "Issue Closure Details" }).locator("dl.facts > div")
      .filter({ has: page.getByRole("term").filter({ hasText: new RegExp(`^${label}$`, "u") }) }).getByRole("definition");
    await page.goto("/request-surfaces-e2e.html?scenario=issue-closure");
    await expect(fact("Active Child Assignments")).toHaveText("Implement Issue 123");
    // The title renders as text; the reason is derived from ledger facts.
    await expect(fact("Excluded Children")).toHaveText("Fix the <b>Settings</b> Sync Race: "
      + "Every work-item attempt is on #131, which has never tracked this issue and has no follow-up links.");
    await expect(page.getByText("so their activity does not revoke this approval", { exact: false })).toBeVisible();
    await page.goto("/request-surfaces-e2e.html?scenario=issue-closure&excluded=none");
    await expect(fact("Excluded Children")).toHaveText("None");
    await page.goto("/request-surfaces-e2e.html?scenario=issue-closure&excluded=old");
    await expect(fact("Excluded Children")).toHaveText("Not Recorded");
    await expect(page.locator(".request-dock .request-card-foot").getByRole("button", { name: /^Approve/u })).toBeEnabled();
  });

  test(`a renewed issue closure shows why the last approval was refused at ${width}px (#4059)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/request-surfaces-e2e.html?scenario=issue-closure-refused");
    const details = page.getByRole("region", { name: "Issue Closure Details" });
    const note = details.getByRole("note");
    await expect(note).toBeVisible();
    await expect(note).toHaveText("The last approved closure of this issue was refused before anything was written, so it used up that approval. "
      + "A related open pull request gained or lost a closing reference to the issue: #77.");
    await expect(page.locator(".request-dock .request-card-foot").getByRole("button", { name: /^Approve/u })).toBeEnabled();
  });
}
