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

/** The Sessions page header's New Session, which carries its C keycap (#2159). */
async function openNewSession(page: Page): Promise<Locator> {
  await page.goto(SHELL);
  const button = page.locator(".page-header .page-primary");
  await expect(button).toBeVisible();
  return button;
}

test.describe("with a fine pointer at 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an inline hint and the Jump to Latest control draw the one keycap", async ({ page }) => {
    await page.goto(PREVIEW);
    await page.locator(".inbox-list").focus();
    await page.keyboard.press("Shift+Space");
    await expect(page.locator(".detail-scroll[data-follow-tail-state]")).toHaveAttribute("data-follow-tail-state", "previewing");
    await expectKeycap(page, page.locator(".transcript-tail-control kbd"), "Jump to Latest control");

    await page.getByRole("button", { name: "Open Session", exact: true }).click();
    await page.getByRole("region", { name: "Session Activity" }).focus();
    // The Reply shortcut's keycap sits in the idle composer's placeholder row (#2166).
    const reply = page.locator(".composer-reply-hint kbd");
    await expect(reply).toHaveText("R");
    await expectKeycap(page, reply, "Reply keycap");
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

  test("the Sessions context menu draws the same keycap in each item's trailing slot (#2214)", async ({ page }) => {
    await page.goto(PREVIEW);
    await page.locator(".inbox-list").focus();
    await page.keyboard.press("Shift+F10");
    const archive = page.getByRole("menuitem", { name: /^Archive/ });
    await expectKeycap(page, archive.locator(".menu-trail kbd"), "context menu keycap");
    await expect(archive).toHaveAttribute("aria-keyshortcuts", "E");
  });

  test("the Sessions search field's / is the same keycap once the field opens", async ({ page }) => {
    await page.goto(SHELL);
    const key = page.locator(".inbox-search kbd.inbox-search-key");
    await expect(key).toBeHidden();
    await page.getByRole("textbox", { name: "Search Sessions" }).focus();
    await expectKeycap(page, key, "Sessions search key");
  });

  test("the page header's New Session carries its keycap after the label", async ({ page }) => {
    const button = await openNewSession(page);
    await expectKeycap(page, button.locator("kbd"), "New Session keycap");
    await expect(button).toHaveAccessibleName("New Session");
    await expect(button).toHaveAttribute("aria-keyshortcuts", "C");
  });
});

test.describe("with a fine pointer at 760px", () => {
  test.use({ viewport: { width: 760, height: 900 } });

  test("keycaps stay visible, because a narrow window with a mouse still has a keyboard", async ({ page }) => {
    const button = await openNewSession(page);
    expect(await page.evaluate(() => matchMedia("(max-width: 760px)").matches), "this is the phone layout").toBe(true);
    // The app bar's New Session is a 44px + whose label is clipped (§15.1); its keycap goes with the
    // label, and the key stays announced.
    await expect(button.locator("kbd")).toBeHidden();
    await expect(button).toHaveAttribute("aria-keyshortcuts", "C");
    // The phone layout keeps the search field open, so its / keycap shows without focus.
    await expectKeycap(page, page.locator(".inbox-search kbd.inbox-search-key"), "Sessions search key");
  });
});

for (const width of [390, 1440]) {
  test.describe(`with a coarse pointer at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: true });

    test("inline keycaps and hints are hidden", async ({ page }) => {
      const button = await openNewSession(page);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await expect(button.locator("kbd")).toBeHidden();
      // Even with the search field open and focused, a touch screen shows no / keycap.
      await page.getByRole("textbox", { name: "Search Sessions" }).focus();
      await expect(page.locator(".inbox-search:focus-within")).toHaveCount(1);
      await expect(page.locator(".inbox-search kbd.inbox-search-key")).toBeHidden();
      if (width === 1440) {
        await page.goto(PREVIEW);
        await page.locator(".inbox-list").focus();
        await page.keyboard.press("Shift+Space");
        // Jump to Latest keeps its label on a touch screen and drops its End keycap.
        const jump = page.locator(".transcript-tail-control");
        await expect(jump).toBeVisible();
        await expect(jump).toHaveAccessibleName("Jump to Latest");
        await expect(jump.locator("kbd")).toBeHidden();
        // A row's ⋯ is always there on a touch screen, and its menu shows no keycaps (#2214).
        await page.locator(".inbox-row-more").first().click();
        await expect(page.getByRole("menu")).toBeVisible();
        await expect(page.locator('[role="menu"] kbd')).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);
        // An expanded session's idle composer offers no Reply keycap on a touch screen.
        await page.getByRole("button", { name: "Open Session", exact: true }).click();
        await expect(page.locator(".composer-box")).toBeVisible();
        await expect(page.locator(".composer-reply-hint kbd")).toBeHidden();
      }
    });

    test("the Keyboard Shortcuts reference keeps its keycaps", async ({ page }) => {
      const reference = await openShortcutReference(page);
      await expectKeycap(page, reference.locator(".shortcut-row kbd").first(), "shortcut reference on touch");
    });
  });
}
