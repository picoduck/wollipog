import { expect, test } from "@playwright/test";
import { campaignIssueLimitsRequirement, campaignIssueScopeChangesRequirement } from "@wollipog/protocol";

for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
  for (const [reason, message] of [
    ["legacy target", "Campaign scope requires a valid local or SSH host execution target belonging to its runner. Container and cloud targets are not supported."],
    ["stale network", "The campaign's saved network boundary no longer matches the runner's current isolation policy. Review the runner policy and saved placement before retrying."],
    ["unsupported host boundaries", "The campaign's saved secrets or billing boundary is unsupported for a host placement. Review the saved placement before retrying."],
  ]) {
    test(`${reason} scope refusal explains placement and refreshes after recovery at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      let recovered = false;
      await page.route("**/api/sessions/*/campaign/issue-scope", async (route) => {
        await route.fulfill({ status: recovered ? 200 : 409, contentType: "application/json", body: JSON.stringify(recovered
          ? { campaignSessionId: "s_root", repository: "team/repo", issueNumbers: [123], revision: 1,
            supported: true, canPropose: true, outsideScope: [], candidates: [] }
          : { error: message }) });
      });
      await page.goto("/campaign-status-e2e.html?scenario=campaign&scope=unsupported-target");
      const scope = page.getByRole("region", { name: "Authorized Issue Scope" });
      await expect(scope.getByRole("alert")).toContainText(message);
      await expect(scope.getByRole("alert")).not.toContainText("gh authentication");
      recovered = true;
      await scope.getByRole("button", { name: "Refresh Scope", exact: true }).click();
      await expect(scope.getByRole("alert")).toHaveCount(0);
      await expect(scope.getByText("team/repo#123", { exact: true })).toBeVisible();
      await expect(scope.getByRole("button", { name: "Request Scope Approval", exact: true })).toBeVisible();
    });
  }

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

for (const [scope, requirement] of [
  ["outdated-runner", campaignIssueScopeChangesRequirement(207)],
  ["issue-limits", campaignIssueLimitsRequirement(216)],
] as const) {
  test(`an ${scope} refusal names the runner update without a protocol number`, async ({ page }) => {
    await page.goto(`/campaign-status-e2e.html?scenario=campaign&scope=${scope}`);
    const panel = page.getByRole("region", { name: "Authorized Issue Scope" });
    const notice = panel.locator(".notice").filter({ hasText: "Scope Changes Unavailable" });
    await expect(notice).toContainText(requirement.error);
    await expect(notice).not.toContainText(/protocol|v\d/u);
    await expect(panel.getByRole("button", { name: "Request Scope Approval", exact: true })).toHaveCount(0);
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
