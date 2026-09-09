import { expect, test, type Page } from "@playwright/test";

/**
 * #784: background work is a status like any other, and it has to look like one.
 *
 * Two claims are measured here, at mobile and desktop widths, with a lifecycle status, background
 * work, an attention status and a change status all live at once:
 *
 *  - PLACEMENT. The background-work badge sits in the ordinary status row, on the same line as the
 *    lifecycle badge, and never takes a line of its own — the header is exactly as tall while a job
 *    is running as it is when none is. When the row cannot hold everything, the passive change
 *    status moves into the `+N` disclosure and background work keeps the row.
 *  - GEOMETRY. "Waiting on External Job" is the same height, type size, weight, vertical padding
 *    and dot size as the lifecycle badge beside it — including "Running" itself — in the header,
 *    and the same size as the card's Running pill in the Sessions list.
 *
 * Geometry is read with every measured badge temporarily un-hidden, because the narrow widths are
 * exactly where the row hides one: a size regression on a `display: none` badge would otherwise
 * measure 0 and pass.
 *
 * A `running` session never carries a change status (`sessionMayShowChangeStatus`), so the
 * four-dimension scenario runs on an idle session and Running is measured in its own pass. Both
 * wear the same `.status-badge` class, which is the thing being sized.
 */

const MOBILE_WIDTHS = [320, 390] as const;
const WIDTHS = [...MOBILE_WIDTHS, 768, 1280] as const;
const BACKGROUND_LABEL = "Background Work: Waiting on External Job";

interface BadgeMetrics {
  height: number;
  width: number;
  fontSize: string;
  fontWeight: string;
  paddingTop: string;
  paddingBottom: string;
  dotWidth: number;
  dotHeight: number;
}

async function loadInbox(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&sessionShell=1");
  await page.evaluate(() => {
    // A settled, clean tree is what gives the session its "No Changes" status.
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setGitStatus("session-alpha", {
      hasChanges: false, ahead: 0, stagedCount: 0, modifiedCount: 0,
      untrackedCount: 0, conflictedCount: 0, operation: null,
    });
  });
  await applyStatuses(page, { status: "idle", backgroundWorkState: "running" });
}

async function applyStatuses(page: Page, patch: { status: string; backgroundWorkState: string }) {
  await page.evaluate(({ status, backgroundWorkState }) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      status,
      backgroundWorkState,
      pendingApproval: {
        kind: "permission",
        requestId: "background-approval",
        title: "Review external work",
        options: [],
      },
    } as never);
  }, patch);
}

async function openSession(page: Page) {
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".session-detail > .detail-head")).toBeVisible();
}

/** Header badge geometry and placement, with the row's displaced badges temporarily restored. */
async function readHeader(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".session-detail > .detail-head")!;
    const statuses = header.querySelector<HTMLElement>(".session-header-statuses")!;
    const measured = [...statuses.querySelectorAll<HTMLElement>(
      ".session-status-indicators > .status-badge, " +
      ".change-status-indicators > .status-badge, " +
      ":scope > .background-work-badge",
    )];
    const label = (element: HTMLElement) => element.getAttribute("aria-label") ?? "";
    const box = (element: HTMLElement) => element.getBoundingClientRect();
    const visible = measured.filter((element) => !element.hidden).map((element) => ({
      label: label(element), y: box(element).y, right: box(element).right,
    }));
    const hidden = measured.filter((element) => element.hidden).map(label);

    const wasHidden = measured.map((element) => element.hidden);
    for (const element of measured) element.hidden = false;
    const read = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const dot = box(element.querySelector<HTMLElement>(".status-dot2, .background-work-dot")!);
      return {
        height: box(element).height,
        width: box(element).width,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        dotWidth: dot.width,
        dotHeight: dot.height,
      };
    };
    const backgroundBadge = statuses.querySelector<HTMLElement>(":scope > .background-work-badge");
    const geometry = {
      lifecycle: read(statuses.querySelector<HTMLElement>('[aria-label^="Activity:"]')!),
      background: backgroundBadge ? read(backgroundBadge) : null,
    };
    measured.forEach((element, index) => { element.hidden = wasHidden[index]!; });

    return {
      geometry,
      visible,
      hidden,
      backgroundIsHidden: backgroundBadge?.hidden ?? null,
      backgroundParent: backgroundBadge?.parentElement?.className ?? "",
      backgroundRight: backgroundBadge ? box(backgroundBadge).right : null,
      statusesRight: box(statuses).right,
      statusesWidth: box(statuses).width,
      actionsLeft: box(header.querySelector<HTMLElement>(".detail-actions")!).left,
      headerHeight: box(header).height,
      overflowCount: header.querySelector<HTMLElement>(".session-status-overflow-trigger")
        ?.textContent?.replace("+", "") ?? null,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      // A line of its own for background work is exactly what this used to be.
      dedicatedBackgroundLine: header.querySelectorAll(
        ":scope > .background-work-badge, :scope > .session-header-background-work",
      ).length,
    };
  });
}

function expectMatchingBadges(background: BadgeMetrics, lifecycle: BadgeMetrics) {
  expect(background.fontSize).toBe(lifecycle.fontSize);
  expect(background.fontWeight).toBe(lifecycle.fontWeight);
  expect(background.paddingTop).toBe(lifecycle.paddingTop);
  expect(background.paddingBottom).toBe(lifecycle.paddingBottom);
  expect(background.dotWidth).toBe(lifecycle.dotWidth);
  expect(background.dotHeight).toBe(lifecycle.dotHeight);
  expect(Math.abs(background.height - lifecycle.height)).toBeLessThanOrEqual(0.5);
}

for (const width of WIDTHS) {
  test(`the Session header keeps background work inline beside its lifecycle badge at ${width}px`, async ({ page }) => {
    await loadInbox(page, width);
    await openSession(page);
    const badge = page.locator(".session-header-statuses > .background-work-badge");
    await expect(badge).toHaveCount(1);
    // The accessible name survives whether or not the row had room to paint the badge.
    await expect(page.locator(`.detail-head .sr-only [aria-label="${BACKGROUND_LABEL}"]`))
      .toHaveCount(1);

    const header = await readHeader(page);

    expect(header.backgroundParent).toContain("session-header-statuses");
    expect(header.dedicatedBackgroundLine).toBe(0);
    // Every badge the row still shows sits on ONE line — no wrap, no second row.
    expect(new Set(header.visible.map((status) => Math.round(status.y))).size).toBe(1);
    if (header.geometry.background!.width <= header.statusesWidth + 0.5) {
      // Wherever the badge fits at all it is in the row, not in the disclosure.
      expect(header.visible.map((status) => status.label)).toContain(BACKGROUND_LABEL);
      // Not clipped, not under the actions, and never a horizontal scroller.
      expect(header.backgroundRight!).toBeLessThanOrEqual(header.statusesRight + 0.5);
      expect(header.backgroundRight!).toBeLessThanOrEqual(header.actionsLeft + 0.5);
    } else {
      // 320px cannot hold this label beside the action controls at any badge sizing. The row keeps
      // the statuses that do fit rather than emptying itself for one that never will, and the
      // badge stays reachable in the disclosure and in its live region.
      expect(header.backgroundIsHidden).toBe(true);
      expect(header.visible.length).toBeGreaterThan(0);
    }
    expect(header.pageOverflows).toBe(false);

    expectMatchingBadges(header.geometry.background!, header.geometry.lifecycle);

    // The same parity against Running itself, which an idle session cannot show at the same time as
    // a change status.
    await applyStatuses(page, { status: "running", backgroundWorkState: "running" });
    await expect(page.locator('.session-header-statuses [aria-label="Activity: Running"]'))
      .toHaveCount(1);
    const running = await readHeader(page);
    expectMatchingBadges(running.geometry.background!, running.geometry.lifecycle);

    // The header is no taller for carrying background work than it is without it.
    await applyStatuses(page, { status: "running", backgroundWorkState: "resumed" });
    await expect(badge).toHaveCount(0);
    const withoutBackgroundWork = await page.locator(".session-detail > .detail-head")
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(running.headerHeight).toBeLessThanOrEqual(withoutBackgroundWork + 0.5);
  });
}

for (const width of MOBILE_WIDTHS) {
  test(`a full status row sheds passive statuses before background work at ${width}px`, async ({ page }) => {
    await loadInbox(page, width);
    await openSession(page);
    const trigger = page.locator(".session-status-overflow-trigger");
    await expect(trigger).toBeVisible();

    const header = await readHeader(page);
    // The narrow widths actually exercise the path: something had to leave the row.
    expect(header.hidden.length).toBeGreaterThan(0);
    expect(header.overflowCount).toBe(String(header.hidden.length));
    // The passive change status is displaced first, and background work outranks it wherever the
    // row can hold the badge at all.
    expect(header.hidden).toContain("Changes: No Changes");
    expect(header.visible.some((status) => status.label.startsWith("Changes:"))).toBe(false);
    if (header.geometry.background!.width <= header.statusesWidth + 0.5) {
      expect(header.backgroundIsHidden).toBe(false);
    }

    // The disclosure carries the whole status set, displaced or not.
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Session Statuses" });
    await expect(dialog.locator(".background-work-badge")).toHaveAccessibleName(BACKGROUND_LABEL);
    for (const displaced of header.hidden) {
      await expect(dialog.locator(`[aria-label="${displaced}"]`)).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });
}

for (const width of [390, 1280] as const) {
  test(`a Sessions list card sizes background work like its Running pill at ${width}px`, async ({ page }) => {
    await loadInbox(page, width);
    await applyStatuses(page, { status: "running", backgroundWorkState: "running" });
    const row = page.locator(".inbox-row").filter({ hasText: "Alpha Session" });
    await expect(row.locator(".inbox-status-pill.running")).toBeVisible();
    await expect(row.locator(".background-work-badge")).toBeVisible();

    const card = await row.evaluate((element) => {
      const read = (node: HTMLElement) => {
        const style = getComputedStyle(node);
        return {
          height: node.getBoundingClientRect().height,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
        };
      };
      return {
        pill: read(element.querySelector<HTMLElement>(".inbox-status-pill.running")!),
        badge: read(element.querySelector<HTMLElement>(".background-work-badge")!),
        cardHeight: element.getBoundingClientRect().height,
      };
    });

    expect(card.badge.fontSize).toBe(card.pill.fontSize);
    expect(card.badge.fontWeight).toBe(card.pill.fontWeight);
    expect(Math.abs(card.badge.height - card.pill.height)).toBeLessThanOrEqual(0.5);

    // #782's contract still holds: sizing the badge did not grow the card.
    await applyStatuses(page, { status: "running", backgroundWorkState: "resumed" });
    await expect(row.locator(".background-work-badge")).toHaveCount(0);
    const withoutBackgroundWork = await row.evaluate((element) =>
      element.getBoundingClientRect().height);
    expect(Math.abs(card.cardHeight - withoutBackgroundWork)).toBeLessThanOrEqual(0.5);
  });
}

/**
 * The row is measured by applying a candidate set and reading geometry back, so every badge is
 * briefly `display: none` — including the one the row is about to keep. A `display: none` element
 * cannot hold focus, so without care a resize, a font load or a live status update silently drops
 * keyboard focus to <body> mid-measurement.
 */
test("remeasuring the row keeps focus on the badge it keeps", async ({ page }) => {
  await loadInbox(page, 390);
  await openSession(page);
  const badge = page.locator(".session-header-statuses > .background-work-badge");
  await expect(badge).toBeVisible();
  await badge.focus();
  await expect(badge).toBeFocused();

  // A resize re-measures the row. The badge survives this one, and so must its focus.
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(badge).toBeVisible();
  await expect(badge).toBeFocused();
});

test("a badge that loses the row hands focus to the disclosure that now holds it", async ({ page }) => {
  await loadInbox(page, 390);
  await openSession(page);
  const badge = page.locator(".session-header-statuses > .background-work-badge");
  await expect(badge).toBeVisible();
  await badge.focus();
  await expect(badge).toBeFocused();

  // 320px cannot hold the badge, so it moves into the disclosure — and focus goes with it rather
  // than falling to <body>, where the next Tab would restart from the top of the document.
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(badge).toBeHidden();
  await expect(page.locator(".session-status-overflow-trigger")).toBeFocused();
});
