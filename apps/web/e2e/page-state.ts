import { expect, type Locator } from "@playwright/test";

/**
 * A page-level state (docs/design-system.md §12.1, #3875) is centered in the area it fills: it
 * spans its container's content box, its icon, title, sentence and actions share that box's center
 * line, and its text is center-aligned. Parts a state does not render are skipped.
 */
export async function expectCenteredState(state: Locator) {
  await expect(state).toHaveClass(/(^|\s)page-level(\s|$)/);
  await expect(state).toHaveCSS("text-align", "center");
  const area = await state.evaluate((element) => {
    const parent = element.parentElement!;
    const box = parent.getBoundingClientRect();
    const style = getComputedStyle(parent);
    const left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const right = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    return { left, right };
  });
  const own = (await state.boundingBox())!;
  expect(Math.abs(own.x - area.left), "the state starts at the area's edge").toBeLessThanOrEqual(1);
  expect(Math.abs(own.x + own.width - area.right), "the state reaches the area's far edge").toBeLessThanOrEqual(1);
  const center = (area.left + area.right) / 2;
  for (const part of [".state-icon", ".state-title", ".state-body", ".actions"]) {
    const located = state.locator(`:scope > ${part}`);
    if (await located.count() === 0) continue;
    const box = (await located.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - center), `${part} is centered in the area`).toBeLessThanOrEqual(1);
  }
}
