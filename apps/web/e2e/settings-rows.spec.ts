import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { SETTINGS_SECTIONS, type SettingsSection } from "../src/navigation.js";

/**
 * What the unit tests for these rows cannot answer.
 *
 * `SettingsRows.dom.test.tsx` asserts the DOM carries the right classes; a companion test asserts
 * the stylesheet declares the right geometry. Neither can see a cascade result — `opacity: 0`, a
 * `border-width: 0` longhand after the tested shorthand, a pseudo-element without `content`, or any
 * later overriding rule leaves both suites green while the affordance disappears.
 *
 * This asks the rendering engine, inside the production dialog hierarchy, in both themes.
 *
 * Every assertion here is about what is PAINTED, not what is declared — and, after three rounds of
 * review, "painted" means COUNTED PIXELS wherever it can. Each round found another property that a
 * plausible rule satisfies while the control is invisible, most recently `clip-path: inset(50%)`,
 * which leaves box, opacity, stroke, transform and contrast all intact. `inkOf` below ends that
 * game: it asks how many pixels the element actually puts on screen.
 */

const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

/**
 * Transitions are disabled for the whole file.
 *
 * The row borders animate for 130–180ms after a theme change. Sampling a colour during that window
 * reads an intermediate value — or the previous theme's — so a genuine contrast regression could
 * pass, and a borderline one would pass or fail on CI timing.
 */
test.use({ reducedMotion: "reduce" });

interface HarnessOptions {
  state?: "rest" | "busy-on" | "busy-off" | "disabled";
  topology?: "full" | "minimal";
  section?: SettingsSection;
  copy?: "default" | "long";
  defaults?: "pending" | "agent";
}


/**
 * Loads the harness in a theme, a state, a topology and a section.
 *
 * Via the URL, not a control on the page: a control would sit inside the hierarchy under test, and
 * a reload per variant guarantees a clean, settled paint.
 */
async function useHarness(
  page: Page,
  theme: Theme,
  { state = "rest", topology = "full", section = "appearance", copy = "default", defaults = "pending" }: HarnessOptions = {},
) {
  await page.goto(
    `/settings-rows-e2e.html?theme=${theme}&state=${state}&topology=${topology}&section=${section}&copy=${copy}&defaults=${defaults}`,
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  // The SECTION's own heading, not a fixed control: asserting a radio here would silently pass on
  // the wrong page for five of the six sections, since an absent locator is simply never visible.
  await expect(page.locator("#settings-panel-heading"))
    .toHaveText(SETTINGS_SECTIONS.find((entry) => entry.id === section)!.title);
}

/** Loads the section a row lives on and returns the row. */
async function useRow(page: Page, theme: Theme, key: RowKey, options: Omit<HarnessOptions, "section"> = {}) {
  await useHarness(page, theme, { ...options, section: ROWS[key].section });
  return rowOf(page, key);
}

interface Rgba { r: number; g: number; b: number; a: number }

const RGB_FUNCTION = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/;
const SRGB_FUNCTION = /^color\(srgb\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/;

/**
 * Parses a computed colour, preserving alpha.
 *
 * Strict on purpose. This was a bare `match(/[\d.]+/g)`, which read `color(srgb .6 .6 .6)` — a
 * serialization Chromium preserves rather than normalising to `rgb()` — as the channel values
 * 0.6/0.6/0.6, i.e. essentially black. A light-theme outline changed to that form measured 20.9:1
 * against white when it is really 2.85:1.
 *
 * Out-of-gamut channels are rejected rather than scaled: `color(srgb 0 0 2)` is displayed clipped to
 * pure blue, about 2.0:1 on the dark surface, while extrapolating the sRGB transfer curve past 1.0
 * reports about 6.8:1. Anything not understood throws, so an unmeasurable colour stops the test
 * instead of producing a number.
 */
function parseColor(value: string): Rgba {
  const text = value.trim();
  const rgb = text.match(RGB_FUNCTION);
  if (rgb) {
    return { r: +rgb[1]!, g: +rgb[2]!, b: +rgb[3]!, a: rgb[4] === undefined ? 1 : +rgb[4] };
  }
  const srgb = text.match(SRGB_FUNCTION);
  if (srgb) {
    const channels = [+srgb[1]!, +srgb[2]!, +srgb[3]!];
    if (channels.some((channel) => channel < 0 || channel > 1)) {
      throw new Error(`out-of-gamut colour "${value}" renders clipped; luminance of the unclipped value is meaningless`);
    }
    // Normalized channels, so 0–1 rather than 0–255.
    return { r: channels[0]! * 255, g: channels[1]! * 255, b: channels[2]! * 255, a: srgb[4] === undefined ? 1 : +srgb[4] };
  }
  throw new Error(`unsupported computed colour "${value}" — extend parseColor rather than guessing at it`);
}

/** Composites a possibly-translucent colour over an opaque backdrop. */
function over(top: Rgba, bottom: Rgba): Rgba {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * How many pixels the element actually PUTS ON SCREEN.
 *
 * The authoritative paint check, and the answer to a whole family of findings that
 * property-by-property inspection kept losing to. `clip-path: inset(50%)` on the light chevron left
 * its box, geometry, stroke width, opacity and computed contrast all intact — and slipped under the
 * screenshot budget too, because the chevron is a 15px stroke whose pixels pixelmatch treats as
 * antialiasing. Every one of the 25 tests passed with the chevron gone.
 *
 * This screenshots the element as rendered, takes the most common colour in that capture as the
 * surface it sits on, and counts everything else. Occlusion, masks, clipping, ancestor filters and
 * same-colour-as-the-background all reduce the count; nothing about the DOM can fake it.
 */
interface InkOptions {
  /** A sub-rectangle in CSS pixels relative to the element's own top-left. */
  region?: { x: number; y: number; width: number; height: number };
  /** The colour to count differences against, when the dominant colour would be the wrong answer. */
  surface?: string;
}

async function inkOf(page: Page, locator: Locator, options: InkOptions = {}): Promise<number> {
  const shot = (await locator.screenshot({ animations: "disabled" })).toString("base64");
  const cssWidth = (await locator.boundingBox())?.width ?? 0;
  return page.evaluate(async ({ b64, region, surface, cssWidth: width }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    // The capture is in DEVICE pixels; a region given in CSS pixels scales with it.
    const scale = image.width / (width || image.width);
    const box = region
      ? {
        x: Math.round(region.x * scale), y: Math.round(region.y * scale),
        width: Math.round(region.width * scale), height: Math.round(region.height * scale),
      }
      : { x: 0, y: 0, width: image.width, height: image.height };
    const { data } = context.getImageData(box.x, box.y, box.width, box.height);

    let reference: number;
    if (surface) {
      const [sr = 0, sg = 0, sb = 0] = (surface.match(/[\d.]+/g) ?? []).map(Number);
      reference = (sr << 16) | (sg << 8) | sb;
    } else {
      const counts = new Map<number, number>();
      for (let index = 0; index < data.length; index += 4) {
        const key = (data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      let most = -1;
      reference = 0;
      for (const [key, count] of counts) if (count > most) { most = count; reference = key; }
    }
    const [sr, sg, sb] = [(reference >> 16) & 255, (reference >> 8) & 255, reference & 255];
    let ink = 0;
    for (let index = 0; index < data.length; index += 4) {
      // A low bar deliberately: the surface is flat, so any difference at all is real paint, and
      // counting faint antialiasing makes the totals steady across themes and states.
      if (Math.abs(data[index]! - sr!) + Math.abs(data[index + 1]! - sg!) + Math.abs(data[index + 2]! - sb!) > 6) ink += 1;
    }
    return ink;
  }, { b64: shot, region: options.region ?? null, surface: options.surface ?? null, cssWidth });
}

/**
 * Measured floors, at roughly half of the smallest value each affordance produces across every
 * theme and state this file loads. Wide enough that rendering differences never reach them, narrow
 * enough that erasing PART of a control does — which is a stricter bar than it sounds, and one the
 * first version of these numbers failed twice:
 *
 * - `track` was 240 against a measured 428–500. But a switch capture's dominant colour is the
 *   TRACK FILL, so its ink is really "knob + border + corners"; erasing the 16x16 knob left ~275
 *   and passed. The floor is now calibrated against that mutation, and `expectKnob` measures the
 *   knob on its own besides, because an aggregate cannot show that each sub-affordance survived.
 * - `chevron` was 12 against a measured 24 that is two symmetric 12-pixel segments, so
 *   `clip-path: inset(0 0 50% 0)` kept exactly enough. It is now 20.
 */
const INK = { track: 400, knob: 150, chevron: 20, icon: 55 } as const;

/**
 * Floors for the Appearance controls, set as ANTI-ERASURE bars rather than as tuned baselines.
 *
 * The numbers above were measured on the rendered control and halved. These were not: the controls
 * are new, and a floor invented at that precision without a run behind it fails on the first
 * unrelated font difference. They are deliberately far below anything the real controls produce, so
 * they catch the failure they exist for — `clip-path`, `opacity: 0`, a control that stopped
 * rendering — and nothing subtler. Tighten them from a measured run; do not guess them upwards.
 */
const APPEARANCE_INK = { pills: 100, swatch: 40 } as const;

/**
 * Where each row actually lives.
 *
 * When Settings was a dialog every row was on one screen, and these tests reached for a radio, a
 * switch and a navigation row in a single page load. A ROUTE renders one section at a time, so the
 * section is part of a row's address now. Naming them here rather than inline is what stops a test
 * from quietly asserting nothing because the row it wanted is on another page — `getByRole` on an
 * absent row fails loudly, but only if the test actually looks at it.
 */
/*
 * Appearance's rows are NOT in here, deliberately.
 *
 * Every entry below is a row that IS a control: the row element carries the role, the state and the
 * affordance, which is what lets one registry drive paint, hover, disabled and focus for all of
 * them. Appearance's three settings are now rows that CONTAIN a control — the row is a div, and the
 * radiogroup, its pills and the picker trigger sit inside it. Forcing them into this shape needs an
 * `affordance` that resolves to the located element itself, and every helper here would grow a
 * branch for it. They get their own describe block at the end of this file instead, pointed at the
 * parts that actually paint by the same ink-and-contrast machinery.
 */
const ROWS = {
  switchOff: { section: "notifications", role: "switch", name: /^Desktop Alerts/, affordance: ".ui-switch", minSize: 16, floor: INK.track },
  switchOn: { section: "notifications", role: "switch", name: /^Push Notifications/, affordance: ".ui-switch", minSize: 16, floor: INK.track },
  tailnetOn: { section: "network", role: "switch", name: /^Enable Tailnet Access/, affordance: ".ui-switch", minSize: 16, floor: INK.track },
  navChevron: { section: "keyboard", role: "button", name: /^Keyboard Shortcuts/, affordance: ".ui-row-chevron", minSize: 8, floor: INK.chevron },
  navIcon: { section: "keyboard", role: "button", name: /^Keyboard Shortcuts/, affordance: ".ui-row-icon", minSize: 8, floor: INK.icon },
} as const satisfies Record<string, {
  section: SettingsSection;
  role: "switch" | "button";
  name: RegExp;
  affordance: string;
  minSize: number;
  floor: number;
}>;

type RowKey = keyof typeof ROWS;
const rowOf = (page: Page, key: RowKey) => page.getByRole(ROWS[key].role, { name: ROWS[key].name });

async function expectInk(page: Page, locator: Locator, label: string, floor: number, options: InkOptions = {}) {
  const ink = await inkOf(page, locator, options);
  expect(ink, `${label} paints ${ink} pixels, below the ${floor} floor`).toBeGreaterThanOrEqual(floor);
}

/**
 * The switch knob, measured against the track it sits on rather than as part of the track's total.
 *
 * The knob is the only thing carrying a switch's position, and it is a pseudo-element, so it has no
 * locator and no box of its own. Its rectangle is read from the computed style — including the
 * translation that IS the on/off cue — and the track's own fill is passed as the reference colour,
 * since inside the knob's rectangle the dominant colour is the knob.
 */
async function expectKnob(page: Page, track: Locator, label: string) {
  const geometry = await track.evaluate((element) => {
    const computed = getComputedStyle(element);
    const knob = getComputedStyle(element, "::after");
    const matrix = new DOMMatrixReadOnly(knob.transform === "none" ? undefined : knob.transform);
    return {
      // `position: absolute` is relative to the padding box, so the border offsets it in a capture.
      x: Number.parseFloat(knob.left) + matrix.m41 + Number.parseFloat(computed.borderLeftWidth),
      y: Number.parseFloat(knob.top) + matrix.m42 + Number.parseFloat(computed.borderTopWidth),
      width: Number.parseFloat(knob.width),
      height: Number.parseFloat(knob.height),
      fill: computed.backgroundColor,
    };
  });
  await expectInk(page, track, label, INK.knob, {
    region: { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height },
    surface: geometry.fill,
  });
}

/**
 * Pixels that differ between two captures, optionally only within a vertical band of them.
 *
 * The band is what makes this a focus-RING check rather than a did-anything-change check. Comparing
 * the whole clip, a permanent ring on every row plus a three-levels-per-channel background change
 * on `:focus-visible` passed: the recolour is imperceptible — about 1.02:1 — but its summed RGB
 * delta is 9, so every interior pixel counted and the floor was cleared with no focus-specific
 * indicator anywhere. Restricted to the strip OUTSIDE the row's border box, where an outline or an
 * outer box-shadow is the only thing that can paint, that mutation changes nothing.
 *
 * `cssWidth` is the clip's width in CSS pixels, since the captures are in device pixels.
 */
async function differingPixels(page: Page, before: Buffer, after: Buffer,
  band?: { x: number; width: number; cssWidth: number }): Promise<number> {
  return page.evaluate(async ({ a, b, band: within }) => {
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
    const [one, two] = [await load(a), await load(b)];
    if (one.width !== two.width || one.height !== two.height) return Number.MAX_SAFE_INTEGER;
    const scale = one.width / (within?.cssWidth || one.width);
    const from = within ? Math.max(0, Math.round(within.x * scale)) : 0;
    const to = within ? Math.min(one.width, Math.round((within.x + within.width) * scale)) : one.width;
    let differing = 0;
    for (let y = 0; y < one.height; y += 1) {
      for (let x = from; x < to; x += 1) {
        const index = (y * one.width + x) * 4;
        const delta = Math.abs(one.data[index]! - two.data[index]!) +
          Math.abs(one.data[index + 1]! - two.data[index + 1]!) +
          Math.abs(one.data[index + 2]! - two.data[index + 2]!);
        if (delta > 6) differing += 1;
      }
    }
    return differing;
  }, { a: before.toString("base64"), b: after.toString("base64"), band: band ?? null });
}

/**
 * The opacity an element is ACTUALLY drawn at: its own, times every ancestor's.
 *
 * Group opacity multiplies, and `getComputedStyle(element).opacity` shows only the element's own
 * share. Adding `.ui-row-switch.is-busy { opacity: 0.7 }` above a track already at `0.6` renders it
 * at 0.42 — enough to take the busy track under 3:1 — while the element still reports 0.6.
 */
async function effectiveOpacity(locator: Locator): Promise<number> {
  const result = await locator.evaluate((element) => {
    let node: HTMLElement | null = element;
    let product = 1;
    while (node) {
      const computed = getComputedStyle(node);
      // `filter: opacity(.5)` and friends dim exactly like opacity but cannot be read off as a
      // number. Refusing is honest; quietly ignoring one would overstate every ratio below it.
      // `mix-blend-mode` is the same problem without the dimming: white under `multiply` on the
      // dark surface reports about 17:1 and paints a 1:1 boundary.
      if (computed.filter !== "none") return { filtered: computed.filter, value: product };
      if (computed.mixBlendMode !== "normal") return { filtered: `mix-blend-mode: ${computed.mixBlendMode}`, value: product };
      product *= Number.parseFloat(computed.opacity);
      node = node.parentElement;
    }
    return { filtered: null as string | null, value: product };
  });
  expect(result.filtered, "a filter or blend mode in the ancestor chain cannot be folded into a contrast ratio").toBe(null);
  return result.value;
}

/** Effective style plus the element's REAL laid-out box. */
async function painted(locator: Locator) {
  const style = await locator.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      display: computed.display,
      visibility: computed.visibility,
      borderWidth: Number.parseFloat(computed.borderTopWidth) || 0,
      borderColor: computed.borderTopColor,
      background: computed.backgroundColor,
      color: computed.color,
    };
  });
  return { ...style, opacity: await effectiveOpacity(locator), box: await locator.boundingBox() };
}

/**
 * Effective style of a pseudo-element, which has no locator of its own.
 *
 * The transform is decomposed in the page with `DOMMatrixReadOnly` rather than by indexing into the
 * serialized string: `translate3d(16px,0,0)` can serialize as `matrix3d(...)`, where the X
 * translation is the thirteenth component.
 */
async function pseudo(locator: Locator, selector: "::before" | "::after") {
  return locator.evaluate((element, which) => {
    const computed = getComputedStyle(element, which);
    const matrix = new DOMMatrixReadOnly(computed.transform === "none" ? undefined : computed.transform);
    // The SMALLER singular value of the 2x2 linear part: the shortest the transform makes any
    // direction. Taking the transformed axis lengths instead reported 1 for
    // `matrix(0, 1, 0, 1, 0, 0)`, whose determinant is zero and which collapses a 16x16 knob to a
    // vertical line; a rotation has to keep reporting 1, so rejecting a zero `a` component is not
    // the answer either.
    const [a, b, c, d] = [matrix.m11, matrix.m12, matrix.m21, matrix.m22];
    const q = Math.hypot((a + d) / 2, (b - c) / 2);
    const r = Math.hypot((a - d) / 2, (b + c) / 2);
    return {
      content: computed.content,
      width: Number.parseFloat(computed.width) || 0,
      height: Number.parseFloat(computed.height) || 0,
      opacity: Number.parseFloat(computed.opacity),
      display: computed.display,
      visibility: computed.visibility,
      background: computed.backgroundColor,
      translateX: matrix.m41,
      scale: Math.abs(q - r),
    };
  }, selector);
}

/**
 * The colour a control is actually seen against.
 *
 * Every translucent ancestor up to the first opaque one is composited, rather than stopping at the
 * first layer with any alpha at all. A control sitting on `rgba(255,255,255,0.04)` over a dark page
 * is seen as near-black; reporting that 4% white as the backdrop overstated the ratio by enough to
 * pass a genuinely low-contrast outline.
 */
async function backdropOf(locator: Locator): Promise<Rgba> {
  const layers = await locator.evaluate((element) => {
    const stack: string[] = [];
    let node: HTMLElement | null = element.parentElement;
    while (node) {
      const computed = getComputedStyle(node);
      // Checked before the colour, and only on layers below the control that are actually reached:
      // an image or gradient paints over its own background-color, so the colour is not what shows.
      if (computed.backgroundImage !== "none") return { image: true, stack };
      const background = computed.backgroundColor;
      const alpha = Number.parseFloat((background.match(/[\d.]+/g) ?? [])[3] ?? "1");
      if (alpha > 0) {
        stack.push(background);
        if (alpha >= 1) return { image: false, stack };
      }
      node = node.parentElement;
    }
    stack.push("rgb(255, 255, 255)");
    return { image: false, stack };
  });
  // Refusing is honest: a gradient behind the control has no single colour to measure against, and
  // silently picking one produces a ratio nobody ever sees.
  expect(layers.image, "a backdrop painting an image cannot be reduced to one colour").toBe(false);
  // Far to near, so the nearest translucent layer ends up on top.
  return layers.stack.reduceRight<Rgba>((below, layer) => over(parseColor(layer), below),
    { r: 255, g: 255, b: 255, a: 1 });
}

/**
 * Asserts an element occupies a real, laid-out box.
 *
 * Necessary but NOT sufficient, and the comment here used to claim otherwise: `boundingBox()`
 * reports layout geometry, so it sees `display: none` and `scale(0)` but not `clip-path`, a mask,
 * or an element painted over. Every caller pairs this with `expectInk`.
 */
function expectPainted(state: Awaited<ReturnType<typeof painted>>, label: string, minSize = 8) {
  expect(state.display, `${label} must not be display:none`).not.toBe("none");
  expect(state.visibility, `${label} must not be hidden`).toBe("visible");
  expect(state.opacity, `${label} must not be transparent`).toBeGreaterThan(0.5);
  expect(state.box?.width ?? 0, `${label} has no rendered width`).toBeGreaterThan(minSize);
  expect(state.box?.height ?? 0, `${label} has no rendered height`).toBeGreaterThan(minSize);
}

/** Asserts a pseudo-element is generated and actually paints something. */
function expectGenerated(state: Awaited<ReturnType<typeof pseudo>>, label: string) {
  expect(state.content, `${label} must be generated at all`).not.toBe("none");
  expect(state.display, `${label} must not be display:none`).not.toBe("none");
  expect(state.visibility, `${label} must not be hidden`).toBe("visible");
  expect(state.opacity, `${label} must not be transparent`).toBeGreaterThan(0.5);
  expect(state.width, `${label} has no width`).toBeGreaterThan(2);
  expect(state.height, `${label} has no height`).toBeGreaterThan(2);
  expect(state.scale, `${label} is collapsed by its transform`).toBeGreaterThan(0.5);
  expect(parseColor(state.background).a, `${label} has no fill`).toBeGreaterThan(0.5);
}

/**
 * The shadows in a computed `box-shadow` that actually form a ring around the element.
 *
 * `0 0 0 0 transparent` draws nothing. `1px 0 0 -100px` draws nothing either: the negative spread
 * collapses the shadow box well inside the border box. So does `101px 0 0 -100px` on a 56px-tall
 * row — the offset carries it clear horizontally, but 100px of inward spread has already collapsed
 * it vertically, which is why this needs the element's dimensions and not just the lengths.
 * Inset shadows never form an outer ring at all.
 */
function parseShadows(value: string, box: { width: number; height: number }): { color: Rgba; label: string }[] {
  if (!value || value === "none") return [];
  // Split on commas that are not inside a colour's own parentheses.
  return value.split(/,(?![^(]*\))/).flatMap((part) => {
    if (/\binset\b/.test(part)) return [];
    const color = part.match(/rgba?\([^)]*\)|color\([^)]*\)/)?.[0] ?? "rgba(0, 0, 0, 0)";
    const [x = 0, y = 0, blur = 0, spread = 0] = (part.replace(/(?:rgba?|color)\([^)]*\)/, "")
      .match(/-?[\d.]+px/g) ?? []).map(Number.parseFloat);
    const survives = box.width + 2 * spread > 0 && box.height + 2 * spread > 0;
    const reaches = Math.max(Math.abs(x), Math.abs(y)) + blur + spread > 0;
    return survives && reaches ? [{ color: parseColor(color), label: part.trim() }] : [];
  });
}

/**
 * Every screenshot in this file compares at these settings.
 *
 * `threshold` is the per-pixel tolerance, and Playwright's default of 0.2 is loose enough that a
 * wholesale colour change can count zero differing pixels: `#727c86` to `#999999` is about 0.12
 * apart, so a control recoloured to fail contrast matched its baseline exactly.
 *
 * These baselines are a backstop, not the primary guard. Pixelmatch does not count differences it
 * classifies as antialiasing, and a thin stroke is nearly all antialiasing — erasing the whole
 * light chevron scored four differences. `inkOf` is what actually holds the line; the baselines
 * catch changes of appearance that are still, pixel for pixel, appearances.
 */
const PIXELS = { threshold: 0.1, animations: "disabled" } as const;

for (const theme of THEMES) {
  test(`every affordance is painted in ${theme} @production`, async ({ page }) => {
    // Every row in the registry, each on the section that owns it. The nav row's leading icon is in
    // here because nothing else looks at it: `.ui-row-icon { opacity: 0 }` takes it off the
    // production Keyboard Shortcuts row and every other assertion stays green.
    for (const key of Object.keys(ROWS) as RowKey[]) {
      const spec = ROWS[key];
      const row = await useRow(page, theme, key);
      const mark = row.locator(spec.affordance);
      const state = await painted(mark);
      expectPainted(state, `the ${key} affordance`, spec.minSize);
      if (spec.affordance !== ".ui-row-icon" && spec.affordance !== ".ui-row-chevron") {
        // The border IS the affordance for a radio or a track, and it must actually paint: a
        // zero-alpha colour renders nothing while every geometric assertion still passes.
        expect(state.borderWidth, `the ${key} border must be drawn`).toBeGreaterThan(0);
        expect(parseColor(state.borderColor).a, `the ${key} border must not be transparent`).toBeGreaterThan(0.5);
      }
      await expectInk(page, mark, `the ${key} affordance`, spec.floor);
      if (spec.affordance === ".ui-switch") await expectKnob(page, mark, `the ${key} knob`);
    }
  });

  test(`control outlines clear 3:1 against the surface behind them in ${theme}`, async ({ page }) => {
    // Measured on the RENDERED element against its REAL backdrop — the panel surface, not the page
    // background. The unit test measured the token against an assumed surface, which passed both
    // when the rule stopped using the token and when the surface differed from the assumption.
    for (const name of ["switchOff"] as const) {
      const locator = (await useRow(page, theme, name)).locator(ROWS[name].affordance);
      const state = await painted(locator);
      const border = parseColor(state.borderColor);
      expect(border.a, `${name} border paints nothing`).toBeGreaterThan(0);
      const backdrop = await backdropOf(locator);
      // Composited, and dimmed by whatever the ancestor chain applies, so a translucent or faded
      // outline is measured as it actually appears.
      const ratio = contrast(over({ ...border, a: border.a * state.opacity }, backdrop), backdrop);
      expect(ratio, `${name} is ${ratio.toFixed(2)}:1 against its backdrop`).toBeGreaterThanOrEqual(3);
    }
  });

  test(`checked state is painted as more than colour in ${theme}`, async ({ page }) => {
    await useHarness(page, theme, { section: "notifications" });
    const off = await pseudo(rowOf(page, "switchOff").locator(".ui-switch"), "::after");
    const on = await pseudo(rowOf(page, "switchOn").locator(".ui-switch"), "::after");
    expectGenerated(off, "the off knob");
    expectGenerated(on, "the on knob");
    // The knob must travel, not merely recolour — colour alone is not an accessible state cue.
    expect(Math.abs(on.translateX - off.translateX), "the knob must move between off and on").toBeGreaterThan(8);
  });

  test(`a navigation row paints a chevron in ${theme}`, async ({ page }) => {
    const slot = (await useRow(page, theme, "navChevron")).locator(".ui-row-chevron");
    const svg = slot.locator("svg");
    await expect(svg).toBeVisible();

    // The SVG has an explicit 15x15 box, so it stays "visible" at full size even painting nothing.
    // What matters is the stroke: its alpha, its width, and its contrast against the row.
    const stroke = await svg.locator("path, polyline, line").first().evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        stroke: computed.stroke,
        strokeWidth: Number.parseFloat(computed.strokeWidth) || 0,
        fill: computed.fill,
        geometry: (element.getAttribute("d") ?? element.getAttribute("points") ?? "").trim(),
      };
    });
    expect(stroke.geometry.length, "the chevron path must describe a shape").toBeGreaterThan(4);
    expect(stroke.stroke, "a chevron drawn with `stroke: none` paints nothing").not.toBe("none");
    expect(stroke.strokeWidth, "and needs a positive stroke width").toBeGreaterThan(0);

    const ink = parseColor(stroke.stroke);
    expect(ink.a, "the chevron stroke must not be transparent").toBeGreaterThan(0.5);
    const dimming = await effectiveOpacity(slot);
    const backdrop = await backdropOf(slot);
    const ratio = contrast(over({ ...ink, a: ink.a * dimming }, backdrop), backdrop);
    expect(ratio, `the chevron is ${ratio.toFixed(2)}:1 against the row`).toBeGreaterThanOrEqual(3);
    // And, since all of the above survives `clip-path: inset(50%)`, the pixels.
    await expectInk(page, slot, "the chevron", INK.chevron);
  });

  /**
   * Under the pointer, where nothing else in this file looks.
   *
   * `.ui-row:hover :is(.ui-radio, .ui-switch, .ui-row-chevron) { clip-path: inset(50%) }` is one
   * rule that erases every affordance in the dialog for anyone using a mouse.
   */
  test(`affordances survive hover in ${theme}`, async ({ page }) => {
    for (const label of Object.keys(ROWS) as RowKey[]) {
      const { affordance, minSize, floor } = ROWS[label];
      const row = await useRow(page, theme, label);
      await row.hover();
      expect(await row.evaluate((element) => element.matches(":hover")),
        `${label}'s row must actually be hovered`).toBe(true);
      expectPainted(await painted(row.locator(affordance)), `the hovered ${label}`, minSize);
      await expectInk(page, row.locator(affordance), `the hovered ${label}`, floor);
      // A switch's aggregate ink is dominated by its own fill, so the knob needs measuring on its
      // own: `.ui-row-switch:hover .ui-switch::after { clip-path: inset(50%) }` left ~275 pixels
      // against a 240 floor and took the only positional cue off a hovered switch.
      if (affordance === ".ui-switch") await expectKnob(page, row.locator(affordance), `the hovered ${label} knob`);
    }
  });

  /**
   * A row that cannot be operated still has to say what kind of control it is.
   *
   * `.ui-row.is-disabled` is reachable in production — App.tsx passes `disabled` to the Tailnet
   * switch while the tailnet is unmanaged or restarting — but no fixture carried the class, so
   * `.ui-row.is-disabled .ui-switch { opacity: 0 }` made that row's switch vanish with every
   * assertion green. Contrast is deliberately not required: WCAG exempts inactive components, and
   * the 0.55 row dimming is the intended appearance.
   */
  test(`disabled rows keep their affordances in ${theme}`, async ({ page }) => {
    // Every row, including BOTH switch values. Production reaches disabled-OFF — App.tsx disables
    // Tailnet whenever it is unmanaged or restarting, which includes while `enabled` is false — and
    // an earlier loop inspected only the checked one, leaving
    // `.ui-row-switch.is-disabled[aria-checked="false"] .ui-switch { opacity: 0 }` green.
    for (const label of Object.keys(ROWS) as RowKey[]) {
      const { affordance, minSize, floor } = ROWS[label];
      const row = await useRow(page, theme, label, { state: "disabled" });
      await expect(row).toBeDisabled();
      await expect(row).toHaveClass(/is-disabled/);
      expectPainted(await painted(row.locator(affordance)), `the disabled ${label}`, minSize);
      await expectInk(page, row.locator(affordance), `the disabled ${label}`, floor);
      if (affordance === ".ui-switch") await expectKnob(page, row.locator(affordance), `the disabled ${label} knob`);
    }
  });

  /**
   * The busy toggle, from both confirmed values, in both themes.
   *
   * Testing only the ON side proved that switching something off keeps announcing on until the
   * request lands, but not the reverse: `aria-checked={busy ? true : checked}` — a plausible
   * simplification — made a switch announce and paint ON before the subscription it represents
   * existed. And testing only dark left
   * `html[data-theme="light"] .ui-row-switch.is-busy[aria-checked="false"] .ui-switch { opacity: 0 }`
   * green.
   */
  for (const [state, confirmed] of [["busy-on", true], ["busy-off", false]] as const) {
    test(`a switch busy from ${confirmed ? "on" : "off"} keeps showing its confirmed value in ${theme}`, async ({ page }) => {
      const busy = await useRow(page, theme, "switchOn", { state });
      await expect(busy).toHaveAttribute("aria-checked", String(confirmed));
      await expect(busy).toHaveAttribute("aria-busy", "true");
      await expect(busy).toBeDisabled();

      // The busy state is carried by opacity, so it is one declaration away from erasing the
      // control it is meant to dim. `.is-busy .ui-switch { opacity: 0 }` left a row that announced
      // "on" with no visible switch, and passed everything.
      const track = await painted(busy.locator(".ui-switch"));
      expectPainted(track, "the busy switch track", 16);
      expectGenerated(await pseudo(busy.locator(".ui-switch"), "::after"), "the busy switch knob");
      await expectInk(page, busy.locator(".ui-switch"), "the busy switch track", INK.track);
      await expectKnob(page, busy.locator(".ui-switch"), "the busy switch knob");

      // The knob's position is the visual half of the same promise the attribute makes.
      const knob = await pseudo(busy.locator(".ui-switch"), "::after");
      const reference = await pseudo(rowOf(page, "switchOff").locator(".ui-switch"), "::after");
      if (confirmed) {
        expect(knob.translateX - reference.translateX, "a busy-from-on knob must stay at the on end").toBeGreaterThan(8);
      } else {
        expect(Math.abs(knob.translateX - reference.translateX), "a busy-from-off knob must not have travelled").toBeLessThan(1);
      }

      // Dimmed, but still an on/off control you can read. `painted` reports the opacity the track is
      // actually drawn at, including the row's own, so stacked dimming cannot hide here.
      const border = parseColor(track.borderColor);
      const backdrop = await backdropOf(busy.locator(".ui-switch"));
      const ratio = contrast(over({ ...border, a: border.a * track.opacity }, backdrop), backdrop);
      expect(ratio, `the busy track is ${ratio.toFixed(2)}:1 against its backdrop`).toBeGreaterThanOrEqual(3);
    });
  }
}

/**
 * The permutations production actually renders.
 *
 * `NotifyRow` returns null when notifications are unsupported, `PushRow` when push is unavailable,
 * and the Tailnet switch is replaced by a disabled explanation when Tailscale is absent. With both
 * notification rows always present in the fixture, `.ui-row-switch:only-child` under Alerts was a
 * selector that matched a real production surface and nothing here.
 */
test("the reduced topology production can render is covered too @production", async ({ page }) => {
  await useHarness(page, "dark", { topology: "minimal", section: "notifications" });
  await expect(page.locator(".settings-options .ui-row"), "Desktop Alerts must be the only notification row")
    .toHaveCount(1);
  await expectInk(page, rowOf(page, "switchOff").locator(".ui-switch"),
    "the sole notification switch", INK.track);

  // Network in its unavailable form: an explanation instead of a switch, which is the shape
  // §11.3 requires — the setting stays visible and says why it cannot be changed.
  await useHarness(page, "dark", { topology: "minimal", section: "network" });
  // The row is still THERE — §11.3's rule is that a setting which could exist stays visible — but
  // it is an EXPLANATION, not a control in the off position. A disabled switch announces
  // `aria-checked="false"`, which claims the setting is off; when the value cannot be read, that
  // claim is false, and for a network-exposure setting it is false in the dangerous direction.
  await expect(page.getByRole("switch", { name: /^Enable Tailnet Access/ }),
    "an unknown value must not be announced as off").toHaveCount(0);
  await expect(page.getByText("Enable Tailnet Access for This Machine"),
    "and the setting must still be visible").toBeVisible();
  await expect(page.getByText(/Tailscale is not installed/),
    "an unavailable setting has to say why it is unavailable").toBeVisible();
});

/** Every section renders, and each one names itself. A route that 404s inside the app is worse
 *  than a dialog tab that does not open, because it is a link someone can send. */
test("the tailnet switch says it is busy, not merely unavailable", async ({ page }) => {
  // A write restarts the local control plane. Passing only `disabled` left the row generically
  // unavailable while its own description said a restart was in progress — and the fixture could
  // not see it, because its Network state hardcoded `busy: false` and every busy assertion in this
  // file was measuring Push.
  await useHarness(page, "dark", { state: "busy-on", section: "network" });
  const row = page.getByRole("switch", { name: /^Enable Tailnet Access/ });
  await expect(row).toHaveAttribute("aria-busy", "true");
  await expect(row).toHaveClass(/is-busy/);
  // Still showing the value the server last confirmed, which is the whole point of a busy state.
  await expect(row).toHaveAttribute("aria-checked", "true");
  await expectInk(page, row.locator(".ui-switch"), "the busy tailnet track", INK.track);
  await expectKnob(page, row.locator(".ui-switch"), "the busy tailnet knob");
});

test("an unavailable tailnet does not take the rest of Network with it", async ({ page }) => {
  // The round-one fix added Control-Plane Origin and Manage Instances; the round-two fix stopped an
  // early return from dropping them in every browser, which is where `available` is always false.
  await useHarness(page, "dark", { topology: "minimal", section: "network" });
  for (const title of ["Control-Plane Origin", "Manage Instances"]) {
    await expect(page.getByText(title, { exact: true }),
      `${title} must survive an unavailable tailnet`).toBeVisible();
  }
});

test("a fresh load leaves the tab order at the top of the page", async ({ page }) => {
  // The focus rescue fired on MOUNT, so the first Tab started after the panel heading and skipped
  // all six section links. Nothing was dropped on a fresh load; there was nothing to rescue.
  await useHarness(page, "dark", { section: "network" });
  expect(await page.evaluate(() => document.activeElement?.tagName ?? null),
    "nothing may take focus on a fresh load").toBe("BODY");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.className ?? ""),
    "the first stop must be the section list, not something after it").toContain("settings-section-link");
});

test("every section renders its own panel", async ({ page }) => {
  for (const { id, title } of SETTINGS_SECTIONS) {
    await useHarness(page, "dark", { section: id });
    await expect(page.locator(".settings-panel .ui-row, .settings-panel .settings-about").first(),
      `the ${title} panel must render something`).toBeVisible();
    await expect(page.locator(`.settings-section-link[aria-current="page"]`)).toHaveText(title);
  }
});

/**
 * Run in a real touch context. Resizing the viewport does not make desktop Chromium a coarse-pointer
 * device, so `@media (pointer: coarse)` never matched and the earlier version of this test passed
 * with the 44px rule deleted.
 */
test.describe("on a touch device", () => {
  // The device descriptor's own properties, minus defaultBrowserType — Playwright rejects that in
  // a describe group because it would force a new worker. hasTouch + isMobile are what make
  // `(pointer: coarse)` and `(hover: none)` match, which the assertion below verifies rather than
  // assumes.
  const phone = devices["Pixel 7"];
  test.use({ viewport: phone.viewport, hasTouch: phone.hasTouch, isMobile: phone.isMobile, userAgent: phone.userAgent });

  test("every row meets the 44px touch target", async ({ page }) => {
    // Every section, not one: a route renders a panel at a time, so checking only Appearance would
    // leave the other five unmeasured on the device the rule exists for.
    let total = 0;
    for (const { id } of SETTINGS_SECTIONS) {
      await useHarness(page, "dark", { section: id });
      const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
      expect(coarse, "this must run where the coarse-pointer rules actually apply").toBe(true);

      const rows = page.locator(".ui-row");
      const count = await rows.count();
      total += count;
      for (let index = 0; index < count; index += 1) {
        const row = rows.nth(index);
        const box = await row.boundingBox();
        const label = (await row.innerText()).split("\n")[0];
        expect(box?.height ?? 0, `"${label}" is below the 44px touch target`).toBeGreaterThanOrEqual(44);
      }
      if (count === 0) continue;
      // Every production row carries a description, so all of them clear 44px on their own content
      // and the loop above passes with the rule deleted. The floor itself has to be asserted.
      const floor = await rows.first().evaluate((element) => Number.parseFloat(getComputedStyle(element).minHeight) || 0);
      expect(floor, "the coarse-pointer minimum height must be declared, not merely met").toBeGreaterThanOrEqual(44);
    }
    expect(total, "the sections together must actually contain rows").toBeGreaterThan(4);

    // The section list is a touch target too, and it is the only way to move between panels here.
    const links = page.locator(".settings-section-link");
    for (let index = 0; index < await links.count(); index += 1) {
      const box = await links.nth(index).boundingBox();
      expect(box?.height ?? 0, "a section link is below the 44px touch target").toBeGreaterThanOrEqual(44);
    }
  });
});

/**
 * Pixel baselines.
 *
 * A backstop rather than the primary guard — see `PIXELS` for why a thin stroke can vanish inside
 * pixelmatch's antialiasing suppression, and `inkOf` for what replaced it. These still catch a
 * change of appearance that is, pixel for pixel, an appearance: a recolour, a resize, a moved knob.
 *
 * Scoped to the affordances themselves, never to text: glyph rasterisation differs across platforms
 * and would make these flaky, while a ring, a track and a chevron are pure geometry.
 *
 * BASELINES ARE PER-PLATFORM — Playwright suffixes them with the OS. Both linux (which CI runs)
 * and win32 sets are committed. A platform without a committed set skips loudly rather than
 * failing on a missing snapshot; regenerate with `playwright test settings-rows -u` on that OS.
 */
/**
 * An integer-sized, integer-positioned clip around an element.
 *
 * `expect(locator).toHaveScreenshot()` captures the element's box at page coordinates, which are
 * fractional: the modal is vertically centred and its height depends on system-font metrics, so a
 * CSS 17x17 radio came out as a 17x18 PNG. One pixel of difference in the runner's font — or an
 * unrelated change to the footer — moves everything by half a pixel, the capture crosses different
 * device-pixel boundaries, and the comparison fails on PNG DIMENSIONS before any tolerance applies.
 * Snapping to integers and adding a one-pixel margin makes the size a function of the CSS box alone.
 */
async function snappedClip(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return {
    x: Math.round(box.x) - 1,
    y: Math.round(box.y) - 1,
    width: Math.ceil(box.width) + 2,
    height: Math.ceil(box.height) + 2,
  };
}

const baselineDir = fileURLToPath(new URL("./settings-rows.spec.ts-snapshots", import.meta.url));
const hasBaselines = () => existsSync(`${baselineDir}/chevron-dark-${process.platform}.png`);
/** Never skip while generating: the guard would otherwise prevent the run that creates them. */
const skipWithoutBaselines = () => test.skip(!hasBaselines() && test.info().config.updateSnapshots === "none",
  `no ${process.platform} baselines committed — run with --update-snapshots to create them`);

for (const theme of THEMES) {
  test(`the affordances render as expected in ${theme}`, async ({ page }) => {
    skipWithoutBaselines();
    for (const [name, key] of [
      ["switch-off", "switchOff"],
      ["switch-on", "switchOn"],
      ["chevron", "navChevron"],
      ["nav-icon", "navIcon"],
    ] as const) {
      const locator = (await useRow(page, theme, key)).locator(ROWS[key].affordance);
      await locator.scrollIntoViewIfNeeded();
      await expect(page).toHaveScreenshot(`${name}-${theme}.png`,
        { ...PIXELS, clip: await snappedClip(locator), maxDiffPixelRatio: 0.02 });
    }
  });

  for (const state of ["busy-on", "busy-off", "disabled"] as const) {
    test(`the ${state} affordance renders as expected in ${theme}`, async ({ page }) => {
      skipWithoutBaselines();
      // Each needs its own page load, and each is a state whose whole expression is a dimming —
      // the one property that can take a control to nothing while its attributes stay right.
      const key = state === "disabled" ? "tailnetOn" : "switchOn";
      const track = (await useRow(page, theme, key, { state })).locator(".ui-switch");
      await track.scrollIntoViewIfNeeded();
      await expect(page).toHaveScreenshot(`switch-${state}-${theme}.png`,
        { ...PIXELS, clip: await snappedClip(track), maxDiffPixelRatio: 0.02 });
    });
  }
}

/**
 * Keyboard focus, on every row that is itself a control.
 *
 * The static test only required the rule to contain `outline:`, which `outline: none` satisfies,
 * and the first browser version focused one row alone — so
 * `.ui-row-switch:focus-visible, .ui-row-nav:focus-visible { outline: none; box-shadow: none }`
 * left switches and navigation rows with no keyboard indicator at all and passed. Which is why the
 * list below is every KIND rather than one representative, and why the Appearance controls get the
 * same treatment separately: a rule scoped to `.ui-seg-option:focus-visible` is exactly this defect
 * one primitive over.
 */
const FOCUSABLE = [
  // No Appearance row here any more: those rows are containers, and what takes focus is the pill or
  // the trigger INSIDE them. The ring on those is asserted in the Appearance block at the end of
  // this file, which measures the focused control rather than the row around it.
  { kind: "switch-off", key: "switchOff" },
  // A checked switch too. The styling is attribute-driven, so
  // `.ui-row-switch[aria-checked="true"]:focus-visible { outline: none }` is one rule that takes the
  // indicator off every switch that is on, and the unchecked target could not see it.
  { kind: "switch-on", key: "switchOn" },
  { kind: "nav", key: "navChevron" },
] as const satisfies ReadonlyArray<{ kind: string; key: RowKey }>;

/**
 * The focus clip is a FIXED-height window anchored on the affordance.
 *
 * It was the row's own box, whose height comes from the title and description line boxes and so
 * from the environment's UI font — the committed images were 41x67 on linux and 41x69 on win32,
 * which is that dependency showing. A one-pixel line-box difference between the WSL environment
 * that generated the linux set and the GitHub Ubuntu image CI runs on changes the PNG's dimensions
 * outright and fails the build for no visual reason. Everything this window contains — the row's
 * horizontal edges, the affordance, the ring around them — is laid out by the grid, not by text.
 */
const FOCUS_CLIP_HEIGHT = 40;
const FOCUS_PAD = 6;   // the ring sits at outline-offset 1px and is 2px wide, so 3px beyond the box

for (const theme of THEMES) {
  for (const target of FOCUSABLE) {
    test(`keyboard focus is visible on a ${target.kind} row in ${theme}`, async ({ page }) => {
      const row = await useRow(page, theme, target.key);
      const affordance = ROWS[target.key].affordance;

      // Focusable by the keyboard at all, not merely programmatically: `tabIndex={-1}` on the row
      // this test picks would otherwise leave it green while no sequential keyboard user can reach
      // it.
      expect(await row.evaluate((element) => (element as HTMLElement).tabIndex),
        `a ${target.kind} row must be in the tab order`).toBeGreaterThanOrEqual(0);

      const indicatorOf = () => row.evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          style: computed.outlineStyle,
          width: Number.parseFloat(computed.outlineWidth) || 0,
          color: computed.outlineColor,
          boxShadow: computed.boxShadow,
        };
      });

      // Scrolled into the modal's viewport BEFORE any of the boxes are read. `page.screenshot`
      // takes a clip in page coordinates but only ever captures what is on screen, and the dialog
      // content scrolls: on linux the taller rows push the nav row out of view, so the rest and
      // focused captures were both of the same empty region and their difference was exactly zero.
      // The row-level locator methods below auto-scroll, which is why only this one test was wrong,
      // and only on the platform whose fonts make the dialog tall enough.
      await row.scrollIntoViewIfNeeded();

      // The clip, derived from the real boxes, and asserted text-free rather than assumed so.
      const rowBox = (await row.boundingBox())!;
      const mark = (await row.locator(affordance).boundingBox())!;
      const body = (await row.locator(".ui-row-body").boundingBox())!;
      // Every remaining row-shaped control carries its affordance at the TRAILING edge — the one
      // leading-edge case was the radio's ring, and Appearance no longer has rows that are radios.
      // The clip is written for that one case rather than branching on an `edge` that now has a
      // single value: a branch no arrangement of this file can enter is not generality, it is an
      // untested path that reads as one.
      const span = { x: mark.x - FOCUS_PAD, width: rowBox.x + rowBox.width + FOCUS_PAD - (mark.x - FOCUS_PAD) };
      expect(span.x, "the focus clip must start after the label").toBeGreaterThanOrEqual(body.x + body.width);
      const clip = { ...span, y: mark.y + mark.height / 2 - FOCUS_CLIP_HEIGHT / 2, height: FOCUS_CLIP_HEIGHT };

      const atRest = await indicatorOf();
      const restPixels = await page.screenshot({ clip, animations: "disabled" });

      await row.focus();
      await expect(row).toBeFocused();
      expect(await row.evaluate((element) => element.matches(":focus-visible")),
        "a keyboard-focused row must match :focus-visible").toBe(true);

      // Either mechanism is valid, so collect every ring this row actually draws and require ONE of
      // them to be seen. Existence is not enough: `outline: 2px solid transparent` and
      // `box-shadow: 0 0 0 0 transparent` both satisfied the earlier "is it declared" check, and
      // neither puts a pixel on screen. A ring the same colour as the surface behind it is the same
      // failure by degrees, which is why this measures contrast rather than alpha.
      const focused = await indicatorOf();
      const rings: { label: string; color: Rgba }[] = [];
      if (focused.style !== "none" && focused.width > 0) {
        rings.push({ label: `outline ${focused.style} ${focused.width}px ${focused.color}`, color: parseColor(focused.color) });
      }
      for (const shadow of parseShadows(focused.boxShadow, rowBox)) {
        rings.push({ label: `box-shadow ${shadow.label}`, color: shadow.color });
      }
      // Both an outline and an outer box-shadow paint beyond the row, so the surface behind the row
      // — not the row's own background — is what they are seen against.
      const dimming = await effectiveOpacity(row);
      const behind = await backdropOf(row);
      const seen = rings.map((ring) => ({
        ...ring,
        ratio: contrast(over({ ...ring.color, a: ring.color.a * dimming }, behind), behind),
      }));
      expect(seen.some((ring) => ring.ratio >= 3),
        `focus must paint a ring of at least 3:1 against the surface behind the row; found ` +
        (seen.length ? seen.map((ring) => `${ring.label} at ${ring.ratio.toFixed(2)}:1`).join("; ") : "nothing drawn"),
      ).toBe(true);

      /*
       * And it has to be focus that paints it. Moving the same ring onto `.ui-row` unconditionally
       * gives every row an identical outline — keyboard focus then indicates nothing — while the
       * focused row's computed style and baseline are byte-for-byte what they were. Comparing the
       * same clip before and after focus is the only form of this claim that a permanent ring
       * cannot satisfy.
       */
      const focusPixels = await page.screenshot({ clip, animations: "disabled" });
      // Only the strip OUTSIDE the row's border box, which is where an outline or an outer
      // box-shadow paints and where nothing else can. Comparing the whole clip let a permanent ring
      // plus a three-levels-per-channel `:focus-visible` background change satisfy this: that
      // recolour is invisible at about 1.02:1, but its summed RGB delta is 9, so every interior
      // pixel counted.
      const outside = { x: rowBox.x + rowBox.width - clip.x, width: clip.x + clip.width - (rowBox.x + rowBox.width) };
      const delta = await differingPixels(page, restPixels, focusPixels, { ...outside, cssWidth: clip.width });
      expect(delta, "focus must paint a ring outside the row, not merely change something inside it")
        .toBeGreaterThan(40);

      // And the row's own affordance has to survive being focused. Every ink assertion above runs at
      // rest, so `.ui-row-nav:focus-visible .ui-row-chevron svg { clip-path: inset(50%) }` took the
      // navigation cue off the row exactly while it was keyboard-focused — the focused baseline
      // cannot see it, because a clipped chevron scores four pixelmatch differences.
      await expectInk(page, row.locator(affordance), `the focused ${target.kind} affordance`, ROWS[target.key].floor);

      /*
       * The baseline was the whole focused row at `maxDiffPixelRatio: 0.02`. On a 482x56 row that is
       * ~540 pixels — more than the entire 17x17 radio — so hiding the control outright while
       * focused fitted inside the budget.
       */
      skipWithoutBaselines();
      await expect(page).toHaveScreenshot(`row-focus-${target.kind}-${theme}.png`, {
        ...PIXELS,
        clip,
        // An absolute allowance, not a ratio, for the same reason.
        maxDiffPixels: 24,
      });
    });
  }
}

/**
 * Reachability, separately from appearance.
 *
 * Everything above calls `.focus()`, which works on elements a Tab press can never land on.
 */
test("tabbing through each section reaches every row kind", async ({ page }) => {
  const reached = new Set<string>();
  // Across sections now: a route renders one panel, so the kinds are no longer on one page.
  // The section list is itself in the tab order ahead of the rows, which is the thing this test
  // would otherwise stop noticing — a panel whose rows sit behind an unbounded run of links is
  // reachable in principle and not in practice.
  //
  // Appearance is not here because its rows are not focusable: they are containers, and the thing
  // Tab lands on is the pill or the trigger inside. That claim is the Appearance block's, at the
  // end of this file, and it is the same claim — it just has a different element to make it about.
  for (const section of ["notifications", "keyboard"] as const) {
    await useHarness(page, "dark", { section });
    for (let press = 0; press < 24; press += 1) {
      await page.keyboard.press("Tab");
      const kind = await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !active.classList.contains("ui-row")) return null;
        for (const candidate of ["ui-row-switch", "ui-row-nav"]) {
          if (active.classList.contains(candidate)) return candidate;
        }
        return null;
      });
      if (kind) {
        reached.add(kind);
        break;
      }
    }
  }
  expect([...reached].sort(), "every row kind must be reachable by Tab")
    .toEqual(["ui-row-nav", "ui-row-switch"]);
});

/**
 * The Appearance controls, which the row registry above cannot describe.
 *
 * Theme, Colour Scheme and Density were ten rows carrying one option each; they are three rows
 * carrying a whole control each. The registry's model — the row IS the control, and one child
 * selector is its affordance — does not fit that, so these get the machinery pointed at them
 * directly rather than a special case threaded through every helper above.
 *
 * What has to hold is unchanged in substance. An unselected option is still visible as an option
 * rather than as blank space; selection is still more than a recolour; the control is still
 * reachable by Tab and still shows a focus ring; and the swatches — which are the one thing here
 * that is a COLOUR by definition — still have to be visible against the surface behind them.
 */
test("Agent Harness defaults are keyboard-operable, cascade by model, and keep one editor open", async ({ page }) => {
  await useHarness(page, "dark", { section: "behavior", defaults: "agent" });
  const defaults = page.getByRole("button", { name: /Default Models, Efforts, and Permissions/ });
  await defaults.focus();
  await page.keyboard.press("Enter");
  await expect(defaults).toHaveAttribute("aria-expanded", "true");

  const harnessRows = page.locator(".agent-defaults-item > .ui-row-nav");
  const codex = harnessRows.filter({ hasText: "Codex App Server" });
  await codex.focus();
  await page.keyboard.press("Enter");
  await expect(codex).toHaveAttribute("aria-expanded", "true");
  const model = page.getByRole("button", { name: /^Codex App Server Model:/ });
  await model.focus();
  await page.keyboard.press("Enter");
  const modelList = page.getByRole("listbox", { name: "Codex App Server Model" });
  await expect(modelList).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(model).toHaveAccessibleName(/Sol/);
  await expect(page.getByRole("button", { name: /^Codex App Server Reasoning Effort:/ }))
    .toHaveAccessibleName(/Choose Effort/);

  const claude = harnessRows.filter({ hasText: "Claude Code" });
  await claude.click();
  await expect(codex).toHaveAttribute("aria-expanded", "false");
  await expect(claude).toHaveAttribute("aria-expanded", "true");
});

test.describe("the appearance controls", () => {
  const seg = (page: Page, name: string) => page.getByRole("radiogroup", { name });
  const pill = (page: Page, group: string, name: string) =>
    seg(page, group).getByRole("radio", { name });
  const trigger = (page: Page) => page.getByRole("button", { name: /^Colour Scheme:/ });

  for (const theme of THEMES) {
    test(`every option is visible before it is chosen in ${theme}`, async ({ page }) => {
      await useHarness(page, theme, { section: "appearance" });

      // Both segmented settings, because a rule scoped to one of them is a rule the other cannot
      // see, and they are the same primitive rendered twice.
      for (const [group, chosen, other] of [["Theme", "System", "Light"], ["Density", "Compact", "Comfortable"]] as const) {
        const groupBox = seg(page, group);
        expectPainted(await painted(groupBox), `the ${group} group`, 16);
        await expectInk(page, groupBox, `the ${group} group`, APPEARANCE_INK.pills);

        // The GROUP's border is what makes the unselected pills read as pills: their own border is
        // transparent, so deleting it leaves a row of bare words until one happens to be selected.
        const border = parseColor((await painted(groupBox)).borderColor);
        expect(border.a, `the ${group} group paints no boundary`).toBeGreaterThan(0);
        const backdrop = await backdropOf(groupBox);
        const ratio = contrast(over(border, backdrop), backdrop);
        expect(ratio, `the ${group} group is ${ratio.toFixed(2)}:1 against its backdrop`).toBeGreaterThanOrEqual(3);

        // And the unselected option is a real, laid-out target rather than a label.
        expectPainted(await painted(pill(page, group, other)), `the unselected ${group} option`, 16);
        await expect(pill(page, group, chosen)).toHaveAttribute("aria-checked", "true");
        await expect(pill(page, group, other)).toHaveAttribute("aria-checked", "false");
      }
    });

    test(`selection is painted as more than a recolour in ${theme}`, async ({ page }) => {
      await useHarness(page, theme, { section: "appearance" });
      const chosen = await painted(pill(page, "Theme", "System"));
      const other = await painted(pill(page, "Theme", "Light"));

      // A FILL and a BORDER, not accent-coloured text. Recolouring the label alone is the failure
      // this asserts against: it carries selection entirely in hue, which is the one channel a
      // colour-blind reader may not have.
      expect(parseColor(chosen.background).a, "the selected pill must be filled").toBeGreaterThan(0);
      expect(parseColor(chosen.borderColor).a, "and outlined").toBeGreaterThan(0);
      expect(chosen.background, "the selected and unselected pills must not share a background")
        .not.toBe(other.background);
      // The selected pill's own outline has to be seen against the group it sits in.
      const backdrop = await backdropOf(pill(page, "Theme", "System"));
      const border = parseColor(chosen.borderColor);
      const ratio = contrast(over(border, backdrop), backdrop);
      expect(ratio, `the selected pill is ${ratio.toFixed(2)}:1 against its backdrop`).toBeGreaterThanOrEqual(3);
    });

    test(`the scheme swatches are visible against the control in ${theme}`, async ({ page }) => {
      await useHarness(page, theme, { section: "appearance" });
      const swatch = trigger(page).locator(".ui-swatch");
      expectPainted(await painted(swatch), "the swatch", 8);
      await expectInk(page, swatch, "the swatch", APPEARANCE_INK.swatch);

      const dots = trigger(page).locator(".ui-swatch-dot");
      await expect(dots, "a scheme is three colours").toHaveCount(3);

      // The inline style actually reached the DOM. Three dots that all resolved to the same colour
      // is what a swatch renders when its map lookup missed, and it still looks like a swatch.
      const fills = await dots.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
      expect(new Set(fills).size, `the swatch painted ${fills.join(", ")}`).toBeGreaterThan(1);

      // A swatch shows a colour that may BE the surface behind it — Wollipog light's ground on a
      // near-white panel — so the outline is what keeps it a colour rather than a gap.
      const first = dots.first();
      const state = await painted(first);
      const border = parseColor(state.borderColor);
      expect(border.a, "a swatch dot paints no outline").toBeGreaterThan(0);
      const backdrop = await backdropOf(first);
      const ratio = contrast(over({ ...border, a: border.a * state.opacity }, backdrop), backdrop);
      expect(ratio, `the swatch outline is ${ratio.toFixed(2)}:1 against its backdrop`).toBeGreaterThanOrEqual(3);
    });

    test(`the appearance controls show a focus ring in ${theme}`, async ({ page }) => {
      // The claim FOCUSABLE makes for the row primitives, made for the two controls that are no
      // longer rows. `.ui-seg-option:focus-visible { outline: none }` is one rule that takes the
      // keyboard indicator off every segmented control in the app.
      await useHarness(page, theme, { section: "appearance" });
      for (const control of [pill(page, "Theme", "System"), trigger(page)]) {
        await control.focus();
        await expect(control).toBeFocused();
        expect(await control.evaluate((element) => element.matches(":focus-visible")),
          "a keyboard-focused control must match :focus-visible").toBe(true);

        const indicator = await control.evaluate((element) => {
          const computed = getComputedStyle(element);
          return {
            style: computed.outlineStyle,
            width: Number.parseFloat(computed.outlineWidth) || 0,
            color: computed.outlineColor,
            boxShadow: computed.boxShadow,
          };
        });
        const box = (await control.boundingBox())!;
        const rings: { label: string; color: Rgba }[] = [];
        if (indicator.style !== "none" && indicator.width > 0) {
          rings.push({ label: `outline ${indicator.style}`, color: parseColor(indicator.color) });
        }
        for (const shadow of parseShadows(indicator.boxShadow, box)) {
          rings.push({ label: `box-shadow ${shadow.label}`, color: shadow.color });
        }
        const behind = await backdropOf(control);
        const seen = rings.map((ring) => ({ ...ring, ratio: contrast(over(ring.color, behind), behind) }));
        expect(seen.some((ring) => ring.ratio >= 3),
          "focus must paint a ring of at least 3:1; found " +
          (seen.length ? seen.map((ring) => `${ring.label} at ${ring.ratio.toFixed(2)}:1`).join("; ") : "nothing drawn"),
        ).toBe(true);
      }
    });
  }

  test("the whole panel is three rows, one per setting", async ({ page }) => {
    // The defect this replaced, stated as a number: three settings rendered as ten rows under three
    // headings, so Appearance did not fit on a phone and the alternatives were never side by side.
    await useHarness(page, "dark", { section: "appearance" });
    await expect(page.locator(".settings-panel .ui-row")).toHaveCount(3);
    await expect(page.locator(".settings-panel .settings-group")).toHaveCount(1);
    await expect(page.locator(".settings-panel .ui-row-title")).toHaveText(["Theme", "Colour Scheme", "Density"]);
  });

  test("the closed controls share an edge and the open scheme list fits readable content", async ({ page }) => {
    await useHarness(page, "dark", { section: "appearance", copy: "long" });
    const controls = [seg(page, "Theme"), trigger(page), seg(page, "Density")];
    const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
    expect(boxes.every(Boolean)).toBe(true);
    for (const box of boxes.slice(1)) {
      expect(Math.abs(box!.x - boxes[0]!.x), "every closed control shares the value-column start").toBeLessThanOrEqual(1);
      expect(Math.abs(box!.x + box!.width - (boxes[0]!.x + boxes[0]!.width)),
        "every closed control shares the value-column end").toBeLessThanOrEqual(1);
    }

    await trigger(page).click();
    const list = page.getByRole("listbox", { name: "Colour Scheme" });
    await expect(list).toBeVisible();
    const geometry = await list.evaluate((element) => {
      const listRect = element.getBoundingClientRect();
      const triggerRect = document.querySelector<HTMLElement>('.ui-row-picker .ui-select-trigger')!
        .getBoundingClientRect();
      const descriptions = [...element.querySelectorAll<HTMLElement>(".ui-select-option-desc")];
      return {
        width: listRect.width,
        leftDelta: listRect.left - triggerRect.left,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        lines: descriptions.map((description) => {
          const computed = getComputedStyle(description);
          const lineHeight = Number.parseFloat(computed.lineHeight)
            || Number.parseFloat(computed.fontSize) * 1.2;
          return Math.round(description.getBoundingClientRect().height / lineHeight);
        }),
        swatchLefts: [...element.querySelectorAll<HTMLElement>(".ui-swatch")]
          .map((swatch) => Math.round(swatch.getBoundingClientRect().left)),
        bodyLefts: [...element.querySelectorAll<HTMLElement>(".ui-select-option-body")]
          .map((body) => Math.round(body.getBoundingClientRect().left)),
      };
    });
    expect(geometry.width).toBeGreaterThanOrEqual(398);
    expect(Math.abs(geometry.leftDelta)).toBeLessThanOrEqual(1);
    expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
    expect(Math.max(...geometry.lines), "localized-length descriptions remain at most two lines").toBeLessThanOrEqual(2);
    expect(new Set(geometry.swatchLefts).size, "every swatch uses the same option gutter").toBe(1);
    expect(new Set(geometry.bodyLefts).size, "every name and description starts on the same edge").toBe(1);

    // A 125% desktop scale exposes fewer CSS pixels for the same physical window. Exercise that
    // narrower layout as well as the corresponding device-pixel ratio.
    await page.setViewportSize({ width: 1024, height: 576 });
    const devtools = await page.context().newCDPSession(page);
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 576,
      deviceScaleFactor: 1.25,
      mobile: false,
    });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect.poll(() => page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scale: window.devicePixelRatio,
    }))).toEqual({ width: 1024, height: 576, scale: 1.25 });
    await expect.poll(async () => {
      const [triggerBox, listBox] = await Promise.all([trigger(page).boundingBox(), list.boundingBox()]);
      if (!triggerBox || !listBox) return null;
      const viewportWidth = await page.evaluate(() => window.innerWidth);
      const collisionLeft = Math.max(8, Math.min(triggerBox.x, viewportWidth - listBox.width - 8));
      return {
        collisionDelta: Math.round(listBox.x - collisionLeft),
        insideRightMargin: listBox.x + listBox.width <= viewportWidth - 8 + 1,
      };
    }).toEqual({ collisionDelta: 0, insideRightMargin: true });
  });

  test("Appearance choices stack at the app mobile breakpoint", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await useHarness(page, "dark", { section: "appearance" });
    const geometry = await page.locator(".ui-row-choice").evaluateAll((rows) => rows.map((row) => {
      const body = row.querySelector<HTMLElement>(".ui-row-body")!.getBoundingClientRect();
      const control = row.querySelector<HTMLElement>(".ui-row-choice-control")!.getBoundingClientRect();
      const description = row.querySelector<HTMLElement>(".ui-row-desc");
      const style = description ? getComputedStyle(description) : null;
      const lineHeight = style
        ? Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2
        : 1;
      return {
        controlTop: control.top,
        bodyBottom: body.bottom,
        descriptionLines: description ? Math.round(description.getBoundingClientRect().height / lineHeight) : 0,
      };
    }));
    for (const row of geometry) {
      expect(row.controlTop).toBeGreaterThanOrEqual(row.bodyBottom);
      expect(row.descriptionLines).toBeLessThanOrEqual(2);
    }
  });

  test("the scheme list becomes viewport-bounded and scrollable only in a short window", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 240 });
    await useHarness(page, "dark", { section: "appearance", copy: "long" });
    await trigger(page).click();
    const list = page.getByRole("listbox", { name: "Colour Scheme" });
    await expect(list).toBeVisible();
    const geometry = await list.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });
    expect(geometry.top).toBeGreaterThanOrEqual(8);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight - 8);
    expect(geometry.left).toBeGreaterThanOrEqual(8);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 8);
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  });

  for (const theme of THEMES) {
    test(`the aligned Appearance rows and colour menu match their ${theme} baselines`, async ({ page }) => {
      skipWithoutBaselines();
      await useHarness(page, theme, { section: "appearance" });
      await page.mouse.move(0, 0);
      const group = page.locator(".settings-panel .settings-group");
      await expect(page).toHaveScreenshot(`settings-rows-${theme}.png`, {
        ...PIXELS,
        clip: await snappedClip(group),
        maxDiffPixelRatio: 0.02,
      });

      await trigger(page).click();
      const list = page.getByRole("listbox", { name: "Colour Scheme" });
      await expect(list).toBeVisible();
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot(`colour-schemes-${theme}.png`, {
        ...PIXELS,
        clip: await snappedClip(list),
        maxDiffPixelRatio: 0.02,
      });
    });
  }

  test("the picker opens a listbox of palettes and Escape puts focus back", async ({ page }) => {
    await useHarness(page, "dark", { section: "appearance" });
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");

    await trigger(page).click();
    const list = page.getByRole("listbox", { name: "Colour Scheme" });
    await expect(list).toBeVisible();
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
    const options = list.getByRole("option");
    await expect(options).toHaveCount(5);
    // Every option carries its palette AND its sentence, which is the reason this is a listbox
    // rather than five more pills.
    await expect(list.locator(".ui-swatch")).toHaveCount(5);
    await expect(options.first()).toContainText("Wollipog");
    await expect(list.locator(".ui-select-option-desc").first()).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    // Focus RETURNS. A dismissal that leaves focus on <body> strands a keyboard user at the top of
    // the document, which is the defect #207 fixed in the rail's sheet.
    await expect(trigger(page)).toBeFocused();
  });

  test("browsing the picker repaints the page, and a cancellation puts the palette back", async ({ page }) => {
    // The preview is the one thing in this panel that can leave the WHOLE PAGE in a state nobody
    // asked for, so the harness applies it exactly as the shell does. Read off `data-scheme`, which
    // is the attribute every palette in the stylesheet is keyed on — Wollipog being its absence.
    await useHarness(page, "dark", { section: "appearance" });
    const applied = () => page.evaluate(() => document.documentElement.dataset.scheme ?? "wollipog");
    const browse = async () => {
      await trigger(page).click();
      // The list takes focus on a frame, so pressing a key before it lands sends the arrow to the
      // trigger — which reopens at the committed value and never moves the highlight.
      await expect(page.getByRole("listbox", { name: "Colour Scheme" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
    };
    expect(await applied()).toBe("wollipog");

    await browse();
    expect(await applied(), "the highlighted palette applies to the page, not to three dots").toBe("github");

    await page.keyboard.press("Escape");
    expect(await applied(), "a cancellation has to put the committed palette back").toBe("wollipog");

    await browse();
    await page.keyboard.press("Enter");
    expect(await applied(), "and a commit keeps it").toBe("github");
    await expect(trigger(page)).toHaveAttribute("aria-label", "Colour Scheme: GitHub");
  });

  test("tabbing through Appearance reaches every control, and the pills cost one stop", async ({ page }) => {
    // The roving contract, from the keyboard rather than from the markup: ten stacked radios cost
    // ten tab stops to pass, and the whole point of the pills is that a group costs one.
    await useHarness(page, "dark", { section: "appearance" });
    const stops: string[] = [];
    /*
     * ONE pass, ended at the last control rather than after a fixed budget.
     *
     * The controls are preceded by the six Settings section links and followed by nothing, so Tab
     * wraps back to the top of the document well inside a fixed thirty presses and walks the same
     * three stops again. `stops` then held each of them twice and the assertion below failed on a
     * page that was behaving perfectly — a spec that cannot pass says nothing about the contract.
     * The bound stays as a guard against a control that never gains focus at all.
     */
    for (let press = 0; press < 20 && stops.at(-1) !== "Density:Compact"; press += 1) {
      await page.keyboard.press("Tab");
      const reached = await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return null;
        if (active.classList.contains("ui-seg-option")) {
          return `${active.closest("[role=radiogroup]")?.getAttribute("aria-label")}:${active.textContent?.trim()}`;
        }
        return active.classList.contains("ui-select-trigger") ? "picker" : null;
      });
      if (reached) stops.push(reached);
    }
    expect(stops, "the controls are reached in order, and each group only once")
      .toEqual(["Theme:System", "picker", "Density:Compact"]);

    // And the reason a group costs one stop, asserted where it lives rather than inferred from the
    // traversal: every other option is held at -1 by the roving rule. Counted per group, because a
    // rule that put the stop on all three would still produce the ordered walk above.
    const rovingStops = await page.evaluate(() => [...document.querySelectorAll("[role=radiogroup]")].map((group) => ({
      group: group.getAttribute("aria-label"),
      stops: [...group.querySelectorAll("[role=radio]")].filter((radio) => radio.getAttribute("tabindex") === "0").length,
    })));
    expect(rovingStops, "each group carries exactly one tab stop")
      .toEqual([{ group: "Theme", stops: 1 }, { group: "Density", stops: 1 }]);
  });

  test("a disabled appearance row keeps its controls visible and explains nothing away", async ({ page }) => {
    // §11.3: an unavailable control stays on screen. `aria-disabled` rather than `disabled`, so the
    // options remain reachable and can still be read — a `disabled` button leaves the tab order
    // entirely, which is how an explanation stops reaching a keyboard user.
    await useHarness(page, "dark", { section: "appearance", state: "disabled" });
    for (const group of ["Theme", "Density"]) {
      expectPainted(await painted(seg(page, group)), `the disabled ${group} group`, 16);
      await expectInk(page, seg(page, group), `the disabled ${group} group`, APPEARANCE_INK.pills);
      // EVERY option, not the first. A row-level disable is every option at once, so checking one
      // of them passes on a group that disabled its selected pill and left the rest operable —
      // which reads as available and does nothing.
      const flags = await seg(page, group).getByRole("radio").evaluateAll(
        (radios) => radios.map((radio) => radio.getAttribute("aria-disabled")),
      );
      expect(flags, `every ${group} option must report itself unavailable`).toEqual(flags.map(() => "true"));
      expect(flags.length, `the disabled ${group} group must still render its options`).toBeGreaterThan(1);

      // And it says who took it away. A faded control with no explanation is the state §11.3
      // forbids: the setting is visible, unusable, and unaccounted for.
      const reason = seg(page, group).locator("xpath=following-sibling::small[contains(@class,'ui-seg-reason')]");
      await expect(reason).toBeVisible();
      await expect(reason).toHaveText("Managed by your workspace administrator.");
      // Resolved through the DOM rather than a CSS selector: `useId` puts colons in the id, which a
      // selector cannot carry, and "near it in the markup" is not what a screen reader reads.
      const associated = await seg(page, group).evaluate((node) => {
        const id = node.getAttribute("aria-describedby");
        return id ? node.ownerDocument.getElementById(id)?.textContent ?? null : null;
      });
      expect(associated, "the reason must be associated with the group, not merely near it")
        .toBe("Managed by your workspace administrator.");
    }
    await expect(trigger(page)).toHaveAttribute("aria-disabled", "true");
    expectPainted(await painted(trigger(page).locator(".ui-swatch")), "the disabled swatch", 8);
  });
});
