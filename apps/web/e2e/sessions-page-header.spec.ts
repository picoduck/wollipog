import { expect, test, type Page } from "@playwright/test";

/**
 * The Sessions page header (#2159): the List / Board switch, the Snoozed toggle, ⋯ and New Session
 * in the header row (§4.2), measured in a real browser. The harness mounts the real InboxView in the
 * app's Sessions page container, with one snoozed session.
 */

const PAGE = "/sessions-board-e2e.html";

async function openHarness(page: Page, theme: "dark" | "light" = "dark") {
  await page.goto(`${PAGE}?path=${encodeURIComponent("/")}`);
  await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
  await expect(page.locator(".page-header .page-primary")).toBeVisible();
}

const header = (page: Page) => page.locator(".page-header");

/** Each visible header control's name and box, left to right. */
function headerControls(page: Page) {
  return header(page).evaluate((element) => {
    const title = element.querySelector<HTMLElement>("#page-title")!;
    const controls = [...element.querySelectorAll<HTMLElement>(".page-actions > *")]
      .map((control) => control.matches(".page-controls") ? control.querySelector<HTMLElement>(".seg")! : control)
      .map((control) => control.matches(".page-more") ? control.querySelector<HTMLElement>(".icon-btn")! : control)
      .filter((control) => control.getClientRects().length > 0);
    const box = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, height: rect.height };
    };
    // The name a screen reader hears: an aria-label, else the text outside aria-hidden parts.
    const name = (node: HTMLElement) => {
      if (node.hasAttribute("aria-label")) return node.getAttribute("aria-label");
      const copy = node.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
      return copy.textContent;
    };
    return [
      { name: title.textContent, radius: "", ...box(title) },
      ...controls.map((control) => ({
        name: name(control),
        radius: getComputedStyle(control).borderTopLeftRadius,
        ...box(control),
      })),
    ];
  });
}

test.describe("with a fine pointer", () => {
  test("at 1440×900 the header shows Sessions, List / Board, Snoozed, ⋯ and New Session at one height and radius", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const theme of ["dark", "light"] as const) {
      await openHarness(page, theme);
      const controls = await headerControls(page);
      expect(controls.map(({ name }) => name)).toEqual(["Sessions", "Sessions View", "Snoozed, 1", "More Actions", "New Session"]);
      for (const [index, control] of controls.entries()) {
        if (index > 0) expect(control.left, `${control.name} follows ${controls[index - 1]!.name}`).toBeGreaterThan(controls[index - 1]!.right);
      }
      const actions = controls.slice(1);
      for (const control of actions) expect(control.height, `${control.name} is --control-h`).toBe(32);
      expect(new Set(actions.map(({ radius }) => radius)).size, "one radius").toBe(1);
      expect(new Set(actions.map(({ top }) => top)).size, "one row").toBe(1);
    }
  });

  test("Snoozed is a pressed toggle with its count, and switching it never moves List / Board or New Session", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHarness(page);
    const snoozed = header(page).getByRole("button", { name: "Snoozed, 1", exact: true });
    await expect(snoozed).toHaveAttribute("aria-pressed", "false");
    await expect(snoozed.locator(".count")).toHaveText("1");
    const before = await headerControls(page);
    const row = page.locator(".inbox-row-shell", { hasText: "Snoozed Session" });
    await expect(row).toHaveCount(0);

    await snoozed.click();
    await expect(snoozed).toHaveAttribute("aria-pressed", "true");
    await expect(row).toBeVisible();
    // On is the §3.1 toggle state: the --bg-elev-3 fill plus the --control-outline edge, so it does
    // not read as hovered. The pointer moves away first, so hover is not what is measured.
    await page.mouse.move(0, 899);
    // Polled: the button eases between states (--dur-fast).
    await expect.poll(() => snoozed.evaluate((button) => {
      const probe = document.createElement("div");
      probe.style.cssText = "background: var(--bg-elev-3); border: 1px solid var(--control-outline)";
      button.parentElement!.append(probe);
      const expected = getComputedStyle(probe);
      const actual = getComputedStyle(button);
      const result = {
        fill: actual.backgroundColor === expected.backgroundColor,
        edge: actual.borderTopColor === expected.borderTopColor,
      };
      probe.remove();
      return result;
    })).toEqual({ fill: true, edge: true });
    expect(await headerControls(page)).toEqual(before);
    // The List / Board choice survives, and Board keeps the filter.
    await expect(page.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: "Board" }).click();
    await expect(page.locator(".board .card", { hasText: "Snoozed Session" })).toBeVisible();
    await expect(snoozed).toHaveAttribute("aria-pressed", "true");
    expect(await headerControls(page)).toEqual(before);
  });

  test("at 940px Snoozed folds into ⋯ as a checked Show Snoozed Sessions with its count", async ({ page }) => {
    await page.setViewportSize({ width: 940, height: 700 });
    await openHarness(page);
    expect((await headerControls(page)).map(({ name }) => name)).toEqual(["Sessions", "Sessions View", "More Actions", "New Session"]);
    const more = header(page).getByRole("button", { name: "More Actions" });
    await more.click();
    const menu = page.getByRole("menu", { name: "More Actions" });
    const show = menu.getByRole("menuitemcheckbox", { name: "Show Snoozed Sessions, 1" });
    await expect(show).toHaveAttribute("aria-checked", "false");
    await expect(show.locator(".menu-trail .count")).toHaveText("1");
    await expect(menu.getByRole("menuitem")).toHaveText(["New Project…New Project is unavailable on this connection.", "Keyboard Shortcuts"]);
    await show.click();
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
    await expect(page.locator(".inbox-row-shell", { hasText: "Snoozed Session" })).toBeVisible();
    await more.click();
    await expect(menu.getByRole("menuitemcheckbox", { name: "Show Snoozed Sessions, 1" })).toHaveAttribute("aria-checked", "true");
  });

  test("⋯ closes on Escape and returns focus to its trigger", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHarness(page);
    const more = header(page).getByRole("button", { name: "More Actions" });
    await more.click();
    const menu = page.getByRole("menu", { name: "More Actions" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
  });
});

test.describe("with a coarse pointer", () => {
  test.use({ hasTouch: true });

  test("the header's controls and the ⋯ menu's items are 44px", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHarness(page);
    for (const control of (await headerControls(page)).slice(1)) {
      expect(control.height, `${control.name} is 44px on touch`).toBe(44);
    }
    await header(page).getByRole("button", { name: "More Actions" }).tap();
    const items = page.getByRole("menu", { name: "More Actions" }).locator('[role^="menuitem"]');
    await expect(items).toHaveCount(2);
    for (const box of await items.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))) {
      expect(box).toBeGreaterThanOrEqual(44);
    }
  });
});
