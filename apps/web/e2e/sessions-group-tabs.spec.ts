import { expect, test, type Page } from "@playwright/test";

/**
 * The Sessions group tabs (#2180): a full-width tab row in the page header with capped tabs, an
 * All Groups menu and machine names on duplicate project names, measured in a real browser. The
 * harness mounts the real InboxView with ten groups on two machines: a 90-character name and two
 * groups both named Docs Site.
 */

const LONG_NAME = "Platform Reliability — Incident Follow-Ups, Postmortem Actions and Platform Hardening 2026";

async function openGroups(page: Page) {
  await page.goto(`/sessions-board-e2e.html?groups=1&path=${encodeURIComponent("/")}`);
  await expect(page.getByRole("tablist", { name: "Session Groups" }).getByRole("tab")).toHaveCount(10);
}

const tablist = (page: Page) => page.getByRole("tablist", { name: "Session Groups" });
const harnessPath = (page: Page) => decodeURIComponent(new URL(page.url()).searchParams.get("path") ?? "");

test("the 90-character name is capped at 200px with its full name in the tooltip, in a row that spans the content", async ({ page }) => {
  expect(LONG_NAME).toHaveLength(90);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);

  const geometry = await page.locator(".page-header").evaluate((header) => {
    const box = (selector: string) => header.querySelector(selector)!.getBoundingClientRect();
    return { header: header.getBoundingClientRect(), row: box(".page-header-row"), bar: box(".tabs-bar") };
  });
  expect(geometry.bar.left).toBe(geometry.row.left);
  expect(geometry.bar.right).toBe(geometry.row.right);
  expect(geometry.bar.top).toBeGreaterThanOrEqual(geometry.row.bottom);
  expect(geometry.bar.height).toBe(40);
  expect(geometry.bar.bottom, "the row sits on the header's hairline").toBe(geometry.header.bottom);

  const labels = await tablist(page).locator(".tab > .group-name").evaluateAll((names) => names.map((name) => ({
    text: name.textContent,
    width: name.getBoundingClientRect().width,
    truncated: name.scrollWidth > name.clientWidth,
  })));
  for (const label of labels) expect(label.width, label.text ?? "").toBeLessThanOrEqual(200);
  expect(labels.filter((label) => label.truncated).map((label) => label.text)).toEqual([LONG_NAME]);

  const long = tablist(page).getByRole("tab", { name: LONG_NAME });
  expect((await long.getAttribute("title"))?.split("\n")[0]).toBe(LONG_NAME);
  // The count after the cut-short label is never truncated.
  const count = await long.locator(".count").evaluate((element) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().width > 0);
  expect(count).toBe(true);
});

test("with ten groups at 1100px the clipped side fades and All Groups selects the eighth, updating the URL and scrolling it into view", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openGroups(page);
  const row = page.locator(".tabs-bar > .tabs");
  await expect(row).toHaveAttribute("data-clip-end", "");

  const allGroups = page.getByRole("button", { name: "All Groups" });
  const allGroupsBox = (await allGroups.boundingBox())!;
  const rowBox = (await row.boundingBox())!;
  expect(allGroupsBox.x, "All Groups follows the tab row").toBeGreaterThanOrEqual(rowBox.x + rowBox.width);
  await allGroups.click();
  const menu = page.getByRole("menu", { name: "All Groups" });
  const items = menu.getByRole("menuitemradio");
  await expect(items).toHaveCount(10);
  const names = await items.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));
  for (const name of names) expect(name).toMatch(/, \d+(, |$)/);
  expect(names[0]).toMatch(/^All, 13, 2 Blocked/);
  await expect(items.first()).toHaveAttribute("aria-checked", "true");

  const eighth = items.nth(7);
  const eighthName = (await eighth.getAttribute("data-menu-label"))!;
  expect(eighthName).toBe("Mobile App");
  const before = harnessPath(page);
  await eighth.click();
  await expect(menu).toBeHidden();
  const tab = tablist(page).getByRole("tab", { name: /^Mobile App/ });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  expect(harnessPath(page)).not.toBe(before);
  expect(harnessPath(page)).toContain("workspace-group-9");
  await expect.poll(async () => {
    const [tabBox, visible] = await Promise.all([tab.boundingBox(), row.boundingBox()]);
    return tabBox!.x >= visible!.x && tabBox!.x + tabBox!.width <= visible!.x + visible!.width;
  }).toBe(true);
  await expect(allGroups).toBeFocused();
});

test("duplicate names show their machine in the tab and in All Groups", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);
  await expect(tablist(page).getByRole("tab", { name: /^Docs Site on Studio Mac/ })).toBeVisible();
  await expect(tablist(page).getByRole("tab", { name: /^Docs Site on Build Server 02/ })).toBeAttached();
  await page.getByRole("button", { name: "All Groups" }).click();
  await expect(page.getByRole("menuitemradio", { name: /^Docs Site on Studio Mac, 1/ })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: /^Docs Site on Build Server 02, 1/ })).toBeVisible();
});

test("Tab and Shift+Tab still move between groups", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);
  const selected = tablist(page).locator('[role="tab"][aria-selected="true"]');
  await expect(selected).toHaveText(/^All/);
  await page.locator(".inbox-list").focus();
  await page.keyboard.press("Tab");
  await expect(selected).toHaveText(/^Billing/);
  await page.keyboard.press("Shift+Tab");
  await expect(selected).toHaveText(/^All/);
});
