import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The phone Sessions app bar (#2211, docs/design-system.md §15.1): one 48px bar with the group
 * picker, Search, ⋯ and New Session in place of the page header, its action row and the group
 * tabs, measured in a real browser. The harness mounts the real InboxView with ten groups on two
 * machines, a running session, sessions with recent activity and idle ones.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openGroups(page: Page) {
  await page.goto(`/sessions-board-e2e.html?groups=1&path=${encodeURIComponent("/")}`);
  await expect(page.locator(".inbox-row-shell").first()).toBeVisible();
}

const bar = (page: Page) => page.locator(".sessions-app-bar");
const picker = (page: Page) => bar(page).locator(".sessions-group-picker");
const harnessPath = (page: Page) => decodeURIComponent(new URL(page.url()).searchParams.get("path") ?? "");

/** A sheet once it has slid in and docked to the bottom (§7.5). */
async function docked(sheet: Locator) {
  await expect(sheet).toBeVisible();
  await expect.poll(async () => {
    const box = (await sheet.boundingBox())!;
    return [box.x, box.width, Math.round(box.y + box.height)];
  }).toEqual([0, 390, 844]);
}

async function expectTargets(locator: Locator) {
  for (const [name, height, width] of await locator.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return [node.getAttribute("aria-label") ?? node.textContent ?? "", box.height, box.width] as const;
  }))) {
    expect(height, `${name} is 44px tall`).toBeGreaterThanOrEqual(44);
    expect(width, `${name} is 44px wide`).toBeGreaterThanOrEqual(44);
  }
}

test("the first row starts at most 56px below the top of the content: the 48px bar and 8px", async ({ page }) => {
  await openGroups(page);
  await expect(page.locator(".page-tabs")).toHaveCount(0);
  const content = (await page.locator(".page").boundingBox())!;
  const header = (await bar(page).boundingBox())!;
  const row = (await page.locator(".inbox-row-shell").first().boundingBox())!;
  expect(header.y).toBe(content.y);
  expect(header.height).toBe(48);
  expect(row.y - content.y).toBeLessThanOrEqual(56);
});

test("the picker names the group and its attention, and choosing in its sheet switches the list", async ({ page }) => {
  await openGroups(page);
  await expect(picker(page)).toHaveAccessibleName("All, 2 Blocked, 1 Stalled");
  await expect(picker(page).locator(".count-badge")).toHaveText(["2", "1"]);
  await picker(page).tap();
  const sheet = page.getByRole("menu", { name: "Session Groups" });
  await docked(sheet);
  await expect(sheet.locator(".menu-head")).toHaveText("Session Groups");
  const rows = sheet.getByRole("menuitemradio");
  await expect(rows).toHaveCount(10);
  await expectTargets(rows);
  await expect(sheet.getByRole("menuitemradio", { name: /^All, 13/ })).toHaveAttribute("aria-checked", "true");

  await sheet.getByRole("menuitemradio", { name: /^Billing, 2/ }).tap();
  await expect(sheet).toHaveCount(0);
  await expect(picker(page)).toHaveAccessibleName("Billing, 1 Blocked, 1 Stalled");
  await expect(page.locator(".inbox-row-title")).toHaveText(["Billing Session", "Move the billing buckets to terraform"]);
  expect(harnessPath(page), "the group is in the URL (§10.1)").toMatch(/[?&]tab=/);
});

test("Search shows a full-width field with focus inside, results follow #2200, and Cancel restores the bar", async ({ page }) => {
  await openGroups(page);
  await bar(page).getByRole("button", { name: "Search Sessions" }).tap();
  const field = bar(page).getByRole("searchbox").or(bar(page).locator(".inbox-search input"));
  await expect(field).toBeFocused();
  await expect(picker(page)).toHaveCount(0);
  const [fieldBox, barBox] = [(await bar(page).locator(".inbox-search").boundingBox())!, (await bar(page).boundingBox())!];
  expect(fieldBox.width, "the field takes the bar's width beside Cancel").toBeGreaterThanOrEqual(barBox.width - 120);
  await expectTargets(bar(page).getByRole("button", { name: "Cancel" }));

  await field.fill("terraform");
  await expect(page.locator(".inbox-row-title")).toHaveText(["Move the billing buckets to terraform", "Plan the terraform state migration"]);
  // No Matches keeps Search Transcripts for the palette; the bar's Search no longer opens it.
  await field.fill("no such session");
  await expect(page.getByRole("button", { name: "Search Transcripts" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await bar(page).getByRole("button", { name: "Cancel" }).tap();
  await expect(bar(page).locator(".inbox-search")).toHaveCount(0);
  await expect(picker(page)).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Search Sessions" })).toBeFocused();
  await expect(page.locator(".inbox-row-title").first()).toBeVisible();
  await bar(page).getByRole("button", { name: "Search Sessions" }).tap();
  await expect(bar(page).locator(".inbox-search input")).toHaveValue("");
});

test("⋯ lists View, Show, New Project… and the project's actions in order, and Board opens the Board", async ({ page }) => {
  await openGroups(page);
  await picker(page).tap();
  await page.getByRole("menu", { name: "Session Groups" }).getByRole("menuitemradio", { name: /^Billing, 2/ }).tap();
  await bar(page).getByRole("button", { name: "More Actions" }).tap();
  const sheet = page.getByRole("menu", { name: "More Actions" });
  await docked(sheet);
  await expect(sheet.locator(".menu-label, .menu-text")).toHaveText([
    "View", "List", "Board", "Show", "Active Sessions", "Snoozed Sessions", "New Project…",
    "Billing", "New Session Here", "Rename Workspace…", "Pin Workspace", "Create Permanent Worktree…", "Archive All Sessions…",
  ]);
  await expectTargets(sheet.locator('[role^="menuitem"]'));

  await sheet.getByRole("menuitemradio", { name: "Board", exact: true }).tap();
  await expect(sheet).toHaveCount(0);
  expect(harnessPath(page)).toMatch(/^\/board/);
  await expect(bar(page)).toBeVisible();
});

test("with Snoozed on, a 44px strip says so, and Show Active returns to active sessions", async ({ page }) => {
  await openGroups(page);
  await bar(page).getByRole("button", { name: "More Actions" }).tap();
  await page.getByRole("menu", { name: "More Actions" }).getByRole("menuitemradio", { name: "Snoozed Sessions, 1" }).tap();
  const strip = bar(page).locator(".sessions-snoozed-strip");
  await expect(strip).toContainText("Showing snoozed sessions.");
  expect((await strip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator(".inbox-row-title")).toHaveText(["Snoozed Session"]);
  await expect(picker(page).locator(".count-badge")).toHaveCount(0);
  await expectTargets(strip.getByRole("button", { name: "Show Active" }));

  await strip.getByRole("button", { name: "Show Active" }).tap();
  await expect(strip).toHaveCount(0);
  await expect(picker(page)).toBeFocused();
  await expect(page.locator(".inbox-row-shell")).toHaveCount(13);
});

test("every bar target is 44px, rows are three-line cards, and Back returns to the list unhighlighted at its scroll", async ({ page }) => {
  await openGroups(page);
  await expectTargets(bar(page).locator("button"));

  // Three lines on every row; the strip follows the badge on the status line while Running, and an
  // idle row with no tool activity in the last 10 minutes draws none.
  for (const lines of await page.locator(".inbox-row-shell").evaluateAll((rows) => rows.map((row) =>
    row.querySelectorAll(".inbox-row-sender-line, .inbox-row-copy, .inbox-row-status-line").length))) {
    expect(lines).toBe(3);
  }
  const running = page.locator(".inbox-row-shell", { hasText: "Move the billing buckets to terraform" });
  const statusLine = running.locator(".inbox-row-status-line");
  await expect(statusLine.locator(":scope > .inbox-row-activity")).toBeVisible();
  expect(await statusLine.evaluate((line) => [...line.children].map((child) => child.className.split(" ")[0]).slice(0, 2)))
    .toEqual(["row-status", "activity-strip"]);
  const strip = (await statusLine.locator(".inbox-row-activity").boundingBox())!;
  expect([Math.round(strip.width), Math.round(strip.height)]).toEqual([48, 12]);
  await expect(running.locator(".inbox-row-copy .inbox-row-activity")).toHaveCount(0);
  const idle = page.locator(".inbox-row-shell", { hasText: "Marketing Site Session" });
  await expect(idle.locator(".inbox-row-activity")).toHaveCount(0);

  const list = page.getByRole("grid", { name: "Sessions", exact: true });
  await list.evaluate((element) => { element.scrollTop = 300; element.dispatchEvent(new Event("scroll")); });
  const scrolled = await list.evaluate((element) => element.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  await page.locator(".inbox-row-shell", { hasText: "Docs Site Session" }).first().locator(".inbox-row").tap();
  await expect(bar(page)).toHaveCount(0);
  await page.goBack();
  await expect(bar(page)).toBeVisible();
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(scrolled);
  await expect(page.locator(".inbox-row-shell.selected")).toHaveCount(0);
});

test("a confirmation from the ⋯ sheet replaces it with Back, which brings the sheet back (§7.5)", async ({ page }) => {
  await openGroups(page);
  await picker(page).tap();
  await page.getByRole("menu", { name: "Session Groups" }).getByRole("menuitemradio", { name: /^Billing, 2/ }).tap();
  await bar(page).getByRole("button", { name: "More Actions" }).tap();
  await page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem", { name: /^Archive/ }).tap();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("menu", { name: "More Actions" })).toHaveCount(0);
  await expectTargets(dialog.getByRole("button", { name: "Back to More Actions" }));
  await dialog.getByRole("button", { name: "Back to More Actions" }).tap();
  await expect(dialog).toHaveCount(0);
  await docked(page.getByRole("menu", { name: "More Actions" }));
});
