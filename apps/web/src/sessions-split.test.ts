import assert from "node:assert/strict";
import test from "node:test";
import { INBOX_SPLIT_RATIO_DEFAULT, INBOX_SPLIT_RATIO_MAX, INBOX_SPLIT_RATIO_MIN, clampInboxSplitRatio } from "./inbox.js";
import {
  SESSIONS_LIST_MIN_ROWS,
  SESSIONS_PREVIEW_MIN_PX,
  sessionsListHeight,
  sessionsListPercent,
  sessionsListRowRange,
  sessionsListRowsForHeight,
  sessionsListRowsForRatio,
  sessionsRatioForRows,
  type SessionsSplitGeometry,
} from "./sessions-split.js";

/** 1440×900 on a fine pointer: 800px under the page header, 56px rows, an 8px top pad. */
const DESKTOP: SessionsSplitGeometry = { area: 800, rowHeight: 56, pad: 8 };
/** 834×1112 on touch: 64px rows. */
const TABLET: SessionsSplitGeometry = { area: 1000, rowHeight: 64, pad: 8 };

test("the default ratio rounds down to whole rows: six at 1440×900 and at 834×1112", () => {
  assert.equal(INBOX_SPLIT_RATIO_DEFAULT, 0.45);
  assert.equal(sessionsListRowsForRatio(INBOX_SPLIT_RATIO_DEFAULT, DESKTOP), 6);
  assert.equal(sessionsListHeight(6, DESKTOP), 8 + 6 * 56);
  assert.equal(sessionsListRowsForRatio(INBOX_SPLIT_RATIO_DEFAULT, TABLET), 6);
});

test("the list keeps at least three rows and leaves the preview at least 240px", () => {
  assert.deepEqual(sessionsListRowRange(DESKTOP), { min: SESSIONS_LIST_MIN_ROWS, max: 9 });
  const { max } = sessionsListRowRange(DESKTOP);
  assert.ok(DESKTOP.area - sessionsListHeight(max, DESKTOP) >= SESSIONS_PREVIEW_MIN_PX);
  assert.ok(DESKTOP.area - sessionsListHeight(max + 1, DESKTOP) < SESSIONS_PREVIEW_MIN_PX);
  assert.equal(sessionsListRowsForRatio(0.75, DESKTOP), 9, "a tall ratio stops at the preview's minimum");
  assert.equal(sessionsListRowsForRatio(0.25, DESKTOP), 3);
  // A window too short for both keeps three rows: the list is the page's main surface.
  const short: SessionsSplitGeometry = { area: 300, rowHeight: 56, pad: 8 };
  assert.deepEqual(sessionsListRowRange(short), { min: 3, max: 3 });
  assert.equal(sessionsListRowsForRatio(0.75, short), 3);
});

test("a stored ratio for a row count reads back as the same count, inside the stored range", () => {
  for (const geometry of [DESKTOP, TABLET, { area: 600, rowHeight: 56, pad: 8 }, { area: 1337, rowHeight: 60, pad: 8 }]) {
    const { min, max } = sessionsListRowRange(geometry);
    for (let rows = min; rows <= max; rows += 1) {
      const raw = sessionsRatioForRows(rows, geometry);
      const readBack = sessionsListRowsForRatio(clampInboxSplitRatio(raw), geometry);
      // Past the stored 25–75% range, the count is the range's own end.
      const expected = raw < INBOX_SPLIT_RATIO_MIN ? sessionsListRowsForRatio(INBOX_SPLIT_RATIO_MIN, geometry)
        : raw > INBOX_SPLIT_RATIO_MAX ? sessionsListRowsForRatio(INBOX_SPLIT_RATIO_MAX, geometry)
          : rows;
      assert.equal(readBack, expected, `${rows} rows in ${geometry.area}px`);
    }
  }
  // At 1440×900 every count from Home's three to End's nine survives a reload.
  for (let rows = 3; rows <= 9; rows += 1) {
    assert.equal(sessionsListRowsForRatio(clampInboxSplitRatio(sessionsRatioForRows(rows, DESKTOP)), DESKTOP), rows);
  }
});

test("a dragged height snaps to the nearer whole row, inside the row range", () => {
  assert.equal(sessionsListRowsForHeight(8 + 4 * 56 + 27, DESKTOP), 4);
  assert.equal(sessionsListRowsForHeight(8 + 4 * 56 + 29, DESKTOP), 5);
  assert.equal(sessionsListRowsForHeight(20, DESKTOP), 3);
  assert.equal(sessionsListRowsForHeight(790, DESKTOP), 9);
});

test("the divider reports the list's share of the split area in whole percent", () => {
  assert.equal(sessionsListPercent(sessionsListHeight(6, DESKTOP), DESKTOP), 43);
  assert.equal(sessionsListPercent(400, { area: 0, rowHeight: 56, pad: 8 }), 0);
});

test("an unmeasured area keeps the minimum rows rather than dividing by nothing", () => {
  const unmeasured: SessionsSplitGeometry = { area: 0, rowHeight: 56, pad: 8 };
  assert.deepEqual(sessionsListRowRange(unmeasured), { min: 3, max: 3 });
  assert.equal(sessionsListRowsForRatio(0.45, unmeasured), 3);
  assert.ok(Number.isFinite(sessionsRatioForRows(3, unmeasured)));
});
