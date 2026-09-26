import { expect, test, type Locator } from "@playwright/test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";

async function expectUnclipped(badge: Locator) {
  await expect(badge).toBeVisible();
  expect(await badge.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    const visibleLabels = [...element.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')]
      .filter((candidate) => candidate.getClientRects().length > 0);
    range.selectNodeContents(visibleLabels[visibleLabels.length - 1]!);
    const text = range.getBoundingClientRect();
    let contained = text.left >= box.left && text.right <= box.right + 0.5;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (/hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowX)) {
        const bounds = parent.getBoundingClientRect();
        contained &&= box.left >= bounds.left - 0.5 && box.right <= bounds.right + 0.5;
      }
    }
    return contained && box.right <= innerWidth && box.left >= 0;
  })).toBe(true);
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
    await expect(row.getByLabel("Activity: Awaiting Prompt")).toBeVisible();
    await expect(row.getByLabel("Attention: Approval Required")).toBeVisible();
    await expectUnclipped(row.locator(".background-work-badge"));
    await expect(row).toHaveAccessibleName(/Waiting on External Job/);
    for (const state of ["continuation_pending", "orphaned", "resumed", "running"] as const) {
      await page.evaluate((backgroundWorkState) => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { backgroundWorkState });
      }, state);
      if (state === "resumed") await expect(row.locator(".background-work-badge")).toHaveCount(0);
      else await expectUnclipped(row.locator(".background-work-badge"));
    }
    await row.click();
    const expand = page.getByRole("button", { name: "Expand Session" });
    if (await expand.isVisible()) await expand.click();
    const header = page.locator(".session-detail > .detail-head");
    // #784: one home at every width — the ordinary status row.
    const badge = header.locator(".session-header-statuses > .background-work-badge");
    for (const [state, label] of [
      ["running", "Waiting on External Job"],
      ["continuation_pending", "Continuation Pending"],
      ["orphaned", "Orphaned"],
    ] as const) {
      await page.evaluate((backgroundWorkState) => {
        window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { backgroundWorkState });
      }, state);
      // #825: every active background-work state has a one-word phone label, so the authoritative
      // badge keeps the ordinary row even at the 320px floor. It is never clipped or given a line
      // of its own, and its live region retains the complete descriptive name.
      await expect(header.locator(`.sr-only [aria-label="Background Work: ${label}"]`)).toHaveCount(1);
      const statusOverflow = header.locator(".session-status-overflow-trigger");
      if (width === 390) await expect(statusOverflow).toBeVisible();
      await expect(badge).toHaveAccessibleName(`Background Work: ${label}`);
      await expectUnclipped(badge);
      await badge.focus();
      await badge.press("Enter");
      // Wait through deferred focus restoration, not merely the click's synchronous render.
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      await expect(badge).toBeFocused();
      await expect(page.getByRole("complementary", { name: "Background Work", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Close Panel", exact: true }).click();
      await badge.click();
      await expect(badge).toBeFocused();
      await expect(page.getByRole("complementary", { name: "Background Work", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Close Panel", exact: true }).click();
      // Background work shares the lifecycle badge's line instead of taking one above it.
      expect(await badge.evaluate((element) => {
        const statuses = document.querySelector(".session-header-statuses")!;
        const lifecycle = statuses.querySelector('[aria-label^="Activity:"]') as HTMLElement | null;
        if (!statuses.contains(element)) return false;
        return !lifecycle || lifecycle.hidden || Math.abs(
          lifecycle.getBoundingClientRect().y - element.getBoundingClientRect().y) <= 0.5;
      })).toBe(true);
      await expect(header.locator('[aria-label="Activity: Awaiting Prompt"]')).toHaveCount(1);
      await expect(header.locator('[aria-label="Changes: No Changes"]')).toHaveCount(1);
      await expect(header.getByRole("button", { name: "Share", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const overflow = header.locator(".session-status-overflow-trigger");
      if (await overflow.isVisible()) {
        await overflow.click();
        const dialog = page.getByRole("dialog", { name: "Session Statuses" });
        await expect(dialog.getByLabel("Attention: Approval Required")).toBeVisible();
        await expect(dialog.getByLabel("Changes: No Changes")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(overflow).toBeFocused();
        await overflow.click();
        await dialog.locator(".background-work-badge").press("Enter");
        await expect(dialog).toHaveCount(0);
        // The activated popover copy unmounts; restore to its surviving trigger.
        await expect(overflow).toBeFocused();
        await expect(page.getByRole("complementary", { name: "Background Work", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Close Panel", exact: true }).click();
      }
    }
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
        backgroundWorkState: "resumed", pendingApproval: null,
      });
    });
    await expect(badge).toHaveCount(0);
    await expect(header.locator(".background-work-badge")).toHaveCount(0);
  });
}

for (const width of [320, 1280]) {
  test(`delivery watchdogs stay compact and open their plain-language detail at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Expand Session" });
    if (await expand.isVisible()) await expand.click();
    const header = page.locator(".session-detail > .detail-head");
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
      let badge = header.locator(":scope > .session-header-statuses > .background-work-badge");
      if (!await badge.isVisible()) {
        await header.locator(".session-status-overflow-trigger").click();
        badge = page.getByRole("dialog", { name: "Session Statuses" }).locator(".background-work-badge");
      }
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText(label);
      await expect(badge).toHaveAccessibleName(`Background Work: ${label}. ${description}`);
      await expect(badge).toHaveAttribute("title", description);
      expect(await badge.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const surface = element.parentElement!.getBoundingClientRect();
        return getComputedStyle(element).whiteSpace === "nowrap" &&
          element.scrollWidth <= element.clientWidth + 0.5 &&
          box.left >= surface.left - 0.5 && box.right <= surface.right + 0.5;
      })).toBe(true);

      if (width === 1280 && watchdogState === "terminal_without_continuation") {
        const pinned = page.getByRole("complementary", { name: "Pinned Summary" });
        if (!await pinned.isVisible()) await page.getByRole("button", { name: "Toggle Pinned Summary" }).click();
        const pinnedBadge = pinned.locator(".background-work-badge");
        await expect(pinnedBadge).toHaveText(label);
        await expect(pinnedBadge).toHaveAccessibleName(`Background Work: ${label}. ${description}`);
        await pinnedBadge.click();
        const pinnedPanel = page.getByRole("complementary", { name: "Background Work", exact: true });
        await expect(pinnedPanel.locator('[data-watchdog-highlighted="true"]')).toBeVisible();
        await pinnedPanel.getByRole("button", { name: "Close Panel", exact: true }).click();
      }

      await badge.click();
      const panel = page.getByRole("complementary", { name: "Background Work", exact: true });
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
      await panel.getByRole("button", { name: "Close Panel", exact: true }).click();
    }
  });
}

for (const width of [320, 1280]) {
  test(`Result Blocked offers Stop Job for the unfinished job and shows it unavailable on older runners at ${width}px (#1780)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Expand Session" });
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
    const openPanel = async () => {
      const header = page.locator(".session-detail > .detail-head");
      const name = /^Background Work: Result Blocked\./;
      let badge = header.locator(":scope > .session-header-statuses").getByRole("button", { name });
      if (!await badge.isVisible()) {
        await header.locator(".session-status-overflow-trigger").click();
        badge = page.getByRole("dialog", { name: "Session Statuses" }).getByRole("button", { name });
      }
      await expect(badge).toHaveText("Result Blocked");
      await badge.click();
      const panel = page.getByRole("complementary", { name: "Background Work", exact: true });
      await expect(panel).toBeVisible();
      return panel;
    };

    // An older runner: the action is visible but unavailable, and the guidance says why.
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(189));
    await resultBlocked();
    let panel = await openPanel();
    const summary = panel.locator('[data-watchdog-state="continuation_blocked"] .background-delivery-summary');
    await expect(summary).toContainText("Stop Job is unavailable: Runner protocol is v189; Stop Job requires protocol v190.");
    await expect(summary).toContainText("Ask the session to stop the unfinished job");
    const monitorRow = panel.locator(".background-work-job").filter({ hasText: "Monitor Job" });
    const unavailable = monitorRow.getByRole("button", { name: "Stop Job", exact: true });
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toHaveAccessibleDescription(/^Stops Monitor Job \d\. Stop Job is unavailable: Runner protocol is v189/);
    await panel.getByRole("button", { name: "Close Panel", exact: true }).click();

    // A v190 runner offers Stop Job, but its restart still discards the result (#1779).
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(190));
    await resultBlocked();
    panel = await openPanel();
    await expect(summary).toContainText("Restarting or stopping the session also ends it, but ends every other job and discards this result.");
    await panel.getByRole("button", { name: "Close Panel", exact: true }).click();

    // A current runner: Stop Job is offered on the unfinished job only, behind a confirmation, and
    // its restart reports the result to the new conversation instead of discarding it (#1779).
    await page.evaluate((version) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(version), PROTOCOL_VERSION);
    await resultBlocked();
    panel = await openPanel();
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
    await expect(panel.locator(".background-work-job").filter({ hasText: "Monitor Job" })).toContainText("Killed");
    await expect(panel.locator(".background-work-job").filter({ hasText: "Agent Job" })).toContainText("Result Delivered");
    await expect(panel.getByRole("button", { name: "Stop Job", exact: true })).toHaveCount(0);
  });
}
