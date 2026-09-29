import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The one keycap of docs/design-system.md §11.5 (#1956), measured in a browser: every `<kbd>` is
 * 11px monospace in an 18px box, and keycaps with the hints they label hide on a coarse pointer at
 * any width, except in the Keyboard Shortcuts reference. The height is a declared box size rather
 * than a text measurement, so it is exact on every machine.
 */

const PREVIEW = "/command-inbox-projects-e2e.html?scenario=preview-follow";
const SHELL = `/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent("/inbox")}`;
const SETTINGS = "/settings-navigation-e2e.html";

interface Keycap { fontSize: string; fontFamily: string; height: number; color: string; background: string }

async function keycap(locator: Locator): Promise<Keycap> {
  await expect(locator).toBeVisible();
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      // The layout box: a dialog's opening transform scales the painted rectangle, not the box.
      height: (element as HTMLElement).offsetHeight,
      color: style.color,
      background: style.backgroundColor,
    };
  });
}

/** A token's computed colour, read through a probe so it compares with `getComputedStyle` output. */
async function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

async function expectKeycap(page: Page, locator: Locator, where: string): Promise<void> {
  const measured = await keycap(locator);
  const mono = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.fontFamily = "var(--font-mono)";
    document.body.append(probe);
    const family = getComputedStyle(probe).fontFamily;
    probe.remove();
    return family;
  });
  expect(measured.fontSize, `${where}: 11px`).toBe("11px");
  expect(measured.fontFamily, `${where}: the --font-mono stack`).toBe(mono);
  expect(measured.height, `${where}: 18px tall`).toBe(18);
  expect(measured.color, `${where}: --text-dim`).toBe(await tokenColour(page, "--text-dim"));
  expect(measured.background, `${where}: on --bg-elev-2`).toBe(await tokenColour(page, "--bg-elev-2"));
}

async function openShortcutReference(page: Page): Promise<Locator> {
  await page.goto(SETTINGS);
  await page.keyboard.press("Shift+Comma");
  await expect(page.getByTestId("view-label")).toHaveText("Settings: appearance");
  await page.getByRole("button", { name: "Open Keyboard Shortcuts" }).click();
  const reference = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await expect(reference).toBeVisible();
  return reference;
}

async function openCreateMenu(page: Page): Promise<Locator> {
  await page.goto(SHELL);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const item = page.getByRole("menuitem", { name: "New Session" });
  await expect(item).toBeVisible();
  return item;
}

test.describe("with a fine pointer at 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an inline hint and the follow-output control draw the one keycap", async ({ page }) => {
    await page.goto(PREVIEW);
    const strip = page.locator(".transcript-status-strip");
    const pageUp = strip.locator('.shortcut-hint[data-shortcut-hint="Shift+Space"]');
    await expectKeycap(page, pageUp.locator("kbd"), "Page Up hint");
    // The label beside the keycap is the small type token in --text-dim.
    const label = await pageUp.locator(".shortcut-hint-label").evaluate((element) => {
      const style = getComputedStyle(element);
      return { fontSize: style.fontSize, color: style.color };
    });
    expect(label.fontSize).toBe("12px");
    expect(label.color).toBe(await tokenColour(page, "--text-dim"));

    await page.locator(".inbox-list").focus();
    await page.keyboard.press("Shift+Space");
    await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "previewing");
    await expectKeycap(page, page.locator(".follow-tail-chip kbd.follow-tail-kbd"), "follow-output control");
  });

  test("the Keyboard Shortcuts reference draws the same keycap", async ({ page }) => {
    const reference = await openShortcutReference(page);
    const keycaps = reference.locator(".shortcut-row kbd");
    expect(await keycaps.count()).toBeGreaterThan(10);
    await expectKeycap(page, keycaps.first(), "shortcut reference");
    const sizes = await keycaps.evaluateAll((elements) => [...new Set(elements.map((element) =>
      `${getComputedStyle(element).fontSize} ${(element as HTMLElement).offsetHeight}`))]);
    expect(sizes, "every row's keycap is the same size").toEqual(["11px 18"]);
  });

  test("a menu item with a binding carries the keycap in its trailing slot", async ({ page }) => {
    const item = await openCreateMenu(page);
    await expectKeycap(page, item.locator(".menu-trail kbd"), "New Session menu item");
    await expect(item).toHaveAccessibleName("New Session");
  });
});

test.describe("with a fine pointer at 760px", () => {
  test.use({ viewport: { width: 760, height: 900 } });

  test("keycaps stay visible, because a narrow window with a mouse still has a keyboard", async ({ page }) => {
    const item = await openCreateMenu(page);
    expect(await page.evaluate(() => matchMedia("(max-width: 760px)").matches), "this is the phone layout").toBe(true);
    await expectKeycap(page, item.locator(".menu-trail kbd"), "New Session sheet item");
  });
});

for (const width of [390, 1440]) {
  test.describe(`with a coarse pointer at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: true });

    test("inline keycaps and hints are hidden", async ({ page }) => {
      const item = await openCreateMenu(page);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await expect(item.locator("kbd")).toBeHidden();
      if (width === 1440) {
        await page.goto(PREVIEW);
        const strip = page.locator(".transcript-status-strip");
        await expect(page.locator(".follow-tail-chip")).toBeVisible();
        await expect(strip.locator('.shortcut-hint[data-shortcut-hint="Shift+Space"]')).toBeHidden();
        await expect(page.locator(".inbox-shortcut-rail button").first()).toBeVisible();
        await expect(page.locator(".inbox-shortcut-rail kbd").first()).toBeHidden();
      }
    });

    test("the Keyboard Shortcuts reference keeps its keycaps", async ({ page }) => {
      const reference = await openShortcutReference(page);
      await expectKeycap(page, reference.locator(".shortcut-row kbd").first(), "shortcut reference on touch");
    });
  });
}
