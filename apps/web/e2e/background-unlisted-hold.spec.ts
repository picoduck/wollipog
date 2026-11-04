import { expect, test } from "@playwright/test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { waitForSessionPreview } from "./session-readiness.js";

for (const count of [2, 25]) for (const width of [390, 1280]) for (const theme of ["light", "dark"]) {
  test(`unlisted hold with ${count} ids at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    await page.evaluate(({ count, theme, protocol }) => {
      document.documentElement.setAttribute("data-theme", theme);
      document.documentElement.style.colorScheme = theme;
      const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
      fixture.setRunnerProtocolVersion(protocol);
      const startedAt = Date.now() - 41 * 60_000;
      fixture.replaceSessionSnapshot("session-alpha", {
        driver: "claude-code", status: "queued", backgroundWorkState: "running",
        backgroundWorkTracking: "managed", backgroundJobsAvailable: true, backgroundJobs: [], backgroundDeliveries: [],
        queueHold: {
          kind: "worktree_rebind", holdId: "unlisted-evidence", since: startedAt + 60_000,
          target: "/worktrees/handoff", queuedPrompts: 1, unfinishedBackgroundJobs: count, unlistedJobCount: count,
          oldestUnfinishedJob: { launchType: "unregistered", startedAt },
          unlistedJobs: Array.from({ length: Math.min(count, 20) }, (_, i) => ({
            id: i === 0 ? "watcher-task" : `tool:pending-${i}`, kind: i === 0 ? "unregistered" : "provisional",
            startedAt: startedAt + i * 60_000,
          })),
        },
      });
    }, { count, theme, protocol: PROTOCOL_VERSION });
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    await waitForSessionPreview(page);
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator(".session-bar .session-status-button").click();
    await page.getByRole("dialog", { name: "Session Status" }).getByRole("button", { name: "Open Background Work" }).click();
    const panel = page.locator('#right-panel[data-mode="background"]');
    const notice = panel.locator('.notice[data-state="unlisted-hold"]');
    await expect(notice).toContainText(`waits for ${count} tasks`);
    await expect(notice).toContainText("The oldest blocking item, an unregistered task, started");
    if (count > 20) await expect(notice).toContainText("Showing 20 of 25");
    await notice.getByRole("button", { name: "Show Details" }).click();
    await expect(notice.locator(".facts time")).toHaveCount(Math.min(count, 20));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.ISSUE_3894_EVIDENCE_DIR) await page.screenshot({
      path: `${process.env.ISSUE_3894_EVIDENCE_DIR}/hold-${count}-${width}-${theme}.png`, fullPage: true, animations: "disabled",
    });
  });
}
