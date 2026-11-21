import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/** Reviewable captures of Google Antigravity setup in Connections (#4780) at 1440x900 and 390x844,
 * with layout measurements: target sizes and gaps, text and control contrast, and horizontal
 * overflow. Runs only with WOLLIPOG_EVIDENCE_DIR set; WOLLIPOG_EVIDENCE_PREFIX names the set
 * ("before", "after"). Behaviour is asserted in AntigravitySetup.dom.test.tsx. */
const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
const prefix = process.env.WOLLIPOG_EVIDENCE_PREFIX ?? "after";
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const;
/** The machine harness's `?antigravity=` fixtures (machine-management-main.tsx). */
const STATES = ["missing", "unsupported", "update-runner", "signin-required", "signin-pending", "signin-failed",
  "verification-failed", "ready"] as const;
const measurements: Record<string, unknown> = {};

test.skip(!evidenceDir, "set WOLLIPOG_EVIDENCE_DIR to capture evidence");
test.afterAll(() => {
  if (evidenceDir) writeFileSync(join(evidenceDir, `${prefix}-measurements.json`), `${JSON.stringify(measurements, null, 2)}\n`);
});

/** Layout boxes of every visible interactive target in `scope`, the smallest gap between adjacent
 * targets, the lowest text and control-boundary contrast, and whether the page scrolls sideways. */
async function measure(page: Page, scope: string): Promise<unknown> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector) ?? document.body;
    const parse = (value: string): [number, number, number, number] | null => {
      const match = value.match(/rgba?\(([^)]+)\)/u);
      if (!match) return null;
      const parts = match[1]!.split(/[ ,/]+/u).filter(Boolean).map(Number);
      return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
    };
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const background = (element: Element | null): number[] => {
      for (let node = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color[3] > 0.5) return color;
      }
      return parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
    };
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const targets = [...root.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, summary, [role=button]")]
      .filter((element) => visible(element) && !(element as HTMLButtonElement).disabled);
    // The pointer target: the layout box, grown by an absolutely positioned pseudo-element that the
    // shared hit-area block adds on coarse pointers (design-system §2.8). Insets are from the padding edge.
    const hitBox = (element: HTMLElement, rect: DOMRect) => {
      let [x0, y0, x1, y1] = [rect.x, rect.y, rect.right, rect.bottom];
      const style = getComputedStyle(element);
      const [bl, bt, br, bb] = [style.borderLeftWidth, style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth].map(Number.parseFloat);
      for (const pseudo of ["::before", "::after"]) {
        const own = getComputedStyle(element, pseudo);
        if (own.content === "none" || own.position !== "absolute") continue;
        const [top, right, bottom, left] = [own.top, own.right, own.bottom, own.left].map(Number.parseFloat);
        if ([top, right, bottom, left].some(Number.isNaN)) continue;
        x0 = Math.min(x0, rect.x + bl! + left!);
        y0 = Math.min(y0, rect.y + bt! + top!);
        x1 = Math.max(x1, rect.right - br! - right!);
        y1 = Math.max(y1, rect.bottom - bb! - bottom!);
      }
      return { hitWidth: x1 - x0, hitHeight: y1 - y0, hit: { x: x0, y: y0, right: x1, bottom: y1 } };
    };
    const boxes = targets.map((element) => {
      const rect = element.getBoundingClientRect();
      return { label: (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName).trim().slice(0, 40),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height, ...hitBox(element, rect) };
    });
    // Whether any two hit areas overlap (a nested copy button inside a row excepted).
    let hitOverlap = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        const nested = Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
          Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
        if (!nested && Math.min(a.hit.right, b.hit.right) > Math.max(a.hit.x, b.hit.x) &&
            Math.min(a.hit.bottom, b.hit.bottom) > Math.max(a.hit.y, b.hit.y)) hitOverlap = true;
      }
    }
    let minGap = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
        const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
        // Adjacent: overlapping on one axis, so the gap on the other is the space between them.
        const overlapX = Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
        if (overlapX && overlapY) continue; // nested (a copy button inside a row), not adjacent
        if (overlapY) minGap = Math.min(minGap, dx);
        else if (overlapX) minGap = Math.min(minGap, dy);
      }
    }
    let minText = Infinity;
    let minTextMargin = Infinity;
    let minTextSample = "";
    for (const element of root.querySelectorAll<HTMLElement>("*")) {
      if (!visible(element) || (element as HTMLButtonElement).disabled || element.closest("[disabled]")) continue;
      const text = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join("").trim();
      if (!text) continue;
      const color = parse(getComputedStyle(element).color);
      if (!color) continue;
      const value = ratio(color, background(element));
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      const weight = Number(getComputedStyle(element).fontWeight);
      const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
      // The worst text relative to its own threshold (large text needs 3:1, other text 4.5:1).
      if (value / required < minTextMargin) {
        minTextMargin = value / required;
        minText = value;
        minTextSample = `${text.slice(0, 40)} (needs ${required}:1)`;
      }
    }
    // Boundaries that identify a control (WCAG 1.4.11, design-system `--control-outline`): a field's
    // edge, and an icon-only button's glyph. A labelled button is identified by its label, whose
    // contrast is the text measure above.
    let minBoundary = Infinity;
    let minBoundarySample = "";
    for (const element of targets) {
      const style = getComputedStyle(element);
      const outside = background(element.parentElement);
      let value: number | null = null;
      if (/^(INPUT|SELECT|TEXTAREA)$/u.test(element.tagName)) {
        const border = parse(style.borderTopColor);
        value = border ? ratio(border, outside) : null;
      } else if (!(element.textContent ?? "").trim() && element.querySelector("svg")) {
        const glyph = parse(getComputedStyle(element.querySelector("svg")!).color);
        value = glyph ? ratio(glyph, background(element)) : null;
      }
      if (value !== null && value < minBoundary) {
        minBoundary = value;
        minBoundarySample = (element.getAttribute("aria-label") ?? element.tagName).slice(0, 40);
      }
    }
    return {
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      targetCount: boxes.length,
      minTargetWidth: Math.min(...boxes.map((box) => box.width)),
      minTargetHeight: Math.min(...boxes.map((box) => box.height)),
      minHitWidth: Math.min(...boxes.map((box) => box.hitWidth)),
      minHitHeight: Math.min(...boxes.map((box) => box.hitHeight)),
      hitOverlap,
      smallestTargets: [...boxes].sort((a, b) => Math.min(a.width, a.height) - Math.min(b.width, b.height)).slice(0, 3)
        .map(({ hit: _hit, ...box }) => box),
      minAdjacentGap: Number.isFinite(minGap) ? minGap : null,
      minTextContrast: Number.isFinite(minText) ? Math.round(minText * 100) / 100 : null,
      minTextContrastSample: minTextSample,
      minControlBoundaryContrast: Number.isFinite(minBoundary) ? Math.round(minBoundary * 100) / 100 : null,
      minControlBoundarySample: minBoundarySample,
    };
  }, scope);
}

async function capture(page: Page, name: string, scope: string, fullPage = false): Promise<void> {
  await page.waitForTimeout(400);
  measurements[name] = await measure(page, scope);
  await page.screenshot({ path: join(evidenceDir!, `${prefix}-${name}.png`), animations: "disabled", fullPage });
}

async function openMachine(page: Page, query: string, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto(`/machine-management-e2e.html?machine=native-t14s${query ? `&${query}` : ""}`);
  await expect(page.locator("article.machine-detail")).toBeVisible();
}

for (const viewport of VIEWPORTS) test.describe(`${viewport.width}x${viewport.height}`, () => {
  const size = `${viewport.width}x${viewport.height}`;
  // The phone width is a touch phone: coarse-pointer sizing (44px targets) applies there.
  if (viewport.width < 760) test.use({ hasTouch: true, isMobile: true });

  test(`Connections machine view, ${size}`, async ({ page }) => {
    await openMachine(page, "", viewport);
    if (prefix !== "before") measurements[`connections-machine-${size}-row`] = await measure(page, 'ul[aria-label="Agent Setup"]');
    await capture(page, `connections-machine-${size}`, "article.machine-detail", true);
  });

  if (prefix === "before") return;

  test(`Connections with many agents and a long machine name, ${size}`, async ({ page }) => {
    await openMachine(page, "antigravity=signin-required&manyAgents&longName", viewport);
    await page.locator('ul[aria-label="Agent Setup"]').scrollIntoViewIfNeeded();
    measurements[`connections-antigravity-stress-${size}-row`] = await measure(page, 'ul[aria-label="Agent Setup"]');
    await capture(page, `connections-antigravity-stress-${size}`, "article.machine-detail", true);
  });

  for (const state of STATES) {
    test(`Google Antigravity setup, ${state}, ${size}`, async ({ page }) => {
      await openMachine(page, `antigravity=${state}`, viewport);
      await page.locator('ul[aria-label="Agent Setup"] button.row').click();
      const dialog = page.getByRole("dialog", { name: "Google Antigravity" });
      await expect(dialog).toBeVisible();
      await capture(page, `connections-antigravity-${state}-${size}`, '[role="dialog"]');
    });
  }

  test(`Google Antigravity setup, long path and diagnostic, ${size}`, async ({ page }) => {
    await openMachine(page, "antigravity=verification-failed&longName", viewport);
    await page.locator('ul[aria-label="Agent Setup"] button.row').click();
    await expect(page.getByRole("dialog", { name: "Google Antigravity" })).toBeVisible();
    await capture(page, `connections-antigravity-long-diagnostic-${size}`, '[role="dialog"]');
  });
});
