import { expect, test, type Page } from "@playwright/test";
import { COLOR_SCHEMES } from "../src/theme.js";

/**
 * Rendered contrast, in a browser, for every palette.
 *
 * `light-theme.test.ts` measures the pairs the stylesheet DECLARES, which is most of them and is
 * cheap. What it cannot see is text whose ground is painted somewhere else — by an ancestor, or by
 * a more specific rule on the same element — because that is a fact about the cascade rather than
 * about any one rule. Four static approximations were tried and each attributed a ground to the
 * wrong token.
 *
 * Here the browser resolves it. Each element's effective background is found by walking up until
 * an opaque layer is reached, compositing the translucent ones on the way, which is what the screen
 * actually shows.
 *
 * COVERAGE IS THE PAGE. This checks the markup `colour-schemes-main.tsx` renders and nothing else;
 * a screen not on that page is not covered by it. That is a real limit and it is why the harness
 * uses production class names rather than a simplification of them.
 */

test.use({ reducedMotion: "reduce" });

const SCHEMES = ["wollipog", ...COLOR_SCHEMES.map((s) => s.value).filter((v) => v !== "wollipog")];
const THEMES = ["dark", "light"] as const;

/** WCAG AA for normal text. Large text is exempt at 3:1; the harness renders none. */
const AA = 4.5;

const expectRenderedLabelCoverage = (measured: { label: string }[]) => {
  const labels = new Set(measured.map((entry) => entry.label));
  expect(labels.size, "the harness must render distinct text labels to measure").toBeGreaterThan(15);
};

async function waitForContrastFixture(
  page: Page,
  expected: { scheme: string; theme: typeof THEMES[number] } = { scheme: "wollipog", theme: "dark" },
) {
  await page.waitForFunction(() => {
    const root = document.documentElement;
    return root.hasAttribute("data-contrast-fixture-ready")
      || root.hasAttribute("data-contrast-fixture-error");
  });
  const state = await page.locator("html").evaluate((root) => ({
    ready: root.getAttribute("data-contrast-fixture-ready"),
    error: root.getAttribute("data-contrast-fixture-error"),
  }));
  expect(state.error, `contrast fixture settlement failed: ${state.error ?? "no error"}`).toBeNull();
  expect(state.ready, "the fixture must publish its settled scheme and theme")
    .toBe(`${expected.scheme}/${expected.theme}`);
}

async function openContrastFixture(
  page: Page,
  url: string,
  expected?: { scheme: string; theme: typeof THEMES[number] },
) {
  await page.goto(url);
  await waitForContrastFixture(page, expected);
}

async function measure(page: Page) {
  return page.evaluate(() => {
    if (!document.documentElement.hasAttribute("data-contrast-fixture-ready")) {
      const root = document.documentElement;
      throw new Error(
        `Contrast fixture is not settled: ready=${root.dataset.contrastFixtureReady ?? "missing"}; `
        + `pending=${root.dataset.contrastFixturePending ?? "missing"}; `
        + `error=${root.dataset.contrastFixtureError ?? "none"}`,
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not create a color normalization context");
    const parse = (value: string) => {
      const parts = value.match(/-?(?:\d+(?:\.\d*)?|\.\d+)/g)?.map(Number) ?? [];
      if (/^rgba?\(/.test(value)) {
        return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
      }
      if (/^color\(\s*srgb\s/i.test(value)) {
        return {
          r: (parts[0] ?? 0) * 255,
          g: (parts[1] ?? 0) * 255,
          b: (parts[2] ?? 0) * 255,
          a: parts[3] ?? 1,
        };
      }
      // Let Chromium convert other CSS Color values into sRGB bytes. A one-millisecond
      // reduced-motion transition is serialised as oklab(); reading its lightness and a/b channels
      // as RGB bytes fabricated ~1:1 contrast. Common rgb()/sRGB values stay on the exact path
      // above, avoiding canvas quantization for translucent tints.
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgb(0 0 0 / 0)";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, alpha = 255] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: alpha / 255 };
    };
    const over = (top: ReturnType<typeof parse>, bottom: ReturnType<typeof parse>) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const lum = (c: ReturnType<typeof parse>) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a: ReturnType<typeof parse>, b: ReturnType<typeof parse>) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    /** Split CSS comma lists without splitting nested functions or quoted strings. */
    const splitTopLevel = (value: string) => {
      const parts: string[] = [];
      let start = 0;
      let depth = 0;
      let quote = "";
      let escaped = false;
      for (let index = 0; index < value.length; index++) {
        const character = value[index]!;
        if (escaped) { escaped = false; continue; }
        if (character === "\\") { escaped = true; continue; }
        if (quote) {
          if (character === quote) quote = "";
          continue;
        }
        if (character === "\"" || character === "'") { quote = character; continue; }
        if (character === "(") depth++;
        else if (character === ")") depth--;
        else if (character === "," && depth === 0) {
          parts.push(value.slice(start, index).trim());
          start = index + 1;
        }
        if (depth < 0) return null;
      }
      if (depth !== 0 || quote || escaped) return null;
      parts.push(value.slice(start).trim());
      return parts;
    };

    const functionCall = (value: string) => {
      const trimmed = value.trim();
      const opening = trimmed.indexOf("(");
      if (opening <= 0 || !/^[a-z-]+$/i.test(trimmed.slice(0, opening))) return null;
      let depth = 0;
      let quote = "";
      let escaped = false;
      for (let index = opening; index < trimmed.length; index++) {
        const character = trimmed[index]!;
        if (escaped) { escaped = false; continue; }
        if (character === "\\") { escaped = true; continue; }
        if (quote) {
          if (character === quote) quote = "";
          continue;
        }
        if (character === "\"" || character === "'") { quote = character; continue; }
        if (character === "(") depth++;
        if (character === ")") {
          depth--;
          if (depth === 0) {
            return {
              name: trimmed.slice(0, opening).toLowerCase(),
              body: trimmed.slice(opening + 1, index),
              full: trimmed.slice(0, index + 1),
              rest: trimmed.slice(index + 1).trim(),
            };
          }
          if (depth < 0) return null;
        }
      }
      return null;
    };

    /** How many points to sample between consecutive gradient stops, including both ends. */
    const GRADIENT_SAMPLES = 257;

    const resolveStopPositions = (positions: (number | undefined)[]) => {
      const resolved = [...positions];
      resolved[0] ??= 0;
      resolved[resolved.length - 1] ??= 1;

      let previous = resolved[0]!;
      for (let index = 1; index < resolved.length; index++) {
        const position = resolved[index];
        if (position === undefined) continue;
        resolved[index] = Math.max(previous, position);
        previous = resolved[index]!;
      }

      for (let index = 1; index + 1 < resolved.length;) {
        if (resolved[index] !== undefined) { index++; continue; }
        const before = index - 1;
        let after = index + 1;
        while (resolved[after] === undefined) after++;
        const span = after - before;
        for (let offset = 1; offset < span; offset++) {
          resolved[before + offset] = resolved[before]! + (
            (resolved[after]! - resolved[before]!) * offset / span
          );
        }
        index = after + 1;
      }
      return resolved as number[];
    };

    const sampleGradient = (
      stops: ReturnType<typeof parse>[],
      positions: number[],
      repeating: boolean,
    ) => {
      const samples: ReturnType<typeof parse>[] = [];
      const sampleInterval = (
        from: ReturnType<typeof parse>,
        to: ReturnType<typeof parse>,
        start: number,
        end: number,
        visibleStart = start,
        visibleEnd = end,
      ) => {
        if (end <= start || visibleEnd <= visibleStart) return;
        const firstT = (visibleStart - start) / (end - start);
        const lastT = (visibleEnd - start) / (end - start);
        for (let step = 0; step < GRADIENT_SAMPLES; step++) {
          const t = firstT + (lastT - firstT) * step / (GRADIENT_SAMPLES - 1);
          const a = from.a * (1 - t) + to.a * t;
          const channel = (key: "r" | "g" | "b") => {
            const premultiplied = from.a * from[key] * (1 - t) + to.a * to[key] * t;
            return a === 0 ? 0 : premultiplied / a;
          };
          samples.push({ r: channel("r"), g: channel("g"), b: channel("b"), a });
        }
      };

      if (!repeating) {
        if (positions[0]! > 0) samples.push(stops[0]!);
        for (let index = 0; index + 1 < stops.length; index++) {
          const start = positions[index]!;
          const end = positions[index + 1]!;
          sampleInterval(
            stops[index]!,
            stops[index + 1]!,
            start,
            end,
            Math.max(0, start),
            Math.min(1, end),
          );
        }
        if (positions.at(-1)! < 1) samples.push(stops.at(-1)!);
        return samples;
      }

      const period = positions.at(-1)! - positions[0]!;
      if (period <= 1) {
        // Every colour in one complete period is painted somewhere in a viewport one period or
        // wider, regardless of where the repetition boundary falls.
        for (let index = 0; index + 1 < stops.length; index++) {
          sampleInterval(stops[index]!, stops[index + 1]!, positions[index]!, positions[index + 1]!);
        }
        return samples;
      }

      // A period wider than the viewport may expose only part of an interval. Enumerate just the
      // shifted copies that intersect the normalized 0..1 paint line and sample their visible part.
      for (let index = 0; index + 1 < stops.length; index++) {
        const start = positions[index]!;
        const end = positions[index + 1]!;
        if (end <= start) continue;
        const firstRepeat = Math.floor(-end / period) + 1;
        const lastRepeat = Math.ceil((1 - start) / period) - 1;
        for (let repeat = firstRepeat; repeat <= lastRepeat; repeat++) {
          const shiftedStart = start + repeat * period;
          const shiftedEnd = end + repeat * period;
          sampleInterval(
            stops[index]!,
            stops[index + 1]!,
            shiftedStart,
            shiftedEnd,
            Math.max(0, shiftedStart),
            Math.min(1, shiftedEnd),
          );
        }
      }
      return samples;
    };

    const gradientSamples = (image: string):
      { samples: ReturnType<typeof parse>[]; error?: never }
      | { samples?: never; error: string } => {
      const layers = splitTopLevel(image);
      if (!layers) return { error: `unbalanced CSS syntax in ${image}` };
      if (layers.length !== 1) {
        return { error: `multiple background-image layers are not modelled: ${image}` };
      }
      const gradient = functionCall(layers[0]!);
      const supported = new Set([
        "linear-gradient", "radial-gradient", "conic-gradient",
        "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient",
      ]);
      if (!gradient || gradient.rest || !supported.has(gradient.name)) {
        return { error: `expected one supported CSS gradient, received ${image}` };
      }
      const components = splitTopLevel(gradient.body);
      if (!components) return { error: `unbalanced ${gradient.name} arguments in ${image}` };
      const stops: ReturnType<typeof parse>[] = [];
      const stopSyntax: string[] = [];
      const stopPositions: (number | undefined)[] = [];
      const isConic = gradient.name.endsWith("conic-gradient");
      const parseStopPosition = (position: string) => {
        const matched = position.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))(.*)$/);
        if (!matched) return null;
        const value = Number(matched[1]);
        const unit = matched[2]!.toLowerCase();
        if (unit === "%") return value / 100;
        if (!unit && value === 0) return 0;
        if (!isConic) return unit && value === 0 ? 0 : null;
        if (unit === "deg") return value / 360;
        if (unit === "grad") return value / 400;
        if (unit === "rad") return value / (2 * Math.PI);
        if (unit === "turn") return value;
        return null;
      };
      let interpolation: string | undefined;
      let geometry = "";
      for (const [index, component] of components.entries()) {
        const candidate = functionCall(component);
        if (candidate && CSS.supports("color", candidate.full)) {
          const positionSyntax = candidate.rest ? candidate.rest.split(/\s+/) : [];
          if (positionSyntax.length > 2) {
            return { error: `too many positions on a gradient stop: ${component}` };
          }
          const positions = positionSyntax.map(parseStopPosition);
          const unsupportedPosition = positions.findIndex((position) => position === null);
          if (unsupportedPosition !== -1) {
            return {
              error: `gradient stop position ${positionSyntax[unsupportedPosition]} is not modelled for ${gradient.name}: ${image}`,
            };
          }
          const expandedPositions = positions.length ? positions : [undefined];
          for (const position of expandedPositions) {
            stops.push(parse(candidate.full));
            stopSyntax.push(candidate.full);
            stopPositions.push(position ?? undefined);
          }
          continue;
        }
        // The first component may be a direction, shape, position, or colour-interpolation method.
        if (index === 0) {
          interpolation = component.match(/\bin\s+([\w-]+)/i)?.[1]?.toLowerCase();
          if (interpolation && interpolation !== "srgb") {
            return { error: `gradient interpolation method ${interpolation} is not modelled: ${image}` };
          }
          geometry = component.replace(/\bin\s+srgb\b/i, "").trim().replace(/\s+/g, " ");
          continue;
        }
        return { error: `gradient component ${index + 1} is not a supported colour stop: ${component}` };
      }
      if (stops.length < 2) return { error: `fewer than two supported colour stops in ${image}` };
      if (gradient.name.endsWith("radial-gradient") && geometry) {
        const normalizedRadialGeometries = new Set([
          "circle", "ellipse", "farthest-corner",
          "circle farthest-corner", "ellipse farthest-corner",
          "farthest-corner circle", "farthest-corner ellipse",
        ]);
        if (!normalizedRadialGeometries.has(geometry.toLowerCase())) {
          return { error: `radial gradient geometry ${geometry} is not modelled: ${image}` };
        }
      }
      if (gradient.name.endsWith("conic-gradient") && /\bat\b/i.test(geometry)) {
        return { error: `off-center conic gradient geometry is not modelled: ${image}` };
      }
      if (stopSyntax.some((stop) => /\bnone\b/i.test(stop))) {
        return { error: `gradient stops with missing colour components are not modelled: ${image}` };
      }

      const first = stops[0]!;
      const isConstant = stops.every((stop) =>
        stop.r === first.r && stop.g === first.g && stop.b === first.b && stop.a === first.a);
      const legacyStops = stopSyntax.every((stop) => /^rgba?\(/i.test(stop));
      const explicitSrgbStops = stopSyntax.every((stop) => {
        if (/^rgba?\(/i.test(stop)) return !/\bnone\b/i.test(stop);
        if (!/^color\(\s*srgb\s/i.test(stop) || /\bnone\b/i.test(stop)) return false;
        const components = stop.match(/-?(?:\d+(?:\.\d*)?|\.\d+)/g)?.map(Number) ?? [];
        return components.slice(0, 3).length === 3
          && components.slice(0, 3).every((component) => component >= 0 && component <= 1);
      });
      // Chromium changes the default interpolation space to Oklab when a gradient contains a
      // non-legacy colour. Once interpolation matters, sampling those converted sRGB endpoints
      // would measure colours the browser never paints.
      if (!isConstant && !interpolation && !legacyStops) {
        return { error: `implicit Oklab interpolation for non-legacy stops is not modelled: ${image}` };
      }
      // Explicit sRGB is exact for computed rgb()/rgba() and in-range color(srgb) stops. Other
      // spaces require an unclamped conversion before interpolation; the 8-bit canvas normalizer
      // cannot provide that without changing out-of-gamut interiors.
      if (!isConstant && interpolation === "srgb" && !explicitSrgbStops) {
        return { error: `gradient stops cannot be modelled accurately with sRGB interpolation: ${image}` };
      }
      const resolvedPositions = resolveStopPositions(stopPositions);
      const repeating = gradient.name.startsWith("repeating-");
      if (repeating && resolvedPositions.at(-1)! <= resolvedPositions[0]!) {
        return { error: `repeating gradient has a non-positive repetition length: ${image}` };
      }
      return { samples: sampleGradient(stops, resolvedPositions, repeating) };
    };

    /**
     * The grounds behind an element — plural, because a gradient is several.
     *
     * A `background-image` is a paint layer above `background-color`, and the first version of this
     * walk ignored it: the primary button's label was measured against the page behind its
     * gradient, at 1.14:1, which is not what anyone sees. Chromium may preserve the colour space of
     * computed gradient stops, so each stop is extracted structurally and normalized through the
     * same browser-backed path as a solid colour. Each adjacent pair is sampled densely because
     * relative luminance can have an interior minimum even when both endpoints pass. A gradient is
     * only as readable as its worst sampled point.
     */
    const groundsOf = (element: Element):
      { grounds: ReturnType<typeof parse>[]; error?: never }
      | { grounds?: never; error: string } => {
      const layersAboveGradient: ReturnType<typeof parse>[] = [];
      let node: Element | null = element;
      while (node) {
        const style = getComputedStyle(node);
        const image = style.backgroundImage;
        if (image && image !== "none") {
          const found = gradientSamples(image);
          if (found.error) return { error: found.error };
          // Build the opaque base behind this gradient. Its own background colour is below the
          // image, then ancestor colours continue underneath until one closes the stack.
          const layersBelowGradient: ReturnType<typeof parse>[] = [];
          let beneath: Element | null = node;
          while (beneath) {
            const beneathStyle = getComputedStyle(beneath);
            if (beneath !== node && beneathStyle.backgroundImage !== "none") {
              return { error: `nested background image is not modelled: ${beneathStyle.backgroundImage}` };
            }
            const fill = parse(beneathStyle.backgroundColor);
            if (fill.a > 0) layersBelowGradient.push(fill);
            if (fill.a >= 1) break;
            beneath = beneath.parentElement;
          }
          const base = layersBelowGradient.reduceRight(
            (below, above) => over(above, below),
            { r: 255, g: 255, b: 255, a: 1 },
          );
          // Descendant fills collected before the gradient are painted above it, not below it.
          return {
            grounds: found.samples.map((sample) => layersAboveGradient.reduceRight(
              (below, above) => over(above, below),
              over(sample, base),
            )),
          };
        }
        const fill = parse(style.backgroundColor);
        if (fill.a > 0) layersAboveGradient.push(fill);
        if (fill.a >= 1) break;
        node = node.parentElement;
      }
      return {
        grounds: [layersAboveGradient.reduceRight(
          (below, above) => over(above, below),
          { r: 255, g: 255, b: 255, a: 1 },
        )],
      };
    };

    const selectorOf = (element: Element) => {
      const classes = (element.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean);
      return `${element.tagName.toLowerCase()}${classes.map((name) => `.${name}`).join("")}`;
    };
    const formatColor = (color: ReturnType<typeof parse>) =>
      `rgb(${color.r.toFixed(2)} ${color.g.toFixed(2)} ${color.b.toFixed(2)} / ${color.a.toFixed(3)})`;
    const ancestryOf = (element: Element) => {
      const ancestry: string[] = [];
      let node: Element | null = element;
      while (node) {
        const style = getComputedStyle(node);
        ancestry.push(
          `${selectorOf(node)}{background-color:${style.backgroundColor};background-image:${style.backgroundImage};opacity:${style.opacity}}`,
        );
        if (parse(style.backgroundColor).a >= 1) break;
        node = node.parentElement;
      }
      return ancestry;
    };

    const results: {
      label: string;
      ratio: number;
      foreground: string;
      background: string;
      ancestry: string[];
    }[] = [];
    /** Paths this measurement cannot model. Reported rather than silently skipped. */
    const unsupported: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      // Elements with their OWN text, so a container is not credited with its children's words.
      const own = [...element.childNodes]
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent?.trim() ?? "")
        .join("");
      if (!own) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      // CSS `opacity` is NOT inherited, and it applies to the whole composited group — the text,
      // its background, and its descendants together — so reading only this element's opacity both
      // misses a translucent ancestor and models the wrong thing when it finds one. Rather than
      // half-model it, the harness refuses: a measured path with any non-unit opacity is reported,
      // and the test fails on it. That keeps the guarantee this spec states true instead of
      // approximately true.
      let translucent: Element | null = element;
      let faded = false;
      while (translucent) {
        if (Number(getComputedStyle(translucent).opacity) < 1) { faded = true; break; }
        translucent = translucent.parentElement;
      }
      if (faded) {
        unsupported.push(`${element.tagName.toLowerCase()}.${(element.className || "").toString()}`);
        continue;
      }
      const ink = parse(style.color);
      if (ink.a === 0) continue;
      const resolvedGrounds = groundsOf(element);
      // The ink's own alpha and any inherited opacity are composited before measuring, so a faded
      // label is measured as it appears rather than as it is declared.
      const path = selectorOf(element);
      if (resolvedGrounds.error) {
        unsupported.push(`${path}: ${resolvedGrounds.error}`);
        continue;
      }
      const ancestry = ancestryOf(element);
      for (const ground of resolvedGrounds.grounds) {
        const painted = over({ ...ink, a: ink.a * Number(style.opacity || 1) }, ground);
        results.push({
          label: `${path} "${own.slice(0, 24)}"`,
          ratio: ratio(painted, ground),
          foreground: style.color,
          background: formatColor(ground),
          ancestry,
        });
      }
    }
    return { results, unsupported };
  });
}

test("gradient sample density cannot satisfy the distinct-label vacuity guard", async ({ page }) => {
  await page.setContent(`
    <html data-contrast-fixture-ready="synthetic">
      <body style="background: white">
        <p class="only-label" style="color: black; background: linear-gradient(black, white)">
          Only Label
        </p>
      </body>
    </html>
  `);

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  expect(measured).toHaveLength(257);
  expect(() => expectRenderedLabelCoverage(measured)).toThrow(
    /the harness must render distinct text labels to measure/,
  );
});

test("rendered contrast waits for final fixture styles", async ({ page }) => {
  await page.goto("/colour-schemes-e2e.html?scheme=wollipog&theme=dark&settle=manual");
  await expect(page.locator(".slash-item.active")).toBeVisible();
  await expect(page.locator(".slash-detail-disabled")).toHaveCSS("color", "rgb(18, 26, 36)");

  await expect(measure(page)).rejects.toThrow("Contrast fixture is not settled");
  await page.evaluate(() => window.dispatchEvent(new Event("contrast-fixture-release")));
  await waitForContrastFixture(page);

  const { results: measured } = await measure(page);
  const failures = measured
    .filter((entry) => entry.ratio < AA)
    .map((entry) => `${entry.label} is ${entry.ratio.toFixed(2)}:1`);
  expect(failures, "measurement must not sample the fixture's pending cascade").toEqual([]);
});

test("CSS color-space serialization is normalized before contrast measurement", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    (element as HTMLElement).style.transition = "none";
    (element as HTMLElement).style.color = "oklab(1 0 0)";
  });

  const { results: measured } = await measure(page);
  const entry = measured.find((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entry?.foreground).toBe("oklab(1 0 0)");
  expect(entry?.ratio).toBeGreaterThan(10);
});

test("non-RGB gradient stops cannot false-pass against their fallback", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  const computedImage = await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.color = "rgb(255 255 255)";
    html.style.backgroundColor = "rgb(0 0 0)";
    html.style.backgroundImage = "linear-gradient(oklab(1 0 0), color(srgb 1 1 1))";
    return getComputedStyle(html).backgroundImage;
  });

  expect(computedImage).toContain("oklab(1 0 0)");
  expect(computedImage).toContain("color(srgb 1 1 1)");
  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(257);
  expect(entries.every((entry) => entry.ratio < AA)).toBe(true);
  expect(entries.every((entry) => entry.background.startsWith("rgb(255.00 255.00 255.00"))).toBe(true);
});

test("implicit non-legacy gradient interpolation fails closed", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = [
      "linear-gradient(color(srgb 0 0 0), color(srgb 1 1 1))",
    ].join("");
  });

  const { unsupported } = await measure(page);
  expect(unsupported).toContainEqual(expect.stringMatching(
    /^p\.slash-detail-disabled: implicit Oklab interpolation for non-legacy stops is not modelled:/,
  ));
});

test("equal-position hard stops do not invent intermediate grounds", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.color = "rgb(31 31 31)";
    html.style.backgroundImage = "linear-gradient(rgb(255 0 255) 50%, rgb(0 255 0) 50%)";
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries.map((entry) => entry.background)).toEqual([
    "rgb(255.00 0.00 255.00 / 1.000)",
    "rgb(0.00 255.00 0.00 / 1.000)",
  ]);
  expect(entries.every((entry) => entry.ratio >= AA)).toBe(true);
});

test("decreasing gradient positions use CSS stop fix-up", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = [
      "linear-gradient(rgb(255 0 0) 0%, rgb(0 0 255) 50%, ",
      "rgb(0 128 0) -100%, rgb(255 255 0) 100%)",
    ].join("");
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(514);
  expect(entries.some((entry) =>
    entry.background === "rgb(0.00 128.00 0.00 / 1.000)",
  )).toBe(true);
});

test("multi-position and repeating hard stops keep only painted colours", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  const gradients = [
    "linear-gradient(rgb(255 0 0) 0% 50%, rgb(0 0 255) 50% 100%)",
    "repeating-linear-gradient(rgb(255 0 0) 0% 25%, rgb(0 0 255) 25% 50%)",
  ];

  for (const gradient of gradients) {
    await disabledDetail.evaluate((element, backgroundImage) => {
      const html = element as HTMLElement;
      html.style.transition = "none";
      html.style.backgroundImage = backgroundImage;
    }, gradient);
    const { results: measured, unsupported } = await measure(page);
    expect(unsupported).toEqual([]);
    const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
    expect(entries).toHaveLength(514);
    expect(new Set(entries.map((entry) => entry.background))).toEqual(new Set([
      "rgb(255.00 0.00 0.00 / 1.000)",
      "rgb(0.00 0.00 255.00 / 1.000)",
    ]));
  }
});

test("repeating periods wider than the paint line sample each visible copy", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = [
      "repeating-linear-gradient(rgb(255 0 0) 50%, rgb(0 0 255) 200%)",
    ].join("");
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(514);
  expect(entries[0]?.background).toBe("rgb(85.00 0.00 170.00 / 1.000)");
  expect(entries[256]?.background).toBe("rgb(0.00 0.00 255.00 / 1.000)");
  expect(entries[257]?.background).toBe("rgb(255.00 0.00 0.00 / 1.000)");
  expect(entries[513]?.background).toBe("rgb(170.00 0.00 85.00 / 1.000)");
});

test("off-canvas gradient intervals contribute only their painted edge colour", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = "linear-gradient(rgb(255 0 0) -100%, rgb(0 0 255) -50%)";
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(1);
  expect(entries[0]?.background).toBe("rgb(0.00 0.00 255.00 / 1.000)");
});

test("position units requiring element geometry fail closed", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = "linear-gradient(rgb(255 0 0) 10px, rgb(0 0 255) 20px)";
  });

  const { unsupported } = await measure(page);
  expect(unsupported).toContainEqual(expect.stringMatching(
    /^p\.slash-detail-disabled: gradient stop position 10px is not modelled for linear-gradient:/,
  ));
});

test("radial sizes with geometry-dependent visible extents fail closed", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  const geometries = [
    "circle closest-side",
    "circle closest-corner",
    "circle farthest-side",
    "circle 40px",
    "circle farthest-corner at 25% 25%",
  ];

  for (const geometry of geometries) {
    await disabledDetail.evaluate((element, radialGeometry) => {
      const html = element as HTMLElement;
      html.style.transition = "none";
      html.style.backgroundImage = [
        `radial-gradient(${radialGeometry}, rgb(255 255 255) 100%, rgb(0 0 0) 150%)`,
      ].join("");
    }, geometry);
    const { unsupported } = await measure(page);
    expect(unsupported[0]).toMatch(
      /^p\.slash-detail-disabled: radial gradient geometry .+ is not modelled:/,
    );
  }
});

test("centered farthest-corner radial gradients retain a normalized extent", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = [
      "radial-gradient(circle farthest-corner, rgb(255 255 255) 100%, rgb(0 0 0) 150%)",
    ].join("");
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(1);
  expect(entries[0]?.background).toBe("rgb(255.00 255.00 255.00 / 1.000)");
});

test("conic angle positions normalize to one painted turn", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = [
      "conic-gradient(rgb(255 0 0) 0deg 180deg, rgb(0 0 255) 180deg 360deg)",
    ].join("");
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(514);
  expect(new Set(entries.map((entry) => entry.background))).toEqual(new Set([
    "rgb(255.00 0.00 0.00 / 1.000)",
    "rgb(0.00 0.00 255.00 / 1.000)",
  ]));
});

test("off-center conic geometry fails closed", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = [
      "conic-gradient(at 0% 0%, rgb(255 0 0) 0deg, rgb(0 0 255) 90deg)",
    ].join("");
  });

  const { unsupported } = await measure(page);
  expect(unsupported).toContainEqual(expect.stringMatching(
    /^p\.slash-detail-disabled: off-center conic gradient geometry is not modelled:/,
  ));
});

test("gradient interiors cannot false-pass when both endpoints clear AA", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.color = "rgb(31 31 31)";
    html.style.backgroundColor = "rgb(255 255 255)";
    html.style.backgroundImage = "linear-gradient(rgb(255 0 255), rgb(0 255 0))";
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(257);
  expect(entries[0]?.ratio).toBeGreaterThan(AA);
  expect(entries.at(-1)?.ratio).toBeGreaterThan(AA);
  const midpoint = entries.find((entry) => entry.background.startsWith("rgb(127.50 127.50 127.50"));
  expect(midpoint?.ratio).toBeLessThan(AA);
});

test("explicit sRGB gradients use sRGB interpolation", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundColor = "rgb(0 0 0)";
    html.style.backgroundImage = [
      "linear-gradient(in srgb, color(srgb 1 0 0), color(srgb 0 1 0), color(srgb 0 0 1))",
    ].join("");
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(514);
  expect(entries[128]?.background).toBe("rgb(127.50 127.50 0.00 / 1.000)");
  expect(entries[385]?.background).toBe("rgb(0.00 127.50 127.50 / 1.000)");
});

test("gradient alpha interpolation is premultiplied before compositing", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundColor = "rgb(0 0 0)";
    html.style.backgroundImage = "linear-gradient(rgb(255 0 0 / 0%), rgb(0 0 255))";
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(257);
  expect(entries[128]?.background).toBe("rgb(0.00 0.00 127.50 / 1.000)");
});

test("RGB gradient stops retain alpha while compositing over their fallback", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.color = "rgb(255 255 255)";
    html.style.backgroundColor = "rgb(0 0 0)";
    html.style.backgroundImage = "linear-gradient(rgb(255 255 255 / 50%), rgba(255, 255, 255, 0.5))";
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(257);
  expect(entries.every((entry) => entry.background.startsWith("rgb(127.50 127.50 127.50"))).toBe(true);
});

test("translucent gradient fallbacks retain the ancestor background", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=light", {
    scheme: "wollipog",
    theme: "light",
  });
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.color = "rgb(255 255 255)";
    html.style.backgroundColor = "rgb(0 0 0 / 20%)";
    html.style.backgroundImage = "linear-gradient(rgb(255 255 255 / 10%), rgb(255 255 255 / 10%))";
    const parent = html.parentElement as HTMLElement;
    parent.style.transition = "none";
    parent.style.backgroundColor = "rgb(200 200 200)";
    parent.style.backgroundImage = "none";
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(257);
  for (const entry of entries) {
    const channel = Number(entry.background.match(/^rgb\(([\d.]+)/)?.[1]);
    expect(channel).toBeCloseTo(169.5, 0);
  }
  expect(entries.every((entry) => entry.ratio < AA)).toBe(true);
});

test("descendant fills are painted above an ancestor gradient", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    const parent = html.parentElement as HTMLElement;
    html.style.transition = "none";
    html.style.color = "rgb(255 255 255)";
    html.style.backgroundColor = "rgb(0 0 0 / 50%)";
    html.style.backgroundImage = "none";
    parent.style.transition = "none";
    parent.style.backgroundColor = "rgb(0 0 0)";
    parent.style.backgroundImage = "linear-gradient(rgb(255 255 255), rgb(255 255 255))";
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(257);
  expect(entries.every((entry) => entry.background.startsWith("rgb(127.50 127.50 127.50"))).toBe(true);
});

test("transparent gradient stops measure the background showing through", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.color = "rgb(0 0 0)";
    html.style.backgroundColor = "rgb(0 0 0)";
    html.style.backgroundImage = "linear-gradient(rgb(255 255 255), transparent)";
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(257);
  expect(entries.some((entry) => entry.ratio > 20)).toBe(true);
  expect(entries.some((entry) => entry.ratio === 1)).toBe(true);
});

test("linear-sRGB gradient stops use browser colour conversion", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = [
      "linear-gradient(color(srgb-linear 0.2 0.2 0.2), color(srgb-linear 0.2 0.2 0.2))",
    ].join("");
  });

  const { results: measured, unsupported } = await measure(page);
  expect(unsupported).toEqual([]);
  const entries = measured.filter((result) => result.label.startsWith("p.slash-detail-disabled"));
  expect(entries).toHaveLength(257);
  expect(entries.every((entry) => entry.background.startsWith("rgb(124.00 124.00 124.00"))).toBe(true);
});

test("unmodelled gradient interpolation methods fail with an actionable diagnostic", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = "linear-gradient(in oklab, rgb(0 0 0), rgb(255 255 255))";
  });

  const { unsupported } = await measure(page);
  expect(unsupported).toContainEqual(expect.stringMatching(
    /^p\.slash-detail-disabled: gradient interpolation method oklab is not modelled:/,
  ));
});

test("sRGB interpolation rejects gradient stops that require unclamped conversion", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = [
      "linear-gradient(in srgb, color(display-p3 1 0 0), color(display-p3 0 1 0))",
    ].join("");
  });

  const { unsupported } = await measure(page);
  expect(unsupported).toContainEqual(expect.stringMatching(
    /^p\.slash-detail-disabled: gradient stops cannot be modelled accurately with sRGB interpolation:/,
  ));
});

test("explicit sRGB interpolation rejects out-of-range sRGB stops", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = [
      "linear-gradient(in srgb, color(srgb 1.2 0 0), color(srgb 0 0 1))",
    ].join("");
  });

  const { unsupported } = await measure(page);
  expect(unsupported).toContainEqual(expect.stringMatching(
    /^p\.slash-detail-disabled: gradient stops cannot be modelled accurately with sRGB interpolation:/,
  ));
});

test("gradient stops with missing components fail closed", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundImage = [
      "linear-gradient(in srgb, color(srgb none 0 0), color(srgb 1 1 1))",
    ].join("");
  });

  const { unsupported } = await measure(page);
  expect(unsupported).toContainEqual(expect.stringMatching(
    /^p\.slash-detail-disabled: gradient stops with missing colour components are not modelled:/,
  ));
});

test("unsupported rendered gradient syntax fails with an actionable diagnostic", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    (element as HTMLElement).style.backgroundImage = [
      "linear-gradient(rgb(0 0 0), rgb(255 255 255))",
      "linear-gradient(rgb(255 0 0), rgb(0 0 255))",
    ].join(", ");
  });

  const { unsupported } = await measure(page);
  expect(unsupported).toContainEqual(expect.stringMatching(
    /^p\.slash-detail-disabled: multiple background-image layers are not modelled:/,
  ));
});

test("nested rendered gradients fail instead of ignoring the lower image", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    const html = element as HTMLElement;
    const parent = html.parentElement as HTMLElement;
    html.style.transition = "none";
    html.style.backgroundColor = "transparent";
    html.style.backgroundImage = "linear-gradient(rgb(255 255 255 / 50%), rgb(255 255 255 / 50%))";
    parent.style.transition = "none";
    parent.style.backgroundImage = "linear-gradient(rgb(0 0 0), rgb(255 255 255))";
  });

  const { unsupported } = await measure(page);
  expect(unsupported).toContainEqual(expect.stringMatching(
    /^p\.slash-detail-disabled: nested background image is not modelled:/,
  ));
});

test("settled contrast measurement still reports genuine failures", async ({ page }) => {
  await openContrastFixture(page, "/colour-schemes-e2e.html?scheme=wollipog&theme=dark");
  const disabledDetail = page.locator(".slash-detail-disabled");
  await disabledDetail.evaluate((element) => {
    (element as HTMLElement).style.color = "var(--bg-elev-1)";
  });
  await expect(disabledDetail).toHaveCSS("color", "rgb(18, 26, 36)");

  const { results: measured } = await measure(page);
  const failure = measured.find((entry) => entry.label.startsWith("p.slash-detail-disabled"));
  expect(failure?.ratio).toBeLessThan(AA);
  expect(failure?.foreground).toMatch(/^(rgb|color)\(/);
  expect(failure?.background).toMatch(/^rgb\(/);
  expect(failure?.ancestry.some((entry) => entry.startsWith("p.slash-detail-disabled{"))).toBe(true);
});

for (const scheme of SCHEMES) {
  for (const theme of THEMES) {
    test(`every rendered label clears AA in ${scheme} ${theme}`, async ({ page }) => {
      await openContrastFixture(
        page,
        `/colour-schemes-e2e.html?scheme=${scheme}&theme=${theme}`,
        { scheme, theme },
      );

      const { results: measured, unsupported } = await measure(page);
      expect(
        unsupported,
        "every rendered path must use modelled opacity and background syntax; see each diagnostic",
      ).toEqual([]);
      // Gradient-backed labels contribute hundreds of grounds, so raw result cardinality cannot
      // prove that the fixture still renders a representative set of distinct labels.
      expectRenderedLabelCoverage(measured);

      const failures = measured
        .filter((entry) => entry.ratio < AA)
        .map((entry) => [
          `${entry.label} is ${entry.ratio.toFixed(2)}:1`,
          `foreground=${entry.foreground}; composited-background=${entry.background}`,
          `ancestry=${entry.ancestry.join(" <- ")}`,
        ].join("; "));
      expect(failures, `${scheme}/${theme} renders text below ${AA}:1`).toEqual([]);
    });
  }
}

for (const scheme of SCHEMES) {
  for (const theme of THEMES) {
    test(`runner card headings inherit their identity style in ${scheme} ${theme}`, async ({ page }) => {
      expect(SCHEMES).toHaveLength(5);
      await page.goto(`/colour-schemes-e2e.html?scheme=${scheme}&theme=${theme}`);
      const headings = [
        page.locator(".runner-card.box-card .runner-id h2"),
        page.locator(".runner-card:not(.box-card) .runner-id h2"),
      ];

      // A missing runner family must fail loudly instead of turning the style assertions vacuous.
      await expect(headings[0]!).toHaveCount(1);
      await expect(headings[1]!).toHaveCount(1);

      for (const heading of headings) {
        const computed = await heading.evaluate((element) => {
          const style = getComputedStyle(element);
          const identityStyle = getComputedStyle(element.parentElement!);
          return {
            margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
            fontSize: style.fontSize,
            inheritedFontSize: identityStyle.fontSize,
          };
        });
        expect(computed.margin).toEqual(["0px", "0px", "0px", "0px"]);
        expect(computed.fontSize).toBe(computed.inheritedFontSize);
      }
    });
  }
}

/**
 * The terminal is a different ground from the app.
 *
 * `terminalTheme()` combines a palette's semantic colours with `--terminal-bg`, and the app's
 * tokens are derived against the app's SURFACES — so nothing had ever measured that combination.
 * Ordinary ANSI output rendered below AA in every light palette: GitHub's red, green and blue at
 * about 3.4:1, Dracula's around 3.5:1, Monokai's around 3.6:1. The unit test called
 * `terminalTheme()` with no styled document, so it only ever exercised the Wollipog fallbacks.
 *
 * This runs it against a real one, in every palette, and measures every channel that carries text.
 */
for (const scheme of SCHEMES) {
  for (const theme of THEMES) {
    test(`every terminal channel clears AA in ${scheme} ${theme}`, async ({ page }) => {
      await page.goto(`/colour-schemes-e2e.html?scheme=${scheme}&theme=${theme}`);
      const measured = await page.evaluate(async () => {
        const mod = await import("/src/theme.ts");
        const resolved = document.documentElement.dataset.theme === "light" ? "light" : "dark";
        const palette = mod.terminalTheme(resolved as "light" | "dark", document) as Record<string, string>;
        const parse = (hex: string) => {
          const h = hex.replace("#", "");
          return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        };
        const chan = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
        const lum = (hex: string) => {
          const [r, g, b] = parse(hex);
          return 0.2126 * chan(r!) + 0.7152 * chan(g!) + 0.0722 * chan(b!);
        };
        const ratio = (a: string, b: string) => {
          const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
          return (hi! + 0.05) / (lo! + 0.05);
        };
        const ground = palette.background!;
        // Every channel that draws TEXT. `cursorAccent` is the cursor's own inverse fill and
        // `background` is the ground itself, so neither is a foreground pair.
        const channels = ["foreground", "black", "red", "green", "yellow", "blue", "magenta", "cyan",
          "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
          "brightMagenta", "brightCyan", "brightWhite", "cursor"];
        return channels
          .filter((name) => /^#[0-9a-f]{6}$/i.test(palette[name] ?? ""))
          .map((name) => ({ name, ratio: ratio(palette[name]!, ground) }));
      });

      expect(measured.length, "the palette must expose text channels to measure").toBeGreaterThan(12);
      const failures = measured
        .filter((entry) => entry.ratio < AA)
        .map((entry) => `${entry.name} is ${entry.ratio.toFixed(2)}:1`);
      expect(failures, `${scheme}/${theme} renders ANSI text below ${AA}:1`).toEqual([]);
    });
  }
}

/**
 * Density, measured rather than declared.
 *
 * A density setting that changes tokens nothing reads is a setting that does nothing, and a source
 * check cannot tell those apart — it sees the tokens either way. This renders both settings and
 * compares the boxes the browser actually lays out.
 */
test("comfortable density gives every row more room than compact", async ({ page }) => {
  const heights = async (density: "compact" | "comfortable") => {
    await page.goto(`/colour-schemes-e2e.html?density=${density}`);
    await expect(page.locator(".ui-row").first()).toBeVisible();
    return page.evaluate(() => {
      // Every family, and BOTH dimensions. The first version measured one settings row, one inbox
      // row and one gap, so a setting that reached two screens out of six passed as
      // "application-wide" — and horizontal padding could shrink while height grew.
      const box = (selector: string) => {
        const element = document.querySelector(selector)!;
        const style = getComputedStyle(element);
        return {
          height: element.getBoundingClientRect().height,
          padX: Number.parseFloat(style.paddingLeft),
          // Vertical padding MEASURED, not inferred from height: the inbox row's height is
          // dominated by its minimum, so reverting its padding-y left the box identical and two
          // mutations went unnoticed. A test that only watches the outcome misses a token that
          // stopped being read whenever something else decides the outcome.
          padY: Number.parseFloat(style.paddingTop),
        };
      };
      return {
        row: box(".ui-row"),
        inbox: box(".inbox-row"),
        project: box(".project-manager-item"),
        card: box(".column .card"),
        agent: box(".agent-row"),
        finding: box(".review-finding-row"),
        ext: box(".ext-session"),
        artifact: box(".browser-artifact-row"),
        run: box(".run-card"),
        boxRunner: box(".runner-card.box-card"),
        nativeRunner: box(".runner-card:not(.box-card)"),
        workspace: box(".workspace-list li"),
        file: box(".files-entry"),
        usage: box(".usage-table td"),
        gap: Number.parseFloat(getComputedStyle(document.querySelector(".settings-options")!).rowGap),
      };
    });
  };
  const compact = await heights("compact");
  const comfortable = await heights("comfortable");

  // Each of the three, not the total: a scale that grew one dimension and shrank another could
  // still add up, and "more room" has to mean more room everywhere it is claimed.
  for (const family of ["row", "inbox", "project", "card", "agent", "finding", "ext", "artifact", "run", "boxRunner", "nativeRunner", "workspace", "file", "usage"] as const) {
    // A MEANINGFUL step, not "greater than": a subpixel increase satisfied the first version, and
    // a density setting nobody can see is a setting that does not work.
    expect(comfortable[family].height, `a ${family} row must be meaningfully taller`)
      .toBeGreaterThan(compact[family].height + 2);
    expect(comfortable[family].padX, `a ${family} row must gain horizontal room`)
      .toBeGreaterThan(compact[family].padX);
    expect(comfortable[family].padY, `a ${family} row must gain vertical room`)
      .toBeGreaterThan(compact[family].padY);
    // Roomier, not a different layout. A density setting that doubles a row has become a font-size
    // control, which is a different feature with different accessibility obligations.
    expect(comfortable[family].height).toBeLessThan(compact[family].height * 1.6);
  }
  expect(comfortable.gap, "and the rows must sit further apart").toBeGreaterThan(compact.gap);
  expect(comfortable.gap, "without the list becoming a stack of cards").toBeLessThan(compact.gap * 2.5);
});

test("compact renders exactly what the merge base rendered", async ({ page }) => {
  // The first version of this compared a bare page with `?density=compact` — and the fixture
  // removes the attribute for both, so it compared the regressed implementation against ITSELF and
  // reported agreement. The values below are read from the merge base, so the comparison is against
  // what shipped rather than against whatever this branch happens to produce.
  await page.goto("/colour-schemes-e2e.html");
  expect(await page.evaluate(() => document.documentElement.dataset.density ?? null),
    "compact is the ABSENCE of the attribute, so the default cannot depend on storage").toBe(null);

  const computed = await page.evaluate(() => {
    const row = getComputedStyle(document.querySelector(".ui-row")!);
    const inbox = getComputedStyle(document.querySelector(".inbox-row")!);
    const list = getComputedStyle(document.querySelector(".settings-options")!);
    const boxRunner = getComputedStyle(document.querySelector(".runner-card.box-card")!);
    const nativeRunner = getComputedStyle(document.querySelector(".runner-card:not(.box-card)")!);
    return {
      rowPadding: `${row.paddingTop} ${row.paddingRight}`,
      rowMinHeight: row.minHeight,
      inboxPadding: `${inbox.paddingTop} ${inbox.paddingRight}`,
      inboxMinHeight: inbox.minHeight,
      listGap: list.rowGap,
      boxRunnerPadding: `${boxRunner.paddingTop} ${boxRunner.paddingRight}`,
      nativeRunnerPadding: `${nativeRunner.paddingTop} ${nativeRunner.paddingRight}`,
    };
  });
  expect(computed).toEqual({
    rowPadding: "11px 12px",
    // These two differ because the ELEMENTS differ, not because the rules do: neither declares a
    // minimum height, and Chromium computes `auto` for one and `0px` for the other by their box
    // type. Both are the merge base's values, which is the property being locked — the numbers here
    // were read from the browser rather than chosen, after an earlier version of this expectation
    // guessed `auto` for both and failed on the guess.
    rowMinHeight: "auto",
    inboxPadding: "9px 11px",
    inboxMinHeight: "0px",
    listGap: "6px",
    boxRunnerPadding: "16px 18px",
    nativeRunnerPadding: "16px 18px",
  });
});
