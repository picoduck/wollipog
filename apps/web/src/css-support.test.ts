import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import postcss from "postcss";
import {
  CSS_FEATURES,
  CSS_SURFACE,
  ENGINES,
  floorSetting,
  formatTarget,
  requiredFloor,
  stylesheetSurface,
  webviewTargets,
  type CssFeature,
} from "./css-support.js";
import { WOLLIPOG_WEBVIEW_TARGETS } from "../vite.config.js";

const raw = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
/** Comments quote example CSS, including features the stylesheet does not actually use. */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const surface = stylesheetSurface(postcss.parse(css));

const compatibilityDoc = readFileSync(
  fileURLToPath(new URL("../../../docs/vite-8-compatibility.md", import.meta.url)),
  "utf8",
);

const SURFACE_KINDS = ["atRules", "properties", "pseudos", "functions"] as const;

/**
 * #914: the production bundle shipped CSS that its own declared browser floor could not parse, and
 * nothing noticed for as long as the two were maintained separately. These tests make that
 * separation impossible — the floor is computed from the stylesheet's requirements, and the
 * stylesheet cannot acquire a requirement nobody has looked at.
 */

test("the build target is the registry's floor, not a separately maintained list", () => {
  assert.deepEqual(WOLLIPOG_WEBVIEW_TARGETS, webviewTargets(),
    "vite.config.ts must derive its target from CSS_FEATURES rather than restate one");
  // The drift this issue was filed for, pinned as a value: every one of these is above the floor
  // that used to be declared by hand (chrome107 / edge107 / firefox104 / safari16).
  assert.deepEqual(WOLLIPOG_WEBVIEW_TARGETS, ["chrome111", "edge111", "firefox121", "safari16.2"]);
});

test("the stylesheet uses no CSS outside the reviewed surface", () => {
  // The guard, inverted. A denylist of dangerous constructs was tried first and review found hole
  // after hole in it, because it has to predict what CSS will be invented. This asks the opposite
  // question — is everything here something a human has already looked at? — which is bounded by
  // the stylesheet and therefore answerable.
  const unreviewed: string[] = [];
  for (const kind of SURFACE_KINDS) {
    const allowed = new Set<string>(CSS_SURFACE[kind]);
    for (const name of surface[kind]) if (!allowed.has(name)) unreviewed.push(`${kind}: ${name}`);
  }
  assert.deepEqual(unreviewed, [],
    "styles.css uses CSS that nobody has classified yet. This is not a rejection — decide which it "
    + "is, add a CSS_FEATURES entry when the answer is not 'obviously old' (requires-floor raises "
    + "the build floor, downlevelled records what rewrites it, degrades records what a reader loses "
    + "without it), then add the name to CSS_SURFACE. Shipping it unreviewed is how the floor went "
    + "stale in the first place.");
});

test("the reviewed surface contains nothing the stylesheet has stopped using", () => {
  // Keeps the allowlist from silently becoming a museum: an entry nobody can reach is an entry
  // nobody re-checks, and it would quietly re-permit whatever it names.
  for (const kind of SURFACE_KINDS) {
    const live = new Set<string>(surface[kind]);
    const stale = CSS_SURFACE[kind].filter((name) => !live.has(name));
    assert.deepEqual(stale, [],
      `CSS_SURFACE.${kind} lists entries styles.css no longer uses: remove them, so the surface `
      + "keeps describing the stylesheet rather than its history.");
  }
});

test("every registered feature is actually used, so none inflates the floor for nothing", () => {
  for (const feature of CSS_FEATURES) {
    assert.ok(feature.detect.test(css),
      `${feature.id} is in CSS_FEATURES but no longer appears in styles.css. Remove it — a `
      + "feature the app does not use must not hold the browser floor up.");
  }
});

test("feature detectors are case-insensitive, as CSS identifiers are", () => {
  // `:HAS(` is the same selector as `:has(`. A case-sensitive detector would miss it entirely —
  // and would then report the entry as unused, inviting a maintainer to delete the one holding the
  // Firefox floor up and leaving the suite green on a floor that cannot run the stylesheet.
  for (const feature of CSS_FEATURES) {
    assert.ok(feature.detect.flags.includes("i"), `${feature.id} detector must be case-insensitive`);
  }
  const has = CSS_FEATURES.find((feature) => feature.id === ":has()")!;
  assert.ok(has.detect.test(":HAS(.x) { color: red }"),
    "an upper-case spelling must still count as used");
});

test("the surface extractor lower-cases, so spelling cannot defeat the allowlist", () => {
  const shouty = stylesheetSurface(postcss.parse("@MEDIA screen { .A:HOVER { COLOR: RGB(0 0 0) } }"));
  assert.deepEqual(shouty.atRules, ["media"]);
  assert.deepEqual(shouty.properties, ["color"]);
  assert.deepEqual(shouty.pseudos, ["hover"]);
  assert.deepEqual(shouty.functions, ["rgb"]);
});

test("strings are data, so valid CSS is never rejected for what is inside them", () => {
  // The worst failure mode for a guard like this is a false POSITIVE: rejecting a legitimate change
  // stops work, where a missed exotic case merely fails to start it. Both of these scanned as
  // grammar before strings were stripped, inventing a `foo()` function and a `new-token` pseudo.
  const urls = stylesheetSurface(postcss.parse('.a { background: url("foo(bar).svg") }'));
  assert.deepEqual(urls.functions, ["url"], "a filename containing parentheses is not a function");
  const attrs = stylesheetSurface(postcss.parse('[data-state="x:new-token"] { color: red }'));
  assert.deepEqual(attrs.pseudos, [], "an attribute value containing a colon is not a pseudo");
  // And the scan still sees real grammar in a declaration that also contains a string.
  const mixed = stylesheetSurface(postcss.parse('.b { background: url("x.svg") var(--y) }'));
  assert.deepEqual(mixed.functions, ["url", "var"]);
});

test("a custom property's value is surface even though its name is not", () => {
  // `--x: oklch(...)` reaches the browser exactly like any other declaration.
  const custom = stylesheetSurface(postcss.parse(":root { --probe: oklch(0.7 0.1 200) }"));
  assert.deepEqual(custom.properties, [], "custom property names are the app's own, not platform surface");
  assert.deepEqual(custom.functions, ["oklch"], "but what they contain still counts");
});

test("each entry carries the evidence its classification depends on", () => {
  for (const feature of CSS_FEATURES) {
    if (feature.kind === "requires-floor") {
      assert.ok(feature.whyNotDownlevelable.length > 40,
        `${feature.id} must explain why no compiler can rewrite it; a downlevelable feature raises `
        + "the floor for output the browser never receives");
      assert.match(feature.source, /retrieved \d{4}-\d{2}-\d{2}/,
        `${feature.id} must cite where its support data came from and when, so it can be re-checked`);
    } else if (feature.kind === "downlevelled") {
      assert.ok(feature.by.length > 10 && feature.evidence.length > 10,
        `${feature.id} claims the build compiles it away, which needs the rewriter and the evidence`);
    } else {
      assert.ok(feature.fallback.length > 40,
        `${feature.id} claims its absence is harmless, which needs saying what a reader actually loses`);
      assert.match(feature.source, /retrieved \d{4}-\d{2}-\d{2}/,
        `${feature.id} must cite its support data even though it does not bind, so it can be re-judged`);
    }
  }
});

test("only breaking features move the floor", () => {
  // `scrollbar-width` needs Chrome 121 and Safari 18.2 — above the computed floor — and is in the
  // stylesheet today. It is classified `degrades`, so it must not drag the whole app's floor up to
  // Safari 18.2 in exchange for scrollbar cosmetics. This is the assertion that keeps that true.
  const scrollbars = CSS_FEATURES.find((feature) => feature.id.startsWith("scrollbar-"))!;
  assert.equal(scrollbars.kind, "degrades");
  assert.deepEqual(requiredFloor().safari, [16, 2],
    "a gracefully-degrading feature must not raise the Safari floor");
  assert.ok(floorSetting().every((feature) => feature.kind === "requires-floor"));
});

test("the floor takes the maximum across features, per engine independently", () => {
  // Not one feature's row: the binding constraint differs by engine, which is exactly the kind of
  // thing a hand-maintained list gets wrong. color-mix() sets Chrome/Edge and Safari; :has() sets
  // Firefox, and does so from a version far above what any other feature needs.
  const floor = requiredFloor();
  assert.deepEqual(floor.chrome, [111, 0], "color-mix() is the binding constraint on Chrome");
  assert.deepEqual(floor.firefox, [121, 0], ":has() is the binding constraint on Firefox");
  assert.deepEqual(floor.safari, [16, 2], "color-mix() is the binding constraint on Safari");

  for (const engine of ENGINES) {
    const highest = Math.max(...floorSetting().map((feature) => feature.support[engine][0]));
    assert.equal(floor[engine][0], highest);
  }
});

test("a newly registered feature raises the floor rather than being absorbed", () => {
  const invented: CssFeature = {
    kind: "requires-floor",
    id: "invented",
    detect: /never-matches/i,
    support: { chrome: [200, 0], edge: [200, 0], firefox: [200, 0], safari: [20, 1] },
    source: "synthetic fixture, retrieved 2026-09-10",
    whyNotDownlevelable: "Fixture proving the floor tracks the registry rather than a fixed list.",
  };
  assert.deepEqual(webviewTargets([...CSS_FEATURES, invented]),
    ["chrome200", "edge200", "firefox200", "safari20.1"]);
});

test("a downlevelled entry is accounted for without raising the floor", () => {
  const nesting: CssFeature = {
    kind: "downlevelled",
    id: "CSS nesting",
    detect: /^\s*&/im,
    by: "Lightning CSS, which flattens nested rules into ordinary selectors",
    evidence: "synthetic fixture for this test",
  };
  assert.deepEqual(webviewTargets([...CSS_FEATURES, nesting]), webviewTargets(),
    "a downlevelled entry must not move the floor");
});

test("minor versions survive the target spelling", () => {
  // safari16.2 is the whole point: a floor rounded to `safari16` is the stale declaration again,
  // because Safari 16.0 and 16.1 cannot parse color-mix().
  assert.equal(formatTarget("safari", [16, 2]), "safari16.2");
  assert.equal(formatTarget("chrome", [111, 0]), "chrome111");
});

test("the compatibility document declares the same floor the build uses", () => {
  // The document is the human-readable half of the contract, and #914 was filed partly because it
  // asserted a floor the build had long since outgrown. Only the DECLARING sentence is checked:
  // the document also recounts the superseded floor as history, which is worth keeping and must not
  // be mistaken for a live claim.
  // Whole line, not a sentence: `Safari 16.2.` contains the delimiter a sentence split would use.
  const declaration = /^- Production JavaScript and CSS target (.+)$/m.exec(compatibilityDoc);
  assert.ok(declaration, "the platform contract must state the target in one recognisable sentence");
  for (const target of WOLLIPOG_WEBVIEW_TARGETS) {
    const [, engine, version] = /^([a-z]+)([\d.]+)$/.exec(target)!;
    const name = engine!.replace(/^./, (c) => c.toUpperCase());
    assert.match(declaration[1]!, new RegExp(`${name} ${version!.replace(".", "\\.")}\\b`),
      `the declaring sentence must name ${name} ${version}`);
  }
  assert.doesNotMatch(declaration[1]!, /Firefox 104\b|Chrome 107\b/,
    "the superseded floor must not be restated as the current target");
});
