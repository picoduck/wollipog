import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * #1955: a ratchet on text glyphs standing in for icons.
 *
 * A "▸" disclosure, a "×" close button or "✓ Copied" renders in the text font and weight, so it looks
 * different from the Lucide icon beside it. docs/design-system.md §18 maps each to an icon. The sites
 * below predate that rule. Each area epic removes its own as it rebuilds the screen, rather than one
 * change rewriting screens that are about to be rewritten again, and this test keeps new ones out.
 *
 * WHAT THIS RECOGNISES. Every §18 text glyph in a string literal, template chunk or JSX text of a
 * production file, read through the TypeScript AST, so comments are ignored and a JSX entity such as
 * `&times;` is read as the character it renders. Tests and the Playwright harnesses in `src/e2e` are
 * not production. "⚠" is on the §18 list but is an emoji (Extended_Pictographic), which the emoji
 * inventory in stylesheet-guardrails.test.ts (#1804) already records, so it is not counted twice.
 *
 * The unit is a SITE: file, glyph and the enclosing literal's text, compared entry for entry, so a
 * new site fails, a copy of a recorded one fails, and removing one fails until its entry here goes in
 * the same change. The list only shrinks, and every change to it is in the diff.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** The §18 list's text glyphs, less its emoji. */
export const TEXT_GLYPHS = ["×", "✕", "✓", "▸", "▾", "↻", "←", "→", "▤", "❞", "△", "◐", "○", "⑃", "✎", "◒", "↯", "↳", "ⓘ"] as const;

// The area epics that own the recorded sites. An epic that is filed carries its number; the rest are
// named by area and gain a number when filed.
const COMPOSER = "Composer epic (not yet filed)";
const SESSION_FRAME = "Session Page Frame and Header epic (not yet filed)";
const RIGHT_PANEL = "Right Panel and Code Review epic (#2870)";
const APPROVALS = "Approvals, Questions and Governance epic (#2226)";
const AUTOMATIONS = "Automations epic (not yet filed)";
const CONNECTIONS = "Connections epic (not yet filed)";
const PODS = "Pods epic (not yet filed)";
const TERMINAL = "Terminal epic (not yet filed)";

/** The inventory, exact: [file, glyph, the enclosing literal's text, the owning area epic]. */
const RECORDED: readonly (readonly [string, string, string, string])[] = [
  ["components/AutomationsView.tsx", "▸", "▸", AUTOMATIONS],
  ["components/AutomationsView.tsx", "×", "×", AUTOMATIONS],
  ["components/OnboardRunnerDialog.tsx", "✓", "✓", CONNECTIONS],
  ["components/OnboardRunnerDialog.tsx", "△", "△", CONNECTIONS],
  ["components/OnboardRunnerDialog.tsx", "✓", "✓", CONNECTIONS],
  ["components/OnboardRunnerDialog.tsx", "↻", "↻ Retry", CONNECTIONS],
  ["components/PodsView.tsx", "→", "→", PODS],
  ["components/PodsView.tsx", "→", "→", PODS],
  ["components/ShellDock.tsx", "×", "×", TERMINAL],
  ["components/ShellDock.tsx", "×", "×", TERMINAL],
];

/**
 * Legitimate text, exempt by name: [file, glyph, the enclosing literal's text, why it is text].
 * An exemption is for a glyph that IS the content, never for an icon nobody has replaced yet.
 */
const EXEMPT: readonly (readonly [string, string, string, string])[] = [
  ["shortcuts.ts", "→", "→", "a keycap's display key for ArrowRight"],
  ["shortcuts.ts", "←", "←", "a keycap's display key for ArrowLeft"],
  ["shortcuts.ts", "→", "Hidden in Settings → Appearance", "a settings path written in a sentence"],
  ["shortcuts.ts", "→", "Turned off in Settings → Experimental", "a settings path written in a sentence"],
  ["components/Markdown.tsx", "×", "×", "the multiplication sign in an image's pixel size, 1280 × 720"],
  ["components/requests/EvidenceReview.tsx", "×", "×", "the multiplication sign in a UI evidence capture's pixel size, 960 × 600"],
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of [...readdirSync(dir)].sort()) {
    const path = join(dir, entry);
    // `src/e2e` is Playwright harness markup, reachable only from a harness page.
    if (entry === "e2e" && statSync(path).isDirectory()) continue;
    if (statSync(path).isDirectory()) { sourceFiles(path, out); continue; }
    if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

const namedEntities = new Map<string, string>();

/** JSX character references as the JSX transform renders them, named ones asked of the TypeScript emitter. */
function decodeJsxEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi, (whole, hex?: string, decimal?: string, name?: string) => {
    if (hex || decimal) {
      const codePoint = Number.parseInt(hex ?? decimal!, hex ? 16 : 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : whole;
    }
    if (!namedEntities.has(name!)) {
      const emitted = ts.transpileModule(`<b>&${name};</b>`, { compilerOptions: { jsx: ts.JsxEmit.React } }).outputText;
      const literal = /, "((?:[^"\\]|\\.)*)"\)/.exec(emitted)?.[1];
      namedEntities.set(name!, literal === undefined ? whole : JSON.parse(`"${literal}"`) as string);
    }
    return namedEntities.get(name!)!;
  });
}

/** Every §18 text glyph in a literal or JSX text, as `file|glyph|text`, one entry per occurrence. */
export function textGlyphSites(source: string, file: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      const jsx = ts.isJsxText(node) || (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent));
      const text = (jsx ? decodeJsxEntities(node.text) : node.text).replace(/\s+/g, " ").trim();
      for (const char of text) if ((TEXT_GLYPHS as readonly string[]).includes(char)) out.push(`${file}|${char}|${text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  return out;
}

/** `left` minus `right`, counting repeats, so a recorded site cannot vouch for a copy of itself. */
function withoutEach(left: readonly string[], right: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const site of right) remaining.set(site, (remaining.get(site) ?? 0) + 1);
  return left.filter((site) => {
    const count = remaining.get(site) ?? 0;
    if (count > 0) remaining.set(site, count - 1);
    return count === 0;
  });
}

const identity = ([file, glyph, text]: readonly [string, string, string, string]) => `${file}|${glyph}|${text}`;

test("the text-glyph sites match the inventory exactly", () => {
  const found = sourceFiles(SRC).flatMap((path) =>
    textGlyphSites(readFileSync(path, "utf8"), path.slice(SRC.length).replace(/\\/g, "/")));
  const allowed = [...RECORDED, ...EXEMPT].map(identity);
  assert.deepEqual(withoutEach(found, allowed), [],
    "a text glyph stands in for an icon; use the icon docs/design-system.md §18 maps it to, from components/Icons.tsx. " +
    "Recording it here is not the fix.");
  assert.deepEqual(withoutEach(allowed, found), [],
    "a recorded site is gone. Good — remove its entry here in the same change so the inventory keeps matching the tree.");
});

test("every recorded site names its owning epic, and every exemption its reason", () => {
  for (const [file, glyph, text, owner] of [...RECORDED, ...EXEMPT]) {
    assert.ok((TEXT_GLYPHS as readonly string[]).includes(glyph), `${file}: ${glyph} is not a §18 text glyph`);
    assert.ok(text.includes(glyph), `${file}: "${text}" does not contain ${glyph}`);
    assert.ok(owner.trim().length > 0, `${file}: ${glyph} needs an owner or a reason`);
  }
});

test("the scanner sees glyphs in literals and JSX text, and ignores comments", () => {
  assert.deepEqual(textGlyphSites('const label = done ? "✓ Copied" : "Copy";', "a.ts"), ["a.ts|✓|✓ Copied"]);
  assert.deepEqual(textGlyphSites("const X = () => <span>▸</span>;", "a.tsx"), ["a.tsx|▸|▸"]);
  assert.deepEqual(textGlyphSites("const X = () => <button>&times;</button>;", "a.tsx"), ["a.tsx|×|×"]);
  assert.deepEqual(textGlyphSites("const X = () => <b title=\"&rarr; Next\" />;", "a.tsx"), ["a.tsx|→|→ Next"]);
  assert.deepEqual(textGlyphSites("const t = `${a} ← ${b}`;", "a.ts"), ["a.ts|←|←"]);
  assert.deepEqual(textGlyphSites('// "✓ Copied" was the old label\n/* ▸ */ const a = 1;', "a.ts"), []);
  assert.deepEqual(textGlyphSites("const X = () => <span>{/* ▸ */}</span>;", "a.tsx"), []);
  assert.deepEqual(textGlyphSites('const warn = "⚠";', "a.ts"), [], "emoji belong to the emoji inventory");
});
