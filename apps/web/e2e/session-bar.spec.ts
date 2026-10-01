import { expect, test, type Page } from "@playwright/test";

/**
 * The session bar on the shared 48px detail-bar anatomy (#2146; docs/design-system.md §4.3, §4.4,
 * §15.2). The real Shell is mounted, so the bar sits in the `app` size container whose width the
 * compact tier answers to, beside the rail and with the shell's Open picker and panel toggles.
 */

const GENERATED_TITLE = "Add a dark mode toggle to the site header.\n\nRequirements:\n- x";
const LONG_TITLE =
  "Add a dark mode toggle to the site header and keep the chosen theme across reloads and new windows.\n\nRequirements:\n- x";

async function openBar(page: Page, width: number, options: { session?: RegExp; height?: number } = {}) {
  await page.setViewportSize({ width, height: options.height ?? 900 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&reviewReady=1&fullShell=1");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: options.session ?? /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator("header.session-bar")).toBeVisible();
}

async function setTitle(page: Page, title: string) {
  await page.evaluate((value) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { title: value });
  }, title);
}

/** The three statuses the scenario reports: lifecycle, review and changes. */
async function expectThreeStatuses(page: Page) {
  const statuses = page.locator("header.session-bar .session-header-statuses");
  await expect(statuses.getByText("Awaiting Prompt", { exact: true })).toBeAttached();
  await expect(statuses.getByText("Ready for Review", { exact: true })).toBeAttached();
  await expect(statuses.getByText("Uncommitted Changes", { exact: true })).toBeAttached();
}

/** Every status badge the row paints sits on one line: the row clips, it never wraps (§15.2). */
async function expectStatusesOnOneLine(page: Page) {
  const tops = await page.locator("header.session-bar .session-header-statuses").evaluate((row) =>
    [...row.querySelectorAll<HTMLElement>(".status")]
      .filter((badge) => badge.getClientRects().length > 0)
      .map((badge) => Math.round(badge.getBoundingClientRect().top)));
  expect(tops.length).toBeGreaterThanOrEqual(3);
  expect(new Set(tops).size, `badge tops ${tops.join(", ")}`).toBe(1);
}

test("at 1440px the bar is one 48px row and every control in it is 32px tall", async ({ page }) => {
  await openBar(page, 1440);
  // A title long enough to put the row under pressure, as in a real generated title.
  await setTitle(page, LONG_TITLE);
  await expectThreeStatuses(page);
  const bar = page.locator("header.session-bar");
  const geometry = await bar.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll<HTMLElement>("button, a.btn")]
      // Status badges are statuses, not controls; they keep the badge recipe's height (§11.1).
      .filter((control) => !control.closest(".session-header-statuses") && control.getClientRects().length > 0)
      .map((control) => ({
        name: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "",
        height: control.getBoundingClientRect().height,
        top: control.getBoundingClientRect().top - box.top,
      }));
    return { height: box.height, controls };
  });
  expect(geometry.height).toBe(48);
  const names = geometry.controls.map((control) => control.name);
  for (const name of ["Back to Sessions", "Alpha", "Share", "More Actions", "Toggle Pinned Summary", "Show Side Panel"]) {
    expect(names).toContain(name);
  }
  expect(geometry.controls.length).toBeGreaterThanOrEqual(8);
  for (const control of geometry.controls) {
    expect(control.height, control.name).toBe(32);
    // Centred in the row: the 47px above the bottom hairline leaves 7.5px of air either side.
    expect(control.top, control.name).toBe(7.5);
  }
  await expectStatusesOnOneLine(page);
  await expect(bar.locator("h1#page-title")).toHaveCSS("font-size", "16px");
  await expect(bar.locator("h1#page-title")).toHaveCSS("font-weight", "600");
  // One divider before the Open picker and one after it, ahead of the panel toggles.
  const order = await bar.locator(".detail-actions").evaluate((actions) =>
    [...actions.querySelectorAll(".editor-select, .detail-actions-divider, [aria-label='More Actions'], [aria-label='Toggle Pinned Summary']")]
      .map((node) => node.classList.contains("detail-actions-divider") ? "|" : node.classList.contains("editor-select") ? "Open" : node.getAttribute("aria-label")));
  expect(order).toEqual(["More Actions", "|", "Open", "|", "Toggle Pinned Summary"]);
});

test("the project button renders short names whole and truncates a long one at 220px", async ({ page }) => {
  await openBar(page, 1440);
  const button = page.locator("header.session-bar .session-project-button");
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { name: "Payments Service" });
  });
  await expect(button).toHaveText("Payments Service");
  const whole = await button.locator(".session-project-button-label").evaluate((label) => ({
    clientWidth: label.clientWidth,
    scrollWidth: label.scrollWidth,
  }));
  expect(whole.scrollWidth).toBeLessThanOrEqual(whole.clientWidth);

  const longName = "Payment Service Platform Migration and Ledger Reconciliation";
  expect(longName).toHaveLength(60);
  await page.evaluate((name) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { name });
  }, longName);
  await expect(button).toHaveAttribute("title", longName);
  const truncated = await button.evaluate((element) => {
    const label = element.querySelector<HTMLElement>(".session-project-button-label")!;
    return {
      width: element.getBoundingClientRect().width,
      clipped: label.scrollWidth > label.clientWidth,
      textOverflow: getComputedStyle(label).textOverflow,
    };
  });
  expect(truncated.width).toBe(220);
  expect(truncated.clipped).toBe(true);
  expect(truncated.textOverflow).toBe("ellipsis");
});

test("the project button opens Open Project and Move to Another Project…, and Open Project navigates", async ({ page }) => {
  await openBar(page, 1440);
  const button = page.locator("header.session-bar .session-project-button");
  await expect(button).toHaveAccessibleName("Alpha");
  await expect(button.locator("svg")).toHaveCount(2);
  await button.click();
  const menu = page.getByRole("menu", { name: "Project Actions" });
  await expect(menu).toBeVisible();
  await expect(menu.locator(".menu-label")).toHaveText("Alpha");
  await expect(menu.getByRole("menuitem")).toHaveText(["Open Project", "Move to Another Project…"]);
  await menu.getByRole("menuitem", { name: "Open Project" }).click();
  await expect(page.locator("header.session-bar")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await expect(page.locator('[aria-current="true"]', { hasText: "Alpha" })).toBeVisible();
});

test("a session with no project shows a faint No Project whose menu only moves it", async ({ page }) => {
  await openBar(page, 1440, { session: /No Project Session/ });
  const button = page.locator("header.session-bar .session-project-button");
  await expect(button).toHaveText("No Project");
  const colors = await button.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-faint)";
    element.append(probe);
    const faint = getComputedStyle(probe).color;
    probe.remove();
    return { button: getComputedStyle(element).color, faint };
  });
  expect(colors.button).toBe(colors.faint);
  const whole = await button.locator(".session-project-button-label").evaluate((label) => label.scrollWidth <= label.clientWidth);
  expect(whole).toBe(true);
  await button.click();
  const menu = page.getByRole("menu", { name: "Project Actions" });
  await expect(menu.locator(".menu-label")).toHaveText("No Project");
  await expect(menu.getByRole("menuitem")).toHaveText(["Move to a Project…"]);
});

for (const width of [761, 834, 940, 1099]) {
  test(`at ${width}px the bar holds one row with a readable title and the project in More Actions`, async ({ page }) => {
    await openBar(page, width);
    await setTitle(page, LONG_TITLE);
    await expectThreeStatuses(page);
    const bar = page.locator("header.session-bar");
    await expect(bar.locator(".session-project-button")).toBeHidden();
    await expect(bar.locator(".session-bar-sep")).toBeHidden();
    const geometry = await bar.evaluate((element) => {
      const rect = (node: Element) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
      };
      const box = rect(element);
      const children = [...element.children]
        .filter((child) => child.getClientRects().length > 0 && !child.classList.contains("sr-only"))
        .map((child) => ({ name: child.className, ...rect(child) }));
      return {
        bar: box,
        children,
        title: rect(element.querySelector("h1")!),
        statuses: rect(element.querySelector(".session-header-statuses")!),
        actions: rect(element.querySelector(".detail-actions")!),
        overflow: element.scrollWidth > element.clientWidth,
      };
    });
    expect(geometry.bar.bottom - geometry.bar.top).toBe(48);
    await expectStatusesOnOneLine(page);
    for (const child of geometry.children) {
      expect(child.top, child.name).toBeGreaterThanOrEqual(geometry.bar.top);
      expect(child.bottom, child.name).toBeLessThanOrEqual(geometry.bar.bottom);
    }
    expect(geometry.overflow).toBe(false);
    expect(geometry.title.width).toBeGreaterThanOrEqual(200);
    expect(geometry.title.right).toBeLessThanOrEqual(geometry.statuses.left + 0.5);
    expect(geometry.statuses.right).toBeLessThanOrEqual(geometry.actions.left + 0.5);
    expect(geometry.actions.right).toBeLessThanOrEqual(geometry.bar.right);

    await bar.getByRole("button", { name: "More Actions" }).click();
    const rows = page.getByRole("menu", { name: "Session Actions" }).locator("[role='menuitem'], [role='separator']");
    await expect(rows.nth(0)).toHaveText("Open Alpha");
    await expect(rows.nth(1)).toHaveText("Move to Another Project…");
    await expect(rows.nth(2)).toHaveAttribute("role", "separator");
  });
}

test("in the compact tier a short title reserves no more than its own width, even after a long one", async ({ page }) => {
  await openBar(page, 940);
  const title = page.locator("header.session-bar h1");
  await setTitle(page, LONG_TITLE);
  await expect.poll(() => title.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(200);
  await setTitle(page, "Fix it");
  await expect(title).toHaveText("Fix it");
  const short = await title.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return { box: element.getBoundingClientRect().width, text: range.getBoundingClientRect().width };
  });
  expect(short.box).toBeLessThan(100);
  expect(short.box - short.text).toBeLessThanOrEqual(1);
});

test("a generated title shows its first line in the bar and the window title", async ({ page }) => {
  await openBar(page, 1440);
  await setTitle(page, GENERATED_TITLE);
  const title = page.locator("header.session-bar h1");
  await expect(title).toHaveText("Add a dark mode toggle to the site header");
  await expect(title).toHaveAttribute("title", "Add a dark mode toggle to the site header");
  await expect(page).toHaveTitle("Add a dark mode toggle to the site header – Wollipog");
});

test.describe("phone", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("the top bar holds Back, the one-line title and the toggles, and every icon button has a 44px hit area", async ({ page }) => {
    await openBar(page, 390, { height: 844 });
    await setTitle(page, GENERATED_TITLE);
    const topbar = page.locator(".topbar");
    await expect(topbar.locator("h1")).toHaveText("Add a dark mode toggle to the site header");
    await expect(topbar.locator("h1")).toHaveCSS("font-size", "16px");
    await expect(topbar.locator("h1")).toHaveCSS("font-weight", "600");
    await expect(page).toHaveTitle("Add a dark mode toggle to the site header – Wollipog");
    await expect(page.locator(".session-project-button, .session-bar-project")).toHaveCount(0);
    await expect(topbar.getByRole("button")).toHaveText(["", "", "", ""]);
    await expect(topbar.getByRole("button").first()).toHaveAccessibleName("Back to Sessions");
    await expect(topbar.getByRole("button").first()).toHaveAttribute("title", "Back to Sessions");

    const targets = await page.evaluate(() => {
      const buttons = [
        ...document.querySelectorAll<HTMLElement>(".topbar button.icon-btn"),
        ...document.querySelectorAll<HTMLElement>(".session-bar .detail-actions button.icon-btn"),
      ];
      return buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const centerX = box.left + box.width / 2;
        const centerY = box.top + box.height / 2;
        // Each edge's midpoint of a 44×44 square on the button's centre (a rounded corner is not
        // part of any target, as in choice-rows.spec.ts). 1px inside rather than 0.5: neighbours'
        // targets abut exactly 8px apart, and Chromium hit-tests a half pixel on that seam as the
        // later neighbour's.
        const corners = [[0, -21], [21, 0], [0, 21], [-21, 0]].map(([dx, dy]) => {
          const hit = document.elementFromPoint(centerX + dx!, centerY + dy!);
          return hit === button || button.contains(hit);
        });
        return { name: button.getAttribute("aria-label"), width: box.width, height: box.height, corners };
      });
    });
    expect(targets.map((target) => target.name)).toEqual([
      "Back to Sessions",
      "Toggle Pinned Summary",
      "Show Terminal",
      "Show Side Panel",
      "+2: Show 2 Hidden Statuses",
      "Fork Conversation",
      "Share",
      "More Actions",
    ]);
    for (const target of targets) {
      expect(target.width, target.name!).toBe(36);
      expect(target.height, target.name!).toBe(36);
      expect(target.corners, target.name!).toEqual([true, true, true, true]);
    }

    await page.locator(".session-bar").getByRole("button", { name: "More Actions" }).click();
    const sheet = page.getByRole("menu", { name: "Session Actions" });
    await expect(sheet.locator(".menu-head")).toHaveText("Add a dark mode toggle to the site header");
    const rows = sheet.locator("[role='menuitem'], [role='separator']");
    await expect(rows.nth(0)).toHaveText("Open Alpha");
    await expect(rows.nth(1)).toHaveText("Move to Another Project…");
    await expect(rows.nth(2)).toHaveAttribute("role", "separator");
  });
});
