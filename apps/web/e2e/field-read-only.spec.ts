import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #2520: the read-only field state (docs/design-system.md §8.1) in a real browser. A field that is
 * read-only for good (`readOnly` plus `.is-read-only`) draws a dashed edge on a --bg-elev-2 fill with
 * its value in --text-dim; it is not the editable look and not §3.1's disabled look. A field that is
 * read-only only while a request runs, and SearchableCombobox's readOnly-as-disabled, keep their own
 * looks. #2617: a disabled field draws its value in --text-faint with `cursor: not-allowed` on the
 * unchanged fill, undimmed (§3.1, §8.1). #2619: so does a disabled Select trigger. #2621: a disabled
 * SearchableCombobox's edge does not step up under the pointer.
 */

/** The editable field as measured on main before #2520 (the issue's table). */
const EDITABLE = {
  dark: { color: "rgb(230, 237, 243)", background: "rgb(11, 17, 24)", border: "rgb(107, 130, 153)" },
  light: { color: "rgb(23, 33, 43)", background: "rgb(255, 255, 255)", border: "rgb(114, 124, 134)" },
} as const;

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

type Look = {
  color: string;
  opacity: string;
  background: string;
  border: string;
  borderStyle: string;
  borderWidth: string;
  cursor: string;
  height: number;
  readOnly: boolean;
};

function look(control: Locator): Promise<Look> {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      opacity: style.opacity,
      background: style.backgroundColor,
      border: style.borderTopColor,
      borderStyle: style.borderTopStyle,
      borderWidth: style.borderTopWidth,
      cursor: style.cursor,
      height: element.getBoundingClientRect().height,
      readOnly: (element as HTMLInputElement).readOnly,
    };
  });
}

function editableLook(theme: "dark" | "light") {
  const { color, background, border } = EDITABLE[theme];
  return { color, background, border, borderStyle: "solid", borderWidth: "1px" };
}

function luminance(rgb: string): number {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g)!.slice(0, 3).map((part) => {
    const value = Number(part) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** A Select's trigger, and the computed colour of its value and caret. */
function trigger(page: Page, name: string): Locator {
  return page.locator(`[data-field="${name}"] .ui-select-trigger`);
}

function triggerInk(control: Locator): Promise<{ value: string; caret: string }> {
  return control.evaluate((element) => ({
    value: getComputedStyle(element.querySelector(".ui-select-value")!).color,
    caret: getComputedStyle(element.querySelector(".ui-select-caret")!).color,
  }));
}

/** Moves focus off the field a dialog focused on opening, and lets its edge finish transitioning. */
async function settle(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForFunction(() => !document.getAnimations().some((animation) => animation instanceof CSSTransition));
}

/** The focus ring a control draws while it has keyboard focus. */
async function focusRing(page: Page, control: Locator): Promise<string> {
  await control.focus();
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}`;
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: a read-only field differs from an editable one, and editable fields are unchanged`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/read-only-fields-e2e.html?theme=${theme}`);
    const control = (name: string) => page.locator(`[data-field="${name}"] :is(input, textarea)`);
    await expect(control("editable")).toBeVisible();
    const [bgElev2, dim, faint, red, controlHeight] = await Promise.all([
      token(page, "--bg-elev-2"), token(page, "--text-dim"), token(page, "--text-faint"), token(page, "--red"),
      page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.height = "var(--control-h)";
        document.body.append(probe);
        const height = probe.getBoundingClientRect().height;
        probe.remove();
        return height;
      }),
    ]);

    const editable = await look(control("editable"));
    expect(editable).toMatchObject({ ...editableLook(theme), cursor: "text", height: controlHeight, readOnly: false });
    expect(await look(control("editable-textarea"))).toMatchObject({ ...editableLook(theme), readOnly: false });
    expect((await look(control("invalid"))).border, "an invalid field keeps its red edge").toBe(red);

    for (const name of ["read-only", "read-only-textarea"]) {
      const readOnly = await look(control(name));
      expect(readOnly.readOnly).toBe(true);
      expect(readOnly, `${name}: a dashed edge on --bg-elev-2, the value in --text-dim`).toMatchObject({
        background: bgElev2, borderStyle: "dashed", borderWidth: "1px", color: dim, cursor: "text",
      });
      expect(readOnly.background, `${name}: the fill differs from the editable field's`).not.toBe(EDITABLE[theme].background);
      expect(readOnly.color, `${name}: not the disabled --text-faint`).not.toBe(faint);
      expect(readOnly.cursor).not.toBe("not-allowed");
      expect(contrast(readOnly.color, readOnly.background), `${name}: the value against its own fill`).toBeGreaterThanOrEqual(4.5);
    }
    expect((await look(control("read-only"))).height, "the read-only field keeps the control height").toBe(controlHeight);
    expect(await focusRing(page, control("read-only")), "and the editable field's focus ring")
      .toBe(await focusRing(page, control("editable")));

    // A field read-only only while a request runs has no marker and keeps the editable look.
    expect(await look(control("busy"))).toMatchObject({ ...editableLook(theme), readOnly: true });
  });

  // #2617: outside forced colors a disabled field drew exactly like an editable one (a select only
  // differed by Chromium's own opacity). §3.1 gives a filled control --text-faint, the fill unchanged,
  // `cursor: not-allowed` and no opacity.
  test(`${theme}: a disabled field draws its value in --text-faint with the not-allowed cursor`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/read-only-fields-e2e.html?theme=${theme}`);
    const control = (name: string) => page.locator(`[data-field="${name}"] :is(input, textarea, select)`);
    await expect(control("editable")).toBeVisible();
    const faint = await token(page, "--text-faint");
    const disabledLook = {
      color: faint, background: EDITABLE[theme].background, border: EDITABLE[theme].border,
      borderStyle: "solid", borderWidth: "1px", cursor: "not-allowed", opacity: "1",
    };

    for (const name of ["disabled", "disabled-textarea", "disabled-select"]) {
      await expect(control(name)).toBeDisabled();
      const disabled = await look(control(name));
      expect(disabled, `${name}: --text-faint on --field-bg, not-allowed, undimmed`).toMatchObject(disabledLook);
      expect(contrast(disabled.color, disabled.background), `${name}: the value stays readable`).toBeGreaterThanOrEqual(4.5);
    }
    expect((await look(control("disabled"))).height, "the disabled field keeps the control height")
      .toBe((await look(control("editable"))).height);

    // SearchableCombobox implements disabled with readOnly and `aria-disabled`; it takes the same look.
    expect(await look(page.locator('[data-field="combobox"] input')), "combobox: the native field's disabled look")
      .toMatchObject({ ...disabledLook, readOnly: true });

    // Editable fields, and the native select, keep their look.
    for (const name of ["editable", "editable-textarea", "editable-select"]) {
      expect(await look(control(name)), `${name}: unchanged`).toMatchObject({ ...editableLook(theme), opacity: "1" });
    }
    expect((await look(control("editable-select"))).cursor, "editable-select: not the disabled cursor").not.toBe("not-allowed");
  });

  // #2619: a disabled Select trigger kept --text-dim, unlike the disabled native select beside it. It
  // is a filled control on the field recipe, so it takes the same §3.1 look, placeholder included,
  // and its edge does not step up under the pointer.
  test(`${theme}: a disabled Select trigger draws the disabled field's look`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/read-only-fields-e2e.html?theme=${theme}`);
    await expect(trigger(page, "select-trigger")).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true);
    const [faint, dim] = await Promise.all([token(page, "--text-faint"), token(page, "--text-dim")]);
    const disabledLook = {
      color: faint, background: EDITABLE[theme].background, border: EDITABLE[theme].border,
      borderStyle: "solid", borderWidth: "1px", cursor: "not-allowed", opacity: "1",
    };
    const nativeSelect = await look(page.locator('[data-field="disabled-select"] select'));
    const hovered = async (control: Locator) => {
      await control.hover();
      await settle(page);
      return (await look(control)).border;
    };

    for (const name of ["disabled-select-trigger", "disabled-select-trigger-placeholder"]) {
      const control = trigger(page, name);
      await expect(control).toHaveAttribute("aria-disabled", "true");
      const disabled = await look(control);
      expect(disabled, `${name}: --text-faint on --field-bg, not-allowed, undimmed`).toMatchObject(disabledLook);
      expect(disabled, `${name}: the disabled native select's look`).toMatchObject({
        color: nativeSelect.color, background: nativeSelect.background, border: nativeSelect.border,
      });
      expect((await triggerInk(control)).value, `${name}: its value or placeholder in the same ink`).toBe(faint);
      expect(contrast(faint, disabled.background), `${name}: the value stays readable`).toBeGreaterThanOrEqual(4.5);
      expect(await hovered(control), `${name}: no hover edge`).toBe(EDITABLE[theme].border);
    }
    await expect(trigger(page, "disabled-select-trigger-placeholder").locator(".ui-select-value")).toHaveClass(/is-placeholder/);

    // The enabled trigger keeps its look and its hover edge, so the hover check above is not vacuous.
    const enabled = trigger(page, "select-trigger");
    expect(await look(enabled), "enabled trigger: unchanged").toMatchObject({ ...editableLook(theme), cursor: "pointer", opacity: "1" });
    expect(await triggerInk(enabled), "enabled trigger: its value in --text, caret in --text-dim")
      .toEqual({ value: EDITABLE[theme].color, caret: dim });
    expect(await hovered(enabled), "enabled trigger: its edge steps up under the pointer").toBe(dim);
  });

  // #2621: a disabled SearchableCombobox's edge still stepped up to --text-dim under the pointer,
  // unlike the disabled Select trigger beside it (§3.1: no hover).
  test(`${theme}: a disabled SearchableCombobox keeps its edge under the pointer`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/read-only-fields-e2e.html?theme=${theme}`);
    const combobox = (name: string) => page.locator(`[data-field="${name}"] input`);
    await expect(combobox("editable-combobox")).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true);
    const dim = await token(page, "--text-dim");
    const hovered = async (control: Locator) => {
      await control.hover();
      await settle(page);
      return look(control);
    };

    const disabled = combobox("combobox");
    await expect(disabled).toHaveAttribute("aria-disabled", "true");
    expect((await look(disabled)).border, "disabled combobox: --control-outline at rest").toBe(EDITABLE[theme].border);
    expect(await hovered(disabled), "disabled combobox: no hover edge, not-allowed").toMatchObject({
      border: EDITABLE[theme].border, cursor: "not-allowed",
    });

    // The enabled combobox keeps its hover edge, so the check above is not vacuous.
    const enabled = combobox("editable-combobox");
    expect(await look(enabled), "enabled combobox: unchanged").toMatchObject({ ...editableLook(theme), cursor: "text", readOnly: false });
    expect((await hovered(enabled)).border, "enabled combobox: its edge steps up under the pointer").toBe(dim);
  });

  test(`${theme}: a read-only field stays in the tab order and its value can be selected`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/read-only-fields-e2e.html?theme=${theme}`);
    await page.locator('[data-field="editable"] input').focus();
    await page.keyboard.press("Tab");
    const readOnly = page.locator('[data-field="read-only"] input');
    await expect(readOnly).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    expect(await readOnly.evaluate((element: HTMLInputElement) => element.value.slice(element.selectionStart!, element.selectionEnd!)))
      .toBe("/home/dev/projects/billing-service");
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-field="editable-textarea"] textarea')).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-field="read-only-textarea"] textarea')).toBeFocused();
  });

  test(`${theme}: Guardrails shows all four fields read-only for a Viewer and editable otherwise`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const [bgElev2, dim] = await (async () => {
      await page.goto(`/read-only-fields-e2e.html?theme=${theme}&scenario=guardrails-viewer`);
      return Promise.all([token(page, "--bg-elev-2"), token(page, "--text-dim")]);
    })();
    const fields = page.getByRole("dialog", { name: "Guardrails" }).locator(".field input");
    await expect(fields).toHaveCount(4);
    for (const field of await fields.all()) {
      expect(await look(field)).toMatchObject({ readOnly: true, background: bgElev2, borderStyle: "dashed", color: dim, cursor: "text" });
    }

    await page.goto(`/read-only-fields-e2e.html?theme=${theme}&scenario=guardrails-editable`);
    await expect(fields).toHaveCount(4);
    await settle(page);
    for (const field of await fields.all()) {
      expect(await look(field)).toMatchObject({ ...editableLook(theme), readOnly: false });
    }

    // Saving holds every field read-only, and they keep the editable look.
    await fields.first().fill("7");
    await fields.first().press("Enter");
    await expect(page.getByRole("button", { name: "Save Guardrails" })).toHaveAttribute("aria-busy", "true");
    await settle(page);
    for (const field of await fields.all()) {
      expect(await look(field)).toMatchObject({ ...editableLook(theme), readOnly: true });
    }
  });

  test(`${theme}: Rename Session keeps the editable look while renaming`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/read-only-fields-e2e.html?theme=${theme}&scenario=rename`);
    const name = page.getByRole("textbox", { name: "Session Name" });
    await expect(name).toBeFocused();
    await settle(page);
    expect(await look(name)).toMatchObject({ ...editableLook(theme), readOnly: false });
    await name.press("Enter");
    await expect(page.getByRole("button", { name: "Rename Session" })).toHaveAttribute("aria-busy", "true");
    await settle(page);
    expect(await look(name)).toMatchObject({ ...editableLook(theme), readOnly: true });
  });
}

/** Opens the fields harness under emulated forced colors and reads the system colours it paints with. */
async function forcedColors(page: Page, palette: "dark" | "light") {
  await page.emulateMedia({ forcedColors: "active", colorScheme: palette });
  await page.goto(`/read-only-fields-e2e.html?theme=${palette}`);
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
  const system = await page.evaluate(() => {
    const read = (value: string) => {
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return { canvasText: read("CanvasText"), grayText: read("GrayText") };
  });
  expect(system.canvasText).not.toBe(system.grayText);
  return system;
}

for (const palette of ["dark", "light"] as const) {
  test(`forced colors (${palette} palette): a read-only value draws in CanvasText with a visible edge`, async ({ page }) => {
    const system = await forcedColors(page, palette);
    for (const name of ["read-only", "read-only-textarea"]) {
      const readOnly = await look(page.locator(`[data-field="${name}"] :is(input, textarea)`));
      expect(readOnly.color, `${name}: CanvasText, not the disabled GrayText`).toBe(system.canvasText);
      expect(readOnly, `${name}: keeps its dashed edge`).toMatchObject({ borderStyle: "dashed", borderWidth: "1px" });
      expect(contrast(readOnly.border, readOnly.background), `${name}: the edge shows against the fill`).toBeGreaterThanOrEqual(3);
    }
  });

  // #2611: forced colors repaints the field's --text as CanvasText, so only an author GrayText tells
  // a forced-colors user that a disabled field is unavailable (§3.1), as it does for a disabled `.btn`.
  test(`forced colors (${palette} palette): a disabled field draws its value and edge in GrayText`, async ({ page }) => {
    const system = await forcedColors(page, palette);
    const control = (name: string) => page.locator(`[data-field="${name}"] :is(input, textarea, select)`);

    for (const name of ["disabled", "disabled-textarea", "disabled-select"]) {
      await expect(control(name)).toBeDisabled();
      expect(await look(control(name)), `${name}: GrayText value and edge`).toMatchObject({
        color: system.grayText, border: system.grayText, borderStyle: "solid",
      });
    }
    // SearchableCombobox's readOnly-as-disabled input is `aria-disabled`, and reads as disabled too.
    expect(await look(page.locator('[data-field="combobox"] input')), "combobox: GrayText value and edge")
      .toMatchObject({ readOnly: true, color: system.grayText, border: system.grayText });
    expect(await page.locator('[data-field="combobox"] .ui-picker-chevron svg').evaluate((icon) => getComputedStyle(icon).color),
      "combobox: its chevron too").toBe(system.grayText);
    // #2621: and its edge stays GrayText under the pointer.
    await page.locator('[data-field="combobox"] input').hover();
    expect((await look(page.locator('[data-field="combobox"] input'))).border, "combobox: hovered, the edge stays GrayText")
      .toBe(system.grayText);

    // #2619: a disabled Select trigger, a button, draws it too, caret included, at rest and hovered.
    for (const name of ["disabled-select-trigger", "disabled-select-trigger-placeholder"]) {
      const disabled = trigger(page, name);
      expect(await look(disabled), `${name}: GrayText value and edge`).toMatchObject({
        color: system.grayText, border: system.grayText, borderStyle: "solid",
      });
      expect(await triggerInk(disabled), `${name}: its value and caret too`)
        .toEqual({ value: system.grayText, caret: system.grayText });
      await disabled.hover();
      expect((await look(disabled)).border, `${name}: hovered, the edge stays GrayText`).toBe(system.grayText);
    }
    const enabled = trigger(page, "select-trigger");
    expect(await look(enabled), "enabled trigger: CanvasText value and edge").toMatchObject({
      color: system.canvasText, border: system.canvasText,
    });
    expect(await triggerInk(enabled), "enabled trigger: its value and caret too")
      .toEqual({ value: system.canvasText, caret: system.canvasText });

    for (const name of ["editable", "editable-textarea", "editable-select", "editable-combobox", "read-only", "read-only-textarea"]) {
      const field = await look(control(name));
      expect(field.color, `${name}: CanvasText, not the disabled GrayText`).toBe(system.canvasText);
      expect(field.border, `${name}: not the disabled edge`).not.toBe(system.grayText);
    }
    for (const name of ["read-only", "read-only-textarea"]) {
      expect((await look(control(name))).borderStyle, `${name}: keeps its dashed edge`).toBe("dashed");
    }
  });
}
