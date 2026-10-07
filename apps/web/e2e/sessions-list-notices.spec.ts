import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #2221 (docs/design-system.md §13.2, §6.3): one notice above the Sessions list, a quiet new-order line
 * under it, and the stacked list giving the head whole rows so the divider never moves and no row is
 * cut at it (#2217's deferred CR-1.1). Also the preview bar's badge, which collapses on the preview's
 * own width (#2219's follow-up).
 */

const FIXTURE = "/command-inbox-projects-e2e.html?scenario=preview-bar&fullShell=1&fill=24&machineName=Build%20Box";

async function open(page: Page, notices = ""): Promise<void> {
  const url = FIXTURE + (notices ? `&listNotices=${notices}` : "");
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);
  await expect(page.locator(".inbox-row").first()).toBeVisible();
  await expect(page.locator(".session-detail.preview header.session-preview-bar")).toBeVisible();
}

const head = (page: Page): Locator => page.locator(".inbox-list-pane > .inbox-list-head");
const slot = (page: Page): Locator => head(page).locator(".list-notice-slot");
const shownTitle = (page: Page): Locator => slot(page).locator(".notice-title");

type Split = {
  /** The divider's hairline: the list track's bottom edge. */
  line: number;
  /** Rows wholly between the list's scroll top and the line. */
  whole: number;
  /** Rows the line passes through. */
  cut: number;
  /** The last whole row's bottom edge. */
  lastBottom: number;
  rowHeight: number;
  headBottom: number;
  listTop: number;
};

async function split(page: Page): Promise<Split> {
  return page.locator(".inbox-view").evaluate((view) => {
    const list = view.querySelector<HTMLElement>(".inbox-list")!;
    const pane = view.querySelector<HTMLElement>(".inbox-list-pane")!.getBoundingClientRect();
    const scroller = list.getBoundingClientRect();
    const listHead = view.querySelector<HTMLElement>(".inbox-list-head")!.getBoundingClientRect();
    const line = pane.bottom;
    const rows = [...list.querySelectorAll<HTMLElement>(".inbox-row-shell")].map((row) => row.getBoundingClientRect());
    const whole = rows.filter((row) => row.top >= scroller.top - 0.5 && row.bottom <= line + 0.5);
    return {
      line,
      whole: whole.length,
      cut: rows.filter((row) => row.top < line - 0.5 && row.bottom > line + 0.5).length,
      lastBottom: Math.max(...whole.map((row) => row.bottom)),
      rowHeight: Number.parseFloat(getComputedStyle(view).getPropertyValue("--row-h-2")),
      headBottom: listHead.bottom,
      listTop: scroller.top,
    };
  });
}

/** Whole rows only, ending at the divider, which is where it is without a notice. */
async function expectWholeRowsAt(page: Page, line: number): Promise<Split> {
  await expect.poll(async () => {
    const measured = await split(page);
    return { line: measured.line, cut: measured.cut, endsAtLine: Math.abs(measured.lastBottom - measured.line) < 0.5 };
  }, { message: "the divider stays, no row is cut and the rows end at it" }).toEqual({ line, cut: 0, endsAtLine: true });
  const measured = await split(page);
  expect(measured.listTop).toBeGreaterThanOrEqual(measured.headBottom - 0.5);
  return measured;
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "touch tablet", width: 834, height: 1112, touch: true },
]) {
  test.describe(`at ${viewport.width}×${viewport.height} (${viewport.name}), stacked`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch });

    for (const [notices, title] of [["sign-in", "Sign In to Codex on Build Box"], ["skills", "Recommended Skills"]] as const) {
      test(`the ${title} notice takes whole rows: the divider stays and no row is cut`, async ({ page }) => {
        await open(page);
        const without = await split(page);
        expect(without.whole).toBe(6);
        expect(without.cut).toBe(0);

        await open(page, notices);
        await expect(shownTitle(page)).toHaveText(title);
        const withNotice = await expectWholeRowsAt(page, without.line);
        const headRows = Math.ceil((withNotice.headBottom - (without.line - 8 - 6 * without.rowHeight)) / without.rowHeight - 1e-6);
        expect(withNotice.whole).toBe(6 - headRows);
        expect(withNotice.whole).toBeGreaterThanOrEqual(1);
      });
    }

    test("the divider does not move when the notice goes", async ({ page }) => {
      await open(page, "skills");
      await expect(shownTitle(page)).toHaveText("Recommended Skills");
      const withNotice = await split(page);
      expect(withNotice.cut).toBe(0);
      await slot(page).getByRole("button", { name: "Dismiss All" }).click();
      await expect(slot(page)).toHaveCount(0);
      const after = await expectWholeRowsAt(page, withNotice.line);
      expect(after.whole).toBe(6);
    });
  });
}

test.describe("at 1440×900, stacked", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Recommended Skills is one body line, then one line of skills and Dismiss All", async ({ page }) => {
    await open(page, "skills");
    const notice = slot(page).locator(".notice");
    await expect(notice).toHaveAttribute("aria-label", "Recommended Skills");
    const layout = await notice.evaluate((element) => {
      const body = element.querySelector<HTMLElement>(".notice-body > p")!.getBoundingClientRect();
      const row = element.querySelector<HTMLElement>(".skill-recommendations-row")!;
      const centre = (item: Element) => {
        const rect = item.getBoundingClientRect();
        return rect.top + rect.height / 2;
      };
      const items = [...row.querySelectorAll(".skill-recommendations-list > li"), row.querySelector(".skill-recommendations-all")!];
      return {
        bodyHeight: body.height,
        rowHeight: row.getBoundingClientRect().height,
        centres: items.map(centre),
        dismissAll: row.querySelector(".skill-recommendations-all")!.textContent,
        noticeHeight: element.getBoundingClientRect().height,
      };
    });
    expect(layout.bodyHeight).toBe(20);
    expect(layout.dismissAll).toBe("Dismiss All");
    expect(layout.centres).toHaveLength(3);
    for (const centre of layout.centres) expect(Math.abs(centre - layout.centres[0]!)).toBeLessThan(1);
    expect(layout.rowHeight).toBeLessThanOrEqual(28);
    expect(layout.noticeHeight).toBeLessThanOrEqual(110);
  });

  test("a pending sign-in shows first, with +2 More naming the setup suggestion and Recommended Skills", async ({ page }) => {
    await open(page, "sign-in,skills,setup");
    await page.locator(".tabs-bar .tab", { hasText: "Alpha" }).first().click();
    await expect(slot(page).locator(".notice")).toHaveCount(1);
    await expect(shownTitle(page)).toHaveText("Sign In to Codex on Build Box");
    const notice = slot(page).locator(".notice");
    await expect(notice.locator(".code-well > code")).toHaveText("WXYZ-1234");
    await expect(notice.getByRole("link", { name: "Open Sign-In Page" })).toHaveAttribute("href", "https://auth.example.com/device");
    await expect(notice.getByRole("button", { name: "Cancel Sign-In" })).toBeVisible();
    await notice.getByRole("button", { name: "+2 More" }).click();
    const menu = page.getByRole("menu", { name: "Sessions Notices" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Set Up Alpha", "Recommended Skills"]);
  });

  test("new activity shows one quiet line under the slot, and Apply reorders without moving a control", async ({ page }) => {
    await open(page, "skills");
    await page.locator(".inbox-row").first().click();
    const stationary = () => page.locator(".page-header .page-actions > *, .tabs-tools > *, .master-detail-resize")
      .evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { name: element.className, left: rect.left, top: rect.top, right: rect.right };
      }));
    const before = await stationary();
    const rowIndex = () => page.locator(".inbox-row-shell").evaluateAll((rows) =>
      rows.findIndex((row) => row.textContent?.includes("Review Pull Request 20")));
    const indexBefore = await rowIndex();
    await page.evaluate(() => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-fill-20", {
        lastEventAt: Date.now() + 60_000,
        status: "running",
      });
    });
    const line = head(page).locator(".inbox-order-line");
    await expect(line).toBeVisible();
    await expect(line.locator("span")).toHaveText("New activity changed the order.");
    expect(await line.evaluate((element) => {
      const slotElement = element.parentElement!.querySelector(".list-notice-slot")!;
      return slotElement.getBoundingClientRect().bottom <= element.getBoundingClientRect().top;
    })).toBe(true);
    expect(await stationary()).toEqual(before);
    await expectWholeRowsAt(page, (await split(page)).line);

    await line.getByRole("button", { name: "Apply" }).click();
    await expect(line).toHaveCount(0);
    // The session was far down the list, past what is rendered; applying brings it up among the first.
    await expect.poll(rowIndex, { message: "the newest activity moves up" }).toBeGreaterThanOrEqual(0);
    const indexAfter = await rowIndex();
    expect(indexAfter).toBeLessThan(6);
    expect(indexBefore === -1 || indexBefore > indexAfter).toBe(true);
    expect(await stationary()).toEqual(before);
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("each skill is a 44px line and Dismiss All spans the notice", async ({ page }) => {
    await page.goto(FIXTURE + "&listNotices=skills");
    await page.evaluate(() => localStorage.clear());
    await page.goto(FIXTURE + "&listNotices=skills");
    const notice = page.locator(".inbox-list-head .notice");
    await expect(notice).toHaveAttribute("aria-label", "Recommended Skills");
    const layout = await notice.evaluate((element) => {
      const row = element.querySelector<HTMLElement>(".skill-recommendations-row")!.getBoundingClientRect();
      const all = element.querySelector<HTMLElement>(".skill-recommendations-all")!.getBoundingClientRect();
      return {
        lines: [...element.querySelectorAll(".skill-recommendations-list > li")].map((item) => item.getBoundingClientRect()),
        row: { left: row.left, width: row.width },
        all: { left: all.left, width: all.width, height: all.height },
      };
    });
    expect(layout.lines).toHaveLength(2);
    for (const line of layout.lines) expect(line.height).toBe(44);
    expect(layout.lines[1]!.top).toBeGreaterThanOrEqual(layout.lines[0]!.bottom - 0.5);
    expect(layout.all).toEqual({ left: layout.row.left, width: layout.row.width, height: 44 });
  });
});

test.describe("the preview bar's badge", () => {
  const status = (page: Page) => page.locator(".session-preview-bar .detail-bar-status");
  const titleWidth = (page: Page) => page.locator(".session-preview-bar .detail-bar-title")
    .evaluate((element) => ({ width: element.clientWidth, truncated: element.scrollWidth > element.clientWidth }));
  const choosePreviewRight = async (page: Page) => {
    await page.getByRole("radiogroup", { name: "Preview Layout" }).getByRole("radio", { name: "Preview Right" }).click();
    await expect(page.locator(".inbox-view")).toHaveAttribute("data-layout", "right");
  };

  test("in Preview Right at 1100×800 the badge is its dot, so the title keeps at least 200px", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await open(page);
    await choosePreviewRight(page);
    await expect(page.locator(".session-preview-bar .detail-bar-title"))
      .toHaveText("Migrate the Billing Tables to the New Schema and Verify Every Row Count");
    await expect(status(page)).toHaveAttribute("data-dot", "");
    await expect(status(page)).toHaveAttribute("title", /\S/);
    const title = await titleWidth(page);
    expect(title.width).toBeGreaterThanOrEqual(200);
  });

  for (const [width, height, right] of [[1100, 800, false], [1440, 900, false], [1440, 900, true]] as const) {
    test(`${right ? "Preview Right" : "stacked"} at ${width}×${height} keeps the full badge`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page);
      if (right) await choosePreviewRight(page);
      await expect(status(page)).not.toHaveAttribute("data-dot");
      expect((await titleWidth(page)).width).toBeGreaterThanOrEqual(200);
    });
  }
});
