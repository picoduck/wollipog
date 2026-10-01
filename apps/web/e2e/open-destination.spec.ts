import { expect, test, type Page } from "@playwright/test";

/**
 * The session bar's Open control (#2164; docs/design-system.md §3.2, §9.1, §15.2): a quiet split of
 * two ghost segments on a hairline, a menu labelled Open In, a single Open Folder button when the
 * folder has one destination, an offline machine explained by the menu's note, and launch failures
 * as error toasts. The harness puts the bar in the `app` size container, as the shell does.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

const OFFLINE_NOTE = "Build Machine is offline. You can open the folder again when it reconnects.";

async function openFixture(page: Page, width: number, query = "") {
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`/open-destination-e2e.html${query ? `?${query}` : ""}`);
  await expect(page.locator(".editor-select")).toBeVisible();
}

/** The resolved value of a custom property on the root, as the browser serializes colours. */
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

for (const theme of ["dark", "light"] as const) {
  test(`the split is two ghost segments on a hairline, with no fill at rest (${theme})`, async ({ page }) => {
    await openFixture(page, 1440, `theme=${theme}`);
    const main = page.getByRole("button", { name: "Open in VS Code" });
    const choose = page.getByRole("button", { name: "Choose Where to Open" });
    await expect(main).toHaveText("Open");
    await expect(main).toHaveAttribute("title", "Open in VS Code");
    await expect(choose).toHaveAttribute("title", "Choose Where to Open");
    const border = await tokenColour(page, "--border");
    const textDim = await tokenColour(page, "--text-dim");
    for (const segment of [main, choose]) {
      await expect(segment).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(segment).toHaveCSS("border-top-color", border);
      await expect(segment).toHaveCSS("color", textDim);
      await expect(segment).toHaveCSS("height", "32px");
    }
    const geometry = await page.locator(".editor-select").evaluate((element) => {
      const [mainBox, caretBox] = [...element.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
      return { mainRight: mainBox!.right, caretLeft: caretBox!.left, mainTop: mainBox!.top, caretTop: caretBox!.top };
    });
    // One shared edge: the caret overlaps the main segment's trailing border by 1px (§3.2).
    expect(Math.abs(geometry.mainRight - geometry.caretLeft)).toBeLessThanOrEqual(1.1);
    expect(geometry.mainTop).toBe(geometry.caretTop);
  });
}

test("the menu is labelled Open In, checks the remembered destination, and puts File Manager after a separator", async ({ page }) => {
  await openFixture(page, 1000);
  await page.getByRole("button", { name: "Choose Where to Open" }).click();
  const menu = page.getByRole("menu", { name: "Open In" });
  await expect(menu.locator(".menu-label")).toHaveText("Open In");
  await expect(menu.locator(".menu-label")).toHaveCSS("text-transform", "none");
  const radios = menu.getByRole("menuitemradio");
  await expect(radios).toHaveText(["VS Code", "Cursor", "Devin Desktop", "Zed", "Future Editor", "File Manager"]);
  await expect(menu.getByRole("menuitemradio", { name: "VS Code" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: "VS Code" }).locator(".menu-check")).toBeVisible();
  const separatorBeforeFileManager = await menu.evaluate((element) =>
    element.querySelector('[role="separator"]')?.nextElementSibling?.textContent?.trim());
  expect(separatorBeforeFileManager).toBe("File Manager");
  await expect(menu.getByRole("menuitemradio", { name: "Devin Desktop" })
    .locator('[data-destination-icon="windsurf"]')).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "File Manager" })
    .locator('[data-destination-icon="file-manager"]')).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(8);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(992);

  await menu.getByRole("menuitemradio", { name: "Devin Desktop" }).click();
  await expect.poll(() => page.evaluate(() => window.hostActions)).toEqual([
    { kind: "open_editor", editorId: "windsurf" },
  ]);
  await expect(page.getByRole("button", { name: "Open in Devin Desktop" })).toHaveText("Open");
});

test("with one destination it is a single Open Folder button with no caret", async ({ page }) => {
  await openFixture(page, 1440, "editors=none");
  const select = page.locator(".editor-select");
  await expect(select.getByRole("button")).toHaveCount(1);
  const button = select.getByRole("button", { name: "Open Folder", exact: true });
  await expect(button).toHaveText("Open Folder");
  await expect(button).not.toHaveAttribute("aria-haspopup", /.*/);
  await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await button.click();
  await expect.poll(() => page.evaluate(() => window.hostActions)).toEqual([{ kind: "reveal" }]);
});

test("offline, Open is disabled and the menu explains why above destinations that are all disabled", async ({ page }) => {
  await openFixture(page, 1440, "offline=1");
  const main = page.getByRole("button", { name: "Open in VS Code" });
  await expect(main).toBeDisabled();
  await expect(main).toHaveAccessibleDescription(OFFLINE_NOTE);
  await expect(page.locator('[title="Runner is offline."]')).toHaveCount(0);
  await main.dispatchEvent("click");
  expect(await page.evaluate(() => window.hostActions)).toEqual([]);

  const choose = page.getByRole("button", { name: "Choose Where to Open" });
  await expect(choose).toBeEnabled();
  await choose.click();
  const menu = page.getByRole("menu", { name: "Open In" });
  await expect(menu.locator(".menu-note")).toHaveText(OFFLINE_NOTE);
  await expect(main).toHaveAccessibleDescription(OFFLINE_NOTE);
  const radios = menu.getByRole("menuitemradio");
  await expect(radios).toHaveCount(6);
  for (const radio of await radios.all()) await expect(radio).toBeDisabled();
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(choose).toBeFocused();
});

for (const width of [1440, 940]) {
  test(`offline, a single Open Folder shows why in the Open In menu at ${width}px (#2273)`, async ({ page }) => {
    await openFixture(page, width, "offline=1&editors=none");
    const select = page.locator(".editor-select");
    await expect(select.getByRole("button")).toHaveCount(1);
    const folder = select.getByRole("button", { name: "Open Folder", exact: true });
    await expect(folder).toBeDisabled();
    await expect(folder).toHaveAttribute("title", "Open Folder");
    await expect(folder).toHaveAttribute("aria-haspopup", "menu");
    await expect(folder).toHaveAccessibleDescription(OFFLINE_NOTE);
    if (width === 940) await expect(folder.locator(".editor-main-label")).toBeHidden();

    const menu = page.getByRole("menu", { name: "Open In" });
    for (const key of ["Enter", "Space"]) {
      await folder.focus();
      await page.keyboard.press(key);
      await expect(menu).toBeVisible();
      await expect(menu).toBeFocused();
      await expect(folder).toHaveAttribute("aria-expanded", "true");
      const note = menu.locator(".menu-note");
      await expect(note).toBeVisible();
      await expect(note).toHaveText(OFFLINE_NOTE);
      await expect(folder).toHaveAccessibleDescription(OFFLINE_NOTE);
      const radios = menu.getByRole("menuitemradio");
      await expect(radios).toHaveText(["File Manager"]);
      await expect(radios).toBeDisabled();
      // The note sits at the bottom, below the disabled file manager.
      const [itemBox, noteBox] = [await radios.boundingBox(), await note.boundingBox()];
      expect(noteBox!.y).toBeGreaterThanOrEqual(itemBox!.y + itemBox!.height);
      const menuBox = await menu.boundingBox();
      expect(menuBox!.x).toBeGreaterThanOrEqual(0);
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(folder).toBeFocused();
    }

    // A pointer click too; `force` because Playwright waits for an aria-disabled control to enable.
    await folder.click({ force: true });
    await expect(menu.locator(".menu-note")).toBeVisible();
    await menu.getByRole("menuitemradio", { name: "File Manager" }).dispatchEvent("click");
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => window.hostActions)).toEqual([]);
  });
}

test("a failed launch is an error toast, not a note under the button", async ({ page }) => {
  await openFixture(page, 1440, "fail=1");
  await page.getByRole("button", { name: "Open in VS Code" }).click();
  const toast = page.getByRole("alert").filter({ hasText: "Couldn't open the folder in VS Code." });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("VS Code is not installed or is not available on PATH on the runner host.");
  await expect(page.locator(".editor-note")).toHaveCount(0);
});

test("at 940px both segments are icon-only, named by their tooltips", async ({ page }) => {
  await openFixture(page, 940);
  const main = page.getByRole("button", { name: "Open in VS Code" });
  const choose = page.getByRole("button", { name: "Choose Where to Open" });
  await expect(main.locator(".editor-main-label")).toBeHidden();
  await expect(main).toHaveAttribute("title", "Open in VS Code");
  await expect(choose).toHaveAttribute("title", "Choose Where to Open");
  const mainBox = await main.boundingBox();
  expect(mainBox).toMatchObject({ width: 32, height: 32 });
  const caretBox = await choose.boundingBox();
  expect(caretBox!.width).toBeLessThanOrEqual(32);

  await openFixture(page, 940, "editors=none");
  const folder = page.getByRole("button", { name: "Open Folder", exact: true });
  await expect(folder.locator(".editor-main-label")).toBeHidden();
  await expect(folder).toHaveAttribute("title", "Open Folder");
  expect(await folder.boundingBox()).toMatchObject({ width: 32, height: 32 });
});
