import { expect, type Locator } from "@playwright/test";
import { expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

export async function expectAssistantControlLayout(dialog: Locator, width: number, layoutTargets: string) {
  await expectNoHorizontalOverflow(dialog);
  await expectPageNoHorizontalOverflow(dialog.page());
  const controls = await dialog.locator(layoutTargets).evaluateAll((elements) => elements.flatMap((element) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    const { x, y, width, height } = rect;
    const style = getComputedStyle(element);
    const node = element.matches("label") ? element.querySelector("input")! : element;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const pixel = canvas.getContext("2d", { willReadFrequently: true })!;
    // Computed backgrounds can be color(srgb …), such as a tinted selected choice.
    const rgb = (value: string) => {
      pixel.clearRect(0, 0, 1, 1);
      pixel.fillStyle = value;
      pixel.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = pixel.getImageData(0, 0, 1, 1).data;
      return [red!, green!, blue!, alpha! / 255];
    };
    const foreground = rgb(style.color);
    const overlays: number[][] = [];
    let backgrounds: number[][] = [[255, 255, 255]];
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const gradientColors = ancestorStyle.backgroundImage.match(/rgba?\([^)]+\)/g);
      if (gradientColors) {
        backgrounds = gradientColors.map(rgb);
        break;
      }
      const color = rgb(ancestorStyle.backgroundColor);
      const alpha = color[3] ?? 1;
      if (alpha === 1) {
        backgrounds = [color];
        break;
      }
      if (alpha > 0) overlays.unshift(color);
    }
    const luminance = (channels: number[]) => [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
      const sRGB = channels[index]! / 255;
      return sum + weight * (sRGB <= 0.04045 ? sRGB / 12.92 : ((sRGB + 0.055) / 1.055) ** 2.4);
    }, 0);
    const color = luminance(foreground);
    const contrasts = backgrounds.map((background) => {
      const composite = overlays.reduce((under, over) => {
        const alpha = over[3] ?? 1;
        return under.map((channel, index) => channel * (1 - alpha) + over[index]! * alpha);
      }, background.slice(0, 3));
      const luminanceBehind = luminance(composite);
      return (Math.max(color, luminanceBehind) + 0.05) / (Math.min(color, luminanceBehind) + 0.05);
    });
    return [{ label: element.textContent?.trim() || element.getAttribute("aria-label") || element.tagName,
      x, y, width, height, font: Number.parseFloat(style.fontSize), enabled: !node.matches(":disabled,[aria-disabled=true]"),
      region: element.closest(".modal-head, .modal-body, .modal-foot")?.className,
      contrast: Math.min(...contrasts) }];
  }));
  const minimum = width === 390 ? 44 : 24;
  for (const control of controls) {
    expect(control.width, control.label).toBeGreaterThanOrEqual(minimum - 0.01);
    expect(control.height, control.label).toBeGreaterThanOrEqual(minimum - 0.01);
    expect(control.font, control.label).toBeGreaterThanOrEqual(12);
    if (control.enabled) expect(control.contrast, control.label).toBeGreaterThanOrEqual(4.5);
  }
  if (width !== 390) return;
  for (const [index, a] of controls.entries()) {
    for (const b of controls.slice(index + 1)) {
      // A clipped control in the scrolling body can have a box behind the fixed header or footer.
      if (a.region !== b.region) continue;
      const horizontalGap = Math.max(a.x - b.x - b.width, b.x - a.x - a.width);
      const verticalGap = Math.max(a.y - b.y - b.height, b.y - a.y - a.height);
      expect(Math.max(horizontalGap, verticalGap), `${a.label} / ${b.label}`).toBeGreaterThanOrEqual(7.99);
    }
  }
}
