import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rovingChoiceStop } from "./components/interactions.js";

/**
 * Phase 6, one screen at a time — and a ratchet so the count can only come down.
 *
 * §11.1 counted seventeen ways this app asks "pick one of N". §29 built three primitives to replace
 * fifteen of them (two are legitimately tablists and stay). Adoption is per screen, so for a while
 * both the primitive and the bespoke pattern exist side by side — which is the state in which a new
 * screen copies the wrong one, because the old pattern is still visibly in use.
 *
 * The first version of this file tracked FILES: a list of migrated screens, a list of remaining
 * ones, and three recognised patterns. Review took it apart, correctly:
 *
 * - "migrated" was a claim about a file, and a file passed as soon as it rendered ONE primitive.
 *   `NewSessionDialog` was certified while its project, location, runner, workspace, preset, agent
 *   and target pickers were all still bespoke.
 * - every listed file was SKIPPED by the global scan, so adding a fourth `aria-pressed` group to
 *   `App.tsx` — or a second `.seg` to `ReviewPanel` — was invisible.
 * - only three patterns were recognised, so `.loc-pick`, `.workflow-preset`, `.pod-member-pick`,
 *   `.access-choice`, `.question-option`, `.agent-pick`, `.cbar-opt` and native `<select>` could be
 *   copied into a new screen freely. Two already existed outside the inventory.
 *
 * WHAT THIS CANNOT DO, stated rather than implied. It counts OCCURRENCES of known spellings, not
 * control roots, and it reads text rather than a syntax tree. So a refactor that renames two
 * `.agent-picks` wrappers while adding a third group built from one wrapper and one option site
 * leaves the total unchanged and passes — the numbers below are a floor on how much bespoke markup
 * exists, not a census of how many controls it makes. Role attributes written as expressions, or
 * spread from props, are invisible for the same reason. Closing those needs the TypeScript AST,
 * which is worth doing and is not this PR; what is in scope is that the claim above matches what
 * the code does.
 *
 * So the unit is an OCCURRENCE, not a file. `BASELINE` records exactly how many of each pattern
 * each file contains today, and the scan compares against it exactly. Migrating a control makes
 * this file fail until its number is lowered, which is the point: the number is the inventory, it
 * lives in the diff, and it only ever goes down. Nothing here can stop someone editing a number
 * upwards — a static test cannot — but it cannot happen silently.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** Every way this app still asks "pick one of N" outside the three primitives. */
const PATTERNS = {
  // Announces "toggle button, pressed". On one of N it says nothing about the other options being
  // alternatives, which is the defect — not the styling.
  // Each name is a FAMILY PREFIX, deliberately: `.loc-pick` owns `.loc-pick-row`,
  // `.loc-pick-title` and so on, and every one of them is part of the same bespoke control. A
  // token-boundary version of these patterns was tried and undercounted by half, because it
  // stopped matching exactly the children that make the control what it is.
  "aria-pressed": /aria-pressed/g,
  // Class TOKENS, not substrings of a class attribute: `className="seg compact"` is the same
  // bespoke control and the exact-string version did not see it. `\bseg\b` alone would match the
  // word in prose, which is why this is anchored to a class position.
  seg: /(?:className=")(?:[^"]*\s)?seg(?:\s[^"]*)?"|seg-btn|scope-seg/g,
  "project-visibility-filters": /project-visibility-filters/g,
  "loc-pick": /loc-pick/g,
  "workflow-preset": /workflow-preset/g,
  "pod-member-pick": /pod-member-pick/g,
  "access-choice": /access-choice/g,
  "question-option": /question-option/g,
  "agent-pick": /agent-pick/g,
  "cbar-opt": /cbar-opt/g,
  // A native select cannot show a description or an icon, and cannot explain a disabled option.
  // `Select` replaces the ones that are a CHOICE; some of these are ordinary form fields and will
  // stay, which is why the inventory is per file rather than a prohibition.
  "native-select": /<select[\s>]/g,
  // Raw choice SEMANTICS, for the control that uses none of the names above. A hand-rolled
  // `role="radiogroup"` with `role="radio"` buttons and a fresh class name contributed nothing to
  // the inventory, so a screen could add one and stay "fully migrated" — the ratchet recognised
  // spellings rather than the thing it was counting. The primitives are excluded by file, below,
  // since they are the radiogroups everything else is supposed to use.
  "raw-radiogroup": /role=["'](radiogroup|radio|listbox|option|menuitemradio|menuitemcheckbox|checkbox)["']|type=["'](radio|checkbox)["']/g,
} as const;

type Pattern = keyof typeof PATTERNS;

/**
 * The inventory, exact. `[file, pattern, count]`.
 *
 * Two entries are DELIBERATE and stay: both `aria-pressed` groups are genuine toggles — the
 * pinned-panel, dock and right-panel buttons in `App`, and the follow-tail control in
 * `SessionDetail`. A toggle is what `aria-pressed` is for; it is only wrong when it describes one
 * of N alternatives. They are counted rather than exempted so that a FOURTH one in `App.tsx` fails
 * here instead of hiding behind a whole-file exemption.
 */
const BASELINE: ReadonlyArray<readonly [string, Pattern, number]> = [
  ["App.tsx", "aria-pressed", 3],
  ["components/AddBoxDialog.tsx", "native-select", 1],
  ["components/AgentSessionDiscoveryDialog.tsx", "agent-pick", 1],
  ["components/AutomationsView.tsx", "native-select", 12],
  ["components/Board.tsx", "native-select", 2],
  ["components/BrowserPanel.tsx", "seg", 1],
  ["components/ComposerControls.tsx", "cbar-opt", 4],
  ["components/FilesPanel.tsx", "native-select", 1],
  ["components/FilesPanel.tsx", "seg", 1],
  ["components/GitDiffViewer.tsx", "native-select", 1],
  ["components/NewPodDialog.tsx", "pod-member-pick", 2],
  ["components/NewRunDialog.tsx", "agent-pick", 4],
  ["components/NewRunDialog.tsx", "native-select", 6],
  ["components/NewRunDialog.tsx", "workflow-preset", 3],
  ["components/NewSessionDialog.tsx", "agent-pick", 2],
  ["components/NewSessionDialog.tsx", "loc-pick", 4],
  ["components/NewSessionDialog.tsx", "native-select", 5],
  ["components/NewSessionDialog.tsx", "workflow-preset", 6],
  ["components/OnboardRunnerDialog.tsx", "seg", 2],
  ["components/PeopleDevicesPanel.tsx", "access-choice", 2],
  ["components/PeopleDevicesPanel.tsx", "native-select", 4],
  ["components/PodsView.tsx", "native-select", 8],
  ["components/ProjectLocationDialog.tsx", "native-select", 1],
  ["components/ReviewPanel.tsx", "seg", 3],
  ["components/SessionApproval.tsx", "question-option", 2],
  ["components/SessionDetail.tsx", "aria-pressed", 1],
  ["components/SessionHeader.tsx", "native-select", 1],
  /* Raw choice markup, found only once the inventory started counting semantics rather than
     class names. These are bespoke controls phase 6 has not reached yet.
     SettingsView used to be the one exception — a hand-rolled radiogroup wrapping RadioRow
     primitives, counted rather than exempted so that a second one appearing there would fail here.
     It is gone: Appearance's three settings are SegmentedRow and SelectRow now, and both own their
     semantics inside the primitives file. The entry came off with the control, which is the
     ratchet working rather than an exemption being granted. */
  ["components/AgentSessionDiscoveryDialog.tsx", "raw-radiogroup", 1],
  ["components/BrowserPanel.tsx", "raw-radiogroup", 2],
  ["components/FilesPanel.tsx", "raw-radiogroup", 3],
  ["components/NewRunDialog.tsx", "raw-radiogroup", 5],
  ["components/NewSessionDialog.tsx", "raw-radiogroup", 13],
  ["components/OnboardRunnerDialog.tsx", "raw-radiogroup", 2],
  ["components/PeopleDevicesPanel.tsx", "raw-radiogroup", 3],
  ["components/ReviewPanel.tsx", "raw-radiogroup", 9],
  ["components/SessionApproval.tsx", "raw-radiogroup", 2],
  ["components/AutomationsView.tsx", "raw-radiogroup", 2],
  ["components/CommandPalette.tsx", "raw-radiogroup", 2],
  // Like CommandPalette, this is transient command navigation rather than a persisted setting or
  // one-of-N form choice. Listbox/option is the correct combobox popup contract for its textarea.
  ["components/SlashCommandMenu.tsx", "raw-radiogroup", 2],
  ["components/ComposerControls.tsx", "raw-radiogroup", 4],
  ["components/EditorSelect.tsx", "raw-radiogroup", 1],
  ["components/GitDiffViewer.tsx", "raw-radiogroup", 3],
  ["components/InstanceSelector.tsx", "raw-radiogroup", 1],
  ["components/NewPodDialog.tsx", "raw-radiogroup", 1],
  ["components/PodsView.tsx", "raw-radiogroup", 2],
  /* Down from 6 on 2026-08-12: the Move to Project dialog adopted ChoiceCards, retiring the
     durable Project chip's bespoke menuitemradio popover. */
  ["components/SessionDetail.tsx", "raw-radiogroup", 4],
];

/**
 * Screens with NOTHING left from the inventory.
 *
 * This is what "migrated" now means, and it is checked against the scan rather than asserted: a
 * screen on this list must contribute zero occurrences AND render a primitive. The first version
 * accepted a file that rendered one primitive while keeping seven bespoke controls.
 */
const FULLY_MIGRATED = [
  "components/UsageView.tsx",
  "components/ProjectsView.tsx",
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    // `src/e2e` is Playwright HARNESS markup, and several of those files reproduce production's
    // bespoke controls on purpose — that is the point of a fixture that measures what the real
    // screens render. Counting them inventories the same control twice and reports a fixture as
    // debt. They are reachable only from a harness page, never from the app.
    if (entry === "e2e" && statSync(path).isDirectory()) continue;
    if (statSync(path).isDirectory()) { sourceFiles(path, out); continue; }
    if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * Comments AND import statements stripped.
 *
 * The comments go because this file's own explanations name every pattern it forbids. The imports
 * go because `workflow-preset` matched `from "./workflow-presets.js"` — so two files' baselines
 * counted a module path as a control, and renaming that module would have freed a slot for a real
 * bespoke control to fill without moving the total. A count that includes things that are not
 * controls is not the inventory it claims to be.
 */
/**
 * The stripping itself, as a function, because the test below has to exercise THIS code and not a
 * copy of these regexes. A copy tests that two identical expressions agree.
 */
export function markupOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*/g, " ")
    // `[^;]` rather than `[\s\S]`: the lazy any-character version could run from a side-effect
    // import across everything up to a LATER statement's `from`, deleting real markup in between.
    // A mutation caught it — the fixture below only passed because that swallowing happened to
    // remove the line the assertion was about.
    .replace(/^\s*import\s[^;]*?from\s+["'][^"']+["'];?/gm, " ")
    .replace(/^\s*export\s+\{[^;]*?\}\s+from\s+["'][^"']+["'];?/gm, " ")
    // Side-effect imports too: `import "./agent-pick.css";` contributed a fake occurrence, and
    // deleting it while adding a real one left the total unchanged — the exact masking the
    // import-stripping was added to remove, one syntax down.
    .replace(/^\s*import\s+["'][^"']+["'];?/gm, " ")
    .replace(/import\(\s*[`"'][^`"']+[`"'][\s\S]*?\)/g, " ");
}

const read = (path: string) => markupOnly(readFileSync(path, "utf8"));

const relative = (path: string) => path.slice(SRC.length).replace(/\\/g, "/");

/**
 * The primitives themselves.
 *
 * `raw-radiogroup` counts the markup a bespoke choice control is made of, and these three files are
 * where that markup is SUPPOSED to live — they are the radiogroups every migrated screen renders.
 * Counting them would make the inventory grow every time a primitive gained a role attribute.
 */
const PRIMITIVES = new Set([
  "components/ui/ChoiceControls.tsx",
  "components/ui/SettingsRows.tsx",
]);

function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const path of sourceFiles(SRC)) {
    if (PRIMITIVES.has(relative(path))) continue;
    const source = read(path);
    for (const [name, pattern] of Object.entries(PATTERNS) as [Pattern, RegExp][]) {
      const count = (source.match(new RegExp(pattern.source, "g")) ?? []).length;
      if (count) found.set(`${relative(path)}:${name}`, count);
    }
  }
  return found;
}

const key = (file: string, pattern: string) => `${file}:${pattern}`;

test("the inventory matches the source exactly", () => {
  const found = scan();
  const expected = new Map(BASELINE.map(([file, pattern, count]) => [key(file, pattern), count]));

  const unexpected = [...found].filter(([k]) => !expected.has(k)).map(([k, n]) => `${k} × ${n}`);
  assert.deepEqual(unexpected, [],
    "a bespoke choice control appeared where the inventory does not know about one; " +
    "migrate it, or add it to BASELINE if it is genuinely not one of §11.1's seventeen");

  const grown = [...expected]
    .filter(([k, n]) => (found.get(k) ?? 0) > n)
    .map(([k, n]) => `${k}: ${found.get(k)} now, ${n} recorded`);
  assert.deepEqual(grown, [], "the count of a bespoke pattern may never go up");

  const stale = [...expected]
    .filter(([k, n]) => (found.get(k) ?? 0) < n)
    .map(([k, n]) => `${k}: ${found.get(k) ?? 0} now, ${n} recorded`);
  assert.deepEqual(stale, [],
    "a control was migrated without lowering its number here; the inventory IS the ratchet, " +
    "so it has to move in the same commit");
});

test("a fully migrated screen keeps nothing from the inventory", () => {
  const found = scan();
  const offenders: string[] = [];
  for (const name of FULLY_MIGRATED) {
    for (const pattern of Object.keys(PATTERNS)) {
      const count = found.get(key(name, pattern));
      if (count) offenders.push(`${name}: ${count} × ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [],
    "a screen is listed as fully migrated but still renders a bespoke choice control");
});

test("a fully migrated screen renders a primitive", () => {
  // The check above passes trivially if a screen simply deletes its control. This is the other
  // half — and it looks for a RENDERED element: matching the bare name passed against a screen
  // whose primitive had been renamed and therefore rendered nothing.
  for (const name of FULLY_MIGRATED) {
    assert.match(read(join(SRC, name)), /<(SegmentedControl|ChoiceCards|Select)[\s/>]/,
      `${name} is listed as fully migrated but renders no choice primitive`);
  }
});

test("the screens the primitives have reached are the ones that use them", () => {
  // A screen can adopt a primitive for ONE of its controls while others remain — NewSessionDialog
  // is exactly that, and the first version of this file called it migrated. Partial adoption is
  // fine and expected; what is not fine is a file claiming to be finished while its inventory
  // entries stand, which the two tests above now separate.
  const partial = read(join(SRC, "components/NewSessionDialog.tsx"));
  assert.match(partial, /<SegmentedControl/, "the harness picker moved onto the primitive");
  assert.ok(BASELINE.some(([file]) => file === "components/NewSessionDialog.tsx"),
    "and the rest of its pickers are still counted, because they are still bespoke");
});

test("a roving choice group always has exactly one tab stop", () => {
  // Three rounds of review found three branches of the same defect, each shipped without the next.
  // The last one — every option disabled — took the stop off ALL of them, so the group vanished
  // from the tab order and a keyboard user could not reach the explanation of why it was
  // unavailable. No error is raised by an unreachable group, which is why it survived twice.
  const stops = (options: { selected: boolean; disabled?: boolean }[]) => rovingChoiceStop(options);

  assert.equal(stops([{ selected: false }, { selected: true }, { selected: false }]), 1,
    "the selected option carries the stop");
  assert.equal(stops([{ selected: false }, { selected: false }]), 0,
    "with nothing selected it falls to the first option");
  assert.equal(stops([{ selected: true, disabled: true }, { selected: false }]), 1,
    "a selected-but-disabled option cannot hold the stop");
  assert.equal(stops([{ selected: false, disabled: true }, { selected: false }]), 1,
    "and a disabled first option cannot either");
  assert.equal(stops([{ selected: true, disabled: true }, { selected: false, disabled: true }]), 0,
    "when every option is disabled the group must STILL be reachable");
  assert.equal(stops([]), -1, "an empty group has nothing to focus");

  // Exactly one, for every arrangement of up to four options — the property the ternary chain in
  // ChoiceControls was expressing, stated once rather than re-derived per primitive.
  for (let size = 1; size <= 4; size += 1) {
    for (let bits = 0; bits < 1 << (2 * size); bits += 1) {
      const options = Array.from({ length: size }, (_, i) => ({
        selected: Boolean(bits & (1 << (2 * i))),
        disabled: Boolean(bits & (1 << (2 * i + 1))),
      }));
      const stop = rovingChoiceStop(options);
      assert.ok(stop >= 0 && stop < size,
        `a group of ${size} must have a stop inside it, got ${stop} for ${JSON.stringify(options)}`);
    }
  }
});

test("the scanner counts controls, not module paths", () => {
  // `workflow-preset` matched `from "./workflow-presets.js"`, so two baselines counted an import as
  // a control. That is not a rounding error: renaming the module would have freed a slot for a real
  // bespoke control to fill without moving the recorded total.
  const fixture = [
    'import { WORKFLOW_PRESETS } from "./workflow-presets.js";',
    'export { thing } from "./loc-pick-helpers.js";',
    'const lazy = await import("./agent-picker.js");',
  ].join(String.fromCharCode(10));
  const stripped = markupOnly(fixture);
  for (const name of ["workflow-preset", "loc-pick", "agent-pick"]) {
    assert.ok(!stripped.includes(name), `${name} was counted from a module path`);
  }
});

test("the scanner sees a class TOKEN, not an exact attribute", () => {
  // `className="seg compact"` is the same bespoke control, and the exact-string version did not
  // see it — so the family the pattern claimed to cover had a hole the width of one extra class.
  const pattern = PATTERNS.seg;
  for (const sample of ['className="seg"', 'className="seg compact"', 'className="compact seg"']) {
    assert.match(sample, new RegExp(pattern.source), `${sample} is a bespoke .seg control`);
  }
  // And not the word in prose, which is what a bare boundary match would have caught.
  assert.doesNotMatch("the seg control", new RegExp(PATTERNS.seg.source));
});

test("a hand-rolled radiogroup is counted even with a brand-new class name", () => {
  // The inventory recognised SPELLINGS. A screen could add `className="sort-options"` with
  // `role="radio"` buttons, contribute nothing to any named family, and stay "fully migrated".
  const sample = '<div role="radiogroup" className="sort-options"><button role="radio" /></div>';
  assert.match(sample, new RegExp(PATTERNS["raw-radiogroup"].source),
    "raw choice semantics are the thing being counted; the class name is incidental");
});

test("the scanner strips every import syntax, not the two it started with", () => {
  // A side-effect import contributed a fake occurrence: `import "./agent-pick.css";` counted as an
  // agent-pick, so deleting it while adding a real one left the total unchanged. That is the exact
  // masking the first round of import-stripping was added to remove, one syntax down.
  const fixture = [
    'import { WORKFLOW_PRESETS } from "./workflow-presets.js";',
    'import "./agent-pick.css";',
    'export { thing } from "./loc-pick-helpers.js";',
    'const lazy = await import("./pod-member-pick.js");',
    'const dyn = await import(`./access-choice.js`);',
  ].join(String.fromCharCode(10));
  const stripped = markupOnly(fixture);
  for (const name of ["workflow-preset", "agent-pick", "loc-pick", "pod-member-pick", "access-choice"]) {
    assert.ok(!stripped.includes(name), `${name} was counted from a module path`);
  }

  // And it must strip ONLY the import. The lazy `[\s\S]*?` this started with could run from a
  // side-effect import all the way to a later statement's `from`, deleting the markup in between —
  // which would hide real controls rather than merely miscount them, and which the fixture above
  // could not see because everything in it was an import.
  const interleaved = [
    'import "./setup.css";',
    'const control = <div className="seg" />;',
    'import { thing } from "./elsewhere.js";',
  ].join(String.fromCharCode(10));
  assert.ok(markupOnly(interleaved).includes('className="seg"'),
    "stripping an import must not take the markup after it");
});

test("the semantic pattern covers the choice families, not just radiogroups", () => {
  // It recognised `role="radiogroup"`, `role="radio"` and native radios — so a hand-rolled listbox,
  // a menu of `menuitemradio`s, or a checkbox group contributed nothing at all, and a screen could
  // add one and stay fully migrated. Single quotes were invisible too.
  const pattern = () => new RegExp(PATTERNS["raw-radiogroup"].source);
  for (const sample of [
    '<div role="radiogroup">', "<div role='radiogroup'>", '<div role="listbox">', '<li role="option">',
    '<button role="menuitemradio">', '<button role="menuitemcheckbox">', '<span role="checkbox">',
    '<input type="radio" />', '<input type="checkbox" />',
  ]) {
    assert.match(sample, pattern(), `${sample} is a choice control`);
  }
  // And not a word that merely contains one of these.
  assert.doesNotMatch('<div className="radiogroup-ish">', pattern());
});
