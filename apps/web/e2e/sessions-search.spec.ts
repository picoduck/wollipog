import { expect, test, type Page } from "@playwright/test";

/**
 * The Sessions search (#2200), measured in a real browser: a field that never resizes, so focusing
 * and typing move nothing; 240px wide, 200px in the compact tier; `/` to reach it; tab counts that
 * follow the results; and No Matches with Clear Search and Search Transcripts. The harness mounts
 * the real InboxView with ten groups, two of whose sessions mention terraform.
 */

async function openGroups(page: Page) {
  await page.goto(`/sessions-board-e2e.html?groups=1&path=${encodeURIComponent("/")}`);
  await expect(page.getByRole("tablist", { name: "Session Groups" }).getByRole("tab")).toHaveCount(10);
}

const field = (page: Page) => page.getByRole("textbox", { name: "Search Sessions" });

/** Every control in the page header and the tab row, by a stable name, with its box. */
async function controlBoxes(page: Page, { tabs }: { tabs: boolean }) {
  return page.locator(".page-header").evaluate((header, includeTabs) => {
    const controls = [...header.querySelectorAll<HTMLElement>("button, input, [role='tab'], .tabs-tools > *")]
      .filter((control) => includeTabs || !control.closest(".tabs-bar > .tabs"));
    return Object.fromEntries(controls.map((control, index) => {
      const { x, y, width, height } = control.getBoundingClientRect();
      const name = control.getAttribute("aria-label") ?? control.getAttribute("title") ?? control.textContent?.trim();
      return [`${index}:${control.tagName}:${name}`, { x, y, width, height }];
    }));
  }, tabs);
}

test("focusing and typing in the field moves no other control in the header or tab row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);
  const resting = await controlBoxes(page, { tabs: true });
  expect(Object.keys(resting).length).toBeGreaterThan(14);

  await field(page).focus();
  await expect(field(page)).toBeFocused();
  expect(await controlBoxes(page, { tabs: true }), "focus moves nothing").toEqual(resting);

  await page.keyboard.type("terraform");
  await expect(page.locator(".inbox-row")).toHaveCount(2);
  // The tabs' own counts follow the results, so only the controls around them are compared.
  const restingOthers = await controlBoxes(page, { tabs: false });
  await field(page).fill("");
  await expect(page.locator(".inbox-row")).not.toHaveCount(2);
  expect(restingOthers).toEqual(await controlBoxes(page, { tabs: false }));
  await field(page).fill("terraform");
  expect(await controlBoxes(page, { tabs: false }), "typing moves nothing outside the tabs").toEqual(restingOthers);
});

for (const [width, height, expected] of [[1440, 900, 240], [940, 700, 200]] as const) {
  test(`the field is ${expected}px at ${width}px, in the UI font, one control tall`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openGroups(page);
    const metrics = await field(page).evaluate((input) => {
      const label = input.closest("label")!;
      const style = getComputedStyle(input);
      return {
        width: label.getBoundingClientRect().width,
        inputWidth: input.getBoundingClientRect().width,
        height: input.getBoundingClientRect().height,
        controlHeight: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-h")),
        font: style.fontFamily,
        uiFont: getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim(),
      };
    });
    expect(metrics.width).toBe(expected);
    expect(metrics.inputWidth).toBe(expected);
    expect(metrics.height).toBe(metrics.controlHeight);
    expect(metrics.font.replace(/\s+/g, "")).toBe(metrics.uiFont.replace(/\s+/g, ""));

    await field(page).focus();
    await page.keyboard.type("terraform");
    expect(await field(page).evaluate((input) => input.closest("label")!.getBoundingClientRect().width)).toBe(expected);
  });
}

test("/ focuses the field from the list, its keycap shows at rest, and Escape clears it, from No Matches too", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The app shell owns the / and Escape bindings.
  await page.goto(`/sessions-board-e2e.html?full-shell=1&groups=1&path=${encodeURIComponent("/")}`);
  await expect(page.locator(".inbox-search kbd")).toBeVisible();
  await page.getByRole("grid", { name: "Sessions", exact: true }).focus();
  await page.keyboard.press("/");
  await expect(field(page)).toBeFocused();
  await page.keyboard.type("terraform");
  await expect(page.locator(".inbox-row")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(field(page)).toHaveValue("");
  await expect(page.locator(".inbox-row").nth(2), "the whole list is back").toBeVisible();

  await field(page).fill("kubernetes");
  // F6 still enters the list zone while No Matches stands in for the list (§16.1).
  await page.locator('.rail-item[aria-current="page"]').first().focus();
  await page.keyboard.press("F6");
  await expect(page.locator(".inbox-state")).toBeFocused();
  const clear = page.locator(".inbox-state").getByRole("button", { name: "Clear Search" });
  await clear.focus();
  await page.keyboard.press("Escape");
  await expect(field(page)).toHaveValue("");
  await expect(page.locator(".inbox-state")).toHaveCount(0);
  await expect(page.getByRole("grid", { name: "Sessions", exact: true })).toBeFocused();
});

test("each tab counts its matches, a tab with none shows a faint 0 without a badge, and clearing restores the totals", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);
  const tab = (name: string) => page.getByRole("tablist", { name: "Session Groups" }).getByRole("tab", { name: new RegExp(`^${name}`) });
  const total = (await tab("All").locator(":scope > .count").textContent())!;
  expect(Number(total)).toBeGreaterThan(2);
  await expect(tab("Billing").locator(".count-badge").first(), "Billing has a session waiting on the user").toBeVisible();

  await field(page).fill("terraform");
  await expect(tab("All").locator(":scope > .count")).toHaveText("2");
  await expect(tab("Infrastructure").locator(":scope > .count")).toHaveText("1");
  await expect(tab("Billing").locator(":scope > .count")).toHaveText("1");
  await expect(tab("Billing").locator(".count-badge"), "the waiting session does not match").toHaveCount(0);
  const zero = tab("Design System").locator(":scope > .count");
  await expect(zero).toHaveText("0");
  await expect(tab("Design System").locator(".count-badge")).toHaveCount(0);
  const [zeroColor, faint] = await zero.evaluate((count) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-faint)";
    document.body.append(probe);
    const colors = [getComputedStyle(count).color, getComputedStyle(probe).color];
    probe.remove();
    return colors;
  });
  expect(zeroColor).toBe(faint);

  await field(page).fill("");
  await expect(tab("All").locator(":scope > .count")).toHaveText(total);
  await expect(tab("Design System").locator(":scope > .count")).toHaveText("1");
});

test("No Matches replaces both panes; Clear Search restores the list and Search Transcripts opens the palette with the query", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);
  await field(page).fill("kubernetes");
  const state = page.locator(".inbox-state .state");
  await expect(state.getByText("No Matches", { exact: true })).toBeVisible();
  await expect(state).toContainText("No sessions match “kubernetes” in any group.");
  await expect(page.locator(".inbox-preview-pane")).toHaveCount(0);
  await expect(page.locator(".master-detail-resize")).toHaveCount(0);

  await state.getByRole("button", { name: "Search Transcripts" }).click();
  const palette = page.getByRole("dialog", { name: "Search" });
  await expect(palette).toBeVisible();
  await expect(palette.locator(".palette-input")).toHaveValue("kubernetes");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(field(page)).toHaveValue("kubernetes");

  await state.getByRole("button", { name: "Clear Search" }).click();
  await expect(field(page)).toHaveValue("");
  await expect(page.locator(".inbox-state")).toHaveCount(0);
  await expect(page.locator(".inbox-row").nth(2), "the whole list is back").toBeVisible();
  await expect(page.locator(".inbox-preview-pane")).toBeVisible();
});

test("when the selected session leaves the results, the first result is selected and previewed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGroups(page);
  await page.locator(".inbox-row", { hasText: "Mobile App Session" }).click();
  await expect(page.locator(".session-preview-bar .detail-bar-title")).toHaveText("Mobile App Session");
  await field(page).fill("terraform");
  const selected = page.locator('.inbox-row-shell[aria-selected="true"] .inbox-row-title');
  await expect(page.locator(".inbox-row")).toHaveCount(2);
  const first = await page.locator(".inbox-row-title").first().textContent();
  await expect(selected).toHaveText(first!);
  await expect(page.locator(".session-preview-bar .detail-bar-title")).toHaveText(first!);
});


/**
 * A search shows a different set of rows, not a reorder of the old ones (#2804). Changing the query
 * shows its results from their first row, and clearing it shows the whole list from its first row,
 * while a live reorder and a return from a session keep the reader's row where it was. The `filters`
 * harness has 29 sessions, enough to scroll at both widths.
 */
const SCROLLING = `/sessions-board-e2e.html?filters=1&path=${encodeURIComponent("/")}`;
const grid = (page: Page) => page.getByRole("grid", { name: "Sessions", exact: true });

async function openScrolling(page: Page) {
  await page.goto(SCROLLING);
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "29");
}

/** The list once the virtualizer's anchor window (8 frames) has run out: its scroll offset and
 * the first row any part of which is in view, with that row's offset from the viewport's top. */
const settled = (page: Page) => grid(page).evaluate(async (list) => {
  for (let frame = 0; frame < 12; frame += 1) await new Promise(requestAnimationFrame);
  const top = list.getBoundingClientRect().top;
  const first = [...list.querySelectorAll<HTMLElement>("[data-virtual-row]")]
    .sort((left, right) => Number(left.dataset.index) - Number(right.dataset.index))
    .find((row) => row.getBoundingClientRect().bottom > top + 0.5);
  return {
    scrollTop: list.scrollTop,
    index: Number(first?.dataset.index),
    key: first?.dataset.virtualKey,
    offset: Math.round(first ? first.getBoundingClientRect().top - top : Number.NaN),
  };
});

/** Whether any of a session's row is in the list's viewport. */
const rowInView = (page: Page, sessionId: string) => grid(page).evaluate((list, id) => {
  const row = list.querySelector<HTMLElement>(`[data-virtual-key="${id}"]`);
  if (!row) return false;
  const rect = row.getBoundingClientRect();
  const view = list.getBoundingClientRect();
  return rect.bottom > view.top && rect.top < view.bottom;
}, sessionId);

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, phone: false },
  { name: "390×844", width: 390, height: 844, phone: true },
] as const) {
  test.describe(`the list's place across searches at ${viewport.name} (#2804)`, () => {
    test.use(viewport.phone
      ? { viewport: { width: viewport.width, height: viewport.height }, hasTouch: true, isMobile: true }
      : { viewport: { width: viewport.width, height: viewport.height } });

    async function search(page: Page, query: string) {
      // The phone app bar's Search opens the field (#2211); the desktop field is always there.
      if (viewport.phone && !(await field(page).isVisible())) {
        await page.locator(".sessions-app-bar").getByRole("button", { name: "Search Sessions" }).tap();
      }
      await field(page).fill(query);
    }

    test("clearing a search for a row below the first screen shows the whole list's first row", async ({ page }) => {
      await openScrolling(page);
      const start = await settled(page);
      expect(start).toMatchObject({ scrollTop: 0, index: 0 });
      // Build Session 15 sits well below the first screen of the whole list.
      expect(await rowInView(page, "s-build-14")).toBe(false);

      await search(page, "Build Session 15");
      await expect(grid(page)).toHaveAttribute("aria-rowcount", "1");
      expect((await settled(page)).key).toBe("s-build-14");

      await field(page).fill("");
      await expect(grid(page)).toHaveAttribute("aria-rowcount", "29");
      expect(await settled(page), "the whole list is back at its first row, not at the match").toMatchObject({
        scrollTop: 0,
        index: 0,
        key: start.key,
      });
      expect(await rowInView(page, "s-build-14")).toBe(false);
    });

    test("Clear Search from No Matches shows the whole list's first row, not the place read before", async ({ page }) => {
      await openScrolling(page);
      await grid(page).evaluate((list) => { list.scrollTop = list.scrollHeight; });
      expect((await settled(page)).scrollTop).toBeGreaterThan(0);

      await search(page, "kubernetes");
      const clear = page.locator(".inbox-state").getByRole("button", { name: "Clear Search" });
      if (viewport.phone) await clear.tap();
      else await clear.click();
      await expect(grid(page)).toHaveAttribute("aria-rowcount", "29");
      expect(await settled(page)).toMatchObject({ scrollTop: 0, index: 0 });
    });

    test("a search typed or refined in a scrolled list shows its first result", async ({ page }) => {
      await openScrolling(page);
      await grid(page).evaluate((list) => { list.scrollTop = list.scrollHeight; });
      expect((await settled(page)).scrollTop).toBeGreaterThan(0);

      await search(page, "Build");
      await expect(grid(page)).toHaveAttribute("aria-rowcount", "15");
      expect(await settled(page), "the first result is the first row in view").toMatchObject({ scrollTop: 0, index: 0 });

      await grid(page).evaluate((list) => { list.scrollTop = list.scrollHeight; });
      expect((await settled(page)).scrollTop).toBeGreaterThan(0);
      // The same fifteen rows answer the refined search, so only the query change can move the list.
      await field(page).fill("Build Session");
      await expect.poll(() => settled(page), { message: "a refined search starts at its first result too" })
        .toMatchObject({ scrollTop: 0, index: 0 });
      await expect(grid(page)).toHaveAttribute("aria-rowcount", "15");
    });

    test("returning from a session opened from the results keeps the reader's place", async ({ page }) => {
      await openScrolling(page);
      await search(page, "Session");
      await expect(grid(page)).toHaveAttribute("aria-rowcount", "29");
      await grid(page).evaluate((list) => { list.scrollTop = 400; });
      const reading = await settled(page);
      expect(reading.scrollTop).toBe(400);

      // The first row wholly in view: returning reveals the opened row, which moves a partly hidden one.
      const opened = await grid(page).evaluate((list) => {
        const top = list.getBoundingClientRect().top;
        return [...list.querySelectorAll<HTMLElement>("[data-virtual-row]")]
          .sort((left, right) => Number(left.dataset.index) - Number(right.dataset.index))
          .find((candidate) => candidate.getBoundingClientRect().top >= top)!.dataset.virtualKey!;
      });
      const row = page.locator(`[data-virtual-key="${opened}"] .inbox-row`);
      // A phone opens the session it is given; a desktop selects it, and Enter opens it.
      if (viewport.phone) {
        await row.tap();
      } else {
        await row.click();
        await grid(page).press("Enter");
      }
      await expect(page.getByRole("region", { name: "Session Activity" })).toBeVisible();
      await page.goBack();
      await expect(grid(page)).toBeVisible();
      await expect(field(page)).toHaveValue("Session");
      expect(await settled(page)).toMatchObject({ scrollTop: reading.scrollTop, key: reading.key });
    });
  });
}

// Only the desktop reorders live rows: a phone holds its order for the whole time the list is open.
test("a live reorder keeps the reader's row where it was (#2804)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openScrolling(page);
  // The desktop holds its order while the window has focus; leaving it is the boundary at which
  // live activity reorders the list (InboxView's browsing-order lease).
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  // The last row's session starts waiting on the user, which moves it above the reader's row.
  const lastKey = await grid(page).evaluate(async (list) => {
    list.scrollTop = list.scrollHeight;
    for (let frame = 0; frame < 4; frame += 1) await new Promise(requestAnimationFrame);
    return [...list.querySelectorAll<HTMLElement>("[data-virtual-row]")]
      .sort((left, right) => Number(right.dataset.index) - Number(left.dataset.index))[0]!.dataset.virtualKey!;
  });
  await grid(page).evaluate((list) => { list.scrollTop = 600; });
  const reading = await settled(page);
  expect(reading.index).toBeGreaterThan(3);

  await page.evaluate((id) => (window as unknown as {
    __updateSession: (sessionId: string, change: object) => void;
  }).__updateSession(id, {
    status: "input_required",
    pendingApproval: { requestId: "live-reorder", title: "Approve Command", options: [] },
    lastEventAt: Date.now(),
    updatedAt: Date.now(),
  }), lastKey);
  await expect.poll(() => grid(page).evaluate((list, id) =>
    Number(list.querySelector<HTMLElement>(`[data-virtual-key="${id}"]`)?.dataset.index), reading.key),
  { message: "the moved row lands above the reader's" }).toBe(reading.index + 1);
  const after = await settled(page);
  expect(after, "the reader's row keeps its offset").toMatchObject({ key: reading.key, offset: reading.offset });
  expect(after.scrollTop).toBeGreaterThan(reading.scrollTop);
});
