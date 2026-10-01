import { expect, test, type Page } from "@playwright/test";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #2150: the field error (docs/design-system.md §8.5) in a real browser. It takes the helper's place,
 * so a field does not move when its error replaces its helper, and an invalid control's edge is
 * --red while its focus ring stays --focus. Positions are compared between two copies of the same
 * field, so the machine's font stack cancels out.
 */

/** A token's computed colour, read the way the browser paints it. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((property) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${property})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

for (const palette of ["dark", "light"] as const) {
  test(`forced colors (${palette} palette): the error icon follows the error's words`, async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", colorScheme: palette });
    await page.goto(`/primitives-e2e.html?theme=${palette}`);
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    const message = page.locator('.field[data-state="invalid"] .field-error');
    await expect(message).toBeVisible();
    // An svg preserves its parent's colour in forced colors, so an icon that set its own author
    // colour would stay red while the words turn CanvasText.
    const colours = await message.evaluate((element) => ({
      words: getComputedStyle(element).color,
      icon: getComputedStyle(element.querySelector("svg")!).color,
      author: getComputedStyle(document.documentElement).getPropertyValue("--danger-text").trim(),
    }));
    expect(colours.icon).toBe(colours.words);
    expect(colours.words).not.toBe(colours.author);
  });
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} at ${width}px: the error sits where the helper sat, in --danger-text`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/primitives-e2e.html?theme=${theme}`);
      const field = (state: string) => page.locator(`.field[data-state="${state}"]`);
      await expect(field("helper")).toBeVisible();

      const measure = (state: string) => field(state).evaluate((element) => {
        const input = element.querySelector("input")!.getBoundingClientRect();
        const line = element.querySelector("input + *")!.getBoundingClientRect();
        return { offset: line.top - input.bottom, height: line.height, left: line.left - input.left, field: element.getBoundingClientRect().height };
      });
      const helper = await measure("helper");
      const error = await measure("invalid");
      expectGeometry(Math.abs(error.offset - helper.offset), "the error starts where the helper starts").toBeLessThanOrEqual(0.61);
      expectGeometry(Math.abs(error.left - helper.left), "and is aligned with it").toBeLessThanOrEqual(0.61);
      expectGeometry(Math.abs(error.height - helper.height), "a one-line error is as tall as a one-line helper").toBeLessThanOrEqual(0.61);
      expectGeometry(Math.abs(error.field - helper.field), "so the field keeps its height").toBeLessThanOrEqual(0.61);

      const message = field("invalid").locator(".field-error");
      await expect(message).toHaveText("Enter a name of 64 characters or fewer.");
      await expect(message).not.toHaveAttribute("role");
      const danger = await token(page, "--danger-text");
      const look = await message.evaluate((element) => {
        const icon = element.querySelector("svg")!;
        const box = icon.getBoundingClientRect();
        const text = element.querySelector("span")!.getBoundingClientRect();
        return {
          color: getComputedStyle(element).color,
          icon: { width: box.width, height: box.height, color: getComputedStyle(icon).color },
          iconInsideFirstLine: box.top >= text.top - 0.5 && box.bottom <= text.top + 16.5,
        };
      });
      expect(look.color).toBe(danger);
      expect(look.icon).toEqual({ width: 14, height: 14, color: danger });
      expect(look.iconInsideFirstLine).toBe(true);
      await expect(field("invalid").locator("input")).toHaveAccessibleDescription("Enter a name of 64 characters or fewer.");
      await expect(field("helper").locator("input")).toHaveAccessibleDescription("Shown in the session list and the window title.");
    });
  }

  test(`${theme}: an invalid control draws a --red edge, and focus keeps the --focus ring`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/primitives-e2e.html?theme=${theme}`);
    const focused = page.locator('.field[data-state="focused"] input');
    await expect(focused).toBeFocused();
    const [red, focus, outline] = await Promise.all([token(page, "--red"), token(page, "--focus"), token(page, "--control-outline")]);
    const edge = (state: string) => page.locator(`.field[data-state="${state}"] input`).evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.borderTopColor, width: style.borderTopWidth, outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}` };
    });
    expect((await edge("helper")).border).toBe(outline);
    expect(await edge("invalid")).toMatchObject({ border: red, width: "1px" });
    expect(await edge("focused")).toEqual({ border: red, width: "1px", outline: `solid 1px ${focus}` });
  });

  test(`${theme}: an invalid picker keeps its --red edge under the pointer`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/primitives-e2e.html?theme=${theme}`);
    expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true);
    // Select and SearchableCombobox do not forward aria-invalid yet; their classes carry the hover
    // edge this has to outrank, so bare controls with those classes stand in for them.
    await page.locator('.field[data-state="helper"]').evaluate((field) => {
      field.insertAdjacentHTML("beforeend", '<button type="button" class="ui-select-trigger" data-picker="valid">Claude</button>');
    });
    await page.locator('.field[data-state="invalid"]').evaluate((field) => {
      field.insertAdjacentHTML("beforeend",
        '<button type="button" class="ui-select-trigger" aria-invalid="true" data-picker="select">Claude</button>'
        + '<input class="ui-searchable-combobox-input" role="combobox" aria-invalid="true" data-picker="combobox" value="wollipog">');
    });
    const [red, dim] = await Promise.all([token(page, "--red"), token(page, "--text-dim")]);
    const hovered = async (picker: string) => {
      const control = page.locator(`[data-picker="${picker}"]`);
      await control.hover();
      await page.waitForFunction(() => !document.getAnimations().some((animation) => animation instanceof CSSTransition));
      return control.evaluate((element) => getComputedStyle(element).borderTopColor);
    };
    expect(await hovered("valid"), "the pickers' own hover edge applies here").toBe(dim);
    expect(await hovered("select")).toBe(red);
    expect(await hovered("combobox")).toBe(red);
  });
}
