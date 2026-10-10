import { expect, test, type Locator, type Page } from "@playwright/test";
import { waitForSessionPreview } from "./session-readiness.js";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * A measured length in Chromium's layout unit (1/64px). A box under a transform is measured in
 * float32, so a 44px control can read 43.99997 (44 - 2^-15): the same 44px of layout, not a shorter
 * control. Rounding to the unit layout itself uses absorbs that and nothing larger, so a real
 * 43.9px control still reads below 44.
 */
function layoutPx(value: number): number {
  return Math.round(value * 64) / 64;
}

test("measured heights are compared in layout units, never forgiving a short control", () => {
  expect(layoutPx(43.999969482421875), "float32 noise on a 44px box").toBe(44);
  expect(layoutPx(44.00003), "and above it").toBe(44);
  expect(layoutPx(43.9), "a genuinely short control").toBeLessThan(44);
  expect(layoutPx(43.99)).toBeLessThan(44);
});

async function controlGeometry(control: Locator) {
  const geometry = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      height: rect.height,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      paddingTop: Number.parseFloat(style.paddingTop),
      paddingBottom: Number.parseFloat(style.paddingBottom),
    };
  });
  return { ...geometry, height: layoutPx(geometry.height) };
}

/** Selects a group: its tab, or on a phone the app bar's group picker (#2211). */
async function chooseGroup(page: Page, name: RegExp) {
  const bar = page.locator(".sessions-app-bar");
  if (await bar.count() > 0) {
    await bar.locator(".sessions-group-picker").click();
    await page.getByRole("menu", { name: "Session Groups" }).getByRole("menuitemradio", { name }).click();
    return;
  }
  await page.getByRole("tab", { name }).click();
}

async function openProjectManager(page: Page, projectName = "Alpha") {
  const tab = page.getByRole("tab", { name: new RegExp(projectName) });
  const trigger = page.getByRole("button", { name: `${projectName} Actions` });
  await tab.hover();
  // Without hover only the active Project tab shows its actions (#2180), so select it first.
  if (!await trigger.isVisible()) await tab.click();
  await trigger.click();
  await page.getByRole("menuitem", { name: /Manage Project/ }).click();
}

async function chooseNewSessionProject(dialog: Locator, query: string, optionText: string | RegExp = query) {
  const input = dialog.getByRole("combobox", { name: "Project" });
  await input.fill(query);
  const option = dialog.getByRole("listbox", { name: "Project Options" })
    .getByRole("option")
    .filter({ hasText: optionText });
  await expect(option).toHaveCount(1);
  await option.click();
}

async function previewScrollMetrics(page: Page) {
  return page.getByRole("region", { name: "Session Preview Activity" }).evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    distanceFromTail: element.scrollHeight - element.scrollTop - element.clientHeight,
  }));
}

async function previewVisibleAnchor(page: Page) {
  return page.getByRole("region", { name: "Session Preview Activity" }).evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-virtual-row]")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    return row?.dataset.virtualKey
      ? { key: row.dataset.virtualKey, offset: row.getBoundingClientRect().top - viewport.top }
      : null;
  });
}

type RowOffsetSample = { key: string; offset: number | null };

/**
 * Runs `action` and follows one row of the reader through every painted frame (#2426). Without
 * `key`, it waits for the reader to scroll (a page lands in the press's own task) and follows the
 * row then at the top; with `key`, it follows that row from the first frame. Recording ends
 * `durationMs` after it starts or, with `untilRowsGrow`, `durationMs` after the list gains a row.
 * Samples are read only inside the browser's rendering step, never in a task between frames: a
 * read there forces a style recalculation that would start a short transition early and hide the
 * very frame under test. Each frame is read once in a rAF callback, and again in a ResizeObserver
 * callback — every frame, and whenever the list, its rows or the reader resize — created after the
 * list's own observers, so it reads the geometry their corrections leave for the paint. A row that
 * moves for a single painted frame and moves back still shows.
 */
async function recordRowOffsets(
  page: Page,
  reader: Locator,
  action: () => Promise<unknown>,
  { key, untilRowsGrow = false, durationMs = 300 }: { key?: string; untilRowsGrow?: boolean; durationMs?: number } = {},
) {
  await reader.evaluate((element, options) => {
    const scrollTop = element.scrollTop;
    const rowCount = () => Number(element.querySelector<HTMLElement>("[data-virtual-total]")?.dataset.virtualTotal ?? 0);
    const initialRowCount = rowCount();
    const rows = () => [...element.querySelectorAll<HTMLElement>("[data-virtual-row]")];
    const samples: Array<{ key: string; offset: number | null }> = [];
    const probe = window as typeof window & {
      __rowOffsets?: Promise<{ samples: typeof samples; completed: boolean }>;
    };
    probe.__rowOffsets = new Promise((resolve) => {
      const startedAt = performance.now();
      let trackedKey: string | null = options.key ?? null;
      let windowStart: number | null = trackedKey != null && !options.untilRowsGrow ? startedAt : null;
      let done = false;
      const observed = new Set<Element>();
      const resized = new ResizeObserver(() => sample());
      // A box of the recorder's own, resized every frame, so its observer reports in every frame's
      // first delivery — after the callbacks of every observer created before it.
      const tick = document.createElement("div");
      tick.style.cssText = "position: fixed; top: 0; left: 0; height: 0; width: 1px; visibility: hidden;";
      document.body.append(tick);
      const observe = () => {
        for (const target of [tick, element, element.querySelector("[data-virtual-total]"), ...rows()]) {
          if (target && !observed.has(target)) {
            observed.add(target);
            resized.observe(target);
          }
        }
      };
      const finish = (completed: boolean) => {
        done = true;
        resized.disconnect();
        tick.remove();
        resolve({ samples, completed });
      };
      const sample = () => {
        if (done) return;
        const now = performance.now();
        const viewport = element.getBoundingClientRect();
        if (trackedKey == null && Math.abs(element.scrollTop - scrollTop) >= 1) {
          trackedKey = rows().find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
          })?.dataset.virtualKey ?? null;
          if (!options.untilRowsGrow) windowStart = now;
        }
        if (options.untilRowsGrow && windowStart == null && rowCount() > initialRowCount) windowStart = now;
        if (trackedKey != null) {
          const row = rows().find((candidate) => candidate.dataset.virtualKey === trackedKey);
          samples.push({ key: trackedKey, offset: row ? row.getBoundingClientRect().top - viewport.top : null });
        }
        observe();
      };
      const frame = () => {
        sample();
        tick.style.width = tick.style.width === "1px" ? "2px" : "1px";
        const now = performance.now();
        if (windowStart != null && now - windowStart >= options.durationMs) finish(true);
        else if (now - startedAt >= 5_000) finish(false);
        else requestAnimationFrame(frame);
      };
      observe();
      requestAnimationFrame(frame);
    });
  }, { key, untilRowsGrow, durationMs });
  await action();
  const recorded = await page.evaluate(() =>
    (window as typeof window & { __rowOffsets?: Promise<{ samples: RowOffsetSample[]; completed: boolean }> })
      .__rowOffsets!);
  expect(recorded.completed, "the recorder saw the reader move or the list grow").toBe(true);
  return recorded.samples;
}

/** The largest distance the followed row moved from where it was in the first recorded frame. */
function rowDrift(samples: RowOffsetSample[]): number {
  expect(samples.length).toBeGreaterThan(2);
  const [first] = samples;
  expect(first!.offset).not.toBeNull();
  return Math.max(...samples.map((sample) => sample.offset == null ? Infinity : Math.abs(sample.offset - first!.offset!)));
}

function expectRowStill(samples: RowOffsetSample[]) {
  expect(rowDrift(samples), JSON.stringify(samples)).toBeLessThanOrEqual(2);
}

async function settlePreviewLayout(page: Page, frames = 12) {
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

async function inboxViewportAnchor(page: Page) {
  return page.locator(".inbox-list").evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-virtual-row]")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    return {
      scrollTop: element.scrollTop,
      key: row?.dataset.virtualKey ?? null,
      offset: row ? row.getBoundingClientRect().top - viewport.top : null,
    };
  });
}

async function settledPreviewScrollMetrics(page: Page) {
  const reader = page.getByRole("region", { name: "Session Preview Activity" });
  await expect.poll(async () => {
    const samples = await reader.evaluate((element) => new Promise<Array<[number, number]>>((resolve) => {
      const measurements: Array<[number, number]> = [];
      const sample = () => {
        measurements.push([element.clientHeight, element.scrollHeight]);
        if (measurements.length === 3) resolve(measurements);
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    const [[clientHeight, scrollHeight], ...rest] = samples;
    return clientHeight >= 100 && scrollHeight > clientHeight &&
      rest.every(([nextClientHeight, nextScrollHeight]) =>
        nextClientHeight === clientHeight && nextScrollHeight === scrollHeight);
  }).toBe(true);
  return previewScrollMetrics(page);
}

async function pausePreviewAt(page: Page, ratio: number) {
  const reader = page.getByRole("region", { name: "Session Preview Activity" });
  await reader.evaluate((element, position) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    element.scrollTop = (element.scrollHeight - element.clientHeight) * position;
    element.dispatchEvent(new Event("scroll"));
  }, ratio);
  await expect(page.locator(".detail-scroll[data-follow-tail-state]")).toHaveAttribute("data-follow-tail-state", "paused");
  await settlePreviewLayout(page);
  const anchor = await previewVisibleAnchor(page);
  expect(anchor).not.toBeNull();
  return anchor!;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/command-inbox-projects-e2e.html");
  await expect(page.getByRole("tab", { name: /Alpha/ })).toBeVisible();
});

const composerQuestion = {
  requestId: "ask-from-sessions",
  title: "Choose a target",
  options: [],
  kind: "question" as const,
  questions: [{
    id: "target",
    question: "Choose a target",
    options: [{ label: "Staging" }, { label: "Production" }],
  }],
};

async function openComposerResponseFixture(page: Page) {
  await page.evaluate(() => localStorage.setItem("wollipog.question-response-style", "composer"));
  await page.goto("/command-inbox-projects-e2e.html?fullShell=1");
  await expect(page.getByRole("tab", { name: /Alpha/ })).toBeVisible();
}

/** The Sessions preview shows a question with Answer in Session, not its answer form (#2210). */
function previewQuestion(page: Page) {
  return page.locator('.session-detail.preview .request-card[data-presentation="preview"] .request-card-title');
}

async function focusZoneWithKeyboard(page: Page, zone: "list" | "main") {
  const presses = zone === "list" ? 2 : 3;
  for (let index = 0; index < presses; index += 1) await page.keyboard.press("F6");
  await expect.poll(() => page.evaluate(() =>
    document.activeElement?.closest<HTMLElement>("[data-focus-zone]")?.dataset.focusZone ?? null))
    .toBe(zone);
}

test("one R from the Sessions list focuses an already-active Composer Response before the next digit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openComposerResponseFixture(page);
  await page.evaluate((pendingApproval) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      status: "input_required",
      pendingApproval,
    });
  }, composerQuestion);
  await expect(previewQuestion(page)).toHaveText("Choose a target");

  await focusZoneWithKeyboard(page, "list");
  await page.keyboard.press("r");
  await page.keyboard.press("1");

  const response = page.locator(".composer-answer-input");
  await expect(page.getByRole("region", { name: "Session Activity" })).toBeVisible();
  await expect(response).toBeFocused();
  await expect(response).toHaveValue("1");
});

test("offline Composer Response owns the immediate digit after R from the Sessions list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openComposerResponseFixture(page);
  await page.evaluate((pendingApproval) => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.updateSession("session-alpha", {
      status: "input_required",
      pendingApproval,
    });
    fixture.setRunnerStatus("offline");
  }, composerQuestion);
  await expect(previewQuestion(page)).toHaveText("Choose a target");

  await focusZoneWithKeyboard(page, "list");
  await page.keyboard.press("r");
  await page.keyboard.press("1");

  const response = page.locator(".composer-answer-input");
  await expect(page.getByRole("region", { name: "Session Activity" })).toBeVisible();
  await expect(response).toBeFocused();
  await expect(response).toHaveAttribute("aria-disabled", "true");
  await expect(response).toHaveAttribute("readonly", "");
  await expect(response).toHaveValue("");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("online"));
  await expect(response).not.toHaveAttribute("aria-disabled", "true");
  await expect(response).not.toHaveAttribute("readonly", "");
  await page.keyboard.press("1");
  await expect(response).toHaveValue("1");
});

test("one R from the split preview enters Composer Response without losing the ordinary draft", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openComposerResponseFixture(page);

  // Build the ordinary draft through the real keyboard path, then return to the split view.
  await focusZoneWithKeyboard(page, "list");
  await page.keyboard.press("r");
  const composer = page.locator(".composer-input");
  await expect(composer).toBeFocused();
  await composer.pressSequentially("preserved draft");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Session Preview Activity" })).toBeVisible();

  await page.evaluate((pendingApproval) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      status: "input_required",
      pendingApproval,
    });
  }, composerQuestion);
  await expect(previewQuestion(page)).toHaveText("Choose a target");

  await page.keyboard.press("F6");
  await expect.poll(() => page.evaluate(() =>
    document.activeElement?.closest<HTMLElement>("[data-focus-zone]")?.dataset.focusZone ?? null))
    .toBe("main");
  await page.keyboard.press("r");
  await page.keyboard.press("1");

  const response = page.locator(".composer-answer-input");
  await expect(response).toBeFocused();
  await expect(response).toHaveValue("1");
  await page.keyboard.press("Escape");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("preserved draft");
});

test("offline Composer Response owns the immediate digit after R from the split preview", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openComposerResponseFixture(page);

  await focusZoneWithKeyboard(page, "list");
  await page.keyboard.press("r");
  const composer = page.locator(".composer-input");
  await expect(composer).toBeFocused();
  await composer.pressSequentially("offline preserved draft");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Session Preview Activity" })).toBeVisible();

  await page.evaluate((pendingApproval) => {
    const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
    fixture.updateSession("session-alpha", {
      status: "input_required",
      pendingApproval,
    });
    fixture.setRunnerStatus("offline");
  }, composerQuestion);
  await expect(previewQuestion(page)).toHaveText("Choose a target");

  await page.keyboard.press("F6");
  await expect.poll(() => page.evaluate(() =>
    document.activeElement?.closest<HTMLElement>("[data-focus-zone]")?.dataset.focusZone ?? null))
    .toBe("main");
  await page.keyboard.press("r");
  await page.keyboard.press("1");

  const response = page.locator(".composer-answer-input");
  await expect(page.getByRole("region", { name: "Session Activity" })).toBeVisible();
  await expect(response).toBeFocused();
  await expect(response).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(page.locator(".composer-answer")).toHaveCount(0);
  await expect(composer).toHaveValue("offline preserved draft");
});

for (const viewport of [
  { name: "mobile", width: 390, height: 720 },
  { name: "desktop", width: 1280, height: 760 },
] as const) {
  test(`live Inbox row changes preserve the ${viewport.name} virtual viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/command-inbox-projects-e2e.html?scenario=inbox-live-scroll");
    const list = page.locator(".inbox-list");
    await expect(list.locator("[data-virtual-total='36']")).toBeVisible();
    await expect.poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    const initialTitles = await list.locator(".inbox-row-title").allTextContents();
    const atTop = await inboxViewportAnchor(page);
    expect(atTop.scrollTop).toBe(0);

    await page.evaluate(() => {
      const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
      fixture.updateSession("session-overflow-1", {
        lastEventAt: 1_000,
        preview: "Approval and concurrent activity changed this live row.",
        status: "input_required",
        pendingApproval: { requestId: "approval", title: "Review", options: [], kind: "question" },
      });
      fixture.updateSession("session-overflow-0", {
        lastEventAt: 1_001,
        preview: "A running activity strip changed without navigation.",
        status: "running",
      });
    });
    await settlePreviewLayout(page);
    const afterTop = await inboxViewportAnchor(page);
    expect(afterTop.scrollTop).toBe(0);
    expect(afterTop.key).toBe(atTop.key);
    expect(Math.abs((afterTop.offset ?? 0) - (atTop.offset ?? 0))).toBeLessThan(2);
    // Adding a request disclosure grows the row and legitimately shrinks the overscan set.
    // Pin the anchor and ordering, not the number of mounted offscreen rows.
    const afterTitles = await list.locator(".inbox-row-title").allTextContents();
    expect(afterTitles.length).toBeGreaterThan(1);
    expect(afterTitles).toEqual(initialTitles.slice(0, afterTitles.length));

    await list.evaluate((element) => {
      element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) * 0.55);
      element.dispatchEvent(new Event("scroll"));
    });
    await settlePreviewLayout(page);
    const scrolled = await inboxViewportAnchor(page);
    expect(scrolled.key).not.toBeNull();

    await page.evaluate(() => {
      const fixture = window.__WOLLIPOG_PROJECT_INBOX_E2E__;
      fixture.updateSession("session-overflow-2", {
        lastEventAt: 1_002,
        preview: "Unread output and activity updated above the viewport.",
        status: "running",
      });
      fixture.updateSession("session-overflow-3", {
        lastEventAt: 1_003,
        preview: "Another concurrent update exerted recency pressure.",
        status: "idle",
      });
    });
    await settlePreviewLayout(page);
    const after = await inboxViewportAnchor(page);
    expect(after.key).toBe(scrolled.key);
    expect(Math.abs((after.offset ?? 0) - (scrolled.offset ?? 0))).toBeLessThan(2);
  });
}

test("desktop can apply a pending Inbox order without losing selection or scroll anchor", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=inbox-live-scroll&reminders=1");
  const list = page.locator(".inbox-list");
  await expect(list.locator("[data-virtual-total='36']")).toBeVisible();
  await expect.poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  await list.evaluate((element) => {
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) * 0.55);
    element.dispatchEvent(new Event("scroll"));
  });
  await settlePreviewLayout(page);
  const selectedKey = await list.locator('.inbox-row-shell[aria-selected="true"]').evaluate((row) =>
    row.closest<HTMLElement>("[data-virtual-row]")?.dataset.virtualKey ?? null);
  expect(selectedKey).not.toBeNull();
  // The page header's controls and the tab row's search field. The pending-order line is
  // conditional, so none of these may move when it appears or leaves (#1675, #2221).
  const stationaryToolbar = () => page.locator(".page-header .page-actions > *, .tabs-tools > .inbox-search")
    .evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { name: element.className, left: rect.left, right: rect.right };
    }));
  const toolbarWithoutButton = await stationaryToolbar();
  expect(toolbarWithoutButton.map(({ name }) => name)).toEqual([
    "page-controls", "btn ghost page-action", "overflow-menu page-more", "btn primary page-primary", "input-affix inbox-search",
  ]);

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-overflow-35", {
      lastEventAt: 2_000,
      attention: { version: 1, meaningfulAt: 2_000, humanActions: [], result: null, acknowledgedRevision: null },
      preview: "Meaningful work is waiting for deliberate order adoption.",
      status: "running",
    });
  });
  // A quiet line above the rows, never a control in the header or the tab row (#2221).
  const orderLine = page.locator(".inbox-list-pane > .inbox-list-head > .inbox-order-line");
  await expect(orderLine).toHaveText("New activity changed the order.Apply");
  const applyOrder = orderLine.getByRole("button", { name: "Apply", exact: true });
  await expect(applyOrder).toBeVisible();
  expect(await stationaryToolbar()).toEqual(toolbarWithoutButton);
  const before = await inboxViewportAnchor(page);
  expect(before.key).not.toBeNull();

  await applyOrder.click();
  await settlePreviewLayout(page);
  await expect(applyOrder).toHaveCount(0);
  expect(await stationaryToolbar()).toEqual(toolbarWithoutButton);
  await expect(list).toBeFocused();
  const after = await inboxViewportAnchor(page);
  expect(after.key).toBe(before.key);
  expect(Math.abs((after.offset ?? 0) - (before.offset ?? 0))).toBeLessThan(2);
  expect(await list.locator('.inbox-row-shell[aria-selected="true"]').evaluate((row) =>
    row.closest<HTMLElement>("[data-virtual-row]")?.dataset.virtualKey ?? null)).toBe(selectedKey);

  await list.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await settlePreviewLayout(page);
  await expect(list.locator(".inbox-row-title").first()).toHaveText("Overflow Session 36");
});

for (const scenario of [
  {
    name: "above the saved viewport",
    patch: { status: "running", activeTurnId: "moved-above", lastEventAt: 2_000 },
    direction: "up",
  },
  {
    name: "below the saved viewport",
    patch: { status: "idle", activeTurnId: null, lastEventAt: -2_000 },
    direction: "down",
  },
  {
    name: "inside the saved viewport",
    patch: null,
    direction: "still",
  },
] as const) test(`Escape reveals a selected Inbox row ${scenario.name}`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=inbox-live-scroll&fullShell=1");
  const list = page.getByRole("grid", { name: "Sessions", exact: true });
  await expect(list.locator("[data-virtual-total='36']")).toBeVisible();
  await expect.poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  await list.evaluate((element) => {
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) * 0.52);
    element.dispatchEvent(new Event("scroll"));
  });
  await settlePreviewLayout(page);
  const selected = page.getByRole("row", { name: /Overflow Session 18/ });
  await expect(selected).toBeVisible();
  await selected.click();
  await selected.evaluate((row) => {
    const list = row.closest<HTMLElement>(".inbox-list")!;
    const rowRect = row.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    list.scrollTop += (rowRect.top + rowRect.bottom - viewport.top - viewport.bottom) / 2;
    list.dispatchEvent(new Event("scroll"));
  });
  await settlePreviewLayout(page);
  const selectedKey = await selected.evaluate((row) =>
    row.closest<HTMLElement>("[data-virtual-row]")?.dataset.virtualKey ?? null);
  expect(selectedKey).not.toBeNull();
  const before = await list.evaluate((element) => element.scrollTop);

  await page.getByRole("button", { name: "Open Session", exact: true }).click();
  await expect(page.getByRole("region", { name: "Session Activity" })).toBeVisible();
  await settlePreviewLayout(page, 2);
  if (scenario.patch) {
    await page.evaluate(({ patch }) => {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-overflow-17", { ...patch,
        attention: { version: 1, meaningfulAt: patch.lastEventAt, humanActions: [], result: null,
          acknowledgedRevision: null } });
    }, { patch: scenario.patch });
  }

  await page.getByRole("region", { name: "Session Activity" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Session Activity" })).toHaveCount(0);
  await expect(list).toBeFocused();
  const selectedAfter = list.locator('.inbox-row-shell[aria-selected="true"]');
  await expect(selectedAfter).toContainText("Overflow Session 18");
  const activeId = await list.getAttribute("aria-activedescendant");
  expect(activeId).not.toBeNull();
  await expect(page.locator(`#${activeId}`)).toBeAttached();
  await expect(page.locator(`#${activeId}`)).toBeInViewport();
  expect(await selectedAfter.evaluate((row) =>
    row.closest<HTMLElement>("[data-virtual-row]")?.dataset.virtualKey ?? null)).toBe(selectedKey);

  const after = await list.evaluate((element) => element.scrollTop);
  if (scenario.direction === "up") expect(after).toBeLessThan(before);
  else if (scenario.direction === "down") expect(after).toBeGreaterThan(before);
  // Virtual row measurement can refine the restored anchor by less than half a 76px desktop row.
  else expect(Math.abs(after - before)).toBeLessThan(40);
  if (scenario.direction !== "still") {
    const edges = await selectedAfter.evaluate((row) => {
      const viewport = row.closest<HTMLElement>(".inbox-list")!.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return { rowTop: rowRect.top, rowBottom: rowRect.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom };
    });
    const nearestEdgeDelta = scenario.direction === "up"
      ? edges.rowTop - edges.viewportTop
      : edges.viewportBottom - edges.rowBottom;
    // Allow fractional virtual measurements and integer scrollTop rounding while still ruling out
    // centering or any other movement substantially larger than the minimum reveal delta. A row
    // revealed at the very end of the list cannot come closer than the list's bottom padding, so
    // there the list must instead have scrolled as far as it goes.
    const remaining = await list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    expect(nearestEdgeDelta).toBeGreaterThanOrEqual(-5);
    if (scenario.direction === "down" && remaining <= 5) expect(nearestEdgeDelta).toBeLessThanOrEqual(5 + 7 + remaining);
    else expect(Math.abs(nearestEdgeDelta)).toBeLessThanOrEqual(5);
  }

  await list.press(scenario.direction === "down" ? "k" : "j");
  await expect(list.locator('.inbox-row-shell[aria-selected="true"]')).not.toContainText("Overflow Session 18");
});

test("real Inbox preview paging keeps ownership while live output streams", async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html?scenario=preview-follow");
  const reader = page.getByRole("region", { name: "Session Preview Activity" });
  const follow = page.locator(".detail-scroll[data-follow-tail-state]");
  await expect(reader.locator("[data-virtual-row]").first()).toBeVisible();
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeLessThanOrEqual(2);
  await page.locator(".inbox-list").focus();

  const before = await settledPreviewScrollMetrics(page);
  await page.keyboard.press("Shift+Space");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");
  await expect.poll(async () => (await previewScrollMetrics(page)).scrollTop)
    .toBeLessThan(before.scrollTop - before.clientHeight * 0.35);
  await settledPreviewScrollMetrics(page);
  const anchor = await previewVisibleAnchor(page);
  expect(anchor).not.toBeNull();

  await page.evaluate(() => {
    for (let index = 0; index < 4; index += 1) {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitAgentMessage(
        "session-alpha",
        `Streamed output ${index + 1}. ${"A growing live row must not reclaim preview ownership. ".repeat(12)}`,
      );
    }
  });
  await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");
  await expect.poll(async () => (await previewVisibleAnchor(page))?.key).toBe(anchor!.key);
  await expect.poll(async () => Math.abs((await previewVisibleAnchor(page))!.offset - anchor!.offset)).toBeLessThan(2);
  await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeGreaterThan(2);

  const streamed = await settledPreviewScrollMetrics(page);
  await page.keyboard.press("Shift+Space");
  await expect.poll(async () => (await previewScrollMetrics(page)).scrollTop)
    .toBeLessThan(streamed.scrollTop - streamed.clientHeight * 0.35);
  await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");
});

test("an event-heavy Inbox preview fills its opening viewport before expansion", async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html?scenario=preview-opening-fill");
  const reader = page.getByRole("region", { name: "Session Preview Activity" });
  await expect(reader.locator("[data-virtual-row]").first()).toBeVisible();

  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests()
      .filter((request) => request.sessionId === "session-alpha" && request.direction === "backward" &&
        request.after === 49).length,
  )).toBe(1);
  const earlierActivity = reader.getByRole("button", { name: "Load Earlier Activity" });
  await expect(earlierActivity).toBeAttached();
  await expect.poll(() => earlierActivity.evaluate((element) => {
    const viewport = element.closest(".detail-scroll")?.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return viewport != null && (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom);
  })).toBe(true);
  const previewMetrics = await reader.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(previewMetrics.scrollHeight).toBeGreaterThan(previewMetrics.clientHeight + 64);
  const requestsBeforeExpansion = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests()
      .filter((request) => request.sessionId === "session-alpha" && request.direction === "backward").length,
  );

  await page.getByRole("button", { name: "Open Session", exact: true }).click();
  const expandedReader = page.getByRole("region", { name: "Session Activity" });
  await expect(expandedReader).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests()
      .filter((request) => request.sessionId === "session-alpha" && request.direction === "backward").length,
  )).toBe(requestsBeforeExpansion);
  await expect.poll(() => expandedReader.evaluate((element) =>
    element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeLessThanOrEqual(2);
});

test("real Inbox preview paging preserves ownership with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/command-inbox-projects-e2e.html?scenario=preview-follow");
  const reader = page.getByRole("region", { name: "Session Preview Activity" });
  const follow = page.locator(".detail-scroll[data-follow-tail-state]");
  await expect(reader.locator("[data-virtual-row]").first()).toBeVisible();
  await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeLessThanOrEqual(2);
  await page.locator(".inbox-list").focus();
  const before = await settledPreviewScrollMetrics(page);

  // The rows the page mounts measure in the frames after it lands, and the row at the top of the
  // reader must not move while they do — not even for one frame (#2426).
  expectRowStill(await recordRowOffsets(page, reader, () => page.keyboard.press("Shift+Space")));
  await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");
  expect((await previewScrollMetrics(page)).scrollTop).toBeLessThan(before.scrollTop - before.clientHeight * 0.35);
  const anchor = await previewVisibleAnchor(page);
  expect(anchor).not.toBeNull();
  // The streamed row lands below the viewport; the anchor stays put in every frame until it has.
  expectRowStill(await recordRowOffsets(page, reader, () => page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitAgentMessage(
      "session-alpha",
      "Reduced-motion streamed output must leave the preview viewport untouched. ".repeat(12),
    );
  }), { key: anchor!.key, untilRowsGrow: true }));
  await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");
  const streamed = await previewVisibleAnchor(page);
  expect(streamed?.key).toBe(anchor!.key);
  expect(Math.abs(streamed!.offset - anchor!.offset)).toBeLessThanOrEqual(2);
});

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`paging keeps the landed row still while paged-in rows measure (${reducedMotion} motion)`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/command-inbox-projects-e2e.html?scenario=preview-follow");
    const preview = page.getByRole("region", { name: "Session Preview Activity" });
    const follow = page.locator(".detail-scroll[data-follow-tail-state]");
    await expect(preview.locator("[data-virtual-row]").first()).toBeVisible();
    await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeLessThanOrEqual(2);
    await page.locator(".inbox-list").focus();
    await settledPreviewScrollMetrics(page);
    expectRowStill(await recordRowOffsets(page, preview, () => page.keyboard.press("Shift+Space")));
    await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");

    // Page Up from the Session Reading keys, in the expanded session.
    await page.getByRole("button", { name: "Open Session", exact: true }).click();
    const reader = page.getByRole("region", { name: "Session Activity" });
    await expect(reader.locator("[data-virtual-row]").first()).toBeVisible();
    await reader.focus();
    await page.keyboard.press("End");
    await expect(follow).toHaveAttribute("data-follow-tail-state", "following");
    await expect.poll(() => reader.evaluate((element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
    await settlePreviewLayout(page);
    expectRowStill(await recordRowOffsets(page, reader, () => page.keyboard.press("Shift+Space")));
    await expect(follow).toHaveAttribute("data-follow-tail-state", "paused");
  });
}

for (const fault of ["row transition", "observer jump"] as const) {
  test(`the painted-frame row recorder sees a row that moves for one frame (${fault})`, async ({ page }) => {
    // Negative controls for the paging tests above. "row transition" puts back the transition #2426
    // removed, which paints a scroll correction a frame before the rows it compensates for.
    // "observer jump" moves the reader in a ResizeObserver callback, before paint, in the first frame
    // after the page lands, and moves it back straight after that paint.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/command-inbox-projects-e2e.html?scenario=preview-follow");
    if (fault === "row transition") {
      await page.addStyleTag({ content: "[data-virtual-row] { transition-property: transform !important; }" });
    }
    const reader = page.getByRole("region", { name: "Session Preview Activity" });
    await expect(reader.locator("[data-virtual-row]").first()).toBeVisible();
    await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeLessThanOrEqual(2);
    await page.locator(".inbox-list").focus();
    await settledPreviewScrollMetrics(page);
    if (fault === "observer jump") {
      await reader.evaluate((element) => {
        const landedFrom = element.scrollTop;
        // In the first frame after the page lands, resize a box this fault owns. Its observer,
        // created before the recorder's, moves the reader in that frame's first delivery, after the
        // frame's rAF reads; the move back runs after the paint and before the next rAF, so only
        // the recorder's observer-phase read can see the frame.
        const trigger = document.createElement("div");
        trigger.style.cssText = "position: fixed; top: 0; left: 0; height: 0; width: 1px; visibility: hidden;";
        document.body.append(trigger);
        let armed = false;
        const jump = new ResizeObserver(() => {
          if (!armed) return;
          jump.disconnect();
          trigger.remove();
          element.scrollTop -= 20;
          setTimeout(() => { element.scrollTop += 20; }, 0);
        });
        jump.observe(trigger);
        const watch = () => {
          if (Math.abs(element.scrollTop - landedFrom) < 1) {
            requestAnimationFrame(watch);
            return;
          }
          armed = true;
          trigger.style.width = "2px";
        };
        requestAnimationFrame(watch);
      });
    }
    const samples = await recordRowOffsets(page, reader, () => page.keyboard.press("Shift+Space"));
    expect(rowDrift(samples), JSON.stringify(samples)).toBeGreaterThan(2);
  });
}

test("real Inbox reading hints and resume keys match preview and expanded follow state", async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html?scenario=preview-follow");
  let reader = page.getByRole("region", { name: "Session Preview Activity" });
  const follow = page.locator(".detail-scroll[data-follow-tail-state]");
  const jump = page.locator(".transcript-tail-anchor > .transcript-tail-control");
  await expect(reader.locator("[data-virtual-row]").first()).toBeVisible();
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");
  // #2153: at the tail nothing renders below the preview's last row — no chip, no pager hints and
  // (#2166) no status strip.
  await expect(jump).toHaveCount(0);
  await expect(page.locator("[class*='transcript-status']")).toHaveCount(0);
  await expect(page.locator(".detail-main [data-shortcut-hint]")).toHaveCount(0);

  await reader.focus();
  await page.keyboard.press("k");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");

  await page.locator(".inbox-list").focus();
  await page.keyboard.press("Shift+Space");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAccessibleName("Jump to Latest");
  await expect(jump.locator("kbd")).toHaveText("End");
  await expect(jump).toHaveAttribute("title", "Jump to Latest (End)");
  // Centered on the reading column, which a preview starts at the page gutter (#2210), floating
  // --space-3 above the reader's lower edge. A transcript row spans the reading column.
  const [readerBox, jumpBox, columnBox] = await Promise.all([
    reader.boundingBox(), jump.boundingBox(), reader.locator(".tl-row").first().boundingBox(),
  ]);
  expect(Math.abs((jumpBox!.x + jumpBox!.width / 2) - (columnBox!.x + columnBox!.width / 2))).toBeLessThan(10);
  expect(readerBox!.y + readerBox!.height - (jumpBox!.y + jumpBox!.height)).toBeCloseTo(12, 0);

  await page.keyboard.press("Shift+G");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeLessThanOrEqual(2);
  await expect(jump).toHaveCount(0);

  await page.keyboard.press("Shift+Space");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");
  await page.keyboard.press("End");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "Open Session", exact: true }).click();
  await expect(page.locator(".inbox-view.expanded")).toBeVisible();
  await expect(page.locator(".inbox-list-pane")).toHaveAttribute("inert", "");
  reader = page.getByRole("region", { name: "Session Activity" });
  await expect(reader).toBeVisible();
  await reader.focus();
  await page.keyboard.press("Shift+Space");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "paused");
  // This session has no activity yet: an empty transcript has no tail, so the reading keys still
  // drive the follow state but nothing offers to jump to it.
  await expect(page.getByText("Start the Conversation")).toBeVisible();
  await expect(jump).toHaveCount(0);
  // The idle composer below the reader offers R, and still no strip sits between them (#2166).
  await expect(page.locator(".composer-reply-hint kbd")).toHaveText("R");
  await expect(page.locator("[class*='transcript-status']")).toHaveCount(0);
  await page.keyboard.press("Shift+G");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");

  await page.keyboard.press("Shift+Space");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "paused");
  await page.keyboard.press("End");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");
});

test("real Inbox restores independent paused anchors after hidden streaming and paginated remounts", async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html?scenario=scroll-restore");
  await page.getByRole("tab", { name: /All/ }).click();
  const reader = page.getByRole("region", { name: "Session Preview Activity" });
  const follow = page.locator(".detail-scroll[data-follow-tail-state]");

  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-alpha']")).toBeVisible();
  await expect.poll(async () => (await previewScrollMetrics(page)).scrollHeight).toBeGreaterThan(1_800);
  const alpha = await pausePreviewAt(page, 0.38);

  await page.getByRole("row", { name: /No Project Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-no-project']")).toBeVisible();
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(async () => (await previewScrollMetrics(page)).scrollHeight).toBeGreaterThan(1_800);
  const noProject = await pausePreviewAt(page, 0.62);
  expect(noProject.key).not.toBe(alpha.key);

  await page.evaluate(() => {
    // Stay in the same log and miss more than two forward pages while this reader is hidden.
    // An epoch change means replacement history, not ordinary pruning of a reader's cache.
    for (let index = 0; index < 36; index += 1) {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitAgentMessage(
        "session-alpha",
        `Hidden Alpha output ${index + 1}. ${"The durable fixture must survive cache pruning. ".repeat(10)}`,
      );
    }
  });
  await expect.poll(async () => (await previewVisibleAnchor(page))?.key).toBe(noProject.key);
  const alphaRequestsBeforeRestore = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests()
      .filter((request) => request.sessionId === "session-alpha").length);
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-alpha']")).toBeVisible();
  await expect(follow).toHaveAttribute("data-follow-tail-state", "paused");
  await expect.poll(async () => (await previewVisibleAnchor(page))?.key).toBe(alpha.key);
  await expect.poll(async () => Math.abs((await previewVisibleAnchor(page))!.offset - alpha.offset)).toBeLessThan(2);
  await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeGreaterThan(48);
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests()
      .filter((request) => request.sessionId === "session-alpha").length))
    .toBeGreaterThan(alphaRequestsBeforeRestore + 1);

  await page.evaluate(() => {
    for (let index = 0; index < 36; index += 1) {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitAgentMessage(
        "session-no-project",
        `Hidden No Project output ${index + 1}. ${"Each session retains its own logical reading position. ".repeat(10)}`,
      );
    }
  });
  const noProjectRequestsBeforeRestore = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests()
      .filter((request) => request.sessionId === "session-no-project").length);
  await page.getByRole("row", { name: /No Project Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-no-project']")).toBeVisible();
  await expect(follow).toHaveAttribute("data-follow-tail-state", "paused");
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests()
      .filter((request) => request.sessionId === "session-no-project").length))
    .toBeGreaterThan(noProjectRequestsBeforeRestore + 1);
  await expect.poll(async () => (await previewVisibleAnchor(page))?.key).toBe(noProject.key);
  await expect.poll(async () => Math.abs((await previewVisibleAnchor(page))!.offset - noProject.offset)).toBeLessThan(2);
  await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeGreaterThan(48);
});

test("Session Reading movement owns an incomplete Inbox restore across an immediate remount", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/command-inbox-projects-e2e.html?scenario=scroll-restore&historyDelay=1000");
  await page.getByRole("tab", { name: /All/ }).click();
  const reader = page.getByRole("region", { name: "Session Preview Activity" });

  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await expect.poll(async () => (await previewScrollMetrics(page)).scrollHeight).toBeGreaterThan(1_800);
  const original = await pausePreviewAt(page, 0.45);
  await page.getByRole("row", { name: /No Project Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-no-project']")).toBeVisible();

  await page.evaluate(() => {
    for (let index = 0; index < 36; index += 1) {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitAgentMessage(
        "session-alpha", `Delayed hidden output ${index + 1}.`,
      );
    }
  });
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-alpha']")).toBeVisible();
  await page.getByRole("button", { name: "Open Session", exact: true }).click();
  const expandedReader = page.getByRole("region", { name: "Session Activity" });
  // The saved window is immediately readable while the same-epoch forward gap is still loading.
  await expect(expandedReader.locator("[data-virtual-total='24']")).toBeVisible();
  await expandedReader.focus();
  const beforeMove = await expandedReader.evaluate((element) => element.scrollTop);
  await page.keyboard.press("j");
  await expect.poll(() => expandedReader.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(beforeMove + 20);
  const moved = await expandedReader.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-virtual-row]")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    return row?.dataset.virtualKey
      ? { key: row.dataset.virtualKey, offset: row.getBoundingClientRect().top - viewport.top }
      : null;
  });
  expect(moved).not.toBeNull();
  expect(moved!.key !== original.key || Math.abs(moved!.offset - original.offset) > 20).toBe(true);

  await expect(expandedReader.locator("[data-virtual-total='24']")).toBeVisible();
  await page.getByRole("button", { name: "Back to Sessions" }).click();
  await page.getByRole("row", { name: /No Project Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-no-project']")).toBeVisible();

  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-alpha']")).toBeVisible();
  await expect.poll(async () => (await previewVisibleAnchor(page))?.key).toBe(moved!.key);
  // Ownership, not pixel identity: the mount-restore machinery has a pre-existing decay in this
  // remount cycle — the restore settles at the anchor row's REST position, up to one Session
  // Reading step (~40px) above the captured offset (browser-measured 36px). The old <12px bound
  // never observed a tighter restore: it only held because the since-moved top "checking for
  // missed activity" notice sat INSIDE the expanded scroller and inflated the capture by its own
  // ~45px box, cancelling the decay by coincidence. The anchor KEY above and the paused state
  // below carry the ownership guarantee; this bound pins the same reading neighbourhood without
  // re-encoding removed-notice geometry.
  await expect.poll(async () => Math.abs((await previewVisibleAnchor(page))!.offset - moved!.offset)).toBeLessThan(48);
  await expect(page.locator(".detail-scroll[data-follow-tail-state]")).toHaveAttribute("data-follow-tail-state", "paused");
});

test("Inbox replacement history expires the old paused anchor and opens its latest window", async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html?scenario=scroll-restore");
  await page.getByRole("tab", { name: /All/ }).click();
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await expect.poll(async () => (await previewScrollMetrics(page)).scrollHeight).toBeGreaterThan(1_800);
  const oldAnchor = await pausePreviewAt(page, 0.38);
  await page.getByRole("row", { name: /No Project Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-no-project']")).toBeVisible();

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionEventHistory("session-alpha",
      Array.from({ length: 56 }, (_, index) => ({
        kind: "agent_message" as const,
        text: `Replacement response ${index + 1}. ${"This belongs to the replacement log. ".repeat(10)}`,
        final: true, messageId: `replacement-message-${index + 1}`,
      })));
  });
  const requestsBefore = await page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests().length);
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-alpha']")).toBeVisible();
  await expect(page.locator(".detail-scroll[data-follow-tail-state]")).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeLessThanOrEqual(2);
  await expect.poll(async () => (await previewVisibleAnchor(page))?.key).not.toBe(oldAnchor.key);
  await expect(page.getByRole("region", { name: "Session Preview Activity" }).getByText(/Replacement response 56\./)).toBeVisible();
  const reads = await page.evaluate((start) =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests().slice(start)
      .filter((request) => request.sessionId === "session-alpha"), requestsBefore);
  expect(reads.some((request) => request.direction === "backward")).toBe(true);
  expect(reads.filter((request) => request.direction !== "backward").every((request) => request.after > 0)).toBe(true);
});

test("Inbox titles keep one reading axis across row signals, widths, and densities", async ({ page }) => {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", {
      name: "Alpha Project with an intentionally long display name",
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", { status: "running" });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-secret", { status: "starting" });
  });
  await page.getByRole("tab", { name: /^All \d/ }).click();
  await expect(page.locator(".inbox-row-title")).toHaveCount(3);

  for (const density of ["compact", "comfortable"] as const) {
    await page.evaluate((value) => {
      if (value === "comfortable") document.documentElement.dataset.density = value;
      else delete document.documentElement.dataset.density;
    }, density);

    for (const width of [1280, 960, 800]) {
      await page.setViewportSize({ width, height: 760 });
      const geometry = await page.locator(".inbox-row").evaluateAll((rows) => rows.map((row) => {
        const title = row.querySelector<HTMLElement>(".inbox-row-title")!;
        const sender = row.querySelector<HTMLElement>(".inbox-row-sender")!;
        // The status line's trailing cluster: the one badge, the strip, the flags and the time (#2209).
        const signals = row.querySelector<HTMLElement>(".inbox-row-trail")!;
        return {
          titleX: title.getBoundingClientRect().left,
          senderRight: sender.getBoundingClientRect().right,
          signalsLeft: signals.getBoundingClientRect().left,
          signalsWidth: signals.getBoundingClientRect().width,
        };
      }));

      // The axis is now the row's own left edge: #664 moved the title onto its own line, so no
      // amount of status badges or sender text can shift where a title starts.
      expect(Math.max(...geometry.map(({ titleX }) => titleX)) - Math.min(...geometry.map(({ titleX }) => titleX)))
        .toBeLessThanOrEqual(1);
      // A narrow list sizes the cluster to what each row carries; a list 880px or wider gives every
      // row the same fixed columns (#2218), so the badges and times line up down the list.
      const listWidth = await page.locator(".inbox-list-pane").evaluate((pane) => pane.getBoundingClientRect().width);
      const spread = Math.max(...geometry.map(({ signalsWidth }) => signalsWidth)) - Math.min(...geometry.map(({ signalsWidth }) => signalsWidth));
      if (listWidth >= 880) expect(spread).toBeLessThanOrEqual(0.5);
      else expect(spread).toBeGreaterThan(8);
      // A long agent-and-Project label yields to the signals column instead of colliding with it.
      for (const { senderRight, signalsLeft } of geometry) expect(senderRight).toBeLessThanOrEqual(signalsLeft + 1);
    }
  }
});

test("archiving the final session keeps its Project selected live and after reload", async ({ page }) => {
  const alpha = page.getByRole("tab", { name: /Alpha/ });
  await alpha.click();
  await page.getByRole("button", { name: "Alpha Actions" }).click();
  await page.getByRole("menuitem", { name: "Archive and Stop All Sessions" }).click();
  const confirmation = page.getByRole("dialog", { name: /^Archive and Stop \d+ Sessions?$/ });
  await confirmation.getByRole("button", { name: "Archive and Stop" }).click();

  await expect(alpha).toHaveAttribute("aria-selected", "true");
  await expect(alpha).toContainText("0");
  await expect(page.getByText("No Sessions Yet", { exact: true })).toBeVisible();
  await expect(page.getByText("Start a session to put an agent to work in Alpha.", { exact: true })).toBeVisible();

  await page.reload();
  const reloadedAlpha = page.getByRole("tab", { name: /Alpha/ });
  await expect(reloadedAlpha).toBeVisible();
  await expect(reloadedAlpha).toContainText("0");
});

test("Project launch actions submit stable Project and Location identity", async ({ page }) => {
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Alpha Actions" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();

  const dialog = page.getByRole("dialog", { name: "New Session" });
  await expect(dialog.getByRole("combobox", { name: "Project" })).toHaveValue("Alpha");
  await expect(dialog.getByRole("radiogroup", { name: "Project Location" }).locator(".choice-row").filter({ hasText: /\/repos\/alpha$/ }).getByRole("radio"))
    .toBeChecked();
  await dialog.getByRole("button", { name: "Create Session" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
    .toMatchObject({
      runnerId: "runner-1",
      workspaceId: "alpha-workspace",
      projectId: "alpha",
      projectLocationId: "location-alpha",
      useWorktree: false,
    });

  await page.goto("/command-inbox-projects-e2e.html");
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Alpha Actions" }).click();
  await page.getByRole("menuitem", { name: "Create Permanent Worktree" }).click();
  const worktreeDialog = page.getByRole("dialog", { name: "New Session" });
  await expect(worktreeDialog.getByRole("combobox", { name: "Project" })).toHaveValue("Alpha");
  await worktreeDialog.getByRole("button", { name: "Create Session" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
    .toMatchObject({
      projectId: "alpha",
      projectLocationId: "location-alpha",
      useWorktree: true,
    });
});

test("Native TUI launch sends the harness intent and opens Terminal only after creation", async ({ page }, testInfo) => {
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Alpha Actions" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();

  const dialog = page.getByRole("dialog", { name: "New Session" });
  const harness = dialog.getByRole("radiogroup", { name: "Harness" });
  await expect(harness.getByRole("radio", { name: /Direct/ })).toBeChecked();
  await harness.getByRole("radio", { name: /Native TUI/ }).click();
  await dialog.getByRole("button", { name: "Create Session" }).click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()?.launchSurface))
    .toBe("native_tui");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.terminalOpenCount()))
    .toBe(1);
  await expect(page.getByRole("tab", { name: "Agent TUI" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Manager policy hooks remain active" })).toHaveText(
    "Usage Accounting: Unavailable. No structured events or approval cards. Manager policy hooks remain active.",
  );

  await page.evaluate(() => {
    const created = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions.at(-1);
    if (!created) throw new Error("created session missing");
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot(created.id, { costBudgetUsd: 5 });
  });
  // The reason is New Agent TUI's second line in the New Tab menu, not only a tooltip (#2864).
  await page.getByRole("region", { name: "Terminal" }).getByRole("button", { name: "New Tab" }).click();
  const newAgentTui = page.getByRole("menu", { name: "New Tab" }).getByRole("menuitem", { name: "New Agent TUI" });
  await expect(newAgentTui).toHaveAttribute("aria-disabled", "true");
  await expect(newAgentTui).toHaveAccessibleDescription(
    "Unavailable while this session has a cost budget, cost checkpoint or tool-call limit.",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status").filter({ hasText: "Agent TUI is unavailable" })).toContainText(
    "Clear those guardrails or use Direct",
  );
  await page.locator(".shell-dock").screenshot({
    path: testInfo.outputPath("native-tui-guardrail-blocked.png"),
  });
});

test("the Sessions header opens both existing workflows with the active Project context", async ({ page }) => {
  await page.getByRole("tab", { name: /Alpha/ }).click();
  // New Session is the header's labeled primary, with its global binding as the shared keycap (§11.5).
  const create = page.locator(".page-header").getByRole("button", { name: "New Session", exact: true });
  await expect(create.locator("kbd")).toHaveText("C");
  const more = page.locator(".page-header").getByRole("button", { name: "More Actions" });

  await create.click();
  const sessionDialog = page.getByRole("dialog", { name: "New Session" });
  const project = sessionDialog.getByRole("combobox", { name: "Project" });
  await expect(project).toHaveValue("Alpha");
  await expect(project).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(project).toHaveAttribute("aria-expanded", "false");
  await expect(sessionDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sessionDialog).toBeHidden();
  await expect(create).toBeFocused();

  await more.click();
  await page.getByRole("menuitem", { name: "New Project…", exact: true }).click();
  const projectDialog = page.getByRole("dialog", { name: "Create Project" });
  await expect(projectDialog).toBeVisible();
  await projectDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(more).toBeFocused();
});

test("the Sessions header's creation actions remain usable at a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The app bar's New Session is the 44px + whose name stays its label (§15.1).
  const create = page.locator(".page-header").getByRole("button", { name: "New Session", exact: true });
  const more = page.locator(".page-header").getByRole("button", { name: "More Actions" });
  await expect(create).toBeVisible();

  await create.click();
  const sessionDialog = page.getByRole("dialog", { name: "New Session" });
  await expect(sessionDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sessionDialog).toBeHidden();
  await expect(create).toBeFocused();

  await more.click();
  await page.getByRole("menuitem", { name: "New Project…", exact: true }).click();
  const projectDialog = page.getByRole("dialog", { name: "Create Project" });
  await expect(projectDialog).toBeVisible();
  await projectDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(more).toBeFocused();
});

test("C defaults New Session to the active single-Project Inbox tab", async ({ page }) => {
  const alphaTab = page.getByRole("tab", { name: /Alpha/ });
  await alphaTab.click();
  await expect(alphaTab).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "New Session" });
  await expect(dialog.getByRole("combobox", { name: "Project" })).toHaveValue("Alpha");
  await expect(dialog.getByRole("radiogroup", { name: "Project Location" })
    .locator(".choice-row").filter({ hasText: /\/repos\/alpha$/ }).getByRole("radio")).toBeChecked();
});

test.describe("with a touch pointer", () => {
  // The mobile 44px minimum is a touch size, keyed to the pointer rather than the viewport (#1799).
  test.use({ hasTouch: true });

  test("New Session control labels retain centred, unclipped browser geometry", async ({ page }) => {
    for (const theme of ["dark", "light"] as const) {
      for (const viewport of [
        { name: "mobile", width: 390, height: 844, touchMinimum: true },
        { name: "desktop", width: 1280, height: 900, touchMinimum: false },
      ] as const) {
        await page.setViewportSize(viewport);
        await page.goto("/command-inbox-projects-e2e.html");
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await chooseGroup(page, /^Alpha/);
        await page.keyboard.press("c");

        const dialog = page.getByRole("dialog", { name: "New Session" });
        await expect(dialog).toBeVisible();
        await dialogMotionSettled(page);
        const controls = [
          dialog.getByRole("button", { name: "Create Project…" }),
          dialog.getByRole("button", { name: "Add Location…" }),
          dialog.locator('[role="combobox"][aria-label="Agent"], button[aria-label^="Agent:"]'),
        ];
        const geometry = await Promise.all(controls.map(controlGeometry));

        for (const [index, control] of geometry.entries()) {
          expect(control.paddingTop - control.paddingBottom,
            `${viewport.name} ${theme} controls centre their line box`).toBe(index < 2 ? 2 : 0);
          expect(control.scrollHeight, `${viewport.name} ${theme} control text is not vertically clipped`)
            .toBeLessThanOrEqual(control.clientHeight);
          expect(control.scrollWidth, `${viewport.name} ${theme} control text is not horizontally clipped`)
            .toBeLessThanOrEqual(control.clientWidth);
        }
        expect(geometry[0]!.height).toBeCloseTo(geometry[1]!.height, 5);
        if (viewport.touchMinimum) {
          for (const control of geometry) expect(control.height).toBeGreaterThanOrEqual(44);
          expect(Math.max(...geometry.map(({ height }) => height)) - Math.min(...geometry.map(({ height }) => height)))
            .toBeLessThan(0.5);
        }
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/command-inbox-projects-e2e.html?longAgent=1");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await chooseGroup(page, /^Alpha/);
    await page.keyboard.press("c");

    const dialog = page.getByRole("dialog", { name: "New Session" });
    const controls = [
      dialog.getByRole("button", { name: "Create Project…" }),
      dialog.getByRole("button", { name: "Add Location…" }),
      dialog.locator('[role="combobox"][aria-label="Agent"], button[aria-label^="Agent:"]'),
    ];
    await expect(dialog.getByRole("button", { name: /^Agent:/ })).toHaveAccessibleName(
      /Áccented Agent With Descenders ģyq — Extended Name/,
    );
    await page.addStyleTag({
      content: ".new-session-project-control, .ui-select-trigger { font-size: 24px !important; }",
    });
    const enlargedGeometry = await Promise.all(controls.map(controlGeometry));
    for (const control of enlargedGeometry) {
      expect(control.height).toBeGreaterThanOrEqual(44);
      expect(control.scrollHeight, "enlarged control text is not vertically clipped").toBeLessThanOrEqual(control.clientHeight);
    }
  });
});

test("multi-Location Projects without a default require an explicit Location", async ({ page }) => {
  await page.evaluate(() => {
    const model = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model();
    const alpha = model.projects.find((project) => project.id === "alpha")!;
    alpha.locations[0]!.isDefault = false;
    alpha.locations.push({
      id: "location-alpha-secondary",
      projectId: "alpha",
      runnerId: "runner-1",
      workspaceId: "alpha-secondary-workspace",
      name: "Alpha Secondary",
      path: "/repos/alpha-secondary",
      source: "managed",
      availability: "available",
      isDefault: false,
      createdAt: 2,
      updatedAt: 2,
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.upsertProject(alpha);
  });

  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Alpha Actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Reveal in File Manager" })).toBeDisabled();
  await page.getByRole("menuitem", { name: "New Session", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "New Session" });
  const locations = dialog.getByRole("radiogroup", { name: "Project Location" });
  const first = locations.locator(".choice-row").filter({ hasText: /\/repos\/alpha$/ }).getByRole("radio");
  const second = locations.locator(".choice-row").filter({ hasText: /\/repos\/alpha-secondary$/ }).getByRole("radio");
  await expect(first).not.toBeChecked();
  await expect(second).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "Create Session" })).toBeDisabled();

  await second.click();
  await dialog.getByRole("button", { name: "Create Session" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
    .toMatchObject({
      runnerId: "runner-1",
      workspaceId: "alpha-secondary-workspace",
      projectId: "alpha",
      projectLocationId: "location-alpha-secondary",
    });
});

test("New Session creates a durable Project and links its first Location inline", async ({ page }) => {
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Alpha Actions" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();
  const newSession = page.getByRole("dialog", { name: "New Session" });
  const createProjectButton = newSession.getByRole("button", { name: /Create Project/ });
  await createProjectButton.click();

  // New Session stays open under its child, under one shared dim (§7.1).
  const createProject = page.getByRole("dialog", { name: "Create Project" });
  await expect(createProject).toBeVisible();
  await expect(newSession).toBeVisible();
  await expect(page.locator(".modal-backdrop")).toHaveCount(2);
  expect(await page.locator(".modal-backdrop").evaluateAll((layers) =>
    layers.map((layer) => getComputedStyle(layer).backgroundColor !== "rgba(0, 0, 0, 0)"))).toEqual([true, false]);
  await createProject.getByLabel("Project Name").fill("Inline Project");
  await createProject.getByRole("button", { name: "Create Project" }).click();

  await expect(createProject).toHaveCount(0);
  await expect(createProjectButton).toBeFocused();
  await expect(newSession.getByRole("combobox", { name: "Project" })).toHaveValue("Inline Project");
  await expect(newSession.getByText("No Project Locations", { exact: true })).toBeVisible();
  await newSession.getByRole("button", { name: /Add Location/ }).click();

  const addLocation = page.getByRole("dialog", { name: "Add Location to Inline Project" });
  const loose = addLocation.getByRole("listitem").filter({ hasText: "/repos/loose" });
  await loose.getByRole("button", { name: "Add to Project" }).click();
  await expect(newSession).toBeVisible();
  await expect(newSession.getByRole("radiogroup", { name: "Project Location" }).locator(".choice-row").filter({ hasText: /\/repos\/loose$/ }).getByRole("radio"))
    .toBeChecked();
  await newSession.getByRole("button", { name: "Create Session" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
    .toMatchObject({
      projectId: "project-4",
      projectLocationId: "location-project-4-loose-workspace",
      workspaceId: "loose-workspace",
    });
});

test("an inline Project fallback cannot revive the Project after a later live deletion", async ({ page }) => {
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Alpha Actions" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();
  const newSession = page.getByRole("dialog", { name: "New Session" });
  await newSession.getByRole("button", { name: /Create Project/ }).click();
  const createProject = page.getByRole("dialog", { name: "Create Project" });
  await createProject.getByLabel("Project Name").fill("Temporary Inline Project");
  await createProject.getByRole("button", { name: "Create Project" }).click();

  const project = newSession.getByRole("combobox", { name: "Project" });
  await expect(project).toHaveValue("Temporary Inline Project");
  await expect(page.getByRole("tab", { name: /Temporary Inline Project/ })).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.removeProject("project-4"));

  await expect(project).toHaveValue("");
  await project.click();
  await expect(newSession.getByRole("listbox", { name: "Project Options" })
    .getByRole("option").filter({ hasText: "Temporary Inline Project" })).toHaveCount(0);
});

test("Project-first creation distinguishes same names and explains multi-location, empty, and offline Projects", async ({ page }) => {
  await page.evaluate(() => {
    const model = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model();
    const alpha = model.projects.find((project) => project.id === "alpha")!;
    alpha.locations.push({
      id: "location-alpha-secondary",
      projectId: "alpha",
      runnerId: "runner-1",
      workspaceId: "alpha-secondary-workspace",
      name: "Alpha Secondary",
      path: "/repos/alpha-secondary",
      source: "managed",
      availability: "available",
      isDefault: false,
      createdAt: 2,
      updatedAt: 2,
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.upsertProject(alpha);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.upsertProject({
      id: "alpha-copy",
      name: "Alpha",
      hidden: true,
      locations: [{
        id: "location-alpha-copy",
        projectId: "alpha-copy",
        runnerId: "runner-1",
        workspaceId: "alpha-copy-workspace",
        name: "Alpha Copy",
        path: "/repos/alpha-copy",
        source: "managed",
        availability: "available",
        isDefault: true,
        createdAt: 2,
        updatedAt: 2,
      }],
      activeSessionCount: 0,
      unarchivedSessionCount: 0,
      totalSessionCount: 0,
      createdAt: 2,
      updatedAt: 2,
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.upsertProject({
      id: "offline",
      name: "Offline Project",
      hidden: false,
      locations: [{
        id: "location-offline",
        projectId: "offline",
        runnerId: "runner-offline",
        workspaceId: "offline-workspace",
        name: "Offline",
        path: "/repos/offline",
        source: "managed",
        availability: "runner_offline",
        isDefault: true,
        createdAt: 2,
        updatedAt: 2,
      }],
      activeSessionCount: 0,
      unarchivedSessionCount: 0,
      totalSessionCount: 0,
      createdAt: 2,
      updatedAt: 2,
    });
  });

  await page.getByRole("tab", { name: /^Alpha/ }).click();
  await page.getByRole("button", { name: "Alpha Actions" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();
  const dialog = page.getByRole("dialog", { name: "New Session" });
  const projectCombobox = dialog.getByRole("combobox", { name: "Project" });
  const locationChoices = dialog.getByRole("radiogroup", { name: "Project Location" });

  await projectCombobox.click();
  await expect(dialog.getByRole("listbox", { name: "Project Options" })
    .getByRole("option").filter({ hasText: "Alpha" })).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(locationChoices.getByRole("radio")).toHaveCount(2);
  await expect(locationChoices.locator(".choice-row").filter({ hasText: /\/repos\/alpha$/ }).getByRole("radio")).toBeChecked();

  await chooseNewSessionProject(dialog, "Gamma");
  await expect(dialog.getByText("No Project Locations", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create Session" })).toBeDisabled();

  await chooseNewSessionProject(dialog, "Offline Project");
  await expect(dialog.getByText(/No Locations are currently available/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create Session" })).toBeDisabled();

  await chooseNewSessionProject(dialog, "/repos/alpha-copy", "/repos/alpha-copy");
  await expect(dialog.getByRole("radiogroup", { name: "Project Location" }).locator(".choice-row").filter({ hasText: /\/repos\/alpha-copy$/ }).getByRole("radio"))
    .toBeChecked();
  await dialog.getByRole("button", { name: "Create Session" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
    .toMatchObject({ projectId: "alpha-copy", projectLocationId: "location-alpha-copy" });
});

/** The session bar's project menu button owns Move to Another Project… (#2146). */
async function openMoveToProjectDialog(page: Page) {
  await page.locator(".session-bar .session-project-button").click();
  await page.getByRole("menuitem", { name: /^Move to (Another|a) Project…$/ }).click();
  return page.getByRole("dialog", { name: "Move to Project" });
}

test("the project menu button opens the project's actions and returns focus to itself", async ({ page }) => {
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { name: "Alpha Project" }));
  await page.getByRole("tab", { name: /^All \d/ }).click();
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Open Session", exact: true }).click();
  // One control for the project: the name and its caret open a menu; nothing navigates on its own.
  const projectButton = page.locator(".session-bar .session-project-button");
  await expect(projectButton).toHaveText("Alpha Project");
  await expect(projectButton).toHaveAccessibleName("Alpha Project");
  await expect(projectButton).toHaveAttribute("aria-haspopup", "menu");
  await expect(projectButton).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Project Actions" })).toHaveCount(0);

  await projectButton.click();
  const actionsMenu = page.getByRole("menu", { name: "Project Actions" });
  await expect(projectButton).toHaveAttribute("aria-expanded", "true");
  await expect(actionsMenu.locator(".menu-label")).toHaveText("Alpha Project");
  await expect(actionsMenu.getByRole("menuitem")).toHaveText(["Open Project", "Move to Another Project…"]);
  await expect(actionsMenu.getByRole("menuitem", { name: "Open Project" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actionsMenu).toBeHidden();
  await expect(projectButton).toBeFocused();

  // Cancelling the Move dialog restores focus to the durable project button, not the removed
  // menu item and not the page heading (regression coverage).
  const moveDialog = await openMoveToProjectDialog(page);
  await page.keyboard.press("Escape");
  await expect(moveDialog).toBeHidden();
  await expect(projectButton).toBeFocused();

  await projectButton.press("Enter");
  await page.getByRole("menuitem", { name: "Open Project" }).click();
  await expect(page.locator(".session-bar")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Alpha Project" }).first()).toBeVisible();
});

test("session Project assignment changes organization without changing execution Location", async ({ page }) => {
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Open Session", exact: true }).click();
  const projectChip = page.locator(".session-bar .session-project-button").filter({ hasText: "Alpha" });
  await expect(projectChip).toBeVisible();
  let dialog = await openMoveToProjectDialog(page);
  await expect(dialog).toHaveAccessibleDescription(
    "Files stay where they are. Only the project that lists this session changes.",
  );
  // The current project is selected, so the primary waits for a different choice (#2163).
  await expect(dialog.getByRole("button", { name: "Move Session" })).toBeDisabled();
  await expect(dialog.getByText("Choose a different project.")).toBeVisible();
  // Gamma has no Location for this folder and Secret's is another folder's, so they are not listed.
  await expect(dialog.getByRole("radio", { name: /Gamma/ })).toHaveCount(0);
  await expect(dialog.getByText("Projects you can't add this folder to aren't listed.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Manage Projects" })).toBeVisible();
  // Choosing a row only selects it.
  await dialog.getByRole("radio", { name: /No Project/ }).click();
  await expect(dialog.getByRole("radio", { name: /No Project/ })).toBeChecked();
  await expect(dialog.getByText("Choose a different project.")).toHaveCount(0);
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
    .find((session) => session.id === "session-alpha")?.projectId)).toBe("alpha");
  await dialog.getByRole("button", { name: "Move Session" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    const value = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions.find((session) => session.id === "session-alpha");
    return [value?.projectId, value?.projectLocationId, value?.workspaceId];
  })).toEqual([null, null, "alpha-workspace"]);

  await expect(page.locator(".session-bar .session-project-button").filter({ hasText: "No Project" })).toBeVisible();
  dialog = await openMoveToProjectDialog(page);
  await dialog.getByRole("radio", { name: /Alpha/ }).click();
  await dialog.getByRole("button", { name: "Move Session" }).click();
  await expect.poll(() => page.evaluate(() => {
    const value = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions.find((session) => session.id === "session-alpha");
    return [value?.projectId, value?.projectLocationId, value?.workspaceId];
  })).toEqual(["alpha", "location-alpha", "alpha-workspace"]);
  // A successful move closes the dialog and hands focus back to the project button.
  await expect(dialog).toBeHidden();
  await expect(page.locator(".session-bar .session-project-button")).toBeFocused();
});

test("an imported session can link its verified Location while moving to a managed Project", async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html?scenario=imported-location");

  await page.getByRole("tab", { name: /No Project/ }).click();
  await page.getByRole("row", { name: /No Project Session/ }).click();
  await page.getByRole("button", { name: "Open Session", exact: true }).click();
  const moveDialog = await openMoveToProjectDialog(page);
  const gammaChoice = moveDialog.getByRole("radio", { name: /Gamma/ });
  await expect(gammaChoice).toHaveAccessibleDescription(/Adds this folder to the project\./);
  await gammaChoice.click();

  // The consent sits beside the choice, and the primary names the outcome (#2163).
  await expect(moveDialog.locator(".notice")).toHaveText(
    "Gamma will include /repos/loose. New sessions in that folder may be filed there too.",
  );
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await moveDialog.getByRole("button", { name: "Add Folder and Move" }).click();

  await expect(page.locator(".session-bar .session-project-button").filter({ hasText: "Gamma" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop Turn" })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => {
    const model = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model();
    const value = model.sessions.find((session) => session.id === "session-no-project");
    const gamma = model.projects.find((project) => project.id === "gamma");
    return [value?.projectId, value?.workspaceId, gamma?.locations[0]?.path];
  })).toEqual(["gamma", "loose-workspace", "/repos/loose"]);
});

test("personal sessions join a team Project only through Move and Share, beside a notice naming the team", async ({ page }) => {
  await page.evaluate(() => {
    const model = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model();
    const alpha = model.projects.find((project) => project.id === "alpha")!;
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setIdentityTeams([{
      teamId: "team-platform",
      organizationId: "fixture-organization",
      name: "Platform",
      memberUserIds: ["fixture-user"],
      createdAt: 1,
    }]);
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.upsertProject({
      ...alpha,
      audience: "team",
      scope: { organizationId: "fixture-organization", owner: { kind: "team", teamId: "team-platform" } },
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      projectId: null,
      projectName: null,
      projectLocationId: null,
      audience: "user",
    });
  });

  await page.getByRole("tab", { name: /No Project/ }).click();
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Open Session", exact: true }).click();
  const moveDialog = await openMoveToProjectDialog(page);
  const alphaChoice = moveDialog.getByRole("radio", { name: /Alpha/ });
  await expect(alphaChoice).toHaveAccessibleDescription("Includes this folder. Shared with the Platform team.");
  await alphaChoice.click();

  // A warning beside the choice names the team and what becomes visible (#2163).
  const notice = moveDialog.locator(".notice");
  await expect(notice).toHaveClass(/warning/);
  await expect(notice).toHaveText(
    "Members of the Platform team will be able to read this conversation. Moving it out later doesn't remove their access.",
  );
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await moveDialog.getByRole("button", { name: "Move and Share" }).click();

  await expect.poll(() => page.evaluate(() => {
    const value = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions.find((session) => session.id === "session-alpha");
    return [value?.projectId, value?.projectLocationId, value?.workspaceId, value?.audience];
  })).toEqual(["alpha", "location-alpha", "alpha-workspace", "team"]);
});

test("older control planes with missing audience metadata fail closed before Project assignment", async ({ page }) => {
  await page.evaluate(() => {
    const model = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model();
    const alpha = model.projects.find((project) => project.id === "alpha")!;
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.upsertProject({ ...alpha, audience: undefined });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      projectId: null,
      projectName: null,
      projectLocationId: null,
      audience: undefined,
    });
  });

  await page.getByRole("tab", { name: /No Project/ }).click();
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Open Session", exact: true }).click();
  const moveDialog = await openMoveToProjectDialog(page);
  await moveDialog.getByRole("radio", { name: /Alpha/ }).click();

  await expect(moveDialog.locator(".notice")).toHaveText(
    "This Wollipog doesn't report who can read this project, so moving the session may change who can read this conversation.",
  );
  await expect(moveDialog.getByRole("button", { name: "Move and Share" })).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await moveDialog.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => page.evaluate(() => {
    const value = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions.find((session) => session.id === "session-alpha");
    return value?.projectId;
  })).toBeNull();
});

test("hidden Projects stay in All while No Project and empty Projects remain explicit", async ({ page }) => {
  await expect(page.getByRole("tab", { name: /Secret/ })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /Gamma/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /No Project/ })).toBeVisible();

  await page.getByRole("tab", { name: /All/ }).click();
  await expect(page.getByText("Secret Session", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /No Project/ }).click();
  await expect(page.getByRole("row", { name: /No Project Session/ })).toBeVisible();
  await expect(page.getByText("Alpha Session", { exact: true })).toHaveCount(0);
});

test("live rename, hide, show, and removal repair Project tabs and selection", async ({ page }) => {
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { name: "Beta" }));
  const beta = page.getByRole("tab", { name: /Beta/ });
  await expect(beta).toHaveAttribute("aria-selected", "true");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { hidden: true }));
  await expect(beta).toHaveCount(0);
  const all = page.getByRole("tab", { name: /All/ });
  await expect(all).toHaveAttribute("aria-selected", "true");
  await expect(all).toBeFocused();
  await expect(page.getByRole("row", { name: /Alpha Session/ })).toBeVisible();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { hidden: false }));
  await expect(page.getByRole("tab", { name: /Beta/ })).toBeVisible();
  await page.getByRole("tab", { name: /Gamma/ }).click();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.removeProject("gamma"));
  await expect(page.getByRole("tab", { name: /Gamma/ })).toHaveCount(0);
  await expect(all).toHaveAttribute("aria-selected", "true");
  await expect(all).toBeFocused();
});

test("Project tabs use roving focus without adding every tab to the page tab order", async ({ page }) => {
  const all = page.getByRole("tab", { name: /All/ });
  const alpha = page.getByRole("tab", { name: /Alpha/ });
  const noProject = page.getByRole("tab", { name: /No Project/ });
  await expect(all).toHaveAttribute("tabindex", "0");
  await expect(alpha).toHaveAttribute("tabindex", "-1");
  await all.focus();
  await all.press("ArrowRight");
  await expect(alpha).toBeFocused();
  await expect(alpha).toHaveAttribute("aria-selected", "true");
  // Only the selected Project tab is followed by ⋯ (#2199), the next stop after the tab row.
  await expect(page.getByRole("button", { name: "Alpha Actions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gamma Actions" })).toHaveCount(0);
  const alphaActions = page.getByRole("button", { name: "Alpha Actions" });
  await page.keyboard.press("Tab");
  await expect(alphaActions).toBeFocused();
  await alphaActions.press("Enter");
  const actionsMenu = page.getByRole("menu", { name: "Alpha Actions" });
  await expect(actionsMenu).toBeVisible();
  await expect(actionsMenu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actionsMenu).toBeHidden();
  await expect(alphaActions).toBeFocused();
  await expect(alphaActions).toHaveAttribute("aria-expanded", "false");
  await alpha.press("End");
  await expect(noProject).toBeFocused();
  await expect(noProject).toHaveAttribute("aria-selected", "true");
});

test.describe("coarse pointer Project actions", () => {
  test.use({ hasTouch: true });

  test("Project action targets are 44px and support a tap action without hover", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "Alpha Actions" });
    // Only the selected Project tab is followed by its action target (#2199).
    await expect(trigger).toHaveCount(0);
    await page.getByRole("tab", { name: /^Alpha/ }).tap();
    await expect(trigger).toBeVisible();
    const alphaTab = await page.getByRole("tab", { name: /^Alpha/ }).boundingBox();
    expect((await trigger.boundingBox())!.x, "the target sits after the tab, not over it")
      .toBeGreaterThanOrEqual(alphaTab!.x + alphaTab!.width);
    const box = (await trigger.boundingBox())!;
    // A small icon button borrows 4px on every side for a 44px target on touch (§2.8), inside the row.
    const reach = await trigger.evaluate((element) => {
      const target = element.getBoundingClientRect();
      const hits = (x: number, y: number) => {
        const found = document.elementFromPoint(x, y);
        return found === element || element.contains(found);
      };
      const cx = target.left + target.width / 2;
      const cy = target.top + target.height / 2;
      return {
        size: [target.width, target.height],
        edges: [hits(target.left - 3.5, cy), hits(target.right + 3.5, cy), hits(cx, target.top - 3.5), hits(cx, target.bottom + 3.5)],
      };
    });
    expect(reach.size).toEqual([36, 36]);
    expect(reach.edges, "the borrowed 4px answers on every side").toEqual([true, true, true, true]);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    const newSessionHere = page.getByRole("menuitem", { name: "New Session Here" });
    await expect(newSessionHere).toBeVisible();
    const actionBox = await newSessionHere.boundingBox();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.height).toBeGreaterThanOrEqual(44);
    await page.touchscreen.tap(
      actionBox!.x + actionBox!.width / 2,
      actionBox!.y + actionBox!.height / 2,
    );
    await expect(page.getByRole("dialog", { name: "New Session" })).toBeVisible();
  });
});

test("Project management creates, hides, reloads, and reveals durable empty Projects", async ({ page }) => {
  await page.locator(".page-header").getByRole("button", { name: "More Actions" }).click();
  await page.getByRole("menuitem", { name: "New Project…", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "Create Project" });
  await createDialog.getByLabel("Project Name").fill("Durable Empty");
  await createDialog.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByRole("tab", { name: /Durable Empty/ })).toBeVisible();
  await openProjectManager(page, "Durable Empty");
  await expect(page.getByText("Group related sessions and choose the folders where they run.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Durable Empty" })).toBeVisible();
  await expect(page.getByText("No Project Locations", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide Project" }).click();
  await expect(page.getByText("Hidden from Sessions", { exact: true })).toBeVisible();

  await page.reload();
  await openProjectManager(page);
  // `radio`, not `button`: the visibility filter is one choice of three, and it used to announce
  // itself as three independent toggles. That the query had to change is the point of the change.
  await page.getByRole("radio", { name: "Hidden", exact: true }).click();
  await expect(page.getByRole("button", { name: /Durable Empty/ })).toBeVisible();
  await page.getByRole("button", { name: /Durable Empty/ }).click();
  await page.getByRole("button", { name: "Show Project" }).click();
  await expect(page.getByText("Shown in Sessions", { exact: true })).toBeVisible();
});

test.describe("with a touch pointer", () => {
  // The 44px back target is a touch size, keyed to the pointer rather than the viewport (#1799).
  test.use({ hasTouch: true });

  test("Project management remains usable as a focused list and detail flow on mobile", async ({ page }) => {
    await openProjectManager(page);
    await page.setViewportSize({ width: 390, height: 844 });
    // On a phone the open Project takes the detail bar (#1801): its name is the page's h1 and Back
    // is the bar's ChevronLeft icon button, not a "← Back to Projects" text link.
    const detail = page.getByRole("heading", { level: 2, name: "Alpha" });
    await expect(detail).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Alpha" })).toBeVisible();
    const back = page.getByRole("button", { name: "Back to Projects", exact: true });
    await expect(back).toBeVisible();
    await expect(back).toHaveText("");
    const box = await back.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await back.click();
    const alpha = page.getByRole("button", { name: /Alpha/ });
    await expect(alpha).toBeVisible();
    await expect(detail).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
    await alpha.click();
    await expect(detail).toBeVisible();
    await expect(back).toBeVisible();
    await back.click();
    await expect(alpha).toBeVisible();
    await expect(detail).toBeHidden();
  });
});

test("one exact Location can be launched from two Projects and unlinked independently", async ({ page }) => {
  test.setTimeout(60_000);
  await openProjectManager(page);
  await page.getByRole("button", { name: /Gamma/ }).click();
  await page.getByRole("button", { name: "Add Location" }).first().click();
  const picker = page.getByRole("dialog", { name: "Add Location to Gamma" });
  await picker.getByLabel("Search Locations").fill("definitely-not-a-location");
  await expect(picker.getByText("No Matching Locations", { exact: true })).toBeVisible();
  await expect(picker.getByRole("button", { name: "Manage Connections" })).toHaveCount(0);
  await picker.getByLabel("Search Locations").fill("");
  const loose = picker.getByRole("listitem").filter({ hasText: "/repos/loose" });
  await loose.getByRole("button", { name: "Add to Project" }).click();
  await expect(page.getByText("/repos/loose", { exact: true })).toBeVisible();
  await expect(page.getByText("Default", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add Location" }).first().click();
  const sharedPicker = page.getByRole("dialog", { name: "Add Location to Gamma" });
  const alphaChoice = sharedPicker.getByRole("listitem").filter({
    has: page.locator('code[title="/repos/alpha"]'),
  });
  await expect(alphaChoice).toContainText("Also Used by: Alpha");
  await alphaChoice.getByRole("button", { name: "Add to Project" }).click();
  await expect(page.getByText("/repos/alpha", { exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const projects = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().projects;
    const alpha = projects.find((project) => project.id === "alpha")!;
    const gamma = projects.find((project) => project.id === "gamma")!;
    return [
      alpha.locations.find((location) => location.workspaceId === "alpha-workspace")?.id,
      gamma.locations.find((location) => location.workspaceId === "alpha-workspace")?.id,
    ];
  })).toEqual(["location-alpha", "location-gamma-alpha-workspace"]);

  const gammaLocation = page.locator(".project-location-row").filter({
    has: page.locator('code[title="/repos/alpha"]'),
  });
  await gammaLocation.getByRole("button", { name: "New Session Here" }).click();
  let sessionDialog = page.getByRole("dialog", { name: "New Session" });
  await expect(sessionDialog.getByRole("combobox", { name: "Project" })).toHaveValue("Gamma");
  await sessionDialog.getByRole("button", { name: "Create Session" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
    .toMatchObject({
      projectId: "gamma",
      projectLocationId: "location-gamma-alpha-workspace",
    });

  await page.goto("/command-inbox-projects-e2e.html");
  await openProjectManager(page, "Alpha");
  const alphaLocation = page.locator(".project-location-row").filter({
    has: page.locator('code[title="/repos/alpha"]'),
  });
  await alphaLocation.getByRole("button", { name: "New Session Here" }).click();
  sessionDialog = page.getByRole("dialog", { name: "New Session" });
  await expect(sessionDialog.getByRole("combobox", { name: "Project" })).toHaveValue("Alpha");
  await sessionDialog.getByRole("button", { name: "Create Session" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
    .toMatchObject({
      projectId: "alpha",
      projectLocationId: "location-alpha",
    });

  await page.goto("/command-inbox-projects-e2e.html");
  await openProjectManager(page, "Gamma");
  const gammaSharedLocation = page.locator(".project-location-row").filter({
    has: page.locator('code[title="/repos/alpha"]'),
  });
  await gammaSharedLocation.getByRole("button", { name: "Remove Location" }).click();
  const confirmation = page.getByRole("dialog", { name: "Remove Location" });
  await expect(confirmation).toContainText("The folder is not deleted");
  await expect(confirmation).toContainText("other Projects are unaffected");
  await confirmation.getByRole("button", { name: "Remove Location" }).click();
  await expect(gammaSharedLocation).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => {
    const model = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model();
    const alpha = model.projects.find((project) => project.id === "alpha")!;
    const gamma = model.projects.find((project) => project.id === "gamma")!;
    const originalSession = model.sessions.find((session) => session.id === "session-alpha");
    return {
      alphaLink: alpha.locations.some((location) => location.id === "location-alpha"),
      gammaLink: gamma.locations.some((location) => location.workspaceId === "alpha-workspace"),
      originalSession: [originalSession?.projectId, originalSession?.projectLocationId],
    };
  })).toEqual({
    alphaLink: true,
    gammaLink: false,
    originalSession: ["alpha", "location-alpha"],
  });
});

test("deleting a Project explicitly retains sessions and moves them to No Project", async ({ page }) => {
  await openProjectManager(page);
  await page.getByRole("button", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Delete Project" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Project" });
  await expect(dialog).toContainText("its sessions move to No Project");
  await expect(dialog).toContainText("Sessions and files are not deleted");
  await dialog.getByLabel("Type Alpha to Confirm").fill("Alpha");
  await dialog.getByRole("button", { name: "Delete Project" }).click();
  await expect.poll(async () => page.evaluate(() => {
    const value = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model();
    return {
      projectExists: value.projects.some((project) => project.id === "alpha"),
      sessionProjectId: value.sessions.find((session) => session.id === "session-alpha")?.projectId,
      sessionStillExists: value.sessions.some((session) => session.id === "session-alpha"),
    };
  })).toEqual({ projectExists: false, sessionProjectId: null, sessionStillExists: true });
});

test.describe("Go to File (#2852)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Ctrl/Cmd+P opens the panel on Files with focus in Go to File, and a second press keeps both", async ({ page }) => {
    await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&reviewReady=1&fullShell=1");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    await waitForSessionPreview(page);
    if (await expand.isVisible()) await expand.click();
    await expect(page.locator("header.session-bar")).toBeVisible();
    await expect(page.locator("#right-panel")).toHaveCount(0);

    const field = page.locator("#right-panel").getByRole("combobox", { name: "Go to File" });
    await page.keyboard.press("ControlOrMeta+p");
    await expect(page.locator("#right-panel .rpanel-switcher-name")).toHaveText("Files");
    await expect(field).toBeFocused();
    await expect(page.locator("#right-panel .files-list .row").first()).toBeVisible();

    await page.keyboard.press("ControlOrMeta+p");
    await expect(page.locator("#right-panel")).toBeVisible();
    await expect(field).toBeFocused();

    await field.fill("session");
    await expect(page.locator("#right-panel").getByRole("option")).toHaveCount(1);
    await expect(page.locator("#right-panel").getByRole("option")).toHaveAttribute("title", "src/session.ts");
    await field.press("Enter");
    await expect(page.locator("#right-panel .crumbs .crumb.is-current")).toHaveText("session.ts");
  });
});
