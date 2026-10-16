import { expect, test } from "@playwright/test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { waitForSessionPreview } from "./session-readiness.js";

test.use({ video: process.env.ISSUE_3280_RECORDING === "true" ? "on" : "off" });

for (const width of [390, 1280]) for (const theme of ["light", "dark"] as const) {
  test(`historical unknown-parent recovery at ${width}px in ${theme}`, async ({ page }) => {
    // Evidence-only pacing; ordinary regression runs have no recording delays.
    const hold = async (ms: number) => {
      if (process.env.ISSUE_3280_RECORDING === "true") await page.waitForTimeout(ms);
    };
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript((value) => localStorage.setItem("wollipog.theme", value), theme);
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    // This isolated shell fixture does not mount the application's theme controller.
    await page.evaluate((value) => {
      document.documentElement.setAttribute("data-theme", value);
      document.documentElement.style.colorScheme = value;
    }, theme);
    await page.evaluate((protocol) => {
      const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
      fixture.setRunnerProtocolVersion(protocol);
      const job = { parentTurnId: "unknown", runnerId: "runner-main", workspaceId: null,
        context: { kind: "native" as const }, launchType: "workflow" as const,
        registeredAt: Date.now() - 120_000, lastObservedAt: Date.now() - 60_000, sourcePresent: true };
      fixture.replaceSessionSnapshot("session-alpha", {
        driver: "claude-code", status: "idle", backgroundWorkState: undefined,
        backgroundWorkTracking: "managed", backgroundJobsAvailable: true, backgroundJobsTruncated: false,
        backgroundJobs: [{ ...job, id: "unresolved-job" }, { ...job, id: "finished-job",
          terminalStatus: "completed", terminalObservedAt: Date.now() - 90_000, continuationRequired: true }],
        backgroundDeliveries: [{ parentTurnId: "unknown", jobCount: 2, terminalCount: 1,
          unfinishedSiblingJobs: 1, watchdogState: "continuation_blocked" }],
      });
    }, PROTOCOL_VERSION);
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    await waitForSessionPreview(page);
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator(".session-bar .session-status-button").click();
    const status = page.getByRole("dialog", { name: "Session Status" });
    await status.getByRole("button", { name: "Open Background Work" }).click();
    const panel = page.locator('#right-panel[data-mode="background"]');
    const notice = panel.locator('.notice[data-state="continuation_blocked"]');
    await expect(notice).toContainText("parent turn is unknown");
    await expect(notice).toContainText("cannot verify that the jobs are still running");
    await expect(notice).toContainText("More Actions → Restart Session");
    await expect(notice).toContainText("Restart ends every job and reports held results; it does not rerun their original commands.");
    await expect(notice.getByRole("button", { name: /^Stop |Acknowledge/ })).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.ISSUE_3280_EVIDENCE_DIR) {
      await page.screenshot({ path: `${process.env.ISSUE_3280_EVIDENCE_DIR}/after-${width}-${theme}.png`, fullPage: true });
    }
    await hold(3_000);
    await notice.getByRole("button", { name: "Show Details" }).click();
    await expect(notice.locator(".facts")).toContainText("Restarting the session ends every job and reports this result to the new conversation.");
    await hold(3_000);
    await panel.getByRole("button", { name: /^(Close Panel|Back to Session)$/ }).click();
    await hold(1_500);
    await page.locator(".session-bar").getByRole("button", { name: "More Actions", exact: true }).click();
    const menu = page.getByRole("menu", { name: "More Actions" });
    const restart = menu.getByRole("menuitem", { name: /Restart Session/ });
    await expect(restart).toBeEnabled();
    await hold(2_000);
    await restart.click();
    const confirmation = page.getByRole("dialog", { name: "Restart Session", exact: true });
    await expect(confirmation).toContainText("ends every background job");
    await expect(confirmation).toContainText("The original job commands are not rerun");
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await hold(4_000);
    if (process.env.ISSUE_3280_EVIDENCE_DIR) {
      await page.screenshot({ path: `${process.env.ISSUE_3280_EVIDENCE_DIR}/confirm-${width}-${theme}.png`, fullPage: true });
    }
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page.locator(".session-bar .session-status-button")).toHaveAccessibleName("Session Status: Result Blocked");
    await hold(4_000);
  });
}
