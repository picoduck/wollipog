import { expect, test, type Page } from "@playwright/test";

const EVIDENCE = "test-results/composer-bar-evidence";

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

async function openFixture(page: Page, width: number, kind: "claude" | "codex" | "orchestrator", extra = "") {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/session-usage-e2e.html?width=${width}&height=804&composer=${kind}${extra}`);
  await expect(page.locator(".composer-box")).toBeVisible();
}

for (const width of [320, 360, 393, 430]) {
  for (const kind of ["claude", "codex", "orchestrator"] as const) {
    test(`${width}px ${kind}: Send stays inside one-line composer controls`, async ({ page }) => {
      await openFixture(page, width, kind);

      const geometry = await page.locator(".composer-box").evaluate((composer) => {
        const composerBounds = composer.getBoundingClientRect();
        const rect = (selector: string) => {
          const bounds = composer.querySelector(selector)!.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
        };
        const model = composer.querySelector(".cbar-model")!;
        const modelStyle = getComputedStyle(model);
        return {
          composer: {
            left: composerBounds.left,
            right: composerBounds.right,
            top: composerBounds.top,
            bottom: composerBounds.bottom,
          },
          bar: rect(".composer-bar"),
          send: rect(".send-btn"),
          model: rect(".cbar-model"),
          modelClientHeight: (model as HTMLElement).clientHeight,
          modelWhiteSpace: modelStyle.whiteSpace,
          modelText: model.textContent,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });

      expect(geometry.send.left).toBeGreaterThanOrEqual(geometry.composer.left - 0.5);
      expect(geometry.send.right).toBeLessThanOrEqual(geometry.composer.right + 0.5);
      expect(geometry.bar.left).toBeGreaterThanOrEqual(geometry.composer.left - 0.5);
      expect(geometry.bar.right).toBeLessThanOrEqual(geometry.composer.right + 0.5);
      expect(geometry.modelWhiteSpace).toBe("nowrap");
      expect(geometry.modelClientHeight).toBeLessThanOrEqual(20);
      expect(geometry.modelText).toContain(kind === "claude" ? "Claude Opus" : "GPT-6-Astra");
      expect(geometry.horizontalOverflow).toBe(false);
      await expect(page.getByRole("button", { name: "Hold to Dictate" })).toBeVisible();
      await expect(page.locator('.cbar-trigger[title^="Service Tier:"]')).toHaveCount(0);
      await expect(page.locator(".cbar-model")).toHaveCount(1);

      if (kind === "orchestrator") {
        await expect(page.getByRole("img", { name: "Permission Mode: Orchestrator" })).toBeVisible();
        await expect(page.locator(".permission-mode-menu")).toHaveCount(0);
      } else {
        const permission = page.getByRole("button", { name: /^Permission Mode:/ });
        await expect(permission).toBeVisible();
        await expect(permission).toHaveText("");
      }
    });
  }
}

test("393px Orchestrator Model Settings is a focus-safe bottom sheet with every setting", async ({ page }) => {
  await openFixture(page, 393, "orchestrator");
  await page.screenshot({ path: `${EVIDENCE}/after-mobile-orchestrator.png` });
  const trigger = page.getByRole("button", { name: /^Model Settings:/ });
  await trigger.click();
  const sheet = page.locator(".model-settings-pop");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Model Settings");
  for (const group of ["Model", "Context Window", "Reasoning Effort", "Service Tier"]) {
    await expect(sheet.getByRole("group", { name: group })).toBeVisible();
  }
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox).not.toBeNull();
  expect(sheetBox!.y + sheetBox!.height).toBeCloseTo(844, 0);
  for (const row of await sheet.getByRole("menuitemradio").all()) {
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(sheet.getByRole("group", { name: "Model" })).toContainText("with a 1M context window");
  await page.screenshot({ path: `${EVIDENCE}/after-mobile-model-settings.png` });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("desktop Model Settings stays an anchored popover", async ({ page }) => {
  await openFixture(page, 1200, "codex");
  const trigger = page.getByRole("button", { name: /^Model Settings:/ });
  await trigger.click();
  const popover = page.locator(".model-settings-pop");
  const [triggerBox, popoverBox] = await Promise.all([trigger.boundingBox(), popover.boundingBox()]);
  expect(triggerBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(triggerBox!.y + 0.5);
  await expect(popover).toContainText("Model Settings");
  await page.screenshot({ path: `${EVIDENCE}/after-desktop-model-settings.png` });
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: unrestricted permission icon has warning treatment with 3:1 contrast`, async ({ page }) => {
    await openFixture(page, 393, "codex", "&unsafe=1");
    await page.evaluate((nextTheme) => { document.documentElement.dataset.theme = nextTheme; }, theme);
    const warning = page.locator(".cbar-approvals.unrestricted");
    await expect(warning).toBeVisible();
    const ratio = await warning.evaluate((element) => {
      const parse = (value: string) => {
        const rgb = value.match(/rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/i);
        if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
        const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
        if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])];
        throw new Error(`Unsupported computed colour: ${value}`);
      };
      const luminance = (channels: number[]) => channels.reduce((sum, channel, index) => {
        const linear = channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
      }, 0);
      const foreground = luminance(parse(getComputedStyle(element).color));
      const surface = luminance(parse(getComputedStyle(element.closest(".composer-box")!).backgroundColor));
      return (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: `${EVIDENCE}/after-${theme}-unrestricted.png` });
  });
}
