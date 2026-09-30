import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The Keyboard Shortcuts reference (#1960) in the real shell: an 800px dialog of one-line rows in
 * two columns that fits in under two screens, with the current page's group first.
 */

const opaque = (value: string) => Buffer.from(value, "utf16le").toString("base64url");
const shell = (path: string) => `/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent(path)}`;
const SKILLS = shell("/skills");
const SESSION = shell(`/sessions/~${opaque("session-alpha")}`);

/** Finish the opening animation, whose scale or slide would skew every measured box. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.getAnimations()
    .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
    .forEach((animation) => animation.finish()));
}

/** Open the reference with `?` from the page itself, as someone reading it would. */
async function openWithKey(page: Page, url: string): Promise<Locator> {
  await page.goto(url);
  await expect(page.locator("#page-title, .page-title").first()).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Shift+Slash");
  const reference = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await expect(reference).toBeVisible();
  await settle(page);
  return reference;
}

const headings = (reference: Locator) => reference.locator(".shortcut-group h3");

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the reference is 800px wide, two columns, and under two screens tall", async ({ page }) => {
    const reference = await openWithKey(page, SKILLS);
    expect((await page.locator(".modal", { has: reference }).boundingBox())!.width).toBe(800);
    await expect(reference.locator(".shortcut-column")).toHaveCount(2);

    const body = reference.locator(".modal-body");
    const { scrollHeight, clientHeight } = await body.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(scrollHeight / clientHeight, "the whole reference fits in under two screens").toBeLessThan(2);

    // Navigation and Actions head the two columns, in view before any scrolling.
    const bodyBox = (await body.boundingBox())!;
    for (const name of ["Navigation", "Actions"]) {
      const box = (await headings(reference).filter({ hasText: new RegExp(`^${name}$`) }).boundingBox())!;
      expect(box.y + box.height, `${name} is visible without scrolling`).toBeLessThan(bodyBox.y + bodyBox.height);
    }

    // One line per row, and no text-transform anywhere in the reference.
    const rows = await reference.locator(".shortcut-row").evaluateAll((elements) => elements.map((element) => ({
      height: (element as HTMLElement).offsetHeight,
      label: element.querySelector("dt")!.getBoundingClientRect().height,
    })));
    expect(rows.length).toBeGreaterThan(40);
    const control = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-h")));
    for (const row of rows) {
      expect(row.height).toBeLessThanOrEqual(control + 1);
      expect(row.label).toBeLessThan(control);
    }
    const transforms = await reference.evaluate((dialog) =>
      [...dialog.querySelectorAll("*")].map((element) => getComputedStyle(element).textTransform).filter((value) => value !== "none"));
    expect(transforms).toEqual([]);

    // Without a session, each Session group says so once and dims its rows with dashed keycaps.
    await expect(reference.getByText("Open a session to use these.")).toHaveCount(2);
    const reading = reference.locator(".shortcut-group").filter({ has: page.getByRole("heading", { name: "Session Reading" }) });
    expect(await reading.locator("kbd").evaluateAll((keys) => [...new Set(keys.map((key) => getComputedStyle(key).borderStyle))]))
      .toEqual(["dashed"]);
  });

  test("with a session open its group comes first, marked Current Page", async ({ page }) => {
    const reference = await openWithKey(page, SESSION);
    await expect(headings(reference).first()).toHaveText("Session Reading Current Page");
    await expect(reference.getByRole("heading", { name: "Session Reading Current Page" })).toBeVisible();
    await expect(reference.locator(".shortcut-current")).toHaveCount(1);
    await expect(reference.getByText("Open a session to use these.")).toHaveCount(0);
    const current = (await headings(reference).first().boundingBox())!;
    const body = (await reference.locator(".modal-body").boundingBox())!;
    expect(current.y + current.height).toBeLessThan(body.y + body.height);
  });

  test("Ctrl+K opens Search while Session Reading owns the transcript, and Alt+Arrow hops sessions", async ({ page }) => {
    await page.goto(SESSION);
    const transcript = page.locator('[data-focus-zone="main"] .detail-scroll');
    await expect(transcript).toBeVisible();
    await transcript.focus();
    await page.keyboard.press("Control+k");
    const search = page.getByRole("dialog", { name: "Search", exact: true });
    await expect(search).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toBeHidden();

    const title = page.getByRole("heading", { level: 1 });
    await expect(title).toHaveText("Alpha Session");
    await transcript.focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(title).not.toHaveText("Alpha Session");
    await transcript.focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(title).toHaveText("Alpha Session");

    // The composer hops too. From an empty composer at the first session, Alt+↑ has nowhere to go
    // and recalls nothing; only a plain ↑ recalls the last prompt.
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitUserMessage("session-alpha", "earlier prompt", "turn-earlier"));
    const composer = page.locator(".composer-input");
    await composer.focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(title).toHaveText("Alpha Session");
    await expect(composer).toHaveValue("");
    await page.keyboard.press("ArrowUp");
    await expect(composer).toHaveValue("earlier prompt");
    await composer.fill("");
    await page.keyboard.press("Alt+ArrowDown");
    await expect(title).not.toHaveText("Alpha Session");

    const reference = await openWithKey(page, SESSION);
    const reading = reference.locator(".shortcut-group").filter({ has: page.getByRole("heading", { name: /^Session Reading/ }) });
    await expect(reading.locator(".shortcut-row", { hasText: "Next Session" }).locator("kbd")).toHaveText("Alt+↓");
    await expect(reading.locator(".shortcut-row", { hasText: "Previous Session" }).locator("kbd")).toHaveText("Alt+↑");
  });

  test("typing filters to the matching rows and their headings", async ({ page }) => {
    const reference = await openWithKey(page, SKILLS);
    const filter = reference.getByRole("searchbox", { name: "Filter Shortcuts" });
    await expect(filter).toBeFocused();
    await filter.fill("term");
    await expect(headings(reference)).toHaveText(["Session"]);
    await expect(reference.locator(".shortcut-row dt")).toHaveText(["Toggle Terminal", "Exit Terminal Focus"]);
    await filter.fill("xyzzy");
    await expect(reference.getByRole("status")).toContainText("No shortcuts match “xyzzy”.");
  });

  test("Done closes the reference and returns focus to its opener", async ({ page }) => {
    await page.goto(SKILLS);
    const opener = page.getByRole("button", { name: "Settings" }).first();
    await opener.focus();
    await page.keyboard.press("Shift+Slash");
    const reference = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
    await expect(reference).toBeVisible();
    const footer = reference.locator(".modal-foot");
    await expect(footer.getByRole("button")).toHaveText(["Done"]);
    // The card takes no ring; with a mouse the filter holds focus.
    expect(await reference.evaluate((dialog) => getComputedStyle(dialog).outlineStyle)).toBe("none");
    await footer.getByRole("button", { name: "Done" }).click();
    await expect(reference).toBeHidden();
    await expect(opener).toBeFocused();
  });
});

test.describe("on a 390px phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the reference is a sheet that leads with the hardware keyboard and keeps its keycaps", async ({ page }) => {
    await page.goto(shell("/settings/keyboard"));
    await page.getByRole("button", { name: /Keyboard Shortcuts/ }).first().click();
    const reference = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
    await expect(reference).toBeVisible();
    await settle(page);
    await expect(reference.locator(".modal-desc")).toHaveText(/^These shortcuts need a hardware keyboard\./);
    // A touch screen opens on the sheet, not the filter: focusing the field would raise the
    // software keyboard over a sheet nobody has read yet.
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await expect(reference).toBeFocused();
    await expect(reference.getByRole("searchbox", { name: "Filter Shortcuts" })).not.toBeFocused();
    const sheet = (await page.locator(".modal", { has: reference }).boundingBox())!;
    expect(sheet.width).toBe(390);
    expect(Math.round(sheet.y + sheet.height)).toBe(844);
    const close = (await reference.getByRole("button", { name: "Close" }).boundingBox())!;
    expect(close.width).toBeGreaterThanOrEqual(44);
    expect(close.height).toBeGreaterThanOrEqual(44);
    await expect(reference.locator(".shortcut-column")).toHaveCount(1);
    await expect(reference.locator(".shortcut-row kbd").first()).toBeVisible();
  });
});
