import { waitForSessionPreview } from "./session-readiness.js";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { DECODABLE_PNG } from "./fixtures/prompt-image.js";

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
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  await waitForSessionPreview(page);
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
      await activateFromKeyboard(page, composer, page.getByRole("button", { name: "Plan", exact: true }), key);
    });

    test("removes an image, and focuses the composer", async ({ page }) => {
      const composer = await openSession(page);
      await page.locator(".composer-attach-input").setInputFiles([
        { name: "one.png", mimeType: "image/png", buffer: DECODABLE_PNG },
      ]);
      await activateFromKeyboard(page, composer, page.getByRole("button", { name: "Remove Attached Image 1" }), key);
    });

    test("removes a workspace reference, and focuses the composer", async ({ page }) => {
      const composer = await openSession(page);
      await composer.pressSequentially("Review @src");
      await page.getByRole("option", { name: /src\/session\.ts/ }).click();
      const remove = page.getByRole("button", { name: "Remove Reference src/session.ts" });
      await expect(remove).toBeVisible();
      await activateFromKeyboard(page, composer, remove, key);
    });
  });
}

test.describe("Enter on a composer control that removes itself, with the composer disabled", () => {
  /**
   * Refuses the signed-in person every command but those in `except`, as a Viewer is refused them.
   * A composer that cannot prompt is disabled and refuses focus, and with configuration refused too
   * nothing in the composer bar can hold it either.
   */
  async function refuseCommands(page: Page, composer: Locator, except: string[] = []) {
    await page.evaluate((allowed) => {
      const refused = { allowed: false as const, reason: "Your Viewer role is read-only." };
      const commands = ["stop", "restart", "stopBackgroundJob", "archive", "unarchive", "prompt", "delete",
        "cancelTurn", "manageQueue", "rename", "configure", "respond"];
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
        commandPermissions: Object.fromEntries(commands.map((command) =>
          [command, allowed.includes(command) ? { allowed: true } : refused])),
      } as never);
    }, except);
    await expect(composer).toBeDisabled();
  }

  /** Session Activity takes focus, as it does when a resolved request cannot return it to the composer. */
  async function expectFocusMovesToSessionActivity(page: Page, control: Locator) {
    await control.focus();
    await expect(control).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(control).toHaveCount(0);
    await page.evaluate(() => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => document.activeElement?.tagName),
      "focus must not fall to the page body").not.toBe("BODY");
    await expect(page.getByRole("region", { name: "Session Activity" })).toBeFocused();
  }

  test("turns Plan mode off", async ({ page }) => {
    const composer = await openSession(page);
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      permissionMode: "plan",
    }));
    // The pill needs configuration allowed; a refused one is disabled and cannot be activated.
    await refuseCommands(page, composer, ["configure"]);
    await expectFocusMovesToSessionActivity(page, page.getByRole("button", { name: "Plan", exact: true }));
  });

  test("removes an image", async ({ page }) => {
    const composer = await openSession(page);
    await page.locator(".composer-attach-input").setInputFiles([
      { name: "one.png", mimeType: "image/png", buffer: DECODABLE_PNG },
    ]);
    await refuseCommands(page, composer);
    await expectFocusMovesToSessionActivity(page, page.getByRole("button", { name: "Remove Attached Image 1" }));
  });

  test("removes a workspace reference", async ({ page }) => {
    const composer = await openSession(page);
    await composer.pressSequentially("Review @src");
    await page.getByRole("option", { name: /src\/session\.ts/ }).click();
    await refuseCommands(page, composer);
    await expectFocusMovesToSessionActivity(page,
      page.getByRole("button", { name: "Remove Reference src/session.ts" }));
  });
});
