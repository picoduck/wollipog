import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * A composer control that removes itself keeps keyboard focus in the composer (#1913).
 *
 * The Plan pill unmounts when Plan mode turns off, and each attachment ✕ unmounts with its chip.
 * Activated from the keyboard, each one held focus as it went, so focus fell to the page body and
 * the user had to Tab back in from the top. Pointer activation never focuses them (#1909), and
 * composer-bar-first-tap.spec.ts covers that.
 */

test.use({ viewport: { width: 1280, height: 800 } });

async function openSession(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], ["default", "acceptEdits", "plan"], {
    supportsImages: true,
  }));
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  const composer = page.locator(".composer-input");
  await expect(composer).toBeEnabled();
  return composer;
}

/**
 * Focuses the control, activates it with `key`, and checks that it went and took nothing with it:
 * focus is in the composer once the removal has rendered, and the key typed nothing there.
 */
async function activateFromKeyboard(page: Page, composer: Locator, control: Locator, key: "Enter" | " ") {
  await control.focus();
  await expect(control).toBeFocused();
  const draft = await composer.inputValue();
  await page.keyboard.press(key);
  await expect(control).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => document.activeElement?.tagName),
    "focus must not fall to the page body").not.toBe("BODY");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(draft);
}

for (const [keyName, key] of [["Enter", "Enter"], ["Space", " "]] as const) {
  test.describe(`${keyName} on a composer control that removes itself`, () => {
    test("turns Plan mode off, and focuses the composer", async ({ page }) => {
      const composer = await openSession(page);
      await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
        permissionMode: "plan",
      }));
      await composer.fill("Draft");
      await activateFromKeyboard(page, composer, page.getByRole("button", { name: "◒ Plan" }), key);
    });

    test("removes an image, and focuses the composer", async ({ page }) => {
      const composer = await openSession(page);
      await page.locator(".composer-attach-input").setInputFiles([
        { name: "one.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71]) },
      ]);
      await activateFromKeyboard(page, composer, page.getByRole("button", { name: "Remove Image" }), key);
    });

    test("removes a workspace reference, and focuses the composer", async ({ page }) => {
      const composer = await openSession(page);
      await composer.pressSequentially("Review @src");
      await page.getByRole("option", { name: /src\/session\.ts/ }).click();
      const remove = page.getByRole("button", { name: "Remove Workspace Reference src/session.ts" });
      await expect(remove).toBeVisible();
      await activateFromKeyboard(page, composer, remove, key);
    });
  });
}
