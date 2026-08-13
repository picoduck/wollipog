import { expect, test } from "@playwright/test";

const PAGE = "/settings-navigation-e2e.html";

test("Shift+, is discoverable and returns from Settings after nested layers and editors", async ({ page }) => {
  await page.goto(PAGE);
  const shortcutLabel = await page.evaluate(() => /mac|iphone|ipad|ipod/i.test(navigator.platform) ? "⇧," : "Shift+,");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toHaveAttribute("title", `Settings (${shortcutLabel})`);
  await expect(settings).toHaveAccessibleDescription(`Open Settings. Keyboard shortcut: ${shortcutLabel}`);

  await page.keyboard.press("Shift+Comma");
  await expect(page.getByTestId("view-label")).toHaveText("Settings: appearance");

  const editor = page.getByRole("textbox", { name: "Settings Search" });
  await editor.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-label")).toHaveText("Settings: appearance");
  await expect(editor).not.toBeFocused();

  await page.getByRole("button", { name: "Theme: System" }).click();
  const themeList = page.getByRole("listbox", { name: "Theme" });
  await expect(themeList).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(themeList).toBeHidden();
  await expect(page.getByTestId("view-label")).toHaveText("Settings: appearance");

  await page.getByRole("button", { name: "Open Keyboard Shortcuts" }).click();
  const reference = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await expect(reference).toBeVisible();
  const settingsRow = reference.locator(".shortcut-row").filter({ hasText: "Open Settings" });
  await expect(settingsRow.locator("kbd")).toHaveText(shortcutLabel);
  await page.keyboard.press("Escape");
  await expect(reference).toBeHidden();
  await expect(page.getByTestId("view-label")).toHaveText("Settings: appearance");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-label")).toHaveText("Inbox");
});

test("Settings preserves exact Session, Project, and Usage origins across section changes", async ({ page }) => {
  await page.goto(PAGE);
  const scenarios = [
    ["Open Session Origin", "Session: session-alpha"],
    ["Open Project Origin", "Project: project-alpha"],
    ["Open Usage Origin", "Usage"],
  ] as const;

  for (const [button, origin] of scenarios) {
    await page.getByRole("button", { name: button }).click();
    await expect(page.getByTestId("view-label")).toHaveText(origin);
    await page.keyboard.press("Shift+Comma");
    await page.getByRole("button", { name: "Open Network Section" }).click();
    await expect(page.getByTestId("view-label")).toHaveText("Settings: network");
    await page.keyboard.press("Shift+Comma");
    await expect(page.getByTestId("view-label")).toHaveText("Settings: network");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("view-label")).toHaveText(origin);
  }
});

test("typing and IME own Shift+, before global Settings navigation", async ({ page }) => {
  await page.goto(PAGE);
  const editor = page.getByRole("textbox", { name: "Origin Editor" });
  await editor.focus();
  await page.keyboard.press("Shift+Comma");
  await expect(page.getByTestId("view-label")).toHaveText("Inbox");

  await editor.blur();
  await page.evaluate(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "<",
      shiftKey: true,
      isComposing: true,
      bubbles: true,
    }));
  });
  await expect(page.getByTestId("view-label")).toHaveText("Inbox");

  await page.keyboard.press("Shift+Comma");
  await expect(page.getByTestId("view-label")).toHaveText("Settings: appearance");
});

test("direct Settings entry falls back to Inbox and Escape return remains a browser-history push", async ({ page }) => {
  await page.goto(`${PAGE}?entry=settings`);
  await expect(page.getByTestId("view-label")).toHaveText("Settings: keyboard");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-label")).toHaveText("Inbox");

  await page.goBack();
  await expect(page.getByTestId("view-label")).toHaveText("Settings: keyboard");
});
