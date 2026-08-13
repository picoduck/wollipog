import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { customProperties, topLevelRule } from "./css-rules.js";
import { DENSITY_OPTIONS, applyDensityToDocument, parseDensity } from "./theme.js";

/**
 * Density, phase 8's §F8 half.
 *
 * §F8's finding was that the app is a uniformly dense grey field — a 14px body with real working
 * sizes of 11-13px — so "compact" here NAMES what already ships rather than introducing a tighter
 * mode. That is why compact is the default and why the default renders byte for byte as before:
 * a density setting whose default changes every screen is a redesign wearing a settings row.
 *
 * What these check is the model and the wiring. Whether comfortable is actually roomier is a
 * question about rendered boxes, and `colour-schemes.spec.ts` measures it in a browser — a token
 * nothing reads looks identical to one that works, from here.
 */

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
const provider = readFileSync(fileURLToPath(new URL("./components/ThemeProvider.tsx", import.meta.url)), "utf8");
const view = readFileSync(fileURLToPath(new URL("./components/SettingsView.tsx", import.meta.url)), "utf8");
const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

test("compact is the default, and the default is the absence of a setting", () => {
  assert.equal(parseDensity(null), "compact");
  assert.equal(parseDensity("nonsense"), "compact");
  assert.equal(parseDensity("comfortable"), "comfortable");

  // The same shape as Wollipog for schemes: a default expressed as a VALUE needs a second block
  // duplicating the base, and duplicated tokens drift. It also makes the default depend on storage
  // being readable, which is the one thing a default should not depend on.
  const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
  const doc = { documentElement: root } as unknown as Document;
  applyDensityToDocument(doc, "comfortable");
  assert.equal(root.dataset.density, "comfortable");
  applyDensityToDocument(doc, "compact");
  assert.equal(root.dataset.density, undefined);
});

test("every density token the comfortable block overrides is declared by the base", () => {
  // A token the base does not declare is a token that falls back to nothing when the setting is
  // off — the density equivalent of a scheme inheriting Wollipog's accent.
  // TWO base blocks, not one: the colour tokens live in `:root, :root[data-theme="dark"]` and the
  // scales — type, space, radius, and now the row rhythm — live in the plain `:root`. Reading only
  // the first reported every density token as missing, which was a wrong model rather than a bug.
  const base = new Set([
    ...customProperties(topLevelRule(css, ':root,\n:root[data-theme="dark"]')).keys(),
    ...customProperties(topLevelRule(css, ":root")).keys(),
  ]);
  const comfortable = customProperties(topLevelRule(css, ':root[data-density="comfortable"]'));
  assert.ok(comfortable.size >= 5, "the comfortable block must actually override the rhythm");
  const missing = [...comfortable.keys()].filter((name) => !base.has(name));
  assert.deepEqual(missing, [], "comfortable overrides a token compact never defines");
});

test("every class the harness renders is a class the app renders", () => {
  // Three times on this campaign a fixture has invented a class — `.slash-source`, `.board-card`,
  // and `.board-col` — and each time it measured unstyled markup and reported success. The first
  // version of this guard let `.board-col` through because `includes("board-col")` matched the
  // substring inside `dataKind="board-column"`, which is the same substring-versus-token mistake
  // the choice ratchet was fixed for.
  const fixture = readFileSync(fileURLToPath(new URL("./e2e/colour-schemes-main.tsx", import.meta.url)), "utf8");
  // Static attributes AND the literal parts of template expressions, since `st ${status}` carries
  // a real class in its static half.
  const used = [...fixture.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .flatMap((match) => (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, " ").split(/\s+/))
    .filter(Boolean);

  const componentDir = fileURLToPath(new URL("./components/", import.meta.url));
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (/\.tsx?$/.test(entry.name)) sources.push(readFileSync(path, "utf8"));
    }
  };
  walk(componentDir);
  // EXACT tokens, from every string literal in the components rather than from `className=` alone:
  // real classes reach the DOM through helpers too — `sourceGutter(row, no, "diff-gutter
  // diff-gutter-new")` and `rowClass("ui-row-nav", disabled)` are both production markup, and an
  // attribute-only scan called them invented. Whole tokens still, so `board-col` cannot pass on the
  // strength of `dataKind="board-column"` the way it did before.
  const rendered = new Set(
    sources.flatMap((source) => [...source.matchAll(/["'`]([^"'`]*)["'`]/g)]
      .flatMap((match) => match[1]!.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)))
      .filter((token) => /^[a-z][a-z0-9-]*$/.test(token)),
  );

  // One explicit list, no prefix rules: a prefix lets any invented class hide behind it.
  const HARNESS_ONLY = new Set(["sample-row"]);
  const unknown = [...new Set(used)]
    .filter((name) => !HARNESS_ONLY.has(name) && !rendered.has(name) && !css.includes(`.${name} `)
      && !css.includes(`.${name},`) && !css.includes(`.${name}{`) && !css.includes(`.${name}:`)
      && !css.includes(`.${name}.`) && !css.includes(`.${name}
`));
  assert.deepEqual(unknown, [], "the harness renders a class the app never does");
});

test("the rhythm is driven by tokens, not by literals", () => {
  // The point of the axis is that ONE edit reaches every screen through the primitives. A row that
  // hardcodes its padding is a row the setting cannot move, and it will look like the setting is
  // broken rather than like that row opted out.
  const row = css.slice(css.indexOf(".ui-row {"), css.indexOf(".ui-row:hover"));
  assert.match(row, /padding: var\(--row-pad-y\) var\(--row-pad-x\)/);
  const inbox = css.slice(css.indexOf(".inbox-row {"), css.indexOf(".inbox-row:hover"));
  assert.match(inbox, /padding: var\(--inbox-row-pad-y\) var\(--inbox-row-pad-x\)/);
  // And the families review found the first version bypassed, so the setting is application-wide
  // rather than "works on the two screens I happened to wire".
  for (const [selector, token] of [
    [".review-queue-row {", "--queue-row-pad-y"],
    [".project-manager-item {", "--project-row-pad-y"],
    [".card {", "--card-pad-y"],
    [".runner-card {", "--runner-card-pad-y"],
  ] as const) {
    const rule = css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));
    assert.ok(rule.includes(`var(${token})`), `${selector.trim()} must scale with the density axis`);
  }
});

test("the setting is offered, persisted, and applied before paint", () => {
  assert.deepEqual(DENSITY_OPTIONS.map((option) => option.value), ["compact", "comfortable"]);
  for (const option of DENSITY_OPTIONS) {
    assert.ok(option.description.length > 0, `${option.value} needs a reason to pick it`);
  }
  // A ROW, not a group. Density was one of three headings each owning a stack of one-option rows;
  // it is a single row in Appearance's one group now, so the control is the thing to look for.
  assert.match(view, /title="Density"[\s\S]{0,120}options=\{densities\}/,
    "the control has to exist in Settings and be fed the options");
  assert.match(app, /densities=\{DENSITY_OPTIONS\}/, "and be wired to the shell's state");
  assert.match(provider, /saveBrowserStorageValue\(DENSITY_STORAGE_KEY, density\)/, "and survive a reload");
  // Applied in the head, or a Comfortable user watches every row jump on load — the same no-flash
  // problem the theme and the scheme each have.
  assert.match(html, /dataset\.density = density/, "the density must be applied before first paint");
});

test("the comfortable block sits outside the generated region", () => {
  // Everything between the scheme generator's sentinel and its insertion marker is REPLACED on
  // every run. The first version of the comfortable block lived there and was silently deleted the
  // next time the generator ran; the idempotency test caught it. Position is load-bearing here.
  const sentinel = css.indexOf("/* --- COLOUR SCHEMES, GENERATED --- */");
  const block = css.indexOf(':root[data-density="comfortable"]');
  assert.ok(block !== -1, "the comfortable block must exist");
  assert.ok(sentinel === -1 || block < sentinel,
    "a hand-written block inside the generated region is deleted by the next regeneration");
});
