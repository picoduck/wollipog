import { expect, test, type Locator } from "@playwright/test";
import { motionSettled } from "./dialog-motion.js";

/**
 * Discard's label against what is actually painted behind it: its own fill composited over the
 * nearest opaque ancestor, which is the file head row. The canvas does the compositing, so a
 * `color-mix(…, transparent)` hover tint is measured as Chromium blends it, not as declared.
 */
async function paint(locator: Locator) {
  // Buttons ease color and background over 130ms, so a reading taken mid-transition is neither
  // state. Settle first.
  await motionSettled(locator);
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const composite = (...layers: string[]) => {
      context.clearRect(0, 0, 1, 1);
      for (const layer of layers) {
        context.fillStyle = layer;
        context.fillRect(0, 0, 1, 1);
      }
      return [...context.getImageData(0, 0, 1, 1).data] as [number, number, number, number];
    };
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    let backdrop: Element | null = element.parentElement;
    while (backdrop && composite(getComputedStyle(backdrop).backgroundColor)[3] < 255) backdrop = backdrop.parentElement;
    const style = getComputedStyle(element);
    const ground = composite(getComputedStyle(backdrop ?? document.body).backgroundColor, style.backgroundColor);
    const ink = composite(style.color);
    const [hi, lo] = [luminance(ink), luminance(ground)].sort((a, b) => b - a) as [number, number];
    return { ink, ground, contrast: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 };
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`Discard stays a legible red at rest and on hover in every ${theme} palette`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 400 });
    for (const scheme of ["wollipog", "github", "one-dark", "dracula", "monokai"] as const) {
      await page.goto(`/diff-discard-e2e.html?scheme=${scheme}&theme=${theme}`);
      const discard = page.getByRole("button", { name: "Discard" });
      await expect(discard).toBeEnabled();

      await page.mouse.move(0, 0);
      const rest = await paint(discard);
      await discard.hover();
      const hover = await paint(discard);
      const context = `${scheme}:${theme}`;
      for (const [state, measured] of [["rest", rest], ["hover", hover]] as const) {
        expect.soft(measured.contrast, `${context} ${state}`).toBeGreaterThanOrEqual(4.5);
        // Still the destructive hue: red leads both other channels.
        const [r, g, b] = measured.ink;
        expect(r > g && r > b, `${context} ${state} ink rgb(${r} ${g} ${b}) must stay red`).toBe(true);
      }
      // The fix changes the label, not the feedback: hover still tints the button.
      expect(hover.ground, `${context} hover must still repaint the button`).not.toEqual(rest.ground);
    }
  });
}
