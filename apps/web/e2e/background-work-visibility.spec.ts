import { waitForSessionPreview } from "./session-readiness.js";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { pinWidestFace } from "./font-geometry.js";

/** The Session Status control is whole on screen: inside the viewport and every clipping ancestor. */
async function expectButtonUnclipped(control: Locator) {
  await expect(control).toBeVisible();
  expect(await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    let contained = element.scrollWidth <= element.clientWidth + 0.5;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (/hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowX)) {
        const bounds = parent.getBoundingClientRect();
        contained &&= box.left >= bounds.left - 0.5 && box.right <= bounds.right + 0.5;
      }
    }
    return contained && box.right <= innerWidth && box.left >= 0;
  })).toBe(true);
}

/** A Sessions row's one status badge (#2209): its whole label shows, inside every clipping ancestor. */
async function expectRowBadgeWhole(badge: Locator) {
  await expect(badge).toBeVisible();
  expect(await badge.evaluate((element) => {
    const box = element.getBoundingClientRect();
    let contained = element.scrollWidth <= element.clientWidth + 0.5;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (/hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowX)) {
        const bounds = parent.getBoundingClientRect();
        contained &&= box.left >= bounds.left - 0.5 && box.right <= bounds.right + 0.5;
      }
    }
    return contained && box.right <= innerWidth && box.left >= 0;
  })).toBe(true);
}

/** The Background Work panel through the Pinned Summary's delivery badge, for a status row whose
 * action is a step rather than Open (#2275). */
async function openBackgroundWorkFromPinnedSummary(page: Page) {
  const pinned = page.getByRole("complementary", { name: "Pinned Summary" });
  if (!await pinned.isVisible()) await page.getByRole("button", { name: "Pinned Summary", exact: true }).click();
  await pinned.locator(".status[data-group='background-work']").click();
}

for (const width of [320, 390, 700, 1280]) {
  test(`background work remains visible through lifecycle transitions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.setGitStatus("session-alpha", {
        hasChanges: false, ahead: 0, stagedCount: 0, modifiedCount: 0,
        untrackedCount: 0, conflictedCount: 0, operation: null,
      });
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        status: "idle", backgroundWorkState: "running",
        pendingApproval: { kind: "permission", requestId: "background-approval", title: "Review external work", options: [] },
      });
    });
    const row = page.locator(".inbox-row").filter({ hasText: "Alpha Session" });
    // Measured in the widest face CI renders, so a line that only just fits here cannot clip there.
    await pinWidestFace(page, row);
    // #2209: a row shows one status on the bar's ranking. The approval needs the person, so it is the
    // badge, and the background work is left to the Session Status popover.
    await expect(row.locator(".status")).toHaveCount(1);
    await expectRowBadgeWhole(row.getByLabel("Status: Approval Required"));
    // Without the request, the background work is the row's one status, whole at every width.
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { pendingApproval: null });
    });
    for (const [state, label] of [
      ["continuation_pending", "Continuation Pending"],
      ["orphaned", "Background Work Lost"],
      ["resumed", null],
      ["running", "Waiting on External Job"],
    ] as const) {
      await page.evaluate((backgroundWorkState) => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { backgroundWorkState });
      }, state);
      if (label === null) await expect(row.locator(".status")).toHaveCount(0);
      else await expectRowBadgeWhole(row.getByLabel(`Status: ${label}`));
    }
    await expect(row).toHaveAccessibleName(/Waiting on External Job/);
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        pendingApproval: { kind: "permission", requestId: "background-approval", title: "Review external work", options: [] },
      });
    });
    await row.click();
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    await waitForSessionPreview(page);
    if (await expand.isVisible()) await expand.click();
    const header = page.locator(".session-bar");
    const status = header.locator(".session-status-button");
    const live = header.locator('[data-live="background-work"]');
    const dialog = page.getByRole("dialog", { name: "Session Status" });
    // #2182: one status control at every width. The approval needs the person, so it is the badge;
    // background work is a row of the Session Status popover, and the live region keeps announcing it.
    for (const [state, label, announced] of [
      ["running", "Waiting on External Job", "Waiting on External Job"],
      ["continuation_pending", "Continuation Pending", "Continuation Pending"],
      ["orphaned", "Background Work Lost", "Lost"],
    ] as const) {
      await page.evaluate((backgroundWorkState) => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { backgroundWorkState });
      }, state);
      await expect(live).toHaveText(`Background Work: ${announced}`);
      await expect(status).toHaveAccessibleName("Session Status: Approval Required");
      await expect(header.locator(".status")).toHaveCount(1);
      await expectButtonUnclipped(status);
      await status.click();
      const row = dialog.locator(".session-status-row").filter({ hasText: label });
      await expect(row.locator(".status")).toHaveText(label);
      await row.getByRole("button", { name: "Open Background Work" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('#right-panel[data-mode="background"]')).toBeVisible();
      await page.getByRole("button", { name: /^(Close Panel|Back to Session)$/u }).click();
      await expect(header.locator('[aria-label^="Changes:"]')).toHaveCount(0);
      await expect(header.getByRole("button", { name: "Share", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    // With the approval answered, running background work is the badge itself while the session
    // awaits its next prompt (#784), at every width and without measuring.
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        backgroundWorkState: "running", pendingApproval: null,
      });
    });
    await expect(status).toHaveAccessibleName("Session Status: Waiting on External Job");
    await expectButtonUnclipped(status);
    await status.focus();
    await status.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(status).toBeFocused();
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { backgroundWorkState: "resumed" });
    });
    await expect(status).toHaveAccessibleName("Session Status: Awaiting Prompt");
    await expect(live).toHaveText("");
  });
}

for (const width of [320, 1280]) {
  test(`delivery watchdogs stay compact and open their plain-language detail at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    await waitForSessionPreview(page);
    if (await expand.isVisible()) await expand.click();
    const header = page.locator(".session-bar");
    const cases = [
      ["terminal_without_continuation", "Result Pending", "A background job finished, but its result has not yet been returned to this conversation."],
      ["continuation_blocked", "Result Blocked", "A background job finished, but its result is held because another job has no confirmed end."],
      ["accepted_without_result", "Result Missing", "A background job finished, but its result is missing after Wollipog accepted the return step."],
      ["result_not_projected", "Transcript Delayed", "A background result reached Wollipog, but it has not appeared in this conversation yet."],
      ["dashboard_observation_pending", "Notification Pending", "A background result reached the conversation, but this dashboard has not yet confirmed the update."],
    ] as const;
    for (const [watchdogState, label, description] of cases) {
      await page.evaluate(({ watchdogState }) => {
        const missing = watchdogState === "accepted_without_result";
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
          backgroundWorkState: undefined,
          backgroundWorkTracking: "managed",
          backgroundJobsAvailable: true,
          backgroundJobs: [],
          backgroundDeliveries: [{
            ...(missing ? {
              continuationId: "bgcont-e2e-missing",
              acceptedAt: Date.now() - 120_000,
              missingResultAt: Date.now() - 90_000,
            } : {}),
            parentTurnId: "watchdog-parent",
            jobCount: 1,
            terminalCount: 1,
            watchdogState,
          }],
        });
      }, { watchdogState });
      // #2182: a result still coming back is a row of the Session Status popover, with its sentence.
      await header.locator(".session-status-button").click();
      const statusDialog = page.getByRole("dialog", { name: "Session Status" });
      const row = statusDialog.locator(".session-status-row").filter({ hasText: label });
      const badge = row.locator(".status");
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText(label);
      await expect(row.locator(".session-status-text")).toHaveText(description);
      expect(await badge.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const surface = element.parentElement!.getBoundingClientRect();
        // One line: a popover badge may wrap only when it is wider than its row.
        return box.height <= 20.5 &&
          element.scrollWidth <= element.clientWidth + 0.5 &&
          box.left >= surface.left - 0.5 && box.right <= surface.right + 0.5;
      })).toBe(true);

      if (width === 1280 && watchdogState === "terminal_without_continuation") {
        await page.keyboard.press("Escape");
        const pinned = page.getByRole("complementary", { name: "Pinned Summary" });
        if (!await pinned.isVisible()) await page.getByRole("button", { name: "Pinned Summary", exact: true }).click();
        const pinnedBadge = pinned.locator(".status[data-group='background-work']");
        await expect(pinnedBadge).toHaveText(label);
        await expect(pinnedBadge).toHaveAccessibleName(`Background Work: ${label}. ${description}`);
        await pinnedBadge.click();
        const pinnedPanel = page.locator('#right-panel[data-mode="background"]');
        await expect(pinnedPanel.locator('[data-watchdog-highlighted="true"]')).toBeVisible();
        await pinnedPanel.getByRole("button", { name: /^(Close Panel|Back to Session)$/u }).click();
        await header.locator(".session-status-button").click();
      }

      if (watchdogState === "accepted_without_result") {
        // #2275: Result Missing needs the person, so it is the bar's status, and its row takes the step
        // itself. On a phone that step is taken here; on desktop the panel's own button is checked.
        const status = header.locator(".session-status-button");
        await expect(status).toHaveAccessibleName("Session Status: Result Missing");
        const step = row.getByRole("button", { name: "Acknowledge Missing Result" });
        await expect(step).toBeVisible();
        if (width === 320) {
          await step.click();
          await expect(statusDialog).toHaveCount(0);
          await expect(status).toBeFocused();
          await expect(page.getByText("Missing result acknowledged.")).toBeVisible();
          await expect(status).toHaveAccessibleName("Session Status: Awaiting Prompt");
          continue;
        }
        await page.keyboard.press("Escape");
        await openBackgroundWorkFromPinnedSummary(page);
      } else {
        await row.getByRole("button", { name: "Open Background Work" }).click();
      }
      const panel = page.locator('#right-panel[data-mode="background"]');
      await expect(panel).toBeVisible();
      const highlighted = panel.locator(`[data-watchdog-state="${watchdogState}"]`);
      await expect(highlighted).toBeVisible();
      // #2859: one notice per delivery at the top of its group; its explanation waits behind Show Details.
      const notice = highlighted.locator(`.notice[data-state="${watchdogState}"]`);
      await expect(notice).toBeVisible();
      await expect(highlighted.locator(".notice")).toHaveCount(1);
      await expect(highlighted.locator(".notice-details-body")).toHaveCount(0);
      if (watchdogState === "accepted_without_result" || watchdogState === "continuation_blocked") {
        await expect(notice.locator(".notice-title")).toHaveText(label);
        const toggle = notice.getByRole("button", { name: "Show Details" });
        await toggle.click();
        await expect(notice.getByRole("button", { name: "Hide Details" })).toBeVisible();
        const code = notice.locator(".facts code");
        await expect(code).toHaveText(watchdogState);
        // The pipeline code wraps inside its column rather than run under its neighbour.
        expect(await notice.locator(".facts dd").evaluateAll((values) =>
          values.every((value) => value.scrollWidth <= value.clientWidth + 0.5))).toBe(true);
        await notice.getByRole("button", { name: "Hide Details" }).click();
      } else {
        await expect(notice).toHaveClass(/\bcompact\b/u);
        await expect(notice.getByRole("button")).toHaveCount(0);
      }
      if (watchdogState === "accepted_without_result") {
        await expect(notice).toContainText("A background job finished, but its result never reached this conversation.");
        const acknowledge = notice.getByRole("button", { name: "Acknowledge", exact: true });
        await expect(acknowledge).toBeVisible();
        await expect(highlighted.getByRole("button", { name: /Retry|Rerun/i })).toHaveCount(0);
        await acknowledge.click();
        await expect(panel.locator(".background-work-turn-head .status")).toHaveText("Missing Result Acknowledged");
        await expect(panel.locator('.notice[data-state="accepted_without_result"]')).toHaveCount(0);
      }
      await panel.getByRole("button", { name: /^(Close Panel|Back to Session)$/u }).click();
    }
  });
}

/** A Result Blocked turn: a monitor that never fires beside a finished review subagent (#1780). */
const resultBlocked = (page: Page) => page.evaluate(() => {
  const now = Date.now();
  window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
    status: "idle",
    driver: "claude-code",
    backgroundWorkState: "running",
    backgroundWorkTracking: "managed",
    backgroundJobsAvailable: true,
    backgroundJobs: [
      {
        id: "bg-monitor-7be210", parentTurnId: "blocked-parent", launchType: "monitor",
        registeredAt: now - 50 * 60_000, lastObservedAt: now - 60_000, sourcePresent: true,
      },
      {
        id: "bg-agent-04d2e1", parentTurnId: "blocked-parent", launchType: "agent",
        registeredAt: now - 50 * 60_000, lastObservedAt: now - 20 * 60_000, sourcePresent: true,
        terminalStatus: "completed", terminalObservedAt: now - 20 * 60_000, continuationRequired: true,
      },
    ],
    backgroundDeliveries: [{
      parentTurnId: "blocked-parent", jobCount: 2, terminalCount: 1,
      watchdogState: "continuation_blocked", unfinishedSiblingJobs: 1,
    }],
  });
});

for (const width of [320, 1280]) {
  test(`Stop Job is on the job's page, behind a confirmation that names it, and unavailable with a visible reason at ${width}px (#1780, #2858)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    await waitForSessionPreview(page);
    if (await expand.isVisible()) await expand.click();
    // #2275: where Stop Job is available for the one running job, the status row offers it itself,
    // so the panel is opened from the Pinned Summary instead.
    const openPanel = async (rowAction: "Open Background Work" | "Stop Job…" = "Open Background Work") => {
      await page.locator(".session-bar .session-status-button").click();
      const row = page.getByRole("dialog", { name: "Session Status" }).locator(".session-status-row")
        .filter({ hasText: "Result Blocked" });
      await expect(row.locator(".status")).toHaveText("Result Blocked");
      await expect(row.getByRole("button")).toHaveAccessibleName(rowAction);
      if (rowAction === "Open Background Work") {
        await row.getByRole("button", { name: "Open Background Work" }).click();
      } else {
        await page.keyboard.press("Escape");
        await openBackgroundWorkFromPinnedSummary(page);
      }
      const panel = page.locator('#right-panel[data-mode="background"]');
      await expect(panel).toBeVisible();
      return panel;
    };
    const closePanel = async (panel: Locator) => {
      const back = panel.getByRole("button", { name: "Back to Background Work" });
      if (await back.count()) await back.click();
      await panel.getByRole("button", { name: /^(Close Panel|Back to Session)$/u }).click();
    };
    const openJob = async (panel: Locator, name: string) => {
      await panel.locator("button.background-job-row").filter({ hasText: name }).click();
      await expect(panel.locator(".rpanel-page-title")).toHaveText(name);
      await expect(panel.getByRole("button", { name: "Back to Background Work" })).toBeVisible();
      return panel.locator(`.job-detail[aria-label="${name}"]`);
    };

    // An older runner: the notice's Stop is visible but unavailable, described by its reason on screen.
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(189));
    await resultBlocked(page);
    let panel = await openPanel();
    const notice = panel.locator('.notice[data-state="continuation_blocked"]');
    await expect(notice.locator(".notice-title")).toHaveText("Result Blocked");
    await expect(notice).toContainText(
      "Agent job 04d2e1 finished, but its result is held because another job has no confirmed end.");
    const noticeStop = notice.getByRole("button", { name: "Stop Monitor Job 7be210…" });
    await expect(noticeStop).toBeDisabled();
    await expect(noticeStop).toHaveAccessibleDescription(
      "This machine needs a newer runner for stopping a background job. Update and restart the runner.");
    let detail = await openJob(panel, "Monitor Job 7be210");
    const unavailable = detail.getByRole("button", { name: "Stop Job…" });
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toHaveAccessibleDescription(
      "This machine needs a newer runner for stopping a background job. Update and restart the runner.");
    await expect(detail.locator(".job-detail-stop-note")).toBeVisible();
    await expect(unavailable).not.toHaveAttribute("title", /.+/u);
    await closePanel(panel);

    // A v190 runner offers Stop Job, but its restart still discards the result (#1779).
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(190));
    await resultBlocked(page);
    panel = await openPanel("Stop Job…");
    await notice.getByRole("button", { name: "Show Details" }).click();
    await expect(notice.locator(".facts")).toContainText(
      "Restarting or stopping the session also ends the unfinished job, but ends every other job and discards this result.");
    await closePanel(panel);

    // A current runner: the notice and the unfinished job's page both offer Stop behind the confirmation
    // titled with its name, and its restart reports the result to the new conversation instead (#1779).
    await page.evaluate((version) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(version), PROTOCOL_VERSION);
    await resultBlocked(page);
    panel = await openPanel("Stop Job…");
    await expect(noticeStop).toBeEnabled();
    await notice.getByRole("button", { name: "Show Details" }).click();
    await expect(notice.locator(".facts")).toContainText("Stopping the session also ends the unfinished job but discards " +
      "this result. Restarting the session ends every job and reports this result to the new conversation.");
    await noticeStop.click();
    const noticeConfirmation = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: "Stop Monitor Job 7be210" }));
    await expect(noticeConfirmation).toContainText("Stop Monitor Job 7be210");
    await noticeConfirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(noticeConfirmation).toHaveCount(0);
    detail = await openJob(panel, "Agent Job 04d2e1");
    await expect(detail.getByRole("button", { name: "Stop Job…" })).toHaveCount(0);
    await expect(detail).toContainText("Returns to this conversation when the other job finishes");
    await panel.getByRole("button", { name: "Back to Background Work" }).click();
    detail = await openJob(panel, "Monitor Job 7be210");
    // Long values wrap inside their column rather than run past the panel.
    expect(await detail.locator(".facts dd").evaluateAll((values) =>
      values.every((value) => value.scrollWidth <= value.clientWidth + 0.5))).toBe(true);
    const stop = detail.getByRole("button", { name: "Stop Job…" });
    await expect(stop).toBeEnabled();
    await stop.click();
    const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: "Stop Monitor Job 7be210" }));
    await expect(confirmation).toContainText("Stop Monitor Job 7be210");
    await expect(confirmation).toContainText("Only this job ends, and it is recorded as killed.");
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(detail.locator(".status").first()).toHaveText("Running");
    await stop.click();
    await confirmation.getByRole("button", { name: "Stop Job", exact: true }).click();

    await expect(detail).toContainText("Stopped. Its status updates here shortly.");
    await expect(detail.locator(".status").first()).toHaveText("Killed");
    // #1849: the job names who stopped it, by role, and why.
    await expect(detail.locator(".facts > div").filter({ hasText: "Ended By" }).locator("dd")).toHaveText("Session Owner");
    await expect(detail.locator(".facts > div").filter({ hasText: "Reason" }).locator("dd")).toHaveText("Stop Job Request");
    await expect(detail.getByRole("button", { name: "Stop Job…" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Back to Background Work" }).click();
    await expect(panel.locator('[data-watchdog-state="continuation_blocked"]')).toHaveCount(0);
    await expect(panel.locator("button.background-job-row").filter({ hasText: "Agent Job 04d2e1" })).toContainText("Result returned");
  });
}

for (const width of [390, 1440]) {
  test(`Result Blocked is the bar's status and its row stops the one running job behind a confirmation at ${width}px (#2275)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    await waitForSessionPreview(page);
    if (await expand.isVisible()) await expand.click();
    await page.evaluate((version) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(version), PROTOCOL_VERSION);
    await resultBlocked(page);
    const status = page.locator(".session-bar .session-status-button");
    await expect(status).toHaveAccessibleName("Session Status: Result Blocked");
    await expectButtonUnclipped(status);
    await status.click();
    // The session's own status stays listed beneath it (#3073).
    await expect(page.getByRole("dialog", { name: "Session Status" }).locator(".session-status-row .status"))
      .toHaveText(["Result Blocked", "Waiting on External Job", "Awaiting Prompt", "1 Worker"]);
    const row = page.getByRole("dialog", { name: "Session Status" }).locator(".session-status-row")
      .filter({ hasText: "Result Blocked" });
    await expect(row.locator(".session-status-text")).toHaveText(
      "A background job finished, but its result is held because another job has no confirmed end.");
    await row.getByRole("button", { name: "Stop Job…" }).click();

    const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: "Stop Job" }));
    await expect(confirmation).toContainText("Only this job ends, and it is recorded as killed.");
    await expect(confirmation).toContainText("Monitor Job 7be210");
    await confirmation.getByRole("button", { name: "Stop Job", exact: true }).click();
    await expect(page.getByText("Monitor Job 7be210 was stopped.")).toBeVisible();
    await expect(status).not.toHaveAccessibleName(/Result Blocked/);
    await expect(status).toBeFocused();
  });
}

for (const width of [390, 1440]) {
  test(`Result Missing is its title, sentence and Acknowledge above the fold, and a lost job says so with View Turn at ${width}px (#2859)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    await waitForSessionPreview(page);
    if (await expand.isVisible()) await expand.click();
    await page.evaluate((version) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(version), PROTOCOL_VERSION);
    await page.evaluate(() => {
      const now = Date.now();
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        status: "idle",
        driver: "claude-code",
        backgroundWorkState: undefined,
        backgroundWorkTracking: "managed",
        backgroundJobsAvailable: true,
        backgroundJobs: [{
          id: "bg-shell-a1f3c9", parentTurnId: "missing-parent", launchType: "shell",
          registeredAt: now - 20 * 60_000, lastObservedAt: now - 15 * 60_000, sourcePresent: true,
          terminalStatus: "completed", terminalObservedAt: now - 15 * 60_000, continuationRequired: true,
          continuationId: "bgcont-e2e-missing", continuationAcceptedAt: now - 14 * 60_000,
          continuationMissingResultAt: now - 12 * 60_000,
        }],
        backgroundDeliveries: [{
          continuationId: "bgcont-e2e-missing", parentTurnId: "missing-parent", jobCount: 1, terminalCount: 1,
          acceptedAt: now - 14 * 60_000, missingResultAt: now - 12 * 60_000, watchdogState: "accepted_without_result",
        }],
      });
    });
    await openBackgroundWorkFromPinnedSummary(page);
    const panel = page.locator('#right-panel[data-mode="background"]');
    await expect(panel).toBeVisible();
    const notice = panel.locator('.notice[data-state="accepted_without_result"]');
    const parts = [
      notice.locator(".notice-title"),
      notice.getByText("Shell job a1f3c9 finished, but its result never reached this conversation."),
      notice.getByRole("button", { name: "Acknowledge", exact: true }),
    ];
    for (const part of parts) {
      await expect(part).toBeInViewport({ ratio: 1 });
    }
    await expect(panel.locator(".background-work-turn").first()).toContainText("Result Missing");
    expect(await panel.locator(".background-work-turn").first().evaluate((group) =>
      (group.textContent ?? "").split("Result Missing").length - 1)).toBe(1);
    await panel.getByRole("button", { name: /^(Close Panel|Back to Session)$/u }).click();

    // The runner restarted under a running monitor: one danger notice, View Turn, and no empty state.
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitUserMessage(
      "session-alpha", "Watch the deploy until it goes green.", "lost-parent"));
    await page.evaluate(() => {
      const now = Date.now();
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        backgroundWorkState: "orphaned",
        backgroundDeliveries: [],
        backgroundJobs: [{
          id: "bg-monitor-7be210", parentTurnId: "lost-parent", launchType: "monitor",
          registeredAt: now - 30 * 60_000, lastObservedAt: now - 12 * 60_000, sourcePresent: true,
        }],
      });
    });
    await page.locator(".session-bar .session-status-button").click();
    await page.getByRole("dialog", { name: "Session Status" }).locator(".session-status-row")
      .filter({ hasText: "Background Work Lost" }).getByRole("button", { name: "Open Background Work" }).click();
    await expect(panel).toBeVisible();
    const lost = panel.locator('.notice[data-state="lost"]');
    await expect(lost.locator(".notice-title")).toHaveText("Lost Track of a Background Job");
    await expect(lost).toContainText("restarted while monitor job 7be210 was running, so its result can't come back to this conversation.");
    await expect(lost.getByRole("button", { name: "View Turn" })).toBeVisible();
    await expect(lost.getByRole("button", { name: /Rerun|Retry/u })).toHaveCount(0);
    await expect(panel.locator("button.background-job-row .status")).toHaveText("Lost");
    await expect(panel.locator(".state")).toHaveCount(0);
  });
}

test.describe("on touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("every Background Work action is at least 44px to hit, and a turn's heading keeps View Turn on its line (#2858)", async ({ page }) => {
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.evaluate((version) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(version), PROTOCOL_VERSION);
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitUserMessage(
      "session-alpha", "Watch the deploy and the long-running integration suite.", "blocked-parent"));
    await resultBlocked(page);
    await page.locator(".session-bar .session-status-button").click();
    await page.getByRole("dialog", { name: "Session Status" }).getByRole("button", { name: "Stop Job…" }).waitFor();
    await page.keyboard.press("Escape");
    await openBackgroundWorkFromPinnedSummary(page);
    const panel = page.locator('#right-panel[data-mode="background"]');
    await expect(panel).toBeVisible();
    /** The tallest hit area a control has: its own box, or the ::after a small control borrows. */
    const hitHeights = (locator: Locator) => locator.evaluateAll((elements) => elements.map((element) => {
      const after = getComputedStyle(element, "::after");
      const own = element.getBoundingClientRect().height;
      if (after.content === "none" || after.position !== "absolute") return own;
      const top = Number.parseFloat(after.top) || 0;
      const bottom = Number.parseFloat(after.bottom) || 0;
      return own - top - bottom;
    }));
    const heading = panel.locator(".background-work-turn-head").first();
    const viewTurn = heading.getByRole("button", { name: "View Turn" });
    await expect(viewTurn).toBeVisible();
    const [headingBox, titleBox, buttonBox] = await Promise.all([
      heading.boundingBox(), heading.locator("h3").boundingBox(), viewTurn.boundingBox()]);
    expect(Math.abs((buttonBox!.y + buttonBox!.height / 2) - (titleBox!.y + titleBox!.height / 2)) < 2,
      "View Turn sits on the heading's line").toBe(true);
    expect(buttonBox!.x + buttonBox!.width <= headingBox!.x + headingBox!.width + 0.5).toBe(true);
    for (const height of await hitHeights(panel.locator("button:visible"))) expect(height).toBeGreaterThanOrEqual(44);

    await panel.locator("button.background-job-row").filter({ hasText: "Monitor Job 7be210" }).click();
    await expect(panel.locator(".job-detail")).toBeVisible();
    for (const height of await hitHeights(page.locator("#right-panel button:visible"))) expect(height).toBeGreaterThanOrEqual(44);
  });
});

for (const width of [390, 1440]) {
  test(`pre-acceptance retry exhaustion is visible and acknowledged safely at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    await waitForSessionPreview(page);
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.evaluate((version) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(version), PROTOCOL_VERSION);
    await page.evaluate(() => {
      const now = Date.now();
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        status: "idle", pendingApproval: null, driver: "claude-code", backgroundWorkState: undefined,
        backgroundWorkTracking: "managed",
        backgroundJobs: [{ id: "capacity-job", parentTurnId: "capacity-turn", launchType: "agent",
          registeredAt: now - 20_000, terminalStatus: "completed", terminalObservedAt: now - 10_000,
          lastObservedAt: now, sourcePresent: true, continuationRequired: true, continuationId: "capacity-continuation" }],
        backgroundDeliveries: [{ continuationId: "capacity-continuation", parentTurnId: "capacity-turn",
          jobCount: 1, terminalCount: 1, queuedAt: now - 9_000, submittedAt: now - 8_000,
          retryExhaustedAt: now - 1_000, watchdogState: "capacity_retry_exhausted" }],
      });
    });
    const status = page.locator(".session-bar .session-status-button");
    await expect(status).toHaveAccessibleName("Session Status: Retry Exhausted");
    await expectButtonUnclipped(status);
    await status.click();
    const popover = page.getByRole("dialog", { name: "Session Status" });
    await expect(popover.getByRole("button", { name: "Acknowledge Retry Exhaustion", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await openBackgroundWorkFromPinnedSummary(page);
    const panel = page.locator('#right-panel[data-mode="background"]');
    const notice = panel.locator('.notice[data-state="capacity_retry_exhausted"]');
    await expect(notice).toBeVisible();
    await expect(notice.locator(".notice-title")).toHaveText("Retry Exhausted");
    await expect(notice).toContainText("The return step was not confirmed.");
    await expect(panel).toContainText("Result return stopped");
    await expect(notice.getByRole("button", { name: "Acknowledge", exact: true })).toBeVisible();
    await expect(notice.getByRole("button", { name: /retry|rerun/i })).toHaveCount(0);
    await notice.getByRole("button", { name: "Show Details", exact: true }).click();
    await expect(notice).toContainText("Exhausted Since");
    await notice.getByRole("button", { name: "Acknowledge", exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect(panel).toContainText("Retry Exhaustion Acknowledged");
    await expect(status).not.toHaveAccessibleName("Session Status: Retry Exhausted");
  });
}
