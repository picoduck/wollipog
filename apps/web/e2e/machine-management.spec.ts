import { expect, test } from "@playwright/test";

const recoveryGeometry = (notice: HTMLElement) => {
  const message = notice.querySelector(".notice-body") as HTMLElement;
  const button = notice.querySelector("button");
  const noticeRect = notice.getBoundingClientRect();
  const messageRect = message.getBoundingClientRect();
  const buttonRect = button?.getBoundingClientRect() ?? null;
  // The label's own extent. `scrollWidth` also counts a touch hit area, which reaches past the
  // button on purpose and is not clipped text.
  const label = button ? document.createRange() : null;
  label?.selectNodeContents(button!);
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
      labelWidth: label!.getBoundingClientRect().width,
      clientHeight: button!.clientHeight,
      scrollHeight: button!.scrollHeight,
      whiteSpace: getComputedStyle(button!).whiteSpace,
    },
  };
};

const setOffline = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setRunnerStatus("offline"));

/** A machine's row in the Machines list (#2985). */
const machineRow = (page: import("@playwright/test").Page, name = "Design Workstation") =>
  page.getByRole("complementary", { name: "Machines" }).locator("button.row").filter({ has: page.locator(".row-title", { hasText: name }) });

/** Design Workstation's own route, which wider than a phone opens it beside the list (#2985). */
const DESIGN_WORKSTATION = "machine=native-t14s";

/**
 * Settings… (#2988): beside ⋯ in the detail's title row, and on a phone the first item of the
 * detail bar's ⋯.
 */
async function openSettings(page: import("@playwright/test").Page) {
  const button = page.locator(".machine-detail-title-row").getByRole("button", { name: "Settings…", exact: true });
  if (await button.isVisible()) {
    await button.click();
    return;
  }
  await page.locator(".detail-bar").getByRole("button", { name: "Machine Actions" }).click();
  await page.getByRole("menu", { name: "Machine Actions" }).getByRole("menuitem", { name: "Settings…" }).click();
}

/** The open machine's one lifecycle notice (#2988). */
const machineNotice = (page: import("@playwright/test").Page) => page.locator("article.machine-detail > .notice");

test.beforeEach(async ({ page }) => {
  // A phone shows the list alone (#2985). Wider, nothing is selected by itself (#2986), so the
  // scenarios open Design Workstation by its route.
  const phone = (page.viewportSize()?.width ?? 1280) <= 760;
  await page.goto(phone ? "/machine-management-e2e.html" : `/machine-management-e2e.html?${DESIGN_WORKSTATION}`);
  await expect(phone ? machineRow(page) : page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
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
  await openSettings(page);
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
  await openSettings(page);
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
  await expect(installation("Legacy Tools")).toContainText("older than the supported version");
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

test("Agent Details does not offer a copyable command for dotted Windows batch aliases", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("dotted-batch-wrapper"));
  await page.getByText("Agents", { exact: true }).click();
  await page.getByRole("button", { name: "View Codex App Server Details" }).click();
  const details = page.getByRole("dialog", { name: "Codex App Server Details" });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: "test-results/dotted-batch-wrapper-details-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/dotted-batch-wrapper-details-mobile.png", fullPage: true });
  await expect(details.getByText(/A copyable launch command is unavailable/)).toBeVisible();
  await expect(details.locator("dt").filter({ hasText: /^Executable$/ }).locator("+ dd code"))
    .toHaveText("codex.v2");
  await expect(details.getByRole("button", { name: /Copy .* Launch Command/ })).toHaveCount(0);
});

test("Agent Details does not offer an extensionless Windows batch launch to copy", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("extensionless-batch-wrapper"));
  await page.getByText("Agents", { exact: true }).click();
  await page.getByRole("button", { name: "View Codex App Server Details" }).click();
  const details = page.getByRole("dialog", { name: "Codex App Server Details" });
  await expect(details.getByText(/may resolve to a batch wrapper/)).toBeVisible();
  await expect(details.locator("dt").filter({ hasText: /^Executable$/ }).locator("+ dd code"))
    .toHaveText("codex");
  await expect(details.locator("dt", { hasText: "Arguments" }).locator("+ dd code"))
    .toHaveText('["--profile","Team \\"Research\\"","%PATH%"]');
  await expect(details.locator(".agent-details-command")).toHaveCount(0);
  await expect(details.getByRole("button", { name: /Copy .* Launch Command/ })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: "test-results/extensionless-batch-wrapper-details-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(details).toBeVisible();
  await page.screenshot({ path: "test-results/extensionless-batch-wrapper-details-mobile.png", fullPage: true });
});

test("Agent Details shows explicit Windows command hosts as reference data", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("explicit-interpreter"));
  await page.getByText("Agents", { exact: true }).click();
  await page.getByRole("button", { name: "View Codex App Server Details" }).click();
  const details = page.getByRole("dialog", { name: "Codex App Server Details" });
  await expect(details.getByText(/This Windows launch may resolve to a batch wrapper or use an executable with legacy PowerShell argument passing/)).toBeVisible();
  await expect(details.locator("dt").filter({ hasText: /^Executable$/ }).locator("+ dd code"))
    .toHaveText("C:\\Windows\\System32\\cmd.exe");
  await expect(details.locator("dt", { hasText: "Arguments" }).locator("+ dd code"))
    .toHaveText('["/d","/c","echo","%PATH%"]');
  await expect(details.getByRole("button", { name: /Copy .* Launch Command/ })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: "test-results/explicit-interpreter-details-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(details).toBeVisible();
  await page.screenshot({ path: "test-results/explicit-interpreter-details-mobile.png", fullPage: true });
});

test("older Windows runner update instructions are suppressed in Details and Machine Settings", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("older-interpreter-guidance"));
  await page.getByText("Agents", { exact: true }).click();
  await page.getByRole("button", { name: "View Codex App Server Details" }).click();
  const details = page.getByRole("dialog", { name: "Codex App Server Details" });
  await expect(details.getByText(/No copyable update command is available/)).toBeVisible();
  await expect(details).not.toContainText("Run `& 'C:\\Windows");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await details.getByText(/No copyable update command is available/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/older-runner-guidance-details-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await details.getByText(/No copyable update command is available/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/older-runner-guidance-details-mobile.png", fullPage: true });
  await details.getByRole("button", { name: "Close" }).last().click();
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Manage Design Workstation" });
  await expect(settings.getByText(/No copyable update command is available/)).toBeVisible();
  await expect(settings).not.toContainText("Run `& 'C:\\Windows");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await settings.getByText(/No copyable update command is available/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/older-runner-guidance-settings-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await settings.getByText(/No copyable update command is available/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/older-runner-guidance-settings-mobile.png", fullPage: true });
});

test("offline Machines retain last-reported harness status without a fresh release notice", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("multiple-installations"));
  await setOffline(page);
  await expect(page.getByRole("button", { name: "New Harness Release · View Settings" })).toHaveCount(0);
  await openSettings(page);
  await expect(page.getByRole("dialog").locator(".machine-harness-installation").first()).toContainText("Last Reported: New Release Published");
  await page.screenshot({ path: "test-results/harness-installations-offline-desktop.png", fullPage: true });
});

test("failed release guidance names the SSH Machine's Reconnect action", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("harness-states-ssh"));
  const detail = page.locator('article.machine-detail[data-kind="ssh"]');
  await detail.getByRole("button", { name: "Machine Actions" }).click();
  const actions = page.getByRole("menu", { name: "Machine Actions" });
  await expect(actions.getByRole("menuitem", { name: "Reconnect", exact: true })).toBeVisible();
  await actions.screenshot({ path: "test-results/failed-harness-check-ssh-action.png" });
  await page.keyboard.press("Escape");
  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  const failedInstallation = dialog.locator(".machine-harness-installation").filter({ hasText: "Pi\\pi.exe" });
  await expect(failedInstallation).toContainText("Reconnect for an SSH Machine after active sessions finish");
  await failedInstallation.screenshot({ path: "test-results/failed-harness-check-ssh-guidance.png" });
});

test("Machine settings keep same-name container installations scoped to their targets", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("target-installations"));
  await openSettings(page);
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

test("Machine owners can remove a provider account after confirming", async ({ page }) => {
  await page.getByText("Accounts", { exact: true }).click();
  const accounts = page.locator("details.runner-agents").filter({ hasText: "Accounts" });
  const personal = accounts.locator(".agent-row").filter({ hasText: "Personal" });
  await personal.getByRole("button", { name: "Remove" }).click();
  const confirmation = page.getByRole("dialog", { name: "Remove Account" });
  await expect(confirmation).toContainText("deletes the credentials it stored");
  await expect(confirmation).toContainText("Personal");
  await page.screenshot({ path: "test-results/provider-accounts/remove-account-confirm.png", fullPage: true });
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(personal).toBeVisible();

  await personal.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog", { name: "Remove Account" }).getByRole("button", { name: "Remove Account" }).click();
  await expect(personal).toHaveCount(0);
  await expect(page.getByText("Account removed.", { exact: true })).toBeVisible();
  await expect(accounts.locator(".agent-row").filter({ hasText: "Work" })).toBeVisible();
  await page.screenshot({ path: "test-results/provider-accounts/remove-account-done.png", fullPage: true });
});

test("Owners adopt and revoke provider profiles, confirming active sessions; members only see the state (#3239)", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?profiles&${DESIGN_WORKSTATION}`);
  await page.getByText("Accounts", { exact: true }).click();
  const accounts = page.locator("details.runner-agents").filter({ hasText: "Accounts" });
  const row = (label: string) => accounts.locator(".agent-row").filter({ hasText: label });
  await expect(row("Work").locator(".atag.ctx")).toHaveText("Profile");
  await expect(row("Personal").locator(".atag", { hasText: "Grant Pending" })).toBeVisible();
  await expect(row("Codex Team").locator(".atag.broken")).toHaveText("Not Granted");
  await expect(row("Codex Solo").locator(".atag")).toHaveText(["Codex", "Logged In"]);
  await expect(row("Work").getByRole("button", { name: "Adopt as Profile" })).toHaveCount(0);
  await expect(row("Personal").getByRole("button", { name: "Adopt as Profile" })).toBeVisible();
  await expect(row("Personal").getByRole("button", { name: "Revoke Access" })).toBeVisible();
  await accounts.screenshot({ path: "test-results/provider-accounts/profile-states.png" });

  await row("Codex Solo").getByRole("button", { name: "Adopt as Profile" }).click();
  const adoption = page.getByRole("dialog", { name: "Adopt as Profile" });
  await expect(adoption).toContainText("only control planes granted this profile can use this account's HOME");
  await page.screenshot({ path: "test-results/provider-accounts/adopt-profile-confirm.png", fullPage: true });
  await adoption.getByRole("button", { name: "Adopt as Profile" }).click();
  await expect(page.getByText("Account adopted as a profile.", { exact: true })).toBeVisible();
  await expect(row("Codex Solo").locator(".atag.ctx")).toHaveText("Profile");

  await row("Work").getByRole("button", { name: "Revoke Access" }).click();
  await page.getByRole("dialog", { name: "Revoke Access" }).getByRole("button", { name: "Revoke Access" }).click();
  const force = page.getByRole("dialog", { name: "Revoke Access from Active Sessions" });
  await expect(force).toContainText("3 active sessions use this account's profile.");
  await expect(force).toContainText("Fix the half-cent rounding bug");
  await expect(force).toContainText("and 1 more");
  await page.screenshot({ path: "test-results/provider-accounts/revoke-profile-force-confirm.png", fullPage: true });
  await force.getByRole("button", { name: "Revoke Access" }).click();
  await expect(page.getByText("Access revoked.", { exact: true })).toBeVisible();
  await expect(row("Work").locator(".atag.ctx")).toHaveCount(0);

  await page.goto(`/machine-management-e2e.html?profiles&role=machine-owner&${DESIGN_WORKSTATION}`);
  await page.getByText("Accounts", { exact: true }).click();
  await expect(row("Personal").locator(".atag", { hasText: "Grant Pending" })).toBeVisible();
  await expect(accounts.getByRole("button", { name: "Adopt as Profile" })).toHaveCount(0);
  await expect(accounts.getByRole("button", { name: "Revoke Access" })).toHaveCount(0);
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

test("offline recovery stays stacked and usable in a narrow detail on a desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setOffline(page);
  const card = page.locator("article.machine-detail");
  await card.evaluate((element) => { (element as HTMLElement).style.width = "260px"; });

  await expect.poll(() => card.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(280);
  expect(await page.evaluate(() => window.innerWidth)).toBe(1280);

  const repair = page.getByRole("button", { name: "Repair Connection…", exact: true });
  await expect(repair).toHaveText("Repair Connection…");
  const geometry = await machineNotice(page).evaluate(recoveryGeometry);
  expect(geometry.button).not.toBeNull();
  // A Notice puts its actions in a row under the body (docs/design-system.md §13.2): the content
  // gap plus the row's top margin, 8px, replacing the old box hint's 12px.
  expect(geometry.button!.top).toBeGreaterThanOrEqual(geometry.message.bottom + 7);
  expect(Math.abs(geometry.button!.left - geometry.message.left)).toBeLessThanOrEqual(0.5);
  // At its own width under the message, not stretched into a bar (§3.1), and a small button's
  // control height: 28px with this fine pointer.
  expect(geometry.button!.width).toBeLessThanOrEqual(geometry.message.width + 0.5);
  expect(geometry.button!.right).toBeLessThanOrEqual(geometry.notice.right + 0.5);
  expect(geometry.button!.height).toBe(28);
  expect(geometry.button!.whiteSpace).toBe("nowrap");
  expect(geometry.button!.scrollWidth).toBeLessThanOrEqual(geometry.button!.clientWidth);
  expect(geometry.button!.scrollHeight).toBeLessThanOrEqual(geometry.button!.clientHeight);

  await repair.click();
  await expect(page.getByRole("dialog", { name: "Repair Connection" })).toBeVisible();
});

test.describe("on a touch phone", () => {
  // Touch sizing follows the pointer, not the viewport (#1799), so the 44px target is measured
  // where a finger is: a coarse-pointer context.
  test.use({ viewport: { width: 320, height: 720 }, hasTouch: true, isMobile: true });

  test("offline recovery stays stacked and usable on a narrow mobile viewport", async ({ page }) => {
    await setOffline(page);
    await machineRow(page).click();
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);

    const repair = page.getByRole("button", { name: "Repair Connection…", exact: true });
    await expect(repair).toBeVisible();
    const geometry = await machineNotice(page).evaluate(recoveryGeometry);
    expect(geometry.button).not.toBeNull();
    expect(geometry.button!.top).toBeGreaterThanOrEqual(geometry.message.bottom + 7);
    expect(Math.abs(geometry.button!.left - geometry.message.left)).toBeLessThanOrEqual(0.5);
    expect(geometry.button!.width).toBeLessThanOrEqual(geometry.message.width + 0.5);
    // A small button is 36px to look at on touch and borrows 4px on each side for a 44px target.
    expect(geometry.button!.height).toBeGreaterThanOrEqual(36);
    const hitsEdges = await repair.evaluate((element) => {
      element.scrollIntoView({ block: "center" });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      return [rect.top - 3.5, rect.bottom + 3.5].every((y) => element.contains(document.elementFromPoint(x, y)));
    });
    expect(hitsEdges, "the 44px hit area reaches past the visible button").toBe(true);
    expect(geometry.button!.whiteSpace).toBe("nowrap");
    expect(geometry.button!.labelWidth).toBeLessThanOrEqual(geometry.button!.clientWidth);
    expect(geometry.notice.left).toBeGreaterThanOrEqual(-0.5);
    expect(geometry.notice.right).toBeLessThanOrEqual(320.5);
  });
});

test("non-admin recovery guidance wraps inside a narrow mobile detail", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/machine-management-e2e.html?role=viewer");
  await machineRow(page).click();
  await expect(page.getByRole("heading", { name: "Design Workstation", exact: true })).toBeVisible();
  await setOffline(page);

  await expect(page.getByRole("button", { name: "Repair Connection…", exact: true })).toHaveCount(0);
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
  await openSettings(page);
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
  await openSettings(page);
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
  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  await expect(dialog.getByRole("heading", { name: "Automatic Account Switching" })).toBeVisible();
  await expect(dialog.getByText("Disabled. Provider usage limits continue to park sessions as before.", {
    exact: true,
  })).toBeVisible();

  await dialog.getByRole("button", { name: "Enable Automatic Switching" }).click();
  const warning = page.getByRole("dialog", { name: "Enable Automatic Switching" });
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

test("Machine settings save independent Claude and Codex default accounts", async ({ page }) => {
  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  await expect(dialog.getByRole("heading", { name: "Default Provider Accounts" })).toBeVisible();
  const defaults = dialog.locator("section.machine-settings-section")
    .filter({ hasText: "Default Provider Accounts" });
  const claude = dialog.getByRole("button", { name: /Default Claude Account:/u });
  const codex = dialog.getByRole("button", { name: /Default Codex Account:/u });
  await expect(claude).toHaveAccessibleName(/Use Existing Behavior/u);
  await expect(codex).toHaveAccessibleName(/Use Existing Behavior/u);
  await defaults.screenshot({ path: "test-results/provider-accounts/defaults-before-desktop.png" });

  await claude.click();
  await page.getByRole("option", { name: /Personal/u }).click();
  await expect(claude).toHaveAccessibleName(/Personal/u);
  await codex.click();
  await page.getByRole("option", { name: /Codex Solo/u }).click();
  await expect(codex).toHaveAccessibleName(/Codex Solo/u);
  await defaults.screenshot({ path: "test-results/provider-accounts/defaults-after-desktop.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await defaults.screenshot({ path: "test-results/provider-accounts/defaults-after-mobile.png" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await defaults.screenshot({ path: "test-results/provider-accounts/defaults-after-mobile-light.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await defaults.screenshot({ path: "test-results/provider-accounts/defaults-after-desktop-light.png" });

  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.getByText("Accounts", { exact: true }).click();
  const personal = page.locator("details.runner-agents .agent-row").filter({ hasText: "Personal" });
  await personal.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog", { name: "Remove Account" }).getByRole("button", { name: "Remove Account" }).click();
  await openSettings(page);
  const reopened = page.getByRole("dialog", { name: "Manage Design Workstation" });
  const missing = reopened.locator("section.machine-settings-section").filter({ hasText: "Default Provider Accounts" });
  await expect(missing).toContainText("The saved account is no longer on this Machine");
  await missing.screenshot({ path: "test-results/provider-accounts/defaults-missing-desktop.png" });
});

test("ordinary members can inspect Runner Capacity but cannot change it", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?role=viewer&${DESIGN_WORKSTATION}`);
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Capacity" })).toContainText("12 of 16 Units Used");
  await expect(page.getByRole("button", { name: "Settings…" })).toHaveCount(0);
});

test("a Machine owner can change capacity without receiving organization-wide controls", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?role=machine-owner&${DESIGN_WORKSTATION}`);
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  await expect(dialog.getByLabel("Runner Capacity", { exact: true })).toBeEnabled();
  await expect(dialog.getByRole("heading", { name: "Machine Details" })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Workspaces" })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Danger Zone" })).toHaveCount(0);
});

test("Machine settings expose deletion with an explicit history warning", async ({ page }) => {
  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Manage Design Workstation" });
  const deleteMachine = dialog.getByRole("button", { name: "Delete Machine" });
  await expect(deleteMachine).toBeDisabled();
  await expect(deleteMachine).toHaveAttribute("title", "Stop this native runner before deleting the Machine");
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setRunnerStatus("offline"));
  await expect(deleteMachine).toBeEnabled();
  await deleteMachine.click();

  const confirmation = page.getByRole("dialog", { name: "Delete Machine" });
  await expect(confirmation).toContainText("Design Workstation, its sessions and its multi-agent runs are deleted from Wollipog. Files on the machine stay where they are.");
  await confirmation.getByRole("button", { name: "Delete Machine" }).click();
  await expect(page.getByText("No Machines Yet")).toBeVisible();
  // The empty tab owns the create actions, so the header no longer offers Add Machine (#2984).
  await expect(page.locator(".page-header").getByRole("button", { name: "Add Machine" })).toHaveCount(0);
  await expect(page.locator(".connections-empty .row button")).toHaveText(["Connect via SSH", "Install Manually"]);
});

test("SSH config import keeps the selected Host and auto-populates an editable Machine Name", async ({ page }) => {
  await page.locator(".page-header").getByRole("button", { name: "Add Machine", exact: true }).click();
  await page.getByRole("menu", { name: "Add Machine" }).getByRole("menuitem", { name: "Connect via SSH…" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect via SSH" });
  const hosts = dialog.getByRole("button", { name: /^Choose from SSH Config:/ });
  const choose = async (host: string) => {
    await hosts.click();
    await page.getByRole("option", { name: new RegExp(`^${host}`) }).click();
  };

  await choose("golf-sim");
  await expect(hosts).toHaveAccessibleName("Choose from SSH Config: golf-sim");
  await expect(dialog.getByLabel("Machine Name (Optional)")).toHaveValue("golf-sim");
  await expect(dialog.getByLabel("SSH Target")).toHaveValue("golf-sim");
  await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue("2222");

  await dialog.getByLabel("Machine Name (Optional)").fill("Golf Simulator");
  await choose("build-box");
  await expect(hosts).toHaveAccessibleName("Choose from SSH Config: build-box");
  await expect(dialog.getByLabel("Machine Name (Optional)")).toHaveValue("Golf Simulator");
  await expect(dialog.getByLabel("SSH Target")).toHaveValue("build-box");
  await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue("22");

  await dialog.getByRole("button", { name: "Connect Machine" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.lastAddBoxRequest()))
    .toMatchObject({
      displayName: "Golf Simulator",
      sshTarget: "build-box",
      sshPort: 22,
    });
});

test("a failed permission load is a danger notice whose Retry recovers the Machines tab (#2984)", async ({ page }) => {
  await page.goto("/machine-management-e2e.html?identity=fail");
  const notice = page.getByRole("alert").filter({ hasText: "Couldn't Load Machine Permissions" });
  await expect(notice).toBeVisible();
  await expect(notice).not.toContainText("503 Service Unavailable");
  await notice.getByRole("button", { name: "Show Details" }).click();
  await expect(notice).toContainText("503 Service Unavailable");
  await expect(page.locator(".page-header").getByRole("button", { name: "Add Machine" })).toHaveCount(0);
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.restoreIdentity());
  await notice.getByRole("button", { name: "Retry" }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.locator(".page-header").getByRole("button", { name: "Add Machine", exact: true })).toBeVisible();
});

test("the empty Machines tab leads with SSH in the web app and This Machine in the desktop app (#2984)", async ({ page }) => {
  const buttons = page.locator(".connections-empty .add-machine-method .btn");
  await page.goto("/machine-management-e2e.html?machines=0");
  await expect(buttons).toHaveText(["Connect via SSH", "Install Manually"]);
  await expect(buttons.first()).toHaveClass("btn primary");

  await page.goto("/machine-management-e2e.html?machines=0&local=setup");
  await expect(buttons).toHaveText(["Set Up This Machine", "Connect via SSH", "Install Manually"]);
  await expect(buttons.first()).toHaveClass("btn primary");
  await expect(buttons.nth(1)).toHaveClass("btn");
  await buttons.first().click();
  await expect(page.getByRole("dialog", { name: "Set Up This Machine" })).toBeVisible();
});

test("a viewer's empty Machines tab says whom to ask and offers no methods (#2984)", async ({ page }) => {
  await page.goto("/machine-management-e2e.html?machines=0&role=viewer");
  await expect(page.getByText("No Machines Yet")).toBeVisible();
  await expect(page.getByText("Ask an organization owner or admin to connect a machine.")).toBeVisible();
  await expect(page.locator(".connections-empty .surface")).toHaveCount(0);
});

test.describe("the empty Machines tab on a touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("each method wraps, and its button keeps its natural width, 44px tall, under the text (#2984)", async ({ page }) => {
    await page.goto("/machine-management-e2e.html?machines=0");
    await expect(page.getByText("No Machines Yet")).toBeVisible();
    await expect(page.locator(".page-header .page-primary")).toHaveCount(0);
    const rows = page.locator(".connections-empty .add-machine-method");
    await expect(rows).toHaveCount(2);
    const geometry = await rows.evaluateAll((elements) => elements.map((row) => {
      const box = (selector: string) => row.querySelector(selector)!.getBoundingClientRect();
      return { row: row.getBoundingClientRect(), body: box(".row-body"), button: box(".btn"), page: document.documentElement.clientWidth };
    }));
    for (const [index, { row, body, button, page: width }] of geometry.entries()) {
      // The row grows to hold its wrapped button, so no button reaches into the next method.
      expect(button.bottom).toBeLessThanOrEqual(row.bottom);
      if (index > 0) expect(row.top).toBeGreaterThanOrEqual(geometry[index - 1]!.row.bottom - 0.5);
      expect(button.top).toBeGreaterThanOrEqual(body.bottom);
      expect(Math.abs(button.left - body.left)).toBeLessThanOrEqual(0.5);
      expect(button.width).toBeLessThan(row.width - (body.left - row.left));
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(row.right).toBeLessThanOrEqual(width);
    }
  });
});

/** Where each pane sits and how it scrolls (#2985). */
const paneGeometry = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const list = document.querySelector<HTMLElement>(".master-detail-list")!;
  const listBody = list.querySelector<HTMLElement>(".master-detail-list-body")!;
  const detail = document.querySelector<HTMLElement>(".master-detail-detail")!;
  return {
    list: list.getBoundingClientRect().toJSON() as DOMRect,
    detail: detail.getBoundingClientRect().toJSON() as DOMRect,
    listScrolls: listBody.scrollHeight > listBody.clientHeight && getComputedStyle(listBody).overflowY === "auto",
    detailScrolls: detail.scrollHeight > detail.clientHeight && getComputedStyle(detail).overflowY === "auto",
    documentScrolls: document.scrollingElement!.scrollHeight > document.scrollingElement!.clientHeight,
  };
});

test("at 1440px the Machines list is 320px beside the detail and each scrolls on its own (#2985)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/machine-management-e2e.html?machines=20");
  await expect(page.getByRole("heading", { name: "All Machines" })).toBeVisible();
  await expect(page.locator(".runner-grid")).toHaveCount(0);
  const geometry = await paneGeometry(page);
  expect(geometry.list.width).toBe(320);
  expect(geometry.detail.left).toBeGreaterThanOrEqual(geometry.list.right - 0.5);
  expect(geometry.detail.top).toBeCloseTo(geometry.list.top, 0);
  expect(geometry.listScrolls, "the list scrolls inside its pane").toBe(true);
  expect(geometry.documentScrolls, "the page itself does not scroll").toBe(false);
  // Scrolling the list leaves the detail where it is.
  const listBody = page.locator(".master-detail-list-body");
  await listBody.evaluate((element) => { element.scrollTop = 200; });
  expect(await page.locator(".master-detail-detail").evaluate((element) => element.scrollTop)).toBe(0);
  // All Machines is selected beside its overview (#2986); a machine's row moves the selection.
  await expect(machineRow(page, "All Machines")).toHaveClass(/is-selected/);
  await machineRow(page, "Studio Mac").click();
  await expect(page.getByRole("heading", { name: "Studio Mac" })).toBeVisible();
  await expect(page.locator(".row.is-selected")).toHaveCount(1);
});

test("in the compact tier the Machines list is 280px (#2985)", async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 900 });
  await page.goto("/machine-management-e2e.html?machines=3");
  await expect(page.getByRole("heading", { name: "All Machines" })).toBeVisible();
  const geometry = await paneGeometry(page);
  expect(geometry.list.width).toBe(280);
  expect(geometry.detail.left).toBeGreaterThanOrEqual(geometry.list.right - 0.5);
});

// 761px leaves this rail-less harness a detail under 440px, as compact widths with the labelled rail
// do, so Capacity's rows take two lines there (review CR-1.1).
for (const width of [1440, 834, 761]) {
  test(`at ${width}px the All Machines overview's Capacity meters line up and nothing overflows (#2986)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/machine-management-e2e.html?machines=10");
    const overview = page.locator(".machines-overview");
    await expect(overview.getByRole("heading", { name: "All Machines" })).toBeVisible();
    await expect(machineRow(page, "All Machines")).toHaveClass(/is-selected/);
    const meters = overview.locator(".machine-capacity-row > .meter");
    await expect(meters.first()).toBeVisible();
    const boxes = await meters.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON() as DOMRect));
    expect(boxes.length).toBeGreaterThan(3);
    for (const box of boxes) {
      expect(box.left).toBeCloseTo(boxes[0]!.left, 0);
      expect(box.width).toBeCloseTo(boxes[0]!.width, 0);
      expect(box.width, "the meter keeps room to compare").toBeGreaterThanOrEqual(64);
    }
    const titles = await overview.locator(".machine-capacity-row > .row-title")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
    for (const titleWidth of titles) expect(titleWidth, "every machine's name keeps its room").toBeGreaterThanOrEqual(80);
    const heights = await overview.locator("button.machine-capacity-row")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
    expect(new Set(heights).size, "every Capacity row is one height").toBe(1);
    await expect(overview.locator(".machine-capacity-rest .row-title")).toHaveText("and 2 more machines");
    const overflow = await page.locator(".master-detail-detail").evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow, "the overview never scrolls sideways").toBeLessThanOrEqual(0);
  });
}

test("past eight machines the list groups under three labels and filters by name (#2985)", async ({ page }) => {
  await page.goto("/machine-management-e2e.html?machines=9");
  const list = page.getByRole("complementary", { name: "Machines" });
  await expect(list.locator(".group-label")).toHaveText(["Needs Attention5", "Online3", "Offline1"]);
  await list.getByRole("searchbox", { name: "Filter Machines" }).fill("studio");
  await expect(list.locator("button.row.row-2 .row-title")).toHaveText(["Studio Mac"]);
  for (const row of await list.locator("button.row.row-2").all()) await expect(row.locator(".status")).toHaveCount(1);
});

test("a machine's route opens it directly, and an unknown one says Machine Not Found (#2985)", async ({ page }) => {
  await page.goto("/machine-management-e2e.html?machines=3&machine=gpu-box");
  await expect(page.getByRole("heading", { name: "GPU Box" })).toBeVisible();
  await expect(machineRow(page, "GPU Box")).toHaveClass(/is-selected/);
  await page.goto("/machine-management-e2e.html?machine=gone");
  await expect(page.getByText("Machine Not Found")).toBeVisible();
  await page.getByRole("button", { name: "Show All Machines" }).click();
  await expect(page.getByRole("heading", { name: "All Machines" })).toBeVisible();
});

test("disconnected, the last-known rows stay dimmed under Reconnecting… (#2985)", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.disconnect());
  const list = page.getByRole("complementary", { name: "Machines" });
  await expect(list.getByRole("status").filter({ hasText: "Reconnecting…" })).toBeVisible();
  await expect(list.locator(".is-stale").locator("button.row.row-2")).toHaveCount(1);
});

test("before the first snapshot the list shows skeleton rows and no empty state (#2985)", async ({ page }) => {
  await page.goto("/machine-management-e2e.html?snapshot=hold");
  await expect(page.locator(".master-detail-list .machine-row-skeleton")).toHaveCount(3);
  await expect(page.locator(".master-detail-detail .detail-skeleton")).toBeVisible();
  await expect(page.getByText("No Machines Yet")).toHaveCount(0);
});

test.describe("the Machines list and detail on a touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a row opens the detail route under Back and the machine's name; Back returns to the list where it was (#2985)", async ({ page }) => {
    await page.goto("/machine-management-e2e.html?machines=20");
    const list = page.getByRole("complementary", { name: "Machines" });
    await expect(page.locator(".page-header").getByRole("tablist", { name: "Connections" })).toBeVisible();
    await expect(page.locator(".row.is-selected")).toHaveCount(0);
    const listBody = page.locator(".master-detail-list-body");
    await listBody.evaluate((element) => { element.scrollTop = 300; });
    await expect.poll(() => listBody.evaluate((element) => element.scrollTop)).toBe(300);
    await machineRow(page, "CI Runner 9").click();

    const bar = page.locator(".detail-bar");
    await expect(bar.getByRole("button", { name: "Back to Connections" })).toBeVisible();
    await expect(bar).toContainText("CI Runner 9");
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(list).toBeHidden();

    await bar.getByRole("button", { name: "Back to Connections" }).click();
    await expect(list).toBeVisible();
    await expect(page.locator(".page-header").getByRole("tablist", { name: "Connections" })).toBeVisible();
    expect(await listBody.evaluate((element) => element.scrollTop)).toBe(300);
    await expect(page.locator(".row.is-selected")).toHaveCount(0);
  });
});

/** The detail's meta line and every control in its title row and the app bar (#2988). */
const headerGeometry = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const meta = document.querySelector<HTMLElement>(".machine-detail-meta")!;
  const controls = [...document.querySelectorAll<HTMLElement>(".machine-detail-title-row button, .detail-bar button")]
    .filter((control) => control.getClientRects().length > 0);
  const root = document.scrollingElement!;
  const detail = document.querySelector<HTMLElement>(".master-detail-detail")!;
  return {
    metaRight: meta.getBoundingClientRect().right,
    metaOverflows: meta.scrollWidth > meta.clientWidth,
    metaTransforms: [...meta.querySelectorAll("li")].map((item) => getComputedStyle(item).textTransform),
    metaText: [...meta.querySelectorAll("li")].map((item) => item.textContent),
    metaLines: Math.round(meta.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(meta).lineHeight)),
    pageScrollsSideways: root.scrollWidth > root.clientWidth || detail.scrollWidth > detail.clientWidth,
    controls: controls.map((control) => {
      // The hit area may reach past the visible box (§15.3): measure what a tap at each edge hits.
      control.scrollIntoView({ block: "nearest" });
      const rect = control.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const reach = (dx: number, dy: number) => control.contains(document.elementFromPoint(x + dx, y + dy));
      return {
        name: control.getAttribute("aria-label") ?? control.textContent?.trim(),
        tall: reach(0, -21.5) && reach(0, 21.5),
        wide: reach(-21.5, 0) && reach(21.5, 0),
      };
    }),
  };
});

for (const width of [320, 390]) {
  test.describe(`the machine detail on a ${width}px touch phone`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });

    test("the meta line truncates on one line, keeps the OS's own casing, and every app bar control is 44px (#2988)", async ({ page }) => {
      await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__
        .setRunnerHostname("design-workstation-in-the-third-floor-studio.corp.example.com"));
      await machineRow(page).click();
      await expect(page.locator(".detail-bar")).toContainText("Design Workstation");
      const geometry = await headerGeometry(page);
      expect(geometry.metaText).toEqual(["Native Runner", "design-workstation-in-the-third-floor-studio.corp.example.com", "Windows"]);
      expect(geometry.metaTransforms.every((transform) => transform === "none"), geometry.metaTransforms.join()).toBe(true);
      expect(geometry.metaLines).toBe(1);
      expect(geometry.metaRight).toBeLessThanOrEqual(width + 0.5);
      expect(geometry.pageScrollsSideways).toBe(false);
      expect(geometry.controls.map((control) => control.name)).toEqual(expect.arrayContaining(["Back to Connections", "Machine Actions"]));
      for (const control of geometry.controls) expect(control, `${control.name} is a 44px target`).toMatchObject({ tall: true, wide: true });
    });

    test("the app bar's ⋯ starts with Settings…, and Delete Machine… replaces the sheet with a confirmation that has Back (#2988)", async ({ page }) => {
      await setOffline(page);
      await machineRow(page).click();
      const detail = page.locator("article.machine-detail");
      await expect(detail.getByRole("button", { name: "Settings…" })).toHaveCount(0);
      await page.locator(".detail-bar").getByRole("button", { name: "Machine Actions" }).click();
      const sheet = page.getByRole("menu", { name: "Machine Actions" });
      await expect(sheet.getByRole("menuitem")).toHaveText([
        "Settings…", "Repair Connection…", "Connection Details…", "Delete Machine…",
      ].map((label) => new RegExp(`^${label}`)));
      await sheet.getByRole("menuitem", { name: "Delete Machine…" }).click();
      const confirmation = page.getByRole("dialog", { name: "Delete Machine" });
      await expect(confirmation).toBeVisible();
      await expect(sheet).toHaveCount(0);
      await confirmation.getByRole("button", { name: "Back to More Actions" }).click();
      await expect(page.getByRole("menu", { name: "Machine Actions" })).toBeVisible();
    });
  });
}

test.describe("the machine detail with a coarse pointer at tablet width", () => {
  test.use({ viewport: { width: 834, height: 900 }, hasTouch: true, isMobile: true });

  test("Settings… and ⋯ in the title row are 44px targets (#2988)", async ({ page }) => {
    await expect(page.locator(".machine-detail-title-row").getByRole("button", { name: "Settings…" })).toBeVisible();
    const geometry = await headerGeometry(page);
    expect(geometry.controls.map((control) => control.name)).toEqual(["Settings…", "Machine Actions"]);
    for (const control of geometry.controls) expect(control, `${control.name} is a 44px target`).toMatchObject({ tall: true, wide: true });
    expect(geometry.metaTransforms.every((transform) => transform === "none")).toBe(true);
  });
});

test("an SSH machine's busy update asks to interrupt its sessions, and Connection Details copies every fact (#2988)", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/machine-management-e2e.html?ssh=online&outdated&busy&${DESIGN_WORKSTATION}`);
  const notice = machineNotice(page);
  await expect(notice).toContainText("Runner Update Required");
  await notice.getByRole("button", { name: "Update Runner…" }).click();
  const interrupt = page.getByRole("dialog", { name: "Interrupt Sessions and Update" });
  await expect(interrupt).toContainText("Updating this runner will interrupt 2 active sessions.");
  await expect(interrupt).toContainText("Fix the half-cent rounding bug");
  await interrupt.getByRole("button", { name: "Interrupt Sessions and Update" }).click();
  await expect(page.getByText("Deploying the update. The status changes when the runner is back online.")).toBeVisible();

  await page.locator(".machine-detail-title-row").getByRole("button", { name: "Machine Actions" }).click();
  await page.getByRole("menu", { name: "Machine Actions" }).getByRole("menuitem", { name: "Connection Details…" }).click();
  const details = page.getByRole("dialog", { name: "Connection Details" });
  await expect(details.locator(".facts dt")).toHaveText([
    "Connection", "SSH Target", "Host", "Operating System", "Runner Version", "Last Seen", "Worktree Storage", "Sandboxing",
    "Deployed Build", "Platform",
  ]);
  await expect(details.locator(".facts dd").nth(6)).toHaveText("Not available");
  await details.getByRole("button", { name: "Copy All" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  for (const label of ["Connection: SSH", "SSH Target: misko@design-workstation", "Operating System: Windows", "Deployed Build: 0.42.0+fixture", "Platform: x86_64-pc-windows-msvc"]) {
    expect(copied).toContain(label);
  }
});

test("an SSH connection refused for its key says so and keeps ssh's words behind Show Details (#2988)", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?ssh=failed&${DESIGN_WORKSTATION}`);
  const notice = machineNotice(page);
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("Couldn't Connect to Design Workstation");
  await expect(notice).toContainText("The host refused your SSH key. Load the key with ssh-add, then try again.");
  await expect(notice).not.toContainText("publickey");
  await notice.getByRole("button", { name: "Show Details" }).click();
  await expect(notice).toContainText("Permission denied (publickey).");
  await expect(notice.getByRole("button", { name: "Try Again" })).toBeVisible();
});
