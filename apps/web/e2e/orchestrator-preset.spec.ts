import { expect, test, type Locator } from "@playwright/test";

test.use({ video: "on" });

/**
 * A Permission Preset card, scoped to its own radiogroup.
 *
 * Scoped because the dialog has three radiogroups — Permission Preset, Harness and Mode — and a
 * bare `getByRole("radio")` matches across all of them. The name is anchored at the start because a
 * ChoiceCard's accessible name is its title followed by its description, and both preset cards
 * mention "Orchestrator": the saved-default card's name begins "Saved Default — ".
 */
function presetCard(dialog: Locator, name: RegExp): Locator {
  return dialog.getByRole("radiogroup", { name: "Permission Preset" }).getByRole("radio", { name });
}


test.beforeEach(async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("tab", { name: /Alpha/ })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
    test(`saved orchestrator default and TUI accounting ${theme} ${viewport.width}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto("/command-inbox-projects-e2e.html?orchestratorDefault=1");
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(112);
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], ["default", "orchestrator"]);
      }, theme);
      await page.getByRole("tab", { name: /Alpha/ }).click();
      await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
      await page.getByRole("menuitem", { name: "New Session Here" }).click();
      const dialog = page.getByRole("dialog", { name: "New Session" });
      // #832 moved Permission Preset from a popover Select to always-visible ChoiceCards, so the
      // saved default now STATES itself on a card instead of inside a closed trigger's name.
      await expect(presetCard(dialog, /^Saved Default — Orchestrator/)).toBeVisible();
      await dialog.getByRole("radio", { name: /^Native TUI/ }).click();
      await expect(dialog.getByText(/Usage Accounting: Unavailable/)).toBeVisible();
      await expect(dialog.getByText(/Native TUI spending and tool calls are not included/)).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("native-tui-unmetered.png") });
      await dialog.getByRole("button", { name: "Create Session" }).click();
      await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
        .toMatchObject({ launchSurface: "native_tui" });
      expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()?.config?.permissionMode))
        .toBeUndefined();
    });
    for (const surface of ["direct", "native_tui"] as const) {
    test(`orchestrator creation preset ${surface} ${theme} ${viewport.width}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(112);
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], ["default", "orchestrator"]);
      }, theme);
      await page.getByRole("tab", { name: /Alpha/ }).click();
      await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
      await page.getByRole("menuitem", { name: "New Session Here" }).click();
      const dialog = page.getByRole("dialog", { name: "New Session" });
      const orchestratorCard = presetCard(dialog, /^Orchestrator/);
      await expect(orchestratorCard).toBeVisible();
      await expect(dialog.getByText("Conductor-Led Work", { exact: true })).toHaveCount(0);
      await orchestratorCard.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("preset-unselected.png") });
      // One click, no popup to open: that IS the fix for #832, whose defect was the second of two
      // options being clipped inside the menu this used to have to open.
      await expect(orchestratorCard).toHaveAttribute("aria-checked", "false");
      await orchestratorCard.click();
      await expect(orchestratorCard).toHaveAttribute("aria-checked", "true");
      const tui = dialog.getByRole("radio", { name: /^Native TUI/ });
      await expect(tui).toBeEnabled();
      if (surface === "native_tui") await tui.click();
      await page.screenshot({ path: testInfo.outputPath("preset-selected.png") });
      await dialog.getByRole("button", { name: "Create Session" }).click();
      await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
        .toMatchObject({ config: { permissionMode: "orchestrator" },
          ...(surface === "native_tui" ? { launchSurface: "native_tui" } : {}) });
    });
    }
  }
}
