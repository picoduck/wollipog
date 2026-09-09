import { expect, test } from "@playwright/test";

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

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: VIEWPORT_HEIGHT });
  await page.goto("/command-inbox-projects-e2e.html?scenario=inbox-row-layout");
  await expect(page.locator(".inbox-row")).toHaveCount(11);
});

for (const width of WIDTHS) {
  test(`every active row shows its whole activity strip at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
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
      expect(strip.stripWidth).toBeGreaterThan(50);
      expect(strip.overflowRight).toBeLessThanOrEqual(0.5);
      expect(strip.overflowLeft).toBeLessThanOrEqual(0.5);
    }
    // The strip never shrinks, so its width is identical on every row at a given width.
    expect(Math.max(...strips.map((s) => s.stripWidth)) - Math.min(...strips.map((s) => s.stripWidth)))
      .toBeLessThanOrEqual(0.5);
  });

  test(`a long title fades instead of displacing the strip at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
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
      expect(title.right).toBeLessThanOrEqual(title.stripLeft + 1);
    }
    // A title long enough to overrun this viewport is present at every width under test, so the
    // fade is actually exercised and not merely declared.
    expect(titles.filter((title) => title.clipped).length).toBeGreaterThan(0);
    // Every title starts on the same reading axis, whatever the row's signals or worktree line.
    expect(Math.max(...titles.map((t) => t.left)) - Math.min(...titles.map((t) => t.left)))
      .toBeLessThanOrEqual(1);
  });
}

// #782 replaces #664's two-versus-three-line contract. That contract WAS the bug: it asserted that
// a session without a worktree took two lines and one with a worktree took three, and a visible
// background badge then took a fourth nobody had accounted for. One shape now, at every width.
const measureRows = (nodes: Element[]) => nodes.map((node) => {
  const row = node as HTMLElement;
  const box = row.getBoundingClientRect();
  const style = getComputedStyle(row);
  const sender = row.querySelector<HTMLElement>(".inbox-row-sender")!;
  const copy = row.querySelector<HTMLElement>(".inbox-row-copy")!;
  const meta = row.querySelector<HTMLElement>(".inbox-row-meta")!;
  const git = row.querySelector<HTMLElement>(".inbox-row-git");
  const badge = row.querySelector<HTMLElement>(".inbox-row-background-work");
  const shell = row.closest<HTMLElement>(".inbox-row-shell")!;
  const metaBox = meta.getBoundingClientRect();
  return {
    height: box.height,
    // Three DISTINCT baselines, so a row cannot pass by stacking two things on one line.
    lineTops: [...new Set([sender, copy, meta].map((line) => Math.round(line.getBoundingClientRect().top)))].length,
    gitText: (git?.textContent ?? "").trim(),
    // Nothing may sit below line three inside the card; a fourth row is exactly what that looks like.
    metaBottom: metaBox.bottom,
    cardInnerBottom: box.bottom - parseFloat(style.paddingBottom),
    metaTop: metaBox.top,
    badgeTop: badge ? badge.getBoundingClientRect().top : null,
    badgeWidth: badge ? badge.getBoundingClientRect().width : null,
    badgeOverflowRight: badge
      ? badge.getBoundingClientRect().right - (box.right - parseFloat(style.paddingRight))
      : null,
    stripBottom: row.querySelector<HTMLElement>(".inbox-row-activity")!.getBoundingClientRect().bottom,
    top: shell.getBoundingClientRect().top,
    bottom: shell.getBoundingClientRect().bottom,
  };
});

for (const width of WIDTHS) {
  test(`every card is exactly three rows with an explicit Git state at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    const rows = await page.locator(".inbox-row").evaluateAll(measureRows);

    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row.lineTops).toBe(3);
      // Every card says something about Git; none of them says it by saying nothing.
      expect(row.gitText.length).toBeGreaterThan(0);
      expect(row.metaBottom).toBeLessThanOrEqual(row.cardInnerBottom + 0.5);
      if (row.badgeTop !== null) {
        // On line three with the Git state, below the strip, and never past the card's edge.
        expect(Math.abs(row.badgeTop - row.metaTop)).toBeLessThanOrEqual(4);
        expect(row.badgeTop).toBeGreaterThanOrEqual(row.stripBottom - 0.5);
        expect(row.badgeWidth!).toBeGreaterThan(20);
        expect(row.badgeOverflowRight!).toBeLessThanOrEqual(0.5);
      }
    }
    // Four of the eleven carry background work, and they are the same height as the seven that do
    // not — which is what makes ONE virtualization estimate honest.
    expect(rows.filter((row) => row.badgeTop !== null)).toHaveLength(4);
    expect(Math.max(...rows.map((row) => row.height)) - Math.min(...rows.map((row) => row.height)))
      .toBeLessThanOrEqual(1);
    // The virtualizer positions from measured heights: no overlap, no gap it cannot explain.
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index]!.top).toBeGreaterThanOrEqual(rows[index - 1]!.bottom - 0.5);
      expect(rows[index]!.top - rows[index - 1]!.bottom).toBeLessThan(24);
    }
  });
}

test("a card's height does not move with selection, unread, or stalled state", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: VIEWPORT_HEIGHT });
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
      expect(Math.abs(height - baseline[index]!), `${state} card ${index}`).toBeLessThanOrEqual(0.5);
    }
  }
});

test("the Git line names a branch, admits to none, or admits to not knowing", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: VIEWPORT_HEIGHT });
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

test("every background-work state reaches the right of the Git line with its accessible name", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: VIEWPORT_HEIGHT });
  for (const [index, label] of [
    [7, "Waiting on External Job"],
    [8, "Waiting on External Job"],
    [9, "Continuation Pending"],
    [10, "Orphaned"],
  ] as const) {
    const badge = page.locator(".inbox-row-meta").nth(index).locator(".background-work-badge");
    await expect(badge).toHaveAttribute("aria-label", `Background Work: ${label}`);
  }
});

// The long branch, long base and PR pill of row eight now share line three with a badge. The badge
// is the item that must survive; the base ref is the one that yields first.
for (const width of [390, 770, 1400]) {
  test(`a long branch yields to the PR pill and the background badge at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    const geometry = await page.locator(".inbox-row-meta").nth(8).evaluate((node) => {
      const row = node.closest<HTMLElement>(".inbox-row")!;
      const style = getComputedStyle(row);
      const rightEdge = row.getBoundingClientRect().right - parseFloat(style.paddingRight);
      const pill = node.querySelector<HTMLElement>(".inbox-row-pr-pill")!;
      const badge = node.querySelector<HTMLElement>(".background-work-badge")!;
      const branch = node.querySelector<HTMLElement>(".inbox-row-branch")!;
      return {
        branchWidth: branch.getBoundingClientRect().width,
        pillWidth: pill.getBoundingClientRect().width,
        badgeWidth: badge.getBoundingClientRect().width,
        pillOverflowRight: pill.getBoundingClientRect().right - rightEdge,
        badgeOverflowRight: badge.getBoundingClientRect().right - rightEdge,
        // Nothing on the line may be drawn over anything else.
        pillClearsBadge: badge.getBoundingClientRect().left - pill.getBoundingClientRect().right,
      };
    });

    expect(geometry.branchWidth).toBeGreaterThan(40);
    expect(geometry.pillWidth).toBeGreaterThan(20);
    expect(geometry.badgeWidth).toBeGreaterThan(20);
    expect(geometry.pillOverflowRight).toBeLessThanOrEqual(0.5);
    expect(geometry.badgeOverflowRight).toBeLessThanOrEqual(0.5);
    expect(geometry.pillClearsBadge).toBeGreaterThanOrEqual(-0.5);
  });
}

test("the worktree line hides a default base ref and keeps a stacked one", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: VIEWPORT_HEIGHT });
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
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
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
    expect(geometry.branchWidth).toBeGreaterThan(80);
    expect(geometry.pillWidth).toBeGreaterThan(20);
    expect(geometry.pillOverflowRight).toBeLessThanOrEqual(0.5);
    // The base ref yields width rather than taking it; it is the least important item on the line.
    expect(geometry.baseWidth).toBeGreaterThan(0);
  });
}

test("a phone drops the base ref from the worktree line but keeps branch and PR state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: VIEWPORT_HEIGHT });
  const stacked = page.locator(".inbox-row-git").nth(1);
  await expect(stacked.locator(".inbox-row-branch")).toBeVisible();
  await expect(stacked.locator(".inbox-row-pr-pill")).toBeVisible();
  await expect(stacked.locator(".inbox-row-base")).toBeHidden();
});

test("the message preview no longer renders in Inbox rows", async ({ page }) => {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    await expect(page.locator(".inbox-row-snippet")).toHaveCount(0);
    await expect(page.locator(".inbox-row").first()).not.toContainText("preview");
  }
});

// #679: the row compares against the repository's reported default branch instead of guessing from
// the branch's name, so a `develop`-default repository keeps an explicit `origin/main` base.
test("a reported default branch decides whether the base ref is worth showing", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: VIEWPORT_HEIGHT });
  const nonDefault = page.locator(".inbox-row-git").nth(3);
  await expect(nonDefault.locator(".inbox-row-branch")).toHaveText("fix/issue-679-default-branch");
  await expect(nonDefault.locator(".inbox-row-base")).toContainText("← origin/main");

  const onDefault = page.locator(".inbox-row-git").nth(4);
  await expect(onDefault.locator(".inbox-row-branch")).toHaveText("fix/issue-679-follow-up");
  await expect(onDefault.locator(".inbox-row-base")).toHaveCount(0);
});
