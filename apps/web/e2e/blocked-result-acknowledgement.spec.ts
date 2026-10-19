import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { waitForSessionPreview } from "./session-readiness.js";

const evidenceDir = process.env.RESULT_BLOCKED_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
test.use({ video: evidenceDir ? { mode: "on", size: { width: 1440, height: 900 } } : "off" });

async function blockResult(page: Page, revision: string) {
  await page.evaluate((revision) => {
    const now = Date.now();
    const parentTurnId = "blocked-parent";
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      status: "idle", driver: "claude-code", pendingApproval: null,
      backgroundWorkState: "running", backgroundWorkTracking: "managed", backgroundJobsAvailable: true,
      backgroundJobs: [{ id: "monitor", parentTurnId, launchType: "monitor", sourcePresent: true,
        registeredAt: now - 7_200_000, lastObservedAt: now - 60_000, stalledSince: now - 3_600_000 },
      { id: `finished-${revision}`, parentTurnId, launchType: "agent", sourcePresent: true,
        registeredAt: now - 7_200_000, lastObservedAt: now - 3_600_000,
        terminalStatus: "completed", terminalObservedAt: now - 3_600_000, continuationRequired: true }],
      backgroundDeliveries: [{ parentTurnId, jobCount: 1, terminalCount: 1,
        watchdogState: "continuation_blocked", unfinishedSiblingJobs: 1,
        blockedResultRevision: JSON.stringify([[`finished-${revision}`, now - 7_200_000]]) }],
    });
  }, revision);
}

for (const width of [390, 1440]) for (const theme of ["dark", "light"] as const) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("acknowledging blocked results reveals other status and keeps future alerts (#3408)", async ({ page }) => {
      test.setTimeout(60_000);
      const capture = async (stage: string) => {
        if (!evidenceDir) return;
        await page.waitForTimeout(2_000);
        await page.screenshot({ path: join(evidenceDir, `${width}-${theme}-${stage}.png`), animations: "disabled" });
      };
      await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await page.getByRole("button", { name: /Alpha Session/ }).click();
      await waitForSessionPreview(page);
      const expand = page.getByRole("button", { name: "Open Session", exact: true });
      if (await expand.isVisible()) await expand.click();
      await blockResult(page, "first");
      const status = page.locator(".session-bar .session-status-button");
      await expect(status).toHaveAccessibleName("Session Status: Result Blocked");
      await status.click();
      const popover = page.getByRole("dialog", { name: "Session Status" });
      await expect(popover).toContainText("Background jobs and held results are kept.");
      await capture("status-before");
      await popover.getByRole("button", { name: "Acknowledge", exact: true }).click();
      await expect(status).not.toHaveAccessibleName(/Result Blocked/);
      await expect(page.getByRole("dialog", { name: "Stop Job" })).toHaveCount(0);
      await capture("status-after");
      const pinned = page.getByRole("complementary", { name: "Pinned Summary" });
      if (!await pinned.isVisible()) await page.getByRole("button", { name: "Pinned Summary", exact: true }).click();
      await pinned.getByTitle("Open Background Work", { exact: true }).click();
      const panel = page.locator('#right-panel[data-mode="background"]');
      const notice = panel.locator('.notice[data-state="continuation_blocked"]');
      // #2871: the acknowledgement is an entry of the panel's one notice slot, never a group's notice.
      const acknowledged = panel.locator(".panel-notice-slot .notice-title")
        .filter({ hasText: /^Blocked Result Acknowledged in an Earlier Turn$/ });
      await expect(acknowledged).toBeVisible();
      await expect(panel.locator(".background-work-turn .notice")).toHaveCount(0);
      await expect(panel.locator("button.background-job-row")).toHaveCount(2);

      // A new result in the same launching turn must appear as a new alert.
      await blockResult(page, "second");
      await expect(status).toHaveAccessibleName("Session Status: Result Blocked");
      await expect(notice.getByRole("button", { name: /^Stop Monitor Job/ })).toBeVisible();
      const acknowledge = notice.getByRole("button", { name: "Acknowledge", exact: true });
      await acknowledge.focus();
      await capture("panel-before");
      await acknowledge.press("Enter");
      await expect(notice).toHaveCount(0);
      await expect(status).not.toHaveAccessibleName(/Result Blocked/);
      await expect(acknowledged).toBeVisible();
      await expect(panel.locator(".notice")).toHaveCount(1);
      await expect(panel.locator("button.background-job-row")).toHaveCount(2);
      await expect(panel.locator("h3.background-work-turn-title")).toBeFocused();
      await capture("panel-after");
      if (evidenceDir) await page.waitForTimeout(3_000);
    });
  });
}
