import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The Board's unboxed columns and its Machine and Agent filters in the Sessions tab row (#2201),
 * against the sessions-board harness's `filters` scenario: Studio Mac and Build Server 02, an
 * agent each machine reports unavailable, a 70-character agent name, and 29 active sessions of
 * which 10 run Claude Code. Nothing is Done, so that column is a strip.
 */

async function openBoard(page: Page, scenario = "filters") {
  await page.goto(`/sessions-board-e2e.html?${scenario}&path=${encodeURIComponent("/board")}`);
  await expect(page.locator(".board .card").first()).toBeVisible();
}

const tabRow = (page: Page) => page.locator(".page-tabs .tabs-bar");

/**
 * Drag a card onto a column the way a person does (#2201): press, start the drag, wait for the
 * empty strips to open to full width, then aim at the column where it now is and release.
 * `locator.dragTo` measures its target before the drag starts, so it aims at a 40px strip that
 * opens under the pointer mid-gesture.
 */
async function dragCardToColumn(page: Page, card: Locator, column: Locator) {
  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 16);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + 28, { steps: 2 });
  await expect(page.locator(".board")).toHaveClass(/is-dragging/);
  await column.scrollIntoViewIfNeeded();
  const to = (await column.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 120), { steps: 4 });
  await page.mouse.up();
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("there is no second toolbar: the first card starts directly under the tab row", async ({ page }) => {
    await openBoard(page);
    await expect(page.locator(".board-wrap > .toolbar, .board-count")).toHaveCount(0);
    await expect(page.locator(".board-wrap select, .tabs-tools select")).toHaveCount(0);
    const gap = await page.evaluate(() => {
      const row = document.querySelector(".page-tabs")!.getBoundingClientRect();
      const card = document.querySelector(".board .card")!.getBoundingClientRect();
      const head = document.querySelector(".board .column-head")!.getBoundingClientRect();
      return { card: card.top - row.bottom, head: head.top - row.bottom, headHeight: head.height };
    });
    // The board's inset, then the column header, then the card: no 70px toolbar between them.
    expect(gap.head).toBeLessThanOrEqual(16);
    expect(gap.card).toBeLessThanOrEqual(gap.head + gap.headHeight + 8);
  });

  test("columns are unboxed, their headers plain, and an empty one a 40px strip that takes a drop", async ({ page }) => {
    await openBoard(page);
    const styles = await page.locator(".board .column").evaluateAll((columns) => columns.map((column) => {
      const style = getComputedStyle(column);
      const head = getComputedStyle(column.querySelector(".column-head")!);
      return {
        id: [...column.classList].find((name) => name.startsWith("col-")),
        border: style.borderTopWidth,
        background: style.backgroundColor,
        transform: head.textTransform,
        spacing: head.letterSpacing,
        width: column.getBoundingClientRect().width,
        title: column.querySelector(".column-title")?.textContent,
      };
    }));
    expect(styles.map((column) => column.title)).toEqual(["Queued", "Running", "Needs Input", "Review", "Done"]);
    for (const column of styles) {
      expect(column.border, `${column.id} has no border`).toBe("0px");
      expect(column.background, `${column.id} has no fill`).toBe("rgba(0, 0, 0, 0)");
      expect(column.transform, `${column.id}'s header is not uppercased`).toBe("none");
      expect(column.spacing, `${column.id}'s header is not tracked`).toBe("normal");
    }
    const done = styles.find((column) => column.id === "col-done")!;
    expect(done.width).toBe(40);
    expect(styles.find((column) => column.id === "col-running")!.width).toBeGreaterThan(230);
    await expect(page.locator(".column.col-done .column-head")).toHaveCSS("writing-mode", "vertical-rl");

    const card = page.locator(".column.col-running .card").first();
    const sessionId = await card.getAttribute("data-session-id");
    await dragCardToColumn(page, card, page.locator(".column.col-done"));
    await expect.poll(() => page.evaluate(() => window.__setColumnCalls))
      .toEqual([{ sessionId, column: "done" }]);
    await expect(page.locator(`.column.col-done .card[data-session-id="${sessionId}"]`)).toBeVisible();
    await expect(page.locator(".column.col-done")).not.toHaveClass(/is-empty/);
  });

  test("an Agent names its button, is pressed, shows 10 of 29 and Clear, and Clear resets both", async ({ page }) => {
    await openBoard(page);
    const tools = page.locator(".tabs-tools");
    const machine = tools.getByRole("button", { name: "All Machines" });
    const agent = tools.getByRole("button", { name: "All Agents" });
    await expect(agent).toHaveAttribute("aria-pressed", "false");
    await expect(tools.getByRole("button", { name: "Clear", exact: true })).toHaveCount(0);

    await agent.click();
    const menu = page.getByRole("menu", { name: "Agent" });
    await expect(menu.getByRole("group")).toHaveText([/^Studio Mac/, /^Build Server 02/]);
    const gemini = menu.getByRole("group", { name: "Studio Mac" }).getByRole("menuitemradio", { name: "Gemini CLI" });
    await expect(gemini).toHaveAttribute("aria-disabled", "true");
    await expect(gemini).toContainText("Gemini CLI is not installed on this machine.");
    // A 70-character name stays inside the 320px menu instead of widening it.
    expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(320);
    await menu.getByRole("group", { name: "Studio Mac" }).getByRole("menuitemradio", { name: "Claude Code" }).click();

    const chosen = tools.getByRole("button", { name: "Claude Code" });
    await expect(chosen).toHaveAttribute("aria-pressed", "true");
    await expect(tools.locator(".board-filter-note")).toHaveText("10 of 29");
    await expect(page.locator(".board .card")).toHaveCount(10);
    await expect(page.locator(".column.col-queued")).toHaveClass(/is-empty/);

    await machine.click();
    await page.getByRole("menu", { name: "Machine" }).getByRole("menuitemradio", { name: "Build Server 02" }).click();
    await expect(tools.getByRole("button", { name: "Build Server 02" })).toHaveAttribute("aria-pressed", "true");
    const state = page.locator(".state");
    await expect(state.locator(".state-title")).toHaveText("No Matching Sessions");
    await expect(state).toContainText("29 sessions are hidden by the current Machine and Agent filters.");

    await tools.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(tools.getByRole("button", { name: "All Machines" })).toHaveAttribute("aria-pressed", "false");
    await expect(tools.getByRole("button", { name: "All Agents" })).toHaveAttribute("aria-pressed", "false");
    await expect(tools.locator(".board-filter-note")).toHaveCount(0);
    await expect(page.locator(".state")).toHaveCount(0);
  });
});

test.describe("at 940×700", () => {
  test.use({ viewport: { width: 940, height: 700 } });

  test("one Filters button, named by its count, leaves room for three group tabs and search", async ({ page }) => {
    await openBoard(page, "groups&filters");
    const tools = page.locator(".tabs-tools");
    await expect(tools.getByRole("button", { name: "All Machines" })).toHaveCount(0);
    const filters = tools.getByRole("button", { name: "Filters", exact: true });
    await expect(filters).toHaveAttribute("aria-pressed", "false");

    await filters.click();
    const menu = page.getByRole("menu", { name: "Filters" });
    await expect(menu.locator(':scope > [role="group"]')).toHaveCount(2);
    await menu.getByRole("group", { name: "Agent" }).getByRole("group", { name: "Studio Mac" })
      .getByRole("menuitemradio", { name: "Claude Code" }).click();

    const set = tools.getByRole("button", { name: "Filters, 1 Active", exact: true });
    await expect(set).toHaveAttribute("aria-pressed", "true");
    await expect(tools.locator(".board-filter-note")).toHaveText(/^10 of \d+$/);

    const fit = await tabRow(page).evaluate((bar) => {
      const tabs = bar.querySelector(".tabs")!.getBoundingClientRect();
      const tools = bar.querySelector(".tabs-tools")!.getBoundingClientRect();
      const search = bar.querySelector(".inbox-search")!.getBoundingClientRect();
      const whole = [...bar.querySelectorAll('[role="tab"]')].filter((tab) => {
        const box = tab.getBoundingClientRect();
        return box.left >= tabs.left - 0.5 && box.right <= tabs.right + 0.5;
      }).length;
      return { whole, sameRow: tools.top < tabs.bottom && tools.bottom > tabs.top, searchShown: search.width > 0, clear: tabs.right <= tools.left };
    });
    expect(fit.whole).toBeGreaterThanOrEqual(3);
    expect(fit.sameRow).toBe(true);
    expect(fit.searchShown).toBe(true);
    expect(fit.clear).toBe(true);
  });
});

test.describe("on a 390×844 phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Filters sit on a row under the app bar, and an empty column is still a strip", async ({ page }) => {
    await openBoard(page);
    // The phone app bar (#2211) has no tab row: Board mode's Filters and count get a row of their
    // own under it, until the phone Board's Filters sheet (#2216).
    const tools = page.locator(".sessions-app-bar-tools");
    const inside = () => tools.evaluate((row) => {
      const box = row.getBoundingClientRect();
      return [...row.querySelectorAll(":scope > *")].every((child) => {
        const rect = child.getBoundingClientRect();
        return rect.left >= box.left - 0.5 && rect.right <= Math.min(box.right, innerWidth) + 0.5;
      });
    });
    expect(await inside(), "Filters fits the row unfiltered").toBe(true);
    expect((await page.locator(".column.col-done").boundingBox())!.width).toBe(40);

    await tools.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("menu", { name: "Filters" }).getByRole("group", { name: "Studio Mac" })
      .getByRole("menuitemradio", { name: "Claude Code" }).click();
    await expect(tools.locator(".board-filter-note")).toHaveText("10 of 29");
    expect(await inside(), "and with a filter and its count").toBe(true);
    expect((await page.locator(".column.col-queued").boundingBox())!.width).toBe(40);
  });
});
