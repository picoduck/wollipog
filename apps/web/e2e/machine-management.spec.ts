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

/** Agent Details' Updates fact: the label, then the runner's release guidance (#3523). */
const updatesFact = (details: import("@playwright/test").Locator) =>
  details.locator("dt", { hasText: /^Updates$/ }).locator("+ dd");
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

test("installed harnesses blocked by provider HOME ownership remain visible with the recovery reason", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("ownership-blocked"));
  await expect(page.locator(".machine-agents-empty")).toContainText("Open an agent’s details to resolve its availability");
  await expect(page.locator(".machine-agents-empty .code-well")).toHaveCount(0);
  for (const name of ["Claude Code", "Codex App Server"]) {
    await expect(agentRow(page, name).locator(".status")).toHaveText("Unavailable");
    await agentRow(page, name).click();
    const details = page.getByRole("dialog", { name, exact: true });
    await expect(details.locator(".notice")).toContainText("Provider HOME ownership blocked discovery");
    await details.getByRole("button", { name: "Close", exact: true }).last().click();
  }
  await expect(page.locator("article.machine-detail details.disclosure > summary").filter({ hasText: /Agents? Not Installed/ })).toHaveCount(0);
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

test("Machine Settings states each installation's availability, and Agent Details gives its release guidance (#3523)", async ({ page }) => {
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
  // The release guidance Machine Settings gave before #2991 sits under each Updates label (#3523).
  await expect(updatesFact(details)).toContainText("change the pin before planning an upgrade");
  await details.getByRole("button", { name: "Done" }).click();
  await agentRow(page, "Policy Claude").click();
  const claude = page.getByRole("dialog", { name: "Policy Claude" });
  await expect(updatesFact(claude)).toContainText("Checks Disabled by Machine Policy");
  await expect(updatesFact(claude)).toContainText("whether manual upgrades are permitted");
  await claude.getByRole("button", { name: "Done" }).click();
  await agentRow(page, "Failed Pi").click();
  const pi = page.getByRole("dialog", { name: "Failed Pi" });
  await expect(updatesFact(pi)).toContainText("no current release status was established");
  await expect(updatesFact(pi)).toContainText(
    "Select Rediscover for a native Machine, or Reconnect for an SSH Machine after active sessions finish",
  );
  await pi.getByRole("button", { name: "Done" }).click();
  // A Codex too old to run already gives the guidance in its notice, so the fact keeps only its label.
  await agentRow(page, "Codex App Server (v0.140.0)").click();
  const legacy = page.getByRole("dialog", { name: "Codex App Server (v0.140.0)" });
  await expect(legacy.locator(".notice")).toContainText("Use the package or version manager that installed this exact copy");
  await expect(updatesFact(legacy)).toHaveText("New Release Published");
});

test("Agent Details gives a Ready installation's release guidance, and on an offline machine as last reported (#3523)", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("multiple-installations"));
  await agentRow(page, "Codex App Server (v0.199.0)").click();
  const system = page.getByRole("dialog", { name: "Codex App Server (v0.199.0)" });
  await expect(system.locator(".notice")).toHaveCount(0);
  await expect(updatesFact(system).locator("> div").first()).toHaveText("New Release Published");
  await expect(updatesFact(system)).toContainText("compatibility with this Machine has not been verified");
  await system.getByRole("button", { name: "Done" }).click();
  await agentRow(page, "Codex App Server (v0.210.0)").click();
  const local = page.getByRole("dialog", { name: "Codex App Server (v0.210.0)" });
  await expect(updatesFact(local)).toContainText("Run `'/home/example/.local/bin/codex' 'update'` in a POSIX shell");
  await local.getByRole("button", { name: "Done" }).click();
  await setOffline(page);
  await agentRow(page, "Codex App Server (v0.199.0)").click();
  await expect(updatesFact(system).locator("> div").first()).toHaveText("Last Reported: New Release Published");
  await expect(updatesFact(system)).toContainText("compatibility with this Machine has not been verified");
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
  // A ready agent's details give its update guidance (#3523), but the safe replacement for the
  // command an older runner quoted for a reference-only launch, never the unsafe command.
  await expect(details.getByText("Managed Externally", { exact: true })).toBeVisible();
  await expect(updatesFact(details)).toContainText("No copyable update command is available for this launch");
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

test("an SSH machine's failed release check reads Check Failed in Agent Details with Reconnect guidance, and its menu offers Reconnect", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.setAgentAvailabilityScenario("harness-states-ssh"));
  const detail = page.locator('article.machine-detail[data-kind="ssh"]');
  await detail.getByRole("button", { name: "Machine Actions" }).click();
  const actions = page.getByRole("menu", { name: "Machine Actions" });
  await expect(actions.getByRole("menuitem", { name: "Reconnect", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await agentRow(page, "Failed Pi").click();
  const updates = updatesFact(page.getByRole("dialog", { name: "Failed Pi" }));
  await expect(updates.locator("> div").first()).toHaveText("Check Failed");
  await expect(updates).toContainText("Reconnect for an SSH Machine after active sessions finish");
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

/** The Provider Accounts section of the open machine (#2995). */
const providerAccounts = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: /^Provider Accounts/ });
const accountRow = (page: import("@playwright/test").Page, label: string) =>
  providerAccounts(page).locator(".surface > .row").filter({ has: page.locator(".row-title", { hasText: label }) });
/** A row's sign-in steps or ending, in the expansion under it (#2996). */
const signInSteps = (page: import("@playwright/test").Page, label: string) =>
  accountRow(page, label).locator("xpath=following-sibling::*[1][contains(concat(' ', @class, ' '), ' provider-account-expansion ')]");
/** Waits for finite animations, so a screenshot shows the dialog or toast instead of its fade. */
const settleAnimations = (page: import("@playwright/test").Page) => page.evaluate(() => Promise.allSettled(document.getAnimations()
  .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished)));
async function openAccountMenu(page: import("@playwright/test").Page, label: string) {
  await accountRow(page, label).getByRole("button", { name: `More Actions for ${label}` }).click();
  return page.getByRole("menu", { name: label });
}

test("Provider Accounts show one status per account: Signed In, Sign-In Required and Signing In", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?signingIn&${DESIGN_WORKSTATION}`);
  const section = providerAccounts(page);
  await expect(section.getByRole("heading", { name: "Provider Accounts 4" })).toBeVisible();
  await expect(accountRow(page, "Work").locator(".status")).toHaveText("Signed In");
  await expect(accountRow(page, "Work").locator(".status")).toHaveClass(/t-success/);
  await expect(accountRow(page, "Personal").locator(".status")).toHaveText("Sign-In Required");
  await expect(accountRow(page, "Personal").locator(".status")).toHaveClass(/t-warning/);
  await expect(accountRow(page, "Codex Team").locator(".status")).toHaveText("Signing In");
  await expect(accountRow(page, "Personal").locator(".row-sub")).toHaveText("Claude");
  await expect(accountRow(page, "Personal").getByRole("button", { name: "Sign In", exact: true })).toBeVisible();
  await expect(section).not.toContainText(/Logged In|Login Required/);
  await expect(signInSteps(page, "Codex Team").locator("ol.steps > li")).toHaveCount(2);
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: "test-results/provider-accounts/section-desktop.png" });

  const menu = await openAccountMenu(page, "Codex Team");
  const remove = menu.getByRole("menuitem", { name: "Remove Account…" });
  await expect(remove).toBeDisabled();
  await expect(remove).toContainText("A sign-in is running. Cancel it first.");
  await page.screenshot({ path: "test-results/provider-accounts/menu-disabled-reason-desktop.png" });
  await page.keyboard.press("Escape");
  const personal = await openAccountMenu(page, "Personal");
  await expect(personal.getByRole("menuitem", { name: "Remove Account…" })).toBeEnabled();
});

test("Machine owners remove a provider account from its menu after confirming", async ({ page }) => {
  const menu = await openAccountMenu(page, "Personal");
  await expect(menu.locator(".menu-label")).toHaveText("Personal");
  await menu.getByRole("menuitem", { name: "Remove Account…" }).click();
  const confirmation = page.getByRole("dialog", { name: "Remove Account" });
  await expect(confirmation).toContainText(
    "Personal (Claude) is removed from Design Workstation. The sign-in Wollipog stored for it stays on this machine. " +
    "Sessions still using it keep working, and the Claude account itself isn't affected.");
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await settleAnimations(page);
  await page.screenshot({ path: "test-results/provider-accounts/remove-account-confirm-desktop.png" });
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(accountRow(page, "Personal")).toBeVisible();

  await (await openAccountMenu(page, "Personal")).getByRole("menuitem", { name: "Remove Account…" }).click();
  await page.getByRole("dialog", { name: "Remove Account" }).getByRole("button", { name: "Remove Account" }).click();
  await expect(accountRow(page, "Personal")).toHaveCount(0);
  const toast = page.locator(".toast").filter({ hasText: "Account removed." });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("The sign-in Wollipog stored for it was kept on this machine.");
  await expect(providerAccounts(page).getByRole("heading", { name: "Provider Accounts 3" })).toBeVisible();
  await settleAnimations(page);
  await page.screenshot({ path: "test-results/provider-accounts/remove-account-toast-desktop.png" });
});

test("A removal on a runner that doesn't report the kept sign-in shows a one-line toast", async ({ page }) => {
  await (await openAccountMenu(page, "Work")).getByRole("menuitem", { name: "Remove Account…" }).click();
  await page.getByRole("dialog", { name: "Remove Account" }).getByRole("button", { name: "Remove Account" }).click();
  const toast = page.locator(".toast").filter({ hasText: "Account removed." });
  await expect(toast).toBeVisible();
  await expect(toast).not.toContainText("was kept");
  await settleAnimations(page);
  await page.screenshot({ path: "test-results/provider-accounts/remove-account-unreported-toast-desktop.png" });
});

test("A removal refused for an agent default names the agent in a notice above the rows", async ({ page }) => {
  await (await openAccountMenu(page, "Codex Solo")).getByRole("menuitem", { name: "Remove Account…" }).click();
  await page.getByRole("dialog", { name: "Remove Account" }).getByRole("button", { name: "Remove Account" }).click();
  const notice = providerAccounts(page).locator(".notice.t-danger");
  await expect(notice).toContainText("Couldn't Remove Codex Solo");
  await expect(notice).toContainText("Custom ACP uses this account as its default in this machine's runner configuration. " +
    "Change that setting, then remove the account.");
  await expect(notice).not.toContainText("custom-acp");
  await expect(accountRow(page, "Codex Solo")).toBeVisible();
  await providerAccounts(page).screenshot({ path: "test-results/provider-accounts/agent-default-refusal-desktop.png" });
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
});

test("On a phone the removal confirmation replaces the menu sheet, and Back returns to it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await accountRow(page, "Personal").scrollIntoViewIfNeeded();
  const menu = await openAccountMenu(page, "Personal");
  await expect(menu).toBeVisible();
  await page.screenshot({ path: "test-results/provider-accounts/menu-sheet-mobile.png" });
  await menu.getByRole("menuitem", { name: "Remove Account…" }).click();
  const confirmation = page.getByRole("dialog", { name: "Remove Account" });
  await expect(confirmation).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.screenshot({ path: "test-results/provider-accounts/remove-account-confirm-mobile.png" });
  await confirmation.getByRole("button", { name: "Back to More Actions" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole("menu", { name: "Personal" })).toBeVisible();
  await expect(accountRow(page, "Personal")).toBeVisible();
});

test("Viewers see each account's status only", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?role=viewer&${DESIGN_WORKSTATION}`);
  const section = providerAccounts(page);
  await expect(section).toContainText("Only this machine's owner or an organization admin can add or remove its accounts.");
  await expect(section.getByRole("button")).toHaveCount(0);
  await expect(accountRow(page, "Personal").locator(".status")).toHaveText("Sign-In Required");
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: "test-results/provider-accounts/viewer-desktop.png" });
});

test("Owners adopt and revoke provider profiles, confirming active sessions; members only see the state (#3239)", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?profiles&${DESIGN_WORKSTATION}`);
  const sub = (label: string) => accountRow(page, label).locator(".row-sub");
  const items = async (label: string) => {
    const menu = await openAccountMenu(page, label);
    const names = await menu.locator(".menu-item .menu-text").allTextContents();
    await page.keyboard.press("Escape");
    return names.filter((name) => name === "Adopt as Profile…" || name === "Revoke Access…");
  };
  await expect(sub("Work")).toHaveText("ClaudeProfile");
  await expect(sub("Personal")).toHaveText("ClaudeGrant Pending");
  await expect(sub("Codex Team")).toHaveText("CodexNot Granted");
  await expect(sub("Codex Solo")).toHaveText("Codex");
  await expect(accountRow(page, "Codex Solo").locator(".status")).toHaveText("Signed In");
  expect(await items("Work")).toEqual(["Revoke Access…"]);
  expect(await items("Personal")).toEqual(["Adopt as Profile…", "Revoke Access…"]);
  await providerAccounts(page).screenshot({ path: "test-results/provider-accounts/profile-states.png" });

  await (await openAccountMenu(page, "Codex Solo")).getByRole("menuitem", { name: "Adopt as Profile…" }).click();
  const adoption = page.getByRole("dialog", { name: "Adopt as Profile" });
  await expect(adoption).toContainText("only control planes granted this profile can use this account's HOME");
  await page.screenshot({ path: "test-results/provider-accounts/adopt-profile-confirm.png", fullPage: true });
  await adoption.getByRole("button", { name: "Adopt as Profile" }).click();
  await expect(page.getByText("Account adopted as a profile.", { exact: true })).toBeVisible();
  await expect(sub("Codex Solo")).toHaveText("CodexProfile");

  await (await openAccountMenu(page, "Work")).getByRole("menuitem", { name: "Revoke Access…" }).click();
  await page.getByRole("dialog", { name: "Revoke Access" }).getByRole("button", { name: "Revoke Access" }).click();
  const force = page.getByRole("dialog", { name: "Revoke Access from Active Sessions" });
  await expect(force).toContainText("3 active sessions use this account's profile.");
  await expect(force).toContainText("Fix the half-cent rounding bug");
  await expect(force).toContainText("and 1 more");
  await page.screenshot({ path: "test-results/provider-accounts/revoke-profile-force-confirm.png", fullPage: true });
  await force.getByRole("button", { name: "Revoke Access" }).click();
  await expect(page.getByText("Access revoked.", { exact: true })).toBeVisible();
  await expect(sub("Work")).toHaveText("Claude");

  await page.goto(`/machine-management-e2e.html?profiles&role=machine-owner&${DESIGN_WORKSTATION}`);
  await expect(sub("Personal")).toHaveText("ClaudeGrant Pending");
  expect(await items("Personal")).toEqual([]);
  expect(await items("Work")).toEqual([]);
});

test("Owners recover a stale provider HOME lease only where the machine can prove it abandoned (#3241)", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?leases&${DESIGN_WORKSTATION}`);
  const sub = (label: string) => accountRow(page, label).locator(".row-sub");
  const recoverItem = async (label: string) => {
    const menu = await openAccountMenu(page, label);
    return menu.getByRole("menuitem", { name: /^Recover Account…/u });
  };
  await expect(sub("Personal")).toHaveText("ClaudeRecovery Needed");
  await expect(sub("Codex Team")).toHaveText("CodexRecovery Needed");
  await expect(accountRow(page, "Codex Team").locator(".provider-account-lease"))
    .toHaveAttribute("title", "Wollipog can't safely unlock this account until this machine has restarted. Save your work, restart the machine, then recover the account in Connections.");
  await expect(sub("Work")).toHaveText("Claude");
  await expect(await recoverItem("Codex Team")).toBeDisabled();
  await page.keyboard.press("Escape");
  await providerAccounts(page).screenshot({ path: "test-results/provider-accounts/stale-leases.png" });

  await (await recoverItem("Personal")).click();
  const recovery = page.getByRole("dialog", { name: "Recover Account" });
  await expect(recovery).toContainText("An earlier Wollipog runner left this account locked.");
  await page.screenshot({ path: "test-results/provider-accounts/recover-lease-confirm.png", fullPage: true });
  await recovery.getByRole("button", { name: "Recover Account" }).click();
  await expect(page.getByText("Account unlocked.", { exact: true })).toBeVisible();
  await expect(sub("Personal")).toHaveText("Claude");
  await providerAccounts(page).screenshot({ path: "test-results/provider-accounts/lease-recovered.png" });

  await page.goto(`/machine-management-e2e.html?leases&role=machine-owner&${DESIGN_WORKSTATION}`);
  await expect(accountRow(page, "Personal")).toBeVisible();
  await expect(providerAccounts(page).locator(".provider-account-lease")).toHaveCount(0);
});

test("Machine owners can start both provider sign-in flow shapes", async ({ page }) => {
  await providerAccounts(page).getByRole("button", { name: "Add Account…" }).click();
  const claudeDialog = page.getByRole("dialog", { name: "Add Account" });
  await claudeDialog.getByLabel("Account Label").fill("Studio Claude");
  await claudeDialog.getByRole("button", { name: "Start Sign-In" }).click();
  await expect(claudeDialog).toHaveCount(0);

  // A new account's sign-in is a row at the end of the list, expanded into its steps (#2996).
  const claude = signInSteps(page, "Studio Claude");
  await expect(accountRow(page, "Studio Claude").locator(".status")).toHaveText("Signing In");
  await expect(providerAccounts(page).locator(".surface > .row").last()).toContainText("Studio Claude");
  await expect(claude.getByRole("link", { name: "Open Claude Sign-In" })).toBeVisible();
  await expect(claude.getByLabel("Paste the Code It Shows")).toHaveAttribute("type", "password");
  await page.screenshot({ path: "test-results/provider-login/claude-paste-code.png", fullPage: true });

  await accountRow(page, "Studio Claude").getByRole("button", { name: "Cancel" }).click();
  await providerAccounts(page).getByRole("button", { name: "Add Account…" }).click();
  const codexDialog = page.getByRole("dialog", { name: "Add Account" });
  await codexDialog.getByRole("radio", { name: "Codex" }).click();
  await codexDialog.getByLabel("Account Label").fill("Studio Codex");
  await codexDialog.getByRole("button", { name: "Start Sign-In" }).click();

  const codex = signInSteps(page, "Studio Codex");
  await expect(codex.getByRole("link", { name: "Open Codex Sign-In" })).toBeVisible();
  await expect(codex.getByText("WOLL-IPOGS", { exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Copy Device Code" })).toBeVisible();
  await expect(codex.getByText("Waiting for Codex to confirm…")).toBeVisible();
  await expect(codex.getByLabel("Paste the Code It Shows")).toHaveCount(0);
  await page.screenshot({ path: "test-results/provider-login/codex-device-code.png", fullPage: true });
});

test("a sign-in runs inside its own row: Work is listed once with Cancel, and a rejected code is an error under the field (#2996)", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?signIn=rejected&${DESIGN_WORKSTATION}`);
  await expect(providerAccounts(page).locator(".surface > .row").filter({ hasText: "Work" })).toHaveCount(1);
  await expect(accountRow(page, "Work").locator(".status")).toHaveText("Signing In");
  await expect(accountRow(page, "Work").getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(providerAccounts(page).locator("article")).toHaveCount(0);
  const steps = signInSteps(page, "Work");
  const field = steps.getByLabel("Paste the Code It Shows");
  const [input, submit] = [await field.boundingBox(), await steps.getByRole("button", { name: "Submit Code" }).boundingBox()];
  expect(Math.abs(submit!.y - input!.y), "Submit Code shares the field's row, level with the input").toBeLessThanOrEqual(1);
  expect(submit!.height).toBe(input!.height);
  expect(submit!.x).toBeGreaterThan(input!.x + input!.width);
  await field.fill("not-the-code");
  await steps.getByRole("button", { name: "Submit Code" }).click();
  await expect(steps.locator(".field-error")).toHaveText(
    "The provider rejected this code. Copy the whole code from the sign-in page and paste it again.");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  expect(await providerAccounts(page).evaluate((section) => section.outerHTML.includes("not-the-code"))).toBe(false);
  const menu = await openAccountMenu(page, "Work");
  await expect(menu.getByRole("menuitem", { name: /^Remove Account…/ })).toBeDisabled();
  await expect(menu).toContainText("A sign-in is running. Cancel it first.");
});

test("each sign-in ending is one notice in its row, and Dismiss removes it for good (#2996)", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?signIn=failed&${DESIGN_WORKSTATION}`);
  let steps = signInSteps(page, "Work");
  await expect(steps.locator(".notice.t-danger .notice-title")).toHaveText("Sign-In Failed");
  await expect(steps.getByRole("button")).toHaveText(["Try Again", "Dismiss"]);
  await expect(accountRow(page, "Work").locator(".status")).toHaveText("Signed In");

  await page.goto(`/machine-management-e2e.html?signIn=timed-out&${DESIGN_WORKSTATION}`);
  steps = signInSteps(page, "Work");
  await expect(steps.locator(".notice.t-neutral .notice-title")).toHaveText("Sign-In Timed Out");
  await expect(steps.getByRole("button")).toHaveText(["Start Again", "Dismiss"]);
  await steps.getByRole("button", { name: "Start Again" }).click();
  await expect(accountRow(page, "Work").locator(".status")).toHaveText("Signing In");
  await expect(signInSteps(page, "Work").getByLabel("Paste the Code It Shows")).toBeVisible();

  await page.goto(`/machine-management-e2e.html?signIn=duplicate&${DESIGN_WORKSTATION}`);
  await expect(accountRow(page, "Work 2").locator(".status")).toHaveText("Not Added");
  steps = signInSteps(page, "Work 2");
  await expect(steps.locator(".notice-title")).toHaveText("Already on This Machine");
  await expect(steps).toContainText("This Claude account is already on this machine, so Wollipog discarded the duplicate sign-in.");
  await expect(steps.getByRole("button")).toHaveText(["Dismiss"]);
  await steps.getByRole("button", { name: "Dismiss" }).click();
  await expect(accountRow(page, "Work 2")).toHaveCount(0);
  await expect(providerAccounts(page).getByRole("heading", { name: "Provider Accounts 4" })).toBeVisible();
});

test("at 390px the code field and Submit Code stack at full width, and wrapped step content keeps to the step's text column (#2996)", async ({ page }) => {
  for (const fixture of ["code", "device"] as const) {
    await page.goto(`/machine-management-e2e.html?signIn=${fixture}&${DESIGN_WORKSTATION}`);
    await page.setViewportSize({ width: 390, height: 844 });
    const label = fixture === "code" ? "Work" : "Codex Team";
    const steps = signInSteps(page, label);
    await steps.scrollIntoViewIfNeeded();
    const items = steps.locator("ol.steps > li");
    await expect(items).toHaveCount(2);
    // The step's text column: its left padding, past the number.
    const column = await items.evaluateAll((lis) => lis.map((li) => {
      const box = li.getBoundingClientRect();
      const style = getComputedStyle(li);
      return { left: box.left + Number.parseFloat(style.paddingLeft), right: box.right, top: box.top,
        numberTop: box.top + Number.parseFloat(getComputedStyle(li, "::before").top) };
    }));
    const open = await steps.getByRole("link", { name: /^Open (Claude|Codex) Sign-In$/ }).boundingBox();
    expect(Math.abs(open!.x - column[0]!.left), `${fixture}: step 1's button starts the text column`).toBeLessThanOrEqual(1);
    if (fixture === "code") {
      const field = (await steps.getByLabel("Paste the Code It Shows").boundingBox())!;
      const submit = (await steps.getByRole("button", { name: "Submit Code" }).boundingBox())!;
      const label = (await steps.locator(".signin-code-form .field-label").boundingBox())!;
      expect(Math.abs(field.x - column[1]!.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(submit.x - column[1]!.left), "Submit Code wraps to the text column").toBeLessThanOrEqual(1);
      expect(submit.y, "Submit Code stacks under the field").toBeGreaterThan(field.y + field.height);
      expect(Math.abs(submit.width - field.width), "both full width").toBeLessThanOrEqual(1);
      expect(Math.abs(field.x + field.width - column[1]!.right)).toBeLessThanOrEqual(1);
      // The number is centred on the field's label, its first line.
      expect(Math.abs((column[1]!.numberTop + 12) - (label.y + label.height / 2))).toBeLessThanOrEqual(1.5);
    } else {
      const code = (await steps.locator(".signin-code").boundingBox())!;
      const waiting = (await steps.getByText("Waiting for Codex to confirm…")).boundingBox();
      expect(Math.abs(code.x - column[1]!.left)).toBeLessThanOrEqual(1);
      expect(Math.abs((await waiting)!.x - column[1]!.left), "the waiting line wraps to the text column").toBeLessThanOrEqual(1);
    }
    // Step 1's number is centred on its button, its first line.
    expect(Math.abs((column[0]!.numberTop + 12) - (open!.y + open!.height / 2))).toBeLessThanOrEqual(1.5);
    await page.screenshot({ path: `test-results/provider-login/steps-390-${fixture}.png` });
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test("a hidden email's sign-in head reads Signing In to Codex in full at 390px, its badge wrapping under it (#2996)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
  for (const [fixture, title] of [["code", "Signing In to Claude"], ["device", "Signing In to Codex"]] as const) {
    await page.goto(`/machine-management-e2e.html?signIn=${fixture}&emailLabels&${DESIGN_WORKSTATION}`);
    const row = providerAccounts(page).locator(".surface > .row").filter({ has: page.locator(".row-title", { hasText: title }) });
    const head = async () => row.evaluate((element) => {
      const name = element.querySelector<HTMLElement>(".row-title")!;
      const badge = element.querySelector<HTMLElement>(".status")!.getBoundingClientRect();
      const box = name.getBoundingClientRect();
      return {
        text: name.textContent, clipped: name.scrollWidth > name.clientWidth, overflows: element.scrollHeight > element.clientHeight,
        height: element.getBoundingClientRect().height, badgeBelow: badge.top >= box.bottom, sub: element.querySelector(".row-sub")?.textContent,
      };
    });
    let measured = await head();
    expect(measured, `${fixture} at 1280`).toMatchObject({ text: title, clipped: false, overflows: false, badgeBelow: false, sub: "Email hidden" });
    expect(measured.height, "wide enough, the row keeps its 56px").toBe(56);
    await page.setViewportSize({ width: 390, height: 844 });
    await row.scrollIntoViewIfNeeded();
    measured = await head();
    expect(measured, `${fixture} at 390`).toMatchObject({ text: title, clipped: false, overflows: false, badgeBelow: true, sub: "Email hidden" });
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test("Add Account refuses an empty or duplicate label under the field, and shows a request failure above the footer", async ({ page }) => {
  await providerAccounts(page).getByRole("button", { name: "Add Account…" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Account" });
  await expect(dialog).toContainText("Design Workstation");
  await page.screenshot({ path: "test-results/provider-accounts/add-account-empty-desktop.png" });
  const field = dialog.getByLabel("Account Label");
  await dialog.getByRole("button", { name: "Start Sign-In" }).click();
  await expect(dialog.locator(".field-error")).toHaveText("Enter a label, such as Work or Personal.");
  await field.fill("work");
  await expect(dialog.locator(".field-error")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Start Sign-In" }).click();
  await expect(dialog.locator(".field-error")).toHaveText(
    "A Claude account named Work is already on this machine. Choose another label, or use Sign In Again on that account.");
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await page.screenshot({ path: "test-results/provider-accounts/add-account-duplicate-desktop.png" });
  // The client check sent nothing: no sign-in started, so the section has no Signing In row.
  await expect(providerAccounts(page).locator(".status", { hasText: "Signing In" })).toHaveCount(0);
  await field.fill("Unreachable");
  await dialog.getByRole("button", { name: "Start Sign-In" }).click();
  const failure = dialog.locator(".notice.t-danger");
  await expect(failure).toContainText("Couldn't Start the Sign-In");
  await expect(failure).toContainText("The runner did not answer in time.");
  await page.screenshot({ path: "test-results/provider-accounts/add-account-failure-desktop.png" });
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
  await (await openAccountMenu(page, "Personal")).getByRole("menuitem", { name: "Remove Account…" }).click();
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

test("account recovery uses plain guidance with separate authorized process details", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?leases&lease-cause=process_uninspectable&${DESIGN_WORKSTATION}`);
  const row = accountRow(page, "Codex Team");
  const badge = row.locator(".provider-account-lease");
  await expect(badge).toHaveText("Recovery Needed");
  await expect(badge).toHaveAttribute("title", /save your work and restart the machine/);
  expect(await badge.getAttribute("title")).not.toMatch(/journal|fallback|boundary|PID|cgroup|delegat|inspectability/i);
  await row.getByRole("button", { name: "More Actions for Codex Team", exact: true }).click();
  await page.getByRole("menuitem", { name: "View Recovery Details…", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Account Recovery Details" });
  await expect(details).toContainText("process_uninspectable");
  await expect(details).toContainText("PID 4242");
  await expect(details).toContainText("Keep the account's files and lease journal intact.");
  await details.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(details).toHaveCount(0);
  await expect(badge).toHaveText("Recovery Needed");
});

/** #3525: All Machines' Reconnect and the machine detail's are one action, with one busy state. */
test("a Reconnect started from All Machines is busy in the machine's detail, which sends no second request (#3525)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/machine-management-e2e.html?ssh=ended&reconnect=hold");
  const fromOverview = page.locator(".machines-overview").getByRole("button", { name: "Reconnect Design Workstation" });
  await fromOverview.click();
  await expect(fromOverview).toHaveAttribute("aria-busy", "true");
  await machineRow(page).click();
  const fromDetail = page.locator("article.machine-detail .notice").getByRole("button", { name: /^Reconnect/ });
  await expect(fromDetail).toHaveAttribute("aria-busy", "true");
  // Busy is aria-disabled rather than disabled (BusyButton), so the press itself must do nothing.
  await fromDetail.click({ force: true });
  expect(await page.evaluate(() => window.__WOLLIPOG_MACHINE_E2E__.reconnectRequests())).toBe(1);
});

test("a Reconnect that fails from All Machines reads as it does from the machine's detail (#3525)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/machine-management-e2e.html?ssh=ended&reconnect=fail");
  await page.locator(".machines-overview").getByRole("button", { name: "Reconnect Design Workstation" }).click();
  const toast = page.locator(".toast").filter({ hasText: "Couldn't reconnect Design Workstation." });
  await expect(toast.locator(".toast-detail")).toHaveText("Wollipog couldn't be reached. Check the connection, then try again.");
  await toast.getByRole("button", { name: "Dismiss Notification" }).click();
  await expect(toast).toHaveCount(0);
  await machineRow(page).click();
  await page.locator("article.machine-detail .notice").getByRole("button", { name: "Reconnect" }).click();
  await expect(toast.locator(".toast-detail")).toHaveText("Wollipog couldn't be reached. Check the connection, then try again.");
});
