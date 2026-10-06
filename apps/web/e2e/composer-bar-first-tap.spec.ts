import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { DECODABLE_PNG } from "./fixtures/prompt-image.js";

/**
 * One tap on a composer bar control acts on the first try while the composer is focused (#1797).
 *
 * On a coarse pointer the bottom rail is removed while a text field holds focus (styles.css). A
 * control that lets the tap blur the composer brings the rail back between `pointerdown` and
 * `click`, the composer bar jumps up by the rail's height, and the click lands on whatever now
 * sits under the finger — so the first tap only closed the keyboard. Each control below must act
 * on a single tap from that state.
 */

const phone = devices["Pixel 7"];
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  userAgent: phone.userAgent,
  deviceScaleFactor: phone.deviceScaleFactor,
});

async function openSession(page: Page, scenario = "permission-mode-layout") {
  // The full Shell: the rail whose return moves the bar exists only there.
  const url = `/command-inbox-projects-e2e.html?scenario=${scenario}&fullShell=1`;
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".session-bar")).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], ["default", "acceptEdits"], {
    models: [{ id: "fixture-large", displayName: "Fixture Large" }, { id: "fixture-small", displayName: "Fixture Small" }],
  }));
  // Both gates the race needs: the rail must exist, and the rail rule is keyed on a coarse
  // pointer. Without either nothing moves under the finger and every case below would pass
  // without exercising it.
  await expect(page.locator(".app-rail")).toBeVisible();
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    "this emulation must report the coarse pointer the rail rule is gated to").toBe(true);
}

/** Puts the page in the state the bug needs: composer focused, rail removed. */
async function focusComposer(page: Page) {
  const idlePreview = page.locator(".composer-idle-preview");
  if (await idlePreview.isVisible()) await idlePreview.tap();
  const composer = page.locator(".composer-input");
  await composer.focus();
  await expect(composer).toBeFocused();
  await expect(page.locator(".app-rail")).toBeHidden();
  return composer;
}

/**
 * A single touch tap at the control's position as rendered with the composer focused, held for as
 * long as a finger's tap lasts. `touchscreen.tap` lifts in the same instant it lands, so anything
 * that expires between pointerdown and click — a zero-delay timer, a frame — never gets the chance.
 */
async function tapOnce(page: Page, control: Locator) {
  const box = await control.boundingBox();
  expect(box, "the control must be on screen before the tap").not.toBeNull();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(120);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/**
 * The opened layer keeps the focus it takes. The composer is no longer blurred by the tap itself,
 * so its blur now happens when the layer claims focus — and the composer's recovery of accidental
 * background blurs, which runs a frame later, must not read that as one and pull focus back.
 */
async function expectFocusSettlesIn(page: Page, layer: Locator) {
  await expect(layer).toBeVisible();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await layer.evaluate((element) => element.contains(document.activeElement)),
    "focus must move into the opened layer and stay there").toBe(true);
}

test.describe("with the composer focused, one tap", () => {
  test("opens the Attach and Settings menu", async ({ page }) => {
    await openSession(page);
    await focusComposer(page);
    await tapOnce(page, page.getByRole("button", { name: "Attach and Settings" }));
    await expectFocusSettlesIn(page, page.getByRole("menu", { name: "Attach and Settings" }));
  });

  test("opens the permission-mode menu", async ({ page }) => {
    await openSession(page);
    await focusComposer(page);
    await tapOnce(page, page.locator(".permission-mode-menu .cbar-trigger"));
    await expectFocusSettlesIn(page, page.locator('.menu[aria-label="Permission Mode"]'));
  });

  test("opens the model settings sheet", async ({ page }) => {
    await openSession(page);
    await focusComposer(page);
    await tapOnce(page, page.locator(".model-settings-menu .cbar-trigger"));
    await expectFocusSettlesIn(page, page.getByRole("dialog", { name: "Model Settings" }));
  });

  test("opens a workspace reference chip's inspector", async ({ page }) => {
    await openSession(page);
    const composer = await focusComposer(page);
    await composer.pressSequentially("Review @src");
    await page.getByRole("option", { name: /src\/session\.ts/ }).click();
    const chip = page.getByRole("button", { name: "Inspect Reference src/session.ts" });
    await expect(chip).toBeVisible();
    await focusComposer(page);
    await tapOnce(page, chip);
    const inspector = page.getByRole("dialog", { name: "File Reference" });
    await expectFocusSettlesIn(page, inspector);
    // The chip opened it, so the chip gets focus back — not the composer the tap never blurred.
    await inspector.getByRole("button", { name: "Close" }).click();
    await expect(inspector).toHaveCount(0);
    await expect(chip).toBeFocused();
  });

  test("turns Plan mode off, and keeps the composer focused", async ({ page }) => {
    await openSession(page);
    await page.evaluate(() => {
      const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
      fixture.setSlashCommands([], ["default", "acceptEdits", "plan"]);
      fixture.updateSession("session-alpha", { permissionMode: "plan" });
    });
    // The idle phone composer collapses the bar; focusing it shows the Plan toggle (#2174).
    const composer = await focusComposer(page);
    const pill = page.getByRole("button", { name: "Plan", exact: true });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("aria-pressed", "true");
    await tapOnce(page, pill);
    await expect(pill).toHaveCount(0);
    // The toggle unmounts with the mode it shows, so focus must not have gone to it.
    await expect(composer).toBeFocused();
  });

  test("removes an image, and keeps the composer focused", async ({ page }) => {
    await openSession(page);
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], ["default", "acceptEdits"], {
      supportsImages: true,
    }));
    await page.locator(".composer-attach-input").setInputFiles([
      { name: "one.png", mimeType: "image/png", buffer: DECODABLE_PNG },
    ]);
    const remove = page.getByRole("button", { name: "Remove Attached Image 1" });
    await expect(remove).toHaveCount(1);
    const composer = await focusComposer(page);
    await tapOnce(page, remove);
    await expect(remove).toHaveCount(0);
    // The ✕ unmounts with its chip, so focus must not have gone to it.
    await expect(composer).toBeFocused();
  });

  test("removes a workspace reference, and keeps the composer focused", async ({ page }) => {
    await openSession(page);
    const composer = await focusComposer(page);
    await composer.pressSequentially("Review @src");
    await page.getByRole("option", { name: /src\/session\.ts/ }).click();
    const remove = page.getByRole("button", { name: "Remove Reference src/session.ts" });
    await expect(remove).toBeVisible();
    await focusComposer(page);
    await tapOnce(page, remove);
    await expect(remove).toHaveCount(0);
    await expect(composer).toBeFocused();
  });

  test("sends, and keeps the composer focused", async ({ page }) => {
    await openSession(page);
    const composer = await focusComposer(page);
    await composer.fill("Ship it");
    await tapOnce(page, page.getByRole("button", { name: "Send" }));
    await expect.poll(() => page.evaluate(() =>
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);
    await expect(composer).toBeFocused();
  });

  test("stops the turn, and keeps the composer focused", async ({ page }) => {
    await openSession(page);
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      status: "running",
      activeTurnId: "turn-1",
    }));
    const composer = await focusComposer(page);
    await tapOnce(page, page.getByRole("button", { name: "Stop Turn" }));
    await expect.poll(() => page.evaluate(() =>
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.cancelTurnCount())).toBe(1);
    await expect(composer).toBeFocused();
  });

  test("starts dictation from a 44px hit area, keeps it on, and keeps the composer focused (#2193)", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { dictationStarts: number; dictationStops: number };
      w.dictationStarts = 0;
      w.dictationStops = 0;
      class FakeRecognition {
        continuous = false;
        interimResults = false;
        lang = "";
        onresult = null;
        onend: (() => void) | null = null;
        onerror = null;
        start() { w.dictationStarts += 1; }
        stop() { w.dictationStops += 1; queueMicrotask(() => this.onend?.()); }
        abort() { queueMicrotask(() => this.onend?.()); }
      }
      // Chromium ships the unprefixed constructor too, and the hook prefers it.
      for (const name of ["SpeechRecognition", "webkitSpeechRecognition"]) {
        Object.defineProperty(window, name, { configurable: true, value: FakeRecognition });
      }
    });
    await openSession(page);
    const composer = await focusComposer(page);
    const mic = page.getByRole("button", { name: "Dictate" });
    // 36px to look, with a hit area 4px past each edge: a tap 3px outside still lands on the mic.
    const hitArea = await mic.evaluate((control) => {
      const box = control.getBoundingClientRect();
      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      const hits = (x: number, y: number) => {
        const target = document.elementFromPoint(x, y);
        return target !== null && (target === control || control.contains(target));
      };
      return {
        width: box.width,
        height: box.height,
        edges: [hits(centerX, box.top - 3), hits(centerX, box.bottom + 3), hits(box.left - 3, centerY), hits(box.right + 3, centerY)],
      };
    });
    expect(hitArea.width).toBeCloseTo(36, 0);
    expect(hitArea.height).toBeCloseTo(36, 0);
    expect(hitArea.edges, "the mic has a 44px hit area").toEqual([true, true, true, true]);

    await tapOnce(page, mic);
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { dictationStarts: number }).dictationStarts)).toBe(1);
    await expect(composer).toBeFocused();
    // A tap is not a hold: dictation stays on after the finger lifts, until the next tap.
    const stopDictating = page.getByRole("button", { name: "Stop Dictating" });
    await expect(stopDictating).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status").filter({ hasText: "Listening…" })).toContainText("Tap the mic to stop");
    expect(await page.evaluate(() => (window as unknown as { dictationStops: number }).dictationStops)).toBe(0);

    await tapOnce(page, stopDictating);
    await expect(page.getByRole("button", { name: "Dictate" })).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate(() => (window as unknown as { dictationStops: number }).dictationStops)).toBe(1);
    await expect(composer).toBeFocused();
  });
});

test("one tap restarts a stopped Session", async ({ page }) => {
  // A stopped Session's composer is disabled, so it cannot hold focus and the rail stays put; the
  // tap still has to act at once.
  await openSession(page, "composer-restart");
  await expect(page.locator(".composer-input")).toBeDisabled();
  await tapOnce(page, page.getByRole("button", { name: "Restart Session" }));
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.restartRequests())).toEqual(["session-alpha"]);
});
