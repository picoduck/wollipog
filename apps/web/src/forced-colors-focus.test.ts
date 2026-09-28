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
 * background to Canvas and drops `box-shadow` outright. A rule that takes an element's outline away
 * and shows focus with a fill or a shadow instead therefore shows nothing at all in a contrast theme:
 * the Resize Panel separator did exactly that, and its focused and unfocused pixels were identical.
 *
 * This is an INVENTORY, not a proof. Deciding from the stylesheet alone whether some other rule puts
 * a visible ring back — under the same media conditions, winning on specificity, importance and
 * source order, in a colour that is not Canvas, at a width that is not zero — is a cascade engine,
 * and review showed a partial one passes exactly the cases it gets wrong. So every rule that sets an
 * outline in any form other than the few known-good rings below is listed here verbatim with the
 * reason focus stays visible, and ANY new, changed or removed one fails until a person checks it.
 *
 * A rule whose selector mentions `:focus` is recorded with its whole block, because its other
 * declarations are the focus cue being judged. Any other rule is recorded with its outline
 * declarations only: its padding is not a focus cue, and churn there would train people to update
 * the list without looking.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(WEB, "src/styles.css"), "utf8");

/**
 * The known-good rings. A transparent outline is the idiomatic forced-colors answer: it paints
 * nothing normally, and forced colors repaints it in a system colour.
 */
const KNOWN_GOOD_OUTLINE = /^2px solid (var\(--accent\)|var\(--text\)|transparent)$/;

/** A reason that holds only while the rule stays above the global `:focus-visible` ring; a test pins that order. */
const BEFORE_RING = "declared before the global :focus-visible ring at equal specificity, so the ring still wins";

/** Every rule that sets an outline some other way, with the reason focus stays visible in forced colors. */
const REVIEWED: ReadonlyMap<string, string> = new Map([
  // Text entry: forced colors keeps the caret, which marks focus in a field.
  ["select, input, textarea { outline: none }", "element selectors (0,0,1) lose to the later global :focus-visible ring, so these fields keep it"],
  [".composer-input { outline: none }", BEFORE_RING],
  [".composer-answer-input { outline: none }", BEFORE_RING],
  [".palette-input { outline: none }", "a text field: forced colors keeps the caret, which marks focus"],
  [".project-manager-search input { outline: 0 }", "a text field: forced colors keeps the caret, which marks focus"],
  [".inbox-search input { outline: 0 }", "a text field: forced colors keeps the caret, which marks focus"],
  [".archive-search input { outline: 0 }", "a text field: forced colors keeps the caret, which marks focus"],
  [".ws-create-name:focus { outline: none; border-color: var(--accent) }", "a text input: forced colors keeps the caret, which marks focus"],
  [".shell-search:focus { outline: none; border-color: var(--accent) }", "a text input: forced colors keeps the caret, which marks focus"],
  [".shell-input:focus { outline: none; border-color: var(--accent) }", "a text input: forced colors keeps the caret, which marks focus"],
  // Programmatic targets and rings drawn elsewhere.
  [".agent-session-agent-step:focus, .agent-session-results-step:focus { outline: none }", "tabIndex={-1} programmatic focus targets, never a keyboard stop"],
  [".session-status-popover-content { outline: none }", BEFORE_RING],
  [".inbox-list { outline: none }", "the list pane's :has(> .inbox-list:focus-visible)::after border marks focus, and forced colors keeps borders"],
  [".inbox-list:focus-visible, .detail-scroll:focus-visible { outline: none }", "the list and preview panes' :has()::after borders mark focus; in the app SessionDetail renders only inside the preview pane"],
  ["@media (pointer: coarse) .inbox-thread-toggle:focus-visible { outline: none }", "the same block outlines the toggle's inner span with the known-good ring instead"],
  [".usage-chart-hit:focus-visible { outline: none; stroke: var(--accent); stroke-width: 2 }", "an SVG <rect>: the 2px stroke marks focus, and forced colors repaints strokes rather than dropping them"],
  // Not focus indicators.
  [".column.drag-over { outline: 1px dashed var(--accent); outline-offset: -1px }", "a drop-target cue while dragging, not a focus indicator"],
  [".composer-box.drag-over { outline: 2px dashed var(--accent); outline-offset: 2px }", "a drop-target cue while dragging, not a focus indicator"],
  ["@media (forced-colors: active) .tl-message-action-unavailable > .tl-message-icon::after { outline: 1px solid Canvas }", "the unavailable slash's Canvas halo (#1887), on a pseudo-element, not a focus indicator"],
  [".agents-list button[aria-current=\"true\"] { outline: 1px solid var(--border) }", "KNOWN GAP, not verified safe: this beats the global ring, so the focused current Agents item looks as it does at rest; reported as a follow-up to #1890"],
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

function contextOf(rule: Rule): string {
  const parts: string[] = [];
  for (let node: Node | undefined = rule.parent; node; node = node.parent) {
    if (node.type === "atrule") parts.unshift(`@${(node as AtRule).name} ${(node as AtRule).params.replace(/\s+/g, " ")} `);
  }
  return parts.join("");
}

/**
 * Property names are case-insensitive, and an escaped one could spell `outline` in a way this cannot
 * read, so an escaped name is treated as setting an outline and goes to review.
 */
function setsOutline(decl: Declaration): boolean {
  const prop = decl.prop.toLowerCase();
  return prop.includes("\\") || prop === "all" || prop === "outline" || prop.startsWith("outline-");
}
const normalise = (decl: Declaration) => `${decl.prop}: ${decl.value.trim().replace(/\s+/g, " ")}${decl.important ? " !important" : ""}`;

/** Offsets that keep the ring on or beside its element; a larger one can move it out of sight. */
const KNOWN_GOOD_OFFSET = /^-?[0-3](px)?$/;

/** An outline declaration that can only draw one of the known-good rings or nudge it. */
function knownGood(decl: Declaration): boolean {
  if (decl.important) return false;
  const value = decl.value.trim().replace(/\s+/g, " ");
  if (decl.prop === "outline-offset") return KNOWN_GOOD_OFFSET.test(value);
  return decl.prop === "outline" && KNOWN_GOOD_OUTLINE.test(value);
}

/** Stands for the top-level `:focus-visible` rule in `outlineEntries`, so an entry's position against it can be checked. */
export const GLOBAL_RING = "<global :focus-visible ring>";

/** The inventory in source order, with GLOBAL_RING where each top-level `:focus-visible` rule sits. */
export function outlineEntries(source: string): string[] {
  const entries: string[] = [];
  postcss.parse(source).walkRules((rule) => {
    if (rule.parent?.type === "root" && rule.selector.trim() === ":focus-visible") entries.push(GLOBAL_RING);
    const decls = rule.nodes.filter((node): node is Declaration => node.type === "decl");
    const outline = decls.filter(setsOutline);
    if (outline.every(knownGood)) return;
    const recorded = /:focus/i.test(rule.selector) ? decls : outline;
    entries.push(`${contextOf(rule)}${selectorMembers(rule.selector).join(", ")} { ${recorded.map(normalise).join("; ")} }`);
  });
  return entries;
}

/** `context selector { declarations }` for every rule that sets an outline other than a known-good ring, sorted. */
export function outlineInventory(source: string): string[] {
  return outlineEntries(source).filter((entry) => entry !== GLOBAL_RING).sort();
}

/** Entries that are declared before `ring` in `entries`, among the given keys; the rest have moved past it. */
export function entriesAfterRing(entries: readonly string[], keys: Iterable<string>): string[] {
  const ring = entries.indexOf(GLOBAL_RING);
  return [...keys].filter((key) => ring < 0 || entries.lastIndexOf(key) > ring);
}

test("every rule that sets an outline outside the known-good rings has been reviewed for forced colors", () => {
  assert.deepEqual(outlineInventory(css), [...REVIEWED.keys()].sort(),
    "a rule that sets an outline other than `2px solid` in --accent, --text or transparent was added, changed or " +
    "removed. Forced colors discards backgrounds and shadows, so check keyboard focus still shows a ring in a " +
    "contrast theme (prefer `outline: 2px solid transparent` to `outline: none`), then update REVIEWED with the reason");
});

test("entries that rely on source order stay above the one global :focus-visible ring", () => {
  const entries = outlineEntries(css);
  assert.equal(entries.filter((entry) => entry === GLOBAL_RING).length, 1, "exactly one top-level :focus-visible rule");
  const beforeRing = [...REVIEWED].filter(([, reason]) => reason === BEFORE_RING).map(([key]) => key);
  assert.equal(beforeRing.length, 3);
  assert.deepEqual(entriesAfterRing(entries, beforeRing), [],
    "a rule whose reason is that the global ring is declared after it has moved below that ring, so its outline now wins");
});

test("entriesAfterRing notices an entry moving past the ring", () => {
  const rule = ".r { outline: none }";
  const ring = ":focus-visible { outline: 2px solid var(--accent); }";
  assert.deepEqual(entriesAfterRing(outlineEntries(`${rule} ${ring}`), [rule]), []);
  assert.deepEqual(entriesAfterRing(outlineEntries(`${ring} ${rule}`), [rule]), [rule]);
  assert.deepEqual(entriesAfterRing(outlineEntries(`${rule} ${ring} ${rule}`), [rule]), [rule]);
  assert.deepEqual(entriesAfterRing(outlineEntries(rule), [rule]), [rule]);
  assert.deepEqual(outlineInventory(`${ring} ${rule}`), [rule]);
});

test("every reviewed entry says why focus stays visible", () => {
  for (const [key, reason] of REVIEWED) assert.ok(reason.trim().length > 20, key);
});

test("the Resize Panel separator's focus rule keeps a transparent outline", () => {
  const rules: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (!selectorMembers(rule.selector).some((member) => member.startsWith(".right-panel-resizer"))) return;
    const outline = rule.nodes.filter((node): node is Declaration => node.type === "decl" && setsOutline(node));
    if (outline.length) rules.push(`${contextOf(rule)}${selectorMembers(rule.selector).join(", ")} { ${outline.map(normalise).join("; ")} }`);
  });
  assert.deepEqual(rules, [".right-panel-resizer:hover, .right-panel-resizer:focus-visible { outline: 2px solid transparent; outline-offset: -2px }"]);
});

test("outlineInventory records every outline that is not a known-good ring", () => {
  const record = (source: string) => outlineInventory(source);
  assert.deepEqual(record(".r:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }"), []);
  assert.deepEqual(record(".r:focus-visible { background: red; outline: 2px solid transparent; }"), []);
  assert.deepEqual(record(".r { padding: 1px; }"), []);
  assert.deepEqual(record(".r:focus-visible { outline: 2px solid var(--text); outline-offset: -3px; }"), []);
  for (const outline of [
    "outline: none", "outline: 0", "outline: 0.0px solid transparent", "outline: 2px solid Canvas",
    "outline-style: none", "outline-width: 0", "outline-color: Canvas", "outline: 2px solid transparent !important",
    "all: unset", "outline: 3px dotted var(--accent)", "OUTLINE: none", "Outline-Style: none",
    "outline-offset: 10000px", "outline-offset: -4px", "outl\\69ne: none",
  ]) assert.equal(record(`.r:focus-visible { ${outline}; }`).length, 1, outline);
});

test("outlineInventory tells apart what a changed or added rule could hide", () => {
  const base = ".c:focus-visible { outline: none; stroke: var(--accent); }";
  const [original] = outlineInventory(base);
  assert.equal(original, ".c:focus-visible { outline: none; stroke: var(--accent) }");
  assert.deepEqual(outlineInventory(".c:focus-visible { outline: none; stroke: none; background: red; }"),
    [".c:focus-visible { outline: none; stroke: none; background: red }"]);
  assert.deepEqual(outlineInventory(`${base} .c:focus-visible { outline: none; stroke: var(--accent); }`), [original, original]);
  assert.deepEqual(outlineInventory(`@media (max-width: 1px) { ${base} }`), [`@media (max-width: 1px) ${original}`]);
  assert.deepEqual(outlineInventory(".r:not(:not(:focus-visible)) { outline: none; background: red; }"),
    [".r:not(:not(:focus-visible)) { outline: none; background: red }"]);
  // Outside a focus rule only the outline is recorded, so unrelated edits there do not churn the list.
  assert.deepEqual(outlineInventory(".r { padding: 1px; outline: none; }"), [".r { outline: none }"]);
});

test("selectorMembers splits only top-level commas", () => {
  assert.deepEqual(selectorMembers(".a:is(.b, .c):focus,\n  .d[title='x,y']"), [".a:is(.b, .c):focus", ".d[title='x,y']"]);
});
