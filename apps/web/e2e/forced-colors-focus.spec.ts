import { expect, test, type Locator, type Page } from "@playwright/test";
import { RIGHT_PANEL_KEY_STEP } from "../src/right-panel.js";

/**
 * Keyboard focus in forced colors (#1890). Forced colors forces backgrounds to Canvas and drops box
 * shadows, so a focus indicator drawn with either vanishes in a contrast theme. The Resize Panel
 * separator drew its focus as a background fill under `outline: none`, and focusing it changed no
 * pixel at all. `forced-colors-focus.test.ts` keeps the stylesheet from doing that again; this spec
 * checks the separator really paints.
 */

// The Requests panel of a campaign with child requests: the session's own requests are on its dock.
const URL = "/request-surfaces-e2e.html?scenario=descendants";

async function openSeparator(page: Page, theme: "dark" | "light") {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(URL);
  await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
  await page.getByRole("button", { name: "Needs Your Input: 8 Requests" }).click();
  const separator = page.getByRole("separator", { name: "Resize Panel" });
  await expect(separator).toBeVisible();
  await page.mouse.move(0, 0);
  return separator;
}

/** The separator and a margin around it, where an outline would land. */
async function capture(page: Page, separator: Locator) {
  const box = (await separator.boundingBox())!;
  return page.screenshot({ clip: { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 } });
}

async function keyboardFocus(page: Page, separator: Locator) {
  await separator.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(separator).toBeFocused();
  expect(await separator.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
}

/**
 * Pixels that visibly differ between two same-size captures, and how many of `after`'s show `ink`
 * painted over `ground`. Chromium paints the forced focus ring translucent, so the ink is matched
 * as composited, not as declared. A difference of a channel step or two is antialiasing, not paint.
 */
async function comparePixels(page: Page, before: Buffer, after: Buffer, ink?: { color: string; ground: string }) {
  return page.evaluate(async ({ before, after, ink }) => {
    const decode = async (base64: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const probe = new OffscreenCanvas(1, 1).getContext("2d")!;
    if (ink) {
      probe.fillStyle = ink.ground;
      probe.fillRect(0, 0, 1, 1);
      probe.fillStyle = ink.color;
      probe.fillRect(0, 0, 1, 1);
    }
    const target = probe.getImageData(0, 0, 1, 1).data;
    const distance = (pixels: Uint8ClampedArray, index: number, other: ArrayLike<number>, at: number) =>
      Math.abs(pixels[index]! - other[at]!) + Math.abs(pixels[index + 1]! - other[at + 1]!) + Math.abs(pixels[index + 2]! - other[at + 2]!);
    const [a, z] = [await decode(before), await decode(after)];
    let changed = 0;
    let inked = 0;
    for (let index = 0; index < a.length; index += 4) {
      if (distance(z, index, a, index) > 6) changed += 1;
      if (ink && distance(z, index, target, 0) <= 6) inked += 1;
    }
    return { changed, inked };
  }, { before: before.toString("base64"), after: after.toString("base64"), ink });
}

for (const theme of ["dark", "light"] as const) {
  test(`the Resize Panel separator shows keyboard focus in forced colors (${theme})`, async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    const separator = await openSeparator(page, theme);
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    const rest = await capture(page, separator);

    await keyboardFocus(page, separator);
    const ring = await separator.evaluate((element) => {
      const style = getComputedStyle(element);
      const canvas = document.createElement("i");
      canvas.style.color = "Canvas";
      document.body.append(canvas);
      const canvasColor = getComputedStyle(canvas).color;
      canvas.remove();
      return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, canvas: canvasColor };
    });
    expect(ring).toMatchObject({ style: "solid", width: "2px" });
    expect(ring.color).not.toBe(ring.canvas);

    // The ring really paints, in its own system colour, not just in the computed style.
    const pixels = await comparePixels(page, rest, await capture(page, separator), { color: ring.color, ground: ring.canvas });
    expect(pixels.changed).toBeGreaterThan(40);
    expect(pixels.inked).toBeGreaterThan(40);

    // Focus still drives the separator from the keyboard.
    const width = Number(await separator.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", String(width + RIGHT_PANEL_KEY_STEP));
    await expect(separator).toBeFocused();
  });

  test(`the separator's forced-colors ring paints nothing without forced colors (${theme})`, async ({ page }) => {
    const separator = await openSeparator(page, theme);
    const rest = await capture(page, separator);
    await keyboardFocus(page, separator);
    const focused = await capture(page, separator);
    // The fill still marks focus, as it always has…
    expect((await comparePixels(page, rest, focused)).changed).toBeGreaterThan(40);
    // …and the outline adds nothing visible: the capture matches one with the outline switched off.
    await page.addStyleTag({ content: ".right-panel-resizer:focus-visible { outline: none !important; }" });
    expect((await comparePixels(page, focused, await capture(page, separator))).changed).toBe(0);
  });
}
