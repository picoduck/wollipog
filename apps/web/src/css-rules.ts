import postcss, { type AtRule, type Root, type Rule } from "postcss";

/**
 * Stylesheet introspection for the invariant tests, built on a real CSS parser.
 *
 * Three successive hand-rolled readers were shown to mis-parse in review: a regex lookup matched
 * `--backup-text-lg` for `--text-lg`; a first-match read hid a duplicate declaration whose later
 * value is the one CSS actually applies; a brace counter could truncate on a brace inside a string
 * or `url()`; a `:root` nested in `@media` passed as the global scope; and exact selector-string
 * comparison rejected equivalent CSS that differed only in whitespace.
 *
 * Each of those is a parsing problem, and parsing is a solved problem. postcss is already present
 * in the dependency tree via Vite, so this adds no new supply chain — only an explicit devDependency
 * on something the build already installs.
 */

function parse(css: string): Root {
  return postcss.parse(css);
}

/** Selector list, normalised so `a,\n b` and `a, b` compare equal. */
function selectorSet(selector: string): string {
  return selector
    .split(",")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .sort()
    .join(", ");
}

/**
 * The one TOP-LEVEL rule whose selector list equals `selectors`.
 *
 * Top-level matters: a rule inside `@media` or `@supports` is conditional, so its declarations are
 * not the global scope however its selector reads.
 */
export function topLevelRule(css: string, selectors: string): Rule {
  const wanted = selectorSet(selectors);
  const matches: Rule[] = [];
  parse(css).each((node) => {
    if (node.type === "rule" && selectorSet(node.selector) === wanted) matches.push(node);
  });
  if (matches.length !== 1) {
    throw new Error(`expected exactly one top-level rule with selector "${selectors}", found ${matches.length}`);
  }
  return matches[0]!;
}

/**
 * Custom-property declarations DIRECTLY in a rule, keyed by exact property name.
 *
 * A name may map to several values; that is the duplicate case callers must reject, since CSS
 * applies the last while a naive read reports the first. Nested declarations (inside a conditional
 * block within the rule) are excluded — they are not unconditionally part of this scope.
 */
export function customProperties(rule: Rule): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const node of rule.nodes) {
    if (node.type !== "decl" || !node.prop.startsWith("--")) continue;
    const existing = found.get(node.prop);
    if (existing) existing.push(node.value.trim());
    else found.set(node.prop, [node.value.trim()]);
  }
  return found;
}

export interface MediaBlock {
  params: string;
  /** Every `max-width` operand in the query, in px. A query may carry more than one. */
  maxWidths: number[];
  containsSelector: (selector: string) => boolean;
  declarationsForSelector: (selector: string) => Map<string, string[]>;
}

/** Every `@media` block in the stylesheet, at any nesting depth. */
export function mediaBlocks(css: string): MediaBlock[] {
  const blocks: MediaBlock[] = [];
  parse(css).walkAtRules("media", (atRule: AtRule) => {
    const maxWidths = [...atRule.params.matchAll(/max-width:\s*(\d+)px/g)]
      .map((match) => Number.parseInt(match[1]!, 10));
    blocks.push({
      params: atRule.params,
      maxWidths,
      containsSelector: (selector: string) => {
        let found = false;
        atRule.walkRules((rule) => {
          if (rule.selector.split(",").some((part) => part.trim().replace(/\s+/g, " ") === selector)) found = true;
        });
        return found;
      },
      declarationsForSelector: (selector: string) => {
        const declarations = new Map<string, string[]>();
        atRule.walkRules((rule) => {
          if (!rule.selector.split(",").some((part) => part.trim().replace(/\s+/g, " ") === selector)) return;
          for (const node of rule.nodes) {
            if (node.type !== "decl") continue;
            const values = declarations.get(node.prop) ?? [];
            values.push(node.value.trim());
            declarations.set(node.prop, values);
          }
        });
        return declarations;
      },
    });
  });
  return blocks;
}

export interface TintedRule {
  selector: string;
  /** Declared value of each requested property, last-wins as CSS applies it. */
  declarations: Record<string, string>;
}

/**
 * Every rule that declares ALL of `props`, anywhere in the stylesheet.
 *
 * The contrast checks need rules that set a text colour AND a fill in the same block, because that
 * pairing is the only place the stylesheet states what goes on what. Last-wins per property, since
 * a rule may declare the same property twice and CSS applies the later one.
 */
export function rulesWith(css: string, props: readonly string[], alsoCollect: readonly string[] = []): TintedRule[] {
  const out: TintedRule[] = [];
  parse(css).walkRules((rule) => {
    const declarations: Record<string, string> = {};
    for (const node of rule.nodes) {
      if (node.type !== "decl") continue;
      // `alsoCollect` is not part of the match — it is context the caller needs ABOUT the matched
      // rule. Returning only the required props hid `-webkit-text-fill-color` from the check meant
      // to reject it, so the check silently never fired.
      if (props.includes(node.prop) || alsoCollect.includes(node.prop)) declarations[node.prop] = node.value.trim();
    }
    if (props.every((prop) => prop in declarations)) {
      out.push({ selector: rule.selector.replace(/\s+/g, " ").trim(), declarations });
    }
  });
  return out;
}

export interface Declaration {
  selector: string;
  /** Every selector in the owning rule's list, normalised. A rule is exempt only if ALL of them are. */
  selectors: string[];
  prop: string;
  value: string;
  line: number;
}

/**
 * Every declaration in the stylesheet, with its owning rule's full selector list.
 *
 * Line-oriented scanning of the source cannot do this safely: a `content: "/*"` string reads as a
 * comment opener and hides everything after it, and a one-line rule leaves a brace-counting state
 * machine stuck. postcss already knows where declarations begin and end.
 */
export function allDeclarations(css: string): Declaration[] {
  const out: Declaration[] = [];
  parse(css).walkDecls((decl) => {
    const parent = decl.parent;
    const selector = parent && parent.type === "rule" ? (parent as Rule).selector : "";
    out.push({
      selector: selector.replace(/\s+/g, " ").trim(),
      selectors: selector.split(",").map((part) => part.trim().replace(/\s+/g, " ")).filter(Boolean),
      prop: decl.prop,
      value: decl.value.trim(),
      line: decl.source?.start?.line ?? 0,
    });
  });
  return out;
}

/** Every declaration of `prop` anywhere in the stylesheet, with the selector that owns it. */
export function declarationsOf(css: string, prop: string): Array<{ selector: string; value: string }> {
  const out: Array<{ selector: string; value: string }> = [];
  parse(css).walkDecls(prop, (decl) => {
    const parent = decl.parent;
    out.push({
      selector: parent && parent.type === "rule" ? (parent as Rule).selector : "(unknown)",
      value: decl.value.trim(),
    });
  });
  return out;
}
