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
      ["continuation_blocked", "Result Blocked", "A background job finished, but its result cannot be returned while another job from the same turn is still running."],
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
      await expect(highlighted.locator(".background-delivery-summary > strong")).toHaveText(label);
      await expect(highlighted.locator(".background-delivery-summary")).toContainText("Completed");
      await expect(highlighted.locator(".background-delivery-summary")).toContainText("Still Pending");
      await expect(highlighted.locator(".background-delivery-summary")).toContainText("Recovery");
      await expect(highlighted.locator(".background-delivery-summary")).toContainText("Your Action");
      await expect(highlighted.locator("details code")).not.toBeVisible();
      if (watchdogState === "continuation_blocked") {
        // Wollipog ends the sibling only for a handoff held past its bound (#1778); otherwise the step is the user's.
        await expect(highlighted).toContainText(
          "It ends that job itself only when a queued handoff has waited on it past its bound.");
        await expect(highlighted).toContainText("Ask the session to stop the unfinished job");
      }
      if (watchdogState === "accepted_without_result") {
        await expect(highlighted).toContainText("Missing Since");
        await expect(highlighted).toContainText("Acknowledgement Required");
        const acknowledge = highlighted.getByRole("button", { name: "Acknowledge Missing Result" });
        await expect(acknowledge).toBeVisible();
        await expect(highlighted.getByRole("button", { name: /Retry/i })).toHaveCount(0);
        await acknowledge.click();
        await expect(panel.locator('[data-recovery-state="missing-result-acknowledged"]'))
          .toContainText("Missing Result Acknowledged");
        await expect(acknowledge).toHaveCount(0);
      }
      await panel.getByRole("button", { name: /^(Close Panel|Back to Session)$/u }).click();
    }
  });
}

for (const width of [320, 1280]) {
  test(`Result Blocked offers Stop Job for the unfinished job and shows it unavailable on older runners at ${width}px (#1780)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    await waitForSessionPreview(page);
    if (await expand.isVisible()) await expand.click();
    const resultBlocked = () => page.evaluate(() => {
      const now = Date.now();
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        driver: "claude-code",
        backgroundWorkState: "running",
        backgroundWorkTracking: "managed",
        backgroundJobsAvailable: true,
        backgroundJobs: [
          {
            id: "monitor-never-fires", parentTurnId: "blocked-parent", launchType: "monitor",
            registeredAt: now - 50 * 60_000, lastObservedAt: now - 60_000, sourcePresent: true,
          },
          {
            id: "review-subagent", parentTurnId: "blocked-parent", launchType: "agent",
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

    // An older runner: the action is visible but unavailable, and the guidance says why.
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(189));
    await resultBlocked();
    let panel = await openPanel();
    const summary = panel.locator('[data-watchdog-state="continuation_blocked"] .background-delivery-summary');
    await expect(summary).toContainText(
      "Stop Job is unavailable: This machine needs a newer runner for stopping a background job. Update and restart the runner.",
    );
    await expect(summary).toContainText("Ask the session to stop the unfinished job");
    const monitorRow = panel.locator(".background-work-job").filter({ hasText: "Monitor Job" });
    const unavailable = monitorRow.getByRole("button", { name: "Stop Job", exact: true });
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toHaveAccessibleDescription(
      /^Stops Monitor Job \d\. Stop Job is unavailable: This machine needs a newer runner for stopping a background job\./,
    );
    await panel.getByRole("button", { name: /^(Close Panel|Back to Session)$/u }).click();

    // A v190 runner offers Stop Job, but its restart still discards the result (#1779).
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(190));
    await resultBlocked();
    panel = await openPanel("Stop Job…");
    await expect(summary).toContainText("Restarting or stopping the session also ends it, but ends every other job and discards this result.");
    await panel.getByRole("button", { name: /^(Close Panel|Back to Session)$/u }).click();

    // A current runner: Stop Job is offered on the unfinished job only, behind a confirmation, and
    // its restart reports the result to the new conversation instead of discarding it (#1779).
    await page.evaluate((version) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(version), PROTOCOL_VERSION);
    await resultBlocked();
    panel = await openPanel("Stop Job…");
    await expect(summary).toContainText("Use Stop Job on the unfinished job below: only that job ends");
    await expect(summary).toContainText("Stopping the session also ends it but discards this result; restarting the " +
      "session ends every job and reports this result to the new conversation instead.");
    await expect(panel.getByRole("button", { name: "Stop Job", exact: true })).toHaveCount(1);
    const stop = panel.locator(".background-work-job").filter({ hasText: "Monitor Job" })
      .getByRole("button", { name: "Stop Job", exact: true });
    await expect(stop).toBeEnabled();
    await expect(stop).toHaveAccessibleDescription(/^Stops Monitor Job \d\.$/);
    await stop.click();
    const confirm = panel.getByRole("group", { name: /^Confirm Stopping Monitor Job \d$/ });
    await expect(confirm).toContainText("Only this job ends, and it is recorded as killed.");
    const confirmBox = await confirm.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(confirmBox && panelBox && confirmBox.x >= panelBox.x - 0.5 &&
      confirmBox.x + confirmBox.width <= panelBox.x + panelBox.width + 0.5).toBe(true);
    await confirm.getByRole("button", { name: "Confirm Stop" }).click();

    await expect(panel.locator('[data-watchdog-state="continuation_blocked"]')).toHaveCount(0);
    const stopped = panel.locator(".background-work-job").filter({ hasText: "Monitor Job" });
    await expect(stopped).toContainText("Killed");
    // #1849: the killed row names who stopped it, by role, and why.
    await expect(stopped.locator("dl > div").filter({ hasText: "Ended By" }).locator("dd")).toHaveText("Session Owner");
    await expect(stopped.locator("dl > div").filter({ hasText: "Reason" }).locator("dd")).toHaveText("Stop Job Request");
    await expect(panel.locator(".background-work-job").filter({ hasText: "Agent Job" })).not.toContainText("Ended By");
    await expect(panel.locator(".background-work-job").filter({ hasText: "Agent Job" })).toContainText("Result Delivered");
    await expect(panel.getByRole("button", { name: "Stop Job", exact: true })).toHaveCount(0);
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
    await page.evaluate(() => {
      const now = Date.now();
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        status: "idle",
        driver: "claude-code",
        backgroundWorkState: "running",
        backgroundWorkTracking: "managed",
        backgroundJobsAvailable: true,
        backgroundJobs: [
          {
            id: "monitor-never-fires", parentTurnId: "blocked-parent", launchType: "monitor",
            registeredAt: now - 50 * 60_000, lastObservedAt: now - 60_000, sourcePresent: true,
          },
          {
            id: "review-subagent", parentTurnId: "blocked-parent", launchType: "agent",
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
    const status = page.locator(".session-bar .session-status-button");
    await expect(status).toHaveAccessibleName("Session Status: Result Blocked");
    await expectButtonUnclipped(status);
    await status.click();
    const row = page.getByRole("dialog", { name: "Session Status" }).locator(".session-status-row")
      .filter({ hasText: "Result Blocked" });
    await expect(row.locator(".session-status-text")).toHaveText(
      "A background job finished, but its result cannot be returned while another job from the same turn is still running.");
    await row.getByRole("button", { name: "Stop Job…" }).click();

    const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: "Stop Job" }));
    await expect(confirmation).toContainText("Only this job ends, and it is recorded as killed.");
    await expect(confirmation).toContainText("Monitor Job 1");
    await confirmation.getByRole("button", { name: "Stop Job", exact: true }).click();
    await expect(page.getByText("Monitor Job 1 was stopped.")).toBeVisible();
    await expect(status).not.toHaveAccessibleName(/Result Blocked/);
    await expect(status).toBeFocused();
  });
}
