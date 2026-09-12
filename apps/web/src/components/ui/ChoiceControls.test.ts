import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SELECT_LIST_CHROME_PX,
  SELECT_MENU_MAX_HEIGHT_PX,
  TOUCH_OPTION_MIN_HEIGHT_PX,
  filterSearchableComboboxOptions,
  selectMenuDesiredHeight,
} from "./ChoiceControls.js";

const SEARCH_OPTIONS = [
  { value: "alpha", label: "Dashboard", description: "~/dev/alpha", keywords: ["local", "primary"] },
  { value: "beta", label: "Dashboard", description: "runner-two · /srv/beta", keywords: ["remote"] },
  {
    value: "gamma",
    label: "Review Agent",
    disabled: true,
    disabledReason: "Setup Required",
  },
  { value: "delta", label: "Ready Agent", disabledReason: "Stale Setup Reason" },
] as const;

test("searchable combobox filtering is case-insensitive and matches visible context", () => {
  assert.deepEqual(
    filterSearchableComboboxOptions(SEARCH_OPTIONS, "DASHBOARD beta").map((option) => option.value),
    ["beta"],
    "all query terms may match across the label and disambiguating description",
  );
  assert.deepEqual(
    filterSearchableComboboxOptions(SEARCH_OPTIONS, "LOCAL").map((option) => option.value),
    ["alpha"],
    "callers can add already-authorized search terms without rendering private metadata",
  );
});

test("searchable combobox filtering preserves source order and unavailable results", () => {
  assert.deepEqual(
    filterSearchableComboboxOptions(SEARCH_OPTIONS, "").map((option) => option.value),
    ["alpha", "beta", "gamma", "delta"],
  );
  assert.deepEqual(
    filterSearchableComboboxOptions(SEARCH_OPTIONS, "setup").map((option) => option.value),
    ["gamma"],
    "an unavailable option remains discoverable by the rendered reason that explains it",
  );
  assert.deepEqual(filterSearchableComboboxOptions(SEARCH_OPTIONS, "stale"), [],
    "a reason that is not rendered on an enabled option cannot create an invisible match");
});

/**
 * The open list asks the anchored-menu helper for a height, and the helper turns that request into
 * a `max-height`. So a request SMALLER than what the options render is not a shorter list — it is a
 * clipped one, and the user gets a scrollbar on a menu that had room to fit.
 *
 * #832 was exactly that, on the control least able to afford it. Permission Preset has two options;
 * the estimator budgeted 34px for an undescribed one and asked for `2 × 34 + 8 = 76px`, while the
 * coarse-pointer stylesheet gives every `.ui-select-option` a 44px touch target. 98px of content in
 * a 76px box scrolls, and half of "Orchestrator" — one of only two choices — was below the fold on
 * a phone.
 *
 * These are the arithmetic, kept as a pure function precisely so the disagreement between the guess
 * and the stylesheet is checkable without a layout engine. The rendered-pixel half is a real
 * browser's job and lives in the mobile E2E spec.
 */

test("a two-option list on a touch device asks for the height its touch targets render", () => {
  // The defect, stated as the number it produced: 76px requested, 98px rendered.
  const height = selectMenuDesiredHeight({ optionCount: 2, maxOptionLines: 1, coarsePointer: true });
  assert.equal(height, 2 * TOUCH_OPTION_MIN_HEIGHT_PX + SELECT_LIST_CHROME_PX);
  assert.ok(height >= 98, `a two-option touch list needs at least 98px, asked for ${height}`);
});

test("the touch floor raises the per-option budget without lowering a taller estimate", () => {
  // A described option is already taller than the touch minimum, so the floor must not touch it.
  // Taking a `Math.min` here — or applying the floor as a replacement rather than a floor — would
  // clip two-line options on exactly the devices this fix is for.
  const described = selectMenuDesiredHeight({ optionCount: 2, maxOptionLines: 2, coarsePointer: true });
  assert.equal(described, 2 * 52 + SELECT_LIST_CHROME_PX);

  const explicitTall = selectMenuDesiredHeight({
    optionCount: 2,
    maxOptionLines: 1,
    estimatedOptionHeight: 96,
    coarsePointer: true,
  });
  assert.equal(explicitTall, 2 * 96 + SELECT_LIST_CHROME_PX,
    "a caller who budgeted MORE than the touch floor keeps its own number");
});

test("a mouse pointer keeps the compact estimate", () => {
  // The 44px floor is what the stylesheet applies under `(pointer: coarse)`; asking for it on a
  // desktop would make every short menu taller than the rows it draws, leaving dead space under
  // the last option. The two numbers have to agree with the CSS, not merely be generous.
  assert.equal(
    selectMenuDesiredHeight({ optionCount: 2, maxOptionLines: 1, coarsePointer: false }),
    2 * 34 + SELECT_LIST_CHROME_PX,
  );
});

test("a long list is still capped, because scrolling IS the answer there", () => {
  // The cap is not the bug. A twenty-option list cannot fit, and a request that tried would be
  // clamped to the viewport by the anchored-menu helper anyway.
  const height = selectMenuDesiredHeight({ optionCount: 20, maxOptionLines: 1, coarsePointer: true });
  assert.equal(height, SELECT_MENU_MAX_HEIGHT_PX);
});

test("an empty list still asks for a box its empty message fits in", () => {
  // `options.length` of 0 multiplied out to the chrome alone, which is an 10px sliver — the
  // "Nothing to choose from" paragraph inside it had nowhere to render.
  const height = selectMenuDesiredHeight({ optionCount: 0, maxOptionLines: 1, coarsePointer: false });
  assert.ok(height >= 34 + SELECT_LIST_CHROME_PX, `an empty list asked for ${height}`);
});

test("every option count that fits the cap is given room for its rows", () => {
  // The property the arithmetic above expresses, rather than the four examples that motivated it:
  // below the cap, the request is never less than rows × the floor the stylesheet enforces.
  for (const coarsePointer of [true, false]) {
    const floor = coarsePointer ? TOUCH_OPTION_MIN_HEIGHT_PX : 34;
    for (let optionCount = 1; optionCount <= 12; optionCount += 1) {
      const height = selectMenuDesiredHeight({ optionCount, maxOptionLines: 1, coarsePointer });
      const rendered = optionCount * floor + SELECT_LIST_CHROME_PX;
      assert.ok(height >= Math.min(rendered, SELECT_MENU_MAX_HEIGHT_PX),
        `${optionCount} options at ${floor}px render ${rendered}px but asked for ${height}px`);
    }
  }
});

/**
 * Round 1 of #986's review found the same defect class this file exists to guard, reintroduced from
 * the other side.
 *
 * An option renders up to THREE lines — its label, its description, and, when refused, its reason —
 * but the budget was computed from `description` alone and topped out at two lines. Giving
 * Execution Target a `disabledReason` therefore produced exactly #832's symptom again: a list
 * asking for less height than it draws, and an option half-hidden behind a scrollbar.
 *
 * The budget is now per RENDERED LINE, so the caller cannot introduce a line the estimate does not
 * know about.
 */

test("an option that renders a reason as well as a description is budgeted for three lines", () => {
  const twoLine = selectMenuDesiredHeight({ optionCount: 3, maxOptionLines: 2, coarsePointer: false });
  const threeLine = selectMenuDesiredHeight({ optionCount: 3, maxOptionLines: 3, coarsePointer: false });
  assert.ok(threeLine > twoLine,
    `three lines must ask for more than two; got ${threeLine} and ${twoLine}`);
  // The extra line costs the same as the second one did, rather than a new invented constant.
  assert.equal(threeLine - twoLine, twoLine - selectMenuDesiredHeight({
    optionCount: 3, maxOptionLines: 1, coarsePointer: false,
  }));
});

test("the one- and two-line budgets are unchanged by the per-line rewrite", () => {
  // The previous behaviour, restated so the refactor cannot quietly move the cases that worked.
  assert.equal(
    selectMenuDesiredHeight({ optionCount: 2, maxOptionLines: 1, coarsePointer: false }),
    2 * 34 + SELECT_LIST_CHROME_PX,
  );
  assert.equal(
    selectMenuDesiredHeight({ optionCount: 2, maxOptionLines: 2, coarsePointer: false }),
    2 * 52 + SELECT_LIST_CHROME_PX,
  );
});

test("the touch floor still applies to a multi-line option", () => {
  // A three-line option is already taller than 44px, so the floor must not pull it DOWN.
  const height = selectMenuDesiredHeight({ optionCount: 2, maxOptionLines: 3, coarsePointer: true });
  assert.equal(height, selectMenuDesiredHeight({ optionCount: 2, maxOptionLines: 3, coarsePointer: false }));
});
