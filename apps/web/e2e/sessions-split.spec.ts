import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #2217 (docs/design-system.md §6.3): the Sessions list over its preview, as whole rows. The list is
 * the stored ratio of the split area (default 0.45) rounded down to whole `--row-h-2` rows plus its
 * 8px top pad, at least three rows, and never so tall that the preview drops under 240px. Rows are
 * exactly their token tall (#2209), so every position below is exact rather than font-dependent.
 */

const FIXTURE = "/command-inbox-projects-e2e.html?scenario=preview-bar&fullShell=1&fill=12";
const BLOCKED = "Migrate the Billing Tables to the New Schema and Verify Every Row Count";

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(FIXTURE + query);
  await page.evaluate(() => localStorage.clear());
  await page.goto(FIXTURE + query);
  await expect(page.locator(".inbox-row").first()).toBeVisible();
  await expect(page.locator(".session-detail.preview header.session-preview-bar")).toBeVisible();
}

const divider = (page: Page): Locator => page.getByRole("separator", { name: "Resize List and Preview" });

type Split = {
  /** The divider's hairline: the list track's bottom edge. */
  line: number;
  listTop: number;
  area: number;
  rowHeight: number;
  previewHeight: number;
  /** Rows wholly between the list's scroll top and the line. */
  whole: number;
  /** Rows the line passes through. */
  cut: number;
  band: { top: number; height: number };
  listScrollTop: number;
};

async function split(page: Page): Promise<Split> {
  return page.locator(".inbox-view").evaluate((view) => {
    const list = view.querySelector<HTMLElement>(".inbox-list")!;
    const pane = view.querySelector<HTMLElement>(".inbox-list-pane")!.getBoundingClientRect();
    const scroller = list.getBoundingClientRect();
    const band = view.querySelector<HTMLElement>(".master-detail-resize")!.getBoundingClientRect();
    const preview = view.querySelector<HTMLElement>(".inbox-preview-pane")!.getBoundingClientRect();
    const line = pane.bottom;
    const rows = [...list.querySelectorAll<HTMLElement>(".inbox-row-shell")].map((row) => row.getBoundingClientRect());
    return {
      line,
      listTop: scroller.top,
      area: view.getBoundingClientRect().height,
      rowHeight: Number.parseFloat(getComputedStyle(view).getPropertyValue("--row-h-2")),
      previewHeight: preview.height,
      whole: rows.filter((row) => row.top >= scroller.top - 0.5 && row.bottom <= line + 0.5).length,
      cut: rows.filter((row) => row.top < line - 0.5 && row.bottom > line + 0.5).length,
      band: { top: band.top, height: band.height },
      listScrollTop: list.scrollTop,
    };
  });
}

async function expectRows(page: Page, rows: number): Promise<Split> {
  await expect.poll(async () => {
    const { whole, cut } = await split(page);
    return { whole, cut };
  }, { message: `${rows} whole rows over the divider and none cut` }).toEqual({ whole: rows, cut: 0 });
  return split(page);
}

/** The hairline the divider draws, and the grip, as computed styles of its pseudo-elements. */
async function dividerPaint(page: Page) {
  return divider(page).evaluate((element) => {
    const line = getComputedStyle(element, "::before");
    const grip = getComputedStyle(element, "::after");
    const probe = document.createElement("span");
    element.parentElement!.append(probe);
    const resolve = (token: string) => {
      probe.style.backgroundColor = `var(${token})`;
      return getComputedStyle(probe).backgroundColor;
    };
    const tokens = { border: resolve("--border"), borderStrong: resolve("--border-strong"), focus: resolve("--focus") };
    probe.remove();
    return {
      line: { height: line.height, color: line.backgroundColor },
      grip: { width: grip.width, height: grip.height, color: grip.backgroundColor },
      outline: getComputedStyle(element).outlineColor,
      tokens,
    };
  });
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, touch: false, band: 9, grip: ["32px", "4px"] },
  { name: "touch tablet", width: 834, height: 1112, touch: true, band: 17, grip: ["40px", "6px"] },
]) {
  test.describe(`at ${viewport.width}×${viewport.height} (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch });

    test("the default ratio shows six whole rows over the divider and cuts none", async ({ page }) => {
      await open(page);
      const measured = await expectRows(page, 6);
      // The list track is the 8px pad and six rows; the band is centred on its 1px hairline.
      expect(measured.line - measured.listTop).toBe(8 + 6 * measured.rowHeight);
      expect(measured.band.height).toBe(viewport.band);
      expect(measured.band.top + measured.band.height / 2).toBe(measured.line + 0.5);
      const paint = await dividerPaint(page);
      expect(paint.line).toEqual({ height: "1px", color: paint.tokens.border });
      expect(paint.grip).toEqual({ width: viewport.grip[0], height: viewport.grip[1], color: paint.tokens.borderStrong });
      await expect(divider(page)).toHaveAttribute("aria-orientation", "horizontal");
      await expect(divider(page)).toHaveAttribute("aria-valuenow",
        String(Math.round(((measured.line - measured.listTop) / measured.area) * 100)));
      // The page itself never scrolls; each pane does.
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight)).toBe(true);
    });
  });
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("F6 into the preview, then Shift+Tab, reaches the divider, and its keys move it by whole rows", async ({ page }) => {
    await open(page);
    await page.locator(".inbox-row").filter({ hasText: BLOCKED }).click();
    const grid = page.getByRole("grid");
    await expect(grid).toBeFocused();
    // Tab and Shift+Tab in the list still switch groups (epic #2227 keeps the binding; #2180).
    const selectedTab = page.getByRole("tablist", { name: "Session Groups" }).locator('[role="tab"][aria-selected="true"]');
    await expect(selectedTab).toHaveText(/^All/);
    await page.keyboard.press("Tab");
    await expect(selectedTab).toHaveText(/^Alpha/);
    await page.keyboard.press("Shift+Tab");
    await expect(selectedTab).toHaveText(/^All/);
    await expect(grid).toBeFocused();

    // The divider's keyboard path: F6 into the preview, then Shift+Tab back through it.
    await page.keyboard.press("F6");
    await expect(page.locator(".inbox-preview-pane .detail-scroll")).toBeFocused();
    let presses = 0;
    while (presses < 12 && !(await divider(page).evaluate((element) => element === document.activeElement))) {
      await page.keyboard.press("Shift+Tab");
      presses += 1;
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".inbox-preview-pane, .master-detail-resize"))),
        "Shift+Tab walks back through the preview, not into another group").toBe(true);
    }
    await expect(divider(page)).toBeFocused();
    await expect(selectedTab, "walking back to the divider switches no group").toHaveText(/^All/);
    let paint = await dividerPaint(page);
    expect(paint.line).toEqual({ height: "2px", color: paint.tokens.focus });
    expect(paint.outline, "no ring beside the line; forced colors paints the transparent one").toBe("rgba(0, 0, 0, 0)");

    await page.keyboard.press("ArrowUp");
    await expectRows(page, 5);
    await page.keyboard.press("Home");
    await expectRows(page, 3);
    await page.keyboard.press("End");
    const tallest = await expectRows(page, 9);
    expect(tallest.previewHeight).toBeGreaterThanOrEqual(240);
    expect(tallest.previewHeight - tallest.rowHeight, "one more row would leave the preview under 240px").toBeLessThan(240);
    await expect(divider(page)).toHaveAttribute("aria-valuemin", String(Math.round(((8 + 3 * 56) / tallest.area) * 100)));
    await expect(divider(page)).toHaveAttribute("aria-valuemax", String(Math.round(((8 + 9 * 56) / tallest.area) * 100)));
    await page.keyboard.press("Enter");
    await expectRows(page, 6);
    await page.keyboard.press("ArrowDown");
    await expectRows(page, 7);
    await page.locator(".inbox-row").first().hover();
    paint = await dividerPaint(page);
    expect(paint.line.color, "focus still draws the focus line").toBe(paint.tokens.focus);
  });

  test("hovering draws the line at 2px, and a drag follows the pointer and snaps to the nearer row on release", async ({ page }) => {
    await open(page);
    const before = await expectRows(page, 6);
    const box = (await divider(page).boundingBox())!;
    const x = box.x + box.width / 4;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    const hovered = await dividerPaint(page);
    expect(hovered.line).toEqual({ height: "2px", color: hovered.tokens.borderStrong });

    await page.mouse.down();
    await page.mouse.move(x, y + 1.4 * before.rowHeight, { steps: 6 });
    const during = await split(page);
    expect(during.line - before.line, "the line follows the pointer").toBeCloseTo(1.4 * before.rowHeight, 0);
    expect(during.cut, "mid-drag the line may cross a row").toBe(1);
    await page.mouse.up();
    const seven = await expectRows(page, 7);

    // Less than half a row snaps back; more than half moves on.
    const again = (await divider(page).boundingBox())!;
    const line = again.y + again.height / 2;
    for (const [rows, expected] of [[0.4, 7], [0.6, 6]] as const) {
      await page.mouse.move(x, line);
      await page.mouse.down();
      await page.mouse.move(x, line - rows * seven.rowHeight, { steps: 4 });
      await page.mouse.up();
      await expectRows(page, expected);
    }

    await divider(page).focus();
    await page.keyboard.press("End");
    await expectRows(page, 9);
    await divider(page).dblclick({ position: { x: box.width / 4, y: box.height / 2 } });
    await expectRows(page, 6);
  });

  test("a resized list keeps its rows across a reload, and resizing scrolls neither pane", async ({ page }) => {
    await open(page);
    await page.locator(".inbox-list").evaluate((list) => { list.scrollTop = 100; });
    // Reading back through the transcript leaves Jump to Latest, so the preview holds its place.
    const transcript = page.locator(".session-detail.preview .detail-scroll");
    const transcriptBox = (await transcript.boundingBox())!;
    await page.mouse.move(transcriptBox.x + transcriptBox.width / 2, transcriptBox.y + transcriptBox.height - 20);
    await page.mouse.wheel(0, -160);
    let reading = -1;
    await expect.poll(async () => {
      const previous = reading;
      reading = await transcript.evaluate((scroller) => scroller.scrollTop);
      return reading === previous;
    }, { message: "the transcript settles where the reader left it" }).toBe(true);
    await divider(page).focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => (await split(page)).line).toBe(100 + 8 + 4 * 56);
    expect((await split(page)).listScrollTop).toBe(100);
    expect(await transcript.evaluate((scroller) => scroller.scrollTop)).toBe(reading);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await split(page)).line).toBe(100 + 8 + 7 * 56);
    expect((await split(page)).listScrollTop).toBe(100);
    expect(await transcript.evaluate((scroller) => scroller.scrollTop)).toBe(reading);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");

    await page.reload();
    await expect(page.locator(".inbox-row").first()).toBeVisible();
    await expectRows(page, 4);
  });

  test("a recommended-skills notice above the list takes rows, not the divider's place", async ({ page }) => {
    await open(page);
    const without = await expectRows(page, 6);
    await open(page, "&skills=list");
    await expect(page.locator(".inbox-list-pane > .inbox-list-head .notice")).toBeVisible();
    const withNotice = await split(page);
    expect(withNotice.line).toBe(without.line);
    expect(withNotice.whole).toBeLessThan(6);
    // The notice takes whole rows, so none is cut at the divider (#2221).
    expect(withNotice.cut).toBe(0);
  });

  test("F6 cycles the list and the preview, and Escape in the preview returns to the selected row", async ({ page }) => {
    await open(page);
    await page.locator(".inbox-row").filter({ hasText: BLOCKED }).click();
    const grid = page.getByRole("grid");
    await expect(grid).toBeFocused();
    const selected = await grid.getAttribute("aria-activedescendant");
    await page.keyboard.press("F6");
    await expect(page.locator(".inbox-preview-pane .detail-scroll")).toBeFocused();
    await page.keyboard.press("Shift+F6");
    await expect(grid).toBeFocused();
    await page.keyboard.press("F6");
    await page.keyboard.press("Escape");
    await expect(grid).toBeFocused();
    await expect(grid).toHaveAttribute("aria-activedescendant", selected!);
  });
});

test.describe("at 390×844 (phone)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the list is the page: no preview and no divider", async ({ page }) => {
    await page.goto(FIXTURE);
    await expect(page.locator(".inbox-row").first()).toBeVisible();
    await expect(page.getByRole("separator")).toHaveCount(0);
    await expect(page.locator(".inbox-preview-pane")).toHaveCount(0);
  });
});

// The docked request card heads the preview, and the transcript scrolls beneath it: the card's slot
// draws an edge over the transcript and keeps --space-2 between the card and the first visible row.
for (const viewport of [{ width: 1440, height: 900, touch: false }, { width: 834, height: 1112, touch: true }]) {
  test.describe(`docked request at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch });

    for (const theme of ["light", "dark"] as const) {
      test(`the transcript scrolls beneath a visible edge in the ${theme} theme`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await open(page);
        const slot = page.locator(".session-detail.preview .detail-chat > .session-notice-slot");
        await expect(slot.locator(".request-dock")).toBeVisible();
        const transcript = page.locator(".session-detail.preview .detail-scroll");
        // Leave a row straddling the transcript's top edge, as reading back through it does.
        await transcript.evaluate((scroller) => { scroller.scrollTop = Math.max(0, scroller.scrollHeight / 2); });
        const geometry = await slot.evaluate((element) => {
          const scroller = element.parentElement!.querySelector<HTMLElement>(".detail-scroll")!;
          const top = scroller.getBoundingClientRect().top;
          const card = element.querySelector<HTMLElement>(".request-dock")!.getBoundingClientRect();
          const firstVisible = [...scroller.querySelectorAll<HTMLElement>(".timeline-row, .tl-row, [data-index]")]
            .map((row) => row.getBoundingClientRect())
            .find((row) => row.bottom > top && row.height > 0);
          const style = getComputedStyle(element);
          const page = getComputedStyle(document.documentElement);
          const probe = document.createElement("span");
          probe.style.boxShadow = "var(--elev-1)";
          probe.style.backgroundColor = "var(--border)";
          element.append(probe);
          const elevation = getComputedStyle(probe).boxShadow;
          const border = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return {
            gap: Math.max(top, firstVisible?.top ?? top) - card.bottom,
            space2: Number.parseFloat(page.getPropertyValue("--space-2")),
            hasRow: firstVisible !== undefined,
            shadow: style.boxShadow,
            elevation,
            hairline: { width: style.borderBottomWidth, style: style.borderBottomStyle, color: style.borderBottomColor },
            border,
            background: style.backgroundColor,
            onTop: (() => {
              const hit = document.elementFromPoint(card.left + 4, element.getBoundingClientRect().bottom - 1);
              return hit !== null && element.contains(hit);
            })(),
          };
        });
        expect(geometry.hasRow, "a transcript row is in view beneath the dock").toBe(true);
        expect(geometry.gap).toBeGreaterThanOrEqual(geometry.space2);
        expect(geometry.shadow).toBe(geometry.elevation);
        expect(geometry.hairline, "a hairline that reads on a dark canvas too")
          .toEqual({ width: "1px", style: "solid", color: geometry.border });
        expect(geometry.background, "an opaque slot, so the transcript passes beneath it").not.toBe("rgba(0, 0, 0, 0)");
        expect(geometry.onTop, "the slot paints over the transcript").toBe(true);
      });
    }
  });
}
