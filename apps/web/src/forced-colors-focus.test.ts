import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import postcss, { type Declaration } from "postcss";

/**
 * Keyboard focus that survives forced colors (#1890).
 *
 * Forced colors (Windows contrast themes) repaints author colours with system colours, forces every
 * background to Canvas and drops `box-shadow` outright. A rule that removes an element's outline and
 * shows focus with a fill or a shadow instead therefore shows nothing at all in a contrast theme: the
 * Resize Panel separator did exactly that, and its focused and unfocused pixels were identical.
 *
 * What forced colors keeps is the SHAPE of an outline, a border or an SVG stroke, repainted in a
 * system colour. A transparent outline is the idiomatic answer: it paints nothing normally, and
 * forced colors repaints its colour. A border-colour change alone does not count, because forced
 * colors paints every border the same system colour.
 *
 * The check is deliberately narrow. A rule that removes its own focused element's outline must paint
 * one of those shapes in the SAME declaration block, resolved in source order. Anything else — a ring
 * on a child, a pseudo-element or an ancestor's `:has()` — has to be listed below with the reason it
 * holds, because proving that from selectors alone (scope, media conditions, source order,
 * specificity) is a cascade engine, and a partial one passes the cases it gets wrong.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(WEB, "src/styles.css"), "utf8");

/**
 * Focus rules that remove the outline and do not repaint a shape in the same block, on purpose. Each
 * entry says why focus stays visible in forced colors; a stale entry fails the inventory test below.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [".ws-create-name:focus", "a text input: the caret marks focus, and forced colors keeps it"],
  [".shell-search:focus", "a text input: the caret marks focus, and forced colors keeps it"],
  [".shell-input:focus", "a text input: the caret marks focus, and forced colors keeps it"],
  [".agent-session-agent-step:focus", "a tabIndex={-1} programmatic focus target, not a keyboard stop"],
  [".agent-session-results-step:focus", "a tabIndex={-1} programmatic focus target, not a keyboard stop"],
  [".inbox-thread-toggle:focus-visible", "the same phone @media block outlines its inner span instead"],
  [".inbox-list:focus-visible", ".inbox-list-pane:has(> .inbox-list:focus-visible)::after borders the pane; InboxView renders the list as its direct child"],
  [".detail-scroll:focus-visible", ".inbox-preview-pane:has(.detail-scroll:focus-visible)::after borders the pane; SessionDetail, its only renderer, sits inside that pane"],
]);

/** Split on top-level `separator` characters, leaving parentheses, attributes and strings whole. */
function splitTopLevel(text: string, isSeparator: (ch: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (depth === 0 && isSeparator(ch)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Split a selector list without treating commas inside :is(), :has(), attributes or strings as members. */
export function selectorMembers(selectorList: string): string[] {
  return splitTopLevel(selectorList, (ch) => ch === ",").map((member) => member.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/**
 * Does this selector match an element because THAT element has focus? Reads the subject (last)
 * compound, including through `:is()`, `:where()` and `:matches()`, but not through `:not()` or
 * `:has()`, which match an unfocused element or a relative of the focused one. `:focus-within` is an
 * ancestor of focus, and a pseudo-element subject is not the focused element's own outline.
 */
export function matchesOwnFocus(member: string): boolean {
  const compounds = splitTopLevel(member, (ch) => ch === " " || ch === ">" || ch === "+" || ch === "~").filter((part) => part.trim());
  const subject = compounds.at(-1)?.trim() ?? "";
  if (subject.includes("::")) return false;
  let depth = 0;
  let blocked = 0;
  const stack: boolean[] = [];
  for (let index = 0; index < subject.length; index += 1) {
    const rest = subject.slice(index);
    const open = /^:(not|has)\(/i.exec(rest);
    if (open) {
      stack.push(true);
      blocked += 1;
      depth += 1;
      index += open[0].length - 1;
      continue;
    }
    const ch = subject[index]!;
    if (ch === "(") { stack.push(false); depth += 1; continue; }
    if (ch === ")") { if (stack.pop()) blocked -= 1; depth -= 1; continue; }
    if (blocked === 0 && /^:focus(-visible)?(?![\w-])/i.test(rest)) return true;
  }
  return false;
}

const LINE_STYLES = /^(auto|solid|dashed|dotted|double|groove|ridge|inset|outset|none|hidden)$/;
const ZERO = /^0([a-z%]*)$/;

/** Style and width of one outline or border side, after a shorthand or longhand. */
interface Line { style: string; zero: boolean }

/** `outline` and `border*` shorthands reset the style they omit to `none`. */
function shorthand(value: string): Line {
  const tokens = value.trim().toLowerCase().split(/\s+/);
  return {
    style: tokens.find((token) => LINE_STYLES.test(token)) ?? "none",
    zero: tokens.some((token) => ZERO.test(token)),
  };
}

/** One to four box values as top, right, bottom, left. */
function boxSides(value: string): [string, string, string, string] {
  const [top, right = top, bottom = top, left = right] = value.split(/\s+/) as [string, ...string[]];
  return [top, right!, bottom!, left!];
}

const SIDES = ["top", "right", "bottom", "left"] as const;

const paints = (line: Line) => line.style !== "none" && line.style !== "hidden" && !line.zero;

/** Resolve a declaration block in source order: its outline, and whether any border side or stroke paints. */
export function resolveFocusPaint(decls: readonly Pick<Declaration, "prop" | "value">[]) {
  let outline: Line = { style: "none", zero: false };
  let touchesOutline = false;
  const sides: Record<string, Line> = Object.fromEntries(SIDES.map((side) => [side, { style: "none", zero: false }]));
  let stroke = "none";
  for (const { prop, value } of decls) {
    const v = value.trim().toLowerCase();
    if (prop === "outline") { outline = shorthand(v); touchesOutline = true; }
    else if (prop === "outline-style") { outline = { ...outline, style: v }; touchesOutline = true; }
    else if (prop === "outline-width") { outline = { ...outline, zero: ZERO.test(v) }; touchesOutline = true; }
    else if (prop === "border") for (const side of SIDES) sides[side] = shorthand(v);
    else if (/^border-(top|right|bottom|left)$/.test(prop)) sides[prop.slice(7)] = shorthand(v);
    else if (prop === "border-style" || prop === "border-width") {
      boxSides(v).forEach((part, i) => {
        const current = sides[SIDES[i]!]!;
        sides[SIDES[i]!] = prop === "border-style" ? { ...current, style: part } : { ...current, zero: ZERO.test(part) };
      });
    }
    else if (/^border-(top|right|bottom|left)-(style|width)$/.test(prop)) {
      const [, side, part] = /^border-(\w+)-(\w+)$/.exec(prop)!;
      const current = sides[side!]!;
      sides[side!] = part === "style" ? { ...current, style: v } : { ...current, zero: ZERO.test(v) };
    }
    else if (prop === "stroke") stroke = v;
  }
  return {
    removesOutline: touchesOutline && !paints(outline),
    paintsShape: paints(outline) || Object.values(sides).some(paints) || !/^(none|transparent)$/.test(stroke),
  };
}

/** Every focus selector whose block removes the outline and repaints no shape forced colors keeps. */
export function focusLostInForcedColors(source: string): string[] {
  const lost = new Set<string>();
  postcss.parse(source).walkRules((rule) => {
    const decls = rule.nodes.filter((node): node is Declaration => node.type === "decl");
    const paint = resolveFocusPaint(decls);
    if (!paint.removesOutline || paint.paintsShape) return;
    for (const member of selectorMembers(rule.selector)) if (matchesOwnFocus(member)) lost.add(member);
  });
  return [...lost].sort();
}

test("every focus rule that removes the outline repaints a shape forced colors keeps", () => {
  const unexplained = focusLostInForcedColors(css).filter((member) => !EXEMPT.has(member));
  assert.deepEqual(unexplained, [],
    "these rules remove the focus outline without painting an outline, border or stroke in the same block; " +
    "forced colors discards backgrounds, shadows and border colours, so use `outline: 2px solid transparent` " +
    "instead of `outline: none`, or list the rule in EXEMPT with the reason focus stays visible");
});

test("every exemption still names a rule that removes the outline", () => {
  const lost = new Set(focusLostInForcedColors(css));
  assert.deepEqual([...EXEMPT.keys()].filter((member) => !lost.has(member)), []);
});

test("the Resize Panel separator's focus rule keeps a transparent outline", () => {
  const rules: { selector: string; outline: string | undefined }[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (!selectorMembers(rule.selector).some((member) => member.startsWith(".right-panel-resizer"))) return;
    let outline: string | undefined;
    rule.walkDecls("outline", (decl) => { outline = decl.value; });
    rules.push({ selector: selectorMembers(rule.selector).join(", "), outline });
  });
  const focus = rules.filter((rule) => selectorMembers(rule.selector).includes(".right-panel-resizer:focus-visible"));
  assert.deepEqual(focus, [{ selector: ".right-panel-resizer:hover, .right-panel-resizer:focus-visible", outline: "2px solid transparent" }]);
  assert.ok(!EXEMPT.has(".right-panel-resizer:focus-visible"));
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
  assert.deepEqual(check(".r:focus-visible { outline: none; border-left: 2px solid red; }"), []);
  assert.deepEqual(check(".r:focus-visible { outline: none; border-style: none solid; }"), []);
});

test("focusLostInForcedColors resolves each block in source order", () => {
  const check = (source: string) => focusLostInForcedColors(source);
  assert.deepEqual(check(".r:focus-visible { outline: 2px solid transparent; outline: none; }"), [".r:focus-visible"]);
  assert.deepEqual(check(".r:focus-visible { outline: none; outline-offset: 2px; }"), [".r:focus-visible"]);
  assert.deepEqual(check(".r:focus-visible { outline: none; border: 2px solid red; border: none; }"), [".r:focus-visible"]);
  assert.deepEqual(check(".r:focus-visible { outline: none; border: 2px solid red; border-width: 0; }"), [".r:focus-visible"]);
  assert.deepEqual(check(".r:focus-visible { outline: none; stroke: transparent; }"), [".r:focus-visible"]);
  assert.deepEqual(check(".r:focus-visible { outline: 2px solid; outline-style: none; }"), [".r:focus-visible"]);
});

test("focusLostInForcedColors credits no other rule, whatever its scope or conditions", () => {
  const check = (source: string) => focusLostInForcedColors(source);
  assert.deepEqual(check(".r:focus-visible { outline: none; } .r:focus-visible > span { outline: 2px solid; }"), [".r:focus-visible"]);
  assert.deepEqual(check(".r:focus-visible { outline: none; } .other .r:focus-visible > span { outline: 2px solid; }"), [".r:focus-visible"]);
  assert.deepEqual(check("@media (max-width: 1px) { .r:focus-visible { outline: none; } } @media (forced-colors: active) and (min-width: 2px) { .r:focus-visible { outline: 2px solid; } }"), [".r:focus-visible"]);
  assert.deepEqual(check("@media (forced-colors: active) { .r:focus-visible { outline: 2px solid; } } .r:focus-visible { outline: none; }"), [".r:focus-visible"]);
  assert.deepEqual(check("@media (max-width: 1px) { @supports (color: red) { .r:focus-visible { outline: none; } } }"), [".r:focus-visible"]);
});

test("matchesOwnFocus reads the focused element, not its ancestors, relatives or children", () => {
  assert.equal(matchesOwnFocus(".b .a:focus-visible"), true);
  assert.equal(matchesOwnFocus(".a:focus"), true);
  assert.equal(matchesOwnFocus(".a:is(:focus-visible)"), true);
  assert.equal(matchesOwnFocus(".a:where(.b, :focus)"), true);
  assert.equal(matchesOwnFocus(".a:is(.b:not(:focus))"), false);
  assert.equal(matchesOwnFocus(".a:focus-visible > span"), false);
  assert.equal(matchesOwnFocus(".a:focus-visible::after"), false);
  assert.equal(matchesOwnFocus(".a:focus-within"), false);
  assert.equal(matchesOwnFocus(".a:not(:focus-visible)"), false);
  assert.equal(matchesOwnFocus(".p:has(> .a:focus-visible)"), false);
  assert.equal(matchesOwnFocus(".a:is(.b > .c:focus)"), true);
});

test("selectorMembers splits only top-level commas", () => {
  assert.deepEqual(selectorMembers(".a:is(.b, .c):focus,\n  .d[title='x,y']"), [".a:is(.b, .c):focus", ".d[title='x,y']"]);
});
