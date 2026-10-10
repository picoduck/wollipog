import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The Files viewer (#2853) in a browser: one toolbar row that never wraps, even in a 320px panel,
 * where setting and clearing a target moves no other control; and no scroll box inside the panel, so
 * a 2,000-line file scrolls with the panel and its code scrolls only sideways.
 */

const CHECKLIST = "apps/web/src/checklist.tsx";
const LONG = "apps/runner/src/checkout.ts";

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/files-panel-e2e.html${query}`);
  await expect(page.locator(".files-viewer").first()).toBeVisible();
}

const viewerRow = (page: Page) => page.locator(".rpanel-toolbar .files-viewer-field > .toolbar");
const symbolField = (page: Page) => page.getByRole("textbox", { name: "Go to Symbol" });

/** Every control in the row and its box. */
async function controlBoxes(row: Locator): Promise<Record<string, { x: number; y: number; width: number; height: number }>> {
  return row.evaluate((element) => Object.fromEntries(
    [...element.querySelectorAll<HTMLElement>("input, button, .seg")]
      .filter((control) => !control.closest(".files-symbol-clear"))
      .map((control) => {
        const box = control.getBoundingClientRect();
        const name = control.getAttribute("aria-label") ?? control.className;
        return [name, { x: box.x, y: box.y, width: box.width, height: box.height }];
      }),
  ));
}

/** The row is one line: every control's vertical centre is the same, and the row is no taller than its tallest control. */
async function expectOneRow(row: Locator): Promise<void> {
  const boxes = Object.values(await controlBoxes(row));
  expect(boxes.length).toBeGreaterThanOrEqual(3);
  const centres = boxes.map((box) => Math.round(box.y + box.height / 2));
  expect(new Set(centres).size, `centres ${centres.join(", ")}`).toBe(1);
  const rowHeight = (await row.boundingBox())!.height;
  expect(rowHeight).toBeLessThanOrEqual(Math.max(...boxes.map((box) => box.height)) + 0.5);
}

for (const [label, viewport, panel] of [
  ["a 320px panel", { width: 1440, height: 900 }, 320],
  ["a 390px phone", { width: 390, height: 844 }, 0],
] as const) {
  test.describe(`in ${label}`, () => {
    test.use({ viewport, ...(panel ? {} : { hasTouch: true, isMobile: true }) });
    const query = panel ? `&panel=${panel}` : "";

    test("the toolbar is one row, and setting and clearing a target moves no other control", async ({ page }) => {
      await open(page, `?open=${CHECKLIST}${query}`);
      if (panel) expect((await page.locator("#right-panel").boundingBox())!.width).toBe(panel);
      const row = viewerRow(page);
      await expectOneRow(row);
      const before = await controlBoxes(row);

      await symbolField(page).fill("calculateTotal");
      await symbolField(page).press("Enter");
      await expect(page.locator(".cl.is-target mark")).toHaveText("calculateTotal");
      await expect(row.getByRole("button", { name: "Clear Target" })).toBeVisible();
      await expectOneRow(row);
      expect(await controlBoxes(row)).toEqual(before);

      await row.getByRole("button", { name: "Clear Target" }).click();
      await expect(page.locator(".cl.is-target")).toHaveCount(0);
      expect(await controlBoxes(row)).toEqual(before);

      // A miss is the field's error under the row; the row itself stays put.
      await symbolField(page).fill("calculateTax");
      await symbolField(page).press("Enter");
      await expect(page.locator(".rpanel-toolbar .field-error")).toHaveText("No symbol named “calculateTax” in this file.");
      expect(await controlBoxes(row)).toEqual(before);
    });

    test("rendered and source Markdown keep the row to one line", async ({ page }) => {
      await open(page, `?open=README.md${query}`);
      await expect(symbolField(page)).toHaveCount(0);
      await expectOneRow(viewerRow(page));
      await viewerRow(page).getByRole("radio", { name: "Source" }).click();
      await expect(symbolField(page)).toBeVisible();
      await expectOneRow(viewerRow(page));
    });
  });
}

/** The field's room for text, and the width its placeholder (and a typed `sample`) needs in the field's own font. */
async function symbolRoom(page: Page, sample: string): Promise<{ room: number; placeholder: number; sample: number }> {
  return symbolField(page).evaluate((input: HTMLInputElement, text) => {
    const style = getComputedStyle(input);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = style.font;
    return {
      room: input.clientWidth - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd),
      placeholder: context.measureText(input.placeholder).width,
      sample: context.measureText(text).width,
    };
  }, sample);
}

// #2913: beside Markdown's Preview and Source, Go to Symbol stays readable in a narrow panel. The
// control shows its icons and the placeholder shortens; their names do not change.
for (const [label, viewport, panel] of [
  ["a 320px panel", { width: 1440, height: 900 }, 320],
  ["a 390px phone", { width: 390, height: 844 }, 0],
] as const) {
  test.describe(`Markdown Source in ${label}`, () => {
    test.use({ viewport, ...(panel ? {} : { hasTouch: true, isMobile: true }) });
    const query = panel ? `&panel=${panel}` : "";

    test("Go to Symbol has room for its whole placeholder, and a target moves no other control", async ({ page }) => {
      await open(page, `?open=README.md${query}`);
      const row = viewerRow(page);
      await row.getByRole("radio", { name: "Source" }).click();
      await expect(row.getByRole("radio", { name: "Source" })).toHaveAttribute("aria-checked", "true");
      await expect(row.getByRole("radio", { name: "Preview" })).toBeVisible();
      await expect(symbolField(page)).toHaveAttribute("placeholder", "Symbol");
      await expectOneRow(row);
      const fit = await symbolRoom(page, "Sessi");
      expect(fit.room, `room ${fit.room} for a ${fit.placeholder}px placeholder`).toBeGreaterThanOrEqual(fit.placeholder);
      expect(fit.room).toBeGreaterThanOrEqual(fit.sample);

      const before = await controlBoxes(row);
      await symbolField(page).fill("Sessions");
      await symbolField(page).press("Enter");
      await expect(page.locator(".cl.is-target mark")).toHaveText("Sessions");
      await expectOneRow(row);
      expect(await controlBoxes(row)).toEqual(before);
      await row.getByRole("button", { name: "Clear Target" }).click();
      await expect(page.locator(".cl.is-target")).toHaveCount(0);
      expect(await controlBoxes(row)).toEqual(before);
    });

    test("a source file keeps the whole placeholder and the row's width", async ({ page }) => {
      await open(page, `?open=${CHECKLIST}${query}`);
      await expect(symbolField(page)).toHaveAttribute("placeholder", "Go to symbol");
      const fit = await symbolRoom(page, "");
      expect(fit.room).toBeGreaterThanOrEqual(fit.placeholder);
    });
  });
}

test.describe("at 400px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a 2,000-line file scrolls with the panel, the only vertical scroller, and its code scrolls sideways", async ({ page }) => {
    await open(page, `?open=${LONG}`);
    await expect(page.locator(".codeview .cl")).toHaveCount(2000);
    const scrollers = await page.locator("#right-panel *").evaluateAll((elements) => elements
      .filter((element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowY))
      .map((element) => element.className));
    expect(scrollers).toEqual(["rpanel-scroll"]);
    const view = await page.locator(".codeview").evaluate((element) => ({
      clipped: element.scrollHeight > element.clientHeight,
      sideways: element.scrollWidth > element.clientWidth,
      maxHeight: getComputedStyle(element).maxHeight,
    }));
    expect(view).toEqual({ clipped: false, sideways: true, maxHeight: "none" });

    const scroller = page.locator(".rpanel-scroll");
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(page.locator('.cl[data-source-line="2000"] > .tx')).toBeInViewport();
    // The toolbar stays fixed above the scroller.
    await expect(viewerRow(page)).toBeInViewport();

    // Scrolled sideways, the line numbers stay in place.
    const number = page.locator('.cl[data-source-line="1951"] > .ln');
    const x = (await number.boundingBox())!.x;
    await page.locator(".codeview").evaluate((element) => { element.scrollLeft = 200; });
    expect(await page.locator(".codeview").evaluate((element) => element.scrollLeft)).toBe(200);
    // Within a pixel: the sticky edge is the scrollport's, which layout rounds.
    expect(Math.abs((await number.boundingBox())!.x - x)).toBeLessThanOrEqual(1);
  });

  test("a line target scrolls to and marks its line", async ({ page }) => {
    await open(page, `?open=${LONG}&line=1500`);
    const line = page.locator('.cl[data-source-line="1500"]');
    await expect(line).toHaveClass(/is-target/u);
    await expect(line.locator(".tx")).toBeInViewport();
    const look = await line.locator(".tx").evaluate((element) => getComputedStyle(element).backgroundColor);
    const plain = await page.locator('.cl[data-source-line="1499"] > .tx').evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(look).not.toBe(plain);
    // Bringing the line into view never scrolls the code sideways, past the start of every line.
    expect(await page.locator(".codeview").evaluate((element) => element.scrollLeft)).toBe(0);
  });

  test("the code is drawn on the view's ground, not as the inline code chip", async ({ page }) => {
    await open(page, `?open=${CHECKLIST}`);
    const look = await page.locator(".codeview-lines").evaluate((element) => {
      const style = getComputedStyle(element);
      const plain = element.querySelector(".diff-syntax-plain")!;
      const probe = document.createElement("span");
      probe.style.color = "var(--text)";
      document.body.append(probe);
      const text = getComputedStyle(probe).color;
      probe.remove();
      return { background: style.backgroundColor, border: style.borderTopWidth, plain: getComputedStyle(plain).color === text };
    });
    expect(look).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px", plain: true });
  });

  test("Markdown Source keeps the worded Preview and Source and the whole placeholder", async ({ page }) => {
    await open(page, "?open=README.md");
    const row = viewerRow(page);
    await row.getByRole("radio", { name: "Source" }).click();
    await expect(row.getByRole("radio", { name: "Preview" })).toHaveText("Preview");
    await expect(row.getByRole("radio", { name: "Source" })).toHaveText("Source");
    await expect(row.locator(".seg-option svg")).toHaveCount(0);
    await expect(symbolField(page)).toHaveAttribute("placeholder", "Go to symbol");
  });

  test("with no editor found, File Actions shows Open in Editor… unavailable with its reason", async ({ page }) => {
    await open(page, `?open=${CHECKLIST}`);
    await viewerRow(page).getByRole("button", { name: "File Actions" }).click();
    const item = page.getByRole("menuitem", { name: "Open in Editor…" });
    await expect(item).toHaveAttribute("aria-disabled", "true");
    await expect(item).toContainText("No editor found on runner-1.");
  });

  test("a binary file and a truncated file say so", async ({ page }) => {
    await open(page, "?open=docs/logo.png");
    await expect(page.getByText("No Preview for This File")).toBeVisible();
    await expect(page.getByText("logo.png isn't text, so it can't be shown here.")).toBeVisible();
    await expect(page.locator(".files-viewer").getByRole("button", { name: "Copy Path" })).toBeVisible();

    await open(page, "?open=pnpm-lock.yaml");
    await expect(page.locator(".notice")).toHaveText("Showing the first 512 KB of 2.1 MB.");
  });
});
