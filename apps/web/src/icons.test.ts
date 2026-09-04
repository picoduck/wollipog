import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ICONS_PATH = join(SRC, "components/Icons.tsx");
const INVENTORY_PATH = join(ROOT, "docs/icon-system.md");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

function relativeSource(path: string): string {
  return path.slice(SRC.length).replace(/\\/g, "/");
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SVG_FACTORY_PATTERN = /\w+\(\s*["'`]svg["'`]/;
const SVG_TAG_ASSIGNMENT_PATTERN = /=\s*["'`]svg["'`]/;

function sourceSlice(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(start, -1, `missing source-slice start anchor: ${startAnchor}`);
  assert.notEqual(end, -1, `missing source-slice end anchor: ${endAnchor}`);
  assert.ok(end > start, `source-slice end anchor must follow start anchor: ${endAnchor}`);
  return source.slice(start, end);
}

// UsageChart draws DATA, not icons: its <svg> is a stacked-column chart whose geometry is computed
// from usage buckets, so there is no glyph to route through Icons.tsx.
const SVG_OWNERS = ["components/AgentIcon.tsx", "components/Icons.tsx", "components/UsageChart.tsx"];

test("the SVG ownership inventory covers every production SVG-owning file", () => {
  const actual = sourceFiles(SRC)
    .filter((path) => {
      const code = codeOnly(readFileSync(path, "utf8"));
      return /<svg[\s>]/.test(code)
        || SVG_FACTORY_PATTERN.test(code)
        || SVG_TAG_ASSIGNMENT_PATTERN.test(code);
    })
    .map(relativeSource)
    .sort();
  assert.deepEqual(actual, SVG_OWNERS);
});

test("SVG ownership patterns cover single, double, and template-literal delimiters", () => {
  for (const source of ['createElement("svg")', "createElement('svg')", "createElement(`svg`)"]) {
    assert.match(source, SVG_FACTORY_PATTERN);
  }
  for (const source of ['const Tag = "svg"', "const Tag = 'svg'", "const Tag = `svg`"]) {
    assert.match(source, SVG_TAG_ASSIGNMENT_PATTERN);
  }
  assert.doesNotMatch("createElement('div')", SVG_FACTORY_PATTERN);
  assert.doesNotMatch("const Tag = 'div'", SVG_TAG_ASSIGNMENT_PATTERN);
});

test("no production component draws or injects an icon outside an SVG owner", () => {
  const offenders: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const relative = relativeSource(path);
    if (SVG_OWNERS.includes(relative)) continue;
    const code = codeOnly(readFileSync(path, "utf8"));
    for (const [pattern, how] of [
      [/<svg[\s>]/, "<svg>"],
      [SVG_FACTORY_PATTERN, 'a factory call naming "svg"'],
      [/dangerouslySetInnerHTML/i, "dangerouslySetInnerHTML"],
      [SVG_TAG_ASSIGNMENT_PATTERN, 'a variable holding the "svg" tag name'],
      [/\bIconBase\b/, "the private custom-mark adapter"],
    ] as const) {
      if (pattern.test(code)) offenders.push(`${relative} (${how})`);
    }
  }
  assert.deepEqual(offenders, [],
    "export icon geometry through Icons.tsx instead of bypassing the ownership boundary");
});

test("production files cannot import Lucide outside Icons.tsx", () => {
  const offenders: string[] = [];
  const patterns = [
    /\bfrom\s*["']lucide-react(?:\/[^"']*)?["']/,
    /\bimport\s*["']lucide-react(?:\/[^"']*)?["']/,
    /\bimport\s*\(\s*["']lucide-react(?:\/[^"']*)?["']\s*\)/,
    /\brequire\s*\(\s*["']lucide-react(?:\/[^"']*)?["']\s*\)/,
  ];
  for (const path of sourceFiles(SRC)) {
    const relative = relativeSource(path);
    if (relative === "components/Icons.tsx") continue;
    const code = codeOnly(readFileSync(path, "utf8"));
    if (patterns.some((pattern) => pattern.test(code))) offenders.push(relative);
  }
  assert.deepEqual(offenders, [],
    "static imports, dynamic imports, and require() must all go through components/Icons.tsx");
});

test("every exported icon is inventoried and follows its documented ownership decision", () => {
  const source = readFileSync(ICONS_PATH, "utf8");
  const docs = readFileSync(INVENTORY_PATH, "utf8");
  const exported = [...source.matchAll(/export function (\w+)\(/g)].map((match) => match[1]!).sort();
  const rows = [...docs.matchAll(/^\| \`(\w+Icon)\` \| (Lucide|Custom Exception) \| \`([^\`]+)\` \|/gm)]
    .map((match) => ({ name: match[1]!, decision: match[2]!, mapping: match[3]! }));
  assert.deepEqual(rows.map((row) => row.name).sort(), exported,
    "docs/icon-system.md must inventory every stable icon export exactly once");

  const customExceptions = rows.filter((row) => row.decision === "Custom Exception").map((row) => row.name).sort();
  assert.deepEqual(customExceptions, [
    "CursorEditorIcon",
    "DevinDesktopIcon",
    "GitHubIcon",
    "VisualStudioCodeIcon",
    "ZedEditorIcon",
  ]);

  for (const row of rows) {
    const body = sourceSlice(source, `export function ${row.name}(`, "\n}");
    if (row.decision === "Lucide") {
      assert.match(body, new RegExp(`<LibraryIcon\\s+glyph=\\{Lucide${escapeRegExp(row.mapping)}\\}`),
        `${row.name} must render its documented Lucide ${row.mapping} mapping`);
    } else {
      assert.doesNotMatch(body, /<LibraryIcon/,
        `${row.name} is documented as custom and must not hide a library mapping`);
    }
  }
});

test("every exported icon uses an approved adapter or is the documented GitHub brand mark", () => {
  const source = readFileSync(ICONS_PATH, "utf8");
  const customAdapter = new Set([
    "CursorEditorIcon",
    "DevinDesktopIcon",
    "VisualStudioCodeIcon",
    "ZedEditorIcon",
  ]);
  const offenders: string[] = [];
  for (const match of source.matchAll(/export function (\w+)\(([\s\S]*?)\n\}/g)) {
    const [, name, body] = match;
    if (name === "GitHubIcon") {
      if (!/<svg/.test(body!)) offenders.push(name);
    } else if (customAdapter.has(name!)) {
      if (!/<IconBase/.test(body!)) offenders.push(name!);
    } else if (!/<LibraryIcon/.test(body!)) {
      offenders.push(name!);
    }
  }
  assert.deepEqual(offenders, []);
});

test("IconBase pins the rendering contract for custom product marks", () => {
  const source = readFileSync(ICONS_PATH, "utf8");
  const base = sourceSlice(source, "function IconBase(", "export function GridIcon");
  for (const [pattern, why] of [
    [/viewBox="0 0 24 24"/, "one coordinate system"],
    [/strokeWidth="1\.8"/, "the shared stroke weight"],
    [/strokeLinecap="round"/, "round line caps"],
    [/strokeLinejoin="round"/, "round line joins"],
    [/fill="none"/, "stroke rendering by default"],
    [/aria-hidden="true"/, "decorative accessibility"],
    [/focusable="false"/, "no phantom tab stop"],
    [/className=.*app-icon/, "the shared CSS class"],
  ] as const) {
    assert.match(base, pattern, `IconBase must preserve ${why}`);
  }
  assert.ok(base.indexOf("{...props}") > base.indexOf('fill="none"'),
    "deliberate caller overrides must follow adapter defaults");
});

test("LibraryIcon pins the rendering contract around Lucide glyphs", () => {
  const source = readFileSync(ICONS_PATH, "utf8");
  const base = sourceSlice(source, "function LibraryIcon(", "/** Shared rendering contract");
  for (const [pattern, why] of [
    [/size=\{size\}/, "the numeric size contract"],
    [/strokeWidth=\{1\.8\}/, "the shared stroke weight"],
    [/aria-hidden="true"/, "decorative accessibility"],
    [/focusable="false"/, "no phantom tab stop"],
    [/className=.*app-icon/, "the shared CSS class"],
  ] as const) {
    assert.match(base, pattern, `LibraryIcon must preserve ${why}`);
  }
  assert.ok(base.indexOf("{...props}") > base.indexOf('focusable="false"'),
    "deliberate caller overrides must follow adapter defaults");
});

test("nothing uses an ellipsis as a progress indicator", () => {
  const offenders: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/[?:]\s*"…"/g)) {
      offenders.push(`${relativeSource(path)}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "use <Spinner />, which animates and carries an accessible name");
});
