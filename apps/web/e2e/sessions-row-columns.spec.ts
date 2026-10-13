import { expect, test, type Page } from "@playwright/test";

import { expectGeometry } from "./geometry-margins.js";

/**
 * #2218 (docs/design-system.md §6.3 "Rows use the width"): in the stacked layout, a list 880px or
 * wider gives each two-line row fixed trailing columns on its status line (status, activity, flags,
 * time), with the row actions in a column of their own. The title line carries no transcript
 * excerpt (#3175), so the title takes the whole line. Narrower lists keep #2209's two lines. Rows
 * stay exactly `--row-h-2` either way.
 *
 * The browser is in Chicago and the snoozed row's reminder was saved from Tokyo, so its time cell
 * proves the row reads the same zone as the Snooze dialog.
 */

test.use({ timezoneId: "America/Chicago" });

const FIXTURE = "/command-inbox-projects-e2e.html?scenario=row-columns&fullShell=1&fill=4";
const LONG_TITLE = "Restructure the Sessions Rows So the Title, the Snippet and Every Trailing Column";

async function open(page: Page, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(FIXTURE);
  await expect(page.locator(".inbox-row").first()).toBeVisible();
  await expect(page.locator(".session-detail.preview header.session-preview-bar")).toBeVisible();
}

type RowGeometry = {
  title: string;
  height: number;
  badge: { left: number; right: number; label: string } | null;
  strip: { left: number; right: number } | null;
  time: { left: number; right: number };
  titleBox: { width: number; clipped: boolean };
  copyWidth: number;
  copyText: string;
  hasSnippet: boolean;
  trailDisplay: string;
  rowRight: number;
  paddingRight: number;
};

/** The rows wholly visible over the divider, as the stacked layout shows them. */
async function visibleRows(page: Page): Promise<RowGeometry[]> {
  return page.locator(".inbox-view").evaluate((view) => {
    const line = view.querySelector<HTMLElement>(".inbox-list-pane")!.getBoundingClientRect().bottom;
    return [...view.querySelectorAll<HTMLElement>(".inbox-row")]
      .filter((row) => row.getBoundingClientRect().bottom <= line + 0.5)
      .map((row) => {
        const box = (element: Element | null) => element ? element.getBoundingClientRect() : null;
        const badge = row.querySelector(".row-status");
        const strip = box(row.querySelector(".inbox-row-activity"));
        const time = box(row.querySelector(".inbox-row-time"))!;
        const title = row.querySelector<HTMLElement>(".inbox-row-title")!;
        const style = getComputedStyle(row);
        return {
          title: title.textContent ?? "",
          height: row.getBoundingClientRect().height,
          badge: badge ? { ...pick(badge.getBoundingClientRect()), label: badge.querySelector(".status")?.getAttribute("aria-label") ?? "" } : null,
          strip: strip ? pick(strip) : null,
          time: pick(time),
          titleBox: { width: title.getBoundingClientRect().width, clipped: title.scrollWidth > title.clientWidth + 1 },
          copyWidth: row.querySelector(".inbox-row-copy")!.getBoundingClientRect().width,
          copyText: row.querySelector(".inbox-row-copy")!.textContent ?? "",
          hasSnippet: row.querySelector(".inbox-row-snippet") !== null,
          trailDisplay: getComputedStyle(row.querySelector(".inbox-row-trail")!).display,
          rowRight: row.getBoundingClientRect().right,
          paddingRight: Number.parseFloat(style.paddingRight),
        };
        function pick(rect: DOMRect) { return { left: rect.left, right: rect.right }; }
      });
  });
}

const rowToken = (page: Page) => page.evaluate(() =>
  Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h-2")));

/** Equal to a hundredth of a pixel: the columns are one grid, so they line up exactly or not at all. */
const same = (values: number[]) => new Set(values.map((value) => value.toFixed(2))).size;

test("at 1440×900 six rows of different statuses line up their badges' left edges and their times' right edges", async ({ page }) => {
  await open(page, 1440);
  const rows = await visibleRows(page);
  expect(rows).toHaveLength(6);
  const labels = rows.map((row) => row.badge?.label ?? "No Badge");
  expect(new Set(labels).size, labels.join(" | ")).toBe(6);
  expect(labels).toContain("No Badge");
  for (const row of rows) expect(row.trailDisplay, row.title).toBe("grid");

  const badges = rows.filter((row) => row.badge);
  expect(badges.length).toBeGreaterThanOrEqual(4);
  expect(same(badges.map((row) => row.badge!.left)), "every badge starts at one x").toBe(1);
  expect(same(rows.map((row) => row.time.right)), "every time ends at one x").toBe(1);

  const token = await rowToken(page);
  for (const row of rows) expect(row.height, row.title).toBe(token);
});

test("no row repeats its request or last message after the title, and a long title takes the whole line (#3175)", async ({ page }) => {
  await open(page, 1440);
  const rows = await visibleRows(page);
  const byTitle = (prefix: string) => rows.find((row) => row.title.startsWith(prefix))!;

  for (const row of rows) {
    expect(row.hasSnippet, row.title).toBe(false);
    expect(row.copyText, `${row.title}: the title line holds only the title`).toBe(row.title);
  }
  for (const text of ["Run the Migration Script", "Which Database Should the Migration Target?", "All 42 tests pass"]) {
    expect(rows.some((row) => row.copyText.includes(text)), text).toBe(false);
  }
  // The long title the old 60% cap clipped here now reads whole, inside its line.
  const long = byTitle(LONG_TITLE);
  expect(long.titleBox.clipped, "the long title is no longer clipped at 1440px").toBe(false);
  expectGeometry(long.titleBox.width - long.copyWidth, "the title stays inside its line").toBeLessThanOrEqual(0.5);
});

test("the activity column sits directly after the status column: a Running row's strip is in it, an idle row's is empty", async ({ page }) => {
  await open(page, 1440);
  const rows = await visibleRows(page);
  const statusLeft = rows.find((row) => row.badge)!.badge!.left;
  // The status column is 184px and the columns are 12px apart (--space-3).
  const activityLeft = statusLeft + 184 + 12;

  const running = rows.find((row) => row.badge?.label === "Status: Running")!;
  expect(running.strip).not.toBeNull();
  expect(running.strip!.left).toBeCloseTo(activityLeft, 1);
  expect(running.strip!.right - running.strip!.left).toBe(48);
  for (const row of rows.filter((candidate) => candidate.strip)) {
    expect(row.strip!.left, `${row.title}: strip in the activity column`).toBeCloseTo(activityLeft, 1);
  }

  const idle = rows.find((row) => row.title === "Draft the Quarterly Report")!;
  expect(idle.badge).toBeNull();
  expect(idle.strip).toBeNull();
  // An empty cell keeps its width: the idle row's time still ends with everyone else's.
  expect(idle.time.right).toBeCloseTo(running.time.right, 2);
});

test("hovering a row shows its actions in their own column and leaves the status and the time in view", async ({ page }) => {
  await open(page, 1440);
  const row = page.locator(".inbox-row-shell").filter({ hasText: "Summarize the Release Notes" });
  await row.hover();
  const actions = row.locator(".inbox-row-actions");
  await expect(actions).toBeVisible();
  await expect(actions.getByRole("button", { name: "More Actions" })).toBeVisible();

  const geometry = await row.evaluate((shell) => {
    const rect = (selector: string) => shell.querySelector(selector)!.getBoundingClientRect();
    const actionsBox = rect(".inbox-row-actions");
    const visible = (selector: string) => {
      const box = rect(selector);
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit !== null && shell.querySelector(selector)!.contains(hit);
    };
    return {
      gapAfterTime: actionsBox.left - rect(".inbox-row-time").right,
      gapAfterBadge: actionsBox.left - rect(".row-status").right,
      actionsRight: actionsBox.right,
      rowRight: rect(".inbox-row").right,
      timeVisible: visible(".inbox-row-time"),
      badgeVisible: visible(".row-status .status"),
    };
  });
  expect(geometry.timeVisible).toBe(true);
  expect(geometry.badgeVisible).toBe(true);
  expectGeometry(geometry.gapAfterTime, "the actions start after the time ends").toBeGreaterThanOrEqual(0);
  expectGeometry(geometry.gapAfterBadge, "the actions start after the badge ends").toBeGreaterThanOrEqual(0);
  expectGeometry(geometry.actionsRight - geometry.rowRight, "the actions stay inside the row").toBeLessThanOrEqual(0);
});

test("at 940px the list is under 880px, and rows keep the two-line anatomy with no columns", async ({ page }) => {
  await open(page, 940);
  const listWidth = await page.locator(".inbox-list-pane").evaluate((pane) => pane.getBoundingClientRect().width);
  // 940px is the issue's own example of a list just under the threshold (876px beside the 64px rail),
  // so this bound has no renderer headroom to give; the rows' shape below is what it guards.
  expect(listWidth, "the list is narrower than the wide-row threshold").toBeLessThan(880);
  const rows = await visibleRows(page);
  expect(rows.length).toBeGreaterThanOrEqual(3);
  const token = await rowToken(page);
  for (const row of rows) {
    expect(row.height, row.title).toBe(token);
    expect(row.trailDisplay, row.title).toBe("flex");
    expect(row.hasSnippet, row.title).toBe(false);
  }
});

// 944px is the narrowest window whose list is 880px (beside the 64px rail); 1100px is the issue's.
for (const width of [944, 1100] as const) {
  test(`at ${width}px the columns fit beside the sender, and a long title takes its whole line`, async ({ page }) => {
    await open(page, width);
    const listWidth = await page.locator(".inbox-list-pane").evaluate((pane) => pane.getBoundingClientRect().width);
    expect(listWidth, "the list reaches the wide-row threshold").toBeGreaterThanOrEqual(880);
    const rows = await visibleRows(page);
    const token = await rowToken(page);
    for (const row of rows) {
      expect(row.trailDisplay, row.title).toBe("grid");
      expect(row.height, row.title).toBe(token);
    }
    expect(same(rows.map((row) => row.time.right)), "every time ends at one x").toBe(1);
    expect(same(rows.filter((row) => row.badge).map((row) => row.badge!.left)), "every badge starts at one x").toBe(1);

    const fit = await page.locator(".inbox-row").evaluateAll((nodes) => nodes.map((row) => {
      const sender = row.querySelector(".inbox-row-sender")!.getBoundingClientRect();
      const trail = row.querySelector(".inbox-row-trail")!.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      return { senderToTrail: trail.left - sender.right, trailOverflow: trail.right - (box.right - Number.parseFloat(getComputedStyle(row).paddingRight)) };
    }));
    for (const { senderToTrail, trailOverflow } of fit) {
      expectGeometry(senderToTrail, "the sender ends before the trailing columns begin").toBeGreaterThanOrEqual(0);
      expectGeometry(trailOverflow, "the trailing columns end before the actions column").toBeLessThanOrEqual(0.5);
    }
    const long = rows.find((row) => row.title.startsWith(LONG_TITLE))!;
    expect(long.titleBox.clipped).toBe(true);
    expect(Math.abs(long.titleBox.width - long.copyWidth), "the long title takes its whole line").toBeLessThan(1);
  });
}

test("a snoozed row's return time reads in the browser's zone, as the Snooze dialog does, and fits its column", async ({ page }) => {
  await open(page, 1440);
  await page.getByRole("button", { name: /^Snoozed/ }).first().click();
  const row = page.locator(".inbox-row-shell").filter({ hasText: "Review the Accessibility Audit" });
  await expect(row).toBeVisible();
  const cell = row.locator(".inbox-row-time.snoozed");
  const expected = await page.evaluate(() => {
    const returns = new Date();
    returns.setDate(returns.getDate() + 2);
    returns.setHours(14, 30, 0, 0);
    const format = (timeZone: string) => new Intl.DateTimeFormat(undefined, {
      weekday: "short", hour: "numeric", minute: "2-digit", timeZone,
    }).format(returns);
    return { here: format(Intl.DateTimeFormat().resolvedOptions().timeZone), stored: format("Asia/Tokyo") };
  });
  expect(expected.here).not.toBe(expected.stored);
  await expect(cell).toHaveText(`Snoozed Until ${expected.here}`);
  await expect(cell).toHaveAttribute("title", /2:30\sPM C[DS]T\.$/);

  const fit = await row.evaluate((shell) => {
    const time = shell.querySelector(".inbox-row-time")!.getBoundingClientRect();
    const trail = shell.querySelector(".inbox-row-trail")!;
    const columns = getComputedStyle(trail).gridTemplateColumns.split(" ").map(Number.parseFloat);
    return { width: time.width, column: columns[3]! };
  });
  expectGeometry(fit.width - fit.column, "the return time and its alarm clock fit the time column").toBeLessThanOrEqual(0);
});
