/**
 * The regular-expression syntax the shipped JavaScript may contain, and a scanner that finds it
 * (#3213).
 *
 * `css-support.ts` computes the browser floor from what the stylesheet needs, and the JS output
 * shares that floor. For most JavaScript that is safe: the compiler lowers what the floor cannot
 * run. Regular expressions are the exception. Rolldown cannot rewrite `(?<=…)` into anything an
 * older engine accepts, so at a floor below its support it turns the literal into a
 * `RegExp("(?<=…)")` constructor call — the build passes, says nothing, and the `SyntaxError` moves
 * to run time. That is how a Safari 16.2 floor shipped lookbehind from first-party code and from
 * `remark-gfm` alike, and the app failed to start on the engines the floor promised.
 *
 * So the check reads the BUILD OUTPUT, dependencies included, not the source: `js-floor.ts` feeds
 * every regex literal and literal `RegExp(...)` argument through `regexSyntax()` below and fails the
 * build when one needs more than the computed floor.
 *
 * As with `CSS_SURFACE`, the scanner is closed rather than open: a group opener or flag it does not
 * recognise is reported as unknown and fails the check, so syntax invented after this file was
 * written cannot slip through as "nothing found".
 */

import type { SupportMatrix } from "./css-support.js";

/** Regex syntax newer than ES2015 that an engine may reject outright. */
export interface RegexSyntaxFeature {
  /** Stable id, also the name used in failure messages and in `JS_FEATURES`. */
  readonly id: RegexSyntaxId;
  /** First version of each engine that parses it. */
  readonly support: SupportMatrix;
  /** Where the support data came from, so a reviewer can re-check it rather than trust it. */
  readonly source: string;
}

export type RegexSyntaxId =
  | "regex lookbehind"
  | "regex named groups"
  | "regex duplicate named groups"
  | "regex modifiers"
  | "regex s flag"
  | "regex d flag"
  | "regex v flag";

const BCD = "MDN browser-compat-data (javascript.regular_expressions / javascript.builtins.RegExp), "
  + "retrieved 2026-10-14";

/**
 * Every construct the scanner can name. Entries at or below the computed floor are allowed; an entry
 * above it fails the check until it is either removed from the bundle or registered in
 * `JS_FEATURES`, which raises the floor to it.
 *
 * Edge rows are Chromium Edge, whose first release (79) postdates the Chrome version for older
 * features.
 */
export const REGEX_SYNTAX: Readonly<Record<RegexSyntaxId, RegexSyntaxFeature>> = {
  "regex lookbehind": {
    id: "regex lookbehind",
    support: { chrome: [62, 0], edge: [79, 0], firefox: [78, 0], safari: [16, 4] },
    source: BCD,
  },
  "regex named groups": {
    id: "regex named groups",
    support: { chrome: [64, 0], edge: [79, 0], firefox: [78, 0], safari: [11, 1] },
    source: BCD,
  },
  "regex duplicate named groups": {
    id: "regex duplicate named groups",
    support: { chrome: [125, 0], edge: [125, 0], firefox: [129, 0], safari: [17, 0] },
    source: BCD,
  },
  "regex modifiers": {
    id: "regex modifiers",
    support: { chrome: [125, 0], edge: [125, 0], firefox: [132, 0], safari: [26, 0] },
    source: BCD,
  },
  "regex s flag": {
    id: "regex s flag",
    support: { chrome: [62, 0], edge: [79, 0], firefox: [78, 0], safari: [11, 1] },
    source: BCD,
  },
  "regex d flag": {
    id: "regex d flag",
    support: { chrome: [90, 0], edge: [90, 0], firefox: [88, 0], safari: [15, 0] },
    source: BCD,
  },
  "regex v flag": {
    id: "regex v flag",
    support: { chrome: [112, 0], edge: [112, 0], firefox: [116, 0], safari: [17, 0] },
    source: BCD,
  },
};

/** ES2015 flags, which every engine at any plausible floor parses. */
const BASE_FLAGS = new Set(["g", "i", "m", "u", "y"]);
const FLAG_FEATURES: Readonly<Record<string, RegexSyntaxId>> = {
  s: "regex s flag",
  d: "regex d flag",
  v: "regex v flag",
};

export interface RegexSyntaxReport {
  readonly features: ReadonlySet<RegexSyntaxId>;
  /** Syntax the scanner cannot classify. Each one fails the check rather than passing as unseen. */
  readonly unknown: readonly string[];
}

/**
 * What one pattern needs from the engine.
 *
 * A tokenizer, not a regex over the source: `[(?<=]` is a character class holding four literal
 * characters, and `\(?<=` is an escaped parenthesis followed by literals. Only a group opener outside
 * a class and not escaped is syntax.
 */
export function regexSyntax(pattern: string, flags: string): RegexSyntaxReport {
  const features = new Set<RegexSyntaxId>();
  const unknown: string[] = [];
  for (const flag of flags) {
    const feature = FLAG_FEATURES[flag];
    if (feature) features.add(feature);
    else if (!BASE_FLAGS.has(flag)) unknown.push(`flag ${JSON.stringify(flag)}`);
  }
  // Only `v` lets classes nest; elsewhere `[` inside a class is a literal bracket.
  const nestedClasses = flags.includes("v");
  const groupNames = new Set<string>();
  let classDepth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (classDepth > 0) {
      if (char === "]") classDepth -= 1;
      else if (char === "[" && nestedClasses) classDepth += 1;
      continue;
    }
    if (char === "[") {
      classDepth = 1;
      continue;
    }
    if (char !== "(" || pattern[index + 1] !== "?") continue;
    const rest = pattern.slice(index + 2);
    if (rest.startsWith(":") || rest.startsWith("=") || rest.startsWith("!")) continue;
    if (rest.startsWith("<=") || rest.startsWith("<!")) {
      features.add("regex lookbehind");
      continue;
    }
    const named = /^<([^>]+)>/.exec(rest);
    if (named) {
      features.add("regex named groups");
      if (groupNames.has(named[1]!)) features.add("regex duplicate named groups");
      groupNames.add(named[1]!);
      continue;
    }
    if (/^[a-z]*(?:-[a-z]*)?:/i.test(rest)) {
      features.add("regex modifiers");
      continue;
    }
    unknown.push(`group opener ${JSON.stringify(`(?${rest.slice(0, 3)}`)}`);
  }
  return { features, unknown };
}
