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
          send: rect(".composer-btn.primary"),
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
    if (plan) await expect(page.getByRole("button", { name: "Plan", exact: true })).toBeVisible();
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
      // Amber on the icon only (§21 item 5): a shield-alert glyph, and no amber fill or edge on the
      // icon or on the control around it (#2174).
      await expect(warning.locator("svg.lucide-shield-alert")).toHaveCount(1);
      expect(await warning.evaluate((element) => getComputedStyle(element).color)).toBe(await tokenColor(page, "--amber"));
      const trigger = page.getByRole("button", { name: /^Permission Mode:/ });
      for (const element of [warning, trigger]) {
        const paint = await element.evaluate((node) => {
          const style = getComputedStyle(node);
          const edged = style.borderTopStyle !== "none" && Number.parseFloat(style.borderTopWidth) > 0;
          return { background: style.backgroundColor, border: edged ? style.borderTopColor : null };
        });
        expect(paint.background).toBe("rgba(0, 0, 0, 0)");
        expect(paint.border).not.toBe(await tokenColor(page, "--amber"));
      }
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

/** WCAG contrast between two computed colours, both opaque: `rgb()` channels are 0–255, and a
 * `color-mix()` computes to `color(srgb …)` with 0–1 channels. */
function contrast(a: string, b: string): number {
  const luminance = (value: string) => {
    const channels = value.match(/[\d.]+/g)!.map(Number).slice(0, 3);
    const scale = value.startsWith("color(") ? 1 : 255;
    return channels.reduce((sum, channel, index) => {
      const c = channel / scale;
      const linear = c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
    }, 0);
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

for (const { name, query, reason } of [
  { name: "failed", query: "&status=failed", reason: "This session failed and can't take new messages." },
  { name: "stopped", query: "&action=restart", reason: "This session is stopped. Restart it to send a message." },
]) {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: a ${name} session's bar reads as paused with its reason (#2154, #2174)`, async ({ page }) => {
      await openFixture(page, 1440, "codex", query);
      await page.evaluate((nextTheme) => { document.documentElement.dataset.theme = nextTheme; }, theme);
      const box = page.locator(".composer-box");
      await expect(box).toHaveClass(/is-disabled/);
      await expect(page.locator(".composer-input")).toHaveAttribute("placeholder", reason);
      // + stays openable on a paused composer (#2175), so Guardrails can still be read; the menu's
      // rows that act refuse with the reason instead.
      const plus = page.getByRole("button", { name: "Attach and Settings" });
      await expect(plus).toBeEnabled();
      const controls = [
        page.getByRole("button", { name: /^Permission Mode:/ }),
        page.getByRole("button", { name: /^Model Settings:/ }),
        page.getByRole("button", { name: "Hold to Dictate" }),
      ];
      for (const control of controls) {
        await expect(control).toBeVisible();
        await expect(control).toBeDisabled();
        await expect(control).toHaveAccessibleDescription(reason);
      }
      await page.evaluate(() => Promise.all(document.getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined))));
      // A disabled control must look disabled: its ink well below a ghost control at rest
      // (--text-dim), yet still at least the 3:1 glyph floor on either page fill (§21 item 10).
      const [rest, bg, elev] = await Promise.all([
        tokenColor(page, "--text-dim"), tokenColor(page, "--bg"), tokenColor(page, "--bg-elev"),
      ]);
      const inks = {
        shield: await controls[0]!.evaluate((element) => getComputedStyle(element.querySelector("svg")!).color),
        modelName: await controls[1]!.locator(".cbar-model").evaluate((element) => getComputedStyle(element).color),
        agentMark: await controls[1]!.locator(".agent-icon").evaluate((element) => getComputedStyle(element).color),
        mic: await controls[2]!.evaluate((element) => getComputedStyle(element).color),
      };
      for (const [control, ink] of Object.entries(inks)) {
        expect(contrast(ink, rest), `${control} is clearly dimmer than rest`).toBeGreaterThanOrEqual(1.8);
        expect(contrast(ink, bg), `${control} stays legible on --bg`).toBeGreaterThanOrEqual(3);
        expect(contrast(ink, elev), `${control} stays legible on --bg-elev`).toBeGreaterThanOrEqual(3);
      }
      expect(new Set(Object.values(inks)).size, "one disabled ink, agent mark included").toBe(1);
      expect(await plus.evaluate((element) => getComputedStyle(element).color), "+ keeps its rest ink").not.toBe(inks.shield);
    });
  }
}

/**
 * One recipe for every bar control (#2174): `--composer-ctl` tall (32px on a fine pointer; 36px on
 * a coarse one, with a 44px hit area and 8px between neighbours), square-cornered, and Send the only
 * accent fill.
 */
async function readBarControls(page: Page) {
  // Fills ease between states (Send turns from disabled to primary once the draft loads): read the
  // settled colours, not a frame of the transition.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation instanceof CSSTransition)
    .map((animation) => animation.finished.catch(() => undefined))));
  return page.locator(".composer-bar").evaluate((bar) => {
    const controls = [...bar.querySelectorAll<HTMLElement>(".composer-btn, .cbar-permission-badge")]
      .filter((element) => element.getClientRects().length > 0);
    return controls.map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      // A hit test 3px past each visible edge, inside the last pixel of the 4px each side borrows:
      // on a coarse pointer it must still land on the control (44px). Neighbours 8px apart meet
      // exactly between them, so this also proves neither takes the other's taps.
      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      const hits = (x: number, y: number) => {
        const target = document.elementFromPoint(x, y);
        return target !== null && (target === element || element.contains(target));
      };
      return {
        name: element.getAttribute("aria-label") ?? element.textContent ?? "",
        left: box.left,
        right: box.right,
        top: box.top,
        height: box.height,
        width: box.width,
        radius: Number.parseFloat(style.borderTopLeftRadius),
        background: style.backgroundColor,
        hitArea: {
          above: hits(centerX, box.top - 3),
          below: hits(centerX, box.bottom + 3),
          left: hits(box.left - 3, centerY),
          right: hits(box.right + 3, centerY),
        },
      };
    });
  });
}

for (const { name, width, height, touch } of [
  { name: "1440px fine pointer", width: 1440, height: 900, touch: false },
  { name: "1440px coarse pointer", width: 1440, height: 900, touch: true },
  { name: "390px coarse pointer", width: 390, height: 844, touch: true },
]) {
  test.describe(name, () => {
    test.use({ hasTouch: touch });

    test(`every bar control is one recipe at ${name} (#2174)`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(`/session-usage-e2e.html?width=${width}&height=${height - 40}&composer=codex&plan=1&draft=Ship%20it`);
      await expect(page.locator(".composer-box")).toBeVisible();
      if (width < 761) await expandComposer(page);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(touch);

      const controls = await readBarControls(page);
      const names = controls.map((control) => control.name);
      for (const expected of ["Attach and Settings", /^Permission Mode:/, /^Model Settings:/, "Plan", "Hold to Dictate", "Send"]) {
        expect(names.some((controlName) => typeof expected === "string" ? controlName === expected : expected.test(controlName)),
          `${String(expected)} is in the bar: ${names.join(", ")}`).toBe(true);
      }
      if (width > 760) {
        // The context and cost triggers #2166 seats in the bar wear the same recipe.
        expect(names.some((controlName) => /^Context Window .* Used$/.test(controlName))).toBe(true);
        expect(names.some((controlName) => /^Session Usage: /.test(controlName))).toBe(true);
      }

      const primary = await tokenColor(page, "--primary-bg");
      const accent = await tokenColor(page, "--accent");
      const visible = touch ? 36 : 32;
      const sorted = [...controls].sort((a, b) => a.left - b.left);
      for (const control of controls) {
        expect(control.height, `${control.name} is ${visible}px tall`).toBeCloseTo(visible, 0);
        // No circle and no pill (§2.5): the control radius, never half the height.
        expect(control.radius, `${control.name} is a rounded square`).toBeLessThanOrEqual(6);
        if (control.name !== "Send") {
          expect([primary, accent], `${control.name} has no accent fill`).not.toContain(control.background);
        }
        if (touch) {
          expect(control.hitArea, `${control.name} has a 44px hit area`).toEqual({ above: true, below: true, left: true, right: true });
        }
      }
      expect(controls.find((control) => control.name === "Send")?.background).toBe(primary);
      expect(new Set(controls.map((control) => Math.round(control.top + control.height / 2))).size, "one row").toBe(1);
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index]!.left - sorted[index - 1]!.right,
          `${sorted[index - 1]!.name} and ${sorted[index]!.name} are 8px apart`).toBeGreaterThanOrEqual(touch ? 8 : 4);
      }
      await page.locator(".composer-box").screenshot({ path: `${EVIDENCE}/after-${width}-${touch ? "coarse" : "fine"}-plan.png` });
    });
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: Stop Turn is a neutral square named for its shortcut, with no red (#2174)`, async ({ page }) => {
    await openFixture(page, 1440, "codex", "&action=stop");
    await page.evaluate((nextTheme) => { document.documentElement.dataset.theme = nextTheme; }, theme);
    const stop = page.getByRole("button", { name: "Stop Turn", exact: true });
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAttribute("title", /^Stop turn \(.+\)$/);
    const paint = await stop.evaluate((element) => {
      const style = getComputedStyle(element);
      const icon = element.querySelector("svg")!;
      return [style.color, style.backgroundColor, style.borderTopColor, getComputedStyle(icon).color, getComputedStyle(icon).fill];
    });
    const reddish = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
      const [r = 0, g = 0, b = 0, alpha = 1] = channels;
      return alpha > 0 && r - Math.max(g, b) > 40;
    };
    for (const value of paint) expect(reddish(value), `Stop Turn paints ${value}`).toBe(false);
    const box = await stop.boundingBox();
    expect(box?.width).toBeCloseTo(32, 0);
    expect(box?.height).toBeCloseTo(32, 0);
    await page.locator(".composer-box").screenshot({ path: `${EVIDENCE}/after-${theme}-stop-turn.png` });
  });
}

for (const forcedColors of [false, true]) {
  test(`a disabled Plan toggle keeps the disabled ink and edge${forcedColors ? " in forced colors" : ""} (#2174)`, async ({ page }) => {
    if (forcedColors) await page.emulateMedia({ forcedColors: "active" });
    await openFixture(page, 1440, "codex", "&plan=1&status=failed");
    const plan = page.getByRole("button", { name: "Plan", exact: true });
    await expect(plan).toBeDisabled();
    await expect(plan).toHaveAttribute("aria-pressed", "true");
    const disabledInk = await page.evaluate((forced) => {
      // What a disabled ghost ComposerButton paints here (in forced colors, any disabled button's
      // GrayText ink and edge): the recipe the toggle must keep.
      const probe = document.createElement("button");
      probe.className = forced ? "btn" : "btn ghost composer-btn";
      probe.disabled = true;
      probe.textContent = "Probe";
      document.querySelector(".composer-box")!.append(probe);
      const style = getComputedStyle(probe);
      const ink = { color: style.color, border: style.borderTopColor };
      probe.remove();
      return forced ? ink : { color: ink.color, border: null };
    }, forcedColors);
    const painted = await plan.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, border: style.borderTopColor };
    });
    expect(painted.color).toBe(disabledInk.color);
    if (forcedColors) expect(painted.border).toBe(disabledInk.border);
    else expect(painted.border).not.toBe(await tokenColor(page, "--control-outline"));
  });
}

/** What a disabled ghost ComposerButton paints inside the composer: the ink every disabled bar control keeps. */
async function disabledInk(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("button");
    probe.className = "btn ghost composer-btn";
    probe.disabled = true;
    probe.textContent = "Probe";
    document.querySelector(".composer-box")!.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

test("controls disabled while open or unrestricted take the disabled ink (#2174)", async ({ page }) => {
  await openFixture(page, 1440, "codex", "&unsafe=1");
  const plus = page.getByRole("button", { name: "Attach and Settings" });
  await plus.click();
  await expect(plus).toHaveAttribute("aria-expanded", "true");
  // The runner drops while the menu is open: + stays enabled with its menu still showing (#2175),
  // while the bar's other controls take the disabled ink.
  await page.evaluate(() => window.setSessionUsageRunnerOnline(false));
  await expect(plus).toBeEnabled();
  const ink = await disabledInk(page);
  const shield = page.getByRole("button", { name: /^Permission Mode:/ });
  await expect(shield).toBeDisabled();
  const chip = page.getByRole("button", { name: /^Model Settings:/ });
  await expect(chip).toBeDisabled();
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation instanceof CSSTransition)
    .map((animation) => animation.finished.catch(() => undefined))));
  const painted = {
    shieldIcon: await shield.locator(".cbar-approvals").evaluate((element) => getComputedStyle(element).color),
    model: await chip.locator(".cbar-model").evaluate((element) => getComputedStyle(element).color),
    context: await chip.locator(".cbar-context").evaluate((element) => getComputedStyle(element).color),
  };
  expect(painted).toEqual({ shieldIcon: ink, model: ink, context: ink });
  expect(await plus.evaluate((element) => getComputedStyle(element).color), "+ is not painted disabled").not.toBe(ink);
});

test.describe("390px phone with Plan on", () => {
  test.use({ hasTouch: true });

  test("the chip keeps the start of a long model name and every control stays on one row (#2174)", async ({ page }) => {
    await openFixture(page, 390, "codex", "&plan=1");
    await expandComposer(page);
    const chip = page.getByRole("button", { name: /^Model Settings:/ });
    // The accessible name keeps what the phone chip hides: the context size and the effort.
    await expect(chip).toHaveAttribute("aria-label", "Model Settings: GPT-6-Astra Extended Context Preview, 1M, High");
    const plan = page.getByRole("button", { name: "Plan", exact: true });
    await expect(plan).toHaveAttribute("aria-pressed", "true");
    const shown = await chip.evaluate((element) => {
      const visible = (selector: string) => {
        const node = element.querySelector(selector);
        return node !== null && node.getClientRects().length > 0;
      };
      const model = element.querySelector<HTMLElement>(".cbar-model")!;
      return {
        mark: visible(".agent-icon"),
        context: visible(".cbar-context"),
        effort: visible(".cbar-effort"),
        caret: visible(".cbar-caret"),
        modelWidth: model.getBoundingClientRect().width,
        truncated: model.scrollWidth > model.clientWidth,
      };
    });
    expect(shown).toMatchObject({ mark: false, context: false, effort: false, caret: false, truncated: true });
    // "GPT-6-…" at least: the start of the name, not an ellipsis alone.
    expect(shown.modelWidth).toBeGreaterThanOrEqual(40);
    const controls = await readBarControls(page);
    expect(new Set(controls.map((control) => Math.round(control.top + control.height / 2))).size, "one row").toBe(1);
    const composer = await page.locator(".composer-box").boundingBox();
    for (const control of controls) expect(control.right).toBeLessThanOrEqual(composer!.x + composer!.width);
    await page.screenshot({ path: `${EVIDENCE}/after-390-plan-long-model.png` });
  });

  test("Plan off, the phone chip shows the mark, the effort and the chevron but not the context size (#2174)", async ({ page }) => {
    await openFixture(page, 390, "codex");
    await expandComposer(page);
    const chip = page.getByRole("button", { name: /^Model Settings:/ });
    const shown = await chip.evaluate((element) => Object.fromEntries(
      [".agent-icon", ".cbar-context", ".cbar-effort", ".cbar-caret"].map((selector) => {
        const node = element.querySelector(selector);
        return [selector, node !== null && node.getClientRects().length > 0];
      }),
    ));
    expect(shown).toEqual({ ".agent-icon": true, ".cbar-context": false, ".cbar-effort": true, ".cbar-caret": true });
  });
});
