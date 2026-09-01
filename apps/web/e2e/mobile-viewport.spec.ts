import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { GLOBAL_VIEW_ITEMS, viewPath, viewTitle, type View } from "../src/navigation.js";
import { MOBILE_PRIMARY_VIEWS } from "../src/components/Rail.js";
import { KEYBOARD_DISMISS_BLUR_EVENT } from "../src/mobile-viewport.js";

/**
 * The software keyboard, end to end.
 *
 * #207's finding was that a phone's bottom rail sits behind the keyboard on browsers that ignore
 * `interactive-widget=resizes-content` and shrink only the visual viewport: `100dvh` still measures
 * the full screen, so every destination is unreachable while typing. `mobile-viewport.test.ts`
 * covers the computation; what it cannot see is whether the STYLESHEET consumes the result. These
 * assert rendered geometry — where the rail and the sheet actually end up.
 */

/**
 * The sheet's trailing row (#458), which is a route but deliberately not a GLOBAL_VIEW_ITEMS
 * destination — that array numbers the desktop rail and its digit shortcuts. Both halves come from
 * production's own canonical functions so the checks below stay non-circular.
 */
const SETTINGS_ROW = {
  path: viewPath({ name: "settings" } as View),
  title: viewTitle({ name: "settings" } as View),
};

const phone = devices["Pixel 7"];
test.use({
  // The descriptor's own properties, minus defaultBrowserType, which Playwright rejects here.
  viewport: phone.viewport,
  hasTouch: phone.hasTouch,
  isMobile: phone.isMobile,
  userAgent: phone.userAgent,
  // Not optional, and it was missing. Without it the context runs at DPR 1 while the user agent and
  // viewport claim a Pixel 7, so `@media (min-resolution: 2dppx)` matched nothing — a rule erasing
  // the rail on every high-density phone, which is nearly all of them, was invisible here. It also
  // means every floor below is calibrated at the density the named device actually renders at.
  deviceScaleFactor: phone.deviceScaleFactor,
  screen: phone.screen,
  reducedMotion: "reduce",
});

const KEYBOARD = 300;

/**
 * What a single element contributes to the screen, isolated from everything around it.
 *
 * Measured by DIFFERENCE: the element's box is captured twice, once as rendered and once with
 * `visibility: hidden` on that element alone, and only positions where the two differ are counted.
 * Layout is preserved by `visibility`, so the second capture is the same region with the mark
 * lifted out — every pixel it still contains belongs to something else.
 *
 * Every earlier version of this asked "how much of the capture differs from its most common
 * colour", and each one lost to something that painted inside the box without being the mark:
 *
 * - The dominant colour need not be the surface. `background: linear-gradient(90deg, #000 0 58%,
 *   #fff 58%)` on the item makes black dominant inside the icon's box, and the 247 white pixels of
 *   that same gradient score 21:1 and were counted as icon.
 * - Nor need the paint belong to the element. An ancestor's `::after` positioned over the icon, or
 *   a `::after` on the label carrying `content: "Destination"`, was counted in full — the second
 *   one replaced every overflow label with fixed text and the suite stayed green.
 *
 * Both disappear here: a gradient, an overlay and a pseudo-element are all present in both
 * captures and cancel. Contrast is likewise per-position, against the pixel actually behind the
 * mark rather than a single guessed surface, so a non-flat backdrop is measured correctly instead
 * of being assumed away.
 *
 * The suppression is OBSERVABLE, though, and that is the one thing this technique has to defend.
 * Hiding the mark writes an inline style, and CSS can select on it:
 * `.rail-more-item:has(> span[style*="visibility: hidden"]) { background: var(--text) }` repaints
 * the row for the reference capture only, and the whole box then reads as high-contrast label ink
 * while the real label sits at `opacity: 0.1`. So the capture covers the mark's PARENT, and
 * everything outside the mark's own box must be byte-identical between the two: if suppressing the
 * mark changed anything anywhere else, the difference is not the mark's and the measurement is
 * refused rather than reported.
 */
interface Ink {
  /** Positions the element changes at all: its GEOMETRY, antialiasing included. */
  paint: number;
  /** Positions where it reaches `minContrast` against what is behind it. */
  legible: number;
  /** Cells of the mark that are solidly painted and contain nothing legible at all. */
  illegibleCells: number;
  /** Positions OUTSIDE the mark's box that suppressing it changed. Must be nothing. */
  outside: number;
  /** Which positions inside the box the mark paints, packed as `y * 4096 + x`. */
  mask: number[];
  /** What the mark grew while it was suppressed, if anything. Must be nothing. */
  decoratedWhileHidden: string | null;
}

/** Below this a position is unchanged; above it the element put something there. */
const PAINT_CONTRAST = 1.02;

/**
 * The grid the mark is checked over, in device pixels, and how much paint makes a cell count.
 *
 * A totals-only check cannot see a small part of a mark going: fading the Inbox glyph's two inner
 * lines, or the last character of every overflow label, moves the legible FRACTION by less than the
 * spread between themes, so no threshold on it separates the two. Both are obvious spatially —
 * there is a region that is solidly painted and contains nothing readable. The cell is a little
 * larger than a stroke is wide, so an antialiased stroke edge never fills one on its own.
 */
const CELL = 5;
const CELL_PAINT = 12;

/**
 * How much repaint further than one pixel outside the mark's box is written off.
 *
 * Zero: the one-pixel margin already absorbs the mark's own edge antialiasing, so anything beyond
 * it is another element reacting to the suppression, and a rule repainting an ancestor is hundreds
 * of positions.
 */
const OUTSIDE_TOLERANCE = 0;

async function inkOf(page: Page, locator: Locator, minContrast: number): Promise<Ink> {
  // Two rectangles: the mark's own box, and a GUARD region around it — its parent's box. Both are
  // fixed page-space clips rather than `locator.screenshot`, because the same rectangle has to be
  // captured twice to be comparable and an element screenshot waits for the element to be visible,
  // which with the mark hidden never happens.
  const clip = await locator.evaluate((element) => {
    const own = element.getBoundingClientRect();
    const guard = (element.parentElement ?? element).getBoundingClientRect();
    const box = (rect: DOMRect) => ({
      x: Math.floor(rect.x + window.scrollX), y: Math.floor(rect.y + window.scrollY),
      width: Math.max(1, Math.ceil(rect.width)), height: Math.max(1, Math.ceil(rect.height)),
    });
    return { own: box(own), guard: box(guard) };
  });
  const shown = (await page.screenshot({ clip: clip.guard, animations: "disabled" })).toString("base64");
  const restore = await locator.evaluate((element) => {
    const previous = (element as HTMLElement).style.visibility;
    (element as HTMLElement).style.visibility = "hidden";
    return previous;
  });
  // Read while suppressed, before the capture that depends on it.
  const decoratedWhileHidden = await locator.evaluate((element) => {
    for (const pseudo of ["::before", "::after"] as const) {
      const style = getComputedStyle(element, pseudo);
      if (style.content !== "none") return `a ${pseudo} carrying ${style.content}`;
    }
    // A descendant that opts back in paints while its suppressed ancestor does not, and the
    // difference then reads as the ancestor's own ink.
    for (const child of element.querySelectorAll("*")) {
      if (getComputedStyle(child).visibility !== "hidden") return `a descendant that stayed visible`;
    }
    return null;
  });
  const hidden = (await page.screenshot({ clip: clip.guard, animations: "disabled" })).toString("base64");
  await locator.evaluate((element, previous) => {
    (element as HTMLElement).style.visibility = previous;
  }, restore);

  // Where the mark's box sits inside the guard capture, in CSS pixels.
  const inset = {
    x: clip.own.x - clip.guard.x, y: clip.own.y - clip.guard.y,
    width: clip.own.width, height: clip.own.height,
  };
  return page.evaluate(async ({ a, b, minContrast: floor, paintContrast, cell, cellPaint_, inset: within, guardWidth }) => {
    const load = async (b64: string) => {
      const image = new Image();
      image.src = `data:image/png;base64,${b64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      return canvas.getContext("2d")!.getImageData(0, 0, image.width, image.height);
    };
    const [front, back] = [await load(a), await load(b)];
    // Hiding the element must not move anything. If it does, the two captures are not comparable
    // and a silent zero would read as "erased" rather than "unmeasurable".
    if (front.width !== back.width || front.height !== back.height) {
      return { paint: -1, legible: -1, illegibleCells: -1, outside: -1, mask: [] as number[] };
    }

    const channel = (value: number) => {
      const v = value / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (r: number, g: number, b2: number) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b2);

    // The guard capture is in device pixels; the mark's rectangle inside it is in CSS pixels.
    const scale = front.width / guardWidth;
    const box = {
      left: Math.round(within.x * scale), top: Math.round(within.y * scale),
      right: Math.round((within.x + within.width) * scale),
      bottom: Math.round((within.y + within.height) * scale),
    };
    // "Outside" starts one CSS pixel beyond the mark's box. The box is snapped to whole device
    // pixels from a fractional CSS rectangle, so the mark's own edge antialiasing lands just past
    // it — at a device ratio of 2.625 that was 26 positions on a sheet label, which a flat
    // tolerance could only absorb by growing large enough to hide real repaint. A margin scales
    // with the device ratio; a count does not.
    const margin = Math.ceil(scale);
    const outer = {
      left: box.left - margin, top: box.top - margin,
      right: box.right + margin, bottom: box.bottom + margin,
    };

    let paint = 0;
    let legible = 0;
    let outside = 0;
    const columns = Math.ceil(front.width / cell);
    const cellPaint = new Int32Array(columns * Math.ceil(front.height / cell));
    const cellLegible = new Int32Array(cellPaint.length);
    const mask: number[] = [];
    for (let y = 0; y < front.height; y += 1) {
      for (let x = 0; x < front.width; x += 1) {
        const index = (y * front.width + x) * 4;
        const mark = luminance(front.data[index]!, front.data[index + 1]!, front.data[index + 2]!);
        const behind = luminance(back.data[index]!, back.data[index + 1]!, back.data[index + 2]!);
        const [hi, lo] = mark > behind ? [mark, behind] : [behind, mark];
        const ratio = (hi + 0.05) / (lo + 0.05);
        const painted = ratio >= paintContrast;
        if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) {
          // Outside the mark's own box. Suppressing the mark may not change anything beyond one
          // pixel of it — if it does, something else in the page is reacting to the suppression and
          // the difference is no longer attributable to the mark.
          if (painted && (x < outer.left || x >= outer.right || y < outer.top || y >= outer.bottom)) {
            outside += 1;
          }
          continue;
        }
        const bucket = Math.floor(y / cell) * columns + Math.floor(x / cell);
        if (painted) { paint += 1; cellPaint[bucket] += 1; mask.push((y - box.top) * 4096 + (x - box.left)); }
        if (ratio >= floor) { legible += 1; cellLegible[bucket] += 1; }
      }
    }
    let illegibleCells = 0;
    for (let bucket = 0; bucket < cellPaint.length; bucket += 1) {
      if (cellPaint[bucket]! >= cellPaint_ && cellLegible[bucket]! === 0) illegibleCells += 1;
    }
    return { paint, legible, illegibleCells, outside, mask };
  }, {
    a: shown, b: hidden, minContrast, paintContrast: PAINT_CONTRAST, cell: CELL, cellPaint_: CELL_PAINT,
    inset, guardWidth: clip.guard.width,
  }).then((ink) => ({ ...ink, decoratedWhileHidden }));
}

/**
 * The measured element may not paint anything that is not its content.
 *
 * The difference measurement above removes everything painted by an ancestor or a sibling, because
 * that survives into the hidden capture. What it cannot remove is fake content the element draws
 * ITSELF: a border, a fill, or a generated string all vanish with `visibility: hidden` and are
 * therefore attributed to the element, exactly as its glyph is. `.rail-item > .app-icon { border:
 * 1px solid }` with `color: transparent` is a 26x26 perimeter standing in for an erased icon, and
 * `span::after { content: "Destination" }` replaced every overflow label with fixed text.
 *
 * Production draws none of these on an icon or a label, so this only ever fails on a mutation.
 */
async function expectUndecorated(locator: Locator, label: string) {
  const decoration = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const widths = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
    if (widths.some((width) => Number.parseFloat(width) > 0)) return `border ${widths.join("/")}`;
    if (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) return `outline ${style.outlineWidth}`;
    if (style.boxShadow !== "none") return `box-shadow ${style.boxShadow}`;
    if (style.textShadow !== "none") return `text-shadow ${style.textShadow}`;
    if (style.backgroundImage !== "none") return `background-image ${style.backgroundImage}`;
    // A fill covers the whole box and reads as a very large, very legible mark.
    if (!/^(transparent|rgba\(0, 0, 0, 0\))$/.test(style.backgroundColor)) return `background ${style.backgroundColor}`;
    for (const pseudo of ["::before", "::after"] as const) {
      const content = getComputedStyle(element, pseudo).content;
      if (content !== "none") return `${pseudo} content ${content}`;
    }
    return null;
  });
  expect(decoration, `"${label}" carries ${decoration}, which would be counted as if it were content`).toBe(null);
}

/**
 * A text mark is text, not a box with text somewhere in it.
 *
 * Suppressing the label hides its children too, so anything they paint is attributed to the label:
 * an absolutely-positioned `<i>` over `color: transparent` text renders every overflow row as an
 * identical opaque slab, clears every floor, and leaves `toHaveText` passing because the canonical
 * string is still in the DOM. Production writes `<span>{item.title}</span>` — one text node, no
 * elements — so requiring exactly that costs nothing and closes the whole family.
 */
async function expectPlainText(locator: Locator, label: string) {
  const shape = await locator.evaluate((element) => ({
    elements: element.children.length,
    text: element.textContent ?? "",
  }));
  expect(shape.elements, `"${label}" contains ${shape.elements} child elements, which paint as if they were it`).toBe(0);
  expect(shape.text.trim(), `"${label}" renders no text`).not.toBe("");
}

/** Contrast floors: 3:1 for icons as non-text content, 4.5:1 for the sheet's text labels. */
const CONTRAST = { icon: 3, label: 4.5 } as const;

/**
 * How much of a mark's own paint must be legible.
 *
 * The absolute `legible` floor has to sit near half its measured value, because the count swings
 * with the theme's colours — the same label scores 184 in dark and 285 in light. That looseness is
 * a hole: fading ONE PRIMITIVE of a mark to `opacity: 0.1` keeps its pixels above the paint
 * threshold and drops them below the contrast one, so a third of an icon, or the last character of
 * every label, can go while the surviving two thirds still clear a half-height floor.
 *
 * The RATIO does not swing: measured 0.45 to 0.75 across both themes, both platforms and every
 * mark, because both counts scale together. Fading a third of a mark takes 0.45 to about 0.30.
 */
const LEGIBLE_FRACTION = 0.55;

interface Mark {
  /** Floor on the mark's geometry. Barely moves between themes, so it can sit close to the measured value. */
  paint: number;
  /** Floor on the resolvable part of it. Swings with the theme's colours, so it sits well below the minimum. */
  legible: number;
  /** How many solidly-painted-but-unreadable regions the mark is allowed. */
  illegibleCells: number;
  minContrast: number;
}

async function expectPainted(page: Page, locator: Locator, label: string, mark: Mark) {
  await expectUndecorated(locator, label);
  const ink = await inkOf(page, locator, mark.minContrast);
  // The decoration check again, this time as it stood WHILE the mark was suppressed. Running it
  // only beforehand missed a rule that arms itself on the suppression:
  // `span[style*="visibility: hidden"]::after { content: ""; visibility: visible; inset: 0;
  // background: var(--text) }` has `content: none` until the reference capture is taken, then
  // paints a solid slab exactly inside the mark's box — inside it, so the outside guard sees
  // nothing, and only while suppressed, so a check that ran before saw nothing either.
  expect(ink.decoratedWhileHidden,
    `"${label}" grew ${ink.decoratedWhileHidden} while it was suppressed, so the reference capture is not of its absence`)
    .toBe(null);
  expect(ink.paint, `"${label}" could not be measured: hiding it changed the layout`).toBeGreaterThanOrEqual(0);
  // Nothing but the mark may respond to the mark being suppressed.
  expect(ink.outside,
    `hiding "${label}" repainted ${ink.outside} positions outside its own box, so the measurement is not of it`)
    .toBeLessThanOrEqual(OUTSIDE_TOLERANCE);
  // Three floors, because each has a mutation the other two miss. Geometry alone passed
  // `opacity: 0.2`, which composites an icon to about 1.45:1 — every pixel still differs from what
  // is behind it, and none of them is distinguishable from it. An absolute contrast floor has to
  // sit at half the measured value to survive theme differences, so it is too loose to notice a
  // mark that has lost a third of itself. The fraction is what catches that third.
  expect(ink.paint, `"${label}" paints ${ink.paint} pixels, below the ${mark.paint} floor`)
    .toBeGreaterThanOrEqual(mark.paint);
  expect(ink.legible,
    `"${label}" has only ${ink.legible} pixels at ${mark.minContrast}:1, below the ${mark.legible} floor`)
    .toBeGreaterThanOrEqual(mark.legible);
  expect(ink.legible / ink.paint,
    `only ${Math.round((100 * ink.legible) / ink.paint)}% of "${label}" reaches ${mark.minContrast}:1`)
    .toBeGreaterThanOrEqual(LEGIBLE_FRACTION);
  // And the legible part has to be spread across the mark, not concentrated in it. The fraction is
  // a total, and a total cannot see a SMALL part of a mark go: fading the Inbox glyph's two inner
  // lines, or the last character of every overflow label, moves it by less than the spread between
  // themes. Both leave a region that is solidly painted and holds nothing readable.
  expect(ink.illegibleCells,
    `"${label}" has ${ink.illegibleCells} solidly painted regions with nothing legible in them`)
    .toBeLessThanOrEqual(mark.illegibleCells);
}

/**
 * Whether a click at the element's centre would actually reach it.
 *
 * Geometry is not reachability. Dropping the sheet below its own backdrop — `z-index:
 * calc(var(--z-popover) - 1)` — leaves every box unchanged while the backdrop covers the sheet and
 * swallows every destination.
 */
async function expectHittable(locator: Locator, label: string) {
  const reached = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return element === top || element.contains(top);
  });
  expect(reached, `"${label}" is covered by something and cannot be tapped`).toBe(true);
}

const THEMES = ["dark", "light"] as const;

/**
 * Floors for the identifying MARKS, not the items and not their containers.
 *
 * This has been wrong at two levels already. At container level the rail's 1px top border alone is
 * about 412 pixels, so `.rail-item { opacity: 0 }` erased every navigation icon with the floor
 * still satisfied. At item level a 44x44 border is about 172, so `color: transparent` plus a
 * visible border did the same thing one level down. Each capture below holds a single icon or a
 * single label and nothing else — no border, no badge, no active indicator.
 *
 * `paint` sits near its measured value because geometry is antialiasing coverage, which barely
 * moves: the same label measures 408 pixels in both themes while its 4.5:1 count swings 184 to 285.
 * That closeness is the point — `moreTrigger` is three dots totalling 17 pixels, and a floor loose
 * enough to be theme-proof would accept two of them.
 *
 *   measured paint / legible at the device's own 2.625 ratio, both themes, portrait and landscape
 *   icon       1154-1547 / 944-1295      moreTrigger   101-108 / 71-86
 *   sheetIcon   346-451  / 292-381       sheetLabel   2084-3204 / 1363-2556
 *   sheetSettingsLabel 1503-1769 / 1038-1229
 *
 * "Settings" needs its own floor because the sheetLabel range was measured against destination
 * titles, the shortest of which is "Automations" — a word with half again the ink of "Settings".
 * A floor loose enough to cover both would sit under 1503 and stop catching a destination label
 * that had lost a third of itself, which is the mutation these floors exist for. The ratio to the
 * measured minimum is the same as sheetLabel's.
 */
const MARKS = {
  icon: { paint: 1000, legible: 450, illegibleCells: 0, minContrast: CONTRAST.icon },
  /* The Automations bolt joined the primary bar when Board became a mode of Sessions (#499).
     It is one stroked path where the other primary glyphs are two or three, so it measures 895
     paint / 716-746 legible against the icon family's 1154-1547 / 944-1295 — a floor calibrated
     for the beefier marks would reject a bolt that is fully painted. Same ratios to the measured
     minimum as `icon`, so losing a third of the bolt still trips it. */
  boltIcon: { paint: 780, legible: 340, illegibleCells: 0, minContrast: CONTRAST.icon },
  moreTrigger: { paint: 90, legible: 35, illegibleCells: 0, minContrast: CONTRAST.icon },
  sheetIcon: { paint: 300, legible: 140, illegibleCells: 0, minContrast: CONTRAST.icon },
  sheetLabel: { paint: 1850, legible: 650, illegibleCells: 0, minContrast: CONTRAST.label },
  sheetSettingsLabel: { paint: 1330, legible: 490, illegibleCells: 0, minContrast: CONTRAST.label },
} as const satisfies Record<string, Mark>;

interface HarnessOptions {
  theme?: (typeof THEMES)[number];
  connections?: number;
  /** Which destination is current. An overflow name makes the More trigger and one sheet row active. */
  view?: string;
  /** Occlusion already present when the fallback installs, firing no event at all. */
  keyboard?: number;
  /** Session counts, which render badges on Inbox as production's live counts do. */
  blocked?: number;
  stalled?: number;
}

async function useHarness(page: Page, options: HarnessOptions = {}) {
  const { theme = "dark", connections = 1, view = "inbox", keyboard = 0, blocked = 0, stalled = 0 } = options;
  await page.goto(`/mobile-viewport-e2e.html?theme=${theme}&connections=${connections}&view=${view}`
    + `&keyboard=${keyboard}&blocked=${blocked}&stalled=${stalled}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator(".app-rail")).toBeVisible();
  // The controller is assigned in an effect, which can flush after the DOM commit — waiting on the
  // Rail alone raced it on a cold run.
  await expect.poll(() => page.evaluate(() => typeof window.keyboardApplies === "function")).toBe(true);
  // The fallback only applies below 760px, and a desktop-width run would pass every assertion
  // below for the wrong reason.
  expect(await page.evaluate(() => matchMedia("(max-width: 760px)").matches),
    "these rules only exist on the phone breakpoint").toBe(true);
}

/**
 * Drives the fake viewport and waits for the fallback's coalesced frame to have RUN.
 *
 * Every assertion about `--keyboard-inset` has to go through this. Polling for a value happens to
 * work — it just waits — but polling for ABSENCE reads an already-empty property and can pass
 * before the scheduled write, so the two negative cases below were resolved by frame timing rather
 * than by the code under test. That made the `NOISE_FLOOR_PX` mutation results unsound in both
 * directions: raising the floor to 119 and lowering it to 3 are exactly the mutations those cases
 * exist to catch. The fixture counts the fallback's frames; waiting for the count to advance makes
 * the read deterministic.
 */
async function applyViewport(page: Page, mutate: () => Promise<void>) {
  const before = await page.evaluate(() => window.keyboardApplies());
  await mutate();
  await expect
    .poll(() => page.evaluate(() => window.keyboardApplies()),
      { message: "the fallback never ran its scheduled frame" })
    .toBeGreaterThan(before);
}

async function expectInset(page: Page, value: string) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--keyboard-inset")))
    .toBe(value);
}

/** Occludes the bottom of the visual viewport, as a keyboard does, and waits for the write. */
async function openKeyboard(page: Page, pixels = KEYBOARD) {
  await applyViewport(page, () => page.evaluate((amount) => window.setKeyboard(amount), pixels));
  await expectInset(page, `${pixels}px`);
}

test("the app shortens by the occluded band", async ({ page }) => {
  await useHarness(page);
  const full = await page.evaluate(() => document.getElementById("root")!.getBoundingClientRect().height);

  await openKeyboard(page);
  const shortened = await page.evaluate(() => document.getElementById("root")!.getBoundingClientRect().height);
  // Not merely "smaller": the whole point is that it clears the keyboard exactly.
  expect(Math.round(full - shortened), "the root must lose exactly the occluded height").toBe(KEYBOARD);
});

for (const theme of THEMES) {
  test(`every destination is painted and tappable in ${theme}`, async ({ page }) => {
    await useHarness(page, { theme });
    await openKeyboard(page);
    await expectEveryPrimaryDestinationUsable(page);
    await page.locator(".rail-more-trigger").click();
    await expect(page.locator(".rail-more-sheet")).toBeVisible();
    await expectEveryDestinationReachable(page, KEYBOARD);
  });
}

/**
 * The state a fresh install renders in, where Connections has no count badge.
 *
 * With one runner online that destination paints a badge, and a measurement of the whole item let
 * the badge stand in for the icon. Zero is both the honest default and the case with nothing else
 * in the box.
 */
test("every destination is painted with no connections online", async ({ page }) => {
  await useHarness(page, { connections: 0 });
  await expect(page.locator(".rail-badge")).toHaveCount(0);
  await openKeyboard(page);
  await expectEveryPrimaryDestinationUsable(page);
});

/**
 * The counted state, which production reaches whenever a session needs attention.
 *
 * The fixture hardcoded zero for both, so `.app-rail:has(.rail-badge.blocked) { opacity: 0 }` —
 * any blocked session at all — erased the production navigation and matched nothing here.
 */
test("every destination is painted with blocked and stalled sessions", async ({ page }) => {
  await useHarness(page, { blocked: 3, stalled: 2 });
  await expect(page.locator(".rail-badge.blocked")).toHaveCount(1);
  await expect(page.locator(".rail-badge.stalled")).toHaveCount(1);
  await openKeyboard(page);
  await expectEveryPrimaryDestinationUsable(page);
});

/**
 * No two destinations look the same.
 *
 * A pixel count cannot tell an inbox glyph from a rectangle — replacing every icon's path with
 * `<rect x="6.5" y="2.5" width="11" height="19" fill="currentColor"/>` clears every floor here
 * while reducing the bar to nine identical slabs. Proving each glyph is the RIGHT one needs
 * committed per-icon baselines, which is a larger piece of work than this suite; proving they are
 * DISTINCT costs one comparison and rules out the whole family of mutations that collapses them,
 * which is what actually makes a tab bar unusable.
 */
test("no two destinations render the same glyph", async ({ page }) => {
  await useHarness(page);
  await openKeyboard(page);
  await page.locator(".rail-more-trigger").click();
  await expect(page.locator(".rail-more-sheet")).toBeVisible();

  const icons = page.locator(".rail-destinations > .rail-item > svg, .rail-more-item > svg");
  const count = await icons.count();
  // Every destination plus the sheet's trailing Settings row. The gear is measured with them
  // rather than excluded: a Settings glyph collapsed into a destination's shape is exactly as
  // unusable as two destinations sharing one, and this is the only check that would catch it.
  expect(count, "every destination and the Settings row must carry an icon")
    .toBe(GLOBAL_VIEW_ITEMS.length + 1);
  // The MASK, not the screenshot. Comparing raw captures compares the backdrop too, so nine
  // identical rectangles over nine `nth-child` background tints five levels apart differed by
  // hundreds of pixels and passed. A mask holds only the positions the glyph itself paints, which
  // is what the difference measurement already isolates, so a backdrop cannot contribute to it.
  const masks: { key: string; positions: number[] }[] = [];
  for (let index = 0; index < count; index += 1) {
    const icon = icons.nth(index);
    await icon.scrollIntoViewIfNeeded();
    const size = await icon.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return `${Math.round(box.width)}x${Math.round(box.height)}`;
    });
    masks.push({ key: size, positions: (await inkOf(page, icon, CONTRAST.icon)).mask });
  }

  // Normalized to each mask's own painted bounding box before comparing. A raw comparison is
  // position-sensitive, so the SAME rectangle shifted 1.5px per destination differed by more than
  // the floor while every glyph was the same meaningless bar. Translation is not identity.
  const normalized = masks.map(({ key, positions }) => {
    let minX = Number.MAX_SAFE_INTEGER;
    let minY = Number.MAX_SAFE_INTEGER;
    for (const position of positions) {
      minX = Math.min(minX, position % 4096);
      minY = Math.min(minY, Math.floor(position / 4096));
    }
    return { key, positions: new Set(positions.map((p) => (Math.floor(p / 4096) - minY) * 4096 + (p % 4096) - minX)) };
  });

  let closest = Number.MAX_SAFE_INTEGER;
  for (let a = 0; a < normalized.length; a += 1) {
    for (let b = a + 1; b < normalized.length; b += 1) {
      // Different sizes are already different glyphs; the sheet's are 20px and the rail's 26px.
      if (normalized[a]!.key !== normalized[b]!.key) continue;
      const [one, two] = [normalized[a]!.positions, normalized[b]!.positions];
      let differing = 0;
      for (const position of one) if (!two.has(position)) differing += 1;
      for (const position of two) if (!one.has(position)) differing += 1;
      closest = Math.min(closest, differing);
    }
  }
  // The closest measured pair differs by 432 positions once both are normalized to their own
  // bounding boxes. Identical glyphs differ by 0, and the same glyph translated differs by 0 too,
  // which is the point of normalizing.
  expect(closest, `the two most similar icons differ by only ${closest} painted positions`)
    .toBeGreaterThan(200);
});

/**
 * An overflow destination is current, which the fixture could not render before.
 *
 * Selecting Inbox always meant `.rail-more-trigger.active` and `.rail-more-item.active` never
 * existed here, so `.rail-more-trigger.active > svg, .rail-more-item.active > svg { opacity: 0 }`
 * matched nothing — while in production, standing on Runs, Pods, Automations or Usage gives a blank
 * active More control and an erased current row inside the sheet.
 */
for (const current of GLOBAL_VIEW_ITEMS.filter((item) => !MOBILE_PRIMARY_VIEWS.includes(item.name))) {
  test(`the More control reads as current on ${current.title}`, async ({ page }) => {
    await useHarness(page, { view: current.name });
    await openKeyboard(page);
    // Every overflow destination, not just one: `overflowSelected = selected === "usage"` left the
    // single-case version green while a user on Runs, Pods or Automations saw a bar with nothing
    // marked current at all.
    await expect(page.locator(".rail-more-trigger.active")).toHaveCount(1);
    await expect(page.locator(".rail-more-trigger")).toHaveAttribute("aria-current", "page");
    await expectEveryPrimaryDestinationUsable(page);

    await page.locator(".rail-more-trigger").click();
    const active = page.locator(".rail-more-item.active");
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText(current.title);
    await expectEveryDestinationReachable(page, KEYBOARD);
  });
}

/**
 * Every destination goes to its OWN destination.
 *
 * "Tappable" was hit-testing and nothing else, and the fixture threw `onNavigate` away — so
 * pointing every primary link at Inbox, or dropping the sheet's `onNavigate` entirely, left the
 * suite green with the navigation reduced to one working destination.
 */
test("each destination navigates to itself", async ({ page }) => {
  await useHarness(page);
  await openKeyboard(page);

  const primary = page.locator(".rail-destinations > .rail-item");
  const names = await primary.evaluateAll((items) =>
    items.map((item) => new URL((item as HTMLAnchorElement).href).pathname));
  for (let index = 0; index < names.length; index += 1) {
    await primary.nth(index).click();
  }
  await page.locator(".rail-more-trigger").click();
  const sheet = page.locator(".rail-more-item");
  const overflow = await sheet.evaluateAll((items) =>
    items.map((item) => new URL((item as HTMLAnchorElement).href).pathname));
  // Activated one at a time: choosing a destination closes the sheet, so it has to be reopened.
  for (let index = 0; index < overflow.length; index += 1) {
    await expect(page.locator(".rail-more-sheet")).toBeVisible();
    await page.locator(".rail-more-item").nth(index).click();
    await expect(page.locator(".rail-more-sheet")).toHaveCount(0);
    if (index + 1 < overflow.length) await page.locator(".rail-more-trigger").click();
  }

  const visited = await page.evaluate(() => window.navigations);
  expect(visited.length, "one navigation per destination").toBe(names.length + overflow.length);
  // Distinct is the property that fails when every link is pointed at one view. Route names are
  // not path segments — `runners` is served at `/connections/machines` — so the href a long-press
  // or a middle-click would follow is compared through production's own mapping, which asserts the
  // link and the click handler agree about where the destination goes.
  expect(new Set(visited).size, "every destination must reach a distinct view").toBe(visited.length);
  expect(visited.map((name) => viewPath({ name } as View))).toEqual([...names, ...overflow]);

  // Space, which an anchor does not activate natively but `role="menuitem"` promises. Unhandled it
  // scrolled the sheet instead of navigating, and nothing above would have noticed: pointer
  // activation covers a different code path.
  await page.locator(".rail-more-trigger").click();
  const first = page.locator(".rail-more-item").first();
  await first.focus();
  await first.press(" ");
  await expect(page.locator(".rail-more-sheet"), "Space must also close the sheet").toHaveCount(0);
  expect(await page.evaluate(() => window.navigations.at(-1)),
    "Space must navigate to the row it was pressed on")
    .toBe(visited[names.length]);
});

/**
 * The fallback applies once at install, before any event.
 *
 * A page loaded while the keyboard is already open — a reload, a link followed from another app —
 * receives no resize and no scroll, so `apply()` in the installer is the only thing that publishes
 * the inset. With the fixture always starting at full height, deleting that call changed nothing
 * anywhere in the suite.
 */
test("an already-open keyboard is compensated for without any event", async ({ page }) => {
  await useHarness(page, { keyboard: KEYBOARD });
  await expectInset(page, `${KEYBOARD}px`);
  await expectRailAt(page, KEYBOARD);
  expect(await page.evaluate(() => window.keyboardApplies()),
    "the install-time apply is synchronous, so no frame should have run").toBe(0);
});

/**
 * A burst of events produces one write.
 *
 * `resize` and `scroll` fire repeatedly while the keyboard animates in. Every other case here
 * dispatches exactly one event, so deleting `if (frame) return` — which turns a burst into one
 * style write per event — left the suite green.
 */
test("a burst of viewport events coalesces into one frame", async ({ page }) => {
  await useHarness(page);
  const before = await page.evaluate(() => window.keyboardApplies());
  await applyViewport(page, () => page.evaluate(() => window.burstKeyboard(300, 12)));
  await expectInset(page, "300px");
  expect(await page.evaluate(() => window.keyboardApplies()) - before,
    "24 events in one task must coalesce to a single frame").toBe(1);
});

/**
 * Teardown releases what it promised to.
 *
 * Nothing exercised the returned stop function, so dropping its `cancelAnimationFrame` and its
 * `removeEventListener` calls was invisible: a frame queued at teardown republishes the inset onto
 * a page that has moved on, and retained listeners keep driving a controller that is gone.
 */
test("stopping the fallback releases the inset and its listeners", async ({ page }) => {
  await useHarness(page);
  await openKeyboard(page);
  // Stop with a frame already queued: the pending callback must not land after teardown. Both
  // assertions below are about ABSENCE, so they have to cross a real frame boundary first — the
  // same mistake `applyViewport` fixes for the noise floor. Two frames on the real window: the
  // first is the rendering opportunity the cancelled callback would have run in, the second is
  // after it.
  await page.evaluate(async () => {
    window.setKeyboard(200);
    window.stopKeyboard();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expectInset(page, "");

  const after = await page.evaluate(() => window.keyboardApplies());
  await page.evaluate(async () => {
    window.setKeyboard(250);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expectInset(page, "");
  expect(await page.evaluate(() => window.keyboardApplies()),
    "a removed listener cannot schedule a frame").toBe(after);
});

/**
 * The noise floor's actual boundary.
 *
 * The smallest positive occlusion otherwise tested is 120px, so raising `NOISE_FLOOR_PX` from 8 to
 * 119 left the whole suite green — and a real 100px residual gap, which is exactly the panned
 * keyboard the implementation was written for, would then publish nothing and leave the rail behind
 * the keyboard.
 */
test("the noise floor sits between 8 and 9 pixels", async ({ page }) => {
  await useHarness(page);
  await applyViewport(page, () => page.evaluate(() => window.setKeyboard(8)));
  await expectInset(page, "");

  await applyViewport(page, () => page.evaluate(() => window.setKeyboard(9)));
  await expectInset(page, "9px");
});

test("the bottom rail stays above the keyboard", async ({ page }) => {
  await useHarness(page);
  // The CLOSED state first, and painted rather than merely placed. Every paint, contrast, glyph and
  // hit-test assertion used to run only after the keyboard was open, so `.app-rail { opacity: 0 }`
  // with an override back to 1 under `html[style*="--keyboard-inset"]` left the suite green while a
  // user saw no navigation at all in the normal case. Geometry alone cannot see that, and neither
  // can `toBeVisible`, which an opacity-zero element satisfies.
  await expectRailAt(page, 0);
  await expectEveryPrimaryDestinationUsable(page);
  // The sheet too, and with no inset published. Every sheet assertion ran after `openKeyboard`, so
  // `.rail-more-sheet { opacity: 0 }` with an override under `html[style*="--keyboard-inset"]` gave
  // a user opening More in the ordinary state an invisible menu, with the suite green.
  await page.locator(".rail-more-trigger").click();
  await expect(page.locator(".rail-more-sheet")).toBeVisible();
  await expectEveryDestinationReachable(page, 0);
  await page.locator(".menu-backdrop").click();
  await expect(page.locator(".rail-more-sheet")).toHaveCount(0);

  await openKeyboard(page);
  await expectRailAt(page, KEYBOARD);
  await expectEveryPrimaryDestinationUsable(page);
});

/**
 * Every always-visible destination, painted and tappable.
 *
 * Hit-testing only the first one left `.rail-destinations > .rail-item:not(:first-child)
 * { pointer-events: none }` green while three of the four were dead: Inbox still answered, and the
 * More trigger is nested elsewhere so it kept working too.
 */
async function expectEveryPrimaryDestinationUsable(page: Page) {
  const items = page.locator(".app-rail .rail-item");
  const count = await items.count();
  expect(count, "the rail must have destinations").toBeGreaterThan(3);
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    const isMoreTrigger = (await item.getAttribute("class"))?.includes("rail-more-trigger") ?? false;
    const label = ((await item.getAttribute("aria-label")) ?? (await item.innerText())).trim() || `item ${index}`;
    // The accessible name is the ONLY name a phone destination has — the rail shows no text — and
    // reading it just to build a diagnostic proved nothing about it. `aria-label="Destination"` on
    // every link left the suite green with the whole bar indistinguishable to a screen reader.
    // Checked against production's canonical label, keyed by the link's own href, for the four
    // primary destinations; the More trigger names itself and is checked where it is asserted.
    if (!isMoreTrigger) {
      const path = await item.evaluate((element) => new URL((element as HTMLAnchorElement).href).pathname);
      const expected = GLOBAL_VIEW_ITEMS.find((entry) => viewPath({ name: entry.name } as View) === path);
      expect(expected, `no destination is served at ${path}`).toBeDefined();
      expect(label, `the destination at ${path} must be announced as "${expected!.label}"`)
        .toMatch(new RegExp(`^${expected!.label}\\b`));
    }
    // The icon, on its own. A phone destination carries no text, so the glyph IS the affordance —
    // and measuring the item instead let its border, and on Connections its count badge, stand in
    // for an icon that had been erased. The More trigger is three small dots inside the same 26px
    // box as a full icon, so it clears a lower floor.
    const isAutomations = !isMoreTrigger &&
      (await item.evaluate((element) => new URL((element as HTMLAnchorElement).href).pathname)) === "/automations";
    await expectPainted(page, item.locator("svg"), `${label} icon`,
      isMoreTrigger ? MARKS.moreTrigger : isAutomations ? MARKS.boltIcon : MARKS.icon);
    await expectHittable(item, label);
  }
}

/**
 * The rail's bottom edge sits exactly on the occluded band.
 *
 * A one-sided "above the keyboard, below the top" pair accepted almost 100px of unnecessary lift:
 * `html[style*="--keyboard-inset"] .app-rail { margin-bottom: 99px }` wasted that much of a phone
 * screen with every assertion green. Overshooting is a bug in the same way undershooting is.
 */
/**
 * A phone tab bar spans the screen, is tall enough to hold a 44px target, and is a BAR.
 *
 * The upper bound matters as much as the lower one: `height: calc(100dvh - var(--keyboard-inset,
 * 0px) - 2px)` gives a full-page element whose bottom edge lands exactly where the occlusion check
 * expects it, whose width is right, and which clears a minimum height — so every predicate passed
 * while the destinations sat at the top of the screen and the app was two pixels tall.
 */
const RAIL_HEIGHT = { min: 48, max: 96 } as const;

async function expectRailAt(page: Page, occluded: number) {
  const box = (await page.locator(".app-rail").boundingBox())!;
  const { width, height } = page.viewportSize()!;
  expect(box.y + box.height, `the rail's bottom edge must sit on the ${occluded}px occluded band`)
    .toBeGreaterThan(height - occluded - 2);
  expect(box.y + box.height).toBeLessThan(height - occluded + 2);
  expect(box.y, "the rail must not be pushed off the top").toBeGreaterThan(0);
  // Both edges, at the screen's edges — not merely "inside the viewport". `translateX(calc(100vw -
  // 1px))` left a one-pixel sliver on screen and a containment check passed it, as did `width: 1px`
  // with an override back to full width while the keyboard is open. Playwright's visibility does
  // not require meaningful intersection with the viewport, so the size has to be asserted too.
  expect(box.x, "the rail must start at the left edge").toBeGreaterThan(-2);
  expect(box.x, "the rail must start at the left edge").toBeLessThan(2);
  expect(box.x + box.width, "the rail must reach the right edge").toBeGreaterThan(width - 2);
  expect(box.x + box.width, "the rail must not overflow the right edge").toBeLessThan(width + 2);
  expect(box.height, "the rail must be tall enough to hold a touch target")
    .toBeGreaterThanOrEqual(RAIL_HEIGHT.min);
  expect(box.height, "the rail is a bar at the bottom, not a panel filling the screen")
    .toBeLessThanOrEqual(RAIL_HEIGHT.max);
}

test("the More sheet opens above the keyboard", async ({ page }) => {
  await useHarness(page);
  await openKeyboard(page);
  await page.locator(".rail-more-trigger").click();

  const sheet = page.locator(".rail-more-sheet");
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  const height = page.viewportSize()!.height;
  // `position: fixed` anchors to the LAYOUT viewport, so shortening the root does not move this on
  // its own — the sheet has to add the occlusion to its own offset. Without that it opens behind
  // the keyboard even though the rail that opened it is visible.
  expect(box.y + box.height, "the sheet must clear the keyboard").toBeLessThanOrEqual(height - KEYBOARD + 1);
  expect(box.y, "the sheet must not be pushed off the top").toBeGreaterThan(0);

  await expectEveryDestinationReachable(page, KEYBOARD);
});

/**
 * Every destination can be brought on screen, and the sheet holding them clears the keyboard.
 *
 * "Reachable", not "simultaneously visible" — the sheet caps its height and scrolls, so in
 * landscape the last item legitimately starts below the fold. An earlier version of this required
 * every item to be visible at once and failed on unmutated code by two pixels, which is a test
 * asserting something next to the property rather than the property.
 */
async function expectEveryDestinationReachable(page: Page, occluded: number) {
  const height = page.viewportSize()!.height;
  const sheet = page.locator(".rail-more-sheet");
  // The container first: if the sheet itself is behind the keyboard, no amount of scrolling helps.
  const sheetBox = (await sheet.boundingBox())!;
  expect(sheetBox.y, "the sheet is above the top of the screen").toBeGreaterThanOrEqual(0);
  expect(sheetBox.y + sheetBox.height, "the sheet is behind the keyboard")
    .toBeLessThanOrEqual(height - occluded + 1);

  const items = sheet.locator(".rail-more-item");
  const count = await items.count();
  expect(count, "the sheet must contain destinations at all").toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    // The row's own href says which destination it is; its visible text must SAY that destination.
    // Reading the name out of `innerText` made the check circular — wrapping every title in
    // `<i>Destination</i>` renamed all four rows identically, cleared the label floors, and named
    // itself in the diagnostics. The expected title comes from production's canonical list instead.
    const path = await item.evaluate((element) => new URL((element as HTMLAnchorElement).href).pathname);
    const destination = GLOBAL_VIEW_ITEMS.find((entry) => viewPath({ name: entry.name } as View) === path);
    // Settings rides in the sheet without being a rail destination, so it is named from its own
    // canonical route title rather than from the destination list.
    const expected = destination?.title ?? (path === SETTINGS_ROW.path ? SETTINGS_ROW.title : undefined);
    expect(expected, `no destination is served at ${path}`).toBeDefined();
    const label = expected!;
    await expect(item, `the row at ${path} must be labelled "${label}"`).toHaveText(label);
    // Scrolling within the sheet is the intended way to reach an overflowing item; what must not
    // happen is an item that cannot be brought into the sheet's visible box at all.
    await item.scrollIntoViewIfNeeded();
    const box = (await item.boundingBox())!;
    const visible = (await sheet.boundingBox())!;
    expect(box.y, `"${label}" cannot be scrolled below the sheet's top edge`)
      .toBeGreaterThanOrEqual(visible.y - 1);
    expect(box.y + box.height, `"${label}" cannot be scrolled above the sheet's bottom edge`)
      .toBeLessThanOrEqual(visible.y + visible.height + 1);
    // Reachable means tappable AND painted. Geometry inside a sheet that sits under its own
    // backdrop is neither, and a perimeter alone cleared both the container-level and the
    // item-level ink floor with every icon and label erased. A sheet row carries two independent
    // marks, so both are measured: `.rail-more-item > .app-icon { opacity: 0 }` removed every
    // overflow icon while the labels kept the item's total above its floor.
    await expectHittable(item, label);
    await expectPainted(page, item.locator("svg"), `${label} icon`, MARKS.sheetIcon);
    await expectPlainText(item.locator("span"), `${label} label`);
    await expectPainted(page, item.locator("span"), `${label} label`,
      path === SETTINGS_ROW.path ? MARKS.sheetSettingsLabel : MARKS.sheetLabel);
  }
}

/**
 * Landscape, which is where the sheet's `max-height` is the rule that matters.
 *
 * In portrait the sheet is far shorter than the space available, so `max-height` never binds and an
 * assertion about it passes with the rule deleted — verified by replacing it with `100dvh` and
 * watching the portrait test stay green. A 568x320 phone with the keyboard open is the case the
 * rule was written for: without it the first destination is pushed off the top with no way to
 * scroll to it.
 */
test.describe("in landscape", () => {
  test.use({ viewport: { width: 568, height: 320 } });

  test("every destination in the More sheet is still reachable", async ({ page }) => {
    await useHarness(page);
    const occluded = 120;
    await openKeyboard(page, occluded);
    await page.locator(".rail-more-trigger").click();
    await expect(page.locator(".rail-more-sheet")).toBeVisible();

    await expectEveryDestinationReachable(page, occluded);
    // Reachable by scrolling counts, but only if the sheet can actually scroll.
    const overflow = await page.locator(".rail-more-sheet").evaluate((element) => ({
      scrollable: element.scrollHeight > element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    if (overflow.scrollable) {
      expect(overflow.overflowY, "a sheet taller than its box must scroll").toMatch(/auto|scroll/);
    }
  });
});

test("closing the keyboard puts everything back", async ({ page }) => {
  await useHarness(page);
  const rail = page.locator(".app-rail");
  const before = (await rail.boundingBox())!;

  await openKeyboard(page);
  await applyViewport(page, () => page.evaluate(() => window.setKeyboard(0)));
  await expectInset(page, "");

  const after = (await rail.boundingBox())!;
  expect(Math.round(after.y), "the rail must return to where it started").toBe(Math.round(before.y));
  await expectEveryPrimaryDestinationUsable(page);
  // Both sides, not just "back where it was". The starting position was itself unchecked above, so
  // `translateY(100px)` in the phone media query with a `html[style*="--keyboard-inset"]` override
  // back to `none` put the closed rail 100px below the screen with the whole suite green: every
  // keyboard-open assertion saw the override, and closing returned to the same off-screen place.
  await expectRailAt(page, 0);
});

/**
 * The rail yields while the user is typing.
 *
 * A focused text field is when the software keyboard is up — on BOTH engine families, which no
 * geometric signal covers: browsers honouring `interactive-widget=resizes-content` shrink the
 * layout viewport and never publish `--keyboard-inset`, so a rule keyed on the inset would hide
 * nothing on them. With the keyboard holding ~300px and the topbar 50px, the rail's 56px is a
 * meaningful slice of what remains for the transcript, and no one is tapping navigation mid-word.
 */
test.describe("while a text field is focused", () => {
  test("the rail is removed and the freed band goes to the content", async ({ page }) => {
    await useHarness(page);
    // The gate the rule hangs on. The Pixel 7 emulation reports a coarse pointer; if it stopped,
    // every assertion below would pass vacuously against a rule that never applies in it.
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      "this emulation must report the coarse pointer the rule is gated to").toBe(true);

    await page.locator(".main-body textarea").focus();
    await expect(page.locator(".app-rail")).toBeHidden();
    // Removed, not merely invisible: `visibility: hidden` or `opacity: 0` satisfies toBeHidden
    // while the 56px band still belongs to the rail. The content must reach the bottom edge.
    const main = (await page.locator(".main").boundingBox())!;
    const height = page.viewportSize()!.height;
    expect(main.y + main.height, "the content must take over the band the rail held")
      .toBeGreaterThan(height - 2);

    await page.locator(".main-body textarea").blur();
    await expectRailAt(page, 0);
    await expectEveryPrimaryDestinationUsable(page);
  });

  test("blur while the inset is still published puts the rail on the occluded band", async ({ page }) => {
    await useHarness(page);
    await page.locator(".main-body textarea").focus();
    await openKeyboard(page);
    await expect(page.locator(".app-rail")).toBeHidden();
    // The keyboard animates out AFTER blur, so for those frames the inset is still published with
    // nothing focused. The returning rail must sit on the occluded band, not under it — hiding
    // while typing does not repeal #207.
    await page.locator(".main-body textarea").blur();
    await expectRailAt(page, KEYBOARD);
  });

  test("a keyboard dismissed without blur gives the rail back", async ({ page }) => {
    await useHarness(page);
    // The blur must be ANNOUNCED as well as performed: composer focus recovery (SessionDetail)
    // refocuses any unannounced background blur one frame later, and on Android that refocus
    // re-summons the keyboard the user just collapsed.
    await page.evaluate((eventName) => {
      const w = window as unknown as { dismissAnnouncements: number };
      w.dismissAnnouncements = 0;
      window.addEventListener(eventName, () => { w.dismissAnnouncements += 1; });
    }, KEYBOARD_DISMISS_BLUR_EVENT);
    await page.locator(".main-body textarea").focus();
    await openKeyboard(page);
    await expect(page.locator(".app-rail")).toBeHidden();

    // Android Back closes the keyboard and leaves the field focused — no blur event ever fires,
    // so the focus-keyed rule alone would hold the navigation hidden over an empty band. The
    // viewport growing back by a keyboard's height while a text field holds focus IS that
    // dismissal, and the fallback answers it by blurring the field.
    await applyViewport(page, () => page.evaluate(() => window.setKeyboard(0)));
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body),
      { message: "the fallback must blur the field the dismissed keyboard belonged to" }).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { dismissAnnouncements: number }).dismissAnnouncements),
      "exactly one announcement, exactly for the dismissal blur").toBe(1);
    await expectRailAt(page, 0);
    await expectEveryPrimaryDestinationUsable(page);
  });

  test("an animated dismissal accumulates to the blur", async ({ page }) => {
    await useHarness(page);
    await page.locator(".main-body textarea").focus();
    await openKeyboard(page);
    await expect(page.locator(".app-rail")).toBeHidden();

    // A closing keyboard animates: several resize frames each growing less than any threshold,
    // whose SUM is the keyboard. A detector comparing single-frame deltas never fires on this
    // sequence and the field stays focused over an empty band — round 2's P1.
    for (const remaining of [240, 180, 120, 60, 0]) {
      await applyViewport(page, () => page.evaluate((step) => window.setKeyboard(step), remaining));
    }
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body),
      { message: "the accumulated growth must be read as the dismissal it is" }).toBe(true);
    await expectRailAt(page, 0);
  });

  test("a partly-receded keyboard is not a dismissal", async ({ page }) => {
    await useHarness(page);
    await page.locator(".main-body textarea").focus();
    // The visual-only engine family, where the bottom occlusion is a DIRECT keyboard signal. A
    // 120px landscape keyboard recedes in same-width steps — 56, then to the last 20px, which is
    // past every height threshold two earlier revisions released at (the peak band, then the
    // shared 100px growth number). While ANY occlusion remains the keyboard is still there, and
    // releasing blurred the field mid-word.
    await openKeyboard(page, 120);
    await expect(page.locator(".app-rail")).toBeHidden();
    await applyViewport(page, () => page.evaluate(() => window.setKeyboard(64)));
    expect(await page.evaluate(() => document.activeElement?.tagName),
      "a partly-receded keyboard must not steal focus from the field").toBe("TEXTAREA");
    await expect(page.locator(".app-rail")).toBeHidden();
    await applyViewport(page, () => page.evaluate(() => window.setKeyboard(20)));
    expect(await page.evaluate(() => document.activeElement?.tagName),
      "the last 20px of keyboard must still hold the release").toBe("TEXTAREA");
    await expect(page.locator(".app-rail")).toBeHidden();

    // The real dismissal afterwards still lands: the occlusion is gone.
    await applyViewport(page, () => page.evaluate(() => window.setKeyboard(0)));
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body),
      { message: "the genuine dismissal after the partial recessions must still blur" }).toBe(true);
    await expectRailAt(page, 0);
  });

  test("chrome collapse interleaved with a live keyboard is not a dismissal", async ({ page }) => {
    await useHarness(page);
    await page.locator(".main-body textarea").focus();
    // Round 5's construction: a 140px keyboard, then 100px of chrome collapsing WHILE its
    // accessory row gives back 20px. Total same-width growth from the lowest armed height is 120
    // — a keyboard's worth, so every height predicate reads a dismissal — but chrome moves both
    // viewports together and cancels out of the occlusion, which still shows 120px of keyboard.
    await openKeyboard(page, 140);
    await expect(page.locator(".app-rail")).toBeHidden();
    await applyViewport(page, () => page.evaluate(() => window.shiftChrome(100)));
    expect(await page.evaluate(() => document.activeElement?.tagName),
      "chrome collapse must not steal focus from the field").toBe("TEXTAREA");
    await applyViewport(page, () => page.evaluate(() => window.setKeyboard(20)));
    expect(await page.evaluate(() => document.activeElement?.tagName),
      "keyboard-scale growth that is really chrome plus accessory row must not release").toBe("TEXTAREA");
    await expect(page.locator(".app-rail")).toBeHidden();

    // The genuine dismissal, with the chrome still collapsed: the visual viewport meets the
    // (shifted) layout viewport and the occlusion reads zero.
    await applyViewport(page, () => page.evaluate(() => window.setKeyboard(-100)));
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body),
      { message: "the dismissal under collapsed chrome must still blur" }).toBe(true);
  });

  test("a fully panned keyboard is not a dismissal", async ({ page }) => {
    await useHarness(page);
    await page.locator(".main-body textarea").focus();
    await openKeyboard(page);
    await expect(page.locator(".app-rail")).toBeHidden();

    // Panning toward the focused field can drive the BOTTOM GAP inside the noise floor with the
    // keyboard fully open — the height never grew, only the origin moved. Reading the residual
    // gap alone as closure blurred the field just as the user started typing.
    await applyViewport(page, () => page.evaluate(() => window.panKeyboard(295)));
    expect(await page.evaluate(() => document.activeElement?.tagName),
      "a panned-away bottom gap must not read as a dismissal").toBe("TEXTAREA");
    await expect(page.locator(".app-rail")).toBeHidden();

    // The genuine dismissal restores both the height and the origin.
    await applyViewport(page, () => page.evaluate(() => window.setKeyboard(0)));
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body),
      { message: "the unpanned dismissal must still blur" }).toBe(true);
    await expectRailAt(page, 0);
  });

  test("the resizes-content family still blurs on a dismissal", async ({ page }) => {
    await useHarness(page);
    await page.locator(".main-body textarea").focus();
    // The engine family that shrinks the LAYOUT viewport with the keyboard: no occlusion is ever
    // published, so the height predicates are the only release path this family can take —
    // deleting them strands every Android Back dismissal with the suite otherwise green.
    await applyViewport(page, () => page.evaluate(() => window.setLayoutKeyboard(300)));
    await expectInset(page, "");
    await expect(page.locator(".app-rail")).toBeHidden();
    // A partial recovery — the accessory row hiding — is not the dismissal.
    await applyViewport(page, () => page.evaluate(() => window.setLayoutKeyboard(250)));
    expect(await page.evaluate(() => document.activeElement?.tagName),
      "a partial layout-viewport recovery must not steal focus").toBe("TEXTAREA");

    await applyViewport(page, () => page.evaluate(() => window.setLayoutKeyboard(0)));
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body),
      { message: "the layout-viewport dismissal must blur without any occlusion signal" }).toBe(true);
    await expectRailAt(page, 0);
  });

  test("growth with no keyboard behind it is not a dismissal", async ({ page }) => {
    await useHarness(page);
    await page.locator(".main-body textarea").focus();
    await expect(page.locator(".app-rail")).toBeHidden();

    // Same-width growth alone: a split-screen pane being enlarged while composing. No keyboard
    // was ever open — nothing shrank first — so blurring here would dismiss the real keyboard
    // and interrupt the user for a window change they made on purpose.
    await applyViewport(page, () => page.evaluate(() =>
      window.resizeViewport(window.innerWidth, window.innerHeight + 150)));
    expect(await page.evaluate(() => document.activeElement?.tagName),
      "growth the keyboard cannot explain must not steal focus").toBe("TEXTAREA");
    await expect(page.locator(".app-rail")).toBeHidden();
  });

  test("a rotation is not read as a keyboard dismissal", async ({ page }) => {
    await useHarness(page);
    await page.locator(".main-body textarea").focus();
    await openKeyboard(page);

    // Rotating with the keyboard up also grows the height past the close threshold — landscape
    // to portrait is hundreds of pixels — but it moves the WIDTH too, which a keyboard cannot.
    // Blurring here would dismiss the keyboard mid-word; the field must keep focus and the rail
    // must stay yielded.
    await applyViewport(page, () => page.evaluate(() => window.resizeViewport(915, 892)));
    expect(await page.evaluate(() => document.activeElement?.tagName),
      "a rotation must not steal focus from the field").toBe("TEXTAREA");
    await expect(page.locator(".app-rail")).toBeHidden();
  });

  test("focus that summons no keyboard leaves the rail in place", async ({ page }) => {
    await useHarness(page);
    // A checkbox holds focus after a tap and opens nothing; hiding on it strands the navigation
    // hidden until the user happens to focus something else.
    await page.locator(".main-body input[type=checkbox]").focus();
    await expectRailAt(page, 0);
    // A read-only text input likewise: production's Share Link field is one, tapped exactly to
    // select and copy — no keyboard appears and no viewport event would ever restore the rail.
    await page.locator(".main-body input[readonly]").focus();
    await expectRailAt(page, 0);
    // The rail's own destinations too: a selector loosened to `.app:has(:focus)` removes the bar
    // in response to the user reaching for it.
    await page.locator(".rail-destinations > .rail-item").first().focus();
    await expectRailAt(page, 0);
    await expectEveryPrimaryDestinationUsable(page);
  });
});

/**
 * The same width without the touch emulation, which is a narrow DESKTOP window: no software
 * keyboard exists there, so focusing the composer must not cost the navigation.
 */
test.describe("with a fine pointer", () => {
  test.use({ hasTouch: false, isMobile: false });

  test("a narrow desktop window keeps its rail while typing", async ({ page }) => {
    await useHarness(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      "without touch emulation this context must report a fine pointer").toBe(false);
    await page.locator(".main-body textarea").focus();
    await expectRailAt(page, 0);
    await expectEveryPrimaryDestinationUsable(page);
  });
});

/**
 * A panned viewport, where the total shrink and the occluded band are different numbers.
 *
 * Some browsers resize the visual viewport in place — `offsetTop` stays 0 — and others scroll it
 * toward the focused field, so it is both shorter AND offset. Only the residual gap at the BOTTOM
 * describes what is hidden underneath a bottom-anchored element. Measuring total shrink instead
 * over-reports, and lifts the rail further than the keyboard needs; without this case the fixture
 * never set `offsetTop`, so dropping it from the formula changed nothing and every test still
 * passed.
 */
test("a panned viewport is measured by its bottom gap, not its total shrink", async ({ page }) => {
  await useHarness(page);
  const shrink = 300;
  const panned = 100;
  await page.evaluate(([amount, offset]) => window.setKeyboard(amount!, offset!), [shrink, panned]);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--keyboard-inset")))
    .toBe(`${shrink - panned}px`);

  await expectRailAt(page, shrink - panned);
});

/**
 * A pan that fires only `scroll`.
 *
 * The browser shrinks the viewport first (`resize`), then scrolls it toward the focused field
 * WITHOUT changing its height, firing only `scroll`. Driving both properties together and always
 * dispatching `resize` meant deleting production's `scroll` listener left the whole suite green:
 * the inset would stay at 300 instead of falling to 200, lifting the rail 100px too far.
 */
test("panning after the keyboard opens updates the inset on scroll alone", async ({ page }) => {
  await useHarness(page);
  await openKeyboard(page, 300);
  await expectRailAt(page, 300);

  await page.evaluate(() => window.panKeyboard(100));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--keyboard-inset")))
    .toBe("200px");
  await expectRailAt(page, 200);
});

/**
 * A gap of a few pixels is rounding, not occlusion, and compensating for it would jitter the rail
 * against every sub-pixel viewport change.
 */
test("a sub-pixel gap is not treated as a keyboard", async ({ page }) => {
  await useHarness(page);
  await applyViewport(page, () => page.evaluate(() => window.setKeyboard(4)));
  await expectInset(page, "");
});
