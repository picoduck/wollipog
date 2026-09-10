import { expect, test, type Locator } from "@playwright/test";

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
      // #784: the badge now competes for the ordinary status row. It wins that row wherever it
      // fits in it; where the label cannot fit beside the action controls at all — a 320px phone
      // showing Fork, Share, More Actions and the disclosure — it is disclosed rather than clipped,
      // wrapped, or given a line of its own. Its live region announces it either way.
      const badgeFits = await badge.evaluate((element) => {
        const statuses = element.closest<HTMLElement>(".session-header-statuses")!;
        const wasHidden = element.hidden;
        element.hidden = false;
        const width = element.getBoundingClientRect().width;
        element.hidden = wasHidden;
        return width <= statuses.getBoundingClientRect().width + 0.5;
      });
      await expect(header.locator(`.sr-only [aria-label="Background Work: ${label}"]`)).toHaveCount(1);
      const statusOverflow = header.locator(".session-status-overflow-trigger");
      if (width === 390) await expect(statusOverflow).toBeVisible();
      if (badgeFits) {
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
      } else {
        await expect(badge).toBeHidden();
        await expect(statusOverflow).toBeVisible();
      }
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
