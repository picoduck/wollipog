import { expect, test, type Locator } from "@playwright/test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";

test.use({ video: "on" });

/**
 * A Session Role card, scoped to its own radiogroup.
 *
 * Scoped because the dialog has three radiogroups — Session Role, Harness and Mode — and a bare
 * `getByRole("radio")` matches across all of them. The name is anchored at the start because a
 * ChoiceCard's accessible name is its title followed by its description, and the Normal card's
 * description also mentions the harness.
 */
function presetCard(dialog: Locator, name: RegExp): Locator {
  return dialog.getByRole("radiogroup", { name: "Session Role" }).getByRole("radio", { name });
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
    await page.getByRole("tab", { name: /Alpha/ }).click();
    await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
    await page.getByRole("menuitem", { name: "New Session Here" }).click();
    const dialog = page.getByRole("dialog", { name: "New Session" });
    const orchestratorCard = presetCard(dialog, /^Orchestrator/);
    await expect(orchestratorCard).toHaveAttribute("aria-disabled", "true");
    await expect(orchestratorCard).toContainText("Upgrade Codex to 0.154.0 or newer.");
    await expect(orchestratorCard).toContainText("verified Direct WSL bridge and a bubblewrap-isolated runner");
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
      await page.getByRole("tab", { name: /Alpha/ }).click();
      await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
      await page.getByRole("menuitem", { name: "New Session Here" }).click();
      const dialog = page.getByRole("dialog", { name: "New Session" });
      // A saved Orchestrator harness default selects the role on the user's behalf and names
      // itself in the always-visible Provider Permissions summary (#1281 separated the two).
      await expect(presetCard(dialog, /^Orchestrator/)).toHaveAttribute("aria-checked", "true");
      await expect(dialog.getByText(/Saved Default — Orchestrator/)).toBeVisible();
      await dialog.getByRole("radio", { name: /^Native TUI/ }).click();
      await expect(dialog.getByText(/Usage Accounting: Unavailable/)).toBeVisible();
      await expect(dialog.getByText(/Native TUI spending and tool calls are not included/)).toBeVisible();
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
      await page.getByRole("tab", { name: /Alpha/ }).click();
      await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
      await page.getByRole("menuitem", { name: "New Session Here" }).click();
      const dialog = page.getByRole("dialog", { name: "New Session" });
      const orchestratorCard = presetCard(dialog, /^Orchestrator/);
      await expect(orchestratorCard).toBeVisible();
      await orchestratorCard.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("preset-unselected.png") });
      // One click, no popup to open: that IS the fix for #832, whose defect was the second of two
      // options being clipped inside the menu this used to have to open.
      await expect(orchestratorCard).toHaveAttribute("aria-checked", "false");
      await orchestratorCard.click();
      await expect(orchestratorCard).toHaveAttribute("aria-checked", "true");
      const liveChildLimit = dialog.getByRole("spinbutton", { name: "Maximum Concurrent Children" });
      await expect(liveChildLimit).toHaveValue("4");
      await liveChildLimit.fill("7");
      await dialog.getByRole("button", { name: /Child Harness: Automatic/ }).click();
      await dialog.getByRole("option", { name: /Codex · Codex App Server · Native/ }).click();
      await dialog.getByRole("button", { name: /Child Model: Automatic/ }).click();
      await dialog.getByRole("option", { name: /GPT-5.6 Sol/ }).click();
      await dialog.getByRole("button", { name: /Child Effort: Automatic/ }).click();
      await dialog.getByRole("option", { name: /High/ }).click();
      await dialog.getByRole("button", { name: /Child Harness: Codex · Codex App Server · Native/ }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("preset-harness-selected.png") });
      const delegatedControl = dialog.getByRole("button", { name: /Descendant Requests: Questions and Approvals/ });
      await expect(delegatedControl).toBeVisible();
      await expect(orchestratorCard).toContainText(/Delegate implementation by default/);
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
    await page.getByRole("tab", { name: /Alpha/ }).click();
    await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
    await page.getByRole("menuitem", { name: "New Session Here" }).click();
    const dialog = page.getByRole("dialog", { name: "New Session" });
    const providerPermissions = dialog.getByRole("group", { name: "Provider Permissions" });
    await expect(presetCard(dialog, /^Normal/)).toHaveAttribute("aria-checked", "true");
    await expect(providerPermissions).toContainText("Harness Default");
    await providerPermissions.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("role-normal.png"), fullPage: true });

    const orchestratorCard = presetCard(dialog, /^Orchestrator/);
    await orchestratorCard.click();
    await expect(orchestratorCard).toHaveAttribute("aria-checked", "true");
    // #1281: the role is additive. The provider permission summary is unchanged by the role and
    // the harness keeps its ordinary modes, so no preset is announced.
    await expect(providerPermissions).toContainText("Harness Default");
    await expect(providerPermissions).toContainText(/same permission modes, integrations, and credentials as a normal session/);
    await expect(providerPermissions).not.toContainText("Orchestrator Preset");
    await providerPermissions.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("role-orchestrator-independent.png"), fullPage: true });

    await dialog.getByRole("button", { name: /Strict Project Isolation: Disabled/ }).click();
    await dialog.getByRole("option", { name: /^Enabled/ }).click();
    await expect(providerPermissions).toContainText("Orchestrator Preset — Harness-Enforced");
    await expect(providerPermissions).toContainText("Strict Project Isolation is enforced through the harness-owned Orchestrator preset.");
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
    await page.getByRole("tab", { name: /Alpha/ }).click();
    await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
    await page.getByRole("menuitem", { name: "New Session Here" }).click();
    const dialog = page.getByRole("dialog", { name: "New Session" });
    const providerPermissions = dialog.getByRole("group", { name: "Provider Permissions" });
    const orchestratorCard = presetCard(dialog, /^Orchestrator/);
    await expect(orchestratorCard).not.toHaveAttribute("aria-disabled", "true");
    await orchestratorCard.click();
    await expect(orchestratorCard).toHaveAttribute("aria-checked", "true");
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
    await expect(dialog.getByRole("button", { name: "Create Session" })).toBeDisabled();

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
    await page.getByRole("tab", { name: /Alpha/ }).click();
    await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
    await page.getByRole("menuitem", { name: "New Session Here" }).click();
    const dialog = page.getByRole("dialog", { name: "New Session" });
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
    await expect(dialog.getByRole("group", { name: "Provider Permissions" })).not.toContainText("Orchestrator Preset");
    await dialog.getByRole("button", { name: "Create Session" }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
      .toMatchObject({ role: "orchestrator", orchestrator: { execution: { integrationIsolation: true } } });
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()?.config?.permissionMode))
      .toBeUndefined();
  });
}
