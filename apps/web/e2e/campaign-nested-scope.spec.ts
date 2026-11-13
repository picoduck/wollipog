import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`nested GitLab scope accepts typed changes at ${width}px (#4248)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1100 });
    const repository = "gitlab.example/group/subgroup/project";
    await page.route("**/api/sessions/*/campaign/issue-scope", (route) => route.fulfill({
      contentType: "application/json", body: JSON.stringify({ campaignSessionId: "s_root", repository,
        issueNumbers: [33], revision: 2, supported: true, canPropose: true, outsideScope: [], candidates: [] }),
    }));
    await page.goto("/campaign-status-e2e.html?scenario=campaign&scope=unsupported-target");
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    const scope = page.getByRole("region", { name: "Authorized Issue Scope" });
    await scope.getByLabel("Issue Additions", { exact: true }).fill(`${repository.toUpperCase()}#54`);
    await scope.getByLabel("Issue Removals", { exact: true }).fill(`${repository}#33`);
    await scope.screenshot({ path: info.outputPath(`nested-scope-entry-${width}.png`) });
    await scope.getByRole("button", { name: "Request Scope Approval", exact: true }).click();
    await expect(scope.getByRole("status").filter({ hasText: "Scope is unchanged" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __SCOPE_PROPOSAL__: unknown }).__SCOPE_PROPOSAL__)).toMatchObject({
      expectedRevision: 2, additions: [{ repository, number: 54 }], removals: [{ repository, number: 33 }],
    });
    await scope.screenshot({ path: info.outputPath(`nested-scope-submitted-${width}.png`) });
    await scope.getByLabel("Issue Additions", { exact: true }).fill(`${repository}/other#54`);
    await scope.getByRole("button", { name: "Request Scope Approval", exact: true }).click();
    await expect(scope.getByRole("alert")).toContainText(`Use repository-qualified issues from ${repository}`);
    await scope.screenshot({ path: info.outputPath(`nested-scope-rejected-${width}.png`) });
  });
}
