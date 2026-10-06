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

test("on a phone search takes its own full-width row above the tabs, and All Groups stays beside them", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openGroups(page);
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  const [bar, search, tabs, allGroups] = await Promise.all([
    box(".tabs-bar"), box(".tabs-tools > .inbox-search"), box(".tabs-bar > .tabs"), box(".tabs-bar > .tabs-all"),
  ]);
  expect(search.width).toBe(bar.width);
  expect(search.y + search.height).toBeLessThanOrEqual(tabs.y);
  expect(allGroups.x).toBeGreaterThanOrEqual(tabs.x + tabs.width);
  expect(allGroups.y + allGroups.height / 2).toBeCloseTo(tabs.y + tabs.height / 2, 0);
  expect(allGroups.x + allGroups.width).toBeLessThanOrEqual(bar.x + bar.width);
});

test.describe("with a touch pointer", () => {
  test.use({ hasTouch: true });

  test("a project chosen from All Groups is scrolled into view with its whole ⋯ target", async ({ page }) => {
    await page.setViewportSize({ width: 940, height: 700 });
    await openGroups(page);
    await page.getByRole("button", { name: "All Groups" }).click();
    await page.getByRole("menuitemradio", { name: /^Mobile App, / }).click();
    const trigger = page.getByRole("button", { name: "Mobile App Actions" });
    await expect(trigger).toBeVisible();
    await expect.poll(() => trigger.evaluate((element) => {
      const target = element.getBoundingClientRect();
      const row = element.closest(".tabs")!.getBoundingClientRect();
      // The row fades its last 24px when clipped, so the target must clear the fade too.
      const visibleRight = row.right - (element.closest(".tabs")!.hasAttribute("data-clip-end") ? 24 : 0);
      return Math.min(target.right, visibleRight) - Math.max(target.left, row.left);
    }), "the whole 36px button, less sub-pixel scroll rounding").toBeGreaterThanOrEqual(35.5);
  });
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

for (const width of [1440, 940]) {
  test(`at ${width}px only the selected project tab has ⋯, after the tab and clear of its blocked count (#2199)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openGroups(page);
    const billing = tablist(page).getByRole("tab", { name: /^Billing/ });
    await billing.click();
    const trigger = page.getByRole("button", { name: "Billing Actions" });
    await expect(trigger).toBeVisible();
    await expect(page.locator(".inbox-project-actions"), "no other tab draws ⋯").toHaveCount(1);
    // Hovering another tab draws nothing over it.
    await tablist(page).getByRole("tab", { name: /^Design System/ }).hover();
    await expect(page.locator(".inbox-project-actions")).toHaveCount(1);
    await trigger.hover();
    const geometry = await trigger.evaluate((element) => {
      const tab = element.parentElement!.querySelector<HTMLElement>('[role="tab"]')!;
      const box = element.getBoundingClientRect();
      const marks = [...tab.querySelectorAll(".count, .count-badge")].map((mark) => mark.getBoundingClientRect());
      const centre = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        badges: tab.querySelectorAll(".count-badge").length,
        tabRight: tab.getBoundingClientRect().right,
        marksRight: Math.max(...marks.map((mark) => mark.right)),
        overlaps: marks.some((mark) => mark.right > box.left && mark.left < box.right && mark.bottom > box.top && mark.top < box.bottom),
        left: box.left,
        width: box.width,
        hit: centre === element || element.contains(centre),
      };
    });
    expect(geometry.badges, "the selected tab carries its blocked count").toBeGreaterThan(0);
    expect(geometry.overlaps).toBe(false);
    expect(geometry.left, "⋯ starts after the tab").toBeGreaterThanOrEqual(geometry.tabRight);
    expect(geometry.left).toBeGreaterThan(geometry.marksRight);
    expect(geometry.width).toBe(28);
    expect(geometry.hit, "nothing covers ⋯").toBe(true);
  });
}

test("right-clicking an unselected project tab opens its menu without selecting it, and Escape returns to the tab (#2199)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);
  const all = tablist(page).getByRole("tab", { name: /^All/ });
  const design = tablist(page).getByRole("tab", { name: /^Design System/ });
  const before = harnessPath(page);
  const box = (await design.boundingBox())!;
  await design.click({ button: "right", position: { x: box.width / 2, y: box.height / 2 } });
  const menu = page.getByRole("menu", { name: "Design System Actions" });
  await expect(menu).toBeVisible();
  await expect(design).toHaveAttribute("aria-selected", "false");
  await expect(all).toHaveAttribute("aria-selected", "true");
  expect(harnessPath(page)).toBe(before);
  await expect(menu.locator('[role="menuitem"] .menu-text').first()).toHaveText("New Session Here");
  // The harness's runner advertises no workspaces, so New Session Here says why and focus starts on
  // the first available item.
  await expect(menu.getByRole("menuitem").first()).toContainText("The runner has not advertised this workspace.");
  await expect(menu.getByRole("menuitem", { name: "Rename Workspace…" })).toBeFocused();
  // It opens at the pointer.
  const menuBox = (await menu.boundingBox())!;
  expect(Math.abs(menuBox.x - (box.x + box.width / 2))).toBeLessThanOrEqual(8);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(design).toBeFocused();

  // Shift+F10 on the focused tab opens the same menu at the tab.
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  const anchored = (await menu.boundingBox())!;
  expect(anchored.y).toBeGreaterThanOrEqual(box.y + box.height);
  await page.keyboard.press("Escape");
  await expect(design).toBeFocused();
  await expect(all).toHaveAttribute("aria-selected", "true");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the project menu is a bottom sheet titled with the project, with 44px items and no Reveal in File Manager (#2199)", async ({ page }) => {
    await openGroups(page);
    await tablist(page).getByRole("tab", { name: /^Billing/ }).tap();
    await page.getByRole("button", { name: "Billing Actions" }).tap();
    const sheet = page.getByRole("menu", { name: "Billing Actions" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".menu-head")).toHaveText("Billing");
    await expect(sheet.locator(".menu-head")).toBeVisible();
    // Docked to the bottom once it has slid in (§7.5).
    await expect.poll(async () => {
      const box = (await sheet.boundingBox())!;
      return [box.x, box.width, Math.round(box.y + box.height)];
    }).toEqual([0, 390, 844]);
    const items = sheet.getByRole("menuitem");
    await expect(items.locator(".menu-text")).toHaveText([
      "New Session Here", "Rename Workspace…", "Pin Workspace", "Create Permanent Worktree…", "Archive All Sessions…",
    ]);
    for (const height of await items.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))) {
      expect(height).toBeGreaterThanOrEqual(44);
    }
  });
});
