import { expect, test } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

for (const theme of ["light", "dark"]) {
  for (const width of [1280, 390]) {
    test(`Account Setup preserves a blocked draft at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/new-session-choices-e2e.html?accountSetup=signed-out&theme=${theme}`);
      const draft = page.getByRole("dialog", { name: "New Session", exact: true });
      await expect(draft).toBeVisible();
      const project = width > 600 ? draft.getByRole("combobox", { name: "Project", exact: true })
        : draft.getByRole("button", { name: "Project: Wollipog", exact: true });
      const before = width > 600 ? await project.inputValue() : await project.textContent();
      const setupButton = draft.getByRole("button", { name: "Account Setup…", exact: true });
      await setupButton.focus();
      await page.keyboard.press("Enter");
      const setup = page.getByRole("dialog", { name: "Account Setup", exact: true });
      await expect(setup).toBeVisible();
      await expect(setup.getByRole("button", { name: "Add Account…" })).toBeEnabled();
      await dialogMotionSettled(page);
      await page.screenshot({ path: testInfo.outputPath(`setup-${width}-${theme}.png`) });
      await setup.getByRole("button", { name: "Add Account…" }).click();
      const add = page.getByRole("dialog", { name: "Add Account", exact: true });
      await expect(add).toBeVisible();
      await add.getByRole("button", { name: "Cancel", exact: true }).click();
      await setup.getByRole("button", { name: "Done", exact: true }).click();
      await expect(draft).toBeVisible();
      expect(width > 600 ? await project.inputValue() : await project.textContent()).toEqual(before);
      await expect(setupButton).toBeFocused();
      await dialogMotionSettled(page);
      await page.screenshot({ path: testInfo.outputPath(`returned-${width}-${theme}.png`) });
    });
  }
}

for (const state of ["viewer", "old", "missing"]) {
  test(`Account Setup explains ${state} without requiring a ready agent`, async ({ page }) => {
    await page.goto(`/new-session-choices-e2e.html?accountSetup=${state}`);
    await page.getByRole("button", { name: "Account Setup…", exact: true }).click();
    const setup = page.getByRole("dialog", { name: "Account Setup", exact: true });
    await expect(setup).toBeVisible();
    if (state === "viewer") {
      await expect(setup.getByText("Only this machine's owner or an organization admin can add or remove its accounts.")).toBeVisible();
      await expect(setup.getByRole("button", { name: "Add Account…" })).toHaveCount(0);
    } else if (state === "old") {
      await expect(setup.getByText(/Update this machine's runner to set up accounts here/)).toBeVisible();
    } else {
      await expect(setup.getByText("Install Claude Code or Codex on this machine, then rediscover.")).toBeVisible();
    }
  });
}

test("returning from setup preserves an explicit account, installation and project placement", async ({ page }) => {
  await page.goto("/new-session-choices-e2e.html");
  const account = page.getByRole("button", { name: /Account:/ });
  await account.click();
  await page.getByRole("option", { name: /Personal/ }).click();
  await page.getByRole("button", { name: "Account Setup…", exact: true }).click();
  await page.getByRole("dialog", { name: "Account Setup", exact: true }).getByRole("button", { name: "Done", exact: true }).click();
  await expect(account).toHaveAccessibleName(/Account: Personal/);
  await page.getByRole("button", { name: "Create Session", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.createSessionRequest)).toBeTruthy();
  const request = JSON.parse((await page.evaluate(() => document.documentElement.dataset.createSessionRequest))!);
  expect(request).toMatchObject({ runnerId: "runner-1", agentId: "claude", workspaceId: "workspace-1", providerAccountId: "claude-personal" });
});
