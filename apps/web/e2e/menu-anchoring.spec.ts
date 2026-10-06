import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Opening a portalled menu never scrolls the page (docs/design-system.md §9.1, #1803).
 *
 * The Project split menu and the Session row menu render at the end of <body>. Before the shared
 * menu surface, the Project menu's first commit had no placement yet, so it sat in normal flow at
 * the end of the document, and focusing its first item scrolled everything that could scroll to
 * reach it; the page jumped. The shared surface is `position: fixed` from its first commit, so
 * nothing moves. Each menu is opened here on a page whose list, and the document itself, are
 * already scrolled, and every scroll offset in the document must be exactly where it was.
 */

/** Tags every scrolled element so the same elements can be re-read after the menu opens. */
async function recordScroll(page: Page): Promise<Record<string, [number, number]>> {
  return page.evaluate(() => {
    const state: Record<string, [number, number]> = { window: [window.scrollX, window.scrollY] };
    let index = 0;
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      if (element.scrollTop === 0 && element.scrollLeft === 0) continue;
      element.dataset.scrollProbe = String(index);
      state[`probe-${index}`] = [element.scrollLeft, element.scrollTop];
      index += 1;
    }
    return state;
  });
}

async function readScroll(page: Page): Promise<Record<string, [number, number]>> {
  return page.evaluate(() => {
    const state: Record<string, [number, number]> = { window: [window.scrollX, window.scrollY] };
    for (const element of document.querySelectorAll<HTMLElement>("[data-scroll-probe]")) {
      state[`probe-${element.dataset.scrollProbe}`] = [element.scrollLeft, element.scrollTop];
    }
    // An element that was not scrolled before and is now would be a jump too.
    for (const element of document.querySelectorAll<HTMLElement>("*:not([data-scroll-probe])")) {
      if (element.scrollTop !== 0 || element.scrollLeft !== 0) {
        state[`new-${element.tagName}.${element.className}`] = [element.scrollLeft, element.scrollTop];
      }
    }
    return state;
  });
}

async function scrollThePage(page: Page): Promise<void> {
  const list = page.locator(".inbox-list");
  await expect(list.locator("[data-virtual-total='36']")).toBeVisible();
  await expect.poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await list.evaluate((element) => {
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) * 0.55);
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  // The document too, as far as it scrolls at all.
  await page.evaluate(() => window.scrollTo(0, 40));
}

async function expectFixedAndFocused(menu: Locator): Promise<void> {
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("position", "fixed");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
}

for (const viewport of [
  // Tall enough that the list under the Sessions page header holds a whole row clear of its edges.
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 720 },
] as const) {
  test.describe(`on a scrolled ${viewport.name} page`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.beforeEach(async ({ page }) => {
      await page.goto("/command-inbox-projects-e2e.html?scenario=inbox-live-scroll");
      await scrollThePage(page);
    });

    test("opening the Project split menu does not scroll or jump the page", async ({ page }) => {
      const before = await recordScroll(page);
      expect(Object.keys(before).length, "the list is scrolled before the menu opens").toBeGreaterThan(1);
      // A right-click opens the menu of a tab that is not selected (#2199), leaving the list as it is.
      await page.getByRole("tab", { name: /Alpha/ }).click({ button: "right" });
      await expectFixedAndFocused(page.getByRole("menu", { name: "Alpha Actions" }));
      expect(await readScroll(page)).toEqual(before);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      expect(await readScroll(page)).toEqual(before);
    });

    test("opening the Session row menu does not scroll or jump the page", async ({ page }) => {
      // A row inside the scrolled list's visible box. It is clicked by position rather than through
      // a locator, which would first scroll an overscan row into view and move the list itself.
      const target = await page.locator(".inbox-list").evaluate((list) => {
        const box = list.getBoundingClientRect();
        const row = [...list.querySelectorAll<HTMLElement>(".inbox-row-shell")].find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.top >= box.top + 40 && rect.bottom <= box.bottom - 40;
        });
        if (!row) return null;
        const rect = row.getBoundingClientRect();
        return {
          title: row.querySelector(".inbox-row-title")?.textContent?.trim() ?? "",
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      });
      expect(target, "a row sits inside the scrolled list").not.toBeNull();
      const { title, x, y } = target!;
      const before = await recordScroll(page);
      await page.mouse.click(x, y, { button: "right" });
      await expectFixedAndFocused(page.getByRole("menu", { name: `Session Actions for ${title}` }));
      expect(await readScroll(page)).toEqual(before);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      expect(await readScroll(page)).toEqual(before);
    });
  });
}
