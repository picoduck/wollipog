import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ACCOUNTABLE_CONSTRUCTS,
  ENGINES,
  FEATURE_SUPPORT,
  formatTarget,
  requiredFloor,
  webviewTargets,
  type CssFeature,
} from "./css-support.js";
import { WOLLIPOG_WEBVIEW_TARGETS } from "../vite.config.js";

const raw = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
/** Comments quote example CSS, including features the stylesheet does not actually use. */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

const compatibilityDoc = readFileSync(
  fileURLToPath(new URL("../../../docs/vite-8-compatibility.md", import.meta.url)),
  "utf8",
);

/**
 * #914: the production bundle shipped CSS that its own declared browser floor could not parse, and
 * nothing noticed for as long as the two were maintained separately. These tests exist to make that
 * separation impossible — the floor is computed from the stylesheet's requirements, and the
 * stylesheet cannot acquire a requirement the registry has not accounted for.
 */

test("the build target is the registry's floor, not a separately maintained list", () => {
  assert.deepEqual(WOLLIPOG_WEBVIEW_TARGETS, webviewTargets(),
    "vite.config.ts must derive its target from FEATURE_SUPPORT rather than restate one");
  // The drift this issue was filed for, pinned as a value: every one of these is above the floor
  // that used to be declared by hand (chrome107 / edge107 / firefox104 / safari16).
  assert.deepEqual(WOLLIPOG_WEBVIEW_TARGETS, ["chrome111", "edge111", "firefox121", "safari16.2"]);
});

test("every registered feature is actually used, so none inflates the floor for nothing", () => {
  for (const feature of FEATURE_SUPPORT) {
    assert.ok(feature.detect.test(css),
      `${feature.id} is in FEATURE_SUPPORT but no longer appears in styles.css. Remove it — a `
      + "feature the app does not use must not hold the browser floor up.");
  }
});

test("every accountable construct in the stylesheet is registered with support data", () => {
  const registered = new Set(FEATURE_SUPPORT.map((feature) => feature.id));
  const unaccounted = ACCOUNTABLE_CONSTRUCTS
    .filter((construct) => construct.detect.test(css))
    .map((construct) => construct.id)
    .filter((id) => !registered.has(id));
  assert.deepEqual(unaccounted, [],
    "styles.css uses CSS that no FEATURE_SUPPORT entry accounts for. Add an entry with its first "
    + "supporting versions and a source, which raises the build floor in this same commit — or, if "
    + "Lightning CSS compiles the feature away for the current floor, say so in the entry instead. "
    + "Shipping it unaccounted for is how the floor silently went stale in the first place.");
});

test("each registered feature records why it cannot simply be compiled for an older engine", () => {
  for (const feature of FEATURE_SUPPORT) {
    assert.ok(feature.whyNotDownlevelable.length > 40,
      `${feature.id} must explain why no compiler can rewrite it; a downlevelable feature raises `
      + "the floor for output the browser never receives");
    assert.match(feature.source, /retrieved \d{4}-\d{2}-\d{2}/,
      `${feature.id} must cite where its support data came from and when, so it can be re-checked`);
  }
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
    const highest = Math.max(...FEATURE_SUPPORT.map((feature) => feature.support[engine][0]));
    assert.equal(floor[engine][0], highest);
  }
});

test("a newly registered feature raises the floor rather than being absorbed", () => {
  const invented: CssFeature = {
    id: "invented",
    detect: /never-matches/,
    support: { chrome: [200, 0], edge: [200, 0], firefox: [200, 0], safari: [20, 1] },
    source: "synthetic fixture, retrieved 2026-09-10",
    whyNotDownlevelable: "Fixture proving the floor tracks the registry rather than a fixed list.",
  };
  assert.deepEqual(webviewTargets([...FEATURE_SUPPORT, invented]),
    ["chrome200", "edge200", "firefox200", "safari20.1"]);
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
