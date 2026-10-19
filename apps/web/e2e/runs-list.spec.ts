import { expect, test, type Page } from "@playwright/test";

/**
 * The Multi-Agent Runs list (#2974; docs/design-system.md §5.2, §12.5, §15.1), measured in a real
 * browser: two-line rows with the badge on line 1 at desktop widths and leading line 2 on phones,
 * Reconnecting over last-known rows, and one New Run while empty.
 */

const LONG_TITLE = "Compare three approaches to indexing session search across machines and projects";

async function open(page: Page, state: string) {
  await page.goto(`/runs-list-e2e.html?state=${state}`);
  await expect(page.getByRole("heading", { level: 1, name: "Multi-Agent Runs", exact: true })).toBeVisible();
}

function row(page: Page, title: string) {
  return page.locator(".surface > .row").filter({ has: page.locator(".row-title", { hasText: title }) });
}

async function rowGeometry(page: Page, title: string) {
  return row(page, title).evaluate((element) => {
    const box = (selector: string) => {
      const found = element.querySelector(selector);
      if (!found) return null;
      const rect = found.getBoundingClientRect();
      return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width };
    };
    const rect = element.getBoundingClientRect();
    return {
      row: { left: rect.left, width: rect.width, height: rect.height },
      title: box(".row-title"),
      badge: box(".run-row-status"),
      meta: box(".run-row-meta"),
      firstMeta: box(".run-row-meta > span"),
      titleTruncated: (() => {
        const title = element.querySelector<HTMLElement>(".row-title")!;
        return title.scrollWidth > title.clientWidth;
      })(),
    };
  });
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("rows are 56px two-line rows with the badge on the title's line", async ({ page }) => {
    await open(page, "loaded");
    await expect(page.locator(".surface > .row")).toHaveCount(4);
    const geometry = await rowGeometry(page, LONG_TITLE);
    expect(geometry.row.height).toBe(56);
    expect(geometry.badge, "a running comparison carries its badge").not.toBeNull();
    expect(geometry.badge!.bottom, "the badge is on line 1").toBeLessThanOrEqual(geometry.meta!.top + 1);
    await expect(row(page, LONG_TITLE).locator(".status")).toHaveText("Running");
    await expect(row(page, "Build and review the settings export screen").locator(".status")).toHaveText("Awaiting Decision");
    await expect(row(page, "Pick a date library for the scheduler").locator(".status")).toHaveCount(0);
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a long title keeps at least 60% of the row and the badge leads line 2", async ({ page }) => {
    await open(page, "loaded");
    const geometry = await rowGeometry(page, LONG_TITLE);
    expect(geometry.titleTruncated, "the fixture's title is long enough to truncate").toBe(true);
    expect(geometry.title!.width / geometry.row.width).toBeGreaterThanOrEqual(0.6);
    expect(geometry.badge!.top, "the badge sits below the title").toBeGreaterThanOrEqual(geometry.title!.bottom - 1);
    expect(geometry.badge!.left, "the badge starts line 2").toBeLessThan(geometry.firstMeta!.left);
    expect(Math.abs(geometry.badge!.left - geometry.title!.left)).toBeLessThanOrEqual(1);
  });

  test("a row without a badge starts its meta under the title", async ({ page }) => {
    await open(page, "loaded");
    const geometry = await rowGeometry(page, "Pick a date library for the scheduler");
    expect(geometry.badge).toBeNull();
    expect(Math.abs(geometry.firstMeta!.left - geometry.title!.left)).toBeLessThanOrEqual(1);
  });
});

test("reconnecting keeps the last-known rows dimmed under Reconnecting…, and they still open", async ({ page }) => {
  await open(page, "reconnecting");
  await expect(page.locator(".page").getByRole("status")).toHaveText("Reconnecting…");
  await expect(page.locator(".is-stale .surface > .row")).toHaveCount(4);
  await row(page, "Pick a date library for the scheduler").click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", JSON.stringify({ name: "run", id: "run-dates" }));
});

test("an empty list offers exactly one New Run, in the empty state", async ({ page }) => {
  await open(page, "empty");
  await expect(page.getByText("No Multi-Agent Runs Yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "New Run", exact: true })).toHaveCount(1);
  await expect(page.locator(".state").getByRole("button", { name: "New Run", exact: true })).toBeVisible();
});
