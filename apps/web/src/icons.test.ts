import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Icons come from one module.
 *
 * Twenty-one inline `<svg>` elements had accumulated across eight components, and they had drifted
 * exactly as you would expect: three stroke widths (1.8, 2, and a spread `stroke` object), five
 * sizes, one non-24 viewBox, and three fill-style paths among otherwise stroked icons. None of that
 * is visible in a diff, and none of it fails anything — it just makes the app look assembled from
 * parts.
 *
 * These are SOURCE-shape assertions, and that is the honest level for this property: "every icon
 * comes from `Icons.tsx`" is a fact about imports, not about pixels. What renders is covered by the
 * paint harnesses in §25 and §26.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { sourceFiles(path, out); continue; }
    // `.ts` as well as `.tsx`: `createElement("svg")` needs no JSX, and a lock that only reads
    // .tsx files simply does not look at half the source.
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * The two files allowed to contain an `<svg>` element.
 *
 * `Icons.tsx` owns the local and library adapters, plus marks that deliberately do not use either
 * and say so at the definition. `AgentIcon.tsx` holds vendor brand marks, which are fixed by their
 * owners.
 */
const SVG_OWNERS = ["components/Icons.tsx", "components/AgentIcon.tsx"];

test("no component draws its own <svg>", () => {
  const offenders: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const relative = path.slice(SRC.length).replace(/\\/g, "/");
    if (SVG_OWNERS.includes(relative)) continue;
    const source = readFileSync(path, "utf8");
    // Strip comments so a doc comment mentioning the element is not an offence.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    // JSX is not the only way to make an element. `createElement("svg")`, a spread onto a lowercase
    // "svg" tag, and raw markup through dangerouslySetInnerHTML all produce one without the literal.
    for (const [pattern, how] of [
      [/<svg[\s>]/, "<svg>"],
      // Any factory call naming the tag, however the import is aliased: createElement("svg"),
      // h("svg"), jsx("svg").
      [/\w+\(\s*["'`]svg["'`]/, 'a factory call naming "svg"'],
      [/dangerouslySetInnerHTML/i, "dangerouslySetInnerHTML — markup this cannot read"],
      // A polymorphic tag: `const Tag = "svg"` then `<Tag />` produces one with no literal.
      [/=\s*["'`]svg["'`]/, 'a variable holding the "svg" tag name'],
      // Imports that bypass the local and library adapters own geometry without a literal <svg>.
      [/IconBase/, "IconBase — every glyph is a named export in Icons.tsx"],
      [/\bfrom\s+["']lucide-react(?:\/[^"']*)?["']/, "a direct library glyph import outside Icons.tsx"],
    ] as const) {
      if (pattern.test(code)) offenders.push(`${relative} (${how})`);
    }
  }
  assert.deepEqual(offenders, [],
    "an inline <svg> drifts from the shared contract; export it through Icons.tsx instead");
});

test("every icon in Icons.tsx shares an approved icon adapter, or says why not", () => {
  const source = readFileSync(join(SRC, "components/Icons.tsx"), "utf8");
  /** Marks that own their `<svg>`, each because it is not ours to redraw or restyle. */
  const EXEMPT = new Set([
    "IconBase",
    // A brand mark with its own 16-unit geometry and solid fill.
    "GitHubIcon",
    // Solid on purpose, where the stroked version reads too light at 13px.
    "FolderSolidIcon",
    // Solid on purpose: the approvals status mark's WEIGHT is the signal, and IconBase's
    // `fill: none` turned it into a thin hollow outline.
    "ShieldIcon",
  ]);

  const offenders: string[] = [];
  for (const match of source.matchAll(/export function (\w+)\(([\s\S]*?)\n\}/g)) {
    const [, name, body] = match;
    if (EXEMPT.has(name!)) continue;
    if (!/<(?:IconBase|LibraryIcon)/.test(body!)) offenders.push(name!);
  }
  assert.deepEqual(offenders, [], "an icon outside the approved adapters has its own conventions");

  // The exemptions must still be real: each has to carry a `<svg>` of its own, or it is stale.
  for (const name of EXEMPT) {
    if (name === "IconBase") continue;
    const at = source.indexOf(`export function ${name}(`);
    assert.notEqual(at, -1, `${name} is on the exemption list but no longer exists`);
    const body = source.slice(at);
    assert.match(body.slice(0, body.indexOf("\n}")), /<svg/,
      `${name} is exempt from IconBase but no longer draws its own <svg>; remove the exemption`);
  }
});

/**
 * IconBase's invariants ARE the shared identity — a caller that overrides them has left the set
 * while still counting as "composes IconBase". Nothing asserted them, so the whole lock rested on
 * a component whose defaults could be changed silently.
 */
test("IconBase pins the conventions every icon shares", () => {
  const source = readFileSync(join(SRC, "components/Icons.tsx"), "utf8");
  const base = source.slice(source.indexOf("function IconBase("), source.indexOf("type LibraryIconProps"));
  for (const [pattern, why] of [
    [/viewBox="0 0 24 24"/, "one coordinate system, so paths are comparable between icons"],
    [/strokeWidth="1\.8"/, "the single stroke weight; 2 and a spread object were the drift"],
    [/strokeLinecap="round"/, "round caps and joins are what make the set look like one set"],
    [/strokeLinejoin="round"/, "round caps and joins are what make the set look like one set"],
    [/fill="none"/, "stroked by default; a solid mark opts out explicitly and says why"],
    [/aria-hidden="true"/, "decorative — the accessible name belongs to the control around it"],
    [/focusable="false"/, "IE/Edge legacy: an svg in the tab order is a phantom stop"],
  ] as const) {
    assert.match(base, pattern, `IconBase must set ${pattern.source}: ${why}`);
  }
  // `{...props}` must come AFTER the defaults or a caller cannot override deliberately; it must not
  // come after `children`, or a caller could replace the drawing.
  assert.ok(base.indexOf("{...props}") > base.indexOf('fill="none"'),
    "spread props after the defaults, so an opt-out is possible and explicit");
});

test("LibraryIcon preserves the local icon contract around third-party glyphs", () => {
  const source = readFileSync(join(SRC, "components/Icons.tsx"), "utf8");
  const base = source.slice(source.indexOf("function LibraryIcon("), source.indexOf("export function GridIcon"));
  for (const [pattern, why] of [
    [/size=\{size\}/, "the app's numeric size scale"],
    [/strokeWidth=\{1\.8\}/, "the app's stroke weight rather than the library default"],
    [/aria-hidden="true"/, "decorative — the accessible name belongs to the surrounding control"],
    [/focusable="false"/, "an SVG must not create a phantom tab stop"],
    [/className=\{`app-icon/, "existing layout and color rules target the shared app-icon class"],
  ] as const) {
    assert.match(base, pattern, `LibraryIcon must preserve ${pattern.source}: ${why}`);
  }
});

test("nothing uses an ellipsis as a progress indicator", () => {
  const offenders: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const source = readFileSync(path, "utf8");
    // `busy ? "…" : X` — a static glyph standing in for a spinner. It does not animate, it does not
    // announce itself to a screen reader, and it reads as truncated text rather than as progress.
    // Independent of variable names and line breaks: any ternary branch that is a bare ellipsis is
    // a static glyph standing in for progress. Keying on `busy|loading|…` meant renaming the flag
    // silently disabled the check, which is a lock that protects only the code that already passed.
    for (const match of source.matchAll(/[?:]\s*"…"/g)) {
      offenders.push(`${path.slice(SRC.length).replace(/\\/g, "/")}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "use <Spinner />, which animates and carries an accessible name");
});
