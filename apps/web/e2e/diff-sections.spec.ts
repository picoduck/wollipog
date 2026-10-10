import { expect, test, type Page } from "@playwright/test";

/**
 * Review's changed files as flush sections (#2848; docs/design-system.md §2.8, §2.10, §7.5, §11.3):
 * one-line hunk headers at the panel's narrowest, folder-first path truncation, Side by Side only
 * when the panel can hold it, the collapsed file index, wrapped lines, a stage race on its own file
 * and the discard confirmation as a phone sheet. The harness is the real side panel over a fixture
 * diff (`diff-sections-main.tsx`).
 */

const CHECKOUT = "apps/shop/src/features/checkout/components/payment/CheckoutPage.tsx";

async function open(page: Page, query: string, viewport = { width: 1100, height: 860 }) {
  await page.setViewportSize(viewport);
  await page.goto(`/diff-sections-e2e.html?${query}`);
  await expect(page.locator(".dfile").first()).toBeVisible();
}

async function viewOption(page: Page, name: string) {
  await page.getByRole("button", { name: "View Options" }).click();
  return page.getByRole("menu", { name: "View Options" }).locator(`[data-menu-label="${name}"]`);
}

test("at a 320px panel every hunk header is one line, and Stage Hunk shows on hover with a mouse", async ({ page }) => {
  await open(page, "width=320");
  const headers = page.locator(".diff-hunk-header");
  const heights = await headers.evaluateAll((elements) => elements.map((element) => {
    const text = element.querySelector(".diff-hunk-header-text")!;
    return {
      header: Math.round(element.getBoundingClientRect().height),
      lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)),
      truncated: text.scrollWidth > text.clientWidth,
    };
  }));
  expect(heights.length).toBeGreaterThan(3);
  for (const measured of heights) {
    expect(measured.header, "one --control-h row").toBe(32);
    expect(measured.lines).toBe(1);
  }
  expect(heights.some((measured) => measured.truncated), "the range text truncates rather than wrapping").toBe(true);

  const stage = page.locator(".dfile").first().locator(".diff-hunk").first().getByRole("button", { name: "Stage Hunk" });
  await page.mouse.move(0, 0);
  await expect(stage).toHaveCSS("opacity", "0");
  await page.locator(".dfile").first().locator(".diff-hunk").first().hover();
  await expect(stage).toHaveCSS("opacity", "1");
  const box = (await stage.boundingBox())!;
  const panel = (await page.locator("#right-panel").boundingBox())!;
  expect(box.x + box.width, "the button stays inside the panel").toBeLessThanOrEqual(panel.x + panel.width);
  expect(Math.round(box.height)).toBe(28);
});

test.describe("on touch", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("Stage Hunk is always shown, 36px, and the header stays one line at 320px", async ({ page }) => {
    await open(page, "width=320");
    const stages = page.locator(".hunk-stage");
    await expect(stages.first()).toHaveCSS("opacity", "1");
    expect(Math.round((await stages.first().boundingBox())!.height)).toBe(36);
    for (const header of await page.locator(".diff-hunk-header").all()) {
      const text = header.locator(".diff-hunk-header-text");
      const lineHeight = await text.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
      expect((await text.boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 1);
    }
  });
});

test("a long path truncates its folder and keeps the file name whole, with the full path as its tooltip", async ({ page }) => {
  await open(page, "width=320");
  const path = page.locator(`.dfile[data-path="${CHECKOUT}"] .dfile-path`);
  await expect(path).toHaveAttribute("title", CHECKOUT);
  const fit = await path.evaluate((element) => {
    const dir = element.querySelector<HTMLElement>(".dfile-dir")!;
    const name = element.querySelector<HTMLElement>(".dfile-name")!;
    return {
      dirTruncated: dir.scrollWidth > dir.clientWidth,
      nameWhole: name.scrollWidth <= name.clientWidth,
      name: name.textContent,
    };
  });
  expect(fit).toEqual({ dirTruncated: true, nameWhole: true, name: "CheckoutPage.tsx" });
});

test("Side by Side waits for a 720px panel, and expanded each column scrolls on its own", async ({ page }) => {
  await open(page, "width=400", { width: 1440, height: 900 });
  const split = await viewOption(page, "Side by Side");
  await expect(split).toHaveAttribute("aria-disabled", "true");
  await expect(split).toContainText("Expand the panel to compare side by side.");
  await expect(await page.getByRole("menu", { name: "View Options" }).locator('[data-menu-label="Unified"]'))
    .toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  await page.locator(".rpanel-head").getByRole("button", { name: "Expand Panel" }).click();
  await expect(page.locator("#right-panel")).toHaveAttribute("data-presentation", "expanded");
  const enabled = await viewOption(page, "Side by Side");
  await expect(enabled).not.toHaveAttribute("aria-disabled", "true");
  await enabled.click();
  const run = page.locator(`.dfile[data-path="${CHECKOUT}"] .dsplit`).first();
  await expect(run.locator("> .side")).toHaveCount(2);

  const sides = run.locator("> .side");
  const measure = () => sides.evaluateAll((elements) => elements.map((side) => {
    const box = side.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      scrollLeft: side.scrollLeft,
      overflows: side.scrollWidth > side.clientWidth,
      clips: getComputedStyle(side).overflowX,
    };
  }));
  const before = await measure();
  expect(before[0]!.right).toBeLessThanOrEqual(before[1]!.left + 1);
  expect(before.map((side) => side.clips), "each column clips and scrolls its own text").toEqual(["auto", "auto"]);
  expect(before[1]!.overflows, "the new side's long line overflows only its own column").toBe(true);
  await sides.nth(1).evaluate((side) => { side.scrollLeft = 200; });
  const after = await measure();
  expect(after[1]!.scrollLeft).toBeGreaterThan(0);
  expect(after[0]!.scrollLeft, "the other column stays put").toBe(0);
  // Rows stay level across the two columns.
  const tops = await sides.evaluateAll((elements) => elements.map((side) =>
    [...side.children].map((row) => Math.round(row.getBoundingClientRect().top))));
  expect(tops[0]).toEqual(tops[1]);
});

test("Collapse All Files leaves one line per file, and choosing one opens it at the top", async ({ page }) => {
  // Short enough that the opened file and what follows it overflow the scroller beside the commit bar.
  await open(page, "width=400", { width: 1100, height: 560 });
  await (await viewOption(page, "Collapse All Files")).click();
  const sections = page.locator(".dfile");
  const rows = await sections.evaluateAll((elements) => elements.map((element) => ({
    height: Math.round(element.getBoundingClientRect().height),
    body: element.querySelector(".dfile-body") !== null,
  })));
  expect(rows.length).toBe(7);
  for (const row of rows) expect(row).toEqual({ height: 33, body: false }); // 32px row and its hairline

  const target = page.locator('.dfile[data-path="apps/shop/src/cart/cart-store.ts"]');
  await target.locator(".dfile-toggle").click();
  await expect(target.locator(".dfile-body")).toBeVisible();
  // At the top of the scroller, or as near it as the scroller goes when the file is near the end.
  await expect.poll(() => target.evaluate((section) => {
    const scroller = section.closest<HTMLElement>(".rpanel-scroll")!;
    const offset = Math.round(section.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
    const atEnd = Math.ceil(scroller.scrollTop + scroller.clientHeight) >= scroller.scrollHeight;
    return { inView: offset >= -1 && offset < scroller.clientHeight, atTopOrEnd: offset <= 0 || atEnd, scrolled: scroller.scrollTop > 0 };
  }), { message: "the chosen file is scrolled to the top" }).toEqual({ inView: true, atTopOrEnd: true, scrolled: true });
});

test("Wrap Long Lines wraps code and keeps each line number beside its first line", async ({ page }) => {
  await open(page, "width=400");
  await (await viewOption(page, "Wrap Long Lines")).click();
  const rows = await page.locator(`.dfile[data-path="${CHECKOUT}"] .diff-line`).evaluateAll((elements) => elements.map((row) => {
    const text = row.querySelector(".diff-text")!.getBoundingClientRect();
    const gutter = [...row.querySelectorAll(".diff-gutter")].find((node) => getComputedStyle(node).display !== "none")!.getBoundingClientRect();
    return {
      height: row.getBoundingClientRect().height,
      textRight: text.right,
      rowRight: row.getBoundingClientRect().right,
      gutterTop: Math.round(gutter.top),
      textTop: Math.round(text.top),
    };
  }));
  expect(rows.some((row) => row.height > 30), "a long line wraps onto more lines").toBe(true);
  for (const row of rows) {
    expect(row.textRight, "no code past the row").toBeLessThanOrEqual(row.rowRight + 1);
    expect(Math.abs(row.gutterTop - row.textTop), "the number sits on the first line").toBeLessThanOrEqual(3);
  }
});

test("a stage race shows its warning at the top of that file, with Refresh", async ({ page }) => {
  await open(page, "width=400&stale=1");
  const file = page.locator(`.dfile[data-path="${CHECKOUT}"]`);
  await file.locator(".diff-hunk").first().hover();
  await file.locator(".diff-hunk").first().getByRole("button", { name: "Stage Hunk" }).click();
  const alert = file.getByRole("alert");
  await expect(alert).toContainText("CheckoutPage.tsx changed after this diff loaded, so the hunk wasn't staged.");
  await expect(alert.getByRole("button", { name: "Refresh" })).toBeVisible();
  const head = (await file.locator(".dfile-head").boundingBox())!;
  const notice = (await alert.boundingBox())!;
  const hunk = (await file.locator(".diff-hunk").first().boundingBox())!;
  expect(notice.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
  expect(notice.y + notice.height).toBeLessThanOrEqual(hunk.y + 1);
  await expect(page.getByRole("alert")).toHaveCount(1);
});

test.describe("on a phone", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("Discard Changes and Discard New File confirm in a sheet with two equal 48px buttons", async ({ page }) => {
    await open(page, "", { width: 390, height: 844 });
    for (const [path, title, message] of [
      [CHECKOUT, "Discard Changes", "go back to its last commit"],
      ["apps/shop/src/features/checkout/CheckoutPage.test.tsx", "Discard New File", "discarding it deletes it"],
    ] as const) {
      await page.getByRole("button", { name: `${path} Actions` }).click();
      await page.getByRole("menuitem", { name: `${title}…` }).click();
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(message);
      await expect(dialog.locator(".confirmation-rows .row-title.mono")).toHaveText(path);
      const buttons = dialog.locator(".modal-foot button");
      await expect(buttons).toHaveText(["Cancel", title]);
      await expect(buttons.first()).toBeFocused();
      const [cancel, confirm] = [(await buttons.nth(0).boundingBox())!, (await buttons.nth(1).boundingBox())!];
      expect(Math.round(cancel.height)).toBe(48);
      expect(Math.round(confirm.height)).toBe(48);
      expect(Math.abs(cancel.width - confirm.width)).toBeLessThanOrEqual(1);
      const sheet = (await dialog.boundingBox())!;
      expect(sheet.width, "a full-width sheet").toBeGreaterThanOrEqual(389);
      expect(Math.round(sheet.y + sheet.height), "anchored to the bottom").toBeGreaterThanOrEqual(843);
      await buttons.first().click();
      await expect(dialog).toBeHidden();
    }
  });
});
