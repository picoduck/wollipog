import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Declaration, type Node, type Rule } from "postcss";

/**
 * Keyboard focus that survives forced colors (#1890).
 *
 * Forced colors (Windows contrast themes) repaints author colours with system colours, forces every
 * background to Canvas and drops `box-shadow` outright. A rule that removes an element's outline and
 * shows focus with a fill or a shadow instead therefore shows nothing at all in a contrast theme: the
 * Resize Panel separator did exactly that, and its focused and unfocused pixels were identical.
 *
 * What forced colors keeps is the SHAPE of an outline, a border or an SVG stroke, repainted in a
 * system colour. So every rule that takes the outline off its own focused element must put one of
 * those back: in the same rule, or in a rule that reaches the same focused element and paints a
 * child, a pseudo-element or an ancestor's `:has()` ring. A border-colour change alone does not
 * count, because forced colors paints every border the same system colour.
 *
 * A transparent outline is the idiomatic answer and is not a removal: it paints nothing normally,
 * and forced colors repaints its colour.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(WEB, "src/styles.css"), "utf8");

/**
 * Rules that remove the outline with no forced-colors-safe replacement, on purpose. Each entry must
 * say why focus stays visible without one; a stale entry fails the inventory test below.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [".ws-create-name:focus", "a text input: the caret marks focus, and forced colors keeps it"],
  [".shell-search:focus", "a text input: the caret marks focus, and forced colors keeps it"],
  [".shell-input:focus", "a text input: the caret marks focus, and forced colors keeps it"],
  [".agent-session-agent-step:focus", "a tabIndex={-1} programmatic focus target, not a keyboard stop"],
  [".agent-session-results-step:focus", "a tabIndex={-1} programmatic focus target, not a keyboard stop"],
]);

/** Split a selector list without treating commas inside :is(), :has(), attributes or strings as members. */
export function selectorMembers(selectorList: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of selectorList) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      members.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  members.push(current);
  return members.map((member) => member.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/**
 * The compound a member styles when that compound is itself focused: `.a:focus-visible` in
 * `.b .a:focus-visible`. Null when the subject is not the focused element — a child of it, a
 * pseudo-element, or `:focus-within`, which matches an ancestor of focus and removes no ring from it.
 */
export function focusedSubject(member: string): string | null {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < member.length; index += 1) {
    const ch = member[index]!;
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (depth === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~")) start = index + 1;
  }
  const subject = member.slice(start).trim();
  if (subject.includes("::")) return null;
  const topLevel = subject.replace(/\([^()]*\)/g, "()");
  return /:focus(?:-visible)?(?![\w-])/.test(topLevel) ? subject : null;
}

const OUTLINE_STYLES = /\b(auto|solid|dashed|dotted|double|groove|ridge|inset|outset)\b/;

/** Does this declaration list leave its element without an outline? Later declarations win. */
export function removesOutline(decls: readonly Pick<Declaration, "prop" | "value">[]): boolean {
  let removed: boolean | null = null;
  for (const { prop, value } of decls) {
    const v = value.trim().toLowerCase();
    if (prop === "outline") removed = /\bnone\b/.test(v) || /^0[a-z]*$/.test(v) || !OUTLINE_STYLES.test(v);
    else if (prop === "outline-style") removed = v === "none";
    else if (prop === "outline-width") removed = /^0[a-z]*$/.test(v);
  }
  return removed === true;
}

/** Does this declaration list paint something forced colors keeps — an outline, a border or a stroke? */
export function paintsForcedColorsIndicator(decls: readonly Pick<Declaration, "prop" | "value">[]): boolean {
  if (decls.some(({ prop }) => prop.startsWith("outline")) && !removesOutline(decls)) return true;
  return decls.some(({ prop, value }) => {
    const v = value.trim().toLowerCase();
    if (/^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/.test(prop)) return !/\bnone\b|^0[a-z]*$/.test(v);
    if (/^border(-.*)?-style$/.test(prop)) return v !== "none" && v !== "hidden";
    return prop === "stroke" && v !== "none";
  });
}

interface FocusRule { member: string; subject: string; context: string; decls: Declaration[] }
interface AnyRule { members: string[]; context: string; decls: Declaration[] }

function contextOf(rule: Rule): string {
  const parts: string[] = [];
  for (let node: Node | undefined = rule.parent; node; node = node.parent) {
    if (node.type === "atrule") parts.unshift(`@${(node as AtRule).name} ${(node as AtRule).params}`);
  }
  return parts.join(" ");
}

function collect(source: string): AnyRule[] {
  const rules: AnyRule[] = [];
  postcss.parse(source).walkRules((rule) => {
    const decls = rule.nodes.filter((node): node is Declaration => node.type === "decl");
    rules.push({ members: selectorMembers(rule.selector), context: contextOf(rule), decls });
  });
  return rules;
}

const FORCED_COLORS = /forced-colors\s*:\s*active/;

/**
 * A replacement counts when it applies wherever the removal does: unconditionally, under the same
 * conditions, or only in forced colors, which is exactly where the removal would otherwise bite.
 */
function contextCovers(replacement: string, removal: string): boolean {
  return replacement === "" || replacement === removal || FORCED_COLORS.test(replacement);
}

/**
 * A rule for the very same selector would fight the removal on source order, so it counts only
 * from a forced-colors block. A child, pseudo-element or `:has()` ring does not compete with it.
 */
function reachesFocus(member: string, removal: FocusRule, context: string): boolean {
  return member === removal.member ? FORCED_COLORS.test(context) : member.includes(removal.subject);
}

/** Every focus rule that removes its element's outline and puts nothing forced colors keeps back. */
export function focusLostInForcedColors(source: string): string[] {
  const rules = collect(source);
  const removals: FocusRule[] = [];
  for (const rule of rules) {
    if (!removesOutline(rule.decls)) continue;
    for (const member of rule.members) {
      const subject = focusedSubject(member);
      if (subject) removals.push({ member, subject, context: rule.context, decls: rule.decls });
    }
  }
  const lost = removals.filter((removal) => {
    if (paintsForcedColorsIndicator(removal.decls)) return false;
    return !rules.some((rule) =>
      contextCovers(rule.context, removal.context) &&
      rule.members.some((member) => reachesFocus(member, removal, rule.context)) &&
      paintsForcedColorsIndicator(rule.decls));
  });
  return [...new Set(lost.map((removal) => removal.member))].sort();
}

test("every focus rule that removes the outline leaves an indicator forced colors keeps", () => {
  const unexplained = focusLostInForcedColors(css).filter((member) => !EXEMPT.has(member));
  assert.deepEqual(unexplained, [],
    "these rules remove the focus outline and show focus only with a background, a shadow or a border colour, " +
    "all of which forced colors discards; use `outline: 2px solid transparent` (or a border or stroke) instead of `outline: none`");
});

test("every exemption still names a rule that loses focus in forced colors", () => {
  const lost = new Set(focusLostInForcedColors(css));
  assert.deepEqual([...EXEMPT.keys()].filter((member) => !lost.has(member)), []);
});

test("focusLostInForcedColors flags fills and shadows and accepts shapes", () => {
  const check = (source: string) => focusLostInForcedColors(source);
  assert.deepEqual(check(".r:focus-visible { background: red; outline: none; }"), [".r:focus-visible"]);
  assert.deepEqual(check(".r:hover, .r:focus-visible { background: red; outline: none; }"), [".r:focus-visible"]);
  assert.deepEqual(check(".r:focus-visible { outline: 0; box-shadow: 0 0 0 2px red; }"), [".r:focus-visible"]);
  assert.deepEqual(check(".r:focus { outline-style: none; border-color: red; }"), [".r:focus"]);
  assert.deepEqual(check(".r:focus-visible { outline-width: 0; }"), [".r:focus-visible"]);
  assert.deepEqual(check(".r:focus-visible { background: red; outline: 2px solid transparent; }"), []);
  assert.deepEqual(check(".r:focus-visible { outline: none; outline: 2px solid transparent; }"), []);
  assert.deepEqual(check(".r:focus-visible { outline: none; stroke: red; }"), []);
  assert.deepEqual(check(".r:focus-visible { outline: none; border: 2px solid red; }"), []);
  assert.deepEqual(check(".r:focus-visible { outline: none; } .r:focus-visible > span { outline: 2px solid red; }"), []);
  assert.deepEqual(check(".r:focus-visible { outline: none; } .p:has(> .r:focus-visible)::after { border: 2px solid red; }"), []);
  assert.deepEqual(check(".r:focus-visible { outline: none; } .r:focus-visible > span { background: red; }"), [".r:focus-visible"]);
});

test("focusLostInForcedColors keeps a replacement to the conditions it applies under", () => {
  const removal = "@media (max-width: 1px) { .r:focus-visible { outline: none; } }";
  assert.deepEqual(focusLostInForcedColors(`${removal} @media (min-width: 2px) { .r:focus-visible > i { outline: 2px solid; } }`),
    [".r:focus-visible"]);
  assert.deepEqual(focusLostInForcedColors(`${removal} @media (max-width: 1px) { .r:focus-visible > i { outline: 2px solid; } }`), []);
  assert.deepEqual(focusLostInForcedColors(`${removal} .r:focus-visible > i { outline: 2px solid; }`), []);
  assert.deepEqual(focusLostInForcedColors(`.r:focus-visible { outline: none; } @media (forced-colors: active) { .r:focus-visible { outline: 2px solid; } }`), []);
  assert.deepEqual(focusLostInForcedColors(`.r:focus-visible { outline: 2px solid; } .r:focus-visible { outline: none; }`), [".r:focus-visible"]);
});

test("focusedSubject reads the focused element, not its ancestors or children", () => {
  assert.equal(focusedSubject(".b .a:focus-visible"), ".a:focus-visible");
  assert.equal(focusedSubject(".a:focus"), ".a:focus");
  assert.equal(focusedSubject(".a:focus-visible > span"), null);
  assert.equal(focusedSubject(".a:focus-visible::after"), null);
  assert.equal(focusedSubject(".a:focus-within"), null);
  assert.equal(focusedSubject(".a:not(:focus-visible)"), null);
  assert.equal(focusedSubject(".p:has(> .a:focus-visible)"), null);
});

test("selectorMembers splits only top-level commas", () => {
  assert.deepEqual(selectorMembers(".a:is(.b, .c):focus,\n  .d[title='x,y']"), [".a:is(.b, .c):focus", ".d[title='x,y']"]);
});
