import { expect, test, type Page } from "@playwright/test";

const EVIDENCE = "test-results/composer-idle-capsule-evidence";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class FixtureSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult = null;
      onend = null;
      onerror = null;
      start() {}
      stop() {}
      abort() {}
    }
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: FixtureSpeechRecognition,
    });
  });
});

async function openComposer(page: Page, width: number, extra = "") {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/session-usage-e2e.html?width=${width}&height=804&composer=codex${extra}`);
  await expect(page.locator(".composer-box")).toBeVisible();
}

for (const width of [320, 360, 393, 430]) {
  test(`${width}px: an empty idle composer is one contained capsule row`, async ({ page }) => {
    await openComposer(page, width);
    const composer = page.locator(".composer-box");
    await expect(composer).toHaveClass(/idle-collapsed/);
    await expect(page.getByRole("button", { name: "Edit Message: Do anything" })).toHaveText("Do anything");

    const geometry = await composer.evaluate((element) => {
      const outer = element.getBoundingClientRect();
      const bounds = (selector: string) => {
        const inner = element.querySelector(selector)!.getBoundingClientRect();
        return { left: inner.left, right: inner.right, top: inner.top, bottom: inner.bottom };
      };
      return {
        outer: { left: outer.left, right: outer.right, top: outer.top, bottom: outer.bottom },
        bar: bounds(".composer-bar"),
        plus: bounds(".plus-btn"),
        preview: bounds(".composer-idle-preview"),
        dictation: bounds(".voice-btn"),
        action: bounds(".send-btn"),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

    for (const child of [geometry.bar, geometry.plus, geometry.preview, geometry.dictation, geometry.action]) {
      expect(child.left).toBeGreaterThanOrEqual(geometry.outer.left - 0.5);
      expect(child.right).toBeLessThanOrEqual(geometry.outer.right + 0.5);
      expect(child.top).toBeGreaterThanOrEqual(geometry.outer.top - 0.5);
      expect(child.bottom).toBeLessThanOrEqual(geometry.outer.bottom + 0.5);
    }
    expect(geometry.horizontalOverflow).toBe(false);
    expect(geometry.outer.bottom - geometry.outer.top).toBeLessThanOrEqual(44);
    if (width === 320) await page.screenshot({ path: `${EVIDENCE}/after-320-empty-capsule.png` });
  });
}

test("a single-line preview truncates visually while expansion preserves and focuses the full draft", async ({ page }) => {
  const draft = "Keep this complete single-line draft while its compact preview becomes deliberately much wider than a phone";
  await openComposer(page, 320, `&draft=${encodeURIComponent(draft)}`);
  const composer = page.locator(".composer-box");
  const preview = page.getByRole("button", { name: `Edit Message: ${draft}` });
  await expect(composer).toHaveClass(/idle-collapsed/);
  await expect(preview).toHaveText(draft);
  const clipping = await preview.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
    textOverflow: getComputedStyle(element).textOverflow,
  }));
  expect(clipping.scrollWidth).toBeGreaterThan(clipping.clientWidth);
  expect(clipping.whiteSpace).toBe("nowrap");
  expect(clipping.textOverflow).toBe("ellipsis");

  await preview.focus();
  await page.keyboard.press("Enter");
  const textarea = page.locator(".composer-input");
  await expect(textarea).toBeVisible();
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue(draft);
  await expect(page.getByRole("button", { name: /^Permission Mode:/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Model Settings:/ })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/after-320-expanded-draft.png` });

  await page.locator(".detail-reader").click({ position: { x: 4, y: 4 } });
  await expect(composer).toHaveClass(/idle-collapsed/);
  await expect(textarea).toHaveValue(draft);
});

for (const exception of [
  { name: "multi-line draft", query: "&draft=Line%20one%5CnLine%20two", visible: ".composer-input" },
  { name: "attachment", query: "&attachment=1", visible: ".image-strip" },
  { name: "pending approval", query: "&approval=checkpoint", visible: ".approval-bar" },
  { name: "pending question", query: "&approval=question&draft=Preserved", visible: ".composer-question-waiting" },
  { name: "recovery notice", query: "&quarantine=1", visible: ".quarantine-banner" },
]) {
  test(`${exception.name} keeps the phone composer expanded`, async ({ page }) => {
    await openComposer(page, 393, exception.query);
    await expect(page.locator(".composer-box")).not.toHaveClass(/idle-collapsed/);
    await expect(page.locator(".composer-input")).toBeVisible();
    await expect(page.locator(exception.visible)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Edit Message:/ })).toBeHidden();
  });
}

test("Answer Mode keeps the phone composer expanded", async ({ page }) => {
  await openComposer(page, 393, "&approval=question&draft=Preserved");
  await page.getByRole("button", { name: "Respond" }).click();
  await expect(page.locator(".composer-box")).toHaveClass(/answer-mode/);
  await expect(page.locator(".composer-box")).not.toHaveClass(/idle-collapsed/);
  await expect(page.getByText("Answer Mode", { exact: true })).toBeVisible();
});

test("resolving a focused phone request reveals and returns focus to the composer", async ({ page }) => {
  await openComposer(page, 393, "&approval=checkpoint");
  await page.getByRole("button", { name: "Continue" }).focus();
  await page.evaluate(() => window.resolveSessionUsageQuestion());

  const composer = page.locator(".composer-box");
  const textarea = page.locator(".composer-input");
  await expect(composer).not.toHaveClass(/idle-collapsed/);
  await expect(textarea).toBeVisible();
  await expect(textarea).toBeFocused();
});

test("a focused phone request falls back to the transcript when the composer becomes disabled", async ({ page }) => {
  await openComposer(page, 393, "&approval=permission");
  await expect(page.locator(".composer-input")).toBeEnabled();
  await page.getByRole("button", { name: "Allow Once" }).focus();
  await page.evaluate(() => window.setSessionUsageRunnerOnline(false));

  await expect(page.locator(".detail-scroll")).toBeFocused();
});

test("active dictation expands the capsule on the initial press", async ({ page }) => {
  await openComposer(page, 393);
  const composer = page.locator(".composer-box");
  const dictation = page.getByRole("button", { name: "Hold to Dictate" });
  await expect(composer).toHaveClass(/idle-collapsed/);
  await dictation.dispatchEvent("pointerdown", {
    button: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: "touch",
  });
  await expect(dictation).toHaveAttribute("aria-pressed", "true");
  await expect(composer).not.toHaveClass(/idle-collapsed/);
});

test.describe("touch dismissal", () => {
  test.use({ hasTouch: true });

  test("outside taps and canceled scroll gestures collapse after relinquishing focus", async ({ page }) => {
    await openComposer(page, 393);
    const composer = page.locator(".composer-box");
    const preview = page.getByRole("button", { name: /^Edit Message:/ });
    await preview.tap();
    await expect(page.locator(".composer-input")).toBeFocused();
    await page.locator(".detail-reader").tap({ position: { x: 8, y: 8 } });
    await expect(composer).toHaveClass(/idle-collapsed/);

    await preview.tap();
    const reader = page.locator(".detail-reader");
    await reader.dispatchEvent("pointerdown", {
      button: 0,
      isPrimary: true,
      pointerId: 4,
      pointerType: "touch",
    });
    await reader.dispatchEvent("pointercancel", {
      button: 0,
      isPrimary: true,
      pointerId: 4,
      pointerType: "touch",
    });
    await expect(composer).toHaveClass(/idle-collapsed/);
  });
});

test("Plus and every primary capsule action work with one activation", async ({ page }) => {
  await openComposer(page, 393);
  const plus = page.getByRole("button", { name: "Add and Modes" });
  await plus.click();
  await expect(plus).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".plus-pop")).toBeVisible();

  await openComposer(page, 393, "&draft=Ship%20it");
  await expect(page.locator(".composer-box")).toHaveClass(/idle-collapsed/);
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.locator("body").getAttribute("data-composer-action")).toBe("send");

  await openComposer(page, 393, "&action=stop");
  await expect(page.locator(".composer-box")).toHaveClass(/idle-collapsed/);
  await page.getByRole("button", { name: "Stop Turn" }).click();
  await expect.poll(() => page.locator("body").getAttribute("data-composer-action")).toBe("stop");

  await openComposer(page, 393, "&action=restart");
  await expect(page.locator(".composer-box")).toHaveClass(/idle-collapsed/);
  await page.getByRole("button", { name: "Restart Session" }).click();
  await expect.poll(() => page.locator("body").getAttribute("data-composer-action")).toBe("restart");
});

test("desktop keeps the expanded composer", async ({ page }) => {
  await openComposer(page, 900, "&draft=Desktop%20draft");
  await expect(page.locator(".composer-box")).not.toHaveClass(/idle-collapsed/);
  await expect(page.locator(".composer-input")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Edit Message:/ })).toBeHidden();
});
