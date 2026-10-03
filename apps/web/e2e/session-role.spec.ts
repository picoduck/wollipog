import { expect, test, type Page } from "@playwright/test";

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
      await dialog.getByRole("button", { name: "Change to Orchestrator", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("session-role")).toHaveText("Orchestrator");
      await page.evaluate(() => window.__WOLLIPOG_ROLE_E2E__.reconnect());
      await expect(page.getByTestId("session-role")).toHaveText("Orchestrator");
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
