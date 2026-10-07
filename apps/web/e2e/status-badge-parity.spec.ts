import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #784 and #2182: background work is a status like any other, and it has to look like one.
 *
 * The Session bar shows ONE status, chosen by `sessionStatusSummary()` rather than by how much room
 * a row has, so what it shows is the same at every width:
 *
 *  - PLACEMENT. One status control sits on the bar's line at every width, and on a phone it leads
 *    the second line beside Share and More Actions without pushing them. Attention comes first;
 *    with nothing needing the person, running background work leads while the session awaits its
 *    next prompt. The header is exactly as tall while a job is running as it is when none is.
 *  - GEOMETRY. The background-work badge is the same height, type size, weight, vertical padding
 *    and dot size as any other badge, in the bar and in the Session Status popover, and the same
 *    size as the card's Running pill in the Sessions list.
 *
 * Every one is the same `.status` recipe (docs/design-system.md §11.1), which is the thing sized.
 */

const MOBILE_WIDTHS = [320, 360, 390] as const;
const WIDTHS = [...MOBILE_WIDTHS, 768, 1280] as const;

interface BadgeMetrics {
  height: number;
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
  await applyStatuses(page, { status: "idle", backgroundWorkState: "running" });
}

async function applyStatuses(page: Page, patch: { status: string; backgroundWorkState: string; approval?: boolean }) {
  await page.evaluate(({ status, backgroundWorkState, approval }) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      status,
      backgroundWorkState,
      pendingApproval: approval === false ? null : {
        kind: "permission",
        requestId: "background-approval",
        title: "Review external work",
        options: [],
      },
    } as never);
  }, patch);
}

/**
 * Requests the Orchestrator handles beside the approval: they are counted only in the Requests
 * panel (#2206), so they must never take the bar's one badge or count toward its "+N" (#2182).
 */
async function addOrchestratorAction(page: Page) {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      orchestratorCampaign: { pendingRequests: { human: 0, orchestrator: 1 } },
    } as never);
  });
}

async function openSession(page: Page) {
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".session-bar")).toBeVisible();
}

function badgeMetrics(badge: Locator): Promise<BadgeMetrics> {
  return badge.evaluate((element) => {
    const style = getComputedStyle(element);
    // The dot is the recipe's `::before`, so it is read from the pseudo-element's computed box.
    const dot = getComputedStyle(element, "::before");
    return {
      height: element.getBoundingClientRect().height,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
      dotWidth: parseFloat(dot.width),
      dotHeight: parseFloat(dot.height),
    };
  });
}

/** The bar's one status control, its badge, and where it sits beside the actions. */
async function readHeader(page: Page) {
  const badge = await badgeMetrics(page.locator(".session-bar .session-status-button .status"));
  const layout = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".session-bar")!;
    const control = header.querySelector<HTMLElement>(".session-status-button")!;
    const box = (element: Element) => element.getBoundingClientRect();
    const share = header.querySelector<HTMLElement>('[aria-label="Share"]')!;
    return {
      name: control.getAttribute("aria-label"),
      badges: header.querySelectorAll(".status").length,
      controlRight: box(control).right,
      controlCenter: box(control).y + box(control).height / 2,
      shareCenter: box(share).y + box(share).height / 2,
      actionsLeft: box(header.querySelector(".detail-actions")!).left,
      headerHeight: box(header).height,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  return { ...layout, badge };
}

function expectMatchingBadges(background: BadgeMetrics, other: BadgeMetrics) {
  expect(background.fontSize).toBe(other.fontSize);
  expect(background.fontWeight).toBe(other.fontWeight);
  expect(background.paddingTop).toBe(other.paddingTop);
  expect(background.paddingBottom).toBe(other.paddingBottom);
  expect(background.dotWidth).toBe(other.dotWidth);
  expect(background.dotHeight).toBe(other.dotHeight);
  expect(Math.abs(background.height - other.height)).toBeLessThanOrEqual(0.5);
}

for (const width of WIDTHS) {
  test(`the Session bar shows one status, attention first, and sizes background work like it at ${width}px`, async ({ page }) => {
    await loadInbox(page, width);
    await openSession(page);
    const control = page.locator(".session-bar .session-status-button");
    // The approval needs the person, so it is the badge at every width; background work waits in the
    // popover, and its live region still announces it.
    await expect(control).toHaveAccessibleName("Session Status: Approval Required");
    await expect(page.locator('.session-bar [data-live="background-work"]'))
      .toHaveText("Background Work: Waiting on External Job");
    const header = await readHeader(page);
    expect(header.badges).toBe(1);
    expect(header.controlRight).toBeLessThanOrEqual(header.actionsLeft + 0.5);
    expect(Math.abs(header.controlCenter - header.shareCenter)).toBeLessThanOrEqual(1);
    expect(header.pageOverflows).toBe(false);
    // The retired 10px `--text-2xs` is gone: every header badge is the recipe's 11px (§2.3, §11.1).
    expect(header.badge.fontSize).toBe("11px");

    await control.click();
    const dialog = page.getByRole("dialog", { name: "Session Status" });
    const backgroundRow = dialog.locator(".session-status-row").filter({ hasText: "Waiting on External Job" });
    const popoverBackground = await badgeMetrics(backgroundRow.locator(".status"));
    expectMatchingBadges(popoverBackground, header.badge);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // With the approval answered, running background work is the badge while the session awaits its
    // next prompt (#784), and it measures like Running itself.
    await applyStatuses(page, { status: "idle", backgroundWorkState: "running", approval: false });
    await expect(control).toHaveAccessibleName("Session Status: Waiting on External Job");
    const background = await readHeader(page);
    await applyStatuses(page, { status: "running", backgroundWorkState: "resumed", approval: false });
    await expect(control).toHaveAccessibleName("Session Status: Running");
    const running = await readHeader(page);
    expectMatchingBadges(background.badge, running.badge);
    // The header is no taller for carrying background work than it is without it.
    expect(background.headerHeight).toBeLessThanOrEqual(running.headerHeight + 0.5);
  });
}

for (const width of MOBILE_WIDTHS) {
  test(`a phone shows attention at first paint and never pushes Share or More Actions at ${width}px`, async ({ page }) => {
    await loadInbox(page, width);
    await addOrchestratorAction(page);
    await openSession(page);
    const header = page.locator(".session-bar");
    const control = header.locator(".session-status-button");
    await expect(control.locator(".status")).toHaveText("Approval Required");
    await expect(header.getByText("Detached Work")).toHaveCount(0);
    for (const name of ["Share", "More Actions"]) {
      const action = header.getByRole("button", { name, exact: true });
      await expect(action).toBeVisible();
      const hit = await action.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const painted = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return painted === element || (painted !== null && element.contains(painted));
      });
      expect(hit, `${name} stays hittable`).toBe(true);
    }
  });
}

for (const width of [390, 1280] as const) {
  test(`a Sessions list row shows one status whatever its background work, at one height, at ${width}px`, async ({ page }) => {
    await loadInbox(page, width);
    const row = page.locator(".inbox-row").filter({ hasText: "Alpha Session" });
    const read = () => row.evaluate((element) => {
      const badges = [...element.querySelectorAll<HTMLElement>(".status")];
      const style = badges[0] ? getComputedStyle(badges[0]) : null;
      return {
        names: badges.map((badge) => badge.getAttribute("aria-label")),
        height: badges[0]?.getBoundingClientRect().height ?? 0,
        fontSize: style?.fontSize,
        fontWeight: style?.fontWeight,
        rowHeight: element.getBoundingClientRect().height,
      };
    });
    // #2209: a running session's background work is not a second badge; the bar's popover lists it.
    await applyStatuses(page, { status: "running", backgroundWorkState: "running", approval: false });
    await expect(row.locator(".status")).toHaveCount(1);
    const running = await read();
    // The fixture's session has been silent for a while, so its one badge may also say it is stalled.
    expect(running.names).toHaveLength(1);
    expect(running.names[0]).toMatch(/^Status: (Stalled, )?Running$/);
    // While the session awaits its next prompt, the work is the one status, drawn like Running.
    await applyStatuses(page, { status: "idle", backgroundWorkState: "running", approval: false });
    await expect(row.getByLabel("Status: Waiting on External Job")).toBeVisible();
    const waiting = await read();
    expect(waiting.names).toEqual(["Status: Waiting on External Job"]);
    expect(waiting.fontSize).toBe(running.fontSize);
    expect(waiting.fontWeight).toBe(running.fontWeight);
    expect(Math.abs(waiting.height - running.height)).toBeLessThanOrEqual(0.5);
    // And the row is the same height either way, or with no status at all.
    await applyStatuses(page, { status: "idle", backgroundWorkState: "resumed", approval: false });
    await expect(row.locator(".status")).toHaveCount(0);
    const idle = await read();
    expect(Math.abs(waiting.rowHeight - running.rowHeight)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(idle.rowHeight - running.rowHeight)).toBeLessThanOrEqual(0.5);
  });
}

test("a live status change and a resize keep focus on the status control", async ({ page }) => {
  await loadInbox(page, 390);
  await openSession(page);
  const control = page.locator(".session-bar .session-status-button");
  await control.focus();
  await expect(control).toBeFocused();
  // The control is one element whatever it shows, so nothing is measured away from under focus.
  await applyStatuses(page, { status: "idle", backgroundWorkState: "running", approval: false });
  await expect(control).toHaveAccessibleName("Session Status: Waiting on External Job");
  await expect(control).toBeFocused();
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(control).toBeFocused();
});
