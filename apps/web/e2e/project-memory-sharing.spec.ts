import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) for (const theme of ["light", "dark"]) {
  test(`project memory consent, persistence and unavailable runners ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.goto("/command-inbox-projects-e2e.html");
    await page.evaluate(() => localStorage.clear()); await page.reload();
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { memorySharing: "separate" });
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setProjectMemoryClaudeVersion("2.1.284");
    }, theme);
    await page.getByRole("tab", { name: /Alpha/ }).hover();
    await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
    await page.getByRole("menuitem", { name: /Manage Project/ }).click();
    const section = page.getByRole("region", { name: "Memory Sharing" });
    const separate = section.getByRole("radio", { name: "Keep Account Memories Separate" });
    const shared = section.getByRole("radio", { name: "Share Project Memory" });
    const save = section.getByRole("button", { name: "Save Memory Policy" });
    await expect(separate).toBeChecked(); await expect(save).toBeDisabled();
    await expect(section).toContainText("project-only sharing is unavailable");
    await expect(section).toContainText("Supported Claude installations use the saved choice");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setProjectMemoryClaudeVersion("2.1.283"));
    await expect(section).toContainText("install Claude Code 2.1.284 or newer");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setProjectMemoryClaudeVersion("2.1.284"));
    await shared.check();
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextProjectUpdate());
    await save.click(); await expect(section.getByRole("alert")).toContainText("Please retry");
    await expect(section).toContainText("Saved Choice: Keep Account Memories Separate");
    await expect(shared).toBeChecked(); await save.click();
    await expect(section.getByRole("alert")).toHaveCount(0);
    await expect(section).toContainText("Saved Choice: Share Project Memory");
    await page.reload();
    await page.getByRole("tab", { name: /Alpha/ }).hover();
    await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
    await page.getByRole("menuitem", { name: /Manage Project/ }).click();
    await expect(shared).toBeChecked();
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(194));
    await expect(section).toContainText("Memory Policy Unavailable — update this runner.");
    await separate.check(); await save.click();
    await expect(section).toContainText("Saved Choice: Keep Account Memories Separate");
    await expect(section).toContainText("Turning sharing off retains shared files");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { memorySharing: undefined }));
    await expect(section).toContainText("Memory policy is unavailable. Update Wollipog to configure it.");
    await expect(section.getByRole("radio")).toHaveCount(0);
  });
}
