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

test("every count in the row range is stored and read back as itself, through the store's clamp", () => {
  const geometries: SessionsSplitGeometry[] = [
    DESKTOP, TABLET, { area: 600, rowHeight: 56, pad: 8 }, { area: 1337, rowHeight: 56, pad: 8 },
    { area: 1337, rowHeight: 60, pad: 8 }, { area: 2000, rowHeight: 64, pad: 8 }, { area: 300, rowHeight: 56, pad: 8 },
  ];
  for (const geometry of geometries) {
    const { min, max } = sessionsListRowRange(geometry);
    for (let rows = min; rows <= max; rows += 1) {
      const readBack = sessionsListRowsForRatio(clampInboxSplitRatio(sessionsRatioForRows(rows, geometry)), geometry);
      assert.equal(readBack, rows, `${rows} rows in ${geometry.area}px of ${geometry.rowHeight}px rows`);
    }
  }
});

test("in a tall split area the stored 25–75% range bounds Home and End (#2710 review)", () => {
  // 1337px of 56px rows: the preview minimum would allow 19 rows, but 75% holds only 17, and 25% is 5.
  const tall: SessionsSplitGeometry = { area: 1337, rowHeight: 56, pad: 8 };
  assert.deepEqual(sessionsListRowRange(tall), { min: 5, max: 17 });
  assert.equal(sessionsListRowsForRatio(INBOX_SPLIT_RATIO_MAX, tall), 17);
  assert.equal(sessionsListRowsForRatio(INBOX_SPLIT_RATIO_MIN, tall), 5);
  assert.equal(sessionsListRowsForHeight(8 + 19 * 56, tall), 17, "a drag past the cap snaps to the cap");
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
