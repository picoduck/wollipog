import { expect, test, type Locator, type Page } from "@playwright/test";
import { openProjectActions } from "./session-groups.js";
import { PROTOCOL_VERSION } from "@wollipog/protocol";

test.use({ video: "on" });

/**
 * Create Session refuses a shape the control plane would refuse (#2952): it stays enabled, and
 * pressing it sends nothing and names the problem under the Orchestrator policy.
 */
async function expectCreateRefused(page: Page, dialog: Locator, problem: RegExp) {
  await dialog.getByRole("button", { name: "Create Session" }).click();
  await expect(dialog.locator(".field-error")).toHaveText(problem);
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest())).toBeFalsy();
}

/**
 * A Role option, scoped to its own radiogroup.
 *
 * Scoped because Options has three radiogroups — Role, Harness and Working Copy — and a bare
 * `getByRole("radio")` matches across all of them. An unavailable option's reason is its accessible
 * description.
 */
function presetCard(dialog: Locator, name: RegExp): Locator {
  return dialog.getByRole("radiogroup", { name: "Role" }).getByRole("radio", { name });
}

/** Options (#2954): every choice below Agent is one row, open before its rows can be used. */
async function openOptions(dialog: Locator): Promise<void> {
  const head = dialog.getByRole("button", { name: "Options", exact: true });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
}

/** The read-only Permissions row in Options. */
function permissionsRow(dialog: Locator): Locator {
  return dialog.locator(".setting-row").filter({ has: dialog.page().locator(".setting-row-title", { hasText: /^Permissions$/ }) });
}

/** The warning notice under Permissions that says why the Orchestrator preset sets them. */
function presetNotice(dialog: Locator): Locator {
  return dialog.locator(".session-options-body > .notice.t-warning");
}


test.beforeEach(async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("tab", { name: /Alpha/ })).toBeVisible();
});

for (const scenario of [
  { name: "desktop light", viewport: { width: 1280, height: 1000 }, theme: "light" },
  { name: "mobile dark", viewport: { width: 390, height: 844 }, theme: "dark" },
] as const) {
  test(`mixed Orchestrator blockers ${scenario.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(scenario.viewport);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(124);
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setOrchestratorAgentFixture({
        context: "wsl",
        permissionModes: ["default"],
        requirement: "Upgrade Codex to 0.154.0 or newer.",
      });
    }, scenario.theme);
    await openProjectActions(page, /Alpha/, "Alpha");
    await page.getByRole("menuitem", { name: "New Session Here" }).click();
    const dialog = page.getByRole("dialog", { name: "New Session" });
    await openOptions(dialog);
    const orchestratorCard = presetCard(dialog, /^Orchestrator/);
    await expect(orchestratorCard).toHaveAttribute("aria-disabled", "true");
    await expect(orchestratorCard).toHaveAccessibleDescription(/Upgrade Codex to 0\.154\.0 or newer\./);
    await expect(orchestratorCard).toHaveAccessibleDescription(/verified Direct WSL bridge and a bubblewrap-isolated runner/);
    await orchestratorCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("mixed-blockers.png"), fullPage: true });
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
    test(`saved orchestrator default and TUI accounting ${theme} ${viewport.width}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto("/command-inbox-projects-e2e.html?orchestratorDefault=1");
      await page.evaluate(({ selectedTheme, protocolVersion }) => {
        document.documentElement.dataset.theme = selectedTheme;
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(protocolVersion);
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], ["default", "orchestrator"]);
      }, { selectedTheme: theme, protocolVersion: PROTOCOL_VERSION });
      await openProjectActions(page, /Alpha/, "Alpha");
      await page.getByRole("menuitem", { name: "New Session Here" }).click();
      const dialog = page.getByRole("dialog", { name: "New Session" });
      await openOptions(dialog);
    await openOptions(dialog);
      // A saved Orchestrator harness default selects the role on the user's behalf and names
      // itself in the Permissions row (#1281 separated the two).
      await expect(presetCard(dialog, /^Orchestrator/)).toBeChecked();
      await expect(permissionsRow(dialog)).toContainText("Saved Default — Orchestrator");
      await dialog.getByRole("radio", { name: /^Native TUI/ }).click();
      // One sentence (#2954): the five-sentence accounting paragraph is gone.
      await expect(dialog.getByText("Native TUI opens the provider's own terminal UI. It doesn't track usage or show approval cards, so sessions with budgets must use Direct.")).toBeVisible();
      await expect(dialog.getByText(/Usage Accounting: Unavailable|spending and tool calls are not included/)).toHaveCount(0);
      await dialog.getByRole("spinbutton", { name: "Maximum Concurrent Children" }).fill("8");
      await page.screenshot({ path: testInfo.outputPath("native-tui-unmetered.png") });
      await dialog.getByRole("button", { name: "Create Session" }).click();
      await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
        .toMatchObject({ launchSurface: "native_tui" });
      expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()?.config?.permissionMode))
        .toBeUndefined();
      expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()?.orchestrator?.behavior?.maximumConcurrentChildren))
        .toBe(8);
    });
    for (const surface of ["direct", "native_tui"] as const) {
    test(`orchestrator creation preset ${surface} ${theme} ${viewport.width}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], ["default", "orchestrator"]);
      }, theme);
      await openProjectActions(page, /Alpha/, "Alpha");
      await page.getByRole("menuitem", { name: "New Session Here" }).click();
      const dialog = page.getByRole("dialog", { name: "New Session" });
      await openOptions(dialog);
    await openOptions(dialog);
      const orchestratorCard = presetCard(dialog, /^Orchestrator/);
      await expect(orchestratorCard).toBeVisible();
      await orchestratorCard.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("preset-unselected.png") });
      // One click, no popup to open: that IS the fix for #832, whose defect was the second of two
      // options being clipped inside the menu this used to have to open.
      await expect(orchestratorCard).not.toBeChecked();
      await orchestratorCard.click();
      await expect(orchestratorCard).toBeChecked();
      const liveChildLimit = dialog.getByRole("spinbutton", { name: "Maximum Concurrent Children" });
      await expect(liveChildLimit).toHaveValue("4");
      await liveChildLimit.fill("7");
      await dialog.getByRole("button", { name: /Child Harness: Automatic/ }).click();
      await dialog.getByRole("option", { name: /Codex App Server · Native/ }).click();
      await dialog.getByRole("button", { name: /Child Model: Automatic/ }).click();
      await dialog.getByRole("option", { name: /GPT-5.6 Sol/ }).click();
      await dialog.getByRole("button", { name: /Child Effort: Automatic/ }).click();
      await dialog.getByRole("option", { name: /High/ }).click();
      await dialog.getByRole("button", { name: /Child Harness: Codex App Server · Native/ }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("preset-harness-selected.png") });
      const delegatedControl = dialog.getByRole("button", { name: /Descendant Requests: Questions and Approvals/ });
      await expect(delegatedControl).toBeVisible();
      await expect(dialog.getByText("An Orchestrator delegates work to child sessions.", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: /Strict Project Isolation: Disabled/ })).toBeVisible();
      await expect(dialog.getByText(/no read-only operating-system boundary is claimed/)).toBeVisible();
      const tui = dialog.getByRole("radio", { name: /^Native TUI/ });
      await expect(tui).toBeEnabled();
      if (surface === "native_tui") await tui.click();
      if (viewport.width === 390) await delegatedControl.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("preset-selected.png") });
      await dialog.getByRole("button", { name: "Create Session" }).click();
      await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
        .toMatchObject({ config: { permissionMode: "orchestrator" },
          orchestrator: { behavior: {
            childHarness: { agentId: "codex", driver: "codex-app-server", context: { kind: "native" } },
            childModel: "gpt-5.6-sol", childEffort: "high", maximumConcurrentChildren: 7,
          } },
          ...(surface === "native_tui" ? { launchSurface: "native_tui" } : {}) });
    });
    }
  }
}

for (const scenario of [
  { name: "desktop light", viewport: { width: 1280, height: 1000 }, theme: "light" },
  { name: "mobile dark", viewport: { width: 390, height: 844 }, theme: "dark" },
] as const) {
  for (const harness of [
    { label: "Claude", driver: "claude-code" },
    { label: "Codex", driver: "codex-app-server" },
  ] as const) {
  test(`native ${harness.label} Orchestrator keeps ordinary provider permissions ${scenario.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(scenario.viewport);
    await page.evaluate(({ theme, protocolVersion, driver }) => {
      document.documentElement.dataset.theme = theme;
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(protocolVersion);
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setOrchestratorAgentFixture({
        context: "native",
        permissionModes: driver === "claude-code"
          ? ["default", "acceptEdits", "orchestrator"]
          : ["untrusted", "on-request", "orchestrator"],
        driver,
        controlPlaneRole: true,
      });
    }, { theme: scenario.theme, protocolVersion: PROTOCOL_VERSION, driver: harness.driver });
    await openProjectActions(page, /Alpha/, "Alpha");
    await page.getByRole("menuitem", { name: "New Session Here" }).click();
    const dialog = page.getByRole("dialog", { name: "New Session" });
    await openOptions(dialog);
    const providerPermissions = permissionsRow(dialog);
    await expect(presetCard(dialog, /^Normal/)).toBeChecked();
    await expect(providerPermissions).toContainText("Harness Default");
    await providerPermissions.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("role-normal.png"), fullPage: true });

    const orchestratorCard = presetCard(dialog, /^Orchestrator/);
    await orchestratorCard.click();
    await expect(orchestratorCard).toBeChecked();
    // #1281: the role is additive. The provider permission summary is unchanged by the role and
    // the harness keeps its ordinary modes, so no preset is announced.
    await expect(providerPermissions).toContainText("Harness Default");
    await expect(providerPermissions).toContainText("An Orchestrator keeps them and its integrations");
    await expect(providerPermissions).not.toContainText("Orchestrator Preset");
    await expect(presetNotice(dialog)).toHaveCount(0);
    await providerPermissions.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("role-orchestrator-independent.png"), fullPage: true });

    await dialog.getByRole("button", { name: /Strict Project Isolation: Disabled/ }).click();
    await dialog.getByRole("option", { name: /^Enabled/ }).click();
    await expect(providerPermissions).toContainText("Orchestrator Preset");
    await expect(presetNotice(dialog)).toContainText("Permissions Set by the Orchestrator Preset");
    await expect(presetNotice(dialog)).toContainText("Strict Project Isolation is enforced by the Orchestrator preset, so the preset sets them.");
    await providerPermissions.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("role-orchestrator-strict-preset.png"), fullPage: true });

    await dialog.getByRole("button", { name: /Strict Project Isolation: Enabled/ }).click();
    await dialog.getByRole("option", { name: /^Disabled/ }).click();
    await expect(providerPermissions).not.toContainText("Orchestrator Preset");
    await dialog.getByRole("button", { name: "Create Session" }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
      .toMatchObject({ role: "orchestrator" });
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()?.config?.permissionMode))
      .toBeUndefined();
  });
  }
}

for (const scenario of [
  { name: "desktop light", viewport: { width: 1280, height: 1000 }, theme: "light" },
  { name: "mobile dark", viewport: { width: 390, height: 844 }, theme: "dark" },
] as const) {
  test(`bridge-verified Pi offers only the additive Orchestrator role ${scenario.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(scenario.viewport);
    await page.evaluate(({ theme, protocolVersion }) => {
      document.documentElement.dataset.theme = theme;
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(protocolVersion);
      // The default runner isolation cannot launch Pi's coupled preset, so the installation
      // advertises the additive role without the "orchestrator" permission mode (#1294).
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setOrchestratorAgentFixture({
        context: "native",
        permissionModes: ["default", "bypassPermissions"],
        driver: "pi",
        orchestratorAdditive: true,
        controlPlaneRole: true,
      });
    }, { theme: scenario.theme, protocolVersion: PROTOCOL_VERSION });
    await openProjectActions(page, /Alpha/, "Alpha");
    await page.getByRole("menuitem", { name: "New Session Here" }).click();
    const dialog = page.getByRole("dialog", { name: "New Session" });
    await openOptions(dialog);
    const providerPermissions = permissionsRow(dialog);
    const orchestratorCard = presetCard(dialog, /^Orchestrator/);
    await expect(orchestratorCard).not.toHaveAttribute("aria-disabled", "true");
    await orchestratorCard.click();
    await expect(orchestratorCard).toBeChecked();
    await expect(providerPermissions).toContainText("Harness Default");
    await expect(providerPermissions).not.toContainText("Orchestrator Preset");
    await providerPermissions.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("pi-orchestrator-independent.png"), fullPage: true });

    // Strict isolation is delivered by the preset this installation cannot launch: it must block
    // with a reason rather than let the user submit a shape the control plane refuses.
    await dialog.getByRole("button", { name: /Strict Project Isolation: Disabled/ }).click();
    await dialog.getByRole("option", { name: /^Enabled/ }).click();
    const blocked = dialog.getByText(/Strict Project Isolation is delivered by the Orchestrator preset, which this agent installation cannot launch here/);
    await expect(blocked).toBeVisible();
    await blocked.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("pi-strict-blocked.png"), fullPage: true });
    await expectCreateRefused(page, dialog, /Strict Project Isolation is delivered by the Orchestrator preset/);

    await dialog.getByRole("button", { name: /Strict Project Isolation: Enabled/ }).click();
    await dialog.getByRole("option", { name: /^Disabled/ }).click();
    await dialog.getByRole("button", { name: "Create Session" }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
      .toMatchObject({ role: "orchestrator" });
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()?.config?.permissionMode))
      .toBeUndefined();
  });
}

for (const scenario of [
  { name: "desktop light", viewport: { width: 1280, height: 1000 }, theme: "light" },
  { name: "mobile dark", viewport: { width: 390, height: 844 }, theme: "dark" },
] as const) {
  test(`Codex offers the additive Orchestrator role without its audited sandbox ${scenario.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(scenario.viewport);
    await page.evaluate(({ theme, protocolVersion }) => {
      document.documentElement.dataset.theme = theme;
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(protocolVersion);
      // A current Codex installation on a platform without Codex's audited sandbox (#1308). The
      // runner attests the additive role, whose launch injects no sandbox, approval, or reviewer
      // setting, and correctly withholds the coupled preset's "orchestrator" permission mode.
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setOrchestratorAgentFixture({
        context: "native",
        permissionModes: ["untrusted", "on-request"],
        driver: "codex-app-server",
        orchestratorAdditive: true,
        controlPlaneRole: true,
        os: "windows",
      });
    }, { theme: scenario.theme, protocolVersion: PROTOCOL_VERSION });
    await openProjectActions(page, /Alpha/, "Alpha");
    await page.getByRole("menuitem", { name: "New Session Here" }).click();
    const dialog = page.getByRole("dialog", { name: "New Session" });
    await openOptions(dialog);
    const providerPermissions = permissionsRow(dialog);
    const orchestratorCard = presetCard(dialog, /^Orchestrator/);
    await expect(orchestratorCard).not.toHaveAttribute("aria-disabled", "true");
    await orchestratorCard.click();
    await expect(orchestratorCard).toBeChecked();
    await expect(providerPermissions).toContainText("Harness Default");
    await expect(providerPermissions).not.toContainText("Orchestrator Preset");
    // Parity with a normal Codex session here, not a new boundary: no platform sentence is shown,
    // because the additive launch has no platform condition to state a reason for.
    await expect(dialog.getByText(/Provider-mode orchestration requires/)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Create Session" })).toBeEnabled();
    await providerPermissions.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("codex-additive-without-audited-sandbox.png"), fullPage: true });

    // The preset's own precondition is untouched, so Strict Project Isolation still blocks here.
    await dialog.getByRole("button", { name: /Strict Project Isolation: Disabled/ }).click();
    await dialog.getByRole("option", { name: /^Enabled/ }).click();
    const blocked = dialog.getByText(/Strict Project Isolation is delivered by the Orchestrator preset, which this agent installation cannot launch here/);
    await expect(blocked).toBeVisible();
    await blocked.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("codex-strict-blocked-without-audited-sandbox.png"), fullPage: true });
    await expectCreateRefused(page, dialog, /Strict Project Isolation is delivered by the Orchestrator preset/);

    await dialog.getByRole("button", { name: /Strict Project Isolation: Enabled/ }).click();
    await dialog.getByRole("option", { name: /^Disabled/ }).click();
    await dialog.getByRole("button", { name: "Create Session" }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
      .toMatchObject({ role: "orchestrator" });
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()?.config?.permissionMode))
      .toBeUndefined();
  });
}

for (const scenario of [
  { name: "desktop light", viewport: { width: 1280, height: 1000 }, theme: "light" },
  { name: "mobile dark", viewport: { width: 390, height: 844 }, theme: "dark" },
] as const) {
  test(`Integration Isolation is its own disclosed control ${scenario.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(scenario.viewport);
    await page.evaluate(({ theme, protocolVersion }) => {
      document.documentElement.dataset.theme = theme;
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(protocolVersion);
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setOrchestratorAgentFixture({
        context: "native",
        permissionModes: ["default", "acceptEdits", "orchestrator"],
        driver: "claude-code",
        controlPlaneRole: true,
      });
    }, { theme: scenario.theme, protocolVersion: PROTOCOL_VERSION });
    await openProjectActions(page, /Alpha/, "Alpha");
    await page.getByRole("menuitem", { name: "New Session Here" }).click();
    const dialog = page.getByRole("dialog", { name: "New Session" });
    await openOptions(dialog);
    await presetCard(dialog, /^Orchestrator/).click();
    const control = dialog.getByRole("button", { name: /Integration Isolation: Disabled/ });
    await expect(control).toBeVisible();
    await control.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("integration-isolation-disabled.png"), fullPage: true });
    await control.click();
    await dialog.getByRole("option", { name: /^Enabled/ }).click();
    // #1295: the disclosure is per harness. For Claude Code only configured MCP servers go;
    // hooks and permission rules stay, and the dialog says why.
    await expect(dialog.getByText(/configured MCP servers/).first()).toBeVisible();
    await expect(dialog.getByText(/permission rules/).first()).toBeVisible();
    const enabled = dialog.getByRole("button", { name: /Integration Isolation: Enabled/ });
    await enabled.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("integration-isolation-enabled.png"), fullPage: true });
    // Independent of the project boundary and of the provider permission mode.
    await expect(dialog.getByRole("button", { name: /Strict Project Isolation: Disabled/ })).toBeVisible();
    await expect(permissionsRow(dialog)).not.toContainText("Orchestrator Preset");
    await dialog.getByRole("button", { name: "Create Session" }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
      .toMatchObject({ role: "orchestrator", orchestrator: { execution: { integrationIsolation: true } } });
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()?.config?.permissionMode))
      .toBeUndefined();
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const) {
  test(`Orchestrator Controls reports a revision conflict in place at ${viewport.width} (#2192)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height}&composer=orchestrator&policy-conflict=1`);
    await page.getByRole("button", { name: "Attach and Settings" }).click();
    await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
    const dialog = page.getByRole("dialog", { name: "Orchestrator Controls" });
    const merge = dialog.getByRole("radiogroup", { name: "PR Merge Approval" });
    await merge.scrollIntoViewIfNeeded();
    await merge.getByRole("radio", { name: "Orchestrator" }).click();

    const notice = dialog.locator(".notice.t-danger");
    await expect(notice).toHaveText(/These controls changed elsewhere\. Your change wasn't saved\./);
    await expect(page.locator("body")).toHaveAttribute("data-session-reloads", "1");
    await expect(merge.getByRole("radio", { name: "Human" }), "the stored choice comes back")
      .toHaveAttribute("aria-checked", "true");
    await expect(dialog.locator(".setting-row-saved")).toHaveCount(0);
    await expect(page.locator(".session-notice-slot"), "nothing reaches the composer's error line").toHaveCount(0);
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/orchestrator-controls/conflict-${viewport.width}.png` });
  });
}
