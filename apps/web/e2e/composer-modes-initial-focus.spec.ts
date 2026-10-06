import { devices, expect, test, type Page } from "@playwright/test";

/**
 * Where focus lands when the composer's Attach and Settings menu opens (#1904, #2203).
 *
 * On a phone, focusing a text field would summon the software keyboard over the sheet the user just
 * opened. Since the guardrail fields moved into the Guardrails dialog (#2175) and the menu became a
 * plain menu (#2203), nothing inside it is a text field: opening it focuses its first enabled item,
 * on either pointer. With Attach Image… disabled (no image support), that is the Reference a File…
 * row, which this harness's runner supports.
 */

const phone = devices["Pixel 7"];
const MENU = "Attach and Settings";

async function openSession(page: Page, { images, plan }: { images: boolean; plan: boolean }) {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(
    ({ images, plan }) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands(
      [],
      plan ? ["default", "acceptEdits", "plan"] : ["default", "acceptEdits"],
      { supportsImages: images },
    ),
    { images, plan },
  );
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".composer-input")).toBeEnabled();
}

/** Two frames: long enough for the open effect and any focus recovery that runs a frame later. */
async function settle(page: Page) {
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** The focused element, described by what matters here: its tag and role, and whether the menu holds it. */
async function focused(page: Page) {
  return page.evaluate((label) => {
    const active = document.activeElement;
    const menu = document.querySelector(`[role="menu"][aria-label="${label}"]`);
    return {
      tag: active?.tagName.toLowerCase() ?? null,
      role: active?.getAttribute("role") ?? null,
      inMenu: Boolean(menu && active && menu.contains(active)),
    };
  }, MENU);
}

/** The menu holds only menu items: no input, select, textarea or section label (#2203). */
async function expectPlainMenu(page: Page) {
  const menu = page.getByRole("menu", { name: MENU });
  await expect(menu).toBeVisible();
  await expect(menu.locator("input, select, textarea, .menu-label")).toHaveCount(0);
  const roles = await menu.locator("button").evaluateAll((rows) => rows.map((row) => row.getAttribute("role")));
  expect(roles.every((role) => role === "menuitem" || role === "menuitemcheckbox"), roles.join(", ")).toBe(true);
}

test.describe("on a coarse pointer", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent: phone.userAgent,
    deviceScaleFactor: phone.deviceScaleFactor,
  });

  test("opening with images and Plan both unsupported focuses the Reference a File… row, not a field", async ({ page }) => {
    await openSession(page, { images: false, plan: false });
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      "this emulation must report the coarse pointer the rule is keyed on").toBe(true);

    await page.getByRole("button", { name: MENU }).tap();
    await expectPlainMenu(page);
    // The case #1904 needed: the first row cannot take focus.
    await expect(page.getByRole("menuitem", { name: "Attach Image…", exact: true })).toBeDisabled();
    await expect(page.getByRole("menuitemcheckbox", { name: "Plan Mode" })).toHaveCount(0);
    await settle(page);

    const state = await focused(page);
    expect(["input", "textarea", "select"], "no text-entry field may take focus on open").not.toContain(state.tag);
    await expect(page.getByRole("menuitem", { name: "Reference a File…" }), "focus lands on the first enabled row").toBeFocused();
  });

  for (const { images, plan } of [
    { images: true, plan: false },
    { images: false, plan: true },
    { images: true, plan: true },
  ]) {
    test(`opening with images ${images ? "supported" : "unsupported"} and Plan ${plan ? "supported" : "unsupported"} never focuses a field`, async ({ page }) => {
      await openSession(page, { images, plan });
      await page.getByRole("button", { name: MENU }).tap();
      await expectPlainMenu(page);
      await settle(page);

      const state = await focused(page);
      expect(["input", "textarea", "select"]).not.toContain(state.tag);
      expect(state.inMenu, "focus moves into the opened menu").toBe(true);
      expect(["menuitem", "menuitemcheckbox"]).toContain(state.role);
    });
  }
});

test.describe("on a fine pointer", () => {
  for (const key of ["Enter", " ", "ArrowDown"]) {
    test(`${key === " " ? "Space" : key} opens into the first enabled item, and Escape returns to the trigger`, async ({ page }) => {
      await openSession(page, { images: false, plan: false });
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);

      const trigger = page.getByRole("button", { name: MENU });
      await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      await trigger.focus();
      await page.keyboard.press(key);
      await expect(page.getByRole("menu", { name: MENU })).toBeVisible();
      await settle(page);

      const state = await focused(page);
      expect(state.inMenu, "keyboard opening moves focus into the menu").toBe(true);
      // Attach Image… is disabled here, so the first enabled item is Reference a File….
      await expect(page.getByRole("menuitem", { name: "Reference a File…" })).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu", { name: MENU })).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }
});
