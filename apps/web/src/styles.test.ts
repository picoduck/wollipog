import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { customProperties, declarationsOf, mediaBlocks, topLevelRule } from "./css-rules.js";

const raw = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
/** Comments carry example declarations and prose; every check below reasons about real rules. */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Declarations of the one top-level rule with this selector list, via a real CSS parser.
 * The previous regex version could be satisfied by a rule nested inside an @media block, and was
 * defeated by whitespace differences in an equivalent selector list.
 */
function soleRuleProps(selector: string): Map<string, string[]> {
  return customProperties(topLevelRule(css, selector));
}

/** Raw declaration text of that rule, for the checks that inspect non-custom properties. */
function soleRuleBody(selector: string): string {
  return topLevelRule(css, selector).nodes
    .map((node) => (node.type === "decl" ? `${node.prop}: ${node.value};` : ""))
    .join("\n");
}

/**
 * Safari zooms the viewport when a control smaller than 16px takes focus, and the user cannot zoom
 * back out. Two earlier attempts at this guard were defeated by the cascade: first by specificity
 * (a bare-element selector is (0,0,1) and loses to every class-scoped rule), then by document
 * order (`:root input` only TIES with `.automation-form-grid input` and `.usage-retention input`,
 * which appear later). Its position at the very end of the file is load-bearing.
 */
test("the iOS focus-zoom guard is the final rule in the stylesheet", () => {
  const guard = css.lastIndexOf(":root .composer-input {");
  assert.notEqual(guard, -1, "the 16px form-text guard must exist");
  assert.match(css.slice(guard), /font-size:\s*16px/, "the guard must set 16px");

  // Scope as well as position: checking only for the composer selector would stay green if the
  // other three selectors were dropped, or if the rule were moved outside the phone media query,
  // while Automation and Usage controls silently went back to zooming on focus.
  const lastMedia = css.lastIndexOf("@media (max-width: 760px)");
  assert.ok(lastMedia !== -1 && lastMedia < guard,
    "the guard must live inside the phone-width media query");
  const guardedRule = css.slice(lastMedia);
  for (const selector of [":root select", ":root input", ":root textarea", ":root .composer-input"]) {
    assert.ok(guardedRule.includes(selector),
      `the focus-zoom guard must still cover ${selector}`);
  }

  // Structural, not declaration-specific: NOTHING may follow the guard. A later rule could defeat
  // it with `font-size` or with the `font` shorthand (which also resets size) at equal
  // specificity, so rejecting only `font-size` would let the shorthand through.
  const closingBrace = css.indexOf("}", css.indexOf("font-size:", guard));
  const afterRule = css.slice(closingBrace + 1);
  const remainder = afterRule.replace(/[\s}]/g, "");
  assert.equal(remainder, "",
    `the focus-zoom guard must be the last rule; found trailing CSS: ${remainder.slice(0, 120)}`);
});

test("known late form rules cannot outrank the focus-zoom guard", () => {
  // These are the rules that beat the previous attempt. They must appear BEFORE the guard so the
  // specificity tie resolves in the guard's favour on document order.
  const guard = css.lastIndexOf(":root .composer-input {");
  for (const selector of [".automation-form-grid input", ".usage-retention input"]) {
    const at = css.indexOf(selector);
    assert.notEqual(at, -1, `${selector} should still exist`);
    assert.ok(at < guard, `${selector} must appear before the focus-zoom guard`);
  }
});

/**
 * These custom properties were referenced across the stylesheet before they were ever defined, so
 * the declarations using them were invalid and dropped — "paused"/"conflicted" states rendered
 * with no colour and commit SHAs rendered in the proportional UI face.
 */
test("every referenced custom property is defined in the shared root scope", () => {
  // Scope matters, not merely "declared somewhere": a token defined only under the light theme
  // leaves every dark-theme consumer unresolved, and one defined inside a component scope does
  // not reach global consumers.
  // Two global scopes, both theme-agnostic in effect: the palette block (which also carries the
  // dark values) and the design-token block. A plain `:root` applies under both themes, so a token
  // declared there resolves everywhere.
  const paletteNames = new Set(soleRuleProps(':root,\n:root[data-theme="dark"]').keys());
  const tokenNames = new Set(soleRuleProps(":root").keys());
  const lightNames = new Set(soleRuleProps(':root[data-theme="light"]').keys());

  // A name in BOTH root scopes resolves inconsistently: the palette selector
  // `:root[data-theme="dark"]` is (0,2,0) and wins under an explicit dark theme, while the plain
  // `:root` token block wins under light. The union below would hide that, so check it first.
  const collisions = [...paletteNames].filter((name) => tokenNames.has(name)).sort();
  assert.deepEqual(collisions, [],
    `declared in both root scopes, so dark and light resolve differently: ${collisions.join(", ")}`);

  const shared = new Set([...paletteNames, ...tokenNames]);
  const light = lightNames;
  const referenced = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]!));

  // Published at runtime by JS rather than declared in the sheet, and always read through a
  // var() fallback, so an undefined value is the normal case rather than a defect. Each entry
  // must be genuinely runtime-set — this is not a place to silence a real missing token.
  const RUNTIME_PUBLISHED = new Set([
    "--keyboard-inset", // installMobileViewportFallback; absent means no occlusion
  ]);

  const unresolved = [...referenced]
    .filter((name) => !shared.has(name) && !RUNTIME_PUBLISHED.has(name))
    .sort();
  assert.deepEqual(unresolved, [],
    `used but not defined in the shared :root scope: ${unresolved.join(", ")}`);

  // The light block may only OVERRIDE tokens the shared block already establishes; a light-only
  // definition would silently break the dark theme.
  const lightOnly = [...light].filter((name) => !shared.has(name)).sort();
  assert.deepEqual(lightOnly, [],
    `defined only under the light theme, so dark is unresolved: ${lightOnly.join(", ")}`);
});

/**
 * `:focus-visible` must not declare border-radius: that restyles the focused ELEMENT, not its
 * outline, so pills, cards, and the circular send button visibly changed shape on keyboard focus.
 */
test("the global focus ring does not restyle the focused element", () => {
  // Anchored to the complete selector: a substring search matches the tail of component rules such
  // as `.rail-brand:focus-visible`, which would leave this test green if the global rule regressed.
  const body = soleRuleBody(":focus-visible");
  assert.match(body, /outline:/);
  assert.doesNotMatch(body, /border-radius/,
    "border-radius in :focus-visible changes the element's shape, not the outline's");
});

test("the permission-mode popover keeps rows compact while long labels can wrap", () => {
  assert.equal(soleRuleBody(".cbar-pop.permission-mode-pop"),
    "width: min(390px, calc(100vw - 32px));");
  assert.match(soleRuleBody(".cbar-permission-row"), /grid-template-columns: minmax\(0, 1fr\) 30px;/);
  assert.match(soleRuleBody(".cbar-permission-label"), /overflow-wrap: anywhere;/);
  assert.doesNotMatch(css, /\.cbar-permission-description/,
    "full explanations belong in deliberate disclosure, not every menu row");
  assert.match(soleRuleBody(".cbar-permission-details-trigger"), /width: 28px;/);
});

test("message metadata actions keep one compact target width on phones", () => {
  assert.match(soleRuleBody(".tl-message-icon"), /width: 24px;/);
  assert.match(soleRuleBody(".tl-message-icon"), /height: 24px;/);
  const phoneOverrides = mediaBlocks(css).filter((block) =>
    block.maxWidths.some((width) => width <= 760) && block.containsSelector(".tl-message-icon"));
  assert.deepEqual(phoneOverrides, [],
    "Message actions must not change width independently at phone sizes");
});

test("mobile Session statuses stay on one measured line before fixed actions", () => {
  const group = soleRuleBody(".change-status-indicators");
  assert.match(group, /display: inline-flex;/);
  assert.match(group, /min-width: 0;/);
  assert.match(group, /flex-wrap: wrap;/,
    "desktop change statuses must retain their existing wrapping behavior");
  const phoneRule = mediaBlocks(css).find((block) =>
    block.maxWidths.includes(760) &&
    block.containsSelector(
      ".session-detail > .detail-head > .session-header-statuses .change-status-indicators",
    ));
  assert.ok(phoneRule, "the phone layout must define the compact shared status row");
  assert.deepEqual(
    phoneRule.declarationsForSelector(
      ".session-detail > .detail-head > .session-header-statuses .change-status-indicators",
    ).get("display"),
    ["contents"],
  );
  const statuses = phoneRule
    .declarationsForSelector(".session-detail > .detail-head > .session-header-statuses");
  assert.deepEqual(statuses.get("grid-column"), ["1"],
    "statuses must stop before the dedicated action track");
  assert.deepEqual(statuses.get("flex-wrap"), ["nowrap"]);
  assert.deepEqual(statuses.get("overflow"), ["clip"],
    "clipped statuses must not create a horizontal scroller");
  assert.deepEqual(statuses.get("contain"), ["paint"],
    "paint containment keeps long badge geometry out of the page overflow area across engines");
  assert.equal(statuses.has("mask-image"), false,
    "a hidden-count disclosure replaces the ambiguous clipped-edge fade");
  assert.deepEqual(
    phoneRule.declarationsForSelector(
      ".session-detail > .detail-head > .session-header-statuses [hidden]",
    ).get("display"),
    ["none"],
    "overflowed badges must not remain partially painted",
  );
  const interactiveStatus = phoneRule.declarationsForSelector(
    ".session-detail > .detail-head > .session-header-statuses > button",
  );
  assert.deepEqual(interactiveStatus.get("order"), ["-1"],
    "focusable status actions must lead the row instead of disappearing into the clipped tail");
  assert.deepEqual(interactiveStatus.get("flex"), ["none"]);
  const lifecycle = phoneRule
    .declarationsForSelector(
      ".session-detail > .detail-head > .session-header-statuses .session-status-indicators",
    );
  assert.deepEqual(lifecycle.get("flex"), ["none"],
    "the lifecycle group must retain stable intrinsic geometry for overflow measurement");
  assert.deepEqual(lifecycle.get("flex-wrap"), ["nowrap"]);
  assert.deepEqual(lifecycle.get("min-height"), ["36px"],
    "the single status line must align with the compact Session actions");
  assert.equal(lifecycle.has("padding-right"), false,
    "the action grid track, not lifecycle padding, must reserve action space");
  for (const selector of [
    ".session-detail > .detail-head > .session-header-statuses .status-badge",
    ".session-detail > .detail-head > .session-header-statuses .background-work-badge",
  ]) {
    const badge = phoneRule.declarationsForSelector(selector);
    assert.deepEqual(badge.get("padding-inline"), ["4px"],
      `${selector} needs enough width headroom for wider system fonts`);
    assert.deepEqual(badge.get("font-size"), ["var(--text-2xs)"],
      `${selector} needs enough width headroom for wider system fonts`);
  }
  assert.deepEqual(
    phoneRule.declarationsForSelector(".session-detail > .detail-head").get("min-height"),
    ["44px"],
    "the compact status/action row must override the desktop 52px floor",
  );
  assert.deepEqual(
    phoneRule.declarationsForSelector(".session-detail > .detail-head").get("row-gap"),
    ["0"],
    "an absent transient note must not leave an empty second-row gap",
  );
  assert.deepEqual(
    phoneRule.declarationsForSelector(
      ".session-detail > .detail-head:has(> .session-header-note)",
    ).get("row-gap"),
    ["4px"],
    "a present transient note retains separation from the status/action row",
  );
  assert.deepEqual(
    phoneRule.declarationsForSelector(
      ".session-detail > .detail-head > .detail-actions",
    ).get("align-self"),
    ["center"],
    "status and action centers must remain aligned if the single row grows",
  );
});

test("mobile Session chrome keeps its coupled offsets and compact action icons", () => {
  const phoneRule = mediaBlocks(css).find((block) =>
    block.maxWidths.includes(760) &&
    block.containsSelector(".topbar") &&
    block.containsSelector(".right-panel") &&
    block.containsSelector(".topbar:has(.mobile-session-back)") &&
    block.containsSelector(".app:has(.mobile-session-back) .right-panel"));
  assert.ok(phoneRule, "the phone layout must define both default and Session chrome geometry");

  const sharedTokens = soleRuleProps(":root");
  assert.deepEqual(sharedTokens.get("--mobile-session-action-gap"), ["2px"]);
  assert.deepEqual(sharedTokens.get("--mobile-session-trailing-inset"),
    ["calc(8px + env(safe-area-inset-right, 0px))"]);

  const sessionTopbar = phoneRule.declarationsForSelector(".topbar:has(.mobile-session-back)");
  const paneActions = phoneRule.declarationsForSelector(
    ".topbar:has(.mobile-session-back) .topbar-mobile-controls",
  );
  const sessionHeader = phoneRule.declarationsForSelector(".session-detail > .detail-head");
  const sessionActions = phoneRule.declarationsForSelector(
    ".session-detail > .detail-head > .detail-actions",
  );
  assert.deepEqual(sessionTopbar.get("padding-right"), ["var(--mobile-session-trailing-inset)"]);
  assert.deepEqual(sessionHeader.get("padding-right"), ["var(--mobile-session-trailing-inset)"]);
  assert.deepEqual(paneActions.get("gap"), ["var(--mobile-session-action-gap)"]);
  assert.deepEqual(sessionActions.get("gap"), ["var(--mobile-session-action-gap)"]);

  const defaultTopbarHeight = phoneRule.declarationsForSelector(".topbar").get("height");
  const defaultPanelTop = phoneRule.declarationsForSelector(".right-panel").get("top");
  assert.deepEqual(defaultTopbarHeight,
    ["calc(50px + env(safe-area-inset-top, 0px))"]);
  assert.deepEqual(defaultPanelTop, defaultTopbarHeight,
    "the default right panel must begin at the default topbar's bottom edge");

  const sessionTopbarHeight = phoneRule
    .declarationsForSelector(".topbar:has(.mobile-session-back)").get("height");
  const sessionPanelTop = phoneRule
    .declarationsForSelector(".app:has(.mobile-session-back) .right-panel").get("top");
  assert.deepEqual(sessionTopbarHeight,
    ["calc(40px + env(safe-area-inset-top, 0px))"]);
  assert.deepEqual(sessionPanelTop, sessionTopbarHeight,
    "the Session right panel must begin at the compact Session topbar's bottom edge");

  const actionIcon = phoneRule.declarationsForSelector(".session-header-action svg");
  assert.deepEqual(actionIcon.get("width"), ["15px"]);
  assert.deepEqual(actionIcon.get("height"), ["15px"]);
});

/**
 * The reconnect recovery pill (issue #56) sits in a permanently-present NORMAL-FLOW slot between
 * the transcript scroller and the status strip. Its non-overlap guarantee is structural, not
 * numeric: an earlier fixed-pixel reservation lost to label wrapping at narrow panes and to
 * rem-scaled root fonts. With the pill markup always mounted, the slot is exactly as tall as the
 * pill really renders at the current pane width and font scale, and activity may toggle only
 * visibility — so recovery can never overlap transcript content, shift a reader's viewport, or
 * flip follow state.
 */
test("the recovery pill is a permanently-sized in-flow slot, never an overlay", () => {
  // No overlay remains: nothing in the recovery family may leave normal flow. An absolutely (or
  // sticky/fixed) positioned pill floating over the scroller is exactly the covered-newest-row
  // bug this slot replaced.
  const positioned = declarationsOf(css, "position")
    .filter(({ selector }) => selector.includes("transcript-recovery"));
  assert.deepEqual(positioned, [],
    "recovery rules must stay in normal flow so the slot's height is the pill's real rendered height");

  // The slot must not clamp its natural height: a wrapped label or rem-scaled text must be free
  // to grow it. (Slot height then changes only on genuine pane/font reflows, which the follow
  // logic already owns through its ResizeObserver on the reader.)
  const slot = soleRuleBody(".transcript-recovery-slot");
  assert.doesNotMatch(slot, /height|overflow/,
    "the slot must size to the pill's rendered height, never clamp or clip it");

  // Inactivity hides through visibility ONLY. `display: none` — or any layout property — would
  // collapse the slot on toggle and reintroduce the scroll shift the permanent slot prevents.
  assert.equal(soleRuleBody(".transcript-recovery-slot:not(.active) .transcript-recovery-notice"),
    "visibility: hidden;");

  // Symmetrically, activation may only start the pulse animation. Every .active-conditioned
  // recovery rule is checked so a future `display`, `margin`, or `height` cannot sneak a layout
  // delta into the activity toggle. The one deliberate exception is the compact-mode meter
  // yield (`:has(...)`): it toggles display INSIDE the fixed-height status strip only — reader
  // geometry and scroll position cannot move — and it is pinned by its own assertion below.
  const activeRules = [...css.matchAll(/([^{}]*transcript-recovery[^{}]*\.active[^{}]*)\{([^}]*)\}/g)]
    .filter(([, selector]) => !selector!.includes(":not(") && !selector!.includes(":has("));
  assert.ok(activeRules.length > 0, "the active state must exist");
  for (const [, selector, body] of activeRules) {
    const props = [...body!.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]);
    assert.deepEqual(props.filter((prop) => prop !== "animation"), [],
      `${selector!.trim()} may only toggle the pulse animation, found: ${props.join(", ")}`);
  }
});

/**
 * Two survival invariants a permanently-present slot must also honour (issue #56, round 3):
 *
 * STRIP SURVIVAL — an inbox preview pane can be arbitrarily short (a generous splitter position
 * on a short viewport left ~99px), where slot + strip simply do not fit and the slot's
 * unconditional height clipped the strip and its follow control out of the pane. The transcript
 * pane is therefore a height-queried container: below the threshold the slot collapses entirely
 * (independent of activity, so toggling recovery still cannot change layout) and active recovery
 * is echoed inside the status strip — the persistent status surface that must always survive.
 *
 * SUMMARY EXCLUSION — the floating pinned summary used to reserve the strip with a hardcoded
 * `calc(100% - 66px)`, which knew nothing of the dynamic-height slot beneath it. Its containing
 * block is now the reader region (the scroller only), so its bounds end above the slot
 * structurally rather than by a pixel constant.
 */
test("short panes keep the status strip, and the pinned summary is bounded by the reader", () => {
  // The pane is a size container so the compact switch keys on the PANE's own height (set by a
  // splitter position), which no viewport media query can observe.
  assert.match(soleRuleBody(".detail-main"), /container:\s*transcript-pane \/ size;/);

  // The compact switch: one height-conditioned container query must collapse the slot and
  // surface the strip echo. Collapsing by pane mode (not by activity) keeps toggles layout-free.
  const compact = /@container transcript-pane \(max-height:\s*\d+px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(compact, "the height-constrained compact mode must exist");
  assert.match(compact![1]!, /\.transcript-recovery-slot\s*\{\s*display:\s*none;\s*\}/,
    "compact mode must collapse the slot so the strip always fits");
  assert.match(compact![1]!, /\.transcript-recovery-strip-echo\s*\{\s*display:\s*inline-flex;\s*\}/,
    "compact mode must surface the in-strip echo in the slot's place");
  // While recovery is active, the fixed-width context meter yields the leading cell: at phone
  // widths it is wider than the whole track and would starve the echo to zero visible label.
  assert.match(compact![1]!,
    /\.transcript-status-context:has\(> \.transcript-recovery-strip-echo\.active\) > \.context-meter\s*\{\s*display:\s*none;\s*\}/,
    "the meter must yield to the active recovery echo in compact mode");

  // The echo's own activity toggle is visibility-only, like the pill's.
  assert.equal(soleRuleBody(".transcript-recovery-strip-echo:not(.active)"), "visibility: hidden;");
  // The strip itself never flexes away beneath the slot.
  assert.match(soleRuleBody(".transcript-status-strip"), /flex:\s*none;/);
  const mobileUsage = soleRuleBody(".transcript-status-usage");
  assert.match(mobileUsage, /min-width:\s*0;/);
  assert.match(mobileUsage, /overflow:\s*hidden;/);
  assert.match(mobileUsage, /text-overflow:\s*ellipsis;/);
  assert.match(mobileUsage, /white-space:\s*nowrap;/);

  // Inbox preview panes always use the compact presentation: the pill band would permanently
  // spend ~47px of a splitter-resizable reader, and shrinking the preview viewport measurably
  // degrades virtualizer paging while freshly streamed rows are still measuring. Mode-based,
  // not activity-based, so recovery toggles stay layout-free in previews too.
  assert.match(soleRuleBody(".session-detail.preview .transcript-recovery-slot"), /display:\s*none;/);
  assert.match(soleRuleBody(".session-detail.preview .transcript-recovery-strip-echo"), /display:\s*inline-flex;/);

  // Full-height phone Sessions deliberately stay in this same compact mode. Both declarations are
  // conditioned on layout, never recovery activity, so active/inactive transitions cannot resize
  // the reader and normal operation reserves no empty slot outside the strip.
  const phone = mediaBlocks(css).find((block) =>
    block.maxWidths.includes(760) &&
    block.containsSelector(".session-detail .transcript-recovery-slot"));
  assert.ok(phone, "the phone layout must collapse the dedicated recovery slot");
  assert.deepEqual(
    phone.declarationsForSelector(".session-detail .transcript-recovery-slot").get("display"),
    ["none"],
  );
  assert.deepEqual(
    phone.declarationsForSelector(".session-detail .transcript-recovery-strip-echo").get("display"),
    ["inline-flex"],
  );
  assert.deepEqual(
    phone.declarationsForSelector(
      ".session-detail .transcript-status-context:has(> .transcript-recovery-strip-echo.active) > .context-meter",
    ).get("display"),
    ["none"],
    "the meter must yield to active recovery in a full-height phone Session too",
  );

  // The pinned summary's containing block is the reader region — which the DOM tests pin as
  // containing the scroller and neither the slot nor the strip — so no pixel reservation for
  // siblings may reappear in its max-height.
  assert.match(soleRuleBody(".detail-reader"), /position:\s*relative;/);
  const summary = soleRuleBody(".pinned-summary");
  assert.match(summary, /max-height:\s*calc\(100% - 24px\);/,
    "the summary reserves only its own top offset and bottom breathing room");
  assert.doesNotMatch(summary, /66px/,
    "the old strip-and-slot pixel reservation must not return");

  // The reader region clips: in panes shorter than the scroller's own padding floor, the
  // scroller would otherwise overflow the reader down over the strip and swallow its clicks.
  assert.match(soleRuleBody(".detail-reader"), /overflow:\s*clip;/,
    "nothing inside the reader may paint or intercept below its bounds");

  // A reader too short to CONTAIN the summary must hide it: a max-height cap cannot shrink the
  // card below its own offset + padding floor, so an escaped card covered the compact strip.
  assert.match(soleRuleBody(".detail-reader"), /container:\s*transcript-reader \/ size;/);
  const shortReader = /@container transcript-reader \(max-height:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(shortReader, "the short-reader mode must exist");
  assert.match(shortReader![2]!, /\.pinned-summary\s*\{\s*display:\s*none;\s*\}/,
    "a reader that cannot contain the summary must hide it, not let it escape over the strip");

  // Threshold COORDINATION, so growing the pane never reduces disclosure: at the first
  // non-compact pane height the slot returns and shrinks the reader — if the summary's hide
  // threshold reached that reader height, dragging a splitter taller would hide the card at
  // the mode switch and only reshow it once the pane out-grew the slot. Derived from the
  // rules' own declarations: nominal slot = slot vertical padding + pill vertical box + one
  // 18px --text-sm line (the pill band's long-documented single-line allowance).
  const paneThreshold = Number(/@container transcript-pane \(max-height:\s*(\d+)px\)/.exec(css)![1]);
  const readerThreshold = Number(shortReader![1]);
  const slotPad = /padding:\s*(\d+)px\s+\d+px\s+(\d+)px;/.exec(soleRuleBody(".transcript-recovery-slot"));
  const pill = soleRuleBody(".transcript-recovery-notice");
  const pillPad = Number(/padding:\s*(\d+)px/.exec(pill)?.[1]);
  const pillBorder = Number(/border:\s*(\d+)px/.exec(pill)?.[1]);
  assert.ok(slotPad && Number.isFinite(pillPad) && Number.isFinite(pillBorder),
    "slot and pill must declare px paddings/borders so the nominal slot height is derivable");
  const nominalSlot = Number(slotPad![1]) + Number(slotPad![2]) + 2 * pillPad + 2 * pillBorder + 18;
  const stripMin = Number(/min-height:\s*(\d+)px/.exec(soleRuleBody(".transcript-status-strip"))![1]);
  const readerAtModeSwitch = paneThreshold + 1 - stripMin - nominalSlot;
  assert.ok(readerThreshold < readerAtModeSwitch,
    `the summary hides at ${readerThreshold}px of reader or less, but the first non-compact ` +
    `pane leaves only ${readerAtModeSwitch}px — growing the pane would re-hide the card`);

  // The compact echo truncates IN PLACE: its grid cell is pinned to its track and the echo to
  // its cell, so a phone-width strip ellipsizes the label instead of pushing it off-screen.
  assert.match(soleRuleBody(".transcript-status-context"), /max-width:\s*100%;/,
    "the strip's leading cell must not outgrow its grid track");
  assert.match(soleRuleBody(".transcript-recovery-strip-echo"), /max-width:\s*100%;/,
    "the echo must not outgrow the strip's leading cell");
  assert.match(soleRuleBody(".transcript-recovery-strip-echo > span:last-child"), /text-overflow:\s*ellipsis;/);
});

test("wrapped code blocks break long prose instead of scrolling sideways", () => {
  // The default stays non-wrapping for source code…
  assert.match(soleRuleBody(".md pre code"), /white-space: pre;/);
  assert.match(soleRuleBody(".md pre"), /overflow-x: auto;/);
  // …and `.md-code-wrap` (prose default or the Wrap Lines toggle) must both wrap preserved
  // newlines and break unbroken runs, or narrow viewports still get a horizontal scrollbar.
  const wrapped = soleRuleBody(".md .md-code-wrap pre code");
  assert.match(wrapped, /white-space: pre-wrap;/);
  assert.match(wrapped, /overflow-wrap: anywhere;/);
});

/** Relative luminance per WCAG 2.1, from a `#rrggbb` token value. */
function luminance(hex: string): number {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Resolve a token to its literal hex in one theme, falling back to the shared root. */
function token(name: string, theme: "dark" | "light"): string {
  const scope = theme === "light"
    ? soleRuleBody(':root[data-theme="light"]')
    : soleRuleBody(':root,\n:root[data-theme="dark"]');
  const shared = soleRuleBody(':root,\n:root[data-theme="dark"]');
  const find = (body: string) => body.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const value = find(scope) ?? find(shared);
  assert.ok(value, `${name} must resolve to a hex value in the ${theme} theme`);
  return value!.toLowerCase();
}

/**
 * Small muted text is the easiest place to drift below AA, and it already happened once: mapping
 * the undefined --muted to --text-faint put 11px governance text at ~4.4:1. These pairs are the
 * ones that render small text directly on a base surface.
 */
test("small muted text clears WCAG AA against its surface in both themes", () => {
  const pairs: Array<[string, string, string]> = [
            ["--text-dim", "--bg", "secondary body text"],
  ];
  for (const theme of ["dark", "light"] as const) {
    for (const [fg, bg, what] of pairs) {
      const ratio = contrast(token(fg, theme), token(bg, theme));
      assert.ok(ratio >= 4.5,
        `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below AA 4.5 — ${what}`);
    }
  }
});

/**
 * The check above proves the TOKENS are safe; this one proves the small-text CONSUMERS actually
 * reference a safe token. Without it, a rule could be pointed back at --text-faint and stay green
 * — which is exactly how the governance regression reached review.
 */
test("small-text consumers reference a token that clears AA on their surface", () => {
  const consumers: Array<[string, string]> = [
    [".governance-audit-heading", "--bg"],
    [".governance-audit-outcome span", "--bg"],
  ];
  for (const [selector, surface] of consumers) {
    const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, "s").exec(css);
    assert.ok(rule, `${selector} must exist`);
    const used = rule![1]!.match(/color:\s*var\((--[a-z0-9-]+)\)/)?.[1];
    assert.ok(used, `${selector} must set colour through a token, not a literal`);
    for (const theme of ["dark", "light"] as const) {
      const ratio = contrast(token(used!, theme), token(surface, theme));
      assert.ok(ratio >= 4.5,
        `${theme}: ${selector} uses ${used} on ${surface} at ${ratio.toFixed(2)}:1, below AA 4.5`);
    }
  }
});
