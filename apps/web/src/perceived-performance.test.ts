import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarationsOf, rulesWith } from "./css-rules.js";

/**
 * Phase 7's acceptance is "measured — React Profiler commit counts during a streaming turn, before
 * vs after; INP on inbox navigation and search typing". That is a benchmark, not a test, and a
 * benchmark asserted as a test is a flake: commit counts and INP both move with machine load.
 *
 * So these assert the STRUCTURAL preconditions instead, each of which is the thing that makes the
 * measurement possible, and each of which regresses silently:
 *
 * - the long list is windowed rather than fully mounted
 * - the row that renders once per item is memoised
 * - typing is decoupled from filtering
 * - the scrolling containers do not repaint blurred shadows on every frame
 *
 * What they cannot say is "the app feels faster". Nothing static can. They can say that the four
 * things phase 7 did are still done, which is what stops the work being quietly undone.
 */

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
/**
 * Source with comments stripped. These tests quote the very patterns they forbid — a comment saying
 * "`onSelect: () => …` defeats the memo" is not an instance of the defect, and matching it made the
 * test fail on its own explanation.
 */
const src = (name: string) => read(name).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*/g, " ");
const css = read("./styles.css");

test("the inbox list is windowed, not fully mounted", () => {
  const list = src("./components/InboxList.tsx");
  // §F7 flagged this as the one unvirtualized list, and it is the longest: 200 sessions meant 200
  // mounted rows, each with its own activity subscription.
  assert.match(list, /<MeasuredVirtualList/,
    "InboxList must window its rows the way Board and EventTimeline already do");
  assert.doesNotMatch(list, /entries\.map\(/,
    "a bare .map over entries mounts every row, which is what windowing replaced");
});

test("the memoised rows receive STABLE callbacks", () => {
  const list = src("./components/InboxList.tsx");
  // `onSelect: () => onSelect(session.id)` builds a new closure on every render, so every row's
  // props differ by identity and the memo compares unequal every time. The memoisation looks
  // applied and does nothing, which is worse than not applying it — it reads as done.
  assert.doesNotMatch(list, /onSelect:\s*\(\)\s*=>/,
    "wrapping the callback per row defeats the memo it was added for");
  assert.doesNotMatch(list, /onExpand:\s*\(\)\s*=>/,
    "wrapping the callback per row defeats the memo it was added for");
});

test("the row callbacks are stable at their SOURCE, not just where they are passed", () => {
  const view = src("./components/InboxView.tsx");
  // Passing them through InboxList unwrapped changed nothing while InboxView rebuilt them inline on
  // every render: every mounted row still received unequal props and failed the shallow compare.
  // The memo was applied in one file and defeated in another.
  assert.match(view, /const handleSelect = useCallback\(/,
    "the select handler must be stable across renders, not rebuilt inline");
  assert.doesNotMatch(view, /onSelect=\{\(sessionId\) =>/,
    "an inline arrow at the call site is a fresh identity per render");
  assert.match(view, /onExpand=\{expand\}/,
    "expand is already memoised; wrapping it discards that");

  // And the SOURCE is not InboxView. The chain runs Shell -> expand -> handleSelect -> row props, so
  // an inline arrow at the top rebuilt all three: a session upsert anywhere re-rendered every
  // visible row, memo or not. Stabilising two links of a three-link chain stabilises nothing.
  const app = src("./App.tsx");
  assert.match(app, /const expandSession = useCallback\(/,
    "the shell's expansion handler is the first link; an inline arrow there defeats the rest");
  assert.match(app, /onExpand=\{expandSession\}/,
    "the stable handler has to be the one actually passed");
});

test("the list ref is published when the NODE changes, not on every commit", () => {
  const list = src("./components/InboxList.tsx");
  // `useImperativeHandle` with no dependency array republishes on every commit — React first calls
  // the previous ref with null, and InboxView's callback ref reapplies the cached scrollTop when it
  // fires. After a filter the virtualizer has just corrected scrollTop to hold the logical anchor,
  // and the republished handle overwrote that correction. With `[]` it was worse: the handle froze
  // on the first render, which for the inbox is the empty state that never attaches anything.
  assert.doesNotMatch(list, /useImperativeHandle/,
    "a handle republished per commit fights the virtualizer's scroll anchoring");
  assert.match(list, /const attachList = useCallback\(\(node: HTMLDivElement \| null\) => \{/,
    "a callback ref fires on attach and detach, which is the event both sides actually want");
  assert.match(list, /ref=\{attachList\}/,
    "the composed ref has to be the one on the scroll container");
});

test("leaving search waits for the deferred query before moving focus", () => {
  const view = src("./components/InboxView.tsx");
  // Clearing the query re-renders urgently with the OLD deferred value, so the zero state is still
  // mounted a frame later. A requestAnimationFrame handoff focused `.inbox-zero`, and the deferred
  // commit then replaced that node — dropping focus to <body>. Deferral is what made this possible.
  assert.doesNotMatch(view, /exitSearch[\s\S]{0,200}requestAnimationFrame/,
    "a frame is not long enough; the handoff must wait for the deferred value");
  assert.match(view, /query !== "" \|\| deferredQuery !== ""/,
    "the handoff runs only once both the immediate and deferred queries have converged");
  // A REF cannot schedule the effect. Escape in an already-empty box made `setQuery("")` a no-op,
  // nothing in the dependency list changed, and focus never left the input — so the request has to
  // be state, and the effect has to depend on it.
  assert.match(view, /const \[exitPending, setExitPending\] = useState\(/,
    "a pending focus handoff has to be something React re-renders on");
  assert.match(view, /\}, \[exitPending, query, deferredQuery\]\)/,
    "the handoff effect must re-run when the request is made, not only when the query changes");
});

test("typing cancels a pending focus handoff", () => {
  const view = src("./components/InboxView.tsx");
  // Escape on a nonempty query, then a new search before the deferred value converged, left the
  // request armed; clearing the second search fired it and stole focus mid-typing.
  assert.match(view, /const changeQuery = useCallback\(\(next: string\) => \{[\s\S]{0,160}setExitPending\(false\)/,
    "an ordinary input change must invalidate the outstanding request");
  assert.match(view, /onChange=\{\(event\) => changeQuery\(event\.target\.value\)\}/,
    "the input must go through the invalidating setter, not setQuery directly");
});

test("the row the list points at is pinned into the mounted range", () => {
  const list = src("./components/InboxList.tsx");
  // The list keeps DOM focus on itself and names its row through aria-activedescendant, so the
  // extractor's focused-row pin never fires — and the id must refer to a mounted element.
  assert.match(list, /pinnedKey=\{selectedSessionId\}/,
    "an aria-activedescendant target that is windowed out points at nothing");
});

test("the per-row components are memoised", () => {
  for (const name of ["InboxRow", "ActivityStrip"]) {
    const source = src(`./components/${name}.tsx`);
    // These render once per row while their parent re-renders on every store update, so a status
    // change anywhere in the inbox re-rendered every row in it.
    assert.match(source, new RegExp(`export const ${name} = memo\\(`),
      `${name} renders per row and must not re-render with its parent`);
  }
});

test("typing is decoupled from filtering", () => {
  const view = src("./components/InboxView.tsx");
  assert.match(view, /useDeferredValue/,
    "the search input must stay on the immediate value while filtering reads the deferred one");
  // The INPUT must not read the deferred value, or every keystroke lags by a frame — the opposite
  // of the intent, and an easy thing to do by accident when wiring this up.
  assert.doesNotMatch(view, /value=\{deferredQuery\}/,
    "the input renders the immediate query; only the filtering is deferred");
  assert.match(view, /const normalizedQuery = deferredQuery/,
    "the filtering must actually consume the deferred value");
});

test("the scrolling containers do not paint blurred shadows on focus", () => {
  const focusRules = rulesWith(css, ["outline"])
    .filter(({ selector }) => /\.inbox-list:focus-visible|\.detail-scroll:focus-visible/.test(selector));
  assert.ok(focusRules.length > 0, "the scroll containers must declare a focus outline");

  // Four 30px-blur inset shadows on a SCROLLING container repaint on every frame of every scroll,
  // which is the one place in the app where paint cost is felt continuously.
  for (const { selector, value } of declarationsOf(css, "box-shadow")) {
    if (!/\.inbox-list:focus-visible|\.detail-scroll:focus-visible/.test(selector)) continue;
    const layers = value.split(/,(?![^()]*\))/).length;
    assert.ok(layers <= 1, `${selector} paints ${layers} shadow layers while scrolling`);
  }
});

test("the disclosures do not claim a height they do not have", () => {
  // `content-visibility: auto` was added to the collapsed disclosures on the theory that an
  // off-screen collapsed subtree still lays out and paints. It does not: `.tl-work`/`.tl-subagent`
  // project their children as sibling rows only while OPEN, so a collapsed wrapper holds just its
  // ~32px header — and `contain-intrinsic-size: auto 120px` then invented ~88px per group, shifting
  // a long Side Chat as those groups neared the viewport. A wrong height is worse than no skipping.
  for (const { selector } of declarationsOf(css, "contain-intrinsic-size")) {
    assert.doesNotMatch(selector, /\.tl-work|\.tl-subagent/,
      `${selector} does not own its collapsed subtree, so any intrinsic size it declares is phantom`);
  }
  for (const { selector, value } of declarationsOf(css, "content-visibility")) {
    if (!/^auto$/.test(value.trim())) continue;
    assert.doesNotMatch(selector, /\.tl-work|\.tl-subagent/,
      `${selector} has nothing off-screen to skip when collapsed`);
  }
});

test("the virtualized inbox exposes ONE structure", () => {
  const list = src("./components/InboxList.tsx");
  // Virtualizing put a separately named `role="list"` inside the `role="grid"`, with the actual
  // rows buried under `role="listitem"` wrappers — two nested structures where there is one table,
  // and the position metadata on the wrappers rather than on the rows a grid exposes.
  assert.match(list, /rootRole="rowgroup"/,
    "a grid may contain a rowgroup; it may not contain a second named list");
  assert.match(list, /rowRole="presentation"/,
    "the positioned wrappers must flatten so the rows are the grid's rows");
  assert.doesNotMatch(list, /ariaLabel="Sessions"/,
    "the grid is already named Sessions; naming the inner structure too creates a second landmark");

  // Position has to survive windowing: only a dozen rows are mounted, so without these a screen
  // reader reads the tenth session of two hundred as "row 1 of 12".
  assert.match(list, /aria-rowcount=\{entries\.length\}/,
    "the grid's row count is the whole inbox, not the mounted window");
  assert.match(list, /rowIndex: index \+ 1/, "each row needs its position in the whole inbox");
  assert.match(src("./components/InboxRow.tsx"), /aria-rowindex=\{rowIndex\}/,
    "the index belongs on the row element itself");
});

test("the Projects placeholder reserves the layout it replaces", () => {
  const projects = src("./components/ProjectsView.tsx");
  // Six 44px rows reserved ~296px for a layout whose grid alone has a 720px minimum, so the load
  // ended in a ~500px jump — the exact thing a skeleton exists to prevent. Mounting it inside the
  // real grid makes the reservation exact by construction rather than by a copied number.
  // The guard must BE the placeholder, not sit in front of one. Slicing a region and looking for
  // the right markup inside it passed happily when an early `return <Skeleton />` was put ahead of
  // the block — the region still contained the good markup, now unreachable.
  assert.doesNotMatch(projects, /if \(!snapshotLoaded\) return/,
    "a one-line return cannot render the intro and the grid the placeholder has to reserve");
  const guards = projects.match(/!snapshotLoaded/g) ?? [];
  assert.equal(guards.length, 1, "one loading guard, so there is no second unreachable branch");
  const loading = projects.slice(projects.indexOf("if (!snapshotLoaded)"), projects.indexOf("if (!projectsSupported)"));
  assert.match(loading, /project-manager-grid/,
    "the placeholder must occupy the container the content will fill");
  assert.match(loading, /projects-intro/,
    "the intro is static copy; withholding it is a jump with no reason behind it");

  // `.skeleton { flex: 1 }` claimed to reserve the space and could not: `.main-body` is a flex
  // ITEM, not a flex container, so the declaration never applied to anything.
  const skeleton = declarationsOf(css, "flex").filter(({ selector }) => /^\.skeleton$/.test(selector.trim()));
  assert.deepEqual(skeleton, [], "a flex child rule on a non-flex parent reserves nothing");
});

test("a slow load shows the shape of what is coming", () => {
  const common = src("./components/common.tsx");
  assert.match(common, /export function Skeleton\(/);
  // A skeleton that announces each placeholder row would read eight empty rows to a screen reader.
  assert.match(common, /aria-hidden="true"/,
    "the placeholder rows are decorative; one live region names the wait");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}\.skeleton-row/,
    "the sweep is the only thing saying 'still working', so it needs a reduced-motion form");
});
