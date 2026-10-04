import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The mic toggles on a tap, works while held, and shows a Listening strip in place of the bar's left
 * group (#2193), against a fake SpeechRecognition the page can make "hear" words.
 */

const EVIDENCE = "test-results/composer-dictation-evidence";
const capture = process.env.CAPTURE_ISSUE_2193 === "1";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    type Result = { isFinal: boolean; 0: { transcript: string } };
    const log: string[] = [];
    const instances: Array<{ onresult: ((ev: { resultIndex: number; results: Result[] }) => void) | null }> = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((ev: { resultIndex: number; results: Result[] }) => void) | null = null;
      onend: (() => void) | null = null;
      onerror = null;
      constructor() { instances.push(this); }
      start() { log.push("start"); }
      stop() { log.push("stop"); queueMicrotask(() => this.onend?.()); }
      abort() { log.push("abort"); queueMicrotask(() => this.onend?.()); }
    }
    Object.assign(window, {
      dictationFixture: {
        log,
        hear(transcript: string, isFinal: boolean) {
          instances.at(-1)?.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] });
        },
      },
    });
    // Chromium ships the unprefixed constructor too, and the hook prefers it.
    for (const name of ["SpeechRecognition", "webkitSpeechRecognition"]) {
      Object.defineProperty(window, name, { configurable: true, value: FakeRecognition });
    }
  });
});

type DictationFixture = { log: string[]; hear: (transcript: string, isFinal: boolean) => void };

function hear(page: Page, transcript: string, isFinal = false) {
  return page.evaluate(([words, final]) =>
    (window as unknown as { dictationFixture: DictationFixture }).dictationFixture.hear(words, final),
  [transcript, isFinal] as const);
}

function recognizerLog(page: Page) {
  return page.evaluate(() => (window as unknown as { dictationFixture: DictationFixture }).dictationFixture.log.slice());
}

async function openComposer(page: Page, width: number, height: number, extra = "", expand = true) {
  await page.setViewportSize({ width, height });
  await page.goto(`/session-usage-e2e.html?width=${width}&height=${height - 40}&composer=codex${extra}`);
  await expect(page.locator(".composer-box")).toBeVisible();
  const idlePreview = page.locator(".composer-idle-preview");
  if (expand && await idlePreview.isVisible()) {
    await idlePreview.click();
    await expect(page.locator(".composer-input")).toBeFocused();
  }
}

/** A touch held on the control for `ms` before it lifts. */
async function touch(page: Page, control: Locator, ms: number) {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(ms);
  return async () => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  };
}

/** A mouse button held on the control for `ms` before it lifts. */
async function mousePress(page: Page, control: Locator, ms: number) {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  return () => page.mouse.up();
}

test("Enter and Space on the focused mic toggle dictation, and focus stays on the mic", async ({ page }) => {
  await openComposer(page, 1440, 900);
  const mic = page.getByRole("button", { name: "Dictate" });
  await expect(mic).toHaveAttribute("title", "Tap to dictate, or hold and release");
  await mic.focus();
  await page.keyboard.press("Enter");
  const stop = page.getByRole("button", { name: "Stop Dictating" });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(stop).toBeFocused();
  const strip = page.getByRole("status").filter({ hasText: "Listening…" });
  await expect(strip).toContainText("Tap the mic to stop");
  await expect(page.locator(".cbar-left")).toHaveCount(0);
  await expect(strip.locator(".dictation-timer")).toHaveText("00:00");
  await expect(strip.locator(".dictation-timer")).toHaveText("00:01", { timeout: 2_500 });

  await page.keyboard.press("Space");
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(mic).toBeFocused();
  await expect(strip).toHaveCount(0);
  await expect(page.locator(".cbar-left")).toBeVisible();
  expect(await recognizerLog(page)).toEqual(["start", "stop"]);
});

test("Escape in the composer ends dictation", async ({ page }) => {
  await openComposer(page, 1440, 900);
  const composer = page.locator(".composer-input");
  await composer.focus();
  await page.getByRole("button", { name: "Dictate" }).click();
  await expect(page.getByRole("button", { name: "Stop Dictating" })).toBeVisible();
  await expect(composer).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Dictate" })).toHaveAttribute("aria-pressed", "false");
  await expect(composer).toBeFocused();
});

test("the Listening dot pulses, and holds still with reduced motion", async ({ page }) => {
  await openComposer(page, 1440, 900);
  await page.getByRole("button", { name: "Dictate" }).click();
  const dot = page.locator(".dictation-dot");
  await expect(dot).toBeVisible();
  const box = await dot.boundingBox();
  expect(box?.width).toBeCloseTo(8, 0);
  expect(box?.height).toBeCloseTo(8, 0);
  expect(await dot.evaluate((element) => getComputedStyle(element).animationName)).toBe("pulse");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await dot.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  // The state stays in words.
  await expect(page.getByRole("status").filter({ hasText: "Listening…" })).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ hasTouch: true });

  test("a hold says to release, and releasing stops; the strip keeps the bar to one row with words in it", async ({ page }) => {
    await openComposer(page, 390, 844);
    const mic = page.getByRole("button", { name: "Dictate" });
    const release = await touch(page, mic, 700);
    const strip = page.getByRole("status").filter({ hasText: "Listening…" });
    await expect(strip).toContainText("Release to stop");
    await expect(page.getByRole("button", { name: "Stop Dictating" })).toHaveAttribute("aria-pressed", "true");
    await release();
    await expect(page.getByRole("button", { name: "Dictate" })).toHaveAttribute("aria-pressed", "false");
    expect(await recognizerLog(page)).toEqual(["start", "stop"]);

    const tap = await touch(page, mic, 100);
    await tap();
    await expect(strip).toContainText("Tap the mic to stop");
    await hear(page, "move the settings link under the account menu and rename it");
    const interim = strip.locator(".dictation-interim");
    await expect(interim).toHaveText("move the settings link under the account menu and rename it");
    await expect(page.locator(".composer-input")).toHaveValue("");
    // A phone strip has no room for the hint and the words together: the hint gives way to them.
    await expect(strip.locator(".dictation-hint")).toBeHidden();
    const layout = await page.locator(".composer-bar").evaluate((bar) => {
      const stripBox = bar.querySelector(".dictation-strip")!.getBoundingClientRect();
      const micBox = bar.querySelector('button[aria-label="Stop Dictating"]')!.getBoundingClientRect();
      const words = bar.querySelector(".dictation-interim")!.getBoundingClientRect();
      const label = bar.querySelector(".dictation-label")!.getBoundingClientRect();
      return {
        stripRight: stripBox.right,
        micLeft: micBox.left,
        wordsRight: words.right,
        wordsWidth: words.width,
        labelWidth: label.width,
        rows: new Set([...bar.querySelectorAll(".dictation-strip > :not(.dictation-hint), button")]
          .map((element) => Math.round(element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2))).size,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    expect(layout.rows, "the strip and the controls share one row").toBe(1);
    expect(layout.stripRight).toBeLessThanOrEqual(layout.micLeft);
    expect(layout.wordsRight).toBeLessThanOrEqual(layout.stripRight + 0.5);
    expect(layout.wordsWidth, "the words have room").toBeGreaterThan(80);
    expect(layout.labelWidth).toBeGreaterThan(0);
    expect(layout.overflow).toBe(false);

    await hear(page, "move the settings link", true);
    await expect(page.locator(".composer-input")).toHaveValue("move the settings link");
    await expect(interim).toHaveCount(0);
    await expect(strip.locator(".dictation-hint")).toBeVisible();
  });
});

test.describe("on a narrow phone", () => {
  test.use({ hasTouch: true });

  for (const width of [320, 360, 390, 430]) {
    test(`${width}px: the strip's contents stay inside it, beside the mic`, async ({ page }) => {
      await openComposer(page, width, 844);
      await page.getByRole("button", { name: "Dictate" }).click();
      const strip = page.locator(".dictation-strip");
      await expect(strip).toBeVisible();
      const fit = await strip.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const shown = [...element.children].filter((child) => getComputedStyle(child).display !== "none");
        return {
          inside: shown.every((child) => child.getBoundingClientRect().right <= box.right + 0.5),
          hint: shown.some((child) => child.classList.contains("dictation-hint")),
        };
      });
      expect(fit.inside).toBe(true);
      // From a 390px phone up there is room for the hint.
      expect(fit.hint).toBe(width >= 390);
      await expect(strip).toContainText("Listening…");
    });
  }
});

test.describe("UI evidence (#2193)", () => {
  test.skip(!capture, "set CAPTURE_ISSUE_2193=1 to capture the evidence screenshots");

  for (const { width, height, touch: coarse } of [
    { width: 1440, height: 900, touch: false },
    { width: 390, height: 844, touch: true },
  ]) {
    test.describe(`${width}px`, () => {
      test.use({ hasTouch: coarse });

      for (const theme of ["dark", "light"] as const) {
        test(`${theme}: idle, listening with words, held, and disabled on a stopped session`, async ({ page }) => {
          const shot = (name: string) => page.locator(".composer").screenshot({
            path: `${EVIDENCE}/after-${width}-${theme}-${name}.png`,
            animations: "disabled",
          });
          const setTheme = () => page.evaluate((next) => { document.documentElement.dataset.theme = next; }, theme);

          await openComposer(page, width, height, "&draft=Fix%20the%20header%20spacing");
          await setTheme();
          await page.locator(".composer-input").focus();
          await shot("idle");

          const press = coarse ? touch : mousePress;
          const mic = page.getByRole("button", { name: "Dictate" });
          await (await press(page, mic, 80))();
          await hear(page, "and keep the title on one line");
          await expect(page.locator(".dictation-interim")).toBeVisible();
          await page.waitForTimeout(2_100);
          await shot("listening");

          await (await press(page, page.getByRole("button", { name: "Stop Dictating" }), 80))();
          await expect(mic).toHaveAttribute("aria-pressed", "false");
          const release = await press(page, mic, 700);
          await expect(page.locator(".dictation-hint")).toHaveText("Release to stop");
          await shot("held");
          await release();

          // A stopped session's phone composer stays a capsule: it cannot take a message to expand for.
          await openComposer(page, width, height, "&action=restart", false);
          await setTheme();
          await expect(page.getByRole("button", { name: "Dictate" })).toBeDisabled();
          await shot("disabled-stopped");
        });
      }
    });
  }
});
