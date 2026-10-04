import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #2520: the read-only field state (docs/design-system.md §8.1) in a real browser. A field that is
 * read-only for good (`readOnly` plus `.is-read-only`) draws a dashed edge on a --bg-elev-2 fill with
 * its value in --text-dim; it is not the editable look and not §3.1's disabled look. A field that is
 * read-only only while a request runs, and SearchableCombobox's readOnly-as-disabled, keep their own
 * looks.
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

    // SearchableCombobox implements disabled with readOnly; it keeps its disabled look.
    const combobox = page.locator('[data-field="combobox"] input');
    expect(await look(combobox)).toMatchObject({
      readOnly: true, cursor: "not-allowed", color: dim, background: EDITABLE[theme].background, borderStyle: "solid",
    });
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

    for (const name of ["editable", "editable-textarea", "editable-select", "read-only", "read-only-textarea"]) {
      const field = await look(control(name));
      expect(field.color, `${name}: CanvasText, not the disabled GrayText`).toBe(system.canvasText);
      expect(field.border, `${name}: not the disabled edge`).not.toBe(system.grayText);
    }
    for (const name of ["read-only", "read-only-textarea"]) {
      expect((await look(control(name))).borderStyle, `${name}: keeps its dashed edge`).toBe("dashed");
    }
  });
}
