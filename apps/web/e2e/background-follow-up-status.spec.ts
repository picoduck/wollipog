import { expect, test } from "@playwright/test";
import { waitForSessionPreview } from "./session-readiness.js";

for (const width of [390, 1280]) {
  for (const colorScheme of ["dark", "light"] as const) {
    test(`follow-up state is truthful at ${width}px in ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
      // The isolated shell fixture does not mount the application's theme controller.
      await page.evaluate((theme) => {
        document.documentElement.setAttribute("data-theme", theme);
        document.documentElement.style.colorScheme = theme;
      }, colorScheme);
      await page.evaluate(() => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
          status: "idle", pendingApproval: null, backgroundWorkState: "continuation_pending",
          backgroundFollowUp: { state: "queued", queuedAt: Date.now() - 12 * 60_000, retryScheduled: true },
        });
      });
      const inbox = page.locator(".inbox-row").filter({ hasText: "Alpha Session" });
      await expect(inbox.getByLabel("Status: Follow-Up Queued")).toBeVisible();
      await expect(inbox.locator(".status")).toHaveClass(/t-neutral/);
      await expect(inbox.locator(".status")).not.toHaveClass(/pulse/);
      await inbox.click();
      await waitForSessionPreview(page);
      const expand = page.getByRole("button", { name: "Open Session", exact: true });
      if (await expand.isVisible()) await expand.click();
      const status = page.locator(".session-bar .session-status-button");
      await expect(status).toHaveAccessibleName("Session Status: Follow-Up Queued");
      await status.click();
      const dialog = page.getByRole("dialog", { name: "Session Status" });
      await expect(dialog).toContainText("An automatic retry is scheduled.");
      await dialog.getByRole("button", { name: "Open Background Work" }).click();
      const detail = page.getByRole("region", { name: "Automatic Follow-Up" });
      await expect(detail).toContainText(/Queued 12m ago/);
      await expect(detail.locator("time")).toHaveAttribute("datetime", /.+/);
      await page.evaluate(() => {
        // Foreground work is running, but it is not the turn returning the background results.
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { status: "running" });
      });
      await expect(status).toHaveAccessibleName("Session Status: Running");
      await expect(detail.locator(".status")).toHaveText("Follow-Up Queued");
      await page.evaluate(() => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
          backgroundFollowUp: { state: "running" },
        });
      });
      await expect(detail.locator(".status")).toHaveText("Running");
      await expect(detail.locator(".status")).toHaveClass(/pulse/);
      await page.evaluate(() => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline");
      });
      await expect(detail.locator(".status")).toHaveText("Follow-Up Pending");
      await expect(detail.locator(".status")).not.toHaveClass(/pulse/);
      await expect(detail).toContainText("unverified");
      await page.evaluate(() => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("online");
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
          status: "idle", backgroundFollowUp: { state: "blocked", blocker: "budget" },
        });
      });
      await expect(status).toHaveAccessibleName("Session Status: Follow-Up Blocked");
      await expect(detail.locator(".status")).toHaveClass(/t-warning/);
      await expect(detail).toContainText("cost budget");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.evaluate(() => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
          backgroundWorkState: undefined, backgroundFollowUp: null,
        });
      });
      await expect(detail).toHaveCount(0);
      await expect(status).toHaveAccessibleName("Session Status: Awaiting Prompt");
    });
  }
}
