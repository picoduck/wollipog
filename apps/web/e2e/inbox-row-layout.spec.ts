import { expect, test, type Page } from "@playwright/test";

import { MOBILE_BREAKPOINT_PX } from "../src/components/useIsMobile.js";
import { expectGeometry, expectGeometryPoll } from "./geometry-margins.js";

/**
 * Sessions rows (#2209, docs/design-system.md §5.2). Desktops and tablets draw two lines, exactly
 * `--row-h-2` whatever a row carries; phones keep the three-line card, one height for every card.
 * The activity strip is 48×12 on the status line after the badge, never on the title line.
 *
 * Two pages: the Sessions page itself on the `inbox-row-layout` scenario (eleven running sessions with
 * long titles and every shape of branch), and `session-rows-e2e.html`, the list component with a row
 * in every status and treatment.
 */

/** At or below this width a row is the phone's three-line card; above it, the two-line row. */
const stacked = (width: number): boolean => width <= MOBILE_BREAKPOINT_PX;

const LAYOUT = "/command-inbox-projects-e2e.html?scenario=inbox-row-layout";
const ROWS = "/session-rows-e2e.html";

/**
 * Eleven rows need roughly 1,100px of list at the phone's card height; at 1400px every one of them is
 * mounted at every width, and the count assertion in `beforeEach` names the cause if it grows.
 */
const VIEWPORT_HEIGHT = 1400;

/**
 * Resize, then WAIT FOR THE ROW TO AGREE. A row's DOM depends on the breakpoint, not just its CSS, so a
 * resize is settled only once React has re-rendered the shape: measuring before that reads a phone
 * DOM under desktop CSS. Nothing is painted in that state; it is a harness race.
 */
const useViewport = async (page: Page, width: number, height = VIEWPORT_HEIGHT) => {
  await page.setViewportSize({ width, height });
  await expect(page.locator(".inbox-row").first().locator(":scope > *").first())
    .toHaveClass(stacked(width) ? /inbox-row-sender-line/ : /inbox-row-status-line/);
};

/** The `--row-h-2` the page resolves, in pixels. */
const rowToken = (page: Page) => page.evaluate(() =>
  Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h-2")));

/** Each row's box and its virtualizer wrapper's box, which is the row's pitch in the list. */
const rowHeights = (page: Page) => page.locator(".inbox-row").evaluateAll((rows) => rows.map((row) => ({
  id: row.closest("[role=row]")!.id,
  height: row.getBoundingClientRect().height,
  pitch: row.closest<HTMLElement>("[data-virtual-row]")!.getBoundingClientRect().height,
})));

test.describe("on the Sessions page", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: VIEWPORT_HEIGHT });
    await page.goto(LAYOUT);
    await expect(page.locator(".inbox-row")).toHaveCount(11);
  });

  for (const width of [390, 1000, 1440] as const) {
    test(`every running row draws its 48×12 strip on the status line, inside the row, at ${width}px`, async ({ page }) => {
      await useViewport(page, width);
      const strips = await page.locator(".inbox-row").evaluateAll((rows) => rows.map((row) => {
        const strip = row.querySelector<HTMLElement>(".inbox-row-activity")!;
        const box = strip.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        const style = getComputedStyle(row);
        const badge = row.querySelector(".row-status");
        return {
          width: box.width,
          height: box.height,
          bars: strip.childElementCount,
          onStatusLine: strip.closest(".inbox-row-status-line") !== null,
          inTitleLine: strip.closest(".inbox-row-copy") !== null,
          afterBadge: badge !== null && (badge.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          overflowRight: box.right - (rowBox.right - parseFloat(style.paddingRight)),
          overflowLeft: (rowBox.left + parseFloat(style.paddingLeft)) - box.left,
          name: strip.getAttribute("aria-label"),
        };
      }));
      expect(strips).toHaveLength(11);
      for (const strip of strips) {
        expect(strip).toMatchObject({
          width: 48, height: 12, bars: 30, onStatusLine: true, inTitleLine: false, afterBadge: true,
          name: "Tool activity in the last 30 minutes",
        });
        expectGeometry(strip.overflowRight, "the strip stays inside the row's right edge").toBeLessThanOrEqual(0.5);
        expectGeometry(strip.overflowLeft, "the strip stays inside the row's left edge").toBeLessThanOrEqual(0.5);
      }
    });

    test(`a long title ends in an ellipsis on its own line, and the status line stays whole, at ${width}px`, async ({ page }) => {
      await useViewport(page, width);
      const rows = await page.locator(".inbox-row").evaluateAll((nodes) => nodes.map((row) => {
        const title = row.querySelector<HTMLElement>(".inbox-row-title")!;
        const trail = row.querySelector<HTMLElement>(stackedRow(row) ? ".inbox-row-time" : ".inbox-row-trail")!;
        const rowBox = row.getBoundingClientRect();
        const style = getComputedStyle(row);
        function stackedRow(node: Element) { return node.closest(".stacked") !== null; }
        return {
          clipped: title.scrollWidth > title.clientWidth + 1,
          ellipsis: getComputedStyle(title).textOverflow,
          titleOverflow: title.getBoundingClientRect().right - (rowBox.right - parseFloat(style.paddingRight)),
          trailOverflow: trail.getBoundingClientRect().right - (rowBox.right - parseFloat(style.paddingRight)),
          trailClipped: trail.scrollWidth > trail.clientWidth + 0.5,
        };
      }));
      // The fixture's longest title runs past every width but the widest.
      if (width < 1440) expect(rows.some((row) => row.clipped)).toBe(true);
      for (const row of rows) {
        expect(row.ellipsis).toBe("ellipsis");
        expectGeometry(row.titleOverflow, "the title stays inside the row").toBeLessThanOrEqual(0.5);
        expectGeometry(row.trailOverflow, "the trailing status cluster stays inside the row").toBeLessThanOrEqual(0.5);
        expect(row.trailClipped).toBe(false);
      }
    });
  }

  test("at 1440×900 every row is exactly --row-h-2, branch or none, PR or none", async ({ page }) => {
    await useViewport(page, 1440, 900);
    const token = await rowToken(page);
    expect(token).toBe(56);
    const rows = await rowHeights(page);
    expect(rows.length).toBeGreaterThan(6);
    for (const row of rows) expect(row, row.id).toMatchObject({ height: token, pitch: token });
  });

  test("at 390×844 rows are three lines of one height, and the sender keeps the project", async ({ page }) => {
    await useViewport(page, 390, 844);
    const cards = await page.locator(".inbox-row").evaluateAll((rows) => rows.map((row) => {
      const label = row.querySelector<HTMLElement>(".inbox-row-sender > span")!;
      return {
        height: row.getBoundingClientRect().height,
        lines: row.children.length,
        sender: label.textContent,
        senderWhole: label.scrollWidth <= label.clientWidth + 0.5,
      };
    }));
    expect(new Set(cards.map((card) => card.height)).size, JSON.stringify(cards)).toBe(1);
    for (const card of cards) {
      expect(card.lines).toBe(3);
      expect(card.sender).toMatch(/ · Alpha$/);
      expect(card.senderWhole, `${card.sender} is not cut`).toBe(true);
    }

  });

  // The list remembers the last opened session as its active row, so a phone returning from one has
  // a selection to show; §5.2 says it shows none. Whichever row is active, every card is drawn alike.
  test("a phone never draws a selected row, whichever row the list holds active", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${ROWS}?selected=session-running`);
    await expect(page.locator(".inbox-row").first().locator(":scope > *").first()).toHaveClass(/inbox-row-sender-line/);
    const drawn = () => page.locator(".inbox-row-shell").evaluateAll((shells) => shells.map((shell) => ({
      active: shell.getAttribute("aria-selected") === "true",
      selectedClass: shell.classList.contains("selected"),
      bar: getComputedStyle(shell.querySelector(".inbox-row-primary-cell")!, "::after").content,
      background: getComputedStyle(shell.querySelector(".inbox-row")!).backgroundColor,
    })));
    for (const tap of [null, "Blocked: Approve", "Snoozed: Revisit"] as const) {
      if (tap) await page.locator(".inbox-row-shell", { hasText: tap }).locator(".inbox-row").click();
      const rows = await drawn();
      expect(rows.filter((row) => row.active)).toHaveLength(1);
      expect(rows.filter((row) => row.selectedClass || row.bar !== "none")).toEqual([]);
      expect(new Set(rows.map((row) => row.background)).size, "every card has the same fill").toBe(1);
    }
  });

  // The DOM order is the reading order, and it has to be the visual order too: a screenshot diff
  // cannot see a row that announces its lines in a different order from the one it shows.
  for (const [width, expected] of [
    [390, ["inbox-row-sender-line", "inbox-row-copy", "inbox-row-status-line"]],
    [1400, ["inbox-row-status-line", "inbox-row-copy"]],
  ] as const) {
    test(`the row's reading order matches its visual order at ${width}px`, async ({ page }) => {
      await useViewport(page, width);
      const lines = await page.locator(".inbox-row").first().evaluate((row) => [...row.children].map((child) => ({
        name: [...child.classList].find((name) => name !== "inbox-row-line")!,
        top: child.getBoundingClientRect().top,
      })));
      expect(lines.map((line) => line.name)).toEqual([...expected]);
      for (let index = 1; index < lines.length; index += 1) {
        expect(lines[index]!.top).toBeGreaterThan(lines[index - 1]!.top);
      }
    });
  }

  test("crossing the breakpoint keeps the first visible row and the list's geometry", async ({ page }) => {
    // Short enough that eleven rows genuinely overflow the list in BOTH shapes.
    await useViewport(page, 1400, 800);
    const list = page.locator(".inbox-list");
    await expect(page.locator(".inbox-row").first()).toBeVisible();

    const anchorTitle = "Orphaned Background Work Beside a Branch";
    let anchorIndex: number | null = null;
    let checkedTopwardOvershoot = false;

    /**
     * How far the reader's row sits OUTSIDE the list's visible band, in pixels; 0 while it is on
     * screen.
     *
     * Not `toBeInViewport`, which demands any intersection at all. Crossing the breakpoint changes the
     * row's height by about 40px, so a row that was already a few pixels above the fold can finish a
     * few pixels below it. The
     * promise the list makes is that your row does not go far, not that it never crosses an edge, and
     * an assertion that cannot tell 20px from 800px is not testing the promise.
     */
    const anchorDisplacement = async (): Promise<number> => await page.evaluate(({ title, index }) => {
      const list = document.querySelector<HTMLElement>(".inbox-list")!;
      const band = list.getBoundingClientRect();
      const row = index == null
        ? [...document.querySelectorAll<HTMLElement>(".inbox-row-title")]
          .find((node) => node.textContent?.includes(title))?.closest<HTMLElement>("[data-virtual-row]")
        : list.querySelector<HTMLElement>(`[data-virtual-row][data-index="${index}"]`);
      if (!row) return Number.POSITIVE_INFINITY;
      const box = row.getBoundingClientRect();
      if (box.bottom < band.top) return band.top - box.bottom;
      if (box.top > band.bottom) return box.top - band.bottom;
      return 0;
    }, { title: anchorTitle, index: anchorIndex });

    const cardHeight = async (): Promise<number> =>
      await page.locator(".inbox-row").first().evaluate((row) => row.getBoundingClientRect().height);

    // The virtualizer corrects a width-change anchor for eight animation frames. The test crosses
    // twice per case (to its source width, then its destination), so both epochs must finish.
    const settleResize = async (): Promise<void> => await page.evaluate(async () => {
      for (let frame = 0; frame < 9; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });

    // Only CONSECUTIVE cards may be compared. The mounted set is deliberately not contiguous: the
    // range extractor pins the selected row wherever it is, so the distance from it to the visible
    // window is the virtualizer working, not a gap. Pairing on `data-index` measures the thing the
    // estimate can actually get wrong.
    const worstNeighbours = async () => await page.locator("[data-virtual-row]").evaluateAll((nodes) => {
      const rows = nodes
        .map((node) => ({
          index: Number((node as HTMLElement).dataset.index),
          box: node.getBoundingClientRect(),
        }))
        .sort((left, right) => left.index - right.index);
      let overlap = 0;
      let gap = 0;
      let pairs = 0;
      for (let at = 1; at < rows.length; at += 1) {
        if (rows[at]!.index !== rows[at - 1]!.index + 1) continue;
        pairs += 1;
        overlap = Math.max(overlap, rows[at - 1]!.box.bottom - rows[at]!.box.top);
        gap = Math.max(gap, rows[at]!.box.top - rows[at - 1]!.box.bottom);
      }
      return { pairs, overlap, gap };
    });

    // Each crossing starts from a settled source width and a fresh scroll to the end of the list.
    // This keeps an earlier resize correction from taking ownership of the next case's viewport.
    for (const [from, to] of [
      [1400, MOBILE_BREAKPOINT_PX],
      [MOBILE_BREAKPOINT_PX, 1400],
      [MOBILE_BREAKPOINT_PX + 1, MOBILE_BREAKPOINT_PX],
      [390, 1400],
      [1400, 390],
    ] as const) {
      anchorIndex = null;
      await useViewport(page, from, 800);
      await settleResize();
      // Scrolled through the LIST, not with `scrollIntoViewIfNeeded`: the anchor is the last of eleven
      // virtualized cards, so before the list reaches it there is no element to scroll to and the
      // locator waits for something that will never attach.
      // Re-scrolled on every attempt, not once. The virtualizer's total height is built from estimates
      // until the rows around the viewport measure themselves, so a single `scrollTop = scrollHeight`
      // aims at a bottom that then moves further down as the content settles.
      await expect
        .poll(async () => {
          await list.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          return anchorDisplacement();
        }, { message: `the reader's row before ${from} to ${to}` })
        .toBe(0);

      // The virtualizer preserves the first visible row. The last row gets us to the end of the
      // list, but may leave view if a breakpoint shortens the list while that reading row stays put.
      anchorIndex = await list.evaluate((node) => {
        const band = node.getBoundingClientRect();
        const row = [...node.querySelectorAll<HTMLElement>("[data-virtual-row]")].find((candidate) => {
          const box = candidate.getBoundingClientRect();
          return box.bottom > band.top && box.top < band.bottom;
        });
        return row ? Number(row.dataset.index) : null;
      });
      expect(anchorIndex, "a visible row anchors the reader before resizing").not.toBeNull();
      const anchorOffsetBefore = await list.evaluate((node, index) => {
        const row = node.querySelector<HTMLElement>(`[data-virtual-row][data-index="${index}"]`);
        return row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
      }, anchorIndex);
      expect(Number.isFinite(anchorOffsetBefore), "the reading row has a measured source offset").toBe(true);

      await useViewport(page, to, 800);
      await settleResize();
      // Within one card of where it was. A card is the unit a reader notices: land inside one and the
      // list looks like it held its place, land several away and it looks like it jumped.
      await expectGeometryPoll(
        anchorDisplacement,
        `the first visible row stays within one card across ${from} to ${to}`,
      ).toBeLessThanOrEqual(await cardHeight());
      // Being somewhere inside a taller viewport is insufficient: a scroll reset can move the
      // reading row several cards down while its displacement outside the viewport remains zero.
      // At the list's end, shrinking content can clamp scrollTop and move the row down. A jump
      // toward the top is still a lost reading position, even if the list ends at maximum scroll.
      const readingOffsetError = async (controlHeight?: number): Promise<number> =>
        await list.evaluate((node, { index, before, controlHeight }) => {
          const row = node.querySelector<HTMLElement>(`[data-virtual-row][data-index="${index}"]`);
          if (!row) return controlHeight === undefined ? Number.POSITIVE_INFINITY : Number.NaN;
          const atEnd = node.scrollTop >= node.scrollHeight - node.clientHeight - 1;
          // The control proves this exact exception. An unmounted row or a scroll that leaves the
          // end between the guard and this measurement must fail instead of passing vacuously.
          if (controlHeight !== undefined && !atEnd) return Number.NaN;
          const measuredOffset = row.getBoundingClientRect().top - node.getBoundingClientRect().top;
          // Feed a counterfactual topward landing through the same predicate without moving the DOM:
          // even a brief CSS translation can perturb the browser's own scroll anchoring.
          const offset = controlHeight === undefined ? measuredOffset
            : measuredOffset - Math.max(measuredOffset - before, 0) - 2 * controlHeight;
          const drift = offset - before;
          return atEnd ? Math.max(-drift, 0) : Math.abs(drift);
        }, { index: anchorIndex, before: anchorOffsetBefore, controlHeight });
      await expectGeometryPoll(
        readingOffsetError,
        `the first visible row keeps its reading offset across ${from} to ${to}`,
      ).toBeLessThanOrEqual(await cardHeight());

      // Negative control: calculate a topward overshoot while scrollTop stays clamped. The previous
      // end-of-list exception returned zero for this broken reading offset.
      if (!checkedTopwardOvershoot && await list.evaluate((node) =>
        node.scrollTop >= node.scrollHeight - node.clientHeight - 1)) {
        const height = await cardHeight();
        expect(await readingOffsetError(height), "a topward overshoot at maximum scroll must fail the reading-offset limit")
          .toBeGreaterThan(height);
        checkedTopwardOvershoot = true;
      }

      // Polled on the predicate itself: a width change opens a new measurement epoch, and the
      // re-seeded rows settle over the next frame or two. What must never settle is an overlap or a
      // hole between consecutive cards.
      await expect.poll(async () => (await worstNeighbours()).pairs, {
        message: `consecutive neighbouring cards mount across ${from} to ${to}`,
      }).toBeGreaterThan(0);
      await expectGeometryPoll(
        async () => {
          const { pairs, overlap } = await worstNeighbours();
          return pairs > 0 ? overlap : Number.NaN;
        },
        `neighbouring cards do not overlap across ${from} to ${to}`,
      ).toBeLessThanOrEqual(0.5);
      await expectGeometryPoll(
        async () => {
          const { pairs, gap } = await worstNeighbours();
          return pairs > 0 ? gap : Number.NaN;
        },
        `neighbouring cards do not leave a hole across ${from} to ${to}`,
      ).toBeLessThan(24);
    }
    expect(checkedTopwardOvershoot, "the test exercises an end-of-list negative control").toBe(true);
    await expect(list).toBeVisible();
  });
});

test.describe("with a row in every status", () => {
  for (const [width, height] of [[1440, 900], [940, 700]] as const) {
    for (const density of ["compact", "comfortable"] as const) {
      test(`at ${width}×${height} every row is exactly --row-h-2 whatever its status, strip, branch or flags (${density})`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.goto(`${ROWS}?density=${density}&selectedUnread=1`);
        await expect(page.locator(".inbox-row")).toHaveCount(15);
        const token = await rowToken(page);
        expect(token).toBe(density === "compact" ? 56 : 60);
        // The fixture really is every shape: one badge or none, "+N", a strip or none, a branch or
        // none, flags, a snoozed time cell, and selected, unread, and selected-and-unread rows.
        await expect(page.locator(".row-status-more")).toHaveCount(1);
        await expect(page.locator(".inbox-row-activity")).toHaveCount(7);
        await expect(page.locator(".inbox-row-time.snoozed")).toHaveCount(2);
        await expect(page.locator(".inbox-row-shell.selected.unread")).toHaveCount(1);
        await expect(page.locator(".inbox-row-shell.unread:not(.selected)")).toHaveCount(2);
        await expect(page.locator(".inbox-row-shell.stalled .status.t-danger")).toHaveCount(1);
        const rows = await rowHeights(page);
        for (const row of rows) expect(row, row.id).toMatchObject({ height: token, pitch: token });
      });
    }
  }

  // Cross-model review of #2209: the densest phone status line (Authentication Required, the strip and
  // a weekday return time) clipped its time at 320px. The badge is what gives way; the strip and the
  // time stay whole inside the line.
  for (const width of [320, 390] as const) {
    test(`a phone card's status line keeps its strip and time whole at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(ROWS);
      await expect(page.locator(".inbox-row")).toHaveCount(15);
      const lines = await page.locator(".inbox-row-status-line").evaluateAll((nodes) => nodes.map((line) => {
        const box = line.getBoundingClientRect();
        const inside = (selector: string) => {
          const item = line.querySelector<HTMLElement>(selector);
          if (!item) return null;
          const itemBox = item.getBoundingClientRect();
          return itemBox.left >= box.left - 0.5 && itemBox.right <= box.right + 0.5 && itemBox.width > 0;
        };
        // The badge ITSELF, not its wrapper: a wrapper can shrink while the badge paints past it.
        const badge = line.querySelector<HTMLElement>(".row-status .status");
        const strip = line.querySelector<HTMLElement>(".inbox-row-activity");
        const next = strip ?? line.querySelector<HTMLElement>(".inbox-row-time")!;
        return {
          title: line.closest(".inbox-row")!.querySelector(".inbox-row-title")!.textContent,
          time: inside(".inbox-row-time"),
          strip: inside(".inbox-row-activity"),
          badge: badge ? inside(".row-status .status")
            && badge.getBoundingClientRect().right <= next.getBoundingClientRect().left + 0.5 : null,
          badgeWhole: badge ? badge.scrollWidth <= badge.clientWidth + 0.5 : null,
        };
      }));
      const dense = lines.find((line) => line.title?.startsWith("Snoozed and Blocked"))!;
      expect(dense).toMatchObject({ time: true, strip: true, badge: true });
      for (const line of lines) {
        expect(line.time, `${line.title}: the time stays whole`).toBe(true);
        if (line.strip !== null) expect(line.strip, `${line.title}: the strip stays whole`).toBe(true);
        if (line.badge !== null) expect(line.badge, `${line.title}: the badge stays inside the line`).toBe(true);
        // The branch gives way before the status does; only the densest card clips its badge.
        if (line.badgeWhole !== null && !line.title?.startsWith("Snoozed and Blocked")) {
          expect(line.badgeWhole, `${line.title}: the badge is whole`).toBe(true);
        }
      }
    });
  }

  // Cross-model review of #2209: the stalled rail was painted over the selected row's accent bar.
  test("a selected stalled row shows the selection bar, not the stalled rail", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${ROWS}?selected=session-stalled`);
    const shell = page.locator(".inbox-row-shell", { hasText: "Stalled:" });
    await expect(shell).toHaveClass(/selected/);
    expect(await shell.evaluate((node) => ({
      rail: getComputedStyle(node, "::before").content,
      bar: getComputedStyle(node.querySelector(".inbox-row-primary-cell")!, "::after").content,
      danger: node.querySelectorAll(".status.t-danger").length,
    }))).toEqual({ rail: "none", bar: "\"\"", danger: 1 });
  });

  test("the branch shows only where the list is 600px or wider", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(ROWS);
    const branch = page.locator(".inbox-row-shell", { hasText: "Running: Rebuild" }).locator(".inbox-row-git");
    await expect(branch).toBeVisible();
    await expect(branch.locator(".inbox-row-pr")).toHaveText("Pull Request: Open");
    await page.goto(`${ROWS}?listWidth=600`);
    await expect(branch).toBeVisible();
    await page.goto(`${ROWS}?listWidth=599`);
    await expect(page.locator(".inbox-row").first()).toBeVisible();
    await expect(branch).toBeHidden();
    // The row keeps its token height without it.
    for (const row of await rowHeights(page)) expect(row.height).toBe(await rowToken(page));
  });

  for (const theme of ["dark", "light"] as const) {
    test(`selected, unread and keyboard focus are three treatments, with one neutral inset ring (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${ROWS}?theme=${theme}&selected=session-blocked`);
      await expect(page.locator(".inbox-row")).toHaveCount(15);
      const read = (title: string) => page.locator(".inbox-row-shell", { hasText: title }).evaluate((shell) => {
        const row = shell.querySelector<HTMLElement>(".inbox-row")!;
        const style = getComputedStyle(row);
        const bar = getComputedStyle(shell.querySelector(".inbox-row-primary-cell")!, "::after");
        const title = getComputedStyle(shell.querySelector(".inbox-row-title")!);
        const dot = shell.querySelector(".inbox-unread-dot");
        return {
          background: style.backgroundColor,
          boxShadow: style.boxShadow,
          border: style.borderTopWidth,
          bar: bar.content === "none" ? null : { width: bar.width, color: bar.backgroundColor },
          titleWeight: title.fontWeight,
          dot: dot ? getComputedStyle(dot).backgroundColor : null,
          outline: style.outlineStyle === "none" ? null
            : { width: style.outlineWidth, offset: style.outlineOffset, color: style.outlineColor },
        };
      });
      const tokens = await page.evaluate(() => {
        const probe = document.createElement("span");
        document.body.append(probe);
        const resolve = (value: string) => { probe.style.color = value; return getComputedStyle(probe).color; };
        const result = { accent: resolve("var(--accent)"), blue: resolve("var(--blue)"), focus: resolve("var(--focus)") };
        probe.remove();
        return result;
      });

      const plain = await read("Idle: Plan");
      const unread = await read("Unread: Review");
      const selectedUnread = await read("Blocked: Approve");
      expect(plain).toMatchObject({ bar: null, dot: null, outline: null, boxShadow: "none" });
      // Unread: the dot and a heavier title, and nothing on the row's box.
      expect(unread).toMatchObject({ bar: null, dot: tokens.blue, titleWeight: "600", background: plain.background,
        boxShadow: "none", border: plain.border });
      // Selected and unread: the fill and the leading accent bar, and the dot and heavy title too.
      expect(selectedUnread.bar).toEqual({ width: "2px", color: tokens.accent });
      expect(selectedUnread.background).not.toBe(plain.background);
      expect(selectedUnread).toMatchObject({ dot: tokens.blue, titleWeight: "600", outline: null, boxShadow: "none" });

      // Keyboard focus in the list: one inset ring in the neutral focus colour, on the active row only.
      await page.keyboard.press("Tab");
      await expect(page.locator(".inbox-list")).toBeFocused();
      const focused = await read("Blocked: Approve");
      expect(focused.outline).toEqual({ width: "2px", offset: "-2px", color: tokens.focus });
      expect(tokens.focus).not.toBe(tokens.accent);
      expect(await page.locator(".inbox-row").evaluateAll((rows) =>
        rows.filter((row) => getComputedStyle(row).outlineStyle !== "none").length)).toBe(1);
      await page.screenshot({ path: `test-results/session-rows-focus-${theme}.png` });
    });
  }

  test("forced colors keep selected, unread and the strip distinguishable, and focus a visible ring", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(ROWS);
    await expect(page.locator(".inbox-row")).toHaveCount(15);
    const transparent = "rgba(0, 0, 0, 0)";
    const seen = await page.evaluate(() => {
      const shell = (title: string) => [...document.querySelectorAll(".inbox-row-shell")]
        .find((candidate) => candidate.querySelector(".inbox-row-title")?.textContent?.startsWith(title))!;
      const cell = shell("Selected:").querySelector(".inbox-row-primary-cell")!;
      const idle = shell("Idle: Plan").querySelector(".inbox-row-primary-cell")!;
      const bar = getComputedStyle(cell, "::after");
      const canvas = getComputedStyle(document.querySelector(".inbox-list")!).backgroundColor;
      return {
        canvas,
        bar: { content: bar.content, width: bar.width, color: bar.backgroundColor },
        idleBar: getComputedStyle(idle, "::after").content,
        dot: getComputedStyle(shell("Unread:").querySelector(".inbox-unread-dot")!).backgroundColor,
        strip: getComputedStyle(document.querySelector(".inbox-row-activity .activity-strip-bar.active")!).backgroundColor,
      };
    });
    expect(seen.idleBar).toBe("none");
    expect(seen.bar.width).toBe("4px");
    for (const color of [seen.bar.color, seen.dot, seen.strip]) {
      expect(color).not.toBe(transparent);
      expect(color).not.toBe(seen.canvas);
    }
    await page.keyboard.press("Tab");
    await expect(page.locator(".inbox-list")).toBeFocused();
    expect(await page.locator(".inbox-row-shell", { hasText: "Selected:" }).locator(".inbox-row").evaluate((row) => {
      const style = getComputedStyle(row);
      return { style: style.outlineStyle, width: style.outlineWidth };
    })).toEqual({ style: "solid", width: "2px" });
  });
});
