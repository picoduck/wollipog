import { expect, test as base, type Page } from "@playwright/test";

interface ResizeObserverLoopError {
  /** The fixture's follow-tail state in the frame the error reports. */
  followTailState: string | undefined;
  /** The reader's distance from its scroll end in that frame, before it paints. */
  distanceFromTail: number;
}

type LoopErrorHost = typeof window & { __resizeObserverLoopErrors?: ResizeObserverLoopError[] };

// React refuses a flushSync requested from inside a lifecycle and logs a console error. Whether
// that update still lands before paint then depends on where it was requested, which the geometry
// assertions here cannot show, so they keep passing. Treat every browser console error or uncaught
// page error in these scenarios as a failure.
//
// "ResizeObserver loop completed with undelivered notifications" is neither: Chromium reports it as
// a window `error` event, which reaches neither the console nor Playwright's page errors. It means
// an observer callback resized an element observed at the same or a shallower depth, and the
// browser left that notice for the next frame. The follow-tail re-pin runs in such a callback, so a
// late notice could paint a frame off the live tail. Chromium dispatches the event after the frame's
// last observer delivery and before its paint, so the geometry read in the listener is the geometry
// that frame paints. Every loop error is recorded and attached to the report, and the test fails if
// one leaves a following reader off its tail.
const test = base.extend<{ consoleErrorGuard: void; resizeObserverLoopGuard: boolean }>({
  resizeObserverLoopGuard: [true, { option: true }],
  consoleErrorGuard: [async ({ page, resizeObserverLoopGuard }, use, testInfo) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      const loopErrors: ResizeObserverLoopError[] = [];
      (window as LoopErrorHost).__resizeObserverLoopErrors = loopErrors;
      window.addEventListener("error", (event) => {
        if (!String(event.message).includes("ResizeObserver loop")) return;
        const reader = document.querySelector<HTMLElement>("[data-testid='reader']");
        loopErrors.push({
          followTailState: reader?.dataset.followTailState,
          distanceFromTail: reader ? reader.scrollHeight - reader.scrollTop - reader.clientHeight : 0,
        });
      });
    });
    await use();
    expect(errors, "the timeline logged unexpected browser console errors").toEqual([]);
    const loopErrors = await page.evaluate(() => (window as LoopErrorHost).__resizeObserverLoopErrors ?? []);
    if (loopErrors.length > 0) {
      await testInfo.attach("resize-observer-loop-errors", {
        body: JSON.stringify(loopErrors, null, 2),
        contentType: "application/json",
      });
    }
    if (!resizeObserverLoopGuard) return;
    expect(
      loopErrors.filter((error) => error.followTailState === "following" && error.distanceFromTail > 1),
      "a ResizeObserver notice left for the next frame painted a following reader off its tail",
    ).toEqual([]);
  }, { auto: true }],
});

async function rowGeometry(page: Page) {
  return page.locator("[data-virtual-row]").evaluateAll((rows) => rows.map((row) => {
    const rect = row.getBoundingClientRect();
    return { key: (row as HTMLElement).dataset.virtualKey, top: rect.top, bottom: rect.bottom, height: rect.height };
  }));
}

function rowsDoNotOverlap(rows: Awaited<ReturnType<typeof rowGeometry>>) {
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.top + 0.5 < rows[index - 1]!.bottom) return false;
  }
  return true;
}

async function expectNoOverlap(page: Page) {
  await expect.poll(async () => rowsDoNotOverlap(await rowGeometry(page))).toBe(true);
}

async function expectTranscriptWidthContained(page: Page) {
  const reader = page.getByTestId("reader");
  await expect.poll(() => reader.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  await expect.poll(() => reader.evaluate((element) => getComputedStyle(element).overflowX)).toBe("hidden");
}

async function visibleAnchor(page: Page) {
  return page.getByTestId("reader").evaluate((reader) => {
    const viewport = reader.getBoundingClientRect();
    const row = [...reader.querySelectorAll<HTMLElement>("[data-virtual-row]")]
      .find((candidate) => candidate.getBoundingClientRect().bottom > viewport.top);
    if (!row) return null;
    return {
      key: row.dataset.virtualKey,
      offset: row.getBoundingClientRect().top - viewport.top,
      index: Number(row.dataset.index),
    };
  });
}

async function settleLayout(page: Page, frames = 12) {
  await page.evaluate((count) => new Promise<void>((resolve) => {
    let remaining = count;
    const next = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }), frames);
}

function geometryByKey(rows: Awaited<ReturnType<typeof rowGeometry>>) {
  return new Map(rows.flatMap((row) => row.key == null ? [] : [[row.key, row.height] as const]));
}

async function stableAnchor(page: Page) {
  let stable: Awaited<ReturnType<typeof visibleAnchor>> = null;
  await expect.poll(async () => {
    const first = await visibleAnchor(page);
    await settleLayout(page, 3);
    const second = await visibleAnchor(page);
    const settled = first != null
      && second != null
      && first.key === second.key
      && Math.abs(first.offset - second.offset) < 0.5;
    if (settled) stable = second;
    return settled;
  }).toBe(true);
  return stable!;
}

async function waitForSharedHeightChange(
  page: Page,
  before: Awaited<ReturnType<typeof rowGeometry>>,
  direction: "greater" | "less" | "either",
) {
  const previous = geometryByKey(before);
  let observed: Awaited<ReturnType<typeof rowGeometry>> = [];
  await expect.poll(async () => {
    observed = await rowGeometry(page);
    return observed.some((row) => {
      if (row.key == null) return false;
      const oldHeight = previous.get(row.key);
      if (oldHeight == null) return false;
      if (direction === "greater") return row.height > oldHeight + 0.5;
      if (direction === "less") return row.height < oldHeight - 0.5;
      return Math.abs(row.height - oldHeight) > 0.5;
    });
  }).toBe(true);
  return observed;
}

async function distanceFromTail(page: Page) {
  return page.getByTestId("reader").evaluate((reader) =>
    reader.scrollHeight - reader.scrollTop - reader.clientHeight);
}

async function waitForStableReaderGeometry(page: Page) {
  const reader = page.getByTestId("reader");
  await expect.poll(async () => {
    const first = await reader.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    await settleLayout(page, 3);
    const second = await reader.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    return Math.abs(first.clientHeight - second.clientHeight) < 0.5
      && Math.abs(first.scrollHeight - second.scrollHeight) < 0.5
      && Math.abs(first.scrollTop - second.scrollTop) < 0.5;
  }).toBe(true);
}

async function moveToStableReadingAnchor(page: Page, ratio = 0.4) {
  const reader = page.getByTestId("reader");
  await reader.evaluate((element, position) => {
    element.scrollTop = element.scrollHeight * position;
    element.dispatchEvent(new Event("scroll"));
  }, ratio);
  await settleLayout(page);
  const intendedKey = await reader.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-virtual-row]")]
      .find((candidate) => candidate.getBoundingClientRect().bottom > viewport.top);
    if (!row) throw new Error("No visible transcript row was available to anchor.");
    element.scrollTop += row.getBoundingClientRect().top - viewport.top + 2;
    element.dispatchEvent(new Event("scroll"));
    return row.dataset.virtualKey;
  });
  await settleLayout(page);
  const anchor = await stableAnchor(page);
  expect(anchor?.key).toBe(intendedKey);
  return anchor;
}

async function rowIsVisible(page: Page, key: string) {
  return page.getByTestId("reader").evaluate((reader, expectedKey) => {
    const viewport = reader.getBoundingClientRect();
    const row = [...reader.querySelectorAll<HTMLElement>("[data-virtual-row]")]
      .find((candidate) => candidate.dataset.virtualKey === expectedKey);
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  }, key);
}

async function alignRowToViewport(page: Page, key: string) {
  const reader = page.getByTestId("reader");
  await reader.evaluate((element, expectedKey) => {
    const row = [...element.querySelectorAll<HTMLElement>("[data-virtual-row]")]
      .find((candidate) => candidate.dataset.virtualKey === expectedKey);
    if (!row) throw new Error(`Transcript row ${expectedKey} is not mounted.`);
    element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top + 2;
    element.dispatchEvent(new Event("scroll"));
  }, key);
  await settleLayout(page);
  const anchor = await visibleAnchor(page);
  expect(anchor?.key).toBe(key);
  return anchor!;
}

async function alignIndexToViewport(page: Page, index: number) {
  const row = page.locator(`[data-virtual-row][data-index="${index}"]`);
  await expect(row).toHaveCount(1);
  const key = await row.getAttribute("data-virtual-key");
  expect(key).not.toBeNull();
  return alignRowToViewport(page, key!);
}

interface ReflowRecorder {
  active: boolean;
  frames: number;
  overlapFrames: number;
  overlapExamples: Array<{
    width: string | undefined;
    previous: string | undefined;
    current: string | undefined;
    pixels: number;
  }>;
  observedWidths: Set<string>;
  observedPrefixHeights: Set<string>;
  anchorSamples: number;
  missingAnchorFrames: number;
  maxAnchorDrift: number;
  anchorDriftExamples: Array<{ width: string | undefined; offset: number; drift: number }>;
  finished: Promise<void>;
}

interface SessionReturnRecorder {
  active: boolean;
  frames: number;
  returnedSessionFrames: number;
  untrustedFrames: number;
  exposedUntrustedFrames: number;
  semanticUntrustedFrames: number;
  untrustedScrollHeights: Set<number>;
  untrustedClientHeights: Set<number>;
  readyFrames: number;
  busyReadyFrames: number;
  maxReadyRows: number;
  overlapFrames: number;
  overlapExamples: Array<{
    frame: number;
    previous: string | undefined;
    current: string | undefined;
    pixels: number;
  }>;
  finished: Promise<void>;
}

async function startSessionReturnRecorder(page: Page, returnedSession: string) {
  await page.evaluate((expectedSession) => {
    const host = window as typeof window & { __sessionReturnRecorder?: SessionReturnRecorder };
    let finish!: () => void;
    const recorder: SessionReturnRecorder = {
      active: true,
      frames: 0,
      returnedSessionFrames: 0,
      untrustedFrames: 0,
      exposedUntrustedFrames: 0,
      semanticUntrustedFrames: 0,
      untrustedScrollHeights: new Set<number>(),
      untrustedClientHeights: new Set<number>(),
      readyFrames: 0,
      busyReadyFrames: 0,
      maxReadyRows: 0,
      overlapFrames: 0,
      overlapExamples: [],
      finished: new Promise<void>((resolve) => { finish = resolve; }),
    };
    host.__sessionReturnRecorder = recorder;
    // ResizeObserver and its React commit run before paint. Sampling from a zero-delay timer after
    // each animation frame records the geometry users could actually see, including the first
    // returned-session frame rather than only the settled virtual layout.
    const scheduleSample = () => requestAnimationFrame(() => setTimeout(sample, 0));
    const sample = () => {
      recorder.frames += 1;
      const reader = document.querySelector<HTMLElement>("[data-testid='reader']");
      if (reader?.dataset.sessionId === expectedSession) {
        recorder.returnedSessionFrames += 1;
        const root = reader.querySelector<HTMLElement>("[data-virtual-measurements]");
        if (root?.dataset.virtualMeasurements === "pending") {
          recorder.untrustedFrames += 1;
          recorder.untrustedScrollHeights.add(reader.scrollHeight);
          recorder.untrustedClientHeights.add(reader.clientHeight);
          if (getComputedStyle(root).opacity !== "0") recorder.exposedUntrustedFrames += 1;
          if (root.getAttribute("role") === "list" &&
              root.getAttribute("aria-label") === "Session Activity" &&
              root.getAttribute("aria-busy") === "true" &&
              root.querySelectorAll("[data-virtual-row]").length > 1) {
            recorder.semanticUntrustedFrames += 1;
          }
        } else if (root?.dataset.virtualMeasurements === "ready") {
          recorder.readyFrames += 1;
          if (root.hasAttribute("aria-busy")) recorder.busyReadyFrames += 1;
          const rows = [...root.querySelectorAll<HTMLElement>("[data-virtual-row]")]
            .map((row) => ({
              index: Number(row.dataset.index),
              key: row.dataset.virtualKey,
              rect: row.getBoundingClientRect(),
            }))
            .sort((left, right) => left.index - right.index);
          recorder.maxReadyRows = Math.max(recorder.maxReadyRows, rows.length);
          const overlapIndex = rows.findIndex((row, index) =>
            index > 0 && row.rect.top + 0.5 < rows[index - 1]!.rect.bottom);
          if (overlapIndex > 0) {
            recorder.overlapFrames += 1;
            if (recorder.overlapExamples.length < 3) recorder.overlapExamples.push({
              frame: recorder.frames,
              previous: rows[overlapIndex - 1]!.key,
              current: rows[overlapIndex]!.key,
              pixels: rows[overlapIndex - 1]!.rect.bottom - rows[overlapIndex]!.rect.top,
            });
          }
        }
      }
      if (recorder.active) scheduleSample();
      else finish();
    };
    scheduleSample();
  }, returnedSession);
}

async function stopSessionReturnRecorder(page: Page) {
  await settleLayout(page, 12);
  return page.evaluate(async () => {
    const recorder = (window as typeof window & { __sessionReturnRecorder?: SessionReturnRecorder })
      .__sessionReturnRecorder;
    if (!recorder) throw new Error("Session return recorder is missing.");
    recorder.active = false;
    await recorder.finished;
    return {
      frames: recorder.frames,
      returnedSessionFrames: recorder.returnedSessionFrames,
      untrustedFrames: recorder.untrustedFrames,
      exposedUntrustedFrames: recorder.exposedUntrustedFrames,
      semanticUntrustedFrames: recorder.semanticUntrustedFrames,
      untrustedScrollHeights: [...recorder.untrustedScrollHeights],
      untrustedClientHeights: [...recorder.untrustedClientHeights],
      readyFrames: recorder.readyFrames,
      busyReadyFrames: recorder.busyReadyFrames,
      maxReadyRows: recorder.maxReadyRows,
      overlapFrames: recorder.overlapFrames,
      overlapExamples: recorder.overlapExamples,
    };
  });
}

interface StreamedGrowthRecorder {
  active: boolean;
  frames: number;
  overlapFrames: number;
  maxOverlapPx: number;
  overlapExamples: Array<{
    frame: number;
    previous: string | undefined;
    current: string | undefined;
    pixels: number;
  }>;
  /** Frames whose painted row layout flipped back to the layout from two frames earlier. */
  alternationFrames: number;
  signatures: string[];
  finished: Promise<void>;
}

/** Samples every painted frame for row overlap and for alternation between incompatible layouts
 * (the same rows repainting at two different sets of offsets on consecutive frames). */
async function startStreamedGrowthRecorder(page: Page) {
  await page.evaluate(() => {
    const host = window as typeof window & { __streamedGrowthRecorder?: StreamedGrowthRecorder };
    let finish!: () => void;
    const recorder: StreamedGrowthRecorder = {
      active: true,
      frames: 0,
      overlapFrames: 0,
      maxOverlapPx: 0,
      overlapExamples: [],
      alternationFrames: 0,
      signatures: [],
      finished: new Promise<void>((resolve) => { finish = resolve; }),
    };
    host.__streamedGrowthRecorder = recorder;
    const scheduleSample = () => requestAnimationFrame(() => setTimeout(sample, 0));
    const sample = () => {
      // Estimate-backed geometry is deliberately unpainted (opacity 0) until its first seed; the
      // dedicated session-return test asserts that invariant. This recorder samples only frames a
      // reader could actually see.
      const root = document.querySelector<HTMLElement>("[data-virtual-measurements]");
      if (!root || root.dataset.virtualMeasurements !== "ready" || getComputedStyle(root).opacity === "0") {
        if (recorder.active) scheduleSample();
        else finish();
        return;
      }
      recorder.frames += 1;
      const rows = [...document.querySelectorAll<HTMLElement>("[data-virtual-row]")]
        .map((row) => ({
          index: Number(row.dataset.index),
          key: row.dataset.virtualKey,
          rect: row.getBoundingClientRect(),
        }))
        .sort((left, right) => left.index - right.index);
      const overlapIndex = rows.findIndex((row, index) =>
        index > 0 && row.rect.top + 0.5 < rows[index - 1]!.rect.bottom);
      if (overlapIndex > 0) {
        recorder.overlapFrames += 1;
        const pixels = rows[overlapIndex - 1]!.rect.bottom - rows[overlapIndex]!.rect.top;
        recorder.maxOverlapPx = Math.max(recorder.maxOverlapPx, pixels);
        if (recorder.overlapExamples.length < 3) recorder.overlapExamples.push({
          frame: recorder.frames,
          previous: rows[overlapIndex - 1]!.key,
          current: rows[overlapIndex]!.key,
          pixels,
        });
      }
      const signature = rows.map((row) => `${row.key}@${Math.round(row.rect.top)}`).join("|");
      const signatures = recorder.signatures;
      signatures.push(signature);
      const length = signatures.length;
      if (length >= 4 &&
          signatures[length - 1] === signatures[length - 3] &&
          signatures[length - 2] === signatures[length - 4] &&
          signatures[length - 1] !== signatures[length - 2]) {
        recorder.alternationFrames += 1;
      }
      if (signatures.length > 8) signatures.shift();
      if (recorder.active) scheduleSample();
      else finish();
    };
    scheduleSample();
  });
}

async function stopStreamedGrowthRecorder(page: Page) {
  await settleLayout(page, 8);
  return page.evaluate(async () => {
    const recorder = (window as typeof window & { __streamedGrowthRecorder?: StreamedGrowthRecorder })
      .__streamedGrowthRecorder;
    if (!recorder) throw new Error("Streamed growth recorder is missing.");
    recorder.active = false;
    await recorder.finished;
    return {
      frames: recorder.frames,
      overlapFrames: recorder.overlapFrames,
      maxOverlapPx: recorder.maxOverlapPx,
      overlapExamples: recorder.overlapExamples,
      alternationFrames: recorder.alternationFrames,
    };
  });
}

interface PaintedTailFrame {
  /** The reader's distance from its scroll end when the frame painted. */
  distance: number;
  following: boolean;
}

interface PaintedTailSampler {
  active: boolean;
  frameTime: number | null;
  latest: PaintedTailFrame | null;
  frames: PaintedTailFrame[];
}

type PaintedTailHost = typeof window & { __paintedTailSampler?: PaintedTailSampler };

/**
 * Samples the reader geometry each frame actually paints.
 *
 * A task-based sample taken after paint is not good enough here. When TanStack re-measures a row
 * without compensating scrollTop, it re-renders in a React scheduler task that can run before any
 * sampling task, so the sample reads a list-root size that no frame painted; the next frame
 * re-pins it before paint. Instead, record the geometry after every animation-frame and
 * ResizeObserver callback, and again after the microtasks each callback queued (MutationObserver
 * deliveries and React commits). Those microtasks can queue further microtasks, so the record
 * repeats across a chain of microtask hops, following continuations up to that depth. Otherwise
 * script cannot run between the last record and paint, so the final record of a frame is its
 * painted geometry. The next frame's first animation callback seals it. Install before the fixture
 * loads so the application's own observers are wrapped.
 */
async function installPaintedTailSampler(page: Page) {
  await page.addInitScript(() => {
    const sampler: PaintedTailSampler = { active: false, frameTime: null, latest: null, frames: [] };
    (window as PaintedTailHost).__paintedTailSampler = sampler;
    const record = () => {
      if (!sampler.active) return;
      const reader = document.querySelector<HTMLElement>("[data-testid='reader']");
      if (!reader) return;
      sampler.latest = {
        distance: reader.scrollHeight - reader.scrollTop - reader.clientHeight,
        following: reader.dataset.followTailState === "following",
      };
    };
    const microtaskHops = 16;
    const recordAfterCallback = () => {
      record();
      let hops = microtaskHops;
      const hop = () => {
        record();
        hops -= 1;
        if (hops > 0) queueMicrotask(hop);
      };
      queueMicrotask(hop);
    };
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => nativeRequestAnimationFrame((time) => {
      if (sampler.frameTime !== time) {
        if (sampler.active && sampler.latest) sampler.frames.push(sampler.latest);
        sampler.frameTime = time;
      }
      try {
        callback(time);
      } finally {
        recordAfterCallback();
      }
    });
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          try {
            callback(entries, observer);
          } finally {
            recordAfterCallback();
          }
        });
      }
    };
  });
}

/**
 * Streams chunks as tasks, the way live output arrives, and returns every frame painted from the
 * first chunk until well after the follow-tail settle window of the last one. Sampling ends only
 * once every chunk has actually streamed, so a runner whose timers lag behind its frames still
 * measures all of them.
 */
async function recordPaintedTailGrowth(page: Page, control: string, growths: number, framesPerGrowth = 3) {
  return page.evaluate(({ controlId, growthCount, spacing }) => new Promise<{
    growths: number;
    frames: PaintedTailFrame[];
  }>((resolve) => {
    const sampler = (window as PaintedTailHost).__paintedTailSampler;
    if (!sampler) throw new Error("The painted-frame sampler was not installed before the fixture loaded.");
    const button = document.querySelector<HTMLButtonElement>(`[data-testid='${controlId}']`)!;
    sampler.frames = [];
    sampler.latest = null;
    sampler.active = true;
    let frame = 0;
    let scheduled = 0;
    let streamed = 0;
    let settleFrames = 0;
    const tick = () => {
      frame += 1;
      if (scheduled < growthCount && frame % spacing === 1) {
        scheduled += 1;
        setTimeout(() => {
          button.click();
          streamed += 1;
        }, 0);
      }
      if (streamed === growthCount) settleFrames += 1;
      if (settleFrames < 16 && frame < 600) {
        requestAnimationFrame(tick);
        return;
      }
      sampler.active = false;
      resolve({ growths: streamed, frames: sampler.frames });
    };
    requestAnimationFrame(tick);
  }), { controlId: control, growthCount: growths, spacing: framesPerGrowth });
}

/** Streams several chunks a couple of frames apart, like live output settling into the timeline. */
async function streamChunks(page: Page, control: string, chunks: number) {
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    await page.getByTestId(control).click();
    await settleLayout(page, 2);
  }
}

async function dragPanelResizer(page: Page) {
  const resizer = page.getByTestId("panel-resizer");
  await expect(resizer).toBeVisible();
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 2, box!.y + box!.height / 2, { steps: 10 });
  await page.mouse.move(box!.x + 2, box!.y + box!.height / 2, { steps: 10 });
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 10 });
  await page.mouse.up();
  await resizer.fill("460");
}

async function recordContinuousResize(page: Page) {
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await expect.poll(async () => page.locator("[data-virtual-row]").evaluateAll((rows) =>
    Math.max(...rows.map((row) => row.textContent?.length ?? 0)))).toBeGreaterThan(1_000);
  await page.getByTestId("medium-panel").click();
  await expect(page.getByTestId("panel")).toHaveAttribute("data-width", "460");
  await expect(page.getByTestId("width-sensitive-prefix")).toBeVisible();
  await settleLayout(page);
  const before = await moveToStableReadingAnchor(page, 0.35);
  expect(before).not.toBeNull();

  await page.evaluate((initialAnchor) => {
    const host = window as typeof window & { __timelineReflowRecorder?: ReflowRecorder };
    let finish!: () => void;
    const recorder: ReflowRecorder = {
      active: true,
      frames: 0,
      overlapFrames: 0,
      overlapExamples: [],
      observedWidths: new Set<string>(),
      observedPrefixHeights: new Set<string>(),
      anchorSamples: 0,
      missingAnchorFrames: 0,
      maxAnchorDrift: 0,
      anchorDriftExamples: [],
      finished: new Promise<void>((resolve) => { finish = resolve; }),
    };
    host.__timelineReflowRecorder = recorder;
    // Sample once per painted frame. The timer runs after ResizeObserver delivery, React's
    // synchronous commit, and the browser paint that users can actually see.
    const scheduleSample = () => requestAnimationFrame(() => setTimeout(sample, 0));
    const sample = () => {
      recorder.frames += 1;
      const panel = document.querySelector<HTMLElement>("[data-testid='panel']");
      if (panel?.dataset.width) recorder.observedWidths.add(panel.dataset.width);
      const prefix = document.querySelector<HTMLElement>("[data-testid='width-sensitive-prefix']");
      if (prefix) recorder.observedPrefixHeights.add(prefix.getBoundingClientRect().height.toFixed(2));
      const reader = document.querySelector<HTMLElement>("[data-testid='reader']");
      const anchoredRow = [...document.querySelectorAll<HTMLElement>("[data-virtual-row]")]
        .find((row) => row.dataset.virtualKey === initialAnchor.key);
      if (reader && anchoredRow) {
        recorder.anchorSamples += 1;
        const offset = anchoredRow.getBoundingClientRect().top - reader.getBoundingClientRect().top;
        const drift = Math.abs(offset - initialAnchor.offset);
        recorder.maxAnchorDrift = Math.max(recorder.maxAnchorDrift, drift);
        if (drift >= 1 && recorder.anchorDriftExamples.length < 5) {
          recorder.anchorDriftExamples.push({ width: panel?.dataset.width, offset, drift });
        }
      } else {
        recorder.missingAnchorFrames += 1;
      }
      const rows = [...document.querySelectorAll<HTMLElement>("[data-virtual-row]")]
        .map((row) => ({ key: row.dataset.virtualKey, rect: row.getBoundingClientRect() }))
        .sort((left, right) => left.rect.top - right.rect.top);
      const overlapIndex = rows.findIndex((row, index) =>
        index > 0 && row.rect.top + 0.5 < rows[index - 1]!.rect.bottom);
      if (overlapIndex > 0) {
        recorder.overlapFrames += 1;
        if (recorder.overlapExamples.length < 3) recorder.overlapExamples.push({
          width: panel?.dataset.width,
          previous: rows[overlapIndex - 1]!.key,
          current: rows[overlapIndex]!.key,
          pixels: rows[overlapIndex - 1]!.rect.bottom - rows[overlapIndex]!.rect.top,
        });
      }
      if (recorder.active) scheduleSample();
      else finish();
    };
    scheduleSample();
  }, { key: before!.key!, offset: before!.offset });

  await dragPanelResizer(page);
  await settleLayout(page);
  const sampled = await page.evaluate(async () => {
    const recorder = (window as typeof window & { __timelineReflowRecorder?: ReflowRecorder })
      .__timelineReflowRecorder;
    if (!recorder) throw new Error("Reflow recorder is missing.");
    recorder.active = false;
    await recorder.finished;
    return {
      frames: recorder.frames,
      overlapFrames: recorder.overlapFrames,
      overlapExamples: recorder.overlapExamples,
      observedWidths: [...recorder.observedWidths],
      observedPrefixHeights: [...recorder.observedPrefixHeights],
      anchorSamples: recorder.anchorSamples,
      missingAnchorFrames: recorder.missingAnchorFrames,
      maxAnchorDrift: recorder.maxAnchorDrift,
      anchorDriftExamples: recorder.anchorDriftExamples,
    };
  });
  return { before: before!, sampled };
}

interface HeightOnlyRecorder {
  active: boolean;
  frames: number;
  missingAnchorFrames: number;
  samples: Array<{ drift: number; prefixHeight: number; readerWidth: number }>;
  finished: Promise<void>;
}

async function recordNoticeChanges(page: Page, change: () => Promise<void>) {
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await settleLayout(page);
  const before = await moveToStableReadingAnchor(page, 0.35);
  const initial = await page.evaluate((key) => {
    const reader = document.querySelector<HTMLElement>("[data-testid='reader']")!;
    const prefix = document.querySelector<HTMLElement>("[data-testid='width-sensitive-prefix']")!;
    const row = [...document.querySelectorAll<HTMLElement>("[data-virtual-row]")]
      .find((candidate) => candidate.dataset.virtualKey === key)!;
    return {
      readerWidth: reader.getBoundingClientRect().width,
      prefixHeight: prefix.getBoundingClientRect().height,
      rowOffset: row.getBoundingClientRect().top - reader.getBoundingClientRect().top,
    };
  }, before!.key!);
  await page.evaluate(({ key, offset }) => {
    const host = window as typeof window & { __heightOnlyRecorder?: HeightOnlyRecorder };
    let finish!: () => void;
    const recorder: HeightOnlyRecorder = {
      active: true,
      frames: 0,
      missingAnchorFrames: 0,
      samples: [],
      finished: new Promise<void>((resolve) => { finish = resolve; }),
    };
    host.__heightOnlyRecorder = recorder;
    const scheduleSample = () => requestAnimationFrame(() => setTimeout(sample, 0));
    const sample = () => {
      recorder.frames += 1;
      const reader = document.querySelector<HTMLElement>("[data-testid='reader']")!;
      const prefix = document.querySelector<HTMLElement>("[data-testid='width-sensitive-prefix']");
      const row = [...document.querySelectorAll<HTMLElement>("[data-virtual-row]")]
        .find((candidate) => candidate.dataset.virtualKey === key);
      if (row) recorder.samples.push({
        drift: row.getBoundingClientRect().top - reader.getBoundingClientRect().top - offset,
        prefixHeight: prefix?.getBoundingClientRect().height ?? 0,
        readerWidth: reader.getBoundingClientRect().width,
      });
      else recorder.missingAnchorFrames += 1;
      if (recorder.active) scheduleSample();
      else finish();
    };
    scheduleSample();
  }, { key: before!.key!, offset: initial.rowOffset });

  await change();
  await settleLayout(page, 12);
  const recorded = await page.evaluate(async () => {
    const recorder = (window as typeof window & { __heightOnlyRecorder?: HeightOnlyRecorder })
      .__heightOnlyRecorder;
    if (!recorder) throw new Error("Height-only recorder is missing.");
    recorder.active = false;
    await recorder.finished;
    return {
      frames: recorder.frames,
      missingAnchorFrames: recorder.missingAnchorFrames,
      samples: recorder.samples,
    };
  });
  return { before: before!, initial, recorded };
}

test("timeline reader disables browser-native scroll anchoring", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html");
  const reader = page.getByTestId("reader");
  await expect(reader).toBeVisible();
  await expect.poll(() => reader.evaluate((element) => getComputedStyle(element).overflowAnchor)).toBe("none");
});

for (const width of [320, 390]) {
  for (const questionStyle of ["interactive", "composer"] as const) {
    test(`structured transcript rows stay inside a ${width}px phone reader with ${questionStyle} questions`, async ({ page }) => {
      await page.addInitScript((style) => {
        localStorage.setItem("wollipog.question-response-style", style);
      }, questionStyle);
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/timeline-reflow-e2e.html?overflow=1");
      const reader = page.getByTestId("reader");
      await expect(page.getByText("Automated Review")).toBeVisible();
      await expect(page.getByRole("button", { name: /2 Tool Calls Auto-Approved · High Risk/ })).toBeVisible();
      await expectTranscriptWidthContained(page);

      await page.getByRole("button", { name: /Worked/ }).click();
      await expect(page.locator(".tl-step").first()).toBeVisible();
      await expect(page.getByText("Automated Review")).toHaveCount(3);
      await expectTranscriptWidthContained(page);
      // An edit's diff is its step's body; a long path clips in the row instead of widening it.
      await page.locator("details.tl-step summary[aria-label^='Edit ']").click();
      await expectTranscriptWidthContained(page);
      const diff = page.locator(".tl-diff-scroll");
      await expect(diff).toBeVisible();
      expect(await diff.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

      const maximumScrollTop = await reader.evaluate((element) => element.scrollHeight - element.clientHeight);
      for (const scrollTop of [maximumScrollTop / 2, maximumScrollTop]) {
        await reader.evaluate((element, top) => {
          element.scrollTop = top;
          element.dispatchEvent(new Event("scroll"));
        }, scrollTop);
        await settleLayout(page);
        await expectTranscriptWidthContained(page);
      }

      const codeBlock = page.locator(".md pre");
      const table = page.locator(".md-table-wrap");
      await expect(codeBlock).toBeVisible();
      await expect(table).toBeVisible();
      expect(await codeBlock.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      for (const localScroller of [codeBlock, table]) {
        expect(await localScroller.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
        expect(await localScroller.evaluate((element) =>
          element.getBoundingClientRect().width <= element.parentElement!.getBoundingClientRect().width + 0.5)).toBe(true);
      }
    });
  }
}

test("timeline rows remeasure when a side panel narrows wrapped messages", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await settleLayout(page);
  const wide = await rowGeometry(page);
  await expectNoOverlap(page);

  await page.getByTestId("wide-panel").click();
  await expect(page.getByTestId("panel")).toBeVisible();
  const narrow = await waitForSharedHeightChange(page, wide, "greater");
  await settleLayout(page);
  await expectNoOverlap(page);

  await page.getByTestId("medium-panel").click();
  await expect(page.getByTestId("panel")).toHaveAttribute("data-width", "460");
  await waitForSharedHeightChange(page, narrow, "less");
  await settleLayout(page);
  await expectNoOverlap(page);

  const beforeStream = await rowGeometry(page);
  await page.getByTestId("stream").click();
  const afterStream = await waitForSharedHeightChange(page, beforeStream, "greater");
  await settleLayout(page);
  await expectNoOverlap(page);
  const mediumHeights = geometryByKey(afterStream);

  await page.getByTestId("close-panel").click();
  await expect(page.getByTestId("panel")).toHaveCount(0);
  await expect.poll(async () => {
    const now = geometryByKey(await rowGeometry(page));
    const shared = [...mediumHeights].filter(([key]) => now.has(key));
    return shared.length > 3
      && shared.every(([key, height]) => now.get(key)! <= height + 0.5)
      && shared.some(([key, height]) => now.get(key)! < height - 0.5);
  }).toBe(true);
  await settleLayout(page);
  await expectNoOverlap(page);
});

test("semantic reveal opens collapsed ancestors, yields to the reader, and can be repeated", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1&reveal=1");
  const reader = page.getByTestId("reader");
  const target = page.locator("[data-virtual-key='item:agent_message:103']");
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect(target).toHaveCount(0);

  await page.getByTestId("reveal-deep-event").click();
  await expect(reader).toHaveAttribute("data-follow-tail-state", "previewing");
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute("data-virtual-target", "true");
  await expect(target).toHaveAttribute("aria-current", "location");
  await expect.poll(async () => target.evaluate((row) => row === document.activeElement)).toBe(true);
  await expect(page.locator(".tl-work .disclosure-trigger")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".tl-agent-toggle")).toHaveCount(2);
  for (const disclosure of await page.locator(".tl-agent-toggle").all()) {
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  }

  const innerDisclosure = page.locator(".tl-agent-toggle").last();
  await innerDisclosure.click();
  await expect(innerDisclosure).toHaveAttribute("aria-expanded", "false");
  await settleLayout(page, 4);
  await expect(innerDisclosure).toHaveAttribute("aria-expanded", "false");
  await expect(target).toHaveCount(0);
  await page.getByTestId("reveal-deep-event").click();
  await expect(target).toBeVisible();

  const ticks = Number(await reader.getAttribute("data-tail-stream-ticks"));
  await page.getByTestId("stream-tail").click();
  await expect(reader).toHaveAttribute("data-tail-stream-ticks", String(ticks + 1));
  await expect.poll(() => rowIsVisible(page, "item:agent_message:103")).toBe(true);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "previewing");

  await reader.dispatchEvent("pointerdown", { pointerType: "mouse", buttons: 1 });
  await reader.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await settleLayout(page, 12);
  await expect.poll(() => rowIsVisible(page, "item:agent_message:103")).toBe(false);
  await expect(target).toHaveCount(0);

  await page.getByTestId("reveal-deep-event").click();
  await expect.poll(() => rowIsVisible(page, "item:agent_message:103")).toBe(true);
  await expect(target).toHaveAttribute("aria-current", "location");
});

test("a completed semantic reveal cannot leak across a history epoch", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1&reveal=1");
  const target = page.locator("[data-virtual-key='item:agent_message:103']");
  await page.getByTestId("reveal-deep-event").click();
  await expect(target).toBeVisible();
  await expect.poll(async () => target.evaluate((row) => row === document.activeElement)).toBe(true);

  const remount = page.getByTestId("remount");
  await remount.click();
  await expect(target).toHaveCount(0);
  await expect(page.locator("[aria-current='location']")).toHaveCount(0);
  await expect(page.locator(".tl-work .disclosure-trigger")).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => remount.evaluate((button) => button === document.activeElement)).toBe(true);
});

test("an unresolved semantic reveal reports failure and restores live following", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1&reveal=1");
  const reader = page.getByTestId("reader");
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await page.getByTestId("reveal-missing-event").click();
  await expect(page.getByTestId("reveal-outcome")).toHaveText(/unresolved/);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect(page.locator("[aria-current='location']")).toHaveCount(0);
});

test("reader input cancels an in-flight reveal and reports a terminal outcome", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1&reveal=1");
  await page.getByTestId("cancel-reveal").click();
  await expect(page.getByTestId("reveal-outcome")).toHaveText(/cancelled/);
});

test("timeline width reflow preserves the logical reading anchor", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html");
  const reader = page.getByTestId("reader");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  const metrics = await reader.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  await settleLayout(page);
  await reader.evaluate((element) => {
    element.scrollTop = 1_800;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(async () => (await visibleAnchor(page))?.key).not.toBe("item:agent_message:1");
  const before = await stableAnchor(page);
  await expect(reader).toHaveAttribute("data-anchor-key", before.key!);
  const beforeOpenGeometry = await rowGeometry(page);

  await page.getByTestId("wide-panel").click();
  await expect(page.getByTestId("panel")).toBeVisible();
  const openGeometry = await waitForSharedHeightChange(page, beforeOpenGeometry, "greater");
  const afterOpen = await stableAnchor(page);
  expect(afterOpen.key).toBe(before.key);
  expect(Math.abs(afterOpen.offset - before.offset)).toBeLessThan(1);
  await expectNoOverlap(page);

  await page.getByTestId("close-panel").click();
  await expect(page.getByTestId("panel")).toHaveCount(0);
  await waitForSharedHeightChange(page, openGeometry, "less");
  const afterClose = await stableAnchor(page);
  expect(afterClose.key).toBe(before.key);
  expect(Math.abs(afterClose.offset - before.offset)).toBeLessThan(1);
  await expectNoOverlap(page);
});

test("no-panel scrolling does not drift when newly revealed rows measure below the viewport", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html");
  const reader = page.getByTestId("reader");
  await expect(page.getByTestId("panel")).toHaveCount(0);
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await settleLayout(page);
  const initial = await stableAnchor(page);

  const requested = await reader.evaluate((element) => {
    const next = Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + 2_600);
    element.scrollTop = next;
    element.dispatchEvent(new Event("scroll"));
    return element.scrollTop;
  });
  expect(requested).toBeGreaterThan(1_000);
  const after = await stableAnchor(page);
  const settledTop = await reader.evaluate((element) => element.scrollTop);

  expect(after.key).not.toBe(initial.key);
  expect(Math.abs(settledTop - requested)).toBeLessThan(1);
  await expectNoOverlap(page);
});

test("deferred measurement commits expose overlapping wrapped rows during continuous resizing", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?offset=1&defer=1");
  const { sampled } = await recordContinuousResize(page);

  expect(sampled.frames).toBeGreaterThan(8);
  expect(sampled.observedWidths.length).toBeGreaterThanOrEqual(5);
  expect(sampled.observedPrefixHeights.length).toBeGreaterThanOrEqual(5);
  expect(sampled.overlapFrames, "the fault-injected asynchronous commit must prove the guard can fail")
    .toBeGreaterThan(0);
});

test("continuous panel resizing keeps long wrapped rows disjoint in every painted frame @production", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?offset=1");
  const { before, sampled } = await recordContinuousResize(page);

  expect(sampled.frames).toBeGreaterThan(8);
  expect(sampled.observedWidths.length).toBeGreaterThanOrEqual(5);
  expect(sampled.observedPrefixHeights.length).toBeGreaterThanOrEqual(5);
  expect(sampled.overlapFrames, JSON.stringify(sampled.overlapExamples)).toBe(0);
  expect(sampled.missingAnchorFrames).toBe(0);
  expect(sampled.anchorSamples).toBe(sampled.frames);
  // MeasuredVirtualList is the only scroll-anchor owner. A whole-line transient used to be
  // tolerated here because Chromium's native anchoring could also change scrollTop while wrapped
  // rows reflowed. The scroll owner now opts out of native anchoring, so every painted sample must
  // preserve the same logical offset; the settled assertions below retain exact final coverage.
  expect(sampled.maxAnchorDrift, JSON.stringify(sampled.anchorDriftExamples)).toBeLessThan(1);
  await expect(page.getByTestId("panel")).toHaveAttribute("data-width", "460");
  await expectNoOverlap(page);
  const after = await stableAnchor(page);
  expect(after.key).toBe(before.key);
  expect(Math.abs(after.offset - before.offset)).toBeLessThan(1);
});

test("a height-only notice change keeps the anchored row top stable in every painted frame", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?offset=1");
  const { before, initial, recorded } = await recordNoticeChanges(
    page,
    () => page.getByTestId("toggle-notice-height").click(),
  );

  expect(recorded.frames).toBeGreaterThan(4);
  expect(recorded.missingAnchorFrames).toBe(0);
  expect(recorded.samples.length).toBe(recorded.frames);
  expect(Math.max(...recorded.samples.map((sample) => sample.prefixHeight)))
    .toBeGreaterThan(initial.prefixHeight + 50);
  expect(Math.max(...recorded.samples.map((sample) => Math.abs(sample.readerWidth - initial.readerWidth))))
    .toBeLessThan(0.5);
  expect(Math.max(...recorded.samples.map((sample) => Math.abs(sample.drift)))).toBeLessThan(1);
  const after = await stableAnchor(page);
  expect(after.key).toBe(before.key);
  expect(Math.abs(after.offset - before.offset)).toBeLessThan(1);
});

test("deferring a margin-only notice commit exposes a painted anchor jump", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?offset=1&defer=1");
  const { initial, recorded } = await recordNoticeChanges(
    page,
    () => page.getByTestId("toggle-notice-height").click(),
  );

  expect(recorded.missingAnchorFrames).toBe(0);
  expect(recorded.samples.length).toBe(recorded.frames);
  expect(Math.max(...recorded.samples.map((sample) => sample.prefixHeight)))
    .toBeGreaterThan(initial.prefixHeight + 50);
  expect(Math.max(...recorded.samples.map((sample) => Math.abs(sample.drift))))
    .toBeGreaterThan(50);
});

async function expectNoticeRemountToPreserveAnchor(page: Page, url: string) {
  await page.goto(url);
  const { before, initial, recorded } = await recordNoticeChanges(page, async () => {
    await page.getByTestId("toggle-notice-mount").click();
    await expect(page.getByTestId("width-sensitive-prefix")).toHaveCount(0);
    await settleLayout(page, 6);
    await page.getByTestId("toggle-notice-mount").click();
    await expect(page.getByTestId("width-sensitive-prefix")).toBeVisible();
  });

  expect(recorded.missingAnchorFrames).toBe(0);
  expect(recorded.samples.length).toBe(recorded.frames);
  expect(Math.min(...recorded.samples.map((sample) => sample.prefixHeight))).toBe(0);
  expect(Math.max(...recorded.samples.map((sample) => sample.prefixHeight))).toBe(initial.prefixHeight);
  expect(Math.max(...recorded.samples.map((sample) => Math.abs(sample.drift)))).toBeLessThan(1);
  const after = await stableAnchor(page);
  expect(after.key).toBe(before.key);
  expect(Math.abs(after.offset - before.offset)).toBeLessThan(1);
}

test("mounting and unmounting a preceding notice preserves the anchor in every painted frame @production", async ({ page }) => {
  await expectNoticeRemountToPreserveAnchor(page, "/timeline-reflow-e2e.html?offset=1");
});

test("mounting and unmounting a preceding notice during a list rerender preserves the anchor in every painted frame @production", async ({ page }) => {
  await expectNoticeRemountToPreserveAnchor(
    page,
    "/timeline-reflow-e2e.html?offset=1&predecessor-rerender=1",
  );
});

test("paused upward traversal compensates old-width rows after a wide panel reflow", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1");
  const reader = page.getByTestId("reader");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);
  await page.getByTestId("pause-follow").click();
  await moveToStableReadingAnchor(page, 0.72);

  await page.getByTestId("wide-panel").click();
  await expect(page.getByTestId("panel")).toHaveAttribute("data-width", "540");
  await settleLayout(page, 16);
  let current = await visibleAnchor(page);
  expect(current).not.toBeNull();

  for (let step = 0; step < 6; step += 1) {
    const targetIndex = current!.index - 2;
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    const aligned = await alignIndexToViewport(page, targetIndex);
    expect(aligned.index).toBeLessThan(current!.index);
    await settleLayout(page, 8);
    const settled = await visibleAnchor(page);
    expect(settled?.key).toBe(aligned.key);
    expect(Math.abs(settled!.offset - aligned.offset)).toBeLessThan(1);
    current = settled;
  }
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
});

test("timeline remount restores a persisted logical row anchor", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1");
  const reader = page.getByTestId("reader");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);
  await page.getByTestId("pause-follow").click();
  const before = await moveToStableReadingAnchor(page, 0.45);
  expect(before).not.toBeNull();
  await expect(reader).toHaveAttribute("data-anchor-key", before!.key!);
  await page.getByTestId("remount").click();
  await settleLayout(page);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  await expect.poll(async () => (await visibleAnchor(page))?.key).toBe(before!.key);
  const restored = await visibleAnchor(page);
  expect(Math.abs(restored!.offset - before!.offset)).toBeLessThan(1);
});

test("returning to a narrowed session keeps untrusted rows unpainted and valid frames disjoint", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1&defer=1");
  const reader = page.getByTestId("reader");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await settleLayout(page);

  await page.getByTestId("pause-follow").click();
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  await reader.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await settleLayout(page);
  const alphaAnchor = await alignRowToViewport(page, "item:user_message:2");
  await expect(reader).toHaveAttribute("data-anchor-key", alphaAnchor.key!);

  await page.getByTestId("session-beta").click();
  await expect(reader).toHaveAttribute("data-session-id", "beta");
  await page.getByTestId("wide-panel").click();
  await expect(page.getByTestId("panel")).toHaveAttribute("data-width", "540");
  const streamTicks = Number(await reader.getAttribute("data-tail-stream-ticks"));
  await page.getByTestId("stream-tail").click();
  await expect(reader).toHaveAttribute("data-tail-stream-ticks", String(streamTicks + 1));
  await settleLayout(page);

  await startSessionReturnRecorder(page, "alpha");
  await page.getByTestId("session-alpha").click();
  await expect(reader).toHaveAttribute("data-session-id", "alpha");
  const sampled = await stopSessionReturnRecorder(page);

  expect(sampled.frames).toBeGreaterThan(8);
  expect(sampled.returnedSessionFrames).toBeGreaterThan(8);
  expect(sampled.untrustedFrames).toBeGreaterThan(0);
  expect(sampled.exposedUntrustedFrames, "estimate-backed geometry must remain unpainted").toBe(0);
  expect(sampled.semanticUntrustedFrames, "the busy semantic list must remain populated")
    .toBe(sampled.untrustedFrames);
  expect(sampled.untrustedScrollHeights).toHaveLength(1);
  expect(sampled.untrustedClientHeights).toHaveLength(1);
  expect(sampled.untrustedScrollHeights[0]!).toBeGreaterThan(sampled.untrustedClientHeights[0]!);
  expect(sampled.readyFrames).toBeGreaterThan(4);
  expect(sampled.busyReadyFrames).toBe(0);
  expect(sampled.maxReadyRows).toBeGreaterThan(1);
  expect(sampled.overlapFrames, JSON.stringify(sampled.overlapExamples)).toBe(0);
  await expectNoOverlap(page);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  await expect.poll(async () => (await visibleAnchor(page))?.key).toBe(alphaAnchor.key);
  const restored = await visibleAnchor(page);
  expect(Math.abs(restored!.offset - alphaAnchor.offset)).toBeLessThan(1);
});

test("width reflow and tail streaming honor following, paused, and previewing states", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1");
  const reader = page.getByTestId("reader");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);

  await page.getByTestId("medium-panel").click();
  await expect(page.getByTestId("panel")).toHaveAttribute("data-width", "460");
  await settleLayout(page);
  await dragPanelResizer(page);
  await settleLayout(page);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);

  await page.getByTestId("wide-panel").click();
  await expect(page.getByTestId("panel")).toHaveAttribute("data-width", "540");
  await settleLayout(page);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);
  await expectNoOverlap(page);

  const followingHeight = await reader.evaluate((element) => element.scrollHeight);
  await page.getByTestId("stream-tail").click();
  await expect.poll(async () => reader.evaluate((element) => element.scrollHeight)).toBeGreaterThan(followingHeight);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);

  await waitForStableReaderGeometry(page);
  await page.getByTestId("pause-follow").click();
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  const pausedAnchor = await moveToStableReadingAnchor(page);
  expect(pausedAnchor).not.toBeNull();

  await page.getByTestId("medium-panel").click();
  await expect(page.getByTestId("panel")).toHaveAttribute("data-width", "460");
  await expect.poll(() => rowIsVisible(page, pausedAnchor!.key!)).toBe(true);
  await expect.poll(() => distanceFromTail(page)).toBeGreaterThan(48);
  const pausedTicks = Number(await reader.getAttribute("data-tail-stream-ticks"));
  await page.getByTestId("stream-tail").click();
  await expect(reader).toHaveAttribute("data-tail-stream-ticks", String(pausedTicks + 1));
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  await expect.poll(() => rowIsVisible(page, pausedAnchor!.key!)).toBe(true);
  await expect.poll(() => distanceFromTail(page)).toBeGreaterThan(48);

  await page.getByTestId("preview-follow").click();
  await expect(reader).toHaveAttribute("data-follow-tail-state", "previewing");
  const previewCandidate = await visibleAnchor(page);
  expect(previewCandidate).not.toBeNull();
  const previewAnchor = await alignRowToViewport(page, previewCandidate!.key!);
  await page.getByTestId("close-panel").click();
  await expect(page.getByTestId("panel")).toHaveCount(0);
  await expect.poll(() => rowIsVisible(page, previewAnchor!.key!)).toBe(true);
  await expect.poll(() => distanceFromTail(page)).toBeGreaterThan(48);
  const previewTicks = Number(await reader.getAttribute("data-tail-stream-ticks"));
  await page.getByTestId("stream-tail").click();
  await expect(reader).toHaveAttribute("data-tail-stream-ticks", String(previewTicks + 1));
  await expect(reader).toHaveAttribute("data-follow-tail-state", "previewing");
  await expect.poll(() => rowIsVisible(page, previewAnchor!.key!)).toBe(true);
  await expect.poll(() => distanceFromTail(page)).toBeGreaterThan(48);
  await expectNoOverlap(page);

  await page.getByTestId("resume-follow").click();
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);
});

test("paused and previewing travel owns scroll during a concurrent stream settle", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1");
  const reader = page.getByTestId("reader");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);

  await page.getByTestId("pause-follow").click();
  await moveToStableReadingAnchor(page, 0.25);
  const pausedBefore = await reader.evaluate((element) => element.scrollTop);
  const pausedTicks = Number(await reader.getAttribute("data-tail-stream-ticks"));
  await page.getByTestId("stream-tail-scroll").click();
  await expect(reader).toHaveAttribute("data-tail-stream-ticks", String(pausedTicks + 1));
  await expect.poll(async () => reader.evaluate((element) => element.scrollTop)).toBeGreaterThan(pausedBefore + 150);
  await settleLayout(page);
  expect(await reader.evaluate((element) => element.scrollTop)).toBeGreaterThan(pausedBefore + 150);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");

  await page.getByTestId("preview-follow").click();
  await moveToStableReadingAnchor(page, 0.3);
  const previewMetrics = await reader.evaluate((element) => ({
    top: element.scrollTop,
    page: element.clientHeight,
    max: element.scrollHeight - element.clientHeight,
  }));
  const previewTicks = Number(await reader.getAttribute("data-tail-stream-ticks"));
  await page.getByTestId("stream-tail-smooth-page").click();
  await expect(reader).toHaveAttribute("data-tail-stream-ticks", String(previewTicks + 1));
  const expectedTravel = Math.min(previewMetrics.page, previewMetrics.max - previewMetrics.top);
  await expect.poll(async () => reader.evaluate((element) => element.scrollTop), { timeout: 5_000 })
    .toBeGreaterThan(previewMetrics.top + expectedTravel * 0.8);
  await settleLayout(page);
  expect(await reader.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(previewMetrics.top + expectedTravel * 0.8);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "previewing");
  await expect.poll(() => distanceFromTail(page)).toBeGreaterThan(48);
});

test("a late overscanned tail resize cannot move a paused logical anchor", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1");
  const reader = page.getByTestId("reader");
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);
  await page.getByTestId("pause-follow").click();
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");

  const anchor = await alignRowToViewport(page, "item:user_message:22");
  await settleLayout(page, 12);
  const settled = await visibleAnchor(page);
  expect(settled?.key).toBe(anchor.key);
  expect(Math.abs(settled!.offset - anchor.offset)).toBeLessThan(0.5);
  const tail = page.locator("[data-virtual-key='item:user_message:30']");
  await expect(tail).toHaveCount(1);
  await expect(tail).not.toBeInViewport();

  const beforeHeight = await reader.evaluate((element) => element.scrollHeight);
  await page.getByTestId("resize-tail-late").click();
  await expect.poll(async () => reader.evaluate((element) => element.scrollHeight)).toBeGreaterThan(beforeHeight);
  await settleLayout(page);
  const after = await visibleAnchor(page);
  expect(after?.key).toBe(settled!.key);
  expect(Math.abs(after!.offset - settled!.offset)).toBeLessThan(1);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
});

test("session anchors survive navigation and history prepend backfill", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1");
  const reader = page.getByTestId("reader");
  await expect(reader).toHaveAttribute("data-session-id", "alpha");
  await page.getByTestId("pause-follow").click();
  const alpha = await moveToStableReadingAnchor(page, 0.35);
  expect(alpha).not.toBeNull();

  await page.getByTestId("session-beta").click();
  await expect(reader).toHaveAttribute("data-session-id", "beta");
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);
  await page.getByTestId("pause-follow").click();
  const beta = await moveToStableReadingAnchor(page, 0.65);
  expect(beta).not.toBeNull();
  expect(beta!.key).not.toBe(alpha!.key);

  await page.getByTestId("prepend-alpha-history").click();
  await page.getByTestId("session-alpha").click();
  await expect(reader).toHaveAttribute("data-session-id", "alpha");
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  await expect.poll(async () => (await visibleAnchor(page))?.key).toBe(alpha!.key);
  await expect.poll(async () => Math.abs((await visibleAnchor(page))!.offset - alpha!.offset)).toBeLessThan(1);

  const alphaBeforeBackfill = await visibleAnchor(page);
  await page.getByTestId("prepend-history").click();
  await expect.poll(async () => (await visibleAnchor(page))?.key).toBe(alphaBeforeBackfill!.key);
  await expect.poll(async () => Math.abs((await visibleAnchor(page))!.offset - alphaBeforeBackfill!.offset)).toBeLessThan(1);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");

  await page.getByTestId("session-beta").click();
  await expect(reader).toHaveAttribute("data-session-id", "beta");
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  await expect.poll(async () => (await visibleAnchor(page))?.key).toBe(beta!.key);
  await expect.poll(async () => Math.abs((await visibleAnchor(page))!.offset - beta!.offset)).toBeLessThan(1);
});

test("a removed persisted anchor clamps to the nearest surviving ordinal", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1");
  const reader = page.getByTestId("reader");
  await page.getByTestId("pause-follow").click();
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  const saved = await moveToStableReadingAnchor(page, 0.4);
  expect(saved).not.toBeNull();

  await page.getByTestId("replace-history").click();
  await expect(page.locator(`[data-virtual-key='${saved!.key}']`)).toHaveCount(0);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  await expect.poll(async () => (await visibleAnchor(page))?.key).toBe("item:agent_message:1003");
  await expect.poll(() => distanceFromTail(page)).toBeGreaterThan(48);

  await page.getByTestId("session-beta").click();
  await expect(reader).toHaveAttribute("data-session-id", "beta");
  await page.getByTestId("session-alpha").click();
  await expect(reader).toHaveAttribute("data-session-id", "alpha");
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  await expect.poll(async () => (await visibleAnchor(page))?.key).toBe("item:agent_message:1003");
});

test("composer growth and shrink are layout-owned: following re-pins and a near-tail pause survives the clamp", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1");
  const reader = page.getByTestId("reader");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);

  // A wrapping draft grows the composer: the viewport shrinks and following stays pinned.
  await page.getByTestId("grow-composer").click();
  await settleLayout(page);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);

  // The reader pauses just above the tail, inside the delta the coming shrink will reclaim.
  await page.getByTestId("pause-follow").click();
  await reader.evaluate((element) => {
    element.scrollTop -= 40;
    element.dispatchEvent(new Event("scroll"));
  });
  await settleLayout(page, 6);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  const pausedDistance = await distanceFromTail(page);
  expect(pausedDistance).toBeGreaterThan(2);
  expect(pausedDistance).toBeLessThan(72);

  // Deleting the draft shrinks the composer: Chromium grows the viewport and clamps scrollTop
  // onto the new bottom with its native ResizeObserver/scroll delivery order. That landing is the
  // browser's, not the reader's — the pause must survive it.
  await page.getByTestId("shrink-composer").click();
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  await waitForStableReaderGeometry(page);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
});

test("a reader-driven return to a streaming tail resumes following", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?follow=1");
  const reader = page.getByTestId("reader");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);

  // A real upward wheel gesture pauses well above the tail.
  const box = await reader.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -600);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
  await expect.poll(() => distanceFromTail(page)).toBeGreaterThan(48);

  // A fresh chunk streams in, then the reader lands on the tail through a bare scrollBy — the
  // reading keys' scroll path, with no wheel or pointer event attached — while the new row's
  // measurements are still churning the geometry. The landing deviates from any layout
  // prediction, so it is reader-owned and must resume live following.
  await page.getByTestId("stream-tail").click();
  await reader.evaluate((element) => {
    element.scrollBy({ top: element.scrollHeight });
  });
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);
});

async function openFollowedTail(page: Page) {
  await installPaintedTailSampler(page);
  await page.goto("/timeline-reflow-e2e.html?follow=1");
  const reader = page.getByTestId("reader");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(1);
  await waitForStableReaderGeometry(page);
  return reader;
}

// The two ways a followed tail row grows. A long streamed row's top has scrolled above the
// viewport, so TanStack compensates scrollTop and re-renders synchronously inside its row observer;
// that render grows the list root after its notice was due, which is the late delivery #1996
// reports. A new reply's top stays inside the viewport, so TanStack leaves scrollTop alone and
// re-renders in a later task, and only the follow-tail observer can keep the grown tail in view.
const tailGrowthControls = [
  { control: "stream-tail", growth: "a long streamed row" },
  { control: "stream-live-reply", growth: "a new reply" },
] as const;

async function expectEveryPaintedFramePinned(page: Page, control: string) {
  const reader = await openFollowedTail(page);
  const before = await reader.evaluate((element) => element.scrollHeight);

  const sampled = await recordPaintedTailGrowth(page, control, 8);

  expect(sampled.growths).toBe(8);
  expect(await reader.evaluate((element) => element.scrollHeight)).toBeGreaterThan(before);
  expect(sampled.frames.length).toBeGreaterThan(30);
  expect(sampled.frames.every((frame) => frame.following)).toBe(true);
  const offTail = sampled.frames.flatMap((frame, index) => frame.distance > 1 ? [{ index, ...frame }] : []);
  expect(offTail, "painted frames off the followed tail").toEqual([]);
  await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
}

for (const { control, growth } of tailGrowthControls) {
  test(`following live output keeps every painted frame pinned while ${growth} grows`, async ({ page }) => {
    await expectEveryPaintedFramePinned(page, control);
  });
}

// The composer is geometry outside the virtual list that moves in step with the follow-tail
// re-pin. The reduced-motion guard once gave every element a 1ms transition on every property, so
// for that user the composer's height change painted a frame late and could lag the re-pin (#2574).
for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`a growing composer keeps every painted frame on the followed tail (${reducedMotion} motion)`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    const reader = await openFollowedTail(page);
    // The first growth mounts the composer; the later ones change its height.
    const sampled = await recordPaintedTailGrowth(page, "grow-composer", 4, 4);
    expect(sampled.growths).toBe(4);
    expect(await page.getByTestId("composer-spacer").evaluate((element) => element.getBoundingClientRect().height))
      .toBeCloseTo(4 * 72, 0);
    expect(sampled.frames.every((frame) => frame.following)).toBe(true);
    const offTail = sampled.frames.flatMap((frame, index) => frame.distance > 2 ? [{ index, ...frame }] : []);
    expect(offTail, "painted frames more than 2px off the followed tail").toEqual([]);
    await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  });
}

type DeepObserverFault = "grow-tail" | "chained-scroll";

/**
 * Injects one fault from inside the observer delivery of a sentinel nested deeper than any
 * transcript row, then returns the frames painted around it.
 *
 * - `grow-tail` grows the tail row during that delivery. The row is shallower than the sentinel, so
 *   Chromium defers every notice of the growth to the next frame and reports a loop error; neither
 *   TanStack nor the follow-tail observer can respond before the frame paints.
 * - `chained-scroll` moves the reader off its tail two microtask hops after the callback and puts it
 *   back in the next frame's animation callbacks, so only a sampler that follows microtask
 *   continuations sees the one frame painted in between.
 */
async function recordDeepObserverFault(page: Page, fault: DeepObserverFault) {
  return page.evaluate((kind) => new Promise<PaintedTailFrame[]>((resolve) => {
    const sampler = (window as PaintedTailHost).__paintedTailSampler!;
    const reader = document.querySelector<HTMLElement>("[data-testid='reader']")!;
    const tail = document.querySelector<HTMLElement>("[data-virtual-key='item:agent_message:400']")!;
    let sentinel: HTMLElement = document.body;
    for (let depth = 0; depth < 40; depth += 1) {
      const child = document.createElement("div");
      sentinel.append(child);
      sentinel = child;
    }
    sentinel.style.height = "1px";
    let armed = false;
    new ResizeObserver(() => {
      if (!armed) return;
      armed = false;
      if (kind === "grow-tail") {
        tail.style.paddingBottom = "160px";
        return;
      }
      queueMicrotask(() => queueMicrotask(() => {
        reader.scrollTop -= 24;
        requestAnimationFrame(() => {
          reader.scrollTop = reader.scrollHeight;
        });
      }));
    }).observe(sentinel);
    sampler.frames = [];
    sampler.latest = null;
    sampler.active = true;
    let frame = 0;
    const tick = () => {
      frame += 1;
      if (frame === 2) {
        setTimeout(() => {
          armed = true;
          sentinel.style.height = "2px";
        }, 0);
      }
      if (frame < 24) {
        requestAnimationFrame(tick);
        return;
      }
      sampler.active = false;
      resolve(sampler.frames);
    };
    requestAnimationFrame(tick);
  }), fault);
}

test.describe("the painted-frame checks can fail", () => {
  // These negative controls deliberately paint a following reader off its tail, which the
  // loop-error guard exists to reject; they assert the guard's record themselves instead.
  test.use({ resizeObserverLoopGuard: false });

  async function openLiveReply(page: Page) {
    const reader = await openFollowedTail(page);
    await page.getByTestId("stream-live-reply").click();
    await expect(page.locator("[data-virtual-key='item:agent_message:400']")).toHaveCount(1);
    await waitForStableReaderGeometry(page);
    await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(1);
    return reader;
  }

  test("a scroll queued behind an observer callback's microtasks is still sampled as painted", async ({ page }) => {
    await openLiveReply(page);

    const sampled = await recordDeepObserverFault(page, "chained-scroll");

    expect(sampled.every((frame) => frame.following)).toBe(true);
    expect(sampled.filter((frame) => frame.distance > 1).length, "the sampler must see the unpinned paint")
      .toBe(1);
    await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(1);
  });

  test("a tail notice left for the next frame paints off the tail, and the sampler and loop-error guard report it", async ({ page }) => {
    const reader = await openLiveReply(page);

    const sampled = await recordDeepObserverFault(page, "grow-tail");

    expect(sampled.every((frame) => frame.following)).toBe(true);
    expect(sampled.filter((frame) => frame.distance > 1).length, "the sampler must see the unpinned paint")
      .toBeGreaterThan(0);
    const loopErrors = await page.evaluate(() => (window as LoopErrorHost).__resizeObserverLoopErrors ?? []);
    expect(
      loopErrors.filter((error) => error.followTailState === "following" && error.distanceFromTail > 1).length,
      "the loop-error guard must see the unpinned paint",
    ).toBeGreaterThan(0);
    await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(1);
    await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
  });
});

test("streamed growth above later rows keeps every painted frame disjoint", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await settleLayout(page);
  const before = await rowGeometry(page);

  await startStreamedGrowthRecorder(page);
  await streamChunks(page, "stream", 8);
  await waitForSharedHeightChange(page, before, "greater");
  const sampled = await stopStreamedGrowthRecorder(page);

  expect(sampled.frames).toBeGreaterThan(12);
  expect(sampled.overlapFrames, JSON.stringify(sampled.overlapExamples)).toBe(0);
  expect(sampled.alternationFrames).toBe(0);
  await expectNoOverlap(page);
});

test("deferred measurement commits expose overlapping frames during streamed growth", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?defer=1");
  await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
  await settleLayout(page);

  await startStreamedGrowthRecorder(page);
  await streamChunks(page, "stream", 8);
  const sampled = await stopStreamedGrowthRecorder(page);

  expect(sampled.frames).toBeGreaterThan(12);
  expect(sampled.overlapFrames, "the fault-injected deferred commit must prove the sampler can fail")
    .toBeGreaterThan(0);
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("session return and settling live output keep painted frames disjoint on a touch phone", async ({ page }) => {
    await page.goto("/timeline-reflow-e2e.html?follow=1");
    const reader = page.getByTestId("reader");
    await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
    await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
    await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);
    await settleLayout(page);

    // A touch reader pauses near the transcript head so a saved logical anchor exists for the
    // return and the streamed head row stays mounted with later rows below it — the geometry the
    // reported flashing needs.
    await page.getByTestId("pause-follow").tap();
    await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
    const anchor = await moveToStableReadingAnchor(page, 0.04);
    expect(anchor).not.toBeNull();

    // Another session streams while this one is away.
    await page.getByTestId("session-beta").tap();
    await expect(reader).toHaveAttribute("data-session-id", "beta");
    const ticks = Number(await reader.getAttribute("data-tail-stream-ticks"));
    await page.getByTestId("stream-tail").tap();
    await expect(reader).toHaveAttribute("data-tail-stream-ticks", String(ticks + 1));
    await settleLayout(page);

    // Return, then let fresh output settle while sampling every painted frame.
    await startStreamedGrowthRecorder(page);
    await page.getByTestId("session-alpha").tap();
    await expect(reader).toHaveAttribute("data-session-id", "alpha");
    await streamChunks(page, "stream", 4);
    await streamChunks(page, "stream-tail", 2);
    // Browser-chrome geometry change: mobile URL bars resize the layout viewport mid-read.
    await page.setViewportSize({ width: 390, height: 780 });
    await settleLayout(page, 6);
    await page.setViewportSize({ width: 390, height: 844 });
    const sampled = await stopStreamedGrowthRecorder(page);

    expect(sampled.frames).toBeGreaterThan(20);
    expect(sampled.overlapFrames, JSON.stringify(sampled.overlapExamples)).toBe(0);
    expect(sampled.alternationFrames).toBe(0);
    await expectNoOverlap(page);
    await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
    await expect.poll(async () => (await visibleAnchor(page))?.key).toBe(anchor!.key);
    expect(Math.abs((await visibleAnchor(page))!.offset - anchor!.offset)).toBeLessThan(1);
  });

  test.describe("iOS user agent", () => {
    // TanStack detects iOS WebKit from the user agent and then defers its scroll compensation while
    // a touch is active or the viewport is scrolling, as the restore's own scroll write marks it.
    test.use({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    });

    for (const touch of ["a held touch", "no touch"] as const) {
      test(`session return with ${touch} keeps the saved row in place on iOS`, async ({ page }) => {
        await page.goto("/timeline-reflow-e2e.html?follow=1");
        const reader = page.getByTestId("reader");
        await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
        await settleLayout(page);
        await page.getByTestId("pause-follow").tap();
        await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
        const anchor = await moveToStableReadingAnchor(page, 0.6);
        await page.getByTestId("session-beta").tap();
        await expect(reader).toHaveAttribute("data-session-id", "beta");
        await settleLayout(page);

        const savedRowOffset = () => reader.evaluate((element, key) => {
          const row = [...element.querySelectorAll<HTMLElement>("[data-virtual-row]")]
            .find((candidate) => candidate.dataset.virtualKey === key);
          return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
        }, anchor.key);
        const client = await page.context().newCDPSession(page);
        const box = (await reader.boundingBox())!;
        if (touch === "a held touch") {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }],
          });
        }
        // Switch without a tap, which would end the held touch.
        await page.getByTestId("session-alpha").evaluate((button) => (button as HTMLButtonElement).click());
        await expect(reader).toHaveAttribute("data-session-id", "alpha");
        // Outlast the restore window and TanStack's scroll-idle debounce.
        await settleLayout(page, 40);
        await page.waitForTimeout(500);
        expect(Math.abs((await savedRowOffset())! - anchor.offset)).toBeLessThan(1);
        if (touch === "a held touch") {
          await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await settleLayout(page, 40);
          await page.waitForTimeout(500);
          expect(Math.abs((await savedRowOffset())! - anchor.offset)).toBeLessThan(1);
        }
        await expectNoOverlap(page);
      });
    }
  });

  test("following live tail growth on a touch phone never paints overlapping rows", async ({ page }) => {
    await page.goto("/timeline-reflow-e2e.html?follow=1");
    const reader = page.getByTestId("reader");
    await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
    await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
    await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);
    await settleLayout(page);

    await startStreamedGrowthRecorder(page);
    await streamChunks(page, "stream-tail", 6);
    const sampled = await stopStreamedGrowthRecorder(page);

    expect(sampled.frames).toBeGreaterThan(12);
    expect(sampled.overlapFrames, JSON.stringify(sampled.overlapExamples)).toBe(0);
    expect(sampled.alternationFrames).toBe(0);
    await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
    await expect.poll(() => distanceFromTail(page)).toBeLessThanOrEqual(2);
  });

  for (const { control, growth } of tailGrowthControls) {
    test(`following live output on a touch phone keeps every painted frame pinned while ${growth} grows`, async ({ page }) => {
      await expectEveryPaintedFramePinned(page, control);
    });
  }
});
