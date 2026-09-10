import { expect, test, type Page } from "@playwright/test";
test.use({ video: "on" });

/**
 * #896: a parent session and its children read as one thread in the Sessions list, every card
 * still measures one card, and the thread is driven from the home row. The harness mounts the real
 * InboxView against a fixture socket (see sessions-board-main.tsx); `?threads=1` adds an
 * orchestrator with four children and gives one session three pending requests.
 */
const PAGE = "/sessions-board-e2e.html?threads=1";
const EVIDENCE = ".agents/tmp/inbox-threads";

async function openList(page: Page, path = "/") {
  await page.goto(`${PAGE}&path=${encodeURIComponent(path)}`);
  await expect(page.locator(".inbox-toolbar")).toBeVisible();
}

const titles = (page: Page) => page.locator(".inbox-row-title").allTextContents();
const grid = (page: Page) => page.getByRole("grid", { name: "Sessions", exact: true });
const parentRow = (page: Page) => page.locator(".inbox-row-shell", { hasText: "Ship the usage and cost overhaul" });

test("a family sorts as one unit with the parent first, children indent under it, and every card keeps one height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openList(page);
  await expect(page.locator(".inbox-row")).toHaveCount(9);
  // Fired reminders lead as before. Then urgency before recency: the live family, two of whose
  // children are waiting, is ONE unit placed by that most urgent member, parent first and its
  // children by the same rule; the fixture's older waiting session follows; then the running and
  // queued rows; the snoozed row is hidden from Active.
  expect(await titles(page)).toEqual([
    "Review Session",
    "Ship the usage and cost overhaul",
    "#601: Link the cost source",
    "#603: Normalize the allowance window",
    "#600: Add the usage table",
    "#602: Roll the daily budget over",
    "Approval Session",
    "Queued Session",
    "Running Session",
  ]);
  const parent = parentRow(page);
  await expect(parent.locator(".inbox-thread-toggle")).toHaveAttribute("aria-label", "Collapse Thread");
  await expect(parent.locator(".inbox-thread-family-text")).toHaveText("4 Children · 2 Awaiting Input");
  await expect(parent.locator(".inbox-thread-family")).toHaveClass(/waiting/);
  await expect(parent.locator(".inbox-thread-dot")).toHaveCount(4);
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await expect(page.locator(".inbox-row-shell.thread-child.thread-last")).toHaveCount(1);
  // The three-request session: one pill per kind, the question first, the permissions counted.
  const approval = page.locator(".inbox-row-shell", { hasText: "Approval Session" });
  await expect(approval.locator(".inbox-status-pill.blocked")).toHaveText(["Answer Required", "Approval Required2"]);
  await expect(approval.locator(".inbox-status-pill.blocked").nth(1))
    .toHaveAttribute("aria-label", "Attention: Approval Required, 2 Requests");
  await expect(approval.locator(".inbox-status-pill.blocked").nth(1))
    .toHaveAttribute("title", "Main Agent: Run npm test\nVerifier · Tester: Run pnpm test");
  await expect(page.locator(".attention-requests")).toHaveCount(0);

  const geometry = await page.locator(".inbox-row-shell").evaluateAll((shells) => shells.map((shell) => {
    const box = shell.querySelector(".inbox-row")!.getBoundingClientRect();
    return { left: Math.round(box.left), height: Math.round(box.height), child: shell.classList.contains("thread-child") };
  }));
  const heights = new Set(geometry.map((row) => row.height));
  expect(heights.size, `every card measures the same: ${JSON.stringify(geometry)}`).toBe(1);
  const parentLeft = geometry[0]!.left;
  for (const row of geometry) expect(row.left - parentLeft).toBe(row.child ? 26 : 0);
  await page.screenshot({ path: `${EVIDENCE}/desktop-expanded.png`, fullPage: true });
});

test("t, Shift+T, p, and the arrows drive the thread, the chevron is the pointer path, and collapse persists", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openList(page);
  await parentRow(page).locator(".inbox-row").click();
  const list = grid(page);
  await expect(list).toBeFocused();
  await list.press("t");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  await expect(parentRow(page).locator(".inbox-thread-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(parentRow(page).locator(".inbox-thread-family-text")).toHaveText("4 Children · 2 Awaiting Input");
  await page.screenshot({ path: `${EVIDENCE}/desktop-collapsed.png`, fullPage: true });
  await page.reload();
  await expect(page.locator(".inbox-toolbar")).toBeVisible();
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  await expect(parentRow(page).locator(".inbox-thread-toggle")).toHaveAttribute("aria-expanded", "false");

  await parentRow(page).locator(".inbox-row").click();
  await list.press("t");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await list.press("j");
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("#601");
  await list.press("p");
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("Ship the usage");
  await list.press("ArrowRight");
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("#601");
  await list.press("t");
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("Ship the usage");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  await list.press("ArrowRight");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await list.press("ArrowLeft");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  await list.press("Shift+T");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await list.press("Shift+T");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);

  // The chevron and the family chip toggle without selecting the row.
  await page.locator(".inbox-row-shell", { hasText: "Running Session" }).locator(".inbox-row").click();
  await parentRow(page).locator(".inbox-thread-toggle").click();
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("Running Session");
  await parentRow(page).locator(".inbox-thread-family").click();
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("Running Session");
  expect(await page.evaluate(() => window.__approveCalls)).toEqual([]);
});

test("a phone narrows the spine and keeps the family chip's dots", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openList(page);
  await expect(page.locator(".inbox-row").first().locator(":scope > *").first()).toHaveClass(/inbox-row-sender/);
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await expect(parentRow(page).locator(".inbox-thread-dot")).toHaveCount(4);
  await expect(parentRow(page).locator(".inbox-thread-family-text")).toBeHidden();
  // One compact attention pill on a phone: the top-priority kind and how many more requests.
  const approval = page.locator(".inbox-row-shell", { hasText: "Approval Session" });
  await expect(approval.locator(".inbox-status-pill.blocked")).toHaveCount(1);
  await expect(approval.locator(".inbox-status-pill.blocked")).toHaveAttribute("aria-label", "Attention: Answer Required, 3 Requests");
  await expect(approval.locator(".inbox-status-pill-count")).toHaveText("+2");
  const geometry = await page.locator(".inbox-row-shell").evaluateAll((shells) => shells.map((shell) => {
    const box = shell.querySelector(".inbox-row")!.getBoundingClientRect();
    return {
      title: shell.querySelector(".inbox-row-title")!.textContent,
      left: Math.round(box.left),
      height: Math.round(box.height),
      child: shell.classList.contains("thread-child"),
    };
  }));
  // Indenting must not change a card's height. A phone card with three pills wraps its relative
  // time whether or not it is indented, and a bordered lifecycle pill sits 2px taller than an
  // unbordered one at every depth, so the comparison is between the parent and the child that
  // carries the same pills.
  const heightOf = (title: string) => geometry.find((row) => row.title === title)!.height;
  expect(heightOf("#600: Add the usage table")).toBe(heightOf("Ship the usage and cost overhaul"));
  for (const row of geometry) expect(row.left - geometry[0]!.left).toBe(row.child ? 14 : 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${EVIDENCE}/phone-expanded.png`, fullPage: true });
});

test("Board cards carry the per-kind pills and the family chip without nesting", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openList(page, "/board");
  const card = page.locator(".card", { hasText: "Ship the usage and cost overhaul" });
  await expect(card.locator(".inbox-thread-family-text")).toHaveText("4 Children · 2 Awaiting Input");
  await expect(card.locator(".inbox-thread-dot")).toHaveCount(4);
  const approval = page.locator(".card", { hasText: "Approval Session" });
  await expect(approval.locator(".inbox-status-pill.blocked")).toHaveText(["Answer Required", "Approval Required2"]);
  await expect(page.locator(".attention-requests")).toHaveCount(0);
  await expect(page.locator(".card.thread-child")).toHaveCount(0);
  await page.screenshot({ path: `${EVIDENCE}/board.png`, fullPage: true });
});
