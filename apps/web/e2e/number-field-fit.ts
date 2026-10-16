import { expect, type Locator, type Page } from "@playwright/test";
import { pinWidestFace } from "./font-geometry.js";

/** The 96px number fields (§8.3) in `scope`, as `.input-affix.w-xs` wrappers. */
export const numberFields = (scope: Locator | Page) => scope.locator(".input-affix.w-xs");

/**
 * Every 96px number field in `scope` shows its whole value, and its unit sits beside the value
 * inside the field (#3185).
 *
 * The UI font is the system's, so the fields are first drawn in the widest verified face (CI's
 * Ubuntu falls back to DejaVu Sans), unit included. A value is cut when it is wider than the content
 * box (measured in the field's own font) or when the engine scrolls it, which also catches room the
 * engine keeps for itself, such as a number field's spin buttons. A unit covers the value when it
 * starts inside the content box, and leaves the field when it ends past the inner edge.
 */
export async function expectNumberFieldsWhole(page: Page, scope: Locator | Page, what: string) {
  const fields = numberFields(scope);
  await pinWidestFace(page, fields);
  await page.evaluate(() => document.fonts.ready);
  const misfits = await fields.evaluateAll((wraps) => wraps.flatMap((wrap) => {
    const input = wrap.querySelector<HTMLInputElement>(":scope > input")!;
    const style = getComputedStyle(input);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const px = (value: string) => Number.parseFloat(value);
    // The layout width, not clientWidth: Firefox reports an input's clientWidth without its padding.
    const inner = input.offsetWidth - px(style.borderLeftWidth) - px(style.borderRightWidth);
    const room = inner - px(style.paddingLeft) - px(style.paddingRight);
    const width = context.measureText(input.value).width;
    const found: string[] = [];
    if (width > room || input.scrollWidth > input.clientWidth) {
      found.push(`"${input.value}" at ${style.fontSize} is cut: ${width.toFixed(1)}px in ${room.toFixed(1)}px (scroll ${input.scrollWidth} in ${input.clientWidth})`);
    }
    const unit = wrap.querySelector<HTMLElement>(":scope > .input-affix-text:last-child");
    if (unit) {
      const field = input.getBoundingClientRect();
      const box = unit.getBoundingClientRect();
      const innerStart = field.left + px(style.borderLeftWidth);
      const contentEnd = innerStart + px(style.paddingLeft) + room;
      const innerEnd = innerStart + inner;
      if (box.left < contentEnd - 0.5) found.push(`"${unit.textContent}" starts ${(contentEnd - box.left).toFixed(1)}px inside the value's room`);
      if (box.right > innerEnd + 0.5) found.push(`"${unit.textContent}" ends ${(box.right - innerEnd).toFixed(1)}px past the field's edge`);
    }
    return found;
  }));
  expect(misfits, what).toEqual([]);
}
