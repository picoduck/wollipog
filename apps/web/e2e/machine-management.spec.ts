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

/** An agent's row in the machine's Agents section (#2990), by its exact name. */
const agentRow = (page: import("@playwright/test").Page, name: string) =>
  page.locator("article.machine-detail button.row").filter({
    has: page.locator(".row-title", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }),
  });
/** Machine Settings (#2991), one form whose description is the machine's name. */
const settingsDialog = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "Machine Settings" });
/** One of Agent Installations' radio groups (#2991), by its label. */
const installationGroup = (page: import("@playwright/test").Page, label: string) =>
  settingsDialog(page).getByRole("radiogroup", { name: label, exact: true });

/** The open machine's one lifecycle notice (#2988). */
const machineNotice = (page: import("@playwright/test").Page) => page.locator("article.machine-detail > .notice");

test.beforeEach(async ({ page }) => {
  // A phone shows the list alone (#2985). Wider, nothing is selected by itself (#2986), so the
  // scenarios open Design Workstation by its route.
  const phone = (page.viewportSize()?.width ?? 1280) <= 760;
  await page.goto(phone ? "/machine-management-e2e.html" : `/machine-management-e2e.html?${DESIGN_WORKSTATION}`);
  await expect(phone ? machineRow(page) : page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
});

test("each agent row shows one status, and an agent not installed folds away (#2990)", async ({ page }) => {
  await expect(agentRow(page, "Custom ACP").locator(".status")).toHaveText("Ready");
  await expect(agentRow(page, "Legacy Unverified ACP").locator(".status")).toHaveText("Unavailable");
  const notInstalled = page.locator("article.machine-detail details.disclosure").filter({ hasText: "1 Agent Not Installed" });
  await expect(notInstalled).not.toHaveAttribute("open", "");
  await expect(agentRow(page, "Missing ACP")).toBeHidden();
  await notInstalled.locator("summary").click();
  await expect(agentRow(page, "Missing ACP").locator(".status")).toHaveText("Not Installed");
  await expect(page.getByRole("region", { name: /^Agents/ }).locator(".atag, .auth-dot, pre")).toHaveCount(0);
  await agentRow(page, "Missing ACP").click();
  const details = page.getByRole("dialog", { name: "Missing ACP" });
  await expect(details.locator(".notice")).toContainText("configured command was not found");
});

test("each agent row keeps one whole badge, and at 390px only its integration under the name (#2990)", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("agent-states"));
  const badges: Array<[string, string]> = [
    ["Claude Code (v2.1.4)", "Ready"],
    ["Codex App Server (v0.155.1)", "Sign-In Required"],
    ["Codex App Server (v0.140.0)", "Update Required"],
    ["Gemini CLI", "Approval Required"],
    ["Goose", "Ready"],
  ];
  for (const [name, status] of badges) await expect(agentRow(page, name).locator(".status")).toHaveText(status);
  await expect(page.locator("article.machine-detail details.disclosure > summary").filter({ hasText: "3 Agents Not Installed" }))
    .toBeVisible();
  await expect(agentRow(page, "Claude Code (v2.1.4)").locator(".row-sub > span:visible")).toHaveText(
    ["Claude Code Native", "Native", "v2.1.4"],
  );
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name] of badges) {
    const row = agentRow(page, name);
    await expect(row.locator(".row-sub > span:visible")).toHaveCount(1);
    const fits = await row.evaluate((element) => {
      const badge = element.querySelector<HTMLElement>(".status")!;
      return badge.scrollWidth <= badge.clientWidth && badge.getBoundingClientRect().right <= element.getBoundingClientRect().right;
    });
    expect(fits, `${name}'s badge is whole and inside its row`).toBe(true);
  }
});

test("Agent Details leads with the fix, and Approve Launch… confirms the exact preview (#2990)", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("agent-states"));
  await agentRow(page, "Codex App Server (v0.155.1)").click();
  const signIn = page.getByRole("dialog", { name: "Codex App Server (v0.155.1)" });
  await expect(signIn.locator(".notice")).toContainText("Sign-In Required");
  await expect(signIn.locator(".notice .code-well code")).toHaveText("codex login");
  await expect(signIn.getByRole("button", { name: "Find Sessions…" })).toBeVisible();
  await signIn.getByRole("button", { name: "Done" }).click();
  await expect(agentRow(page, "Codex App Server (v0.155.1)")).toBeFocused();

  await agentRow(page, "Gemini CLI").click();
  const gemini = page.getByRole("dialog", { name: "Gemini CLI" });
  await gemini.getByRole("button", { name: "Approve Launch…" }).click();
  const approve = page.getByRole("dialog", { name: "Approve Launch" });
  await expect(approve.locator(".code-well pre")).toHaveText("npx --yes @google/gemini-cli@1.2.0 --experimental-acp");
  await expect(approve.getByRole("button", { name: "Approve Launch", exact: true })).toHaveClass(/\bprimary\b/);
  await approve.getByRole("button", { name: "Cancel" }).click();
  await gemini.getByRole("button", { name: "Done" }).click();

  await agentRow(page, "Goose").click();
  const goose = page.getByRole("dialog", { name: "Goose" });
  await goose.getByRole("button", { name: "Revoke Approval…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Revoke Approval" }).or(page.getByRole("dialog", { name: "Revoke Approval" }))
    .getByRole("button", { name: "Revoke Approval", exact: true })).toHaveClass(/\bdanger\b/);
});

test("Choose Another Installation… opens Machine Settings with focus and view on Agent Installations (#2990, #2991)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("selected-installation-unavailable"));
  await agentRow(page, "Codex App Server (v0.155.1)").click();
  const details = page.getByRole("dialog", { name: "Codex App Server (v0.155.1)" });
  await expect(details.locator(".notice")).toContainText("Codex exited before it answered the check. Rediscover to check it again.");
  await details.getByRole("button", { name: "Choose Another Installation…" }).click();
  const settings = settingsDialog(page);
  const installations = settings.getByRole("group", { name: "Agent Installations" });
  // After the opening effects settle, focus and the view agree: the installations, not Machine Name.
  await page.waitForTimeout(500);
  await expect(installations).toBeFocused();
  await expect(installations).toBeInViewport();
  await expect(settings.getByLabel("Machine Name")).not.toBeFocused();
  await settings.getByRole("button", { name: "Cancel" }).click();
  // Agent Details stayed under Machine Settings.
  await expect(details).toBeVisible();
});

test("a machine's own manager gets no Choose Another Installation…, whose installations they cannot see (#2990)", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?role=machine-owner&${DESIGN_WORKSTATION}`);
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("selected-installation-unavailable"));
  await agentRow(page, "Codex App Server (v0.155.1)").click();
  const details = page.getByRole("dialog", { name: "Codex App Server (v0.155.1)" });
  await expect(details.locator(".notice")).toContainText("Rediscover to check it again.");
  await expect(details.getByRole("button", { name: "Choose Another Installation…" })).toHaveCount(0);
});

test("Machine Settings lists competing installations as one radio group and saves the other one (#2991)", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("multiple-installations"));
  await openSettings(page);
  const codex = installationGroup(page, "Codex");
  const system = codex.getByRole("radio", { name: "/usr/bin/codex" });
  const local = codex.getByRole("radio", { name: "/home/example/.local/bin/codex" });
  await expect(system).toBeChecked();
  await expect(local).not.toBeChecked();
  await expect(codex.locator(".choice-row").filter({ hasText: "/home/example/.local/bin/codex" })).toContainText("v0.210.0");
  await expect(codex.locator(".choice-row").filter({ hasText: "/home/example/.local/bin/codex" })).toContainText("Available. Signed in.");
  // Release facts are Agent Details' (#2990); the dialog has no per-row buttons.
  await expect(settingsDialog(page)).not.toContainText("New Release Published");
  await expect(settingsDialog(page).getByRole("button", { name: /Use This Installation|Selected/u })).toHaveCount(0);
  await local.check();
  await settingsDialog(page).getByRole("button", { name: "Save Changes" }).click();
  await expect(settingsDialog(page)).toHaveCount(0);
  await openSettings(page);
  await expect(installationGroup(page, "Codex").getByRole("radio", { name: "/home/example/.local/bin/codex" })).toBeChecked();
});

test("Machine Settings states each installation's availability, and Agent Details keeps its release guidance", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("harness-states"));
  await openSettings(page);
  const codex = installationGroup(page, "Codex");
  const row = (path: string) => codex.locator(".choice-row").filter({ hasText: path });
  await expect(row("Codex Tools")).toContainText("Available.");
  await expect(row("Legacy Tools")).toContainText("Unavailable. Codex 0.140.0 is older than the supported version 0.147.0.");
  // An unavailable installation can still be chosen; it is a saved choice that is missing that cannot.
  await expect(codex.getByRole("radio", { name: "C:\\Legacy Tools\\codex.exe" })).not.toHaveAttribute("aria-disabled", "true");
  // Claude Code and Pi have one installation each: nothing to choose.
  await expect(settingsDialog(page).getByRole("radiogroup")).toHaveCount(1);
  await settingsDialog(page).getByRole("button", { name: "Cancel" }).click();
  await agentRow(page, "Codex App Server (v0.155.1)").click();
  const details = page.getByRole("dialog", { name: "Codex App Server (v0.155.1)" });
  await expect(details.getByText("PowerShell 7.3 or later on this Machine", { exact: false })).toBeVisible();
  await expect(details.locator(".code-well code")).toHaveText(
    "& 'C:\\Program Files\\Codex Tools\\codex.exe' '--profile' 'Team''s Profile'",
  );
  await expect(details.getByText("Pinned by Machine Policy", { exact: true })).toBeVisible();
});

test("Agent Details treats Windows batch wrapper arguments as reference data", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("batch-wrapper"));
  await agentRow(page, "Codex App Server").click();
  const details = page.getByRole("dialog", { name: "Codex App Server" });
  await expect(details.getByText(/so there is no command to copy/)).toBeVisible();
  await expect(details.locator("dt").filter({ hasText: /^Executable$/ }).locator("+ dd code"))
    .toHaveText("C:\\Program Files\\Codex Tools\\codex.cmd");
  await expect(details.locator("dt", { hasText: "Arguments" }).locator("+ dd code"))
    .toHaveText('["--profile","Team \\"Research\\"","%PATH%"]');
  await expect(details.locator(".code-well")).toHaveCount(0);
  await expect(details.getByRole("button", { name: /Copy .* Launch Command/ })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: "test-results/batch-wrapper-details-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(details).toBeVisible();
  await page.screenshot({ path: "test-results/batch-wrapper-details-mobile.png", fullPage: true });
});

test("Agent Details does not offer a copyable command for dotted Windows batch aliases", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("dotted-batch-wrapper"));
  await agentRow(page, "Codex App Server").click();
  const details = page.getByRole("dialog", { name: "Codex App Server" });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: "test-results/dotted-batch-wrapper-details-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/dotted-batch-wrapper-details-mobile.png", fullPage: true });
  await expect(details.getByText(/so there is no command to copy/)).toBeVisible();
  await expect(details.locator("dt").filter({ hasText: /^Executable$/ }).locator("+ dd code"))
    .toHaveText("codex.v2");
  await expect(details.getByRole("button", { name: /Copy .* Launch Command/ })).toHaveCount(0);
});

test("Agent Details does not offer an extensionless Windows batch launch to copy", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("extensionless-batch-wrapper"));
  await agentRow(page, "Codex App Server").click();
  const details = page.getByRole("dialog", { name: "Codex App Server" });
  await expect(details.getByText(/may resolve to a batch wrapper/)).toBeVisible();
  await expect(details.locator("dt").filter({ hasText: /^Executable$/ }).locator("+ dd code"))
    .toHaveText("codex");
  await expect(details.locator("dt", { hasText: "Arguments" }).locator("+ dd code"))
    .toHaveText('["--profile","Team \\"Research\\"","%PATH%"]');
  await expect(details.locator(".code-well")).toHaveCount(0);
  await expect(details.getByRole("button", { name: /Copy .* Launch Command/ })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: "test-results/extensionless-batch-wrapper-details-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(details).toBeVisible();
  await page.screenshot({ path: "test-results/extensionless-batch-wrapper-details-mobile.png", fullPage: true });
});

test("Agent Details shows explicit Windows command hosts as reference data", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("explicit-interpreter"));
  await agentRow(page, "Codex App Server").click();
  const details = page.getByRole("dialog", { name: "Codex App Server" });
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

test("older Windows runner update instructions are suppressed in Agent Details and Machine Settings", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("older-interpreter-guidance"));
  await agentRow(page, "Codex App Server").click();
  const details = page.getByRole("dialog", { name: "Codex App Server" });
  // A ready agent's details carry no update guidance at all (#2990), so never the unsafe command.
  await expect(details.getByText("Managed Externally", { exact: true })).toBeVisible();
  await expect(details).not.toContainText("Run `& 'C:\\Windows");
  await details.getByRole("button", { name: "Done" }).click();
  await openSettings(page);
  // Machine Settings carries no release guidance at all (#2991), so never the unsafe command.
  await expect(settingsDialog(page)).toBeVisible();
  await expect(settingsDialog(page)).not.toContainText("Run `& 'C:\\Windows");
});

test("an offline machine's settings say what saves now and what waits, and still list its installations (#2991)", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("multiple-installations"));
  await setOffline(page);
  await expect(page.getByRole("button", { name: "New Harness Release · View Settings" })).toHaveCount(0);
  await openSettings(page);
  await expect(settingsDialog(page).locator(".notice").first()).toHaveText(
    "Design Workstation is offline. Changes save now; Capacity Limit and automatic switching take effect when it reconnects.",
  );
  await expect(installationGroup(page, "Codex").getByRole("radio")).toHaveCount(2);
  // Nothing here needs the machine online, so every field stays enabled.
  await expect(settingsDialog(page).getByLabel("Capacity Limit")).toBeEnabled();
  await expect(settingsDialog(page).getByRole("switch", { name: "Switch Accounts Automatically" })).toBeEnabled();
  await expect(settingsDialog(page).getByRole("button", { name: "Delete Machine…" })).toBeEnabled();
});

test("an SSH machine's failed release check reads Check Failed in Agent Details, and its menu offers Reconnect", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("harness-states-ssh"));
  const detail = page.locator('article.machine-detail[data-kind="ssh"]');
  await detail.getByRole("button", { name: "Machine Actions" }).click();
  const actions = page.getByRole("menu", { name: "Machine Actions" });
  await expect(actions.getByRole("menuitem", { name: "Reconnect", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await agentRow(page, "Failed Pi").click();
  await expect(page.getByRole("dialog", { name: "Failed Pi" }).locator("dt", { hasText: "Updates" }).locator("+ dd"))
    .toHaveText("Check Failed");
});

test("Machine Settings keeps same-name container installations scoped to their targets (#2991)", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("target-installations"));
  await openSettings(page);
  const alpha = installationGroup(page, "Codex in Alpha Image");
  const beta = installationGroup(page, "Codex in Beta Image");
  await expect(alpha.getByRole("radio", { name: "/usr/bin/codex" })).toBeChecked();
  await expect(beta.getByRole("radio", { name: "/usr/bin/codex" })).not.toBeChecked();
  await expect(alpha).toContainText("Available. Signed in.");
  await expect(beta).toContainText("Available.");
  await beta.getByRole("radio", { name: "/usr/bin/codex" }).check();
  await settingsDialog(page).getByRole("button", { name: "Save Changes" }).click();
  await expect(settingsDialog(page)).toHaveCount(0);
  await openSettings(page);
  await expect(installationGroup(page, "Codex in Beta Image").getByRole("radio", { name: "/usr/bin/codex" })).toBeChecked();
  await expect(installationGroup(page, "Codex in Alpha Image").getByRole("radio", { name: "/usr/bin/codex" })).toBeChecked();
});

test("an SSH machine with two installations and a missing saved choice shows the missing one as a disabled row (#2991)", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("ssh-installations"));
  await openSettings(page);
  await expect(installationGroup(page, "Codex").getByRole("radio")).toHaveCount(2);
  await expect(installationGroup(page, "Codex").locator(".choice-row").filter({ hasText: "/home/misko/.local/bin/codex" }))
    .toContainText("Unavailable. Sign in to this installation, then rediscover.");
  const claude = installationGroup(page, "Claude Code");
  const missing = claude.getByRole("radio", { name: "/opt/claude/bin/claude" });
  await expect(missing).toBeChecked();
  await expect(missing).toHaveAttribute("aria-disabled", "true");
  await expect(claude.locator(".choice-row").filter({ hasText: "/opt/claude/bin/claude" }))
    .toContainText("Saved choice not found. Choose another installation.");
  // An SSH machine is deleted through its connection, so Delete Machine… is offered while it is online.
  await expect(settingsDialog(page).getByRole("button", { name: "Delete Machine…" })).toBeEnabled();
  await claude.getByRole("radio", { name: "/usr/local/bin/claude" }).check();
  await settingsDialog(page).getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByText("Machine settings saved.", { exact: true })).toBeVisible();
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
  const state = page.locator("article.machine-detail .state");
  await expect(state.locator(".state-title")).toHaveText("No Agents Ready");
  await expect(state.getByText("Update this runner to verify its configured agent availability.", { exact: true })).toBeVisible();
  await expect(state.locator(".code-well")).toHaveCount(0);
  await expect(agentRow(page, "Legacy Unverified ACP").locator(".status")).toHaveText("Unavailable");
});

test("Connections show installation guidance for protocol v154 verified-unavailable agents", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("verified-unavailable"));
  const state = page.locator("article.machine-detail .state");
  await expect(state.locator(".state-title")).toHaveText("No Agents Ready");
  await expect(state.getByText("Install Claude Code or Codex on this machine, then rediscover.", { exact: true })).toBeVisible();
  await expect(state.getByRole("button", { name: "Copy Claude Code Install Command" })).toBeVisible();
  await expect(page.getByText("Update this runner to verify its configured agent availability.", { exact: true })).toHaveCount(0);
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
test("Machine settings rename the Machine, and Add Workspace… registers a Workspace without creating a Project", async ({ page }) => {
  await openSettings(page);
  const dialog = settingsDialog(page);
  await expect(dialog.locator(".modal-desc")).toHaveText("Design Workstation");
  // Workspaces live in the machine's detail (#2989), and its facts in Connection Details (#2988).
  await expect(dialog.getByRole("heading", { name: "Workspaces" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Add Workspace/ })).toHaveCount(0);
  await expect(dialog.getByText("Misko-T14s-G6", { exact: true })).toHaveCount(0);

  const name = dialog.getByLabel("Machine Name");
  await name.fill("Primary Development Machine");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Machine settings saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Primary Development Machine", exact: true })).toBeVisible();

  const workspaces = page.getByRole("region", { name: /^Workspaces/ });
  await workspaces.getByRole("button", { name: "Add Workspace…" }).click();
  const add = page.getByRole("dialog", { name: "Add Workspace" });
  await expect(add).toContainText("Primary Development Machine");
  await add.getByRole("button", { name: "repo" }).click();
  await expect(add.getByLabel("Workspace Name")).toHaveValue("repo");
  await add.getByRole("button", { name: "Add Workspace" }).click();

  await expect(add).toHaveCount(0);
  const row = workspaces.locator(".surface > .row").filter({ hasText: "repo" });
  await expect(row.locator(".machine-workspace-path")).toHaveAttribute("title", "C:\\Users\\misko\\repo");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.lastRegisteredWorkspace()))
    .toEqual({ name: "repo", path: "C:\\Users\\misko\\repo" });
});

test("Capacity shows live usage in the detail, and Change Limit… applies an authorized increase", async ({ page }) => {
  const capacity = page.getByRole("region", { name: "Capacity" });
  await expect(capacity.locator(".machine-capacity-figure")).toHaveText("12 of 16 units in use");
  await expect(capacity.getByRole("progressbar", { name: "Units in Use" })).toHaveClass(/t-warning/);
  await expect(capacity.getByRole("list", { name: "Capacity Breakdown" }).getByRole("listitem"))
    .toHaveText(["Active Turns 4 of 4", "Queued 3", "Idle Resumable 9", "Parked 2"]);
  await expect(capacity.locator(".notice.t-warning")).toHaveText("Claude is using 4 of 4 provider slots. 3 sessions waiting.");

  await capacity.getByRole("button", { name: "Change Limit…" }).click();
  const dialog = settingsDialog(page);
  // Change Limit… opens Machine Settings with focus in Capacity Limit (#2991).
  await expect(dialog.getByLabel("Capacity Limit")).toBeFocused();
  await expect(dialog.getByLabel("Runner Capacity Usage")).toHaveCount(0);
  await expect(dialog.getByLabel("Capacity Dimensions")).toHaveCount(0);
  await dialog.getByLabel("Capacity Limit").fill("24");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(capacity.locator(".machine-capacity-figure")).toHaveText("12 of 24 units in use");
  await expect(capacity.getByRole("progressbar", { name: "Units in Use" })).not.toHaveClass(/t-warning/);
});

for (const width of [1440, 390]) {
  test(`at ${width}px Capacity waits for a report, Workspaces says when it has none, and long paths stay in their rows (#2989)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const open = async (query: string) => {
      await page.goto(`/machine-management-e2e.html?${query}${width > 760 ? `&${DESIGN_WORKSTATION}` : ""}`);
      if (width <= 760) await machineRow(page).click();
      await expect(page.getByRole("region", { name: "Capacity" })).toBeVisible();
    };
    await open("capacity=waiting&workspaces=0");
    await expect(page.getByRole("region", { name: "Capacity" })).toContainText("Waiting for live capacity from this machine.");
    await expect(page.getByRole("region", { name: "Capacity" }).locator(".meter")).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Workspaces/ })).toContainText("No workspaces yet.");

    await open("workspaces=long");
    const rows = page.getByRole("region", { name: /^Workspaces/ }).locator(".surface > .row");
    await expect(rows).toHaveCount(3);
    const heights = await rows.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    expect(new Set(heights).size, "every row is one height").toBe(1);
    const path = rows.filter({ hasText: "Acme Storefront" }).locator(".machine-workspace-path");
    await expect(path).toHaveAttribute("title", /acme-storefront$/);
    if (width <= 760) expect(await path.evaluate((element) => element.scrollWidth > element.clientWidth), "a phone truncates the long path").toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test("turning on automatic switching confirms the provider terms first, and Cancel saves nothing (#2991)", async ({ page }) => {
  await openSettings(page);
  const dialog = settingsDialog(page);
  const toggle = dialog.getByRole("switch", { name: "Switch Accounts Automatically" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(dialog).toContainText("When an account reaches its usage limit, the next turn moves to another account from the same provider on this machine.");
  await toggle.click();
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  const confirmation = page.getByRole("dialog", { name: "Turn On Automatic Switching" });
  await expect(confirmation.locator(".notice.t-warning")).toContainText("prohibit circumventing rate limits");
  await expect(confirmation.locator(".modal-tone-icon")).toHaveCount(0);
  const turnOn = confirmation.getByRole("button", { name: "Turn On Automatic Switching" });
  await expect(turnOn).toHaveClass(/\bprimary\b/);
  await expect(turnOn).toBeFocused();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked"))).toBe("true");

  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await page.getByRole("dialog", { name: "Turn On Automatic Switching" }).getByRole("button", { name: "Turn On Automatic Switching" }).click();
  await expect(dialog).toHaveCount(0);
  await openSettings(page);
  await expect(settingsDialog(page).getByRole("switch", { name: "Switch Accounts Automatically" })).toHaveAttribute("aria-checked", "true");
});

test("Machine settings save independent Claude and Codex default accounts", async ({ page }) => {
  await openSettings(page);
  const dialog = settingsDialog(page);
  await expect(dialog.getByRole("group", { name: "Default Accounts" })).toBeVisible();
  const claude = dialog.getByRole("button", { name: /Default Claude Account:/u });
  const codex = dialog.getByRole("button", { name: /Default Codex Account:/u });
  await expect(claude).toHaveAccessibleName(/No Default/u);
  await expect(codex).toHaveAccessibleName(/No Default/u);

  await claude.click();
  await expect(page.getByRole("option", { name: /Work/u })).toContainText("Signed In");
  await expect(page.getByRole("option", { name: /Personal/u })).toContainText("Sign-In Required");
  await expect(page.getByRole("listbox")).not.toContainText(/Logged In|Login Required/u);
  await page.getByRole("option", { name: /Personal/u }).click();
  await codex.click();
  await page.getByRole("option", { name: /Codex Solo/u }).click();
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).toHaveCount(0);

  await openSettings(page);
  await expect(settingsDialog(page).getByRole("button", { name: /Default Claude Account:/u })).toHaveAccessibleName(/Personal/u);
  await expect(settingsDialog(page).getByRole("button", { name: /Default Codex Account:/u })).toHaveAccessibleName(/Codex Solo/u);
  await settingsDialog(page).getByRole("button", { name: "Cancel" }).click();
  await page.getByText("Accounts", { exact: true }).click();
  const personal = page.locator("details.runner-agents .agent-row").filter({ hasText: "Personal" });
  await personal.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog", { name: "Remove Account" }).getByRole("button", { name: "Remove Account" }).click();
  await openSettings(page);
  await expect(settingsDialog(page).getByRole("button", { name: /Default Claude Account:/u }))
    .toHaveAccessibleName(/Saved Account Not Found/u);
});

test("ordinary members can inspect Runner Capacity but cannot change it", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?role=viewer&${DESIGN_WORKSTATION}`);
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Capacity" })).toContainText("12 of 16 units in use");
  await expect(page.getByRole("button", { name: "Change Limit…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add Workspace…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings…" })).toHaveCount(0);
});

test("a Machine owner can change capacity without receiving organization-wide controls", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?role=machine-owner&${DESIGN_WORKSTATION}`);
  await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
  await openSettings(page);
  const dialog = settingsDialog(page);
  await expect(dialog.getByLabel("Capacity Limit")).toBeEnabled();
  await expect(dialog.getByRole("switch", { name: "Switch Accounts Automatically" })).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Default Accounts" })).toBeVisible();
  await expect(dialog.getByLabel("Machine Name")).toHaveCount(0);
  await expect(dialog.getByRole("group", { name: "Agent Installations" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete Machine…" })).toHaveCount(0);
});

test("Delete Machine… waits for an online native runner to stop, saying so, then confirms the deletion", async ({ page }) => {
  await openSettings(page);
  const deleteMachine = page.getByRole("button", { name: "Delete Machine…" });
  await expect(deleteMachine).toBeDisabled();
  await expect(page.getByText("Stop the runner to delete.", { exact: true })).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setRunnerStatus("offline"));
  await expect(deleteMachine).toBeEnabled();
  await expect(page.getByText("Stop the runner to delete.", { exact: true })).toHaveCount(0);
  await deleteMachine.click();

  const confirmation = page.getByRole("dialog", { name: "Delete Machine" });
  await expect(confirmation).toContainText("Design Workstation, its sessions and its multi-agent runs are deleted from Wollipog. Files on the machine stay where they are.");
  await confirmation.getByRole("button", { name: "Delete Machine" }).click();
  await expect(page.getByText("No Machines Yet")).toBeVisible();
  // The empty tab owns the create actions, so the header no longer offers Add Machine (#2984).
  await expect(page.locator(".page-header").getByRole("button", { name: "Add Machine" })).toHaveCount(0);
  await expect(page.locator(".connections-empty .row button")).toHaveText(["Connect via SSH", "Install Manually"]);
});

test("Save Changes names what wasn't saved when one field fails, and keeps what did (#2991)", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setSettingsSaveFailure("capacity"));
  await openSettings(page);
  const dialog = settingsDialog(page);
  await dialog.getByLabel("Machine Name").fill("Primary Development Machine");
  await dialog.getByLabel("Capacity Limit").fill("24");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  const failure = dialog.locator('.notice.t-danger[role="alert"]');
  await expect(failure).toContainText("Capacity Limit wasn't saved.");
  await expect(page.getByRole("heading", { name: "Primary Development Machine", exact: true })).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setSettingsSaveFailure(null));
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Capacity" }).locator(".machine-capacity-figure")).toHaveText("12 of 24 units in use");
});

test("Capacity Limit is 96px, and 300 shows its error under the helper on blur (#2991)", async ({ page }) => {
  await openSettings(page);
  const limit = settingsDialog(page).getByLabel("Capacity Limit");
  // offsetWidth: the opening scale animation would shrink a bounding box.
  expect(await limit.evaluate((element) => (element as HTMLElement).offsetWidth)).toBe(96);
  await limit.fill("300");
  await limit.blur();
  await expect(limit).toHaveAttribute("aria-invalid", "true");
  await expect(limit).toHaveAccessibleDescription(
    "In units, from 1 to 256. Sessions beyond the limit wait in a queue. Enter a whole number from 1 to 256.",
  );
});

test("at 390px Machine Settings is a bottom sheet: two 48px footer buttons, Delete Machine… the body's last row (#2991)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/machine-management-e2e.html?${DESIGN_WORKSTATION}`);
  await openSettings(page);
  const dialog = settingsDialog(page);
  const footer = dialog.locator(".modal-foot > .btn");
  await expect(footer).toHaveText(["Cancel", "Save Changes"]);
  for (const height of await footer.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))) {
    expect(height).toBe(48);
  }
  const last = dialog.locator(".modal-body > :last-child");
  await expect(last).toHaveClass(/modal-tertiary/);
  await expect(last.getByRole("button", { name: "Delete Machine…" })).toBeVisible();
  await expect(last).toContainText("Stop the runner to delete.");
  // The confirmation replaces the sheet, with Back, rather than stacking a second one (§7.5).
  await dialog.getByRole("switch", { name: "Switch Accounts Automatically" }).click();
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  const confirmation = page.getByRole("dialog", { name: "Turn On Automatic Switching" });
  await expect(confirmation.getByRole("button", { name: "Back to Machine Settings" })).toBeVisible();
  await expect(dialog).toBeHidden();
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
    "Idle Processes", "Deployed Build", "Platform",
  ]);
  await expect(details.locator(".facts dd").nth(6)).toHaveText("Not available");
  await details.getByRole("button", { name: "Copy All" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  for (const label of ["Connection: SSH", "SSH Target: misko@design-workstation", "Operating System: Windows", "Deployed Build: 0.42.0+fixture", "Platform: x86_64-pc-windows-msvc", "Idle Processes: Park When Needed"]) {
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
