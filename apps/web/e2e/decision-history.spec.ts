import { expect, test, type Page } from "@playwright/test";

/** Decision History (#2213) in the real right panel over the fixture audit in decision-history-main. */

const evidence = process.env.DECISION_HISTORY_EVIDENCE;

async function capture(page: Page, name: string) {
  if (!evidence) return;
  // Let the disclosure chevron and the busy spinner's first frame settle before the capture.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${evidence}/${name}.png` });
}

const rows = (page: Page) => page.locator(".decision-history details.tl-decision");
const outcomes = (page: Page) => page.locator(".decision-history .tl-decision-outcome").allTextContents();

async function filterTo(page: Page, label: "All" | "You" | "Policies") {
  await page.getByRole("radiogroup", { name: "Filter Decisions" }).getByRole("radio", { name: label }).click();
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`Decision History at 1440px, ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("lists every decision newest first under day headers, and filters to You and Policies", async ({ page }) => {
      await page.goto(`/decision-history-e2e.html?theme=${theme}`);
      await expect(page.locator(".rpanel-switcher-name")).toHaveText("Decision History");
      await expect(rows(page)).toHaveCount(10);
      expect(await outcomes(page)).toEqual([
        "Blocked", "Blocked", "Allowed", "Answered", "Rejected", "Allowed", "Allowed", "Allowed", "Dismissed", "Allowed",
      ]);
      await expect(page.locator(".decision-history-day-label")).toHaveText(["Today", "Yesterday"]);
      for (const height of await rows(page).locator("summary").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))) {
        expect(height).toBeGreaterThanOrEqual(32);
      }
      await capture(page, `all-1440-${theme}`);

      await filterTo(page, "You");
      expect(await outcomes(page)).toEqual(["Allowed", "Answered", "Rejected", "Allowed", "Dismissed", "Allowed"]);
      await capture(page, `you-1440-${theme}`);
      await filterTo(page, "Policies");
      expect(await outcomes(page)).toEqual(["Blocked", "Blocked", "Allowed", "Allowed"]);
      await capture(page, `policies-1440-${theme}`);
    });

    test("an open row shows its facts, Show in Transcript and Copy Audit ID", async ({ page }) => {
      await page.goto(`/decision-history-e2e.html?theme=${theme}`);
      const allowedBash = page.locator('details[data-audit-id="allow-bash"]');
      await allowedBash.locator("summary").click();
      const show = allowedBash.getByRole("button", { name: "Show in Transcript" });
      await expect(show).toBeVisible();
      await expect(allowedBash.getByRole("button", { name: "Copy Audit ID" })).toBeVisible();
      await show.click();
      expect(await page.evaluate(() => window.__WOLLIPOG_DECISION_HISTORY_E2E__.revealed())).toEqual([41]);
      await capture(page, `open-row-1440-${theme}`);

      await allowedBash.locator("summary").click();
      await page.locator('details[data-audit-id="reject-write"] summary').click();
      const unavailable = page.locator('details[data-audit-id="reject-write"]').getByRole("button", { name: "Show in Transcript" });
      await expect(unavailable).toHaveAttribute("aria-disabled", "true");
      await expect(unavailable).toHaveAccessibleDescription("Not in the loaded transcript.");
      await expect(page.locator('details[data-audit-id="reject-write"]')).toHaveAttribute("open", "");
      await capture(page, `open-row-unavailable-1440-${theme}`);
    });

    test("Load Older Decisions sits at the list's left edge and keeps its label while loading", async ({ page }) => {
      await page.goto(`/decision-history-e2e.html?theme=${theme}`);
      const more = page.getByRole("button", { name: "Load Older Decisions" });
      await more.scrollIntoViewIfNeeded();
      const listLeft = await page.locator(".decision-history").evaluate((node) => node.getBoundingClientRect().left);
      const before = await more.boundingBox();
      expect(before!.x).toBeCloseTo(listLeft, 0);
      expect(before!.width).toBeLessThan(300);
      await capture(page, `load-older-1440-${theme}`);
      await more.click();
      await expect(more).toHaveAttribute("aria-busy", "true");
      await expect(more).toHaveText("Load Older Decisions");
      await capture(page, `load-older-busy-1440-${theme}`);
      await expect(rows(page)).toHaveCount(12);
      await expect(more).toHaveCount(0);
    });

    test("the empty, loading and error states", async ({ page }) => {
      await page.goto(`/decision-history-e2e.html?theme=${theme}&scenario=empty&open=launcher`);
      const launcherRow = page.locator('.session-tools [data-tool="decisions"]');
      await expect(launcherRow).toBeEnabled();
      await capture(page, `launcher-1440-${theme}`);
      await launcherRow.click();
      await expect(page.getByText("No Decisions Yet")).toBeVisible();
      await expect(page.getByText("Decisions you and your approval policies make in this session appear here.")).toBeVisible();
      await capture(page, `empty-1440-${theme}`);

      await page.goto(`/decision-history-e2e.html?theme=${theme}&scenario=loading`);
      await expect(page.locator(".decision-history-skeleton .skeleton-row")).toHaveCount(4);
      for (const height of await page.locator(".decision-history-skeleton .skeleton-row").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))) {
        expect(height).toBe(32);
      }
      await capture(page, `loading-1440-${theme}`);

      await page.goto(`/decision-history-e2e.html?theme=${theme}&scenario=error`);
      const notice = page.getByRole("alert");
      await expect(notice).toContainText("Couldn't Load Decisions");
      await capture(page, `error-1440-${theme}`);
      await notice.getByRole("button", { name: "Retry" }).click();
      await expect(rows(page)).toHaveCount(10);
    });
  });

  test.describe(`Decision History at 390px on touch, ${theme}`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("rows are 44px targets and the request title is never squeezed out by who decided", async ({ page }) => {
      await page.goto(`/decision-history-e2e.html?theme=${theme}`);
      await expect(rows(page)).toHaveCount(10);
      for (const height of await rows(page).locator("summary").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))) {
        expect(height).toBeGreaterThanOrEqual(44);
      }
      // The longest title keeps the room the outcome and time leave; who decided gives way first.
      const longTitle = page.locator('details[data-audit-id="reject-write"] .tl-decision-title');
      const titleWidth = await longTitle.evaluate((node) => node.getBoundingClientRect().width);
      expect(titleWidth).toBeGreaterThan(120);
      const policyRow = page.locator('details[data-audit-id="allow-read"]');
      await expect(policyRow.locator(".tl-decision-title")).toHaveText("Read");
      expect(await policyRow.locator(".tl-decision-title").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await capture(page, `all-390-${theme}`);

      await filterTo(page, "You");
      await capture(page, `you-390-${theme}`);
      await filterTo(page, "Policies");
      await capture(page, `policies-390-${theme}`);

      await filterTo(page, "All");
      await page.locator('details[data-audit-id="allow-bash"] summary').click();
      await capture(page, `open-row-390-${theme}`);
      const more = page.getByRole("button", { name: "Load Older Decisions" });
      await more.scrollIntoViewIfNeeded();
      await capture(page, `load-older-390-${theme}`);
    });

    test("the empty, loading and error states on a phone", async ({ page }) => {
      await page.goto(`/decision-history-e2e.html?theme=${theme}&scenario=empty`);
      await expect(page.getByText("No Decisions Yet")).toBeVisible();
      await capture(page, `empty-390-${theme}`);
      await page.goto(`/decision-history-e2e.html?theme=${theme}&scenario=loading`);
      await expect(page.locator(".decision-history-skeleton .skeleton-row").first()).toBeVisible();
      await capture(page, `loading-390-${theme}`);
      await page.goto(`/decision-history-e2e.html?theme=${theme}&scenario=error`);
      await expect(page.getByRole("alert")).toContainText("Couldn't Load Decisions");
      await capture(page, `error-390-${theme}`);
    });
  });
}

test("Show in Transcript scrolls the real transcript to the request's row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/decision-history-session-e2e.html");
  const historyRow = page.locator('.decision-history details[data-audit-id="audit-early-deploy"]');
  await expect(historyRow.locator(".tl-decision-outcome")).toHaveText("Allowed");
  const transcriptSummary = page.locator(".detail-scroll summary", { hasText: "Run ./scripts/deploy.sh staging" });
  await expect(transcriptSummary).not.toBeInViewport();
  await historyRow.locator("summary").click();
  await historyRow.getByRole("button", { name: "Show in Transcript" }).click();
  await expect(transcriptSummary).toBeInViewport();
  await capture(page, "show-in-transcript-1280-dark");
});
