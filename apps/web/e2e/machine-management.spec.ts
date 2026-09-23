import { expect, test } from "@playwright/test";

const recoveryGeometry = (notice: HTMLElement) => {
  const message = notice.firstElementChild as HTMLElement;
  const button = notice.querySelector("button");
  const noticeRect = notice.getBoundingClientRect();
  const messageRect = message.getBoundingClientRect();
  const buttonRect = button?.getBoundingClientRect() ?? null;
  return {
    notice: { left: noticeRect.left, right: noticeRect.right, width: noticeRect.width },
    message: { left: messageRect.left, right: messageRect.right, bottom: messageRect.bottom, width: messageRect.width },
    button: buttonRect && {
      left: buttonRect.left,
      right: buttonRect.right,
      top: buttonRect.top,
      width: buttonRect.width,
      height: buttonRect.height,
      clientWidth: button!.clientWidth,
      scrollWidth: button!.scrollWidth,
      clientHeight: button!.clientHeight,
      scrollHeight: button!.scrollHeight,
      whiteSpace: getComputedStyle(button!).whiteSpace,
    },
  };
};

const setOffline = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setRunnerStatus("offline"));

test.beforeEach(async ({ page }) => {
  await page.goto("/machine-management-e2e.html");
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
});

test("Connections distinguish verified, unavailable, and unverified agents", async ({ page }) => {
  await expect(page.locator(".runner-agents-summary")).toHaveText("1 Available");
  await page.getByText("Agents", { exact: true }).click();

  await expect(page.getByText("Custom ACP", { exact: true })).toBeVisible();
  await expect(page.getByText("Missing ACP", { exact: true })).toBeVisible();
  await expect(page.getByText("Legacy Unverified ACP", { exact: true })).toBeVisible();
  await expect(page.locator(".atag.broken", { hasText: "Unavailable" })).toHaveCount(1);
  await expect(page.locator(".atag.broken", { hasText: "Unverified" })).toHaveCount(1);
  await expect(page.getByText(/configured command was not found/u)).toBeVisible();
});

test("Machine settings show competing installations and switch the saved target", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("multiple-installations"));
  await page.getByRole("button", { name: "New Harness Release · View Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  const system = dialog.locator(".machine-harness-installation").filter({ hasText: "/usr/bin/codex" });
  const local = dialog.locator(".machine-harness-installation").filter({ hasText: "/home/example/.local/bin/codex" });
  await expect(system.getByRole("button", { name: "Selected" })).toBeVisible();
  await expect(local.getByRole("button", { name: "Use This Installation" })).toBeVisible();
  await expect(system).toContainText("New Release Published");
  await expect(system).toContainText("compatibility with this Machine has not been verified");
  await expect(local).toContainText("`codex update`");
  await expect(local.locator("p")).not.toContainText("selected Codex installation");
  await expect(local.locator("p")).toContainText("'/home/example/.local/bin/codex' 'update'");
  await page.screenshot({ path: "test-results/harness-installations-before-desktop.png", fullPage: true });
  await local.getByRole("button", { name: "Use This Installation" }).click();
  await expect(local.getByRole("button", { name: "Selected" })).toBeVisible();
  await page.screenshot({ path: "test-results/harness-installations-after-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: "test-results/harness-installations-after-mobile.png", fullPage: true });
});

test("Machine and Connections explain pinned, suppressed, failed, and unavailable harness states", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("harness-states"));
  await page.getByRole("button", { name: "New Harness Release · View Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  const installation = (path: string) => dialog.locator(".machine-harness-installation").filter({ hasText: path });
  await expect(installation("Codex Tools")).toContainText("Pinned by Machine Policy");
  await expect(installation("Codex Tools")).toContainText("change the pin before planning an upgrade");
  await expect(installation("Claude\\claude.exe")).toContainText("Checks Disabled by Machine Policy");
  await expect(installation("Claude\\claude.exe")).toContainText("whether manual upgrades are permitted");
  await expect(installation("Pi\\pi.exe")).toContainText("Check Failed");
  await expect(installation("Pi\\pi.exe")).toContainText("no current release status was established");
  await installation("Pi\\pi.exe").scrollIntoViewIfNeeded();
  await installation("Pi\\pi.exe").screenshot({ path: "test-results/failed-harness-check-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await installation("Pi\\pi.exe").screenshot({ path: "test-results/failed-harness-check-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(installation("Pi\\pi.exe")).toContainText(
    "Select Rediscover for a native Machine, or Reconnect for an SSH Machine after active sessions finish",
  );
  await expect(installation("Legacy Tools")).toContainText("Unavailable");
  await expect(installation("Legacy Tools")).toContainText("older than the verified app-server floor");
  await expect(installation("Legacy Tools")).toContainText("New Release Published");
  await expect(installation("Legacy Tools")).toContainText("Use the package or version manager that installed this exact copy");
  await expect(installation("Legacy Tools").getByRole("button", { name: "Use This Installation" })).toBeEnabled();
  await page.screenshot({ path: "test-results/harness-states-desktop.png", fullPage: true });
  await installation("Legacy Tools").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/harness-states-desktop-bottom.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await installation("Codex Tools").scrollIntoViewIfNeeded();
  await expect(installation("Codex Tools")).toBeVisible();
  await page.screenshot({ path: "test-results/harness-states-mobile.png", fullPage: true });
  await installation("Claude\\claude.exe").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/harness-states-mobile-policy.png", fullPage: true });
  await installation("Legacy Tools").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/harness-states-mobile-bottom.png", fullPage: true });
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.getByText("Agents", { exact: true }).click();
  await page.getByRole("button", { name: "View Codex App Server Details" }).first().click();
  const details = page.getByRole("dialog", { name: "Codex App Server Details" });
  await expect(details.getByText("PowerShell 7.3 or later on this Machine", { exact: false })).toBeVisible();
  await expect(details.locator(".agent-details-command code")).toHaveText(
    "& 'C:\\Program Files\\Codex Tools\\codex.exe' '--profile' 'Team''s Profile'",
  );
  await expect(details.getByText("Pinned by Machine Policy", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/harness-command-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: "test-results/harness-command-desktop.png", fullPage: true });
});

test("Agent Details treats Windows batch wrapper arguments as reference data", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("batch-wrapper"));
  await page.getByText("Agents", { exact: true }).click();
  await page.getByRole("button", { name: "View Codex App Server Details" }).click();
  const details = page.getByRole("dialog", { name: "Codex App Server Details" });
  await expect(details.getByText(/A copyable launch command is unavailable/)).toBeVisible();
  await expect(details.locator("dt").filter({ hasText: /^Executable$/ }).locator("+ dd code"))
    .toHaveText("C:\\Program Files\\Codex Tools\\codex.cmd");
  await expect(details.locator("dt", { hasText: "Arguments" }).locator("+ dd code"))
    .toHaveText('["--profile","Team \\"Research\\"","%PATH%"]');
  await expect(details.locator(".agent-details-command")).toHaveCount(0);
  await expect(details.getByRole("button", { name: /Copy .* Launch Command/ })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: "test-results/batch-wrapper-details-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(details).toBeVisible();
  await page.screenshot({ path: "test-results/batch-wrapper-details-mobile.png", fullPage: true });
});

test("offline Machines retain last-reported harness status without a fresh release notice", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("multiple-installations"));
  await setOffline(page);
  await expect(page.getByRole("button", { name: "New Harness Release · View Settings" })).toHaveCount(0);
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(page.getByRole("dialog").locator(".machine-harness-installation").first()).toContainText("Last Reported: New Release Published");
  await page.screenshot({ path: "test-results/harness-installations-offline-desktop.png", fullPage: true });
});

test("failed release guidance names the SSH Machine's Reconnect action", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("harness-states-ssh"));
  const card = page.locator(".box-card").filter({ hasText: "Design Workstation" });
  await expect(card.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await card.locator(".runner-head-right").screenshot({ path: "test-results/failed-harness-check-ssh-action.png" });
  await card.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  const failedInstallation = dialog.locator(".machine-harness-installation").filter({ hasText: "Pi\\pi.exe" });
  await expect(failedInstallation).toContainText("Reconnect for an SSH Machine after active sessions finish");
  await failedInstallation.screenshot({ path: "test-results/failed-harness-check-ssh-guidance.png" });
});

test("Machine settings keep same-name container installations scoped to their targets", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("target-installations"));
  await page.getByRole("button", { name: "Manage" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  const installationSection = dialog.locator(".machine-settings-section").filter({ hasText: "Agent Harness Installations" });
  const alpha = dialog.locator(".machine-harness-installation").filter({ hasText: "Alpha Image" });
  const beta = dialog.locator(".machine-harness-installation").filter({ hasText: "Beta Image" });
  await expect(alpha).toContainText("/usr/bin/codex");
  await expect(beta).toContainText("/usr/bin/codex");
  await expect(alpha).toContainText("Authenticated · Capability Verified");
  await expect(alpha).toContainText("Codex Login Status · Codex App Server Help");
  await expect(beta).toContainText("Authentication Unknown · Capability Unknown");
  await expect(alpha.getByRole("button", { name: "Selected" })).toBeVisible();
  await expect(beta.getByRole("button", { name: "Use This Installation" })).toBeVisible();
  await installationSection.screenshot({ path: "test-results/target-installations-before-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await installationSection.screenshot({ path: "test-results/target-installations-before-mobile.png" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await installationSection.screenshot({ path: "test-results/target-installations-before-mobile-light.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await installationSection.screenshot({ path: "test-results/target-installations-before-desktop-light.png" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await beta.getByRole("button", { name: "Use This Installation" }).click();
  await expect(beta.getByRole("button", { name: "Selected" })).toBeVisible();
  await expect(alpha.getByRole("button", { name: "Selected" })).toBeVisible();
  await installationSection.screenshot({ path: "test-results/target-installations-after-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(beta).toBeVisible();
  await installationSection.screenshot({ path: "test-results/target-installations-after-mobile.png" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await installationSection.screenshot({ path: "test-results/target-installations-after-mobile-light.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await installationSection.screenshot({ path: "test-results/target-installations-after-desktop-light.png" });
});

test("Machine cards show account-scoped login status", async ({ page }) => {
  await page.getByText("Accounts", { exact: true }).click();
  const accounts = page.locator("details.runner-agents").filter({ hasText: "Accounts" });
  const work = accounts.locator(".agent-row").filter({ hasText: "Work" });
  await expect(work).toContainText("Claude");
  await expect(work).toContainText("Logged In");
  const personal = accounts.locator(".agent-row").filter({ hasText: "Personal" });
  await expect(personal).toContainText("Claude");
  await expect(personal).toContainText("Login Required");
  await page.screenshot({ path: "test-results/provider-accounts/machine-accounts.png", fullPage: true });
});

test("Machine owners can start both provider sign-in flow shapes", async ({ page }) => {
  await page.getByText("Accounts", { exact: true }).click();
  await page.getByRole("button", { name: "Add Account" }).click();
  const claudeDialog = page.getByRole("dialog", { name: "Add Account" });
  await claudeDialog.getByLabel("Account Label").fill("Studio Claude");
  await claudeDialog.getByRole("button", { name: "Start Sign-In" }).click();

  const claude = page.getByRole("article", { name: "Studio Claude Provider Sign-In" });
  await expect(claude.getByRole("link", { name: "Open Provider Sign-In" })).toBeVisible();
  await expect(claude.getByLabel("Authorization Code")).toBeVisible();
  await page.screenshot({ path: "test-results/provider-login/claude-paste-code.png", fullPage: true });

  await claude.getByRole("button", { name: "Cancel" }).click();
  await page.getByText("Accounts", { exact: true }).click();
  await page.getByRole("button", { name: "Add Account" }).click();
  const codexDialog = page.getByRole("dialog", { name: "Add Account" });
  await codexDialog.getByRole("button", { name: "Provider: Claude" }).click();
  await codexDialog.getByRole("option", { name: "Codex" }).click();
  await codexDialog.getByLabel("Account Label").fill("Studio Codex");
  await codexDialog.getByRole("button", { name: "Start Sign-In" }).click();

  const codex = page.getByRole("article", { name: "Studio Codex Provider Sign-In" });
  await expect(codex.getByText("WOLL-IPOGS", { exact: true })).toBeVisible();
  await expect(codex.getByLabel("Authorization Code")).toHaveCount(0);
  await page.screenshot({ path: "test-results/provider-login/codex-device-code.png", fullPage: true });
});

test("Connections ask protocol v153 runners to update before trusting unverified agents", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("legacy-unverified"));
  await expect(page.locator(".runner-agents-summary")).toHaveText("0 Available");
  await page.getByText("Agents", { exact: true }).click();

  await expect(page.locator(".atag.broken", { hasText: "Unverified" })).toHaveCount(1);
  await expect(page.getByText(
    "Update this runner to verify its configured agent availability.", { exact: true },
  )).toBeVisible();
  await expect(page.getByText("No usable agent CLIs found on this machine — install one:", { exact: true }))
    .toHaveCount(0);
  await expect(page.locator(".install-cmd")).toHaveCount(0);
});

test("Connections show installation guidance for protocol v154 verified-unavailable agents", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("verified-unavailable"));
  await expect(page.locator(".runner-agents-summary")).toHaveText("0 Available");
  await page.getByText("Agents", { exact: true }).click();

  await expect(page.locator(".atag.broken", { hasText: "Unavailable" })).toHaveCount(1);
  await expect(page.getByText("No usable agent CLIs found on this machine — install one:", { exact: true }))
    .toBeVisible();
  await expect(page.locator(".install-cmd").first()).toBeVisible();
  await expect(page.getByText(
    "Update this runner to verify its configured agent availability.", { exact: true },
  )).toHaveCount(0);
});

test("offline recovery stays stacked and usable in a narrow card on a desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setOffline(page);
  await page.locator(".runner-grid").evaluate((grid) => { (grid as HTMLElement).style.width = "260px"; });

  const card = page.locator(".runner-card");
  await expect.poll(() => card.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(280);
  expect(await page.evaluate(() => window.innerWidth)).toBe(1280);

  const repair = page.getByRole("button", { name: "Repair Credentials", exact: true });
  await expect(repair).toHaveText("Repair Credentials");
  const geometry = await page.locator(".connection-recovery").evaluate(recoveryGeometry);
  expect(geometry.button).not.toBeNull();
  expect(geometry.button!.top).toBeGreaterThanOrEqual(geometry.message.bottom + 11);
  expect(Math.abs(geometry.button!.left - geometry.message.left)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.button!.width - geometry.message.width)).toBeLessThanOrEqual(0.5);
  expect(geometry.button!.right).toBeLessThanOrEqual(geometry.notice.right + 0.5);
  expect(geometry.button!.height).toBeGreaterThanOrEqual(44);
  expect(geometry.button!.whiteSpace).toBe("nowrap");
  expect(geometry.button!.scrollWidth).toBeLessThanOrEqual(geometry.button!.clientWidth);
  expect(geometry.button!.scrollHeight).toBeLessThanOrEqual(geometry.button!.clientHeight);

  await repair.click();
  await expect(page.getByRole("dialog", { name: "Repair Runner Connection" })).toBeVisible();
});

test("offline recovery stays stacked and usable on a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await setOffline(page);

  const repair = page.getByRole("button", { name: "Repair Credentials", exact: true });
  await expect(repair).toBeVisible();
  const geometry = await page.locator(".connection-recovery").evaluate(recoveryGeometry);
  expect(geometry.button).not.toBeNull();
  expect(geometry.button!.top).toBeGreaterThanOrEqual(geometry.message.bottom + 11);
  expect(Math.abs(geometry.button!.left - geometry.message.left)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(geometry.button!.width - geometry.message.width)).toBeLessThanOrEqual(0.5);
  expect(geometry.button!.height).toBeGreaterThanOrEqual(44);
  expect(geometry.button!.whiteSpace).toBe("nowrap");
  expect(geometry.button!.scrollWidth).toBeLessThanOrEqual(geometry.button!.clientWidth);
  expect(geometry.notice.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.notice.right).toBeLessThanOrEqual(320.5);
});

test("non-admin recovery guidance wraps inside a narrow mobile card", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/machine-management-e2e.html?role=viewer");
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
  await setOffline(page);

  await expect(page.getByRole("button", { name: "Repair Credentials", exact: true })).toHaveCount(0);
  const guidance = page.getByText("Ask an organization owner or admin to repair this connection.", { exact: true });
  await expect(guidance).toBeVisible();
  const geometry = await guidance.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const notice = element.parentElement!.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      lineHeight: Number.parseFloat(style.lineHeight),
      noticeLeft: notice.left,
      noticeRight: notice.right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(geometry.lineHeight);
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.noticeLeft - 0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.noticeRight + 0.5);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

});
test("Machine settings rename the Machine and register a Workspace without creating a Project", async ({ page }) => {
  await page.getByRole("button", { name: "Manage" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  await expect(dialog.getByText("Misko-T14s-G6", { exact: true })).toBeVisible();

  const name = dialog.getByLabel("Machine Name");
  await name.fill("Primary Development Machine");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByRole("heading", { name: "Primary Development Machine", exact: true })).toBeVisible();
  const renamedDialog = page.getByRole("dialog", { name: "Manage Primary Development Machine" });

  await renamedDialog.getByRole("button", { name: "Add Workspace" }).last().click();
  await renamedDialog.getByRole("button", { name: "repo" }).click();
  await renamedDialog.getByRole("button", { name: "Use This Folder" }).click();
  await expect(renamedDialog.getByLabel("Workspace Name")).toHaveValue("repo");
  await renamedDialog.getByRole("button", { name: "Add Workspace" }).last().click();

  await expect(renamedDialog.getByText("C:\\Users\\misko\\repo", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.lastRegisteredWorkspace()))
    .toEqual({ name: "repo", path: "C:\\Users\\misko\\repo" });
});

test("Machine settings explain live Runner Capacity and apply an authorized increase", async ({ page }) => {
  await page.getByRole("button", { name: "Manage" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  await expect(dialog.getByRole("heading", { name: "Runner Capacity" })).toBeVisible();
  await expect(dialog.getByLabel("Runner Capacity Usage")).toContainText("12 Units");
  await expect(dialog.getByText("12 of 16 Units Used · 3 Sessions Queued", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Capacity Dimensions")).toContainText("Active Turns4 of 4");
  await expect(dialog.getByLabel("Capacity Dimensions")).toContainText("Resident Process Units12 of 16");
  await expect(dialog.getByLabel("Capacity Dimensions")).toContainText("Retained Resumable Sessions9 (Unlimited)");
  await expect(dialog.getByLabel("Capacity Dimensions")).toContainText("Parked Sessions2");
  await expect(dialog.getByLabel("Capacity Dimensions")).toContainText("Idle Process PolicyPark When Needed");
  await expect(dialog.getByText(/idle-process parking are configured in/)).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Current Capacity Bottlenecks" }))
    .toContainText("claude is using 4 of 4 provider slots · 3 Waiting");

  await dialog.getByLabel("Runner Capacity", { exact: true }).fill("24");
  await dialog.getByRole("button", { name: "Save Capacity" }).click();
  await expect(dialog.getByText("12 of 24 Units Used · 3 Sessions Queued", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Runner Capacity Usage")).toContainText("12 Units");
});

test("Machine settings require the terms warning before enabling Automatic Account Switching", async ({ page }) => {
  await page.getByRole("button", { name: "Manage" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  await expect(dialog.getByRole("heading", { name: "Automatic Account Switching" })).toBeVisible();
  await expect(dialog.getByText("Disabled. Provider usage limits continue to park sessions as before.", {
    exact: true,
  })).toBeVisible();

  await dialog.getByRole("button", { name: "Enable Automatic Switching" }).click();
  const warning = page.getByRole("dialog", { name: "Enable Automatic Account Switching?" });
  await expect(warning).toContainText("prohibit circumventing rate limits");
  await expect(warning).toContainText("You are responsible");
  await page.screenshot({
    path: "test-results/automatic-account-switching/enable-warning.png",
    fullPage: true,
  });
  await warning.getByRole("button", { name: "Enable Automatic Switching" }).click();

  await expect(dialog.getByRole("button", { name: "Disable Automatic Switching" })).toBeVisible();
  await expect(dialog.getByText(/Enabled. Exhausted, unauthenticated, and cooling-down accounts/)).toBeVisible();
  await page.screenshot({
    path: "test-results/automatic-account-switching/machine-setting-enabled.png",
    fullPage: true,
  });
});

test("ordinary members can inspect Runner Capacity but cannot change it", async ({ page }) => {
  await page.goto("/machine-management-e2e.html?role=viewer");
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
  await expect(page.getByLabel("System Details")).toContainText("12 of 16 Units Used");
  await expect(page.getByRole("button", { name: "Manage" })).toHaveCount(0);
});

test("a Machine owner can change capacity without receiving organization-wide controls", async ({ page }) => {
  await page.goto("/machine-management-e2e.html?role=machine-owner");
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
  await page.getByRole("button", { name: "Manage" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  await expect(dialog.getByLabel("Runner Capacity", { exact: true })).toBeEnabled();
  await expect(dialog.getByRole("heading", { name: "Machine Details" })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Workspaces" })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Danger Zone" })).toHaveCount(0);
});

test("Machine settings expose deletion with an explicit history warning", async ({ page }) => {
  await page.getByRole("button", { name: "Manage" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  const deleteMachine = dialog.getByRole("button", { name: "Delete Machine" });
  await expect(deleteMachine).toBeDisabled();
  await expect(deleteMachine).toHaveAttribute("title", "Stop this native runner before deleting the Machine");
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setRunnerStatus("offline"));
  await expect(deleteMachine).toBeEnabled();
  await deleteMachine.click();

  const confirmation = page.getByRole("dialog", { name: "Delete Design Workstation?" });
  await expect(confirmation).toContainText("permanently deletes the Machine, its sessions, and its multi-agent runs");
  await confirmation.getByRole("button", { name: "Delete Machine" }).click();
  await expect(page.getByText("No Machines Connected")).toBeVisible();
});

test("SSH config import keeps the selected Host and auto-populates an editable Machine Name", async ({ page }) => {
  await page.getByRole("button", { name: "Connect via SSH" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect via SSH" });
  const hosts = dialog.getByLabel("Import From ~/.ssh/config");

  await hosts.selectOption("golf-sim");
  await expect(hosts).toHaveValue("golf-sim");
  await expect(dialog.getByLabel("Machine Name")).toHaveValue("golf-sim");
  await expect(dialog.getByLabel("SSH Target")).toHaveValue("golf-sim");
  await expect(dialog.getByLabel("SSH Port")).toHaveValue("2222");

  await dialog.getByLabel("Machine Name").fill("Golf Simulator");
  await hosts.selectOption("build-box");
  await expect(hosts).toHaveValue("build-box");
  await expect(dialog.getByLabel("Machine Name")).toHaveValue("Golf Simulator");
  await expect(dialog.getByLabel("SSH Target")).toHaveValue("build-box");

  await dialog.getByRole("button", { name: "Connect Machine" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.lastAddBoxRequest()))
    .toMatchObject({
      displayName: "Golf Simulator",
      sshTarget: "build-box",
      sshPort: 22,
    });
});
