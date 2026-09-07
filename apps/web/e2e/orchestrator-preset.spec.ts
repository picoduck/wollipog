import { expect, test } from "@playwright/test";

test.use({ video: "on" });

test.beforeEach(async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("tab", { name: /Alpha/ })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
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
      const preset = dialog.getByRole("checkbox", { name: "Orchestrator", exact: true });
      await expect(preset).toBeVisible();
      await expect(dialog.getByText("Conductor-Led Work", { exact: true })).toHaveCount(0);
      await preset.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("preset-unselected.png") });
      await preset.check();
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
