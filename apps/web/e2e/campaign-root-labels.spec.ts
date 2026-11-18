import { expect, test, type Locator, type Page } from "@playwright/test";
import { waitForSessionPreview } from "./session-readiness.js";

/**
 * #4369: an at-rest Full Control root reads the same on its Sessions row, its Board card and its
 * session header. Campaign Active, Campaign Complete and Complete, Needs Cleanup take the place of
 * Awaiting Prompt; a Completed root keeps Completed with the campaign state beside it; a root whose
 * child still works keeps Children Working beside its campaign state. Campaign Stuck, Waiting for You
 * and a Custom campaign keep Awaiting Prompt.
 *
 * CAPTURE_CAMPAIGN_LABELS=after (or =before, against the base branch's web sources, which skips the
 * assertions) writes the UI evidence to .evidence/4369/. The clock is fixed so captures repeat.
 */

const CAPTURE = process.env.CAPTURE_CAMPAIGN_LABELS;
const ASSERT = CAPTURE !== "before";
const NOW = new Date("2026-11-17T12:00:00Z");

const ACTIVE = "Campaign Active: Children Working";
const COMPLETE = "Campaign Complete: Every Issue Merged";
const CLEANUP = "Campaign Delivered: Merged Branch Left";
const COMPLETED = "Campaign Root Completed: Every Issue Merged";
const CHILDREN = "Campaign Active: Child Still Working";
const STUCK = "Campaign Stuck: Unmerged PR, Nothing Running";
const WAITING = "Campaign Waiting: Merge Approval for You";
const CUSTOM = "Custom Campaign: Result to Review";

/** Each root's badges, in order, as accessible names: the lifecycle first, then its secondary. */
const LABELS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [ACTIVE, ["Status: Campaign Active"]],
  [COMPLETE, ["Status: Campaign Complete"]],
  [CLEANUP, ["Status: Complete, Needs Cleanup"]],
  [COMPLETED, ["Status: Completed", "Status: Campaign Complete"]],
  [CHILDREN, ["Status: Campaign Active", "Status: Children Working"]],
  [STUCK, ["Status: Awaiting Prompt", "Status: Campaign Stuck"]],
  [WAITING, ["Status: Awaiting Prompt", "Status: 1 Child Request"]],
  [CUSTOM, ["Status: Awaiting Prompt", "Status: Ready for Review"]],
];

async function open(page: Page, path: string, width: number, colorScheme: "light" | "dark", height = width < 600 ? 844 : 900) {
  await page.clock.setFixedTime(NOW);
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme });
  await page.goto(`/sessions-board-e2e.html?campaigns=1&campaign-labels=1&path=${encodeURIComponent(path)}`);
  // The isolated fixture does not mount the application's theme controller.
  await page.evaluate((value) => {
    document.documentElement.setAttribute("data-theme", value);
    document.documentElement.style.colorScheme = value;
  }, colorScheme);
}

async function capture(page: Page, name: string) {
  if (!CAPTURE) return;
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `.evidence/4369/${CAPTURE}-${name}.png`, fullPage: true, animations: "disabled" });
}

/** The badges of one row or card, as accessible names, in reading order. */
const badges = (container: Locator) => container.locator(".row-status > .status")
  .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));

async function expectLabels(item: (title: string) => Locator) {
  for (const [title, labels] of LABELS) {
    await expect.poll(() => badges(item(title)), title).toEqual(labels);
    await expect(item(title).locator(".row-status"), title).not.toContainText(
      labels[0] === "Status: Awaiting Prompt" ? "Campaign Active" : "Awaiting Prompt");
    // Each visible label is its accessible name, in Title Case.
    for (const label of labels) {
      await expect(item(title).getByLabel(label, { exact: true }), title).toHaveText(label.replace(/^Status: /u, ""));
    }
  }
}

const row = (page: Page) => (title: string) =>
  page.locator(".inbox-row").filter({ has: page.locator(".inbox-row-title", { hasText: title }) });
const card = (page: Page) => (title: string) =>
  page.locator(".board .card").filter({ has: page.locator(".card-title", { hasText: title }) });

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test(`Sessions rows read each Full Control root's campaign state at ${width}px in ${colorScheme}`, async ({ page }) => {
      // Tall enough that the whole list shows without scrolling, so one capture holds every row.
      await open(page, "/", width, colorScheme, width < 600 ? 1400 : 1600);
      await expect(row(page)(ACTIVE)).toBeVisible();
      if (ASSERT) {
        await expectLabels(row(page));
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      }
      await capture(page, `rows-${width}-${colorScheme}`);
    });
  }

  test(`Board cards read each Full Control root's campaign state at 1280px in ${colorScheme}`, async ({ page }) => {
    await open(page, "/board", 1280, colorScheme);
    await expect(card(page)(ACTIVE)).toBeVisible();
    if (ASSERT) {
      await expectLabels(card(page));
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    await capture(page, `board-1280-${colorScheme}`);
  });

  test(`phone Board cards read each Full Control root's campaign state in ${colorScheme}`, async ({ page }) => {
    await open(page, "/board", 390, colorScheme);
    await expect(page.getByRole("tablist", { name: "Board Columns" })).toBeVisible();
    for (const tab of ["Running", "Review", "Done"]) {
      await page.getByRole("tab", { name: new RegExp(`^${tab},`) }).click();
      if (ASSERT) {
        for (const [title, labels] of LABELS) {
          const item = page.locator(".board-phone .card").filter({ has: page.locator(".card-title", { hasText: title }) });
          if (await item.count() === 0) continue;
          await expect.poll(() => badges(item), title).toEqual(labels);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      }
      await capture(page, `board-390-${colorScheme}-${tab.toLowerCase()}`);
    }
  });
}

/** The session header's status names each root's campaign state, as its row and card do. */
const HEADERS = [
  ["active", ACTIVE, "Session Status: Campaign Active"],
  ["completed", COMPLETED, "Session Status: Completed, Campaign Complete"],
  ["children", CHILDREN, "Session Status: Campaign Active"],
  ["stuck", STUCK, "Session Status: Awaiting Prompt, Campaign Stuck and 1 More"],
  ["waiting", WAITING, "Session Status: Awaiting Prompt, 1 Child Request"],
  ["custom", CUSTOM, "Session Status: Awaiting Prompt, Ready for Review"],
] as const;

for (const [name, title, accessibleName] of HEADERS) {
  const shapes = name === "active" || name === "children"
    ? [[1280, "light"], [1280, "dark"], [390, "light"], [390, "dark"]] as const
    : [[1280, "light"]] as const;
  for (const [width, colorScheme] of shapes) {
    test(`a Full Control root's header reads its campaign state (${name}) at ${width}px in ${colorScheme}`, async ({ page }) => {
      await open(page, "/", width, colorScheme);
      // The title, so a phone row never takes the tap as its thread's Expand Thread.
      await row(page)(title).locator(".inbox-row-title").click();
      await waitForSessionPreview(page);
      const expand = page.getByRole("button", { name: "Open Session", exact: true });
      if (await expand.isVisible()) await expand.click();
      const status = page.locator(".session-bar .session-status-button");
      await expect(status).toBeVisible();
      if (ASSERT) {
        await expect(status).toHaveAccessibleName(accessibleName);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      }
      await capture(page, `header-${name}-${width}-${colorScheme}`);
    });
  }
}
