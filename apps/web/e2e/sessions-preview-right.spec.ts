import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #2219 (docs/design-system.md §6, §6.3): Preview Right, the Sessions list beside its preview, as a
 * per-device preference set from the Sessions header or Settings › Appearance › Display. Preview
 * Below stays the default, and Preview Right applies only in windows 1100px and wider.
 */

const FIXTURE = "/command-inbox-projects-e2e.html?scenario=preview-bar&fullShell=1&fill=24&history=1";
const IDLE = "Draft the Quarterly Report";

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(FIXTURE + query);
  await page.evaluate(() => localStorage.clear());
  await page.goto(FIXTURE + query);
  await expect(page.locator(".inbox-row").first()).toBeVisible();
  await expect(page.locator(".session-detail.preview header.session-preview-bar")).toBeVisible();
}

const layoutControl = (page: Page): Locator => page.getByRole("radiogroup", { name: "Preview Layout" });
const view = (page: Page): Locator => page.locator(".inbox-view");
const divider = (page: Page): Locator => page.getByRole("separator", { name: "Resize List and Preview" });

async function choosePreviewRight(page: Page): Promise<void> {
  await layoutControl(page).getByRole("radio", { name: "Preview Right" }).click();
  await expect(view(page)).toHaveAttribute("data-layout", "right");
}

type Columns = {
  listLeft: number;
  listWidth: number;
  listRight: number;
  previewLeft: number;
  previewTop: number;
  listTop: number;
  listBottom: number;
  previewBottom: number;
  /** Rows wholly inside the list's scroll box. */
  whole: number;
  rowHeight: number;
  snippetsShown: number;
};

async function columns(page: Page): Promise<Columns> {
  return view(page).evaluate((element) => {
    const pane = element.querySelector<HTMLElement>(".inbox-list-pane")!.getBoundingClientRect();
    const list = element.querySelector<HTMLElement>(".inbox-list")!.getBoundingClientRect();
    const preview = element.querySelector<HTMLElement>(".inbox-preview-pane")!.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>(".inbox-list .inbox-row-shell")].map((row) => row.getBoundingClientRect());
    return {
      listLeft: pane.left,
      listWidth: pane.width,
      listRight: pane.right,
      previewLeft: preview.left,
      previewTop: preview.top,
      listTop: pane.top,
      listBottom: pane.bottom,
      previewBottom: preview.bottom,
      whole: rows.filter((row) => row.top >= list.top - 0.5 && row.bottom <= list.bottom + 0.5).length,
      rowHeight: Number.parseFloat(getComputedStyle(element).getPropertyValue("--row-h-2")),
      snippetsShown: [...element.querySelectorAll<HTMLElement>(".inbox-row-snippet")]
        .filter((snippet) => getComputedStyle(snippet).display !== "none").length,
    };
  });
}

async function expectListWidth(page: Page, width: number): Promise<void> {
  await expect.poll(async () => (await columns(page)).listWidth, { message: `the list column is ${width}px` }).toBe(width);
  await expect(divider(page)).toHaveAttribute("aria-valuenow", String(width));
}

/** The divider's line, as computed styles of its pseudo-elements, and the tokens to compare with. */
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
    const preview = element.parentElement!.querySelector(".inbox-preview-pane")!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      line: { width: line.width, color: line.backgroundColor, left: box.left + Number.parseFloat(line.left) },
      grip: grip.display,
      cursor: getComputedStyle(element).cursor,
      band: box.width,
      previewLeft: preview.left,
      tokens,
    };
  });
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Preview Below is the default, and the header control names both layouts", async ({ page }) => {
    await open(page);
    await expect(view(page)).toHaveAttribute("data-layout", "below");
    const control = layoutControl(page);
    const below = control.getByRole("radio", { name: "Preview Below", exact: true });
    const right = control.getByRole("radio", { name: "Preview Right", exact: true });
    await expect(below).toHaveAttribute("aria-checked", "true");
    await expect(right).toHaveAttribute("aria-checked", "false");
    await expect(below).toHaveAttribute("title", "Preview below the list");
    await expect(right).toHaveAttribute("title", "Preview beside the list");
    // Right after List/Board, in the same slot.
    const order = await page.locator(".page-controls [role=radiogroup]").evaluateAll((groups) =>
      groups.map((group) => group.getAttribute("aria-label")));
    expect(order).toEqual(["Sessions View", "Preview Layout"]);
    await expect(divider(page)).toHaveAttribute("aria-orientation", "horizontal");
  });

  test("Preview Right puts the list beside the preview with at least 12 whole rows, and a reload keeps it", async ({ page }) => {
    await open(page);
    await choosePreviewRight(page);
    const measured = await columns(page);
    expect(measured.listWidth, "the list column's default width").toBe(400);
    expect(measured.previewLeft, "the preview starts where the list column ends").toBe(measured.listRight);
    expect(measured.previewTop, "side by side, not stacked").toBe(measured.listTop);
    expect(measured.previewBottom, "both fill the height under the header").toBe(measured.listBottom);
    expect(measured.whole).toBeGreaterThanOrEqual(12);
    // The column is under 880px, so rows keep the two-line anatomy without a snippet (#2209, #2218).
    expect(measured.snippetsShown).toBe(0);
    const rowHeight = await page.locator(".inbox-list .inbox-row-shell").first().evaluate((row) => row.getBoundingClientRect().height);
    expect(rowHeight).toBe(measured.rowHeight);
    await expect(divider(page)).toHaveAttribute("aria-orientation", "vertical");
    // The page never scrolls; each pane does.
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight)).toBe(true);

    await page.reload();
    await expect(page.locator(".inbox-row").first()).toBeVisible();
    await expect(view(page)).toHaveAttribute("data-layout", "right");
    await expect(layoutControl(page).getByRole("radio", { name: "Preview Right" })).toHaveAttribute("aria-checked", "true");
  });

  test("arrow keys move and select in the Preview Layout control", async ({ page }) => {
    await open(page);
    const below = layoutControl(page).getByRole("radio", { name: "Preview Below" });
    const right = layoutControl(page).getByRole("radio", { name: "Preview Right" });
    await below.focus();
    await page.keyboard.press("ArrowRight");
    await expect(right).toBeFocused();
    await expect(right).toHaveAttribute("aria-checked", "true");
    await expect(view(page)).toHaveAttribute("data-layout", "right");
    await page.keyboard.press("ArrowLeft");
    await expect(below).toBeFocused();
    await expect(below).toHaveAttribute("aria-checked", "true");
    await expect(view(page)).toHaveAttribute("data-layout", "below");
  });

  test("the divider resizes the list column within 280–440px, persists, and double-click resets to 400px", async ({ page }) => {
    await open(page);
    await choosePreviewRight(page);
    await expect(divider(page)).toHaveAttribute("aria-valuemin", "280");
    await expect(divider(page)).toHaveAttribute("aria-valuemax", "440");
    await expectListWidth(page, 400);

    // At rest the divider is the 1px hairline on the preview's first pixel, with no grip.
    let paint = await dividerPaint(page);
    expect(paint.line.width).toBe("1px");
    expect(paint.line.color).toBe(paint.tokens.border);
    expect(paint.line.left).toBe(paint.previewLeft);
    expect(paint.grip).toBe("none");
    expect(paint.cursor).toBe("col-resize");
    expect(paint.band).toBe(4);

    // Keys: 16px steps, Home and End at the bounds, Enter back to the default.
    await divider(page).focus();
    await page.keyboard.press("ArrowLeft");
    await expectListWidth(page, 384);
    // Keyboard focus draws the line at 2px --focus, with no ring beside it.
    paint = await dividerPaint(page);
    expect(paint.line).toMatchObject({ width: "2px", color: paint.tokens.focus });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expectListWidth(page, 416);
    await page.keyboard.press("End");
    await expectListWidth(page, 440);
    await page.keyboard.press("ArrowRight");
    await expectListWidth(page, 440);
    await page.keyboard.press("Home");
    await expectListWidth(page, 280);
    await page.keyboard.press("ArrowLeft");
    await expectListWidth(page, 280);
    await page.keyboard.press("Enter");
    await expectListWidth(page, 400);
    await divider(page).blur();

    // Hover draws the grip: the line at 2px --border-strong.
    const box = (await divider(page).boundingBox())!;
    const y = box.y + box.height / 2;
    const x = box.x + box.width / 2;
    await page.mouse.move(x, y);
    paint = await dividerPaint(page);
    expect(paint.line).toMatchObject({ width: "2px", color: paint.tokens.borderStrong });

    // A drag follows the pointer and stays within the bounds.
    await page.mouse.down();
    await page.mouse.move(x - 60, y, { steps: 6 });
    expect((await columns(page)).listWidth, "the column follows the pointer").toBe(340);
    await page.mouse.move(x + 200, y, { steps: 6 });
    expect((await columns(page)).listWidth, "never past 440px").toBe(440);
    await page.mouse.move(x - 300, y, { steps: 6 });
    expect((await columns(page)).listWidth, "never under 280px").toBe(280);
    await page.mouse.move(x - 52, y, { steps: 4 });
    await page.mouse.up();
    await expectListWidth(page, 348);

    await page.reload();
    await expect(page.locator(".inbox-row").first()).toBeVisible();
    await expectListWidth(page, 348);

    // A press and release that does not move keeps the stored width.
    const again = (await divider(page).boundingBox())!;
    await divider(page).click({ position: { x: again.width / 2, y: again.height / 2 } });
    await expectListWidth(page, 348);
    await divider(page).dblclick({ position: { x: again.width / 2, y: again.height / 2 } });
    await expectListWidth(page, 400);
  });

  test("the preview's bar, meta line, docked request and transcript are inset --space-6 from the divider", async ({ page }) => {
    await open(page);
    await choosePreviewRight(page);
    // The fixture opens on the blocked session, whose request is docked at the top of the preview.
    await expect(page.locator(".session-detail.preview .session-notice-slot .request-dock")).toBeVisible();
    const inset = async () => page.evaluate(() => {
      const left = (element: Element | null | undefined) => element?.getBoundingClientRect().left ?? Number.NaN;
      const scroll = document.querySelector(".session-detail.preview .detail-scroll")!;
      const scrollTop = scroll.getBoundingClientRect().top;
      const firstTurn = [...scroll.querySelectorAll(".tl-row")].find((row) => row.getBoundingClientRect().bottom > scrollTop);
      return {
        divider: left(document.querySelector(".inbox-preview-pane")),
        space6: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-6")),
        title: left(document.querySelector(".session-preview-bar .detail-bar-title")),
        meta: left(document.querySelector(".session-preview-facts > li")),
        dock: left(document.querySelector(".session-detail.preview .session-notice-slot .request-dock")),
        turn: left(firstTurn),
      };
    });
    const blocked = await inset();
    expect(blocked.space6).toBe(24);
    for (const name of ["title", "meta", "dock"] as const) {
      expectGeometry(Math.abs(blocked[name] - blocked.divider - blocked.space6), `the ${name} starts --space-6 from the divider`)
        .toBeLessThanOrEqual(0.61);
    }

    await page.locator(".inbox-row").filter({ hasText: IDLE }).click();
    await expect(page.locator(".session-detail.preview .detail-scroll .tl-row").first()).toBeVisible();
    const idle = await inset();
    expectGeometry(Math.abs(idle.turn - idle.divider - idle.space6), "the first transcript turn starts --space-6 from the divider")
      .toBeLessThanOrEqual(0.61);
  });

  test("Settings › Appearance › Display shows the same layout, and changing either updates the other without a reload", async ({ page }) => {
    await open(page);
    await choosePreviewRight(page);
    const loads: string[] = [];
    page.on("load", () => loads.push(page.url()));

    await page.getByRole("button", { name: "Settings" }).first().click();
    const row = page.getByRole("radiogroup", { name: "Sessions Layout" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("radio", { name: "Preview Right" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Preview Right applies in windows 1100px and wider.")).toBeVisible();
    await row.getByRole("radio", { name: "Preview Below" }).click();
    await expect(row.getByRole("radio", { name: "Preview Below" })).toHaveAttribute("aria-checked", "true");

    await page.goBack();
    await expect(view(page)).toHaveAttribute("data-layout", "below");
    await expect(layoutControl(page).getByRole("radio", { name: "Preview Below" })).toHaveAttribute("aria-checked", "true");
    await choosePreviewRight(page);

    await page.goForward();
    await expect(page.getByRole("radiogroup", { name: "Sessions Layout" }).getByRole("radio", { name: "Preview Right" }))
      .toHaveAttribute("aria-checked", "true");
    expect(loads, "no step reloaded the page").toEqual([]);
  });

  test("the Board has no Preview Layout control and ignores the preference", async ({ page }) => {
    await open(page);
    await choosePreviewRight(page);
    const views = page.getByRole("radiogroup", { name: "Sessions View" });
    const before = await views.boundingBox();
    await views.getByRole("radio", { name: "Board" }).click();
    await expect(page.locator(".inbox-view.board-mode")).toBeVisible();
    await expect(layoutControl(page)).toHaveCount(0);
    await expect(page.locator(".sessions-preview-layout")).toHaveCSS("visibility", "hidden");
    expect(await views.boundingBox(), "List / Board stays under the pointer (#2159)").toEqual(before);
    await expect(view(page)).not.toHaveAttribute("data-layout", /./);
    await expect(divider(page)).toHaveCount(0);
  });
});

test.describe("across the 1100px threshold", () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test("at 1099px Preview Right stacks and the control hides; at 1100px it is side by side again", async ({ page }) => {
    await open(page);
    await choosePreviewRight(page);
    await expect(layoutControl(page)).toBeVisible();

    await page.setViewportSize({ width: 1099, height: 800 });
    await expect(view(page)).toHaveAttribute("data-layout", "below");
    await expect(layoutControl(page)).toHaveCount(0);
    await expect(divider(page)).toHaveAttribute("aria-orientation", "horizontal");

    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(view(page)).toHaveAttribute("data-layout", "right");
    await expect(layoutControl(page).getByRole("radio", { name: "Preview Right" })).toHaveAttribute("aria-checked", "true");
    await expect(divider(page)).toHaveAttribute("aria-orientation", "vertical");
    const measured = await columns(page);
    expect(measured.listWidth).toBe(400);
    expect(measured.previewLeft).toBe(measured.listRight);
  });
});

test.describe("at 390×844 (phone)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the control is absent and the stored preference changes nothing", async ({ page }) => {
    await page.goto(FIXTURE);
    // The instance-scoped key (instance-storage.ts) for the fixture's instance.
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("wollipog.instance.v1:17:project-inbox-e2e31:wollipog.sessions.previewLayout", "right");
    });
    await page.goto(FIXTURE);
    await expect(page.locator(".inbox-row").first()).toBeVisible();
    await expect(layoutControl(page)).toHaveCount(0);
    await expect(page.locator(".inbox-preview-pane")).toHaveCount(0);
    await expect(view(page)).not.toHaveAttribute("data-layout", /./);
  });
});
