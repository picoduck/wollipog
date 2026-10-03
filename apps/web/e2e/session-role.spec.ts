import { expect, test, type Page } from "@playwright/test";

async function chooseRoleSetting(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function openRoleDialog(page: Page) {
  await page.getByRole("button", { name: "More Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Change Session Role…", exact: true }).click();
  return page.getByRole("dialog", { name: "Change Session Role", exact: true });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const theme of ["dark", "light"]) {
    test(`both directions and reconnect at ${viewport.width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`/session-role-e2e.html?theme=${theme}`);
      await expect(page.getByTestId("session-role")).toHaveText("Standard");
      const before = await page.evaluate(() => window.__WOLLIPOG_ROLE_E2E__.session());
      const dialog = await openRoleDialog(page);
      await expect(dialog.getByRole("button", { name: "Change to Orchestrator", exact: true })).toBeEnabled();
      await expect(dialog).toContainText("Provider permissions stay unchanged (auto)");
      await expect(dialog).toContainText("PR Merge");
      await chooseRoleSetting(page, "Child Harness", "Codex App · Codex App Server · Native");
      await chooseRoleSetting(page, "Child Model", "GPT-6.1 Sol");
      await chooseRoleSetting(page, "Child Effort", "High");
      await dialog.getByLabel("Maximum Concurrent Children", { exact: true }).fill("7");
      await chooseRoleSetting(page, "Follow-Ups", "Execute Approved");
      await chooseRoleSetting(page, "Completion", "Retain");
      await chooseRoleSetting(page, "Descendant Requests", "Questions");
      await chooseRoleSetting(page, "PR Merge", "Orchestrator");
      await chooseRoleSetting(page, "Integration Isolation", "Enabled");
      await dialog.getByRole("button", { name: "Change to Orchestrator", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("session-role")).toHaveText("Orchestrator");
      await page.evaluate(() => window.__WOLLIPOG_ROLE_E2E__.reconnect());
      await expect(page.getByTestId("session-role")).toHaveText("Orchestrator");
      const promoted = await page.evaluate(() => window.__WOLLIPOG_ROLE_E2E__.session());
      expect(promoted.orchestratorPolicy?.behavior).toMatchObject({ childModel: "gpt-6.1-sol", childEffort: "high", maximumConcurrentChildren: 7, followUps: "execute_approved", completion: "retain" });
      expect(promoted.orchestratorPolicy?.delegation).toMatchObject({ parentControl: "questions", decisions: { pr_merge: "orchestrator" } });
      expect(promoted.orchestratorPolicy?.execution.integrationIsolation).toBe(true);
      const demotion = await openRoleDialog(page);
      await expect(demotion).toContainText("Live children and unsettled decisions prevent conversion");
      await demotion.getByRole("button", { name: "Change to Standard", exact: true }).click();
      await expect(page.getByTestId("session-role")).toHaveText("Standard");
      const after = await page.evaluate(() => window.__WOLLIPOG_ROLE_E2E__.session());
      for (const key of ["id", "providerAccountId", "projectId", "worktreePath", "permissionMode", "messageCount", "createdAt"] as const) expect(after[key]).toEqual(before[key]);
      expect(await page.evaluate(() => window.__WOLLIPOG_ROLE_E2E__.calls())).toBe(2);
      expect(errors).toEqual([]);
    });
  }
}

for (const scenario of ["busy", "children", "older-runner", "strict", "viewer"]) {
  test(`actionable ${scenario} refusal never submits conversion`, async ({ page }) => {
    await page.goto(`/session-role-e2e.html?scenario=${scenario}`);
    const dialog = await openRoleDialog(page);
    await expect(dialog.getByRole("button", { name: /^Change to / })).toBeDisabled();
    await expect(dialog.locator(".notice")).toBeVisible();
    if (scenario === "older-runner") await expect(dialog.locator(".notice")).toContainText("protocol v203 or later");
    expect(await page.evaluate(() => window.__WOLLIPOG_ROLE_E2E__.calls())).toBe(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  });
}

test("an older control plane disables the role action with upgrade guidance", async ({ page }) => {
  await page.goto("/session-role-e2e.html?scenario=older-control-plane");
  await page.getByRole("button", { name: "More Actions", exact: true }).click();
  const item = page.getByRole("menuitem", { name: "Change Session Role…", exact: true });
  await expect(item).toBeDisabled();
  await expect(page.getByText("Update the control plane before changing an existing session's role.")).toBeVisible();
  expect(await page.evaluate(() => window.__WOLLIPOG_ROLE_E2E__.calls())).toBe(0);
});

test("a lost reply locks and restores the selected promotion settings before exact retry", async ({ page }) => {
  await page.goto("/session-role-e2e.html?scenario=lost-reply");
  const dialog = await openRoleDialog(page);
  await dialog.getByLabel("Maximum Concurrent Children", { exact: true }).fill("9");
  await chooseRoleSetting(page, "PR Merge", "Orchestrator");
  await chooseRoleSetting(page, "Integration Isolation", "Enabled");
  await dialog.getByRole("button", { name: "Change to Orchestrator", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Retry Role Change", exact: true })).toBeEnabled();
  await expect(dialog.getByLabel("Maximum Concurrent Children", { exact: true })).toBeDisabled();
  await page.evaluate(() => window.__WOLLIPOG_ROLE_E2E__.reconnect());
  await expect(dialog.getByLabel("Maximum Concurrent Children", { exact: true })).toHaveValue("9");
  await expect(dialog.getByRole("button", { name: "PR Merge: Orchestrator", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry Role Change", exact: true }).click();
  await expect(page.getByTestId("session-role")).toHaveText("Orchestrator");
  const policy = await page.evaluate(() => window.__WOLLIPOG_ROLE_E2E__.session().orchestratorPolicy);
  expect(policy?.behavior.maximumConcurrentChildren).toBe(9);
  expect(policy?.delegation.decisions.pr_merge).toBe("orchestrator");
  expect(policy?.execution.integrationIsolation).toBe(true);
});

test("strict defaults can be corrected in the promotion dialog without changing provider permissions", async ({ page }) => {
  await page.goto("/session-role-e2e.html?scenario=strict");
  const dialog = await openRoleDialog(page);
  await expect(dialog.getByRole("button", { name: "Change to Orchestrator", exact: true })).toBeDisabled();
  await chooseRoleSetting(page, "Strict Project Isolation", "Disabled");
  await expect(dialog.getByRole("button", { name: "Change to Orchestrator", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Change to Orchestrator", exact: true }).click();
  const session = await page.evaluate(() => window.__WOLLIPOG_ROLE_E2E__.session());
  expect(session.permissionMode).toBe("auto");
  expect(session.orchestratorPolicy?.execution.strictProjectIsolation).toBe(false);
});

test("nested promotion shows its inherited campaign settings without allowing policy overrides", async ({ page }) => {
  await page.goto("/session-role-e2e.html?scenario=inherited");
  const dialog = await openRoleDialog(page);
  await expect(dialog.getByRole("button", { name: /^Child Harness:/ })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /^PR Merge:/ })).toBeDisabled();
  await expect(dialog).toContainText("fixed by the controlling campaign");
  await expect(dialog.getByRole("button", { name: "Change to Orchestrator", exact: true })).toBeEnabled();
});
