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

async function measure(page: Page) {
  return page.evaluate(() => {
    const parse = (value: string) => {
      // Chromium serialises a `color-mix()` result as `color(srgb 0.51 0.73 0.98)` — components in
      // 0-1, not 0-255. Reading those as bytes made a light blue label parse as near-black and
      // measure 1.09:1 against a dark page, which looked exactly like a palette failure and was a
      // failure to read the palette.
      const srgb = /^color\(\s*srgb/.test(value);
      const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
      const scale = srgb ? 255 : 1;
      return {
        r: (parts[0] ?? 0) * scale,
        g: (parts[1] ?? 0) * scale,
        b: (parts[2] ?? 0) * scale,
        a: parts[3] ?? 1,
      };
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

    /**
     * The grounds behind an element — plural, because a gradient is several.
     *
     * A `background-image` is a paint layer above `background-color`, and the first version of this
     * walk ignored it: the primary button's label was measured against the page behind its
     * gradient, at 1.14:1, which is not what anyone sees. The browser resolves gradient stops to
     * rgb in the computed value, so every stop is a real ground and the label has to clear all of
     * them — a gradient is only as readable as its worst point.
     */
    const groundsOf = (element: Element) => {
      const layers: ReturnType<typeof parse>[] = [];
      let node: Element | null = element;
      let stops: ReturnType<typeof parse>[] = [];
      while (node) {
        const style = getComputedStyle(node);
        const image = style.backgroundImage;
        if (image && image !== "none") {
          const found = image.match(/rgba?\([^)]*\)/g)?.map(parse).filter((c) => c.a > 0) ?? [];
          if (found.length > 0) {
            stops = found;
            break;
          }
        }
        const fill = parse(style.backgroundColor);
        if (fill.a > 0) layers.push(fill);
        if (fill.a >= 1) break;
        node = node.parentElement;
      }
      const beneath = layers.length === 0
        ? { r: 255, g: 255, b: 255, a: 1 }
        : layers.reduceRight((below, above) => over(above, below));
      if (stops.length === 0) return [beneath];
      // The stops sit ON whatever was already accumulated, so a translucent gradient is composited
      // rather than assumed opaque.
      return stops.map((stop) => over(stop, beneath));
    };

    const results: { label: string; ratio: number }[] = [];
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
      const grounds = groundsOf(element);
      // The ink's own alpha and any inherited opacity are composited before measuring, so a faded
      // label is measured as it appears rather than as it is declared.
      const path = `${element.tagName.toLowerCase()}.${(element.className || "").toString().split(" ").join(".")}`;
      for (const ground of grounds) {
        const painted = over({ ...ink, a: ink.a * Number(style.opacity || 1) }, ground);
        results.push({ label: `${path} "${own.slice(0, 24)}"`, ratio: ratio(painted, ground) });
      }
    }
    return { results, unsupported };
  });
}

for (const scheme of SCHEMES) {
  for (const theme of THEMES) {
    test(`every rendered label clears AA in ${scheme} ${theme}`, async ({ page }) => {
      await page.goto(`/colour-schemes-e2e.html?scheme=${scheme}&theme=${theme}`);
      await expect(page.locator(".slash-item.active")).toBeVisible();

      const { results: measured, unsupported } = await measure(page);
      expect(unsupported, "group opacity is not modelled; no measured path may contain it").toEqual([]);
      // A vacuous version of the static check once passed while measuring nothing, so the count is
      // asserted before the ratios are.
      expect(measured.length, "the harness must render text to measure").toBeGreaterThan(15);

      const failures = measured
        .filter((entry) => entry.ratio < AA)
        .map((entry) => `${entry.label} is ${entry.ratio.toFixed(2)}:1`);
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
