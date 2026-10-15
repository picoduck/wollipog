import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseAst, type Plugin } from "vite";
import { ENGINES, compareVersions, formatTarget, requiredFloor, type SupportMatrix } from "./css-support.js";
import { REGEX_SYNTAX, regexSyntax, type RegexSyntaxId } from "./regex-syntax.js";

/**
 * #3213 — the emitted JavaScript must run on the floor it was compiled for.
 *
 * A build target is not a validator. At `safari16.2` Rolldown turned every regex lookbehind into a
 * `RegExp("(?<=…)")` call and reported nothing, so the bundle — first-party code and `remark-gfm`
 * alike — threw at run time on the engines the floor named. This reads what the build actually
 * wrote and fails it instead.
 *
 * Covered: every regex literal, and every `RegExp(...)` / `new RegExp(...)` whose pattern is a
 * string literal, which is the form the compiler's own lowering produces. Not covered: a pattern
 * assembled at run time from variables, which no static read of the output can see.
 */

export interface RegexOccurrence {
  readonly pattern: string;
  readonly flags: string;
  /** Offset into the scanned code, for a line number in the failure. */
  readonly offset: number;
}

type Node = Record<string, unknown> & { type?: string; start?: number };

function staticString(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const value = node as Node;
  if (value.type === "Literal" && typeof value.value === "string") return value.value;
  if (value.type === "TemplateLiteral" && (value.expressions as unknown[]).length === 0) {
    const [quasi] = value.quasis as Array<{ value: { cooked: string | null } }>;
    return quasi?.value.cooked ?? undefined;
  }
  return undefined;
}

function isRegExpCallee(node: unknown): boolean {
  const callee = node as Node;
  if (callee.type === "Identifier") return callee.name === "RegExp";
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  const object = callee.object as Node;
  const property = callee.property as Node;
  return object.type === "Identifier" && ["globalThis", "window", "self"].includes(object.name as string)
    && property.type === "Identifier" && property.name === "RegExp";
}

/** Every regex in `code` whose pattern is fixed at build time. */
export function regexesIn(code: string): RegexOccurrence[] {
  const found: RegexOccurrence[] = [];
  // Iterative: minified output nests deeply enough that recursion is a needless risk.
  const stack: unknown[] = [parseAst(code)];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item)) {
      stack.push(...item);
      continue;
    }
    const node = item as Node;
    const regex = node.regex as { pattern: string; flags: string } | undefined;
    if (node.type === "Literal" && regex) {
      found.push({ pattern: regex.pattern, flags: regex.flags, offset: node.start ?? 0 });
    } else if ((node.type === "CallExpression" || node.type === "NewExpression") && isRegExpCallee(node.callee)) {
      const [source, flags] = node.arguments as unknown[];
      const pattern = staticString(source);
      if (pattern !== undefined) found.push({ pattern, flags: staticString(flags) ?? "", offset: node.start ?? 0 });
    }
    for (const key in node) if (key !== "type" && typeof node[key] === "object") stack.push(node[key]);
  }
  return found;
}

function exceeds(support: SupportMatrix, floor: SupportMatrix): boolean {
  return ENGINES.some((engine) => compareVersions(support[engine], floor[engine]) > 0);
}

function targets(matrix: SupportMatrix): string {
  return ENGINES.map((engine) => formatTarget(engine, matrix[engine])).join(", ");
}

/**
 * What a single pattern needs that `floor` lacks: one phrase per feature above it or syntax the
 * scanner cannot classify. Empty when the floor runs it.
 */
export function aboveFloor(pattern: string, flags: string, floor: SupportMatrix = requiredFloor()): string[] {
  const report = regexSyntax(pattern, flags);
  const problems: string[] = [];
  for (const id of report.features) {
    const { support } = REGEX_SYNTAX[id];
    if (exceeds(support, floor)) problems.push(`${id}, which needs ${targets(support)}; the floor is ${targets(floor)}`);
  }
  for (const syntax of report.unknown) problems.push(`${syntax}, which regex-syntax.ts cannot classify`);
  return problems;
}

export interface FloorScan {
  /** Every regex feature the code uses, within the floor or not. */
  readonly features: ReadonlySet<RegexSyntaxId>;
  /** One line per regex the floor cannot run, ready to print. */
  readonly violations: readonly string[];
}

/** Checks one emitted file against the floor. */
export function scanForFloor(file: string, code: string, floor: SupportMatrix = requiredFloor()): FloorScan {
  const features = new Set<RegexSyntaxId>();
  const violations: string[] = [];
  let occurrences: RegexOccurrence[];
  try {
    occurrences = regexesIn(code);
  } catch (error) {
    // Unreadable output is not output that passed.
    throw new Error(`${file} could not be parsed to check its regex syntax: ${String((error as Error).message)}`);
  }
  for (const { pattern, flags, offset } of occurrences) {
    for (const id of regexSyntax(pattern, flags).features) features.add(id);
    const problems = aboveFloor(pattern, flags, floor);
    if (problems.length === 0) continue;
    const before = code.slice(0, offset).split("\n");
    const where = `${file}:${before.length}:${before.at(-1)!.length + 1}`;
    const shown = `/${pattern.length > 60 ? `${pattern.slice(0, 60)}…` : pattern}/${flags}`;
    for (const problem of problems) violations.push(`${where}: ${shown} uses ${problem}.`);
  }
  return { features, violations };
}

/** What to do about a violation, said once after the list. */
export const FLOOR_ADVICE = "Remove the syntax, or register it in JS_FEATURES (css-support.ts) so the "
  + "floor rises to cover it. Shipping it anyway moves the SyntaxError from the build to the user's browser.";

async function javascriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Scans a written build directory, including files copied verbatim from `public/`. */
export async function scanBuildOutput(outDir: string, floor: SupportMatrix = requiredFloor()): Promise<FloorScan> {
  const features = new Set<RegexSyntaxId>();
  const violations: string[] = [];
  for (const path of await javascriptFiles(outDir)) {
    const scan = scanForFloor(relative(outDir, path), await readFile(path, "utf8"), floor);
    for (const id of scan.features) features.add(id);
    violations.push(...scan.violations);
  }
  return { features, violations };
}

/** Runs on every build: browser, desktop, same-origin watch, and the e2e fixtures. */
export function jsFloorGuard(floor: SupportMatrix = requiredFloor()): Plugin {
  let publicDir = "";
  let copiesPublicDir = true;
  return {
    name: "wollipog-js-floor",
    apply: "build",
    configResolved(config) {
      publicDir = config.publicDir;
      copiesPublicDir = config.build.copyPublicDir;
    },
    // After Vite's preload analysis has rewritten chunk code, so this is the code that ships.
    generateBundle: { order: "post", async handler(_options, bundle) {
      const violations: string[] = [];
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk") violations.push(...scanForFloor(item.fileName, item.code, floor).violations);
        else if (/\.m?js$/.test(item.fileName)) {
          violations.push(...scanForFloor(item.fileName, String(item.source), floor).violations);
        }
      }
      // `public/` is copied around the bundle, so sw.js would otherwise never be read.
      if (publicDir && copiesPublicDir) {
        for (const path of await javascriptFiles(publicDir)) {
          violations.push(...scanForFloor(relative(publicDir, path), await readFile(path, "utf8"), floor).violations);
        }
      }
      if (violations.length > 0) {
        this.error(`The emitted JavaScript needs more than its compilation floor:\n${violations.join("\n")}\n${FLOOR_ADVICE}`);
      }
    } },
  };
}
