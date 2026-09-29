import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
// ContextWindowMeter's ring is a data mark too: a progress arc whose length is the session's
// context fill, not a glyph.
const SVG_OWNERS = ["components/AgentIcon.tsx", "components/ContextWindowMeter.tsx", "components/Icons.tsx", "components/UsageChart.tsx"];

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

/**
 * Exports that may render another export's glyph, each with the export it duplicates. A shared glyph
 * reads as a shared meaning (docs/design-system.md §18), so this list only ever shrinks.
 */
const SHARED_GLYPHS: Readonly<Record<string, string>> = {
  // The rail's archived destination, filled; #1958 replaces it, and whichever of #1958 and #1955
  // lands second deletes the export.
  FolderSolidIcon: "FolderIcon",
};

test("no two icon exports render the same Lucide glyph except the documented exceptions", () => {
  const docs = readFileSync(INVENTORY_PATH, "utf8");
  const byGlyph = new Map<string, string[]>();
  for (const match of docs.matchAll(/^\| `(\w+Icon)` \| Lucide \| `([^`]+)` \|/gm)) {
    byGlyph.set(match[2]!, [...(byGlyph.get(match[2]!) ?? []), match[1]!]);
  }
  const shared = [...byGlyph].filter(([, names]) => names.length > 1)
    .flatMap(([, names]) => names.slice(1).map((name) => `${name} → ${names[0]}`)).sort();
  assert.deepEqual(shared, Object.entries(SHARED_GLYPHS).map(([name, of]) => `${name} → ${of}`).sort(),
    "give each meaning its own glyph, or delete the alias and use the existing export");
});

test("the retired icon aliases stay deleted", () => {
  const source = readFileSync(ICONS_PATH, "utf8");
  for (const name of ["WarningTriangleIcon", "GearIcon", "FolderOutlineIcon"]) {
    assert.doesNotMatch(source, new RegExp(`export function ${name}\\(`), `${name} was merged into one export per meaning`);
  }
});

/**
 * Components whose `size` is not an interface icon size: product and vendor marks keep their own
 * geometry, and the rail's glyph size belongs to the App Shell rail unit (#1958).
 */
const SIZE_EXEMPT_TAGS = new Set(["AgentIcon", "CursorEditorIcon", "DevinDesktopIcon", "GitHubIcon", "VisualStudioCodeIcon", "ZedEditorIcon"]);
const SIZE_EXEMPT_FILES = new Set(["components/Rail.tsx"]);

/** Every `<…Icon size={N}>` whose literal N is off the §18 scale, as `file:line <Tag size={N}>`. */
export function offScaleIconSizes(source: string, file: string): string[] {
  const out: string[] = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /Icon$/.test(node.tagName.getText())
      && !SIZE_EXEMPT_TAGS.has(node.tagName.getText())) {
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== "size" || !attribute.initializer) continue;
        const literals: number[] = [];
        const collect = (child: ts.Node): void => {
          if (ts.isNumericLiteral(child)) literals.push(Number(child.text));
          ts.forEachChild(child, collect);
        };
        collect(attribute.initializer);
        for (const size of literals.filter((value) => ![14, 16, 20, 24].includes(value))) {
          const line = sourceFile.getLineAndCharacterOfPosition(attribute.getStart()).line + 1;
          out.push(`${file}:${line} <${node.tagName.getText()} size={${size}}>`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

test("no production component passes an icon a literal size off the 14, 16, 20 and 24 scale", () => {
  const offenders = sourceFiles(SRC)
    .filter((path) => path.endsWith(".tsx") && !SIZE_EXEMPT_FILES.has(relativeSource(path)) && !relativeSource(path).startsWith("e2e/"))
    .flatMap((path) => offScaleIconSizes(readFileSync(path, "utf8"), relativeSource(path)));
  assert.deepEqual(offenders, [], "use the nearest size on the scale: 14 beside small text, 16 by default, 20 for prominent toolbar icons");
});

test("the off-scale size scan reads literals, ternaries and wrapper icons, and skips brand marks", () => {
  assert.deepEqual(offScaleIconSizes("<GridIcon size={15} />", "a.tsx"), ["a.tsx:1 <GridIcon size={15}>"]);
  assert.deepEqual(offScaleIconSizes("<Icon size={compact ? 13 : 16} />", "a.tsx"), ["a.tsx:1 <Icon size={13}>"]);
  assert.deepEqual(offScaleIconSizes("<DestinationIcon destination={d} size={18}></DestinationIcon>", "a.tsx"),
    ["a.tsx:1 <DestinationIcon size={18}>"]);
  assert.deepEqual(offScaleIconSizes("<GridIcon size={16} /><AgentIcon driver={d} size={13} /><QRCodeSVG size={208} />", "a.tsx"), []);
});

test("the documented icon bundle ceiling matches the contract and no measured figure can drift", () => {
  const docs = readFileSync(INVENTORY_PATH, "utf8");
  const contract = readFileSync(join(SRC, "../scripts/verify-icon-bundle.mjs"), "utf8");
  const documented = docs.match(/([\d,]+)-byte ceiling/)?.[1]?.replace(/,/g, "");
  const enforced = contract.match(/bytes < ([\d_]+),/)?.[1]?.replace(/_/g, "");
  assert.ok(enforced, "verify-icon-bundle.mjs must enforce a byte ceiling");
  assert.equal(documented, enforced, "docs/icon-system.md must state the ceiling the contract enforces");
  assert.doesNotMatch(docs, /currently reports|bytes across \d+ exports/,
    "record the live icon bundle size only in the contract output, never as a literal that goes stale");
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
