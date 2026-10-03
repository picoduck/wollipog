import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #2130: in forced colors a disabled `.btn` of every variant, whether `disabled` or
 * `aria-disabled="true"`, draws its text and border in the system's unavailable ink (GrayText), and
 * an enabled one does not. A busy button is running, not unavailable, so it keeps its enabled look.
 */

const VARIANTS = ["Secondary", "Primary", "Ghost", "Danger", "Ghost Danger"] as const;

/**
 * A button's text and border colours, with GrayText's own value named. Only GrayText is named: the
 * emulated palette gives ButtonText, ButtonBorder and CanvasText one value, so other names collide.
 */
async function ink(button: Locator) {
  return button.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "GrayText";
    document.body.append(probe);
    const grayText = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(element);
    const named = (color: string) => color === grayText ? "GrayText" : color;
    return { text: named(style.color), border: named(style.borderTopColor) };
  });
}

async function open(page: Page, theme: "dark" | "light") {
  await page.goto(`/busy-button-e2e.html?surface=states&theme=${theme}`);
  await expect(page.locator(".button-states-fixture")).toBeVisible();
}

function state(page: Page, variant: string, name: "enabled" | "disabled" | "aria-disabled" | "busy") {
  return page.locator(`[data-variant="${variant}"] [data-state="${name}"]`);
}

test.use({ reducedMotion: "reduce" });

for (const theme of ["dark", "light"] as const) {
  test(`a disabled button draws GrayText in forced colors, and an enabled or busy one does not (${theme})`, async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await open(page, theme);
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    await page.mouse.move(0, 0);

    for (const variant of VARIANTS) {
      const enabled = await ink(state(page, variant, "enabled"));
      expect(enabled.text, `${variant}: enabled text`).not.toBe("GrayText");
      expect(enabled.border, `${variant}: enabled border`).not.toBe("GrayText");
      // Polled, not read once: late in a long shard the first read of a freshly loaded page can
      // report ButtonText for a disabled button that already paints GrayText (#2481's merge queue).
      // The expected ink is unchanged; the read only waits for the computed style to settle.
      await expect.poll(() => ink(state(page, variant, "disabled")), { message: `${variant}: disabled` })
        .toEqual({ text: "GrayText", border: "GrayText" });
      await expect.poll(() => ink(state(page, variant, "aria-disabled")), { message: `${variant}: aria-disabled` })
        .toEqual({ text: "GrayText", border: "GrayText" });
      const busy = state(page, variant, "busy");
      await expect(busy).toHaveAttribute("aria-busy", "true");
      await expect(busy).toHaveAttribute("aria-disabled", "true");
      expect(await ink(busy), `${variant}: busy keeps its enabled look`).toEqual(enabled);
    }

    // The issue's own case: a disabled primary and an enabled one no longer paint the same text.
    const primary = await page.locator('[data-variant="Primary"] [data-state="enabled"]')
      .evaluate((element) => getComputedStyle(element).color);
    const disabledPrimary = await page.locator('[data-variant="Primary"] [data-state="disabled"]')
      .evaluate((element) => getComputedStyle(element).color);
    expect(disabledPrimary).not.toBe(primary);

    // Hovering a disabled button does not bring back the enabled ink.
    await state(page, "Primary", "aria-disabled").hover();
    expect(await ink(state(page, "Primary", "aria-disabled"))).toEqual({ text: "GrayText", border: "GrayText" });
  });
}

test("outside forced colors a disabled button keeps its themed faint text", async ({ page }) => {
  await open(page, "dark");
  for (const variant of VARIANTS) {
    expect((await ink(state(page, variant, "disabled"))).text, variant).not.toBe("GrayText");
  }
});
