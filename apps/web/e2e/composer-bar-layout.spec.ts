import { expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

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

async function openFixture(page: Page, width: number, kind: "claude" | "codex" | "orchestrator" | "pi", extra = "") {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/session-usage-e2e.html?width=${width}&height=804&composer=${kind}${extra}`);
  await expect(page.locator(".composer-box")).toBeVisible();
}

test("Pi exposes verified permission choices and their delivery outcomes", async ({ page }) => {
  await openFixture(page, 900, "pi");
  await expect(page.locator(".composer-input")).toBeVisible();
  await page.getByRole("button", { name: "Permission Mode: Ask Every Time" }).click();
  const menu = page.locator('.menu[aria-label="Permission Mode"]');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Permission Mode");
  await expect(menu.getByRole("menuitemradio", { name: /Default/ })).toContainText("Approvals Available");
  await expect(menu.getByRole("menuitemradio", { name: /Don't Ask/ })).toContainText("Blocks Requests");
  await expect(menu.getByRole("menuitemradio", { name: /Full Access/ })).toContainText("No Command Approvals");
  await page.screenshot({ path: `${EVIDENCE}/after-pi-permission-modes.png` });
});

async function expandComposer(page: Page) {
  await page.locator(".composer-idle-preview").click();
  await expect(page.locator(".composer-input")).toBeVisible();
  await expect(page.locator(".composer-input")).toBeFocused();
}

for (const width of [320, 360, 393, 430]) {
  for (const kind of ["claude", "codex", "orchestrator"] as const) {
    test(`${width}px ${kind}: Send stays inside one-line composer controls`, async ({ page }) => {
      await openFixture(page, width, kind);
      await expandComposer(page);

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
      expect(geometry.model.right - geometry.model.left).toBeGreaterThanOrEqual(12);
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

test.describe("with a touch pointer", () => {
  // Touch sizing follows the pointer, not the viewport (#1799): the 44px sheet targets are a touch-screen size.
  test.use({ hasTouch: true });

  test("393px Orchestrator Model Settings is a focus-safe bottom sheet with every setting", async ({ page }) => {
    await openFixture(page, 393, "orchestrator");
    await expandComposer(page);
    await page.screenshot({ path: `${EVIDENCE}/after-mobile-orchestrator.png` });
    const trigger = page.getByRole("button", { name: /^Model Settings:/ });
    await trigger.click();
    const sheet = page.locator('.menu[aria-label="Model Settings"]');
    await expect(sheet).toBeVisible();
    await dialogMotionSettled(page);
    await expect(sheet).toContainText("Model Settings");
    const close = sheet.getByRole("menuitem", { name: "Close Model Settings" });
    await expect(close).toBeVisible();
    const [closeBox, titleBox] = await Promise.all([
      close.boundingBox(),
      sheet.getByText("Model Settings", { exact: true }).boundingBox(),
    ]);
    expect(closeBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(closeBox!.width).toBeGreaterThanOrEqual(44);
    expect(closeBox!.height).toBeGreaterThanOrEqual(44);
    expect(closeBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width);
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
    await sheet.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(close).toBeVisible();
    const scrolledCloseBox = await close.boundingBox();
    expect(scrolledCloseBox).not.toBeNull();
    expect(scrolledCloseBox!.y).toBeCloseTo(closeBox!.y, 0);
    await close.click();
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.locator(".menu-backdrop").click({ position: { x: 1, y: 1 } });
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

for (const { frameWidth, plan } of [
  { frameWidth: 360, plan: false },
  { frameWidth: 500, plan: true },
]) {
  test(`desktop Model Settings stays inside a ${frameWidth}px clipped pane${plan ? " with Plan" : ""}`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 844 });
    await page.goto(`/session-usage-e2e.html?width=${frameWidth}&height=804&tiers=1${plan ? "&plan=1" : ""}`);
    if (plan) await expect(page.getByRole("button", { name: "◒ Plan" })).toBeVisible();
    const trigger = page.getByRole("button", { name: /^Model Settings:/ });
    await trigger.click();
    const popover = page.locator('.menu[aria-label="Model Settings"]');
    await expect(popover).toBeVisible();
    await dialogMotionSettled(page);
    const close = popover.getByRole("menuitem", { name: "Close Model Settings" });
    const [frameBox, triggerBox, popoverBox, closeBox] = await Promise.all([
      page.locator("#frame").boundingBox(),
      trigger.boundingBox(),
      popover.boundingBox(),
      close.boundingBox(),
    ]);
    expect(frameBox).not.toBeNull();
    expect(triggerBox).not.toBeNull();
    expect(popoverBox).not.toBeNull();
    expect(closeBox).not.toBeNull();
    expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(triggerBox!.y + 0.5);
    expect(popoverBox!.x).toBeGreaterThanOrEqual(frameBox!.x);
    expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(frameBox!.x + frameBox!.width);
    expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(popoverBox!.x + popoverBox!.width);
    expect(closeBox!.y).toBeGreaterThanOrEqual(popoverBox!.y);
    await expect(popover).toContainText("Model Settings");
    if (!plan) await page.screenshot({ path: `${EVIDENCE}/after-desktop-model-settings.png` });
  });
}

for (const kind of ["claude", "codex"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme} ${kind}: unrestricted permission icon has warning treatment with 3:1 contrast`, async ({ page }) => {
      await openFixture(page, 393, kind, "&unsafe=1");
      await page.evaluate((nextTheme) => { document.documentElement.dataset.theme = nextTheme; }, theme);
      await expandComposer(page);
      const warning = page.locator(".cbar-approvals.unrestricted");
      await expect(warning).toBeVisible();
      const ratio = await warning.evaluate((element) => {
        const parse = (value: string) => {
          const rgb = value.match(/rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/i);
          if (rgb) return {
            channels: [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255],
            alpha: rgb[4] === undefined ? 1 : Number(rgb[4]),
          };
          const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/i);
          if (srgb) return {
            channels: [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])],
            alpha: srgb[4] === undefined ? 1 : Number(srgb[4]),
          };
          throw new Error(`Unsupported computed colour: ${value}`);
        };
        const luminance = (channels: number[]) => channels.reduce((sum, channel, index) => {
          const linear = channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
        }, 0);
        const foreground = luminance(parse(getComputedStyle(element).color).channels);
        const composerSurface = parse(getComputedStyle(element.closest(".composer-box")!).backgroundColor).channels;
        const warningSurface = parse(getComputedStyle(element).backgroundColor);
        const compositedSurface = warningSurface.channels.map((channel, index) => (
          channel * warningSurface.alpha + composerSurface[index]! * (1 - warningSurface.alpha)
        ));
        const surface = luminance(compositedSurface);
        return (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05);
      });
      expect(ratio).toBeGreaterThanOrEqual(3);
      await page.screenshot({ path: `${EVIDENCE}/after-${theme}-${kind}-unrestricted.png` });
    });
  }
}

/** The computed colour a token resolves to on this page, for comparing against computed borders. */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

for (const { width, height } of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const theme of ["dark", "light"] as const) {
    test(`${width}px ${theme}: a focused composer shows one edge in --focus and nothing teal (#2154)`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(`/session-usage-e2e.html?width=${width}&height=${height - 40}&composer=codex&draft=Ship%20it`);
      await page.evaluate((nextTheme) => { document.documentElement.dataset.theme = nextTheme; }, theme);
      const box = page.locator(".composer-box");
      await expect(box).toBeVisible();
      if (width < 761) await page.locator(".composer-idle-preview").click();
      const input = page.locator(".composer-input");
      await input.focus();
      await expect(input).toBeFocused();
      const [focus, accent] = await Promise.all([tokenColor(page, "--focus"), tokenColor(page, "--accent")]);
      const painted = await box.evaluate((card) => {
        const edges = (element: Element) => {
          const style = getComputedStyle(element);
          return {
            borders: (["Top", "Right", "Bottom", "Left"] as const)
              .filter((side) => style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none" &&
                Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0)
              .map((side) => style.getPropertyValue(`border-${side.toLowerCase()}-color`)),
            outline: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0 ? style.outlineColor : null,
            ring: style.boxShadow,
          };
        };
        return {
          card: edges(card),
          inner: [...card.querySelectorAll("*")].map((element) => ({ name: element.className.toString(), ...edges(element) })),
        };
      });
      expect(new Set(painted.card.borders)).toEqual(new Set([focus]));
      expect(painted.card.outline).toBeNull();
      expect(painted.card.ring).toBe("none");
      const field = painted.inner.find((element) => element.name.includes("composer-input"));
      expect(field?.outline).toBeNull();
      for (const element of [painted.card, ...painted.inner]) {
        expect(element.borders).not.toContain(accent);
        expect(element.outline).not.toBe(accent);
      }
      await page.screenshot({ path: `${EVIDENCE}/after-${width}-${theme}-focused-draft.png` });
    });
  }
}

test("the placeholder takes --text-faint (#2154)", async ({ page }) => {
  await openFixture(page, 1440, "codex");
  const faint = await tokenColor(page, "--text-faint");
  const placeholder = await page.locator(".composer-input").evaluate((input) => getComputedStyle(input, "::placeholder").color);
  expect(placeholder).toBe(faint);
});

for (const width of [390, 834]) {
  test(`${width}px: the card keeps a 12px gutter on both sides of the column (#2154)`, async ({ page }) => {
    await openFixture(page, width, "codex", "&draft=Line%20one%5CnLine%20two");
    const gutters = await page.locator(".composer").evaluate((column) => {
      const outer = column.getBoundingClientRect();
      const card = column.querySelector(".composer-box")!.getBoundingClientRect();
      return { left: card.left - outer.left, right: outer.right - card.right };
    });
    expect(gutters.left).toBeCloseTo(12, 0);
    expect(gutters.right).toBeCloseTo(12, 0);
  });
}

test("an empty desktop card is one line tall, and a long draft stops growing at 12 lines (#2154)", async ({ page }) => {
  await openFixture(page, 1440, "codex");
  const box = page.locator(".composer-box");
  const empty = await box.boundingBox();
  expect(empty!.height).toBeLessThanOrEqual(88);
  const input = page.locator(".composer-input");
  await input.fill(Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join("\n"));
  const grown = await input.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(grown.height).toBeCloseTo(12 * 22, 0);
  expect(grown.scrollHeight).toBeGreaterThan(grown.clientHeight);
});

for (const { name, query, reason } of [
  { name: "failed", query: "&status=failed", reason: "This session failed and can't take new messages." },
  { name: "stopped", query: "&action=restart", reason: "This session is stopped. Restart it to send a message." },
]) {
  test(`a ${name} session's bar reads as paused with its reason (#2154)`, async ({ page }) => {
    await openFixture(page, 1440, "codex", query);
    const box = page.locator(".composer-box");
    await expect(box).toHaveClass(/is-disabled/);
    await expect(page.locator(".composer-input")).toHaveAttribute("placeholder", reason);
    for (const control of [
      page.getByRole("button", { name: /^Permission Mode:/ }),
      page.getByRole("button", { name: /^Model Settings:/ }),
      page.getByRole("button", { name: "Hold to Dictate" }),
    ]) {
      await expect(control).toBeVisible();
      await expect(control).toBeDisabled();
      await expect(control).toHaveAccessibleDescription(reason);
    }
  });
}
