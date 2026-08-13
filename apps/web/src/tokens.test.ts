import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MOBILE_BREAKPOINT_PX } from "./components/useIsMobile.js";
import { customProperties, mediaBlocks, topLevelRule } from "./css-rules.js";

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

test("the legacy radius tokens keep their existing values", () => {
  const palette = scope(PALETTE);
  assert.equal(only(palette, "--radius", "the palette block"), "12px");
  assert.equal(only(palette, "--radius-sm", "the palette block"), "8px");
  assert.equal(only(palette, "--radius-md", "the palette block"), "10px");
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
    ["--text-2xs", "0.625rem", 10], ["--text-xs", "0.6875rem", 11],
    ["--text-sm", "0.75rem", 12], ["--text-base", "0.8125rem", 13],
    ["--text-md", "0.875rem", 14], ["--text-lg", "1.0625rem", 17],
    ["--text-xl", "1.25rem", 20], ["--text-2xl", "1.5rem", 24],
  ];
  for (const [name, value, px] of expected) {
    assert.equal(only(tokens, name, "the token block"), value, `${name} should be ${value} (${px}px)`);
    assert.equal(Number.parseFloat(value) * 16, px, `${name} must equal ${px}px at a 16px root`);
  }
});

test("the radius scale is an exact px ladder", () => {
  // Exact values, not parseInt ordering: `4rem` parses as 4 and would read as a valid first step
  // while computing to 64px.
  const tokens = scope(TOKENS);
  const palette = scope(PALETTE);
  assert.equal(only(tokens, "--radius-xs", "the token block"), "4px");
  assert.equal(only(palette, "--radius-sm", "the palette block"), "8px");
  assert.equal(only(palette, "--radius-md", "the palette block"), "10px");
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

test("the token block declares every promised member of every scale", () => {
  // A sampled inventory passes while an unreferenced token is moved into a component rule, where
  // it is no longer global at all. Enumerate the whole contract.
  const tokens = new Set(scope(TOKENS).keys());
  const promised = [
    "--text-2xs", "--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl",
    "--leading-tight", "--leading-normal", "--leading-relaxed",
    "--weight-normal", "--weight-medium", "--weight-semibold", "--weight-bold",
    "--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6", "--space-8", "--space-10",
    "--radius-xs", "--radius-lg", "--radius-pill",
    "--dur-instant", "--dur-fast", "--dur-base", "--dur-slow", "--ease-out", "--ease-spring",
    "--elev-1", "--elev-2", "--elev-3",
    "--z-sticky", "--z-dock", "--z-popover", "--z-backdrop", "--z-modal", "--z-palette", "--z-toast",
    "--bp-phone", "--bp-tablet", "--bp-desktop",
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
