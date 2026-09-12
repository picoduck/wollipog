import { expect, test } from "@playwright/test";

import { TABLET_BREAKPOINT_PX } from "../src/components/useIsMobile.js";
import { expectGeometry, expectGeometryPoll } from "./geometry-margins.js";

/** At or below this width the card is #782's three-row stack; above it, #877's two-row card (#901). */
const stacked = (width: number): boolean => width <= TABLET_BREAKPOINT_PX;

/**
 * #664: the activity strip is the row's only irreplaceable signal, and it used to be the first
 * thing pushed out of the row. These tests measure geometry rather than reading text, because the
 * regression was invisible to every assertion that only asked whether an element existed — the
 * strip was in the DOM the whole time, clipped past the row's right edge.
 */
const WIDTHS = [390, 1000, 1400] as const;

/**
 * The Inbox list is virtualized, so a card only has a box to measure while it is mounted, and these
 * tests measure the whole fixture at once. Eleven 86px cards need roughly 950px of list viewport;
 * at the 900px this file used while the fixture held seven rows, only nine of the eleven mount and
 * every whole-list assertion fails on the count rather than on the geometry it meant to check.
 * 1400px clears all eleven at every width with room to spare, and the count assertion below is the
 * guard: grow the fixture again and it fails here, naming the real cause.
 */
const VIEWPORT_HEIGHT = 1400;

/**
 * Resize, then WAIT FOR THE CARD TO AGREE. #877 made the card's DOM depend on the breakpoint, not
 * just its CSS, so a resize is no longer settled the instant `setViewportSize` returns: React
 * re-renders from the `resize` event, before the next paint but sometimes after Playwright's next
 * `evaluate`. Measuring immediately catches a phone-shaped DOM under desktop CSS and reports three
 * rows at 1400px. Nothing is ever painted in that state — this is a harness race, not a frame a
 * reader can see — but every geometry assertion below has to be taken after it resolves.
 */
const useViewport = async (page: import("@playwright/test").Page, width: number, height = VIEWPORT_HEIGHT) => {
  await page.setViewportSize({ width, height });
  await expect(page.locator(".inbox-row").first().locator(":scope > *").first())
    .toHaveClass(stacked(width) ? /inbox-row-sender/ : /inbox-row-lead/);
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: VIEWPORT_HEIGHT });
  await page.goto("/command-inbox-projects-e2e.html?scenario=inbox-row-layout");
  await expect(page.locator(".inbox-row")).toHaveCount(11);
});

for (const width of WIDTHS) {
  test(`every active row shows its whole activity strip at ${width}px`, async ({ page }) => {
    await useViewport(page, width);
    const strips = await page.locator(".inbox-row").evaluateAll((rows) => rows.map((row) => {
      const strip = row.querySelector<HTMLElement>(".inbox-row-activity")!;
      const stripBox = strip.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        stripWidth: stripBox.width,
        renderedBars: strip.childElementCount,
        overflowRight: stripBox.right - (rowBox.right - parseFloat(style.paddingRight)),
        overflowLeft: (rowBox.left + parseFloat(style.paddingLeft)) - stripBox.left,
      };
    }));

    expect(strips).toHaveLength(11);
    for (const strip of strips) {
      expect(strip.renderedBars).toBe(30);
      expectGeometry(strip.stripWidth, "the activity strip keeps a readable width").toBeGreaterThan(50);
      expectGeometry(strip.overflowRight, "the activity strip stays inside the row's right edge")
        .toBeLessThanOrEqual(0.5);
      expectGeometry(strip.overflowLeft, "the activity strip stays inside the row's left edge")
        .toBeLessThanOrEqual(0.5);
    }
    // The strip never shrinks, so its width is identical on every row at a given width.
    expectGeometry(
      Math.max(...strips.map((s) => s.stripWidth)) - Math.min(...strips.map((s) => s.stripWidth)),
      "every activity strip keeps the same width",
    )
      .toBeLessThanOrEqual(0.5);
  });

  test(`a long title fades instead of displacing the strip at ${width}px`, async ({ page }) => {
    await useViewport(page, width);
    const titles = await page.locator(".inbox-row").evaluateAll((rows) => rows.map((row) => {
      const node = row.querySelector<HTMLElement>(".inbox-row-title")!;
      const strip = row.querySelector<HTMLElement>(".inbox-row-activity")!;
      const style = getComputedStyle(node);
      return {
        text: node.textContent ?? "",
        clipped: node.scrollWidth > node.clientWidth + 1,
        mask: style.maskImage || style.webkitMaskImage,
        overflowX: style.overflowX,
        textOverflow: style.textOverflow,
        left: node.getBoundingClientRect().left,
        right: node.getBoundingClientRect().right,
        stripLeft: strip.getBoundingClientRect().left,
      };
    }));

    // The full title stays in the DOM for assistive technology and for the row's accessible name.
    expect(titles[0]!.text).toContain("Always Visible");
    for (const title of titles) {
      // Fade, not ellipsis: a mask draws the truncation and `text-overflow` is never asked to.
      expect(title.mask).toContain("linear-gradient");
      expect(title.overflowX).toBe("hidden");
      expect(title.textOverflow).toBe("clip");
      // The title yields to the strip rather than growing under it.
      expectGeometry(title.right - title.stripLeft, "the title stays left of the activity strip")
        .toBeLessThanOrEqual(1);
    }
    // A title long enough to overrun this viewport is present at every width under test, so the
    // fade is actually exercised and not merely declared.
    expect(titles.filter((title) => title.clipped).length).toBeGreaterThan(0);
    // Every title starts on the same reading axis, whatever the row's signals or worktree line.
    expectGeometry(
      Math.max(...titles.map((t) => t.left)) - Math.min(...titles.map((t) => t.left)),
      "every title starts on the same reading axis",
    )
      .toBeLessThanOrEqual(1);
  });
}

// #782 replaced #664's two-versus-three-line contract. THAT contract was the bug: it asserted that
// a session without a worktree took two lines and one with a worktree took three, and a visible
// background badge then took a fourth nobody had accounted for. #877 splits the shape by BREAKPOINT
// instead of by content — three lines on a phone, two on the desktop — which keeps what #782 was
// actually protecting: at any one width, every card is the same shape and the same height whatever
// it happens to contain.
//
// The row count is read off the resolved `grid-template-rows`, not off distinct element tops. Items
// on one grid line are centred in it and therefore have DIFFERENT tops — the 12px sender sits 2px
// below the 20px Git line beside it — so counting tops reports the desktop card as three lines when
// it is two. The resolved track list is the layout's own answer.
const measureRows = (nodes: Element[]) => nodes.map((node) => {
  const row = node as HTMLElement;
  const box = row.getBoundingClientRect();
  const style = getComputedStyle(row);
  const centre = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.top + rect.height / 2;
  };
  const sender = row.querySelector<HTMLElement>(".inbox-row-sender")!;
  const copy = row.querySelector<HTMLElement>(".inbox-row-copy")!;
  const meta = row.querySelector<HTMLElement>(".inbox-row-meta")!;
  const git = row.querySelector<HTMLElement>(".inbox-row-git");
  const badge = row.querySelector<HTMLElement>(".inbox-row-background-work");
  const strip = row.querySelector<HTMLElement>(".inbox-row-activity")!;
  const shell = row.closest<HTMLElement>(".inbox-row-shell")!;
  const metaBox = meta.getBoundingClientRect();
  return {
    height: box.height,
    gridRows: style.gridTemplateRows.split(" ").filter(Boolean).length,
    gitText: (git?.textContent ?? "").trim(),
    // Nothing may sit below the card's last line; an extra row is exactly what that looks like.
    lastLineBottom: Math.max(metaBox.bottom, copy.getBoundingClientRect().bottom),
    cardInnerBottom: box.bottom - parseFloat(style.paddingBottom),
    senderCentre: centre(sender),
    copyCentre: centre(copy),
    metaCentre: centre(meta),
    metaTop: metaBox.top,
    badgeCentre: badge ? centre(badge) : null,
    badgeRight: badge ? badge.getBoundingClientRect().right : null,
    badgeTop: badge ? badge.getBoundingClientRect().top : null,
    badgeWidth: badge ? badge.getBoundingClientRect().width : null,
    badgeOverflowRight: badge
      ? badge.getBoundingClientRect().right - (box.right - parseFloat(style.paddingRight))
      : null,
    // Where the badge belongs is a DOM fact on desktop and a geometric one on a phone; assert both.
    badgeOnTitleLine: badge ? copy.contains(badge) : null,
    stripLeft: strip.getBoundingClientRect().left,
    stripBottom: strip.getBoundingClientRect().bottom,
    top: shell.getBoundingClientRect().top,
    bottom: shell.getBoundingClientRect().bottom,
  };
});

// 901px is the first two-row pixel and 900px the last stacked one: the two rules meet here, and a
// layout that only works well clear of its own breakpoint fails at exactly one of these. 770px is
// kept because it is where #877's three-column line one lost the branch name outright, and 390px
// because a phone must keep the shape #782 gave it.
const LAYOUT_WIDTHS = [390, 770, 900, 901, 1400] as const;

for (const width of LAYOUT_WIDTHS) {
  const phone = stacked(width);
  const expectedRows = phone ? 3 : 2;
  test(`every card is exactly ${expectedRows} rows with an explicit Git state at ${width}px`, async ({ page }) => {
    await useViewport(page, width);
    const rows = await page.locator(".inbox-row").evaluateAll(measureRows);

    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row.gridRows).toBe(expectedRows);
      // Every card says something about Git; none of them says it by saying nothing.
      expect(row.gitText.length).toBeGreaterThan(0);
      expectGeometry(row.lastLineBottom - row.cardInnerBottom, "the final line stays inside the card")
        .toBeLessThanOrEqual(0.5);
      if (phone) {
        // Line three, under the title line, with the Git state and the background badge on it.
        expectGeometry(row.metaCentre - row.copyCentre, "line three follows the title line")
          .toBeGreaterThan(0);
        expectGeometry(row.copyCentre - row.senderCentre, "the title line follows the sender line")
          .toBeGreaterThan(0);
      } else {
        // The Git state shares line one with the sender; the title line is the only other line.
        expectGeometry(Math.abs(row.metaCentre - row.senderCentre), "Git and sender share line one")
          .toBeLessThanOrEqual(1);
        expectGeometry(row.copyCentre - row.senderCentre, "the title line follows desktop line one")
          .toBeGreaterThan(0);
      }
      if (row.badgeCentre !== null) {
        expectGeometry(row.badgeWidth!, "the background-work badge keeps readable width")
          .toBeGreaterThan(20);
        expectGeometry(row.badgeOverflowRight!, "the background-work badge stays inside the card")
          .toBeLessThanOrEqual(0.5);
        if (phone) {
          // On line three with the Git state, below the strip.
          expect(row.badgeOnTitleLine).toBe(false);
          expectGeometry(Math.abs(row.badgeTop! - row.metaTop), "the badge starts on line three")
            .toBeLessThanOrEqual(4);
          expectGeometry(row.badgeTop! - row.stripBottom, "the line-three badge clears the activity strip")
            .toBeGreaterThanOrEqual(-0.5);
        } else {
          // On the title line, immediately LEFT of the strip rather than under it.
          expect(row.badgeOnTitleLine).toBe(true);
          expectGeometry(Math.abs(row.badgeCentre - row.copyCentre), "the badge shares the title line")
            .toBeLessThanOrEqual(1);
          expectGeometry(row.badgeRight! - row.stripLeft, "the badge stays left of the activity strip")
            .toBeLessThanOrEqual(0.5);
        }
      }
    }
    // Four of the eleven carry background work, and they are the same height as the seven that do
    // not — which is what makes ONE virtualization estimate per shape honest.
    expect(rows.filter((row) => row.badgeCentre !== null)).toHaveLength(4);
    expectGeometry(
      Math.max(...rows.map((row) => row.height)) - Math.min(...rows.map((row) => row.height)),
      "every card at one breakpoint keeps the same height",
    )
      .toBeLessThanOrEqual(1);
    // The virtualizer positions from measured heights: no overlap, no gap it cannot explain.
    for (let index = 1; index < rows.length; index += 1) {
      expectGeometry(rows[index]!.top - rows[index - 1]!.bottom, "neighbouring cards do not overlap")
        .toBeGreaterThanOrEqual(-0.5);
      expectGeometry(rows[index]!.top - rows[index - 1]!.bottom, "neighbouring cards do not leave a row-sized gap")
        .toBeLessThan(24);
    }
  });
}

// The density claim #877 is FOR: a desktop card that is not materially shorter than the phone card
// bought nothing.
//
// RELATIVE on purpose. An earlier version of this test also pinned the phone card at 85-87px, which
// is what it measures on a developer machine and 83px on CI: a card's height is a sum of text line
// boxes, so it tracks the font metrics of whatever renders it, and a layout invariant that fails on
// a different font stack is testing the font stack. That the phone card is UNCHANGED is carried by
// evidence that does not depend on a magic number — its exact grid-row count at both breakpoint
// edges, its reading order, and an out-of-band pixel diff against the base with animations frozen.
test("a desktop card is a whole line shorter than a phone card", async ({ page }) => {
  const heightAt = async (width: number) => {
    await useViewport(page, width);
    const rows = await page.locator(".inbox-row").evaluateAll(measureRows);
    expect(rows).toHaveLength(11);
    return rows[0]!.height;
  };
  const phone = await heightAt(390);
  const desktop = await heightAt(1400);
  // A whole line's worth of card, whatever a line measures on this machine. This also catches the
  // desktop card quietly reverting to three rows, which would collapse the difference to nothing.
  expectGeometry(phone - desktop, "the phone card is at least one text line taller")
    .toBeGreaterThan(15);
});

test("a card's height does not move with selection, unread, or stalled state", async ({ page }) => {
  await useViewport(page, 1400);
  const baseline = (await page.locator(".inbox-row").evaluateAll(measureRows)).map((row) => row.height);
  // The state classes, not a click: this asserts the CSS itself never spends layout on a state
  // that is supposed to be paint only, on every card at once rather than on whichever one is easy
  // to select.
  for (const state of ["selected", "unread", "stalled"] as const) {
    const heights = await page.locator(".inbox-row").evaluateAll((nodes, applied) => {
      for (const node of nodes) node.closest(".inbox-row-shell")!.classList.add(applied);
      const measured = nodes.map((node) => node.getBoundingClientRect().height);
      for (const node of nodes) node.closest(".inbox-row-shell")!.classList.remove(applied);
      return measured;
    }, state);
    for (const [index, height] of heights.entries()) {
      expectGeometry(Math.abs(height - baseline[index]!), `${state} card ${index} keeps its height`)
        .toBeLessThanOrEqual(0.5);
    }
  }
});

test("selection stays visually distinct from unread across every palette, theme, and density", async ({ page }) => {
  await useViewport(page, 1400);
  await page.locator(".inbox-row-shell").first().evaluate((source) => {
    const host = document.createElement("div");
    host.id = "selection-state-fixture";
    host.style.width = "1000px";
    for (const states of [[], ["unread"], ["selected"], ["selected", "unread"]]) {
      const shell = source.cloneNode(true) as HTMLElement;
      shell.removeAttribute("id");
      shell.className = "inbox-row-shell";
      shell.classList.add(...states);
      host.append(shell);
    }
    document.body.append(host);
  });
  const shells = page.locator("#selection-state-fixture .inbox-row-shell");

  for (const theme of ["dark", "light"] as const) {
    for (const scheme of ["wollipog", "github", "one-dark", "dracula", "monokai"] as const) {
      for (const density of ["compact", "comfortable"] as const) {
        await page.evaluate(({ theme, scheme, density }) => {
          document.documentElement.dataset.theme = theme;
          if (scheme === "wollipog") delete document.documentElement.dataset.scheme;
          else document.documentElement.dataset.scheme = scheme;
          if (density === "comfortable") document.documentElement.dataset.density = density;
          else delete document.documentElement.dataset.density;
        }, { theme, scheme, density });
        const visual = await shells.evaluateAll((nodes) => nodes.map((shell) => {
            const row = shell.querySelector<HTMLElement>(".inbox-row")!;
            const style = getComputedStyle(row);
            return {
              height: row.getBoundingClientRect().height,
              border: style.borderColor,
              shadow: style.boxShadow,
              background: style.backgroundImage,
            };
        }));
        const [read, unread, selected, both] = visual;
        const context = `${scheme}/${theme}/${density}`;
        expect(unread!.background, `${context}: unread owns its tinted background`).not.toBe(read!.background);
        expect(selected!.border, `${context}: selection is not the unread accent border`).not.toBe(unread!.border);
        expect(selected!.shadow, `${context}: selection is not the unread inset rail`).not.toBe(unread!.shadow);
        expect(both!.border, `${context}: selected + unread keeps the selection boundary`).toBe(selected!.border);
        expect(both!.background, `${context}: selected + unread keeps the unread tint`).toBe(unread!.background);
        expect(both!.shadow, `${context}: selected + unread keeps the unread rail`).toContain("inset");
        expect(new Set(visual.map((state) => state.height)).size, `${context}: paint causes no reflow`).toBe(1);
      }
    }
  }

  const selectedUnreadButton = shells.nth(3).locator(".inbox-row");
  await selectedUnreadButton.focus();
  const focused = await selectedUnreadButton.evaluate((row) => {
    const style = getComputedStyle(row);
    return { border: style.borderColor, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focused.border).not.toBe("rgba(0, 0, 0, 0)");
  expect(focused.outlineStyle).toBe("solid");
  expect(focused.outlineWidth).toBe("2px");
});

test("the Git line names a branch, admits to none, or admits to not knowing", async ({ page }) => {
  await useViewport(page, 1400);
  const lines = page.locator(".inbox-row-git");
  await expect(lines).toHaveCount(11);
  // Rows five and six hold no worktree and never asked for one: an authoritative absence.
  await expect(lines.nth(5).locator(".inbox-row-branch-state")).toHaveText("No Branch");
  await expect(lines.nth(6).locator(".inbox-row-branch-state")).toHaveText("No Branch");
  // Row nine holds an active worktree whose identity never reached the client. Saying "No Branch"
  // there would be a claim the client cannot support.
  const unknown = lines.nth(9).locator(".inbox-row-branch-state");
  await expect(unknown).toHaveText("Branch Unavailable");
  await expect(unknown).toHaveClass(/unknown/);
  // The distinction survives without colour: the words differ, and so does the class.
  await expect(lines.nth(5).locator(".inbox-row-branch-state")).toHaveClass(/none/);
  // The whole state reaches the accessible name, not just the pixels.
  await expect(page.getByRole("row", { name: /Branch: No Branch/ }).first()).toBeVisible();
  await expect(page.getByRole("row", { name: /Branch: Branch Unavailable/ })).toHaveCount(1);
  await expect(page.getByRole("row", { name: /Branch: fix\/issue-782-orphaned/ })).toHaveCount(1);
});

// The badge is found through the CARD, not through the Git line: which line carries it is what
// #877 made responsive, and its words and accessible name are what must not move with it.
for (const width of [390, 1400]) {
  test(`every background-work state keeps its accessible name at ${width}px`, async ({ page }) => {
    await useViewport(page, width);
    for (const [index, label] of [
      [7, "Waiting on External Job"],
      [8, "Waiting on External Job"],
      [9, "Continuation Pending"],
      [10, "Orphaned"],
    ] as const) {
      const badge = page.locator(".inbox-row").nth(index).locator(".background-work-badge");
      await expect(badge).toHaveCount(1);
      await expect(badge).toHaveAttribute("aria-label", `Background Work: ${label}`);
    }
  });
}

// Row eight's long branch, long base, and PR pill share their line with the badge on a phone and
// with the sender and the signals column on the desktop. Either way the branch is the row's
// identity, the pill is the item that must survive, and the base ref yields first.
for (const width of [390, 770, 1000, 1400]) {
  test(`a long branch yields to the PR pill without evicting itself at ${width}px`, async ({ page }) => {
    await useViewport(page, width);
    const geometry = await page.locator(".inbox-row").nth(8).evaluate((row) => {
      const style = getComputedStyle(row);
      const rightEdge = row.getBoundingClientRect().right - parseFloat(style.paddingRight);
      const pill = row.querySelector<HTMLElement>(".inbox-row-pr-pill")!;
      const badge = row.querySelector<HTMLElement>(".background-work-badge")!;
      const branch = row.querySelector<HTMLElement>(".inbox-row-branch")!;
      const sender = row.querySelector<HTMLElement>(".inbox-row-sender")!;
      return {
        branchWidth: branch.getBoundingClientRect().width,
        branchLeft: branch.getBoundingClientRect().left,
        senderRight: sender.getBoundingClientRect().right,
        pillWidth: pill.getBoundingClientRect().width,
        badgeWidth: badge.getBoundingClientRect().width,
        pillOverflowRight: pill.getBoundingClientRect().right - rightEdge,
        badgeOverflowRight: badge.getBoundingClientRect().right - rightEdge,
        // Nothing on a shared line may be drawn over anything else.
        pillClearsBadge: badge.getBoundingClientRect().left - pill.getBoundingClientRect().right,
        senderLineDelta: Math.abs(
          branch.getBoundingClientRect().top - sender.getBoundingClientRect().top,
        ),
      };
    });

    expectGeometry(geometry.branchWidth, "the long branch keeps readable width").toBeGreaterThan(40);
    expectGeometry(geometry.pillWidth, "the pull-request pill keeps readable width").toBeGreaterThan(20);
    expectGeometry(geometry.badgeWidth, "the background-work badge keeps readable width").toBeGreaterThan(20);
    expectGeometry(geometry.pillOverflowRight, "the pull-request pill stays inside the row")
      .toBeLessThanOrEqual(0.5);
    expectGeometry(geometry.badgeOverflowRight, "the background-work badge stays inside the row")
      .toBeLessThanOrEqual(0.5);
    if (!stacked(width)) {
      // The branch shares line one with the sender and starts clear of it, rather than under it.
      expectGeometry(geometry.senderLineDelta, "the branch shares the sender's line")
        .toBeLessThanOrEqual(4);
      // Exact contact is valid; this is a structural ordering invariant, not a safety margin.
      expect(geometry.branchLeft).toBeGreaterThanOrEqual(geometry.senderRight);
    } else {
      expectGeometry(geometry.senderLineDelta, "the stacked branch leaves the sender's line")
        .toBeGreaterThan(4);
      expectGeometry(geometry.pillClearsBadge, "the pull-request pill clears the background-work badge")
        .toBeGreaterThanOrEqual(-0.5);
    }
  });
}

// #877's own failure mode, and the reason line one is a flex LEAD inside column one rather than a
// third grid column. The sender, the Git state, and the signals column all want line one; whichever
// is asked to yield LAST is the one that survives, and the branch name is the card's identity.
//
// As three grid columns this was a measured regression: at 770px with four extra attention pills the
// Git column resolved to 0px — branch, base ref and PR pill gone outright — while the card grew from
// 65px to 75px and put the virtualization estimate out by a row. The lead's shrink factors invert
// that, so the sender ellipsizes and then collapses before the Git line gives up anything.

/** Adds `count` attention pills to the first card's signals column and measures line one. */
const measureUnderSignalPressure = (page: import("@playwright/test").Page, count: number) =>
  page.locator(".inbox-row").first().evaluate((row, pills) => {
    row.querySelectorAll(".injected-pressure").forEach((node) => node.remove());
    const signals = row.querySelector<HTMLElement>(".inbox-row-signals")!;
    for (let index = 0; index < pills; index += 1) {
      const pill = document.createElement("span");
      pill.className = "inbox-status-pill blocked injected-pressure";
      pill.textContent = "Approval Required";
      signals.prepend(pill);
    }
    const width = (selector: string) => row.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0;
    const label = row.querySelector<HTMLElement>(".inbox-row-sender > span:last-child")!;
    const box = row.getBoundingClientRect();
    return {
      height: box.height,
      senderWidth: width(".inbox-row-sender"),
      senderClipped: label.scrollWidth > label.clientWidth + 1,
      branchWidth: width(".inbox-row-branch"),
      signalsOverflowRight: (row.querySelector<HTMLElement>(".inbox-row-signals")!.getBoundingClientRect().right)
        - (box.right - parseFloat(getComputedStyle(row).paddingRight)),
    };
  }, count);

for (const width of [901, 1000, 1200, 1400]) {
  // Two more pills than the fixture's Running and Stalled: a card that also wants an attention pill
  // and a reminder. That is an ordinary busy session, not a contrived one.
  test(`a crowded signals column takes its width from the sender, not the branch, at ${width}px`, async ({ page }) => {
    await useViewport(page, width);
    const before = await measureUnderSignalPressure(page, 0);
    const after = await measureUnderSignalPressure(page, 2);

    // The branch is the card's identity and stays readable.
    expectGeometry(after.branchWidth, "the pressured branch keeps readable width").toBeGreaterThan(40);
    // The sender is what paid for it: it gave up width, or there was enough for both.
    // Equality is the expected safe outcome when there was enough room for both; a percentage
    // margin from zero would reject that structural monotonic invariant rather than renderer drift.
    expect(after.senderWidth, "signal pressure never grows the sender").toBeLessThanOrEqual(before.senderWidth);
    if (after.senderWidth < before.senderWidth) expect(after.senderClipped).toBe(true);
    // And line one never grows the card or spills past its padding.
    expectGeometry(Math.abs(after.height - before.height), "signal pressure does not change card height")
      .toBeLessThanOrEqual(0.5);
    expectGeometry(after.signalsOverflowRight, "pressured signals stay inside the row")
      .toBeLessThanOrEqual(0.5);
  });
}

// The cliff, pinned deliberately rather than left to be discovered. Four extra pills is about as
// crowded as a real card gets: a lifecycle pill, an attention pill, an orphaned-background-work
// pill, a reminder and Stalled at once.
test("the crowded extreme spends the sender completely before the branch gives up anything", async ({ page }) => {
  await useViewport(page, 1400);
  const roomy = await measureUnderSignalPressure(page, 4);
  // A full-width desktop card has room for all of it; nothing has to yield. Compared against the
  // UNPRESSURED width rather than against 300px: the branch measures 341px here and about 329px on
  // CI, so a bare floor near the real value spends most of its headroom on the renderer before it
  // says anything about the layout.
  const unpressured = await measureUnderSignalPressure(page, 0);
  expectGeometry(Math.abs(roomy.branchWidth - unpressured.branchWidth), "wide cards preserve branch width under pressure")
    .toBeLessThanOrEqual(0.5);
  expect(roomy.senderClipped).toBe(false);

  await useViewport(page, TABLET_BREAKPOINT_PX + 1);
  const tight = await measureUnderSignalPressure(page, 4);
  // The narrowest width that still uses the two-row card. Below it the card stacks instead (#901),
  // which is what stops the Git line being squeezed to nothing. Here the order is what is
  // guaranteed: the sender is at zero before the Git line yields, the card does not change height,
  // and nothing is drawn past the card's edge.
  // Spent, not exactly zero: how much of "Codex App Server · Alpha" fits before the pills push it
  // out depends on the renderer's font metrics, and sub-pixel is still spent.
  expectGeometry(tight.senderWidth, "the sender is spent before the branch yields").toBeLessThanOrEqual(1);
  expectGeometry(tight.signalsOverflowRight, "extreme signal pressure stays inside the row")
    .toBeLessThanOrEqual(0.5);
  expectGeometry(Math.abs(tight.height - roomy.height), "extreme signal pressure does not change card height")
    .toBeLessThanOrEqual(0.5);
});

// The same priority with no signals pressure at all: a very long agent-and-project label must
// ellipsize rather than push the branch off the line. Both widths use the two-row card, which is the
// only shape where the sender and the Git state share a line.
for (const width of [901, 1400]) {
  test(`a long agent and project label yields line one to the branch at ${width}px`, async ({ page }) => {
    await useViewport(page, width);
    await page.evaluate(() => {
      const sender = document.querySelector<HTMLElement>(".inbox-row-sender > span:last-child")!;
      sender.textContent = "An Agent With an Extremely Long Name · A Project Whose Name Also Runs On and On "
        + "and On, Past Any Share of a Card That Line One Could Reasonably Give It at the Widest Desktop "
        + "Viewport This Inbox Is Ever Rendered At";
    });
    const geometry = await page.locator(".inbox-row").first().evaluate((row) => {
      const sender = row.querySelector<HTMLElement>(".inbox-row-sender")!;
      const label = row.querySelector<HTMLElement>(".inbox-row-sender > span:last-child")!;
      const branch = row.querySelector<HTMLElement>(".inbox-row-branch")!;
      return {
        clipped: label.scrollWidth > label.clientWidth + 1,
        ellipsis: getComputedStyle(label).textOverflow,
        branchWidth: branch.getBoundingClientRect().width,
        branchLeft: branch.getBoundingClientRect().left,
        senderRight: sender.getBoundingClientRect().right,
      };
    });

    // Clipped with an ellipsis, and still leaving the branch a readable share of the line.
    expect(geometry.clipped).toBe(true);
    expect(geometry.ellipsis).toBe("ellipsis");
    expectGeometry(geometry.branchWidth, "the branch stays readable after a long sender label")
      .toBeGreaterThan(40);
    // Exact contact is valid; this is a structural ordering invariant, not a safety margin.
    expect(geometry.branchLeft).toBeGreaterThanOrEqual(geometry.senderRight);
  });
}

test("the worktree line hides a default base ref and keeps a stacked one", async ({ page }) => {
  await useViewport(page, 1400);
  const worktreeLines = page.locator(".inbox-row-git");
  await expect(worktreeLines.nth(0)).toContainText("fix/issue-664-restructure-inbox-rows");
  await expect(worktreeLines.nth(0).locator(".inbox-row-base")).toHaveCount(0);
  await expect(worktreeLines.nth(0).locator(".inbox-row-pr-pill")).toHaveText("Open PR");
  await expect(worktreeLines.nth(1).locator(".inbox-row-base")).toContainText("← fix/issue-664-restructure");
  await expect(worktreeLines.nth(1).locator(".inbox-row-pr-pill")).toHaveText("Merged PR");
});

// Regression, found by cross-model review: `.inbox-row-base` was `flex: none`, so the branch
// collapsed to zero width before the base yielded a pixel and the PR pill was then pushed past the
// line's clip — line three reproducing the very failure line two was restructured to remove.
for (const width of [770, 800, 1000, 1400]) {
  test(`a long base ref truncates instead of evicting the branch or the PR pill at ${width}px`, async ({ page }) => {
    await useViewport(page, width);
    const line = page.locator(".inbox-row-git").nth(2);
    const geometry = await line.evaluate((node) => {
      const row = node.closest<HTMLElement>(".inbox-row")!;
      const style = getComputedStyle(row);
      const pill = node.querySelector<HTMLElement>(".inbox-row-pr-pill")!;
      const branch = node.querySelector<HTMLElement>(".inbox-row-branch")!;
      const base = node.querySelector<HTMLElement>(".inbox-row-base")!;
      return {
        branchWidth: branch.getBoundingClientRect().width,
        baseWidth: base.getBoundingClientRect().width,
        pillWidth: pill.getBoundingClientRect().width,
        pillOverflowRight: pill.getBoundingClientRect().right
          - (row.getBoundingClientRect().right - parseFloat(style.paddingRight)),
      };
    });

    // The branch is the row's identity; it must never be the thing that disappears.
    expectGeometry(geometry.branchWidth, "the branch survives a long base ref").toBeGreaterThan(80);
    expectGeometry(geometry.pillWidth, "the pull-request pill survives a long base ref").toBeGreaterThan(20);
    expectGeometry(geometry.pillOverflowRight, "the pull-request pill stays inside the row with a long base ref")
      .toBeLessThanOrEqual(0.5);
    // The base ref yields width rather than taking it; it is the least important item on the line.
    expectGeometry(geometry.baseWidth, "the base ref yields without disappearing").toBeGreaterThan(0);
  });
}

test("a phone drops the base ref from the worktree line but keeps branch and PR state", async ({ page }) => {
  await useViewport(page, 390);
  const stacked = page.locator(".inbox-row-git").nth(1);
  await expect(stacked.locator(".inbox-row-branch")).toBeVisible();
  await expect(stacked.locator(".inbox-row-pr-pill")).toBeVisible();
  await expect(stacked.locator(".inbox-row-base")).toBeHidden();
});

test("the message preview no longer renders in Inbox rows", async ({ page }) => {
  for (const width of WIDTHS) {
    await useViewport(page, width);
    await expect(page.locator(".inbox-row-snippet")).toHaveCount(0);
    await expect(page.locator(".inbox-row").first()).not.toContainText("preview");
  }
});

// #679: the row compares against the repository's reported default branch instead of guessing from
// the branch's name, so a `develop`-default repository keeps an explicit `origin/main` base.
test("a reported default branch decides whether the base ref is worth showing", async ({ page }) => {
  await useViewport(page, 1400);
  const nonDefault = page.locator(".inbox-row-git").nth(3);
  await expect(nonDefault.locator(".inbox-row-branch")).toHaveText("fix/issue-679-default-branch");
  await expect(nonDefault.locator(".inbox-row-base")).toContainText("← origin/main");

  const onDefault = page.locator(".inbox-row-git").nth(4);
  await expect(onDefault.locator(".inbox-row-branch")).toHaveText("fix/issue-679-follow-up");
  await expect(onDefault.locator(".inbox-row-base")).toHaveCount(0);
});

// Two card shapes mean two virtualization estimates, and an estimate that does not match what the
// cards actually measure is only visible AFTER a scroll: the rows the reader has not reached yet
// are positioned from it. Crossing the breakpoint mid-scroll exercises both, plus the measurement
// epoch that has to invalidate one shape's cached sizes without losing the reader's place.
test("crossing the breakpoint keeps the reader's row and the list's geometry", async ({ page }) => {
  // Short enough that eleven cards genuinely overflow the list in BOTH shapes.
  await useViewport(page, 1400, 800);
  const list = page.locator(".inbox-list");
  await expect(page.locator(".inbox-row").first()).toBeVisible();

  const anchorTitle = "Orphaned Background Work Beside a Branch";

  /**
   * How far the reader's row sits OUTSIDE the list's visible band, in pixels; 0 while it is on
   * screen.
   *
   * Not `toBeInViewport`, which demands any intersection at all. Crossing the breakpoint changes the
   * card's height by about 21px, so a row that was already a few pixels above the fold can finish a
   * few pixels below it — measured, the worst case here is 20px, against a card of roughly 94px. The
   * promise the list makes is that your row does not go far, not that it never crosses an edge, and
   * an assertion that cannot tell 20px from 800px is not testing the promise.
   */
  const anchorDisplacement = async (): Promise<number> => await page.evaluate((title) => {
    const list = document.querySelector<HTMLElement>(".inbox-list")!;
    const band = list.getBoundingClientRect();
    const row = [...document.querySelectorAll<HTMLElement>(".inbox-row-title")]
      .find((node) => node.textContent?.includes(title));
    if (!row) return Number.POSITIVE_INFINITY;
    const box = row.getBoundingClientRect();
    if (box.bottom < band.top) return band.top - box.bottom;
    if (box.top > band.bottom) return box.top - band.bottom;
    return 0;
  }, anchorTitle);

  const cardHeight = async (): Promise<number> =>
    await page.locator(".inbox-row").first().evaluate((row) => row.getBoundingClientRect().height);

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

  // ONE crossing at a time, each starting from a fresh scroll to the reader's row.
  //
  // A single sequence of resizes chained end to end tests something else: four restores in a row,
  // each starting from wherever the last one left off, and the drift accumulates until the failure
  // names a width that did nothing wrong. What the list actually promises is that ONE crossing keeps
  // the reader where they were, so that is what each case does.
  for (const [from, to] of [
    [1400, TABLET_BREAKPOINT_PX],
    [TABLET_BREAKPOINT_PX, 1400],
    [TABLET_BREAKPOINT_PX + 1, TABLET_BREAKPOINT_PX],
    [390, 1400],
    [1400, 390],
  ] as const) {
    await useViewport(page, from, 800);
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

    await useViewport(page, to, 800);
    // Within one card of where it was. A card is the unit a reader notices: land inside one and the
    // list looks like it held its place, land several away and it looks like it jumped.
    await expectGeometryPoll(
      anchorDisplacement,
      `the reader's row stays within one card across ${from} to ${to}`,
    ).toBeLessThanOrEqual(await cardHeight());

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
  await expect(list).toBeVisible();
});

// Round two of cross-model review, confirmed by measurement: the phone card's DOM order had moved.
// The lead wrapper was rendered at every width and dissolved on a phone with `display: contents`,
// which lays out identically to the pixel but does NOT reorder the accessibility tree — the row
// announced sender, branch, title while showing sender, title, branch. A screenshot diff cannot see
// this, so the reading order is asserted directly, at both shapes.
for (const [width, expected] of [
  [390, ["inbox-row-sender", "inbox-row-copy", "inbox-row-meta", "inbox-row-signals"]],
  // On a desktop card the Git state really is on line one, so the lead's DOM order IS the visual
  // order: sender then branch, then the title line below it.
  [1400, ["inbox-row-lead", "inbox-row-copy", "inbox-row-signals"]],
] as const) {
  test(`the card's reading order matches its visual order at ${width}px`, async ({ page }) => {
    await useViewport(page, width);
    const order = await page.locator(".inbox-row").first().evaluate((row) =>
      [...row.children].map((child) => child.className));
    expect(order).toEqual([...expected]);

    // The row's own text, which is what its accessible name is computed from, in reading order.
    const reading = await page.locator(".inbox-row").first().evaluate((row) => {
      const seen: string[] = [];
      for (const selector of [".inbox-row-sender", ".inbox-row-title", ".inbox-row-git"]) {
        const node = row.querySelector<HTMLElement>(selector)!;
        seen.push(`${selector}@${[...row.querySelectorAll("*")].indexOf(node)}`);
      }
      return seen;
    });
    const positions = reading.map((entry) => Number(entry.split("@")[1]));
    if (stacked(width)) {
      // sender, then title, then Git state — #782's order, unchanged.
      expect(positions[0]).toBeLessThan(positions[1]!);
      expect(positions[1]).toBeLessThan(positions[2]!);
    } else {
      // sender, then Git state, then title — which is what a desktop card shows.
      expect(positions[0]).toBeLessThan(positions[2]!);
      expect(positions[2]).toBeLessThan(positions[1]!);
    }
  });
}

// Round two, second finding, also confirmed: the sender's label ellipsizes but the 16px agent icon
// is `flex: none`. With the sender box squeezed to 0 the icon kept painting, 6px into the branch
// name beside it. "The sender yields first" has to mean it disappears, not that it overlaps.
test("a sender squeezed to nothing takes its icon with it instead of painting over the branch", async ({ page }) => {
  // The narrowest two-row card, where line one is under the most pressure it ever sees.
  await useViewport(page, TABLET_BREAKPOINT_PX + 1);
  const geometry = await page.locator(".inbox-row").first().evaluate((row) => {
    const signals = row.querySelector<HTMLElement>(".inbox-row-signals")!;
    // Four, not two: at the narrowest two-row width there is more line to spend than there was at
    // 770px, and the premise of this test is that the sender really has been spent.
    for (let index = 0; index < 4; index += 1) {
      const pill = document.createElement("span");
      pill.className = "inbox-status-pill blocked";
      pill.textContent = "Approval Required";
      signals.prepend(pill);
    }
    const sender = row.querySelector<HTMLElement>(".inbox-row-sender")!;
    const icon = sender.querySelector("svg, img")!;
    const meta = row.querySelector<HTMLElement>(".inbox-row-meta")!;
    const iconBox = icon.getBoundingClientRect();
    const metaBox = meta.getBoundingClientRect();
    // HIT TESTING, not rectangles. `getBoundingClientRect` reports an element's own geometry whether
    // or not an ancestor clips it, so the icon's rect still runs past a `overflow: hidden` sender.
    // What is actually painted at the contested point is what `elementFromPoint` answers.
    const contested = iconBox.right - 2;
    const painted = document.elementFromPoint(contested, iconBox.top + iconBox.height / 2);
    return {
      senderWidth: sender.getBoundingClientRect().width,
      senderClipsOverflow: getComputedStyle(sender).overflowX,
      contestedInsideMeta: contested > metaBox.left,
      iconOwnsContestedPoint: painted != null && (painted === icon || icon.contains(painted)),
      metaOwnsContestedPoint: painted != null && meta.contains(painted),
    };
  });

  // The premise: this pressure really does collapse the sender, and the icon's box really does
  // extend into the Git line's territory.
  expectGeometry(geometry.senderWidth, "the squeezed sender collapses before painting over Git")
    .toBeLessThanOrEqual(1);
  expect(geometry.senderClipsOverflow).toBe("hidden");
  expect(geometry.contestedInsideMeta).toBe(true);
  // And nothing of the sender is painted there: the icon is clipped away with its box.
  expect(geometry.iconOwnsContestedPoint).toBe(false);
  expect(geometry.metaOwnsContestedPoint).toBe(true);
});

// #901's whole claim, and it is stronger than "readable": BELOW the threshold the Git state has a
// line of its own, so a crowded signals column cannot reach it at all. The branch is the same width
// crowded as uncrowded.
//
// An earlier version asserted `crowded > roomy * 0.4` at both 900px and 901px. At 900px that is true
// by a mile — the real ratio is 1.0 — and at 901px it was true by 5%, which CI promptly disproved:
// the two-row card there keeps 42% of the branch on a developer machine and 20% on the runner. The
// assertion was relative and still had no headroom, and worse, it claimed something at 901px that
// #901 never fixed. The squeeze just above the threshold is #877's documented residual; what this
// change does is put the widths where it bites on the other side of the line.
test(`a crowded card keeps its whole branch name at ${TABLET_BREAKPOINT_PX}px`, async ({ page }) => {
  await useViewport(page, TABLET_BREAKPOINT_PX);
  const roomy = await measureUnderSignalPressure(page, 0);
  // Four pills beyond the fixture's lifecycle pill and Stalled: a card showing an attention pill, an
  // orphaned-background-work pill, a reminder, and one more at once.
  const crowded = await measureUnderSignalPressure(page, 4);

  expectGeometry(Math.abs(crowded.branchWidth - roomy.branchWidth), "stacked cards preserve branch width under pressure")
    .toBeLessThanOrEqual(0.5);
  expectGeometry(Math.abs(crowded.height - roomy.height), "stacked cards preserve height under pressure")
    .toBeLessThanOrEqual(0.5);
  expectGeometry(crowded.signalsOverflowRight, "stacked pressured signals stay inside the row")
    .toBeLessThanOrEqual(0.5);
});

// One pixel wider the card is two rows again, and the Git state shares line one. The branch DOES
// give up width there — that is the trade #877 made and #901 bounds rather than removes. What must
// still hold is everything that is not about width: the card does not change height, and nothing is
// drawn past its edge.
test(`a crowded card stays intact at ${TABLET_BREAKPOINT_PX + 1}px, where the branch does yield`, async ({ page }) => {
  await useViewport(page, TABLET_BREAKPOINT_PX + 1);
  const roomy = await measureUnderSignalPressure(page, 0);
  const crowded = await measureUnderSignalPressure(page, 4);

  expectGeometry(Math.abs(crowded.height - roomy.height), "two-row cards preserve height under pressure")
    .toBeLessThanOrEqual(0.5);
  expectGeometry(crowded.signalsOverflowRight, "two-row pressured signals stay inside the row")
    .toBeLessThanOrEqual(0.5);
  // The branch is narrower than it was, and still there rather than erased.
  expectGeometry(crowded.branchWidth - roomy.branchWidth, "the two-row branch yields under pressure")
    .toBeLessThan(0);
  expectGeometry(crowded.branchWidth, "the yielding branch remains present").toBeGreaterThan(0);
});

// The stacked card is what the narrow widths fall back to, so it has to actually be the stacked one
// — and the two-row card has to start exactly one pixel further out. This is the pair of widths the
// stylesheet and useIsTabletOrSmaller() must agree about; tokens.test.ts pins that they do.
test("the card changes shape across the tablet breakpoint and nowhere else nearby", async ({ page }) => {
  for (const [width, expected] of [
    [TABLET_BREAKPOINT_PX - 1, 3],
    [TABLET_BREAKPOINT_PX, 3],
    [TABLET_BREAKPOINT_PX + 1, 2],
    [TABLET_BREAKPOINT_PX + 2, 2],
  ] as const) {
    await useViewport(page, width);
    const tracks = await page.locator(".inbox-row").first().evaluate((row) =>
      getComputedStyle(row).gridTemplateRows.split(" ").filter(Boolean).length);
    expect(tracks, `${width}px`).toBe(expected);
  }
});
