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
      await expect(setup.getByRole("button", { name: "Add Separate Sign-In…" })).toBeEnabled();
      await dialogMotionSettled(page);
      await page.screenshot({ path: testInfo.outputPath(`setup-${width}-${theme}.png`) });
      await setup.getByRole("button", { name: "Add Separate Sign-In…" }).click();
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
      await expect(setup.getByRole("button", { name: "Add Separate Sign-In…" })).toHaveCount(0);
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

for (const state of ["busy", "unknown", "restricted", "offline"]) {
  test(`Account Setup keeps ${state} observations distinct from missing or signed out`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/new-session-choices-e2e.html?accountSetup=${state}`);
    await page.getByRole("button", { name: "Account Setup…", exact: true }).click();
    const setup = page.getByRole("dialog", { name: "Account Setup", exact: true });
    await expect(setup).toBeVisible();
    await expect(setup.getByText("Sign-In Required", { exact: true })).toHaveCount(0);
    await expect(setup.getByText(/Install Claude Code or Codex on this machine/)).toHaveCount(0);
    await expect(setup.getByText(/Checked .*ago\./).first()).toBeVisible();
    if (state === "busy") await expect(setup.getByText(/This sign-in is in use/).first()).toBeVisible();
    if (state === "restricted") await expect(setup.getByText(/current access permissions/).first()).toBeVisible();
    if (state === "offline") await expect(setup.getByRole("button", { name: "Add Separate Sign-In…" })).toBeDisabled();
    await dialogMotionSettled(page);
    await page.screenshot({ path: testInfo.outputPath(`readiness-${state}.png`) });
  });
}

test("missing provider installation explains the next step before starting setup", async ({ page }) => {
  await page.goto("/new-session-choices-e2e.html?accountSetup=missing");
  await page.getByRole("button", { name: "Account Setup…", exact: true }).click();
  await page.getByRole("button", { name: "Add Separate Sign-In…" }).click();
  const add = page.getByRole("dialog", { name: "Add Account", exact: true });
  await expect(add.getByText(/Install Claude on this machine/)).toBeVisible();
  await expect(add.getByRole("button", { name: "Start Sign-In", exact: true })).toBeDisabled();
});

for (const theme of ["light", "dark"]) {
  for (const width of [1280, 390]) {
    test(`SSH connection and readiness remain distinct at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/machine-management-e2e.html?ssh=online&readinessFailure=1&machine=native-t14s&theme=${theme}`);
      await expect(page.getByRole("heading", { name: "Design Workstation", exact: true })).toBeVisible();
      await expect(page.locator(".machine-detail-status")).toHaveText("Online");
      await expect(page.getByText("Provider Readiness Needs Attention", { exact: true })).toBeVisible();
      await dialogMotionSettled(page);
      await page.screenshot({ path: testInfo.outputPath(`ssh-readiness-${width}-${theme}.png`) });
      await page.goto(`/machine-management-e2e.html?theme=${theme}`);
      await page.locator(".page-header").getByRole("button", { name: "Add Machine", exact: true }).click();
      await page.getByRole("menuitem", { name: "Connect via SSH…", exact: true }).click();
      await expect(page.getByText(/Connecting lets this server use the machine's existing permitted/)).toBeVisible();
      await dialogMotionSettled(page);
      await page.screenshot({ path: testInfo.outputPath(`ssh-trust-${width}-${theme}.png`) });
    });
  }
}
