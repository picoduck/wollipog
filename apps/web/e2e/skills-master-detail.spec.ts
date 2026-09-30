import { expect, test, type Page } from "@playwright/test";

/**
 * Agent Skills' frame (#1947; docs/design-system.md §4.2, §6, §6.2, §12, §15), in the real Shell:
 * one header row, a master-detail whose panes scroll on their own and never widen the page, and
 * list and detail as two routes on a phone.
 */
const shell = (path: string, query = "") =>
  `/command-inbox-projects-e2e.html?fullShell=1&history=1&path=${encodeURIComponent(path)}${query}`;
const SKILL_1 = `/skills/~${Buffer.from("skill-1", "utf16le").toString("base64url")}`;

async function open(page: Page, path: string, query = "") {
  await page.goto(shell(path, query));
  await expect(page.locator("#page-title")).toBeVisible();
}

const header = (page: Page) => page.locator(".page-header");
const routePath = (page: Page) => page.evaluate(() => new URL(window.location.href).searchParams.get("path"));

/** The header's shown controls: every one the same height, in one row, none wrapped. */
const headerRow = (page: Page) => page.locator(".page-header .page-actions").evaluate((row) => {
  const shown = [...row.children].filter((child) => child.getClientRects().length > 0);
  const boxes = shown.map((child) => child.getBoundingClientRect());
  return {
    names: shown.map((child) => child.getAttribute("aria-label") ?? child.querySelector("[aria-label]")?.getAttribute("aria-label") ?? child.textContent),
    heights: [...new Set(boxes.map((box) => Math.round(box.height)))],
    tops: [...new Set(boxes.map((box) => Math.round(box.top)))],
    wrapped: shown.some((child) => {
      const button = child.matches("button") ? child : child.querySelector("button");
      return Boolean(button && button.getClientRects().length > 1);
    }),
  };
});

test.describe("at desktop widths", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the header is one row, Manage Groups…, Import, New Skill, at 32px, at every width above 760px", async ({ page }) => {
    await open(page, "/skills");
    expect(await headerRow(page)).toEqual({ names: ["Manage Groups…", "Import", "New Skill"], heights: [32], tops: [expect.any(Number)], wrapped: false });
    await expect(header(page).getByRole("button", { name: "Manage Groups…", exact: true })).toHaveClass(/\bghost\b/);
    for (const width of [761, 834, 900, 1099, 1100, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const row = await headerRow(page);
      expect(row.heights, `${width}px`).toEqual([32]);
      expect(row.tops, `${width}px: one row`).toHaveLength(1);
      expect(row.wrapped, `${width}px: no label wraps`).toBe(false);
      expect(row.names.at(-1)).toBe("New Skill");
    }
  });

  test("Import opens a two-item menu the keyboard can walk, and each item opens its dialog", async ({ page }) => {
    await open(page, "/skills");
    const importButton = header(page).getByRole("button", { name: "Import", exact: true });
    await importButton.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Import" });
    const items = menu.getByRole("menuitem");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveAccessibleName("Import from Git…");
    await expect(items.nth(1)).toHaveAccessibleName("Import from Machine…");
    await expect(menu.locator(".menu-desc")).toHaveCount(2);
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(importButton).toBeFocused();

    await importButton.click();
    await items.nth(1).click();
    await expect(page.getByRole("dialog", { name: "Import Skill from Machine" })).toBeVisible();
    await page.keyboard.press("Escape");
    await importButton.click();
    await menu.getByRole("menuitem", { name: "Import from Git…" }).click();
    await expect(page.getByRole("dialog", { name: "Import Skills from Git" })).toBeVisible();
  });

  test("at 900px Manage Groups… is in ⋯ and Import and New Skill stay buttons", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await open(page, "/skills");
    await expect(header(page).locator(".page-action:visible")).toHaveText(["Import"]);
    await expect(header(page).getByRole("button", { name: "New Skill", exact: true })).toBeVisible();
    await header(page).getByRole("button", { name: "More Actions", exact: true }).click();
    await expect(page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem")).toHaveText(["Manage Groups…"]);
  });

  test("the list pane is 320px, or 280px in the compact tier, flush, with a hairline divider", async ({ page }) => {
    await open(page, SKILL_1);
    const pane = page.locator(".master-detail-list");
    const measure = () => pane.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: element.getBoundingClientRect().width, divider: style.borderRightWidth, background: style.backgroundColor, radius: style.borderTopLeftRadius };
    });
    expect(await measure()).toEqual({ width: 320, divider: "1px", background: "rgba(0, 0, 0, 0)", radius: "0px" });
    await page.setViewportSize({ width: 1000, height: 800 });
    expect((await measure()).width).toBe(280);
  });

  test("the list and the detail scroll on their own, and a new selection starts the detail at the top", async ({ page }) => {
    await open(page, SKILL_1, "&skills=many");
    const list = page.locator(".master-detail-list-body");
    const detail = page.locator(".master-detail-detail");
    await expect(detail.getByRole("heading", { name: "code-review" })).toBeVisible();
    const scroll = (locator: typeof list, top: number) => locator.evaluate((element, value) => { element.scrollTop = value; }, top);
    const top = (locator: typeof list) => locator.evaluate((element) => element.scrollTop);
    await scroll(list, 400);
    await scroll(detail, 300);
    expect(await top(list)).toBe(400);
    expect(await top(detail)).toBe(300);
    expect(await page.locator(".main-body").evaluate((element) => element.scrollHeight - element.clientHeight), "the page itself never scrolls").toBe(0);

    const row = list.getByRole("button", { name: /^team-skill-12/ });
    await row.click();
    await expect(detail.getByRole("heading", { name: "team-skill-12" })).toBeVisible();
    expect(await top(detail), "the detail starts at its top").toBe(0);
    expect(await top(list), "the list keeps its place").toBe(400);
    await expect(row).toHaveAttribute("aria-current", "true");
    expect(await routePath(page)).toBe(`/skills/~${Buffer.from("skill-12", "utf16le").toString("base64url")}`);
  });

  test("/skills/orphans opens the Orphaned Copies pane, and Back leaves it", async ({ page }) => {
    await open(page, "/skills");
    await page.goto(shell("/skills/orphans"));
    await expect(page.locator('.master-detail-detail [aria-label="Orphaned Copies"]')).toBeVisible();
    await expect(page.locator(".master-detail-list-head .row")).toHaveAttribute("aria-current", "true");
    await page.goBack();
    await expect(page.locator('[aria-label="Orphaned Copies"]')).toHaveCount(0);
    await expect(page.locator(".master-detail-detail")).toContainText("Select a skill");
  });

  test("an empty library is one state across the content, and the header keeps only Manage Groups…", async ({ page }) => {
    await open(page, "/skills", "&skills=empty");
    await expect(page.locator(".master-detail")).toHaveCount(0);
    const state = page.locator(".master-detail-state");
    await expect(state.getByRole("heading", { level: 2 })).toHaveText("No Agent Skills Yet");
    await expect(page.getByRole("button", { name: "New Skill", exact: true })).toHaveCount(1);
    await expect(state.getByRole("button", { name: "Import from Git…", exact: true })).toBeVisible();
    await expect(state.getByRole("button", { name: "Import from Machine…", exact: true })).toBeVisible();
    expect((await headerRow(page)).names).toEqual(["Manage Groups…"]);
    await expect(state.locator(".steps.horizontal > li")).toHaveCount(3);
    // The state spans the content area: it starts at the page gutter, not in a 280px column.
    const [title, content] = await Promise.all([page.locator("#page-title").boundingBox(), state.boundingBox()]);
    expect(content!.x).toBe(title!.x);
    expect(content!.width).toBeGreaterThan(900);
  });

  test("loading shows skeleton rows and a skeleton detail; a failed load shows Couldn't Load Skills", async ({ page }) => {
    await open(page, "/skills", "&skills=loading");
    await expect(page.locator(".master-detail-list .skeleton-row")).toHaveCount(5);
    await expect(page.locator(".master-detail-detail .detail-skeleton")).toBeVisible();
    const rowHeight = await page.locator(".master-detail-list .skeleton-row").first().evaluate((element) => element.getBoundingClientRect().height);
    expect(rowHeight, "a skeleton row is the two-line row's height").toBe(56);

    await open(page, "/skills", "&skills=error");
    const notice = page.getByRole("alert").filter({ hasText: "Couldn't Load Skills" });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await notice.getByRole("button", { name: "Show Details", exact: true }).click();
    await expect(notice.locator(".code-well")).toContainText("HTTP 503");
    await expect(page.locator(".form-error")).toHaveCount(0);
  });
});

test("with a coarse pointer every header control is 44px tall", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await open(page, "/skills");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const row = await headerRow(page);
    expect(row.names).toEqual(["Manage Groups…", "Import", "New Skill"]);
    expect(row.heights).toEqual([44]);
    expect(row.tops).toHaveLength(1);
  } finally {
    await context.close();
  }
});

for (const [label, options] of [
  ["an 834px coarse-pointer tablet", { viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true }],
  ["a 390px phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
] as const) {
  test(`on ${label} a skill whose assignments table is its widest child never widens the page`, async ({ browser }) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    try {
      await open(page, SKILL_1);
      await expect(page.locator(".skills-table")).toBeVisible();
      const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth }));
      expect(widths.scroll).toBe(widths.viewport);
      // A dialog opened from the detail is laid out against the viewport, not a widened page.
      await page.getByRole("button", { name: "Add Assignment", exact: true }).click();
      const dialog = await page.getByRole("dialog", { name: "Add Assignment" }).boundingBox();
      expect(dialog!.x).toBeGreaterThanOrEqual(0);
      expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(options.viewport.width);
    } finally {
      await context.close();
    }
  });
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the app bar shows the title, a + named New Skill and ⋯, whose sheet lists all three", async ({ page }) => {
    await open(page, "/skills");
    await expect(page.locator(".page-desc")).toBeHidden();
    const plus = header(page).getByRole("button", { name: "New Skill", exact: true });
    const box = await plus.boundingBox();
    expect([box!.width, box!.height]).toEqual([44, 44]);
    await header(page).getByRole("button", { name: "More Actions", exact: true }).click();
    const sheet = page.getByRole("menu", { name: "More Actions" });
    await expect(sheet.locator(".menu-text")).toHaveText(["Manage Groups…", "Import from Git…", "Import from Machine…"]);
    await expect(page.locator(".master-detail-detail")).toBeHidden();
  });

  test("tapping a skill opens its route with Back, and ‹ or the browser's Back returns to the list where it was", async ({ page }) => {
    await open(page, "/skills", "&skills=many");
    const list = page.locator(".master-detail-list-body");
    await list.evaluate((element) => { element.scrollTop = 600; });
    const row = list.getByRole("button", { name: /^team-skill-20/ });
    for (const back of ["bar", "browser"] as const) {
      await row.tap();
      expect(await routePath(page)).toBe(`/skills/~${Buffer.from("skill-20", "utf16le").toString("base64url")}`);
      const bar = page.locator(".detail-bar");
      await expect(bar.getByRole("heading", { level: 1 })).toHaveText("team-skill-20");
      await expect(bar.getByRole("button", { name: "Back to Agent Skills", exact: true })).toBeVisible();
      await expect(list).toBeHidden();
      await expect(page.locator("#page-title")).toBeFocused();
      // The bar and the detail share the column: only the detail scrolls, never the page around it.
      expect(await page.locator(".main-body").evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
      const barBox = await bar.boundingBox();
      expect(barBox!.y).toBe(0);
      if (back === "bar") await bar.getByRole("button", { name: "Back to Agent Skills", exact: true }).tap();
      else await page.goBack();
      await expect(page.locator(".detail-bar")).toHaveCount(0);
      expect(await routePath(page)).toBe("/skills");
      await expect(list).toBeVisible();
      expect(await list.evaluate((element) => element.scrollTop), `${back}: the list is where it was`).toBe(600);
      await expect(page.locator(".master-detail-list .is-selected"), "a phone list shows no selected row").toHaveCount(0);
    }
  });
});
