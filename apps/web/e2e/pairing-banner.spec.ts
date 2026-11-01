import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The pairing banner and Pair This Device (#3005; docs/design-system.md §12.5, §13.3, §7.5). The real
 * Shell is mounted with its store: the fixture refuses every socket as unpaired until the dialog
 * stores the one code it accepts. Copy and the store's behaviour are DOM tested
 * (PairingBanner.dom.test.tsx); this is the layout only a browser shows.
 */

const ACCEPTED = "e2eAcceptedPairingCode0123456789";
const REFUSED = "e2eRefusedPairingCode01234567890";

async function open(page: Page, width: number, theme: "light" | "dark", query = "") {
  await page.setViewportSize({ width, height: width > 760 ? 900 : 844 });
  await page.addInitScript((value) => {
    if (!sessionStorage.getItem("pairing-e2e-cleared")) {
      localStorage.clear();
      sessionStorage.setItem("pairing-e2e-cleared", "1");
    }
    localStorage.setItem("wollipog.theme", value);
  }, theme);
  await page.goto(`/command-inbox-projects-e2e.html?fullShell=1&pairingRequired=1&path=%2Fsettings${query}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  // Keep the pointer off the page so no hover shows in a capture.
  await page.mouse.move(0, 0);
}

async function capture(page: Page, name: string) {
  if (!process.env.EVIDENCE_DIR) return;
  // Let transitions (a disclosure's chevron, a sheet sliding in) settle before the capture.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/${name}.png` });
}

async function noHorizontalOverflow(page: Page, banner: Locator) {
  expect(await banner.evaluate((element) => element.scrollWidth <= element.clientWidth), "banner has no horizontal overflow").toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page has no horizontal overflow").toBe(true);
}

/** The banner's one action at the top right of its content, beside the sentence. */
async function assertTopRight(banner: Locator, name: string) {
  const [body, action, content] = await Promise.all([
    banner.locator(".notice-body").boundingBox(),
    banner.getByRole("button", { name }).boundingBox(),
    banner.locator(".notice-content").boundingBox(),
  ]);
  expect(Math.abs(action!.y - content!.y), `${name} stays at the top`).toBeLessThan(1);
  expect(Math.abs(action!.x + action!.width - content!.x - content!.width), `${name} stays at the right`).toBeLessThan(1);
  expect(body!.x + body!.width, "sentence and action do not overlap").toBeLessThanOrEqual(action!.x);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) test.describe(`${width}px ${theme}`, () => {
    // 390px is a phone: touch, where controls take their 44px targets (§15.3).
    if (width <= 760) test.use({ hasTouch: true, isMobile: true });
    test(`the unpaired banner and Pair This Device at ${width}px in ${theme}`, async ({ page }) => {
      await open(page, width, theme);
      const banner = page.locator(".notice.page-banner");
      await expect(banner).toHaveCount(1);
      await expect(banner.locator(".notice-body")).toHaveText("This device isn't paired with Wollipog yet.");
      await expect(banner.locator("input")).toHaveCount(0);
      await assertTopRight(banner, "Pair This Device…");
      await noHorizontalOverflow(page, banner);
      await capture(page, `unpaired-banner-${width}-${theme}`);

      await banner.getByRole("button", { name: "Pair This Device…" }).click();
      const dialog = page.getByRole("dialog", { name: "Pair This Device" });
      await expect(dialog).toBeVisible();
      const field = dialog.getByLabel("Pairing Link or Code");
      // A phone sheet does not raise the keyboard on open; a desktop dialog focuses its field.
      if (width > 760) await expect(field).toBeFocused();
      if (width <= 760) {
        // A bottom sheet (§7.5): flush with the bottom edge, a 44px field and two 48px buttons.
        await expect.poll(async () => {
          const sheet = (await page.locator(".modal").first().boundingBox())!;
          return [Math.round(sheet.x), Math.round(sheet.width), Math.round(sheet.y + sheet.height)];
        }, { message: "the sheet docks to the bottom edge across the width" }).toEqual([0, 390, 844]);
        expect((await field.boundingBox())!.height).toBe(44);
        for (const name of ["Cancel", "Pair This Device"]) {
          expect((await dialog.getByRole("button", { name, exact: true }).boundingBox())!.height, name).toBe(48);
        }
      }
      await page.mouse.move(0, 0);
      await capture(page, `dialog-empty-${width}-${theme}`);

      await field.fill("https://studio.example.com/#pair=");
      await page.keyboard.press("Enter");
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(dialog.locator(".field-error")).toHaveText("This isn't a pairing link or code. Copy the whole link, including #pair=.");
      await capture(page, `dialog-field-error-${width}-${theme}`);

      await field.fill(`https://studio.example.com/#pair=${REFUSED}`);
      await dialog.getByRole("button", { name: "Pair This Device", exact: true }).click();
      const refused = dialog.locator(".notice.t-danger");
      await expect(refused.locator(".notice-title")).toHaveText("Wollipog Didn't Accept This Link");
      await page.mouse.move(0, 0);
      await capture(page, `dialog-not-accepted-${width}-${theme}`);

      await dialog.getByText("Where Do I Find the Link?").click();
      await expect(dialog.locator(".disclosure-body .code-well code")).toHaveText("wollipog pair url");
      await page.mouse.move(0, 0);
      await capture(page, `dialog-where-${width}-${theme}`);

      await field.fill(ACCEPTED);
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".notice.page-banner")).toHaveCount(0);
    });

    test(`the desktop app's managed-pairing failure at ${width}px in ${theme}`, async ({ page }) => {
      await open(page, width, theme, "&managedPairingFailure=1");
      const banner = page.locator(".notice.page-banner");
      await expect(banner.locator(".notice-body")).toHaveText("This app couldn't read its saved pairing, so it can't connect.");
      const retry = banner.getByRole("button", { name: "Retry Pairing" });
      const paste = banner.getByRole("button", { name: "Paste a Link…" });
      const [sentence, retryBox, pasteBox] = await Promise.all([
        banner.locator(".notice-body").boundingBox(),
        retry.boundingBox(),
        paste.boundingBox(),
      ]);
      if (width <= 760) {
        // Two actions take one row under the sentence, each 44px tall.
        expect(retryBox!.y, "the actions sit under the sentence").toBeGreaterThanOrEqual(sentence!.y + sentence!.height);
        expect(Math.abs(retryBox!.y - pasteBox!.y), "on one row").toBeLessThan(1);
        expect(retryBox!.height).toBe(44);
        expect(pasteBox!.height).toBe(44);
        const icon = await banner.locator(".notice-icon").boundingBox();
        expect(icon!.y, "the icon stays on the first line").toBeLessThan(sentence!.y + 20);
      } else {
        await assertTopRight(banner, "Show Details");
        expect(Math.abs(retryBox!.y - sentence!.y), "the actions stay at the top").toBeLessThan(6);
      }
      await noHorizontalOverflow(page, banner);
      await capture(page, `managed-failure-banner-${width}-${theme}`);

      await retry.click();
      await expect(banner.locator(".notice-body"))
        .toHaveText("Another Wollipog is already running on this computer. Paste a pairing link from it.");
      await noHorizontalOverflow(page, banner);
      await page.mouse.move(0, 0);
      await capture(page, `managed-failure-port-taken-${width}-${theme}`);
      await paste.click();
      await expect(page.getByRole("dialog", { name: "Pair This Device" })).toBeVisible();
    });
  });
}
