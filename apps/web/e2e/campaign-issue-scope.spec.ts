import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
  test(`human scope recovery and epic selection at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign");
    const scope = page.getByRole("region", { name: "Authorized Issue Scope" });
    await expect(scope.getByText("Work Outside Authorized Scope", { exact: true })).toBeVisible();
    await scope.getByRole("checkbox", { name: /team\/repo#123/ }).check();
    await scope.getByRole("checkbox", { name: /team\/repo#124/ }).check();
    await scope.getByRole("button", { name: "Request Scope Approval", exact: true }).click();
    await expect(scope.getByRole("status").filter({ hasText: "Scope is unchanged" })).toContainText("Scope is unchanged");
    expect(await page.evaluate(() => (window as unknown as { __SCOPE_PROPOSAL__: unknown }).__SCOPE_PROPOSAL__)).toMatchObject({
      expectedRevision: 0, additions: [{ repository: "team/repo", number: 123 }, { repository: "team/repo", number: 124 }], removals: [],
    });
    await scope.getByLabel("Issue Additions", { exact: true }).fill("other/repo#125");
    await scope.getByRole("button", { name: "Request Scope Approval", exact: true }).click();
    await expect(scope.getByRole("alert")).toContainText("Use repository-qualified issues from team/repo");
    const geometry = await scope.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
  });
}


test("scope approval request shows exact changes and affected assignments",async({page})=>{
  await page.goto("/request-surfaces-e2e.html?scenario=issue-scope");
  await expect(page.locator(".request-dock .request-card-foot").getByRole("button", {name:/^Approve/u})).toBeEnabled();
  await expect(page.getByText("team/repo#125",{exact:true})).toBeVisible();
  await expect(page.getByText("team/repo#124",{exact:true})).toBeVisible();
  await expect(page.getByText("closure-member-124",{exact:true})).toBeVisible();
  await expect(page.getByText(/Issue closure still requires its own human approval/)).toBeVisible();
});
