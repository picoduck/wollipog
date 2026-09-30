import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  COMPACT_BREAKPOINT_PX,
  MOBILE_BREAKPOINT_PX,
  TABLET_BREAKPOINT_PX,
  WIDE_BREAKPOINT_PX,
} from "./components/useIsMobile.js";
import { containerBlocks, customProperties, mediaBlocks, topLevelRule } from "./css-rules.js";
import { ALTERNATIVES, SCHEMES, THEMES } from "./palettes.js";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

/** Custom properties of the one top-level rule with this selector list. */
function scope(selector: string): Map<string, string[]> {
  return customProperties(topLevelRule(css, selector));
}

/** The single value of `name` in `body`. Duplicates are a failure, not something to pick from. */
function only(body: Map<string, string[]>, name: string, where: string): string {
  const values = body.get(name);
  assert.ok(values, `${name} must be declared in ${where}`);
  assert.equal(values!.length, 1,
    `${name} is declared ${values!.length} times in ${where}; CSS applies the last, so a first-match read is a lie`);
  return values![0]!;
}

const PALETTE = ':root,\n:root[data-theme="dark"]';
const LIGHT = ':root[data-theme="light"]';
const TOKENS = ":root";

test("no root scope declares the same custom property twice", () => {
  // Appending a second `--radius` to a block reshapes every consumer while a first-match read
  // still reports the old value — every focused test stayed green.
  for (const selector of [PALETTE, LIGHT, TOKENS]) {
    for (const [name, values] of scope(selector)) {
      assert.equal(values.length, 1, `${selector} declares ${name} ${values.length} times`);
    }
  }
});

test("the palette radius tokens hold the design system's control and container tiers", () => {
  // docs/design-system.md §2.5 and §19.1: controls tightened from 8 to 6, containers from 10 to 8.
  const palette = scope(PALETTE);
  assert.equal(only(palette, "--radius", "the palette block"), "12px");
  assert.equal(only(palette, "--radius-sm", "the palette block"), "6px");
  assert.equal(only(palette, "--radius-md", "the palette block"), "8px");
});

/**
 * `:root[data-theme="dark"]` is (0,2,0) and outranks a plain `:root`, so a legacy radius token
 * redeclared in the token block takes effect in light mode only. Declaring one in the LIGHT block
 * does the mirror image: light reshapes, dark does not.
 *
 * The previous revision guarded only the token block, on the reasoning that styles.test.ts's
 * light-only check covered the rest. It does not — that check catches a name missing from the
 * shared scope, not a light-specific override of a name that is present.
 */
test("radius tokens are declared only in the palette block", () => {
  for (const [selector, where] of [[TOKENS, "the token block"], [LIGHT, "the light theme"]] as const) {
    const body = scope(selector);
    for (const legacy of ["--radius", "--radius-sm", "--radius-md"]) {
      assert.equal(body.get(legacy), undefined,
        `${legacy} in ${where} reshapes one theme and not the other`);
    }
  }
});

test("--shadow is themed in the palette and light blocks, and nowhere else", () => {
  // Unlike radius, --shadow SHOULD differ per theme: a shadow tuned for a dark ground reads as
  // soot on a white one. It still must not appear in the theme-agnostic token block.
  assert.ok(only(scope(PALETTE), "--shadow", "the palette block"));
  assert.ok(only(scope(LIGHT), "--shadow", "the light theme"));
  assert.equal(scope(TOKENS).get("--shadow"), undefined,
    "--shadow is theme-dependent; declaring it in the plain :root block applies to light mode only");
});

test("the type scale is the intended rem ladder", () => {
  const tokens = scope(TOKENS);
  const expected: ReadonlyArray<[string, string, number]> = [
    ["--text-xs", "0.6875rem", 11],
    ["--text-sm", "0.75rem", 12], ["--text-base", "0.8125rem", 13],
    ["--text-md", "0.875rem", 14], ["--text-lg", "1rem", 16],
    ["--text-xl", "1.25rem", 20], ["--text-2xl", "1.5rem", 24],
  ];
  for (const [name, value, px] of expected) {
    assert.equal(only(tokens, name, "the token block"), value, `${name} should be ${value} (${px}px)`);
    assert.equal(Number.parseFloat(value) * 16, px, `${name} must equal ${px}px at a 16px root`);
  }
});

test("the retired type sizes are neither declared nor read", () => {
  // docs/design-system.md §2.3 and §19.1: --text-2xs (10px) and --text-status (11.5px) collapse into
  // --text-xs (11px). A declaration left behind invites the next badge to read it again.
  for (const name of ["--text-2xs", "--text-status"]) {
    assert.equal(new RegExp(`${name}\\s*:`).test(css), false, `${name} must not be declared`);
    assert.equal(css.includes(`var(${name})`), false, `${name} must not be read`);
  }
});

test("the radius scale is an exact px ladder", () => {
  // Exact values, not parseInt ordering: `4rem` parses as 4 and would read as a valid first step
  // while computing to 64px.
  const tokens = scope(TOKENS);
  const palette = scope(PALETTE);
  assert.equal(only(tokens, "--radius-xs", "the token block"), "4px");
  assert.equal(only(palette, "--radius-sm", "the palette block"), "6px");
  assert.equal(only(palette, "--radius-md", "the palette block"), "8px");
  assert.equal(only(tokens, "--radius-lg", "the token block"), "12px");
  assert.equal(only(tokens, "--radius-pill", "the token block"), "999px");
});

/**
 * A query's purpose cannot be inferred from how close its width is to the breakpoint: moving the
 * phone layout to 700px escapes a proximity band entirely, while a legitimate future 800px
 * breakpoint would be rejected by one. Identify each phone-designated block by a selector only it
 * contains, then assert its width.
 */
test("every phone-designated media query uses the shared breakpoint", () => {
  assert.equal(only(scope(TOKENS), "--bp-phone", "the token block"), `${MOBILE_BREAKPOINT_PX}px`);

  const anchors: ReadonlyArray<[string, string]> = [
    [".rail-item.active::before", "the phone layout block"],
    [":root .composer-input", "the iOS focus-zoom guard"],
  ];
  const media = mediaBlocks(css);
  for (const [anchor, what] of anchors) {
    const owning = media.filter((block) => block.containsSelector(anchor));
    assert.equal(owning.length, 1, `${what}: expected exactly one media block containing ${anchor}`);
    const widths = owning[0]!.maxWidths;
    assert.equal(widths.length, 1, `${what}: expected a single max-width operand, got ${widths.join(", ")}`);
    assert.equal(widths[0], MOBILE_BREAKPOINT_PX,
      `${what} must use the shared phone breakpoint, or CSS and useIsMobile() disagree`);
  }
});

/**
 * The Sessions list card's shape is chosen in TWO places — a media query here and
 * `useIsTabletOrSmaller()` in the list — and the two must agree. When they disagree the card renders
 * one shape while the virtualizer positions unmeasured rows with the other shape's estimate, which
 * is a scroll that lands in the wrong place rather than anything visible in a screenshot (#901).
 */
test("the stacked-card media query uses the shared tablet breakpoint", () => {
  // `.inbox-row-lead` is the wrapper the stacked shape dissolves, so the block that dissolves it is
  // the block that owns the shape.
  const owning = mediaBlocks(css).filter((block) => block.containsSelector(".inbox-row-lead"));
  assert.equal(owning.length, 1, "expected exactly one media block to dissolve the card's lead wrapper");
  assert.deepEqual(owning[0]!.maxWidths, [TABLET_BREAKPOINT_PX],
    "the stacked card must start at the shared tablet breakpoint, or CSS and " +
    "useIsTabletOrSmaller() disagree about which shape the list is rendering");
});

test("the phone breakpoint is not what chooses the card's shape", () => {
  // #901 moved the stack from the phone breakpoint to the tablet one. If they are ever set to the
  // same number the distinction is gone and the regression is silent, so assert they differ.
  assert.notEqual(MOBILE_BREAKPOINT_PX, TABLET_BREAKPOINT_PX,
    "the card's density threshold and the phone threshold are different decisions");
  assert.ok(TABLET_BREAKPOINT_PX > MOBILE_BREAKPOINT_PX, "a tablet is wider than a phone");
});

/**
 * The tier tokens are documentation (media queries cannot read custom properties), so the only thing
 * keeping them honest is that they equal the constants useIsCompact() is built from (§2.10, #1969).
 */
test("the tier tokens mirror the JS tier constants, and the retired ones are gone", () => {
  const tokens = scope(TOKENS);
  assert.equal(only(tokens, "--bp-compact", "the token block"), `${COMPACT_BREAKPOINT_PX}px`);
  assert.equal(only(tokens, "--bp-wide", "the token block"), `${WIDE_BREAKPOINT_PX}px`);
  // 900 and 1240 were declared and read by nothing; 900 lives on only as the Sessions card threshold.
  for (const retired of ["--bp-tablet", "--bp-desktop"]) {
    assert.doesNotMatch(css, new RegExp(`${retired}\\b`), `${retired} was replaced by --bp-compact and --bp-wide`);
  }
});

test("every compact-tier query ends where useIsCompact() does", () => {
  // Anchored by what each block does, as the phone test above is, not by how close its width is.
  // A compact rule is written against the viewport (@media) or the main column (@container app).
  const compact = [...mediaBlocks(css).map((block) => ({ ...block, kind: "@media" })),
    ...containerBlocks(css).map((block) => ({ ...block, kind: "@container" }))].filter((block) =>
    block.containsSelector('.page-more[data-overflow="2"]') && block.kind === "@media" ||
    block.declarationsForSelector(".project-manager-grid").get("grid-template-columns")?.includes("280px minmax(0, 1fr)") ||
    block.containsSelector(".archive-session-meta"));
  assert.equal(compact.length, 3, "the page header's priority+ tier, the Projects list pane and the Archived Sessions table");
  for (const block of compact) {
    assert.deepEqual(block.maxWidths, [COMPACT_BREAKPOINT_PX - 1],
      `${block.kind} ${block.params} must end at the shared compact breakpoint, or CSS and useIsCompact() disagree`);
  }
  // The Projects list pane answers to the width the main column has (§2.10, #2105).
  const listPane = compact.find((block) => block.containsSelector(".project-manager-grid"));
  assert.equal(listPane?.kind, "@container");
  assert.match(listPane!.params, /^app\s*\(/, "the Projects list pane queries the main column's `app` container");
});

test("the main column is the `app` size container from the compact tier up (§2.10)", () => {
  const desktop = mediaBlocks(css).filter((block) =>
    block.declarationsForSelector(".main").get("container")?.includes("app / inline-size"));
  assert.equal(desktop.length, 1, "one rule makes `.main` the `app` container");
  assert.equal(desktop[0]!.params.replace(/\s+/g, " ").trim(), `(min-width: ${MOBILE_BREAKPOINT_PX + 1}px)`,
    "not on a phone, where the column is the viewport and fixed phone surfaces use viewport coordinates");
  assert.equal(topLevelRule(css, ".main").nodes.some((node) => node.type === "decl" && node.prop.startsWith("container")), false,
    "the unconditional `.main` rule declares no container");
});

test("the token block declares every promised member of every scale", () => {
  // A sampled inventory passes while an unreferenced token is moved into a component rule, where
  // it is no longer global at all. Enumerate the whole contract.
  const tokens = new Set(scope(TOKENS).keys());
  const promised = [
    "--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl",
    "--leading-tight", "--leading-normal", "--leading-relaxed",
    "--weight-normal", "--weight-medium", "--weight-semibold", "--weight-bold",
    "--type-page-title", "--type-title", "--type-section", "--type-body", "--type-body-strong",
    "--type-reading", "--type-small", "--type-label", "--type-micro", "--type-figure",
    "--space-0-5", "--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6", "--space-8",
    "--space-10", "--space-12", "--space-16",
    "--radius-xs", "--radius-lg", "--radius-pill",
    "--dur-instant", "--dur-fast", "--dur-base", "--dur-slow", "--ease-out", "--ease-spring",
    "--elev-1", "--elev-2", "--elev-3",
    "--z-sticky", "--z-dock", "--z-popover", "--z-backdrop", "--z-modal", "--z-palette", "--z-toast",
    "--bp-phone", "--bp-compact", "--bp-wide",
    "--surface-selected", "--focus", "--focus-width", "--focus-offset",
    "--primary-bg", "--primary-bg-hover", "--primary-bg-active", "--primary-fg", "--tint",
  ];
  const missing = promised.filter((name) => !tokens.has(name));
  assert.deepEqual(missing, [], `promised but not declared globally: ${missing.join(", ")}`);
});

test("the elevation ramp is complete in both themes", () => {
  const tokens = scope(TOKENS);
  const light = scope(LIGHT);
  for (const name of ["--elev-1", "--elev-2", "--elev-3"]) {
    assert.ok(only(tokens, name, "the token block"));
    assert.ok(only(light, name, "the light theme"));
  }
  // topLevelRule throws unless there is exactly one, so reaching here proves it.
  assert.doesNotThrow(() => topLevelRule(css, LIGHT),
    "a theme must be declared in exactly one top-level block");
});

/**
 * The values docs/design-system.md §2.2–§2.4 fixes. Derived colours are `var()` references in the
 * shared block, so every scheme resolves them from its own palette; asserting the reference rather
 * than a hex is what keeps them derived.
 */
test("the foundation tokens hold the design system's values", () => {
  const tokens = scope(TOKENS);
  const expected: ReadonlyArray<[string, string]> = [
    ["--surface-selected", "color-mix(in srgb, var(--accent) 12%, var(--bg-elev))"],
    ["--focus", "var(--text)"], ["--focus-width", "2px"], ["--focus-offset", "2px"],
    ["--primary-bg", "var(--primary-from)"], ["--primary-bg-hover", "var(--primary-hover-from)"],
    ["--primary-bg-active", "var(--primary-active-from)"], ["--primary-fg", "var(--on-accent)"],
    ["--tint", "14%"],
    ["--type-page-title", "600 var(--text-xl)/28px var(--font-ui)"],
    ["--type-title", "600 var(--text-lg)/24px var(--font-ui)"],
    ["--type-section", "600 var(--text-md)/20px var(--font-ui)"],
    ["--type-body", "400 var(--text-base)/20px var(--font-ui)"],
    ["--type-body-strong", "500 var(--text-base)/20px var(--font-ui)"],
    ["--type-reading", "400 var(--text-md)/22px var(--font-ui)"],
    ["--type-small", "400 var(--text-sm)/16px var(--font-ui)"],
    ["--type-label", "500 var(--text-sm)/16px var(--font-ui)"],
    ["--type-micro", "500 var(--text-xs)/16px var(--font-ui)"],
    ["--type-figure", "600 var(--text-2xl)/32px var(--font-ui)"],
    ["--space-0-5", "2px"], ["--space-12", "48px"], ["--space-16", "64px"],
  ];
  for (const [name, value] of expected) assert.equal(only(tokens, name, "the token block"), value, name);
});

/**
 * Per-theme tokens live in the two theme blocks, one value each. The four generated schemes inherit
 * them (colour-schemes.test.ts measures that the inherited pairs still read in every scheme).
 */
test("the per-theme foundation tokens have a value in each theme", () => {
  const palette = scope(PALETTE);
  const light = scope(LIGHT);
  const expected: ReadonlyArray<[string, string, string]> = [
    ["--field-bg", "var(--bg)", "var(--bg-elev)"],
    ["--danger-bg", "#c93c37", "#cf222e"],
    ["--danger-bg-hover", "#b62324", "#a40e26"],
    ["--danger-fg", "#ffffff", "#ffffff"],
    ["--count-warning-fg", "#1b1300", "#ffffff"],
  ];
  for (const [name, dark, lightValue] of expected) {
    assert.equal(only(palette, name, "the palette block"), dark, `${name} (dark)`);
    assert.equal(only(light, name, "the light theme"), lightValue, `${name} (light)`);
    assert.equal(scope(TOKENS).get(name), undefined, `${name} in the token block would outrank the light theme`);
  }
});

const FOUNDATION_TOKENS = [
  "--surface-selected", "--focus", "--focus-width", "--focus-offset", "--primary-bg", "--primary-bg-hover",
  "--primary-bg-active", "--primary-fg", "--danger-fg", "--tint", "--field-bg", "--danger-bg",
  "--danger-bg-hover", "--count-warning-fg", "--type-page-title", "--type-title", "--type-section",
  "--type-body", "--type-body-strong", "--type-reading", "--type-small", "--type-label", "--type-micro",
  "--type-figure", "--space-0-5", "--space-12", "--space-16",
] as const;

/**
 * Every foundation token resolves, through its whole `var()` chain, in every scheme and theme.
 *
 * The cascade on `<html>` is modelled the way the selectors apply: the token block and the palette
 * block match in both themes, the light block overrides in light, and a scheme block overrides last.
 * A derived token that names something a scheme lacks, or a per-theme token missing from one theme,
 * fails here rather than rendering as an invalid declaration in that one palette.
 */
test("the foundation tokens resolve in every colour scheme and theme", () => {
  assert.ok(ALTERNATIVES.length >= 4, "the four generated schemes must be registered");
  for (const scheme of SCHEMES) {
    for (const theme of THEMES) {
      const layers = [scope(TOKENS), scope(PALETTE)];
      if (theme === "light") layers.push(scope(LIGHT));
      if (scheme !== "wollipog") layers.push(scope(`:root[data-scheme="${scheme}"][data-theme="${theme}"]`));
      const merged = new Map<string, string>();
      for (const layer of layers) for (const [name, values] of layer) merged.set(name, values[values.length - 1]!);

      const resolve = (name: string, seen: string[]): string => {
        assert.ok(!seen.includes(name), `${scheme}/${theme}: ${[...seen, name].join(" -> ")} is a cycle`);
        const value = merged.get(name);
        assert.ok(value !== undefined, `${scheme}/${theme}: ${seen.at(-1) ?? name} references undeclared ${name}`);
        return value.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/g, (_, inner: string) => resolve(inner, [...seen, name]));
      };
      for (const name of FOUNDATION_TOKENS) {
        const value = resolve(name, []);
        assert.doesNotMatch(value, /var\(/, `${scheme}/${theme}: ${name} did not resolve (${value})`);
      }
    }
  }
});
