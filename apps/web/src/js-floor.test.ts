import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { build, type Plugin } from "vite";
import { JS_FEATURES, requiredFloor, type SupportMatrix } from "./css-support.js";
import { aboveFloor, jsFloorGuard, regexesIn, scanBuildOutput, scanForFloor } from "./js-floor.js";
import { regexSyntax } from "./regex-syntax.js";
import { WOLLIPOG_WEBVIEW_TARGETS } from "../vite.config.js";

/**
 * #3213: the bundle was compiled for Safari 16.2 and shipped regex lookbehind, which Safari parses
 * from 16.4. The compiler turned each one into a `RegExp(...)` call without a word, so the build
 * passed and the shared entry chunk threw on load in exactly the engines the floor named.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
/** The floor the bundle used to declare, kept to prove the checks fail where the bug lived. */
const SAFARI_16_2: SupportMatrix = { ...requiredFloor(), safari: [16, 2] };
const TARGETS_16_2 = WOLLIPOG_WEBVIEW_TARGETS.map((target) => target.startsWith("safari") ? "safari16.2" : target);

function features(pattern: string, flags = ""): string[] {
  return [...regexSyntax(pattern, flags).features].sort();
}

test("lookbehind is syntax only outside classes and escapes", () => {
  assert.deepEqual(features("(?<=a)b"), ["regex lookbehind"]);
  assert.deepEqual(features("(?<!a)b"), ["regex lookbehind"]);
  assert.deepEqual(features("[(?<=]"), [], "inside a class those are four literal characters");
  assert.deepEqual(features("\\(?<=a"), [], "an escaped parenthesis opens no group");
  assert.deepEqual(features("\\\\(?<=a)"), ["regex lookbehind"], "an escaped backslash does not escape the group");
  assert.deepEqual(features("[\\]](?<=a)"), ["regex lookbehind"], "an escaped bracket does not end the class");
  assert.deepEqual(features("(?:a)(?=b)(?!c)"), [], "lookahead and plain groups are ES3");
});

test("named groups, duplicates, modifiers and flags are each named", () => {
  assert.deepEqual(features("(?<year>\\d+)"), ["regex named groups"]);
  assert.deepEqual(features("(?<y>a)|(?<y>b)"), ["regex duplicate named groups", "regex named groups"]);
  assert.deepEqual(features("(?i:a)(?-m:b)(?s-i:c)"), ["regex modifiers"]);
  assert.deepEqual(features("a", "gimuy"), [], "ES2015 flags need nothing");
  assert.deepEqual(features("a", "dsv"), ["regex d flag", "regex s flag", "regex v flag"]);
  // Only `v` nests classes: there `[[(?<=]]` is still one class, elsewhere its second `]` closes nothing.
  assert.deepEqual(features("[[(?<=]](?<=a)", "v"), ["regex lookbehind", "regex v flag"]);
});

test("syntax the scanner cannot classify is reported, never passed as nothing", () => {
  // A closed scanner, like CSS_SURFACE: whatever regex syntax is invented next fails the check
  // until someone classifies it, instead of slipping through as "no features found".
  assert.deepEqual(regexSyntax("(?|a)", "").unknown, ['group opener "(?|a)"']);
  assert.deepEqual(regexSyntax("a", "gq").unknown, ['flag "q"']);
  assert.deepEqual(aboveFloor("a", "q"), ['flag "q", which regex-syntax.ts cannot classify']);
});

test("the floor decides, per engine", () => {
  assert.deepEqual(aboveFloor("(?<=a)b", ""), [], "lookbehind is within the computed floor");
  assert.match(aboveFloor("(?<=a)b", "", SAFARI_16_2).join(), /regex lookbehind, which needs .*safari16\.4; the floor is .*safari16\.2/);
  assert.match(aboveFloor("[\\p{L}--a]", "v").join(), /regex v flag, which needs .*safari17/,
    "the v flag is above the floor until JS_FEATURES registers it");
});

test("regexes are read from literals and literal RegExp arguments, not from strings", () => {
  const code = [
    "const a = /(?<=x)y/g;",
    'const b = RegExp("(?<!p)q", "u");',
    "const c = new RegExp(`(?<k>v)`);",
    'const d = new globalThis.RegExp("plain");',
    'const e = "(?<=just a string)";',
    "const f = new RegExp(source, flags);",
  ].join("\n");
  assert.deepEqual(regexesIn(code).map(({ pattern, flags }) => [pattern, flags]).sort(), [
    ["(?<!p)q", "u"], ["(?<=x)y", "g"], ["(?<k>v)", ""], ["plain", ""],
  ]);
  const scan = scanForFloor("x.js", code, SAFARI_16_2);
  assert.equal(scan.violations.length, 2);
  assert.match(scan.violations[0]!, /^x\.js:\d+:\d+: \/\(\?<[=!]/);
  assert.throws(() => scanForFloor("broken.js", "const = ;"), /^Error: broken\.js could not be parsed/,
    "output the scanner cannot read must fail the check, never pass it");
});

const LOWERED_LOOKBEHIND = "virtual:lowered-lookbehind";
function lookbehindEntry(): Plugin {
  return {
    name: "lookbehind-entry",
    resolveId: (id) => id === LOWERED_LOOKBEHIND ? `\0${id}` : undefined,
    load: (id) => id === `\0${LOWERED_LOOKBEHIND}`
      ? "globalThis.split = (text) => text.split(/(?<=[/._])/);"
      : undefined,
  };
}

async function buildEntry(target: string[], guard: Plugin, publicDir: string | false = false): Promise<void> {
  await build({
    root: WEB,
    configFile: false,
    logLevel: "silent",
    publicDir,
    build: { write: false, minify: true, target, rolldownOptions: { input: LOWERED_LOOKBEHIND } },
    plugins: [lookbehindEntry(), guard],
  });
}

test("the build fails when the compiler lowers lookbehind instead of shipping it", { timeout: 120_000 }, async () => {
  // The exact shape of the bug: at safari16.2 this compiles to `RegExp("(?<=[/._])")` and
  // previously passed in silence.
  await assert.rejects(buildEntry(TARGETS_16_2, jsFloorGuard(SAFARI_16_2)),
    /needs more than its compilation floor[\s\S]*regex lookbehind[\s\S]*JS_FEATURES/);
  await buildEntry(WOLLIPOG_WEBVIEW_TARGETS, jsFloorGuard());
});

test("files copied from public/ are held to the floor as well", { timeout: 120_000 }, async () => {
  // sw.js never passes through the bundler, so scanning chunks alone would never read it.
  const publicDir = mkdtempSync(join(tmpdir(), "wollipog-js-floor-public-"));
  try {
    writeFileSync(join(publicDir, "sw.js"), "self.match = /(?<y>a)|(?<y>b)/;\n");
    await assert.rejects(buildEntry(WOLLIPOG_WEBVIEW_TARGETS, jsFloorGuard(), publicDir),
      /sw\.js:1:\d+: .* uses regex duplicate named groups/);
  } finally {
    rmSync(publicDir, { recursive: true, force: true });
  }
});

/**
 * Evaluates the chunks `index.html` modulepreloads — the shared entry graph — with `RegExp`
 * replaced by one that rejects syntax above `floor`, as such an engine does. Literals are checked
 * statically by the guard; this catches what the guard cannot see, a pattern built at module scope.
 */
async function evaluateEntryChunks(out: string, floor: SupportMatrix): Promise<string[]> {
  const html = readFileSync(join(out, "index.html"), "utf8");
  const files = [...html.matchAll(/rel="modulepreload"[^>]*href="\/([^"]+)"/g)].map((match) => match[1]!);
  assert.ok(files.some((file) => /^assets\/common-/.test(file)), "the shared common chunk must be among them");
  const Native = globalThis.RegExp;
  const check = ([source, flags]: unknown[]) => {
    const pattern = source instanceof Native ? source.source : String(source);
    const flagText = flags === undefined ? source instanceof Native ? source.flags : "" : String(flags);
    const problems = aboveFloor(pattern, flagText, floor);
    if (problems.length > 0) throw new SyntaxError(`Invalid regular expression: /${pattern}/: ${problems.join("; ")}`);
  };
  globalThis.RegExp = new Proxy(Native, {
    construct(target, args, newTarget) {
      check(args);
      return Reflect.construct(target, args, newTarget) as object;
    },
    apply(target, thisArg, args) {
      check(args);
      return Reflect.apply(target, thisArg, args) as unknown;
    },
  });
  const failures: string[] = [];
  try {
    for (const file of files) {
      await import(pathToFileURL(join(out, file)).href)
        .catch((error: unknown) => failures.push(`${file}: ${String((error as Error).message)}`));
    }
  } finally {
    globalThis.RegExp = Native;
  }
  return failures;
}

test("the shipped bundle needs nothing above its floor, and loads on an engine at it", { timeout: 300_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), "wollipog-js-floor-app-"));
  try {
    await build({ root: WEB, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
    const scan = await scanBuildOutput(out);
    assert.deepEqual(scan.violations, []);
    for (const feature of JS_FEATURES) {
      assert.ok(scan.features.has(feature.id),
        `${feature.id} is in JS_FEATURES but the build no longer contains it. Remove it — a feature `
        + "the bundle does not use must not hold the browser floor up.");
    }
    assert.deepEqual(await evaluateEntryChunks(out, requiredFloor()), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("at the old floor the same checks catch the shipped bug", { timeout: 300_000 }, async () => {
  // The control: compile the real app for safari16.2 as main did, without the guard, and both the
  // static scan and the floor engine must fail — the latter at module scope in the shared chunk,
  // which is what kept the app from starting.
  const out = mkdtempSync(join(tmpdir(), "wollipog-js-floor-old-"));
  try {
    await build({
      root: WEB,
      configFile: false,
      logLevel: "silent",
      plugins: [react()],
      build: { outDir: out, emptyOutDir: true, target: TARGETS_16_2, cssTarget: TARGETS_16_2 },
    });
    const scan = await scanBuildOutput(out, SAFARI_16_2);
    assert.ok(scan.violations.some((line) => /^assets\/common-.* uses regex lookbehind/.test(line)),
      "the static scan must see the lowered lookbehind in the shared chunk");
    const failures = await evaluateEntryChunks(out, SAFARI_16_2);
    assert.match(failures[0] ?? "", /^assets\/common-[^:]+: Invalid regular expression: .*regex lookbehind/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
