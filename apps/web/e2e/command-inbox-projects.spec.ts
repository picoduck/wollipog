import { expect, test, type Locator, type Page } from "@playwright/test";

async function controlGeometry(control: Locator) {
  return control.evaluate((element) => {
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
}

async function openProjectManager(page: Page, projectName = "Alpha") {
  await page.getByRole("tab", { name: new RegExp(projectName) }).hover();
  await page.getByRole("button", { name: `Project Actions for ${projectName}` }).click();
  await page.getByRole("menuitem", { name: /Manage Project/ }).click();
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
  await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "paused");
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
    expect((await inboxViewportAnchor(page)).scrollTop).toBe(0);
    expect(await list.locator(".inbox-row-title").allTextContents()).toEqual(initialTitles);

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
  await page.goto("/command-inbox-projects-e2e.html?scenario=inbox-live-scroll");
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

  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-overflow-35", {
      lastEventAt: 2_000,
      preview: "Newest activity is waiting for deliberate order adoption.",
      status: "running",
    });
  });
  const applyOrder = page.getByRole("button", { name: "Apply New Order" });
  await expect(applyOrder).toBeVisible();
  const before = await inboxViewportAnchor(page);
  expect(before.key).not.toBeNull();

  await applyOrder.click();
  await settlePreviewLayout(page);
  await expect(applyOrder).toHaveCount(0);
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

test("real Inbox preview paging keeps ownership while live output streams", async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html?scenario=preview-follow");
  const reader = page.getByRole("region", { name: "Session Preview Activity" });
  const follow = page.locator(".follow-tail-chip");
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

  await page.getByRole("button", { name: "Expand Session" }).click();
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
  const follow = page.locator(".follow-tail-chip");
  await expect(reader.locator("[data-virtual-row]").first()).toBeVisible();
  await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeLessThanOrEqual(2);
  await page.locator(".inbox-list").focus();
  const before = await settledPreviewScrollMetrics(page);

  await page.keyboard.press("Shift+Space");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");
  await expect.poll(async () => (await previewScrollMetrics(page)).scrollTop)
    .toBeLessThan(before.scrollTop - before.clientHeight * 0.35);
  const anchor = await previewVisibleAnchor(page);
  expect(anchor).not.toBeNull();
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitAgentMessage(
      "session-alpha",
      "Reduced-motion streamed output must leave the preview viewport untouched. ".repeat(12),
    );
  });
  await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");
  await expect.poll(async () => (await previewVisibleAnchor(page))?.key).toBe(anchor!.key);
  await expect.poll(async () => Math.abs((await previewVisibleAnchor(page))!.offset - anchor!.offset)).toBeLessThan(12);
});

test("real Inbox reading hints and resume keys match preview and expanded follow state", async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html?scenario=preview-follow");
  let reader = page.getByRole("region", { name: "Session Preview Activity" });
  const strip = page.locator(".transcript-status-strip");
  const follow = page.locator(".follow-tail-chip");
  const pageUp = strip.locator('[data-shortcut-hint="Shift+Space"]');
  const pageDown = strip.locator('[data-shortcut-hint="Space"]');
  const resume = strip.locator('[data-shortcut-hint="Shift+G"]');
  await expect(reader.locator("[data-virtual-row]").first()).toBeVisible();
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");
  await expect(pageUp).toHaveText("Page UpShift+Space");
  await expect(pageDown).toHaveCount(0);
  await expect(resume).toHaveCount(0);

  await reader.focus();
  await page.keyboard.press("k");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");

  await page.locator(".inbox-list").focus();
  await page.keyboard.press("Shift+Space");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");
  await expect(pageDown).toHaveText("SpacePage Down");
  await expect(pageDown).toBeVisible();
  // The resume keycap renders INSIDE the follow-state control; the chord reaches assistive tech
  // through the control's tooltip rather than a separate described-by hint.
  await expect(resume).toHaveText("Shift+G");
  await expect(resume).toBeVisible();
  await expect(follow.locator('[data-shortcut-hint="Shift+G"]')).toHaveCount(1);
  expect(await follow.getAttribute("title")).toContain("Shift+G");
  // The whole pager cluster is centered in the strip, and its hints sit directly beside the
  // control at the standard inter-control gap — bounded, not merely present (IDEA-007 2026-08-10).
  const cluster = page.locator(".follow-tail-control");
  const [stripBox, clusterBox, pageUpBox, followBox, pageDownBox] = await Promise.all([
    strip.boundingBox(), cluster.boundingBox(), pageUp.boundingBox(), follow.boundingBox(), pageDown.boundingBox(),
  ]);
  expect(stripBox).not.toBeNull();
  expect(clusterBox).not.toBeNull();
  expect(pageUpBox).not.toBeNull();
  expect(followBox).not.toBeNull();
  expect(pageDownBox).not.toBeNull();
  expect(Math.abs(
    (clusterBox!.x + clusterBox!.width / 2) - (stripBox!.x + stripBox!.width / 2),
  )).toBeLessThan(2);
  const leadingGap = followBox!.x - (pageUpBox!.x + pageUpBox!.width);
  const trailingGap = pageDownBox!.x - (followBox!.x + followBox!.width);
  expect(leadingGap).toBeGreaterThanOrEqual(0);
  expect(leadingGap).toBeLessThanOrEqual(24);
  expect(trailingGap).toBeGreaterThanOrEqual(0);
  expect(trailingGap).toBeLessThanOrEqual(24);

  await page.keyboard.press("Shift+G");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeLessThanOrEqual(2);
  await expect(pageDown).toHaveCount(0);
  await expect(resume).toHaveCount(0);

  await page.keyboard.press("Shift+Space");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "previewing");
  await page.keyboard.press("End");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "following");
  await expect.poll(async () => (await previewScrollMetrics(page)).distanceFromTail).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "Expand Session" }).click();
  await expect(page.locator(".inbox-view.expanded")).toBeVisible();
  await expect(page.locator(".inbox-list-pane")).toHaveAttribute("inert", "");
  reader = page.getByRole("region", { name: "Session Activity" });
  await expect(reader).toBeVisible();
  await reader.focus();
  await page.keyboard.press("Shift+Space");
  await expect(follow).toHaveAttribute("data-follow-tail-state", "paused");
  await expect(resume).toHaveText("Shift+G");
  await expect(pageUp).toHaveCount(0);
  const reply = strip.locator('button.shortcut-hint-button[data-shortcut-hint="R"]');
  await expect(reply).toBeVisible();
  const [expandedResumeBox, replyBox] = await Promise.all([resume.boundingBox(), reply.boundingBox()]);
  expect(expandedResumeBox).not.toBeNull();
  expect(replyBox).not.toBeNull();
  expect(expandedResumeBox!.x + expandedResumeBox!.width).toBeLessThan(replyBox!.x);
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
  const follow = page.locator(".follow-tail-chip");

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
    for (let index = 0; index < 4; index += 1) {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitAgentMessage(
        "session-alpha",
        `Hidden Alpha output ${index + 1}. ${"The durable fixture must survive cache pruning. ".repeat(10)}`,
      );
    }
    const alpha = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
      .find((session) => session.id === "session-alpha");
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      eventEpoch: (alpha?.eventEpoch ?? 0) + 1,
    });
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
    for (let index = 0; index < 3; index += 1) {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitAgentMessage(
        "session-no-project",
        `Hidden No Project output ${index + 1}. ${"Each session retains its own logical reading position. ".repeat(10)}`,
      );
    }
    const noProject = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
      .find((session) => session.id === "session-no-project");
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-no-project", {
      eventEpoch: (noProject?.eventEpoch ?? 0) + 1,
    });
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
    const alpha = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
      .find((session) => session.id === "session-alpha");
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      eventEpoch: (alpha?.eventEpoch ?? 0) + 1,
    });
  });
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-alpha']")).toBeVisible();
  await page.getByRole("button", { name: "Expand Session" }).click();
  const expandedReader = page.getByRole("region", { name: "Session Activity" });
  await expect(expandedReader.locator("[data-virtual-total='12']")).toBeVisible();
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
  expect(moved!.key).not.toBe(original.key);

  await expect(expandedReader.locator("[data-virtual-total='12']")).toBeVisible();
  await page.getByRole("button", { name: "Back to Inbox" }).click();
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
  await expect(page.locator(".follow-tail-chip")).toHaveAttribute("data-follow-tail-state", "paused");
});

test("Inbox titles keep one reading axis across row signals, widths, and densities", async ({ page }) => {
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", {
      name: "Alpha Project with an intentionally long display name",
    });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", { status: "running" });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-secret", { status: "starting" });
  });
  await page.getByRole("tab", { name: /^All\d/ }).click();
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
        const senderText = sender.querySelector<HTMLElement>("span")!;
        const signals = row.querySelector<HTMLElement>(".inbox-row-signals")!;
        return {
          titleX: title.getBoundingClientRect().left,
          senderWidth: sender.getBoundingClientRect().width,
          senderOverflows: senderText.scrollWidth > senderText.clientWidth,
          signalsWidth: signals.getBoundingClientRect().width,
        };
      }));

      expect(Math.max(...geometry.map(({ titleX }) => titleX)) - Math.min(...geometry.map(({ titleX }) => titleX)))
        .toBeLessThanOrEqual(1);
      expect(Math.max(...geometry.map(({ senderWidth }) => senderWidth)) - Math.min(...geometry.map(({ senderWidth }) => senderWidth)))
        .toBeLessThanOrEqual(1);
      expect(Math.max(...geometry.map(({ signalsWidth }) => signalsWidth)) - Math.min(...geometry.map(({ signalsWidth }) => signalsWidth)))
        .toBeGreaterThan(8);
      expect(geometry.some(({ senderOverflows }) => senderOverflows)).toBe(true);
    }
  }
});

test("archiving the final session keeps its Project selected live and after reload", async ({ page }) => {
  const alpha = page.getByRole("tab", { name: /Alpha/ });
  await alpha.click();
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "Archive and Stop All Sessions" }).click();
  const confirmation = page.getByRole("dialog", { name: "Archive and stop 1 session?" });
  await confirmation.getByRole("button", { name: "Archive and Stop" }).click();

  await expect(alpha).toHaveAttribute("aria-selected", "true");
  await expect(alpha).toContainText("0");
  await expect(page.getByText("No Sessions Yet", { exact: true })).toBeVisible();
  await expect(page.getByText("Start a session in Alpha.", { exact: true })).toBeVisible();

  await page.reload();
  const reloadedAlpha = page.getByRole("tab", { name: /Alpha/ });
  await expect(reloadedAlpha).toBeVisible();
  await expect(reloadedAlpha).toContainText("0");
});

test("Project launch actions submit stable Project and Location identity", async ({ page }) => {
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();

  const dialog = page.getByRole("dialog", { name: "New Session" });
  await expect(dialog.getByLabel("Project", { exact: true })).toHaveValue("alpha");
  await expect(dialog.getByRole("radiogroup", { name: "Project Location" }).getByRole("radio", { name: /\/repos\/alpha$/ }))
    .toHaveAttribute("aria-checked", "true");
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
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "Create Permanent Worktree" }).click();
  const worktreeDialog = page.getByRole("dialog", { name: "New Session" });
  await expect(worktreeDialog.getByLabel("Project", { exact: true })).toHaveValue("alpha");
  await worktreeDialog.getByRole("button", { name: "Create Session" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
    .toMatchObject({
      projectId: "alpha",
      projectLocationId: "location-alpha",
      useWorktree: true,
    });
});

test("Native TUI launch sends the harness intent and opens Terminal only after creation", async ({ page }) => {
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();

  const dialog = page.getByRole("dialog", { name: "New Session" });
  const harness = dialog.getByRole("radiogroup", { name: "Harness" });
  await expect(harness.getByRole("radio", { name: /Direct/ })).toHaveAttribute("aria-checked", "true");
  await harness.getByRole("radio", { name: /Native TUI/ }).click();
  await dialog.getByRole("button", { name: "Create Session" }).click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()?.launchSurface))
    .toBe("native_tui");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.terminalOpenCount()))
    .toBe(1);
  await expect(page.getByRole("tab", { name: "Agent TUI" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Manager policy hooks remain active" })).toHaveText(
    "No structured events or approval cards. Manager policy hooks remain active.",
  );
});

test("unified Inbox creation opens both existing workflows with the active Project context", async ({ page }) => {
  await page.getByRole("tab", { name: /Alpha/ }).click();
  const create = page.getByRole("button", { name: "Create", exact: true });

  await create.click();
  const choices = page.getByRole("menu", { name: "Create" });
  await expect(choices.getByRole("menuitem").allTextContents()).resolves.toEqual(["New Session", "New Project"]);
  await choices.getByRole("menuitem", { name: "New Session", exact: true }).click();
  const sessionDialog = page.getByRole("dialog", { name: "New Session" });
  await expect(sessionDialog.getByLabel("Project", { exact: true })).toHaveValue("alpha");
  await page.keyboard.press("Escape");
  await expect(sessionDialog).toBeHidden();
  await expect(create).toBeFocused();

  await create.click();
  await page.getByRole("menuitem", { name: "New Project", exact: true }).click();
  const projectDialog = page.getByRole("dialog", { name: "Create Project" });
  await expect(projectDialog).toBeVisible();
  await projectDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(create).toBeFocused();
});

test("unified Inbox creation choices remain usable at a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const create = page.getByRole("button", { name: "Create", exact: true });
  await expect(create).toBeVisible();

  await create.click();
  await page.getByRole("menuitem", { name: "New Session", exact: true }).click();
  const sessionDialog = page.getByRole("dialog", { name: "New Session" });
  await expect(sessionDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sessionDialog).toBeHidden();
  await expect(create).toBeFocused();

  await create.click();
  await page.getByRole("menuitem", { name: "New Project", exact: true }).click();
  const projectDialog = page.getByRole("dialog", { name: "Create Project" });
  await expect(projectDialog).toBeVisible();
  await projectDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(create).toBeFocused();
});

test("C defaults New Session to the active single-Project Inbox tab", async ({ page }) => {
  const alphaTab = page.getByRole("tab", { name: /Alpha/ });
  await alphaTab.click();
  await expect(alphaTab).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "New Session" });
  await expect(dialog.getByLabel("Project", { exact: true })).toHaveValue("alpha");
  await expect(dialog.getByRole("radiogroup", { name: "Project Location" })
    .getByRole("radio", { name: /\/repos\/alpha$/ })).toHaveAttribute("aria-checked", "true");
});

test("New Session control labels retain centred, unclipped browser geometry", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    for (const viewport of [
      { name: "mobile", width: 390, height: 844, touchMinimum: true },
      { name: "desktop", width: 1280, height: 900, touchMinimum: false },
    ] as const) {
      await page.setViewportSize(viewport);
      await page.goto("/command-inbox-projects-e2e.html");
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.getByRole("tab", { name: /Alpha/ }).click();
      await page.keyboard.press("c");

      const dialog = page.getByRole("dialog", { name: "New Session" });
      const controls = [
        dialog.getByRole("button", { name: "Create Project…" }),
        dialog.getByRole("button", { name: "Add Location…" }),
        dialog.getByLabel("Agent"),
      ];
      const geometry = await Promise.all(controls.map(controlGeometry));

      for (const control of geometry) {
        expect(control.paddingTop - control.paddingBottom,
          `${viewport.name} ${theme} controls optically offset their line box`).toBe(2);
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

  const dialog = page.getByRole("dialog", { name: "New Session" });
  const controls = [
    dialog.getByRole("button", { name: "Create Project…" }),
    dialog.getByRole("button", { name: "Add Location…" }),
    dialog.getByLabel("Agent"),
  ];
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByLabel("Agent").evaluate((element) => {
    const selected = (element as HTMLSelectElement).selectedOptions[0];
    if (selected) selected.textContent = "Áccented Agent With Descenders ģyq — Extended Name";
  });
  await page.addStyleTag({
    content: ".new-session-project-control, .new-session-agent-control { font-size: 24px !important; }",
  });
  const enlargedGeometry = await Promise.all(controls.map(controlGeometry));
  for (const control of enlargedGeometry) {
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.scrollHeight, "enlarged control text is not vertically clipped").toBeLessThanOrEqual(control.clientHeight);
  }
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
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
  await expect(page.getByRole("menuitem", { name: "Reveal in File Manager" })).toBeDisabled();
  await page.getByRole("menuitem", { name: "New Session", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "New Session" });
  const locations = dialog.getByRole("radiogroup", { name: "Project Location" });
  const first = locations.getByRole("radio", { name: /\/repos\/alpha$/ });
  const second = locations.getByRole("radio", { name: /\/repos\/alpha-secondary$/ });
  await expect(first).toHaveAttribute("aria-checked", "false");
  await expect(second).toHaveAttribute("aria-checked", "false");
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
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();
  const newSession = page.getByRole("dialog", { name: "New Session" });
  await newSession.getByRole("button", { name: /Create Project/ }).click();

  await expect(newSession).toBeHidden();
  const createProject = page.getByRole("dialog", { name: "Create Project" });
  await createProject.getByLabel("Project Name").fill("Inline Project");
  await createProject.getByRole("button", { name: "Create Project" }).click();

  await expect(newSession).toBeVisible();
  await expect(newSession.getByLabel("Project", { exact: true })).toHaveValue("project-4");
  await expect(newSession.getByText("No Project Locations", { exact: true })).toBeVisible();
  await newSession.getByRole("button", { name: /Add Location/ }).click();

  const addLocation = page.getByRole("dialog", { name: "Add Location to Inline Project" });
  const loose = addLocation.getByRole("listitem").filter({ hasText: "/repos/loose" });
  await loose.getByRole("button", { name: "Add to Project" }).click();
  await expect(newSession).toBeVisible();
  await expect(newSession.getByRole("radiogroup", { name: "Project Location" }).getByRole("radio", { name: /\/repos\/loose$/ }))
    .toHaveAttribute("aria-checked", "true");
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
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();
  const newSession = page.getByRole("dialog", { name: "New Session" });
  await newSession.getByRole("button", { name: /Create Project/ }).click();
  const createProject = page.getByRole("dialog", { name: "Create Project" });
  await createProject.getByLabel("Project Name").fill("Temporary Inline Project");
  await createProject.getByRole("button", { name: "Create Project" }).click();

  await expect(newSession.getByLabel("Project", { exact: true })).toHaveValue("project-4");
  await expect(page.getByRole("tab", { name: /Temporary Inline Project/ })).toBeVisible();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.removeProject("project-4"));

  await expect(newSession.getByLabel("Project", { exact: true }).locator('option[value="project-4"]')).toHaveCount(0);
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
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();
  const dialog = page.getByRole("dialog", { name: "New Session" });
  const projectSelect = dialog.getByLabel("Project", { exact: true });
  const locationChoices = dialog.getByRole("radiogroup", { name: "Project Location" });

  await expect(projectSelect.locator("option").filter({ hasText: "Alpha" })).toHaveCount(2);
  await expect(locationChoices.getByRole("radio")).toHaveCount(2);
  await expect(locationChoices.getByRole("radio", { name: /\/repos\/alpha$/ })).toHaveAttribute("aria-checked", "true");

  await projectSelect.selectOption("gamma");
  await expect(dialog.getByText("No Project Locations", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create Session" })).toBeDisabled();

  await projectSelect.selectOption("offline");
  await expect(dialog.getByText(/No Locations are currently available/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create Session" })).toBeDisabled();

  await projectSelect.selectOption("alpha-copy");
  await expect(dialog.getByRole("radiogroup", { name: "Project Location" }).getByRole("radio", { name: /\/repos\/alpha-copy$/ }))
    .toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "Create Session" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.lastCreateSessionRequest()))
    .toMatchObject({ projectId: "alpha-copy", projectLocationId: "location-alpha-copy" });
});

/** The persistent vertical-ellipsis trigger beside the Project crumb owns the Move Session menu. */
async function openMoveToProjectDialog(page: Page) {
  await page.getByRole("button", { name: "Project Actions" }).click();
  await page.getByRole("menuitem", { name: "Move Session…" }).click();
  return page.getByRole("dialog", { name: "Move to Project" });
}

test("the Project crumb navigates independently beside persistent Project Actions", async ({ page }) => {
  // A longer name keeps its click region separate from the compact trailing actions gutter.
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { name: "Alpha Project" }));
  await page.getByRole("tab", { name: /^All\d/ }).click();
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Expand Session" }).click();
  const projectChip = page.locator(".detail-crumbs .cctx-chip").filter({ hasText: "Alpha Project" });
  await expect(projectChip).toBeVisible();
  await expect(projectChip).not.toHaveAttribute("aria-haspopup", /.+/);

  // The vertical-ellipsis trigger stays visible in the crumb's reserved trailing gutter without
  // covering the Project navigation button.
  const actions = page.getByRole("button", { name: "Project Actions" });
  const projectCrumb = page.locator(".crumb-project");
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(actions).toHaveCSS("pointer-events", "auto");
  const dotGeometry = await actions.locator("circle").evaluateAll((dots) => dots
    .map((dot) => ({
      x: Number.parseFloat(dot.getAttribute("cx") ?? "NaN"),
      y: Number.parseFloat(dot.getAttribute("cy") ?? "NaN"),
    }))
    .sort((a, b) => a.y - b.y));
  expect(dotGeometry).toEqual([
    { x: 12, y: 5 },
    { x: 12, y: 12 },
    { x: 12, y: 19 },
  ]);
  const [crumbBox, chipBox, actionsBox] = await Promise.all([
    projectCrumb.boundingBox(),
    projectChip.boundingBox(),
    actions.boundingBox(),
  ]);
  expect(crumbBox).not.toBeNull();
  expect(chipBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox!.x).toBeGreaterThanOrEqual(chipBox!.x + chipBox!.width - 1);
  expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(crumbBox!.x + crumbBox!.width + 1);

  const defaultStyle = await actions.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage };
  });
  await actions.hover();
  await expect.poll(() => actions.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(defaultStyle.backgroundColor);
  await expect(actions).toHaveCSS("background-image", defaultStyle.backgroundImage);
  const hoverBackground = await actions.evaluate((element) => getComputedStyle(element).backgroundColor);

  const actionsCenter = { x: actionsBox!.x + actionsBox!.width / 2, y: actionsBox!.y + actionsBox!.height / 2 };
  await page.mouse.move(actionsCenter.x, actionsCenter.y);
  await page.mouse.down();
  await expect.poll(() => actions.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(hoverBackground);
  const activeBackground = await actions.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(activeBackground).not.toBe(defaultStyle.backgroundColor);
  await page.mouse.up();

  // The trigger opens a small menu rather than a dialog directly.
  const actionsMenu = page.getByRole("menu", { name: "Project Actions" });
  await expect(actionsMenu.getByRole("menuitem", { name: "Manage Project" })).toBeVisible();
  await expect(actionsMenu.getByRole("menuitem", { name: "Move Session…" })).toBeVisible();
  await expect(actions).toHaveAttribute("aria-expanded", "true");
  const openStyle = await actions.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage };
  });
  expect(openStyle.backgroundColor).not.toBe(defaultStyle.backgroundColor);
  expect(openStyle.backgroundImage).toBe("none");
  await page.keyboard.press("Escape");
  await expect(actionsMenu).toBeHidden();
  await expect(actions).toBeFocused();

  await projectChip.focus();
  await page.keyboard.press("Tab");
  await expect(actions).toBeFocused();
  const focusStyle = await actions.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth) };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2);

  // Cancelling the Move dialog restores focus to the durable ⋯ trigger, not the removed
  // menu item and not the page heading (regression coverage).
  const moveDialog = await openMoveToProjectDialog(page);
  await page.keyboard.press("Escape");
  await expect(moveDialog).toBeHidden();
  await expect(actions).toBeFocused();

  await projectChip.click({ position: { x: 8, y: 8 } });
  await expect(page.locator(".inbox-view.expanded")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /Alpha/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("row", { name: /Alpha Session/ })).toBeVisible();
});

test("session Project assignment changes organization without changing execution Location", async ({ page }) => {
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Expand Session" }).click();
  const projectChip = page.locator(".detail-crumbs .cctx-chip").filter({ hasText: "Alpha" });
  await expect(projectChip).toBeVisible();
  let dialog = await openMoveToProjectDialog(page);
  await expect(dialog.getByText(
    "Changing this organizes the session without moving files or changing its execution Location. Team sharing is confirmed separately.",
  ))
    .toBeVisible();
  await dialog.getByRole("radio", { name: /No Project/ }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    const value = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions.find((session) => session.id === "session-alpha");
    return [value?.projectId, value?.projectLocationId, value?.workspaceId];
  })).toEqual([null, null, "alpha-workspace"]);

  await expect(page.locator(".detail-crumbs .cctx-chip").filter({ hasText: "No Project" })).toBeVisible();
  dialog = await openMoveToProjectDialog(page);
  await dialog.getByRole("radio", { name: /Alpha/ }).click();
  await expect.poll(() => page.evaluate(() => {
    const value = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions.find((session) => session.id === "session-alpha");
    return [value?.projectId, value?.projectLocationId, value?.workspaceId];
  })).toEqual(["alpha", "location-alpha", "alpha-workspace"]);
  // A successful move closes the dialog and hands focus back to the ⋯ trigger.
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Project Actions" })).toBeFocused();
});

test("an imported session can link its verified Location while moving to a managed Project", async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html?scenario=imported-location");

  await page.getByRole("tab", { name: /No Project/ }).click();
  await page.getByRole("row", { name: /No Project Session/ }).click();
  await page.getByRole("button", { name: "Expand Session" }).click();
  const moveDialog = await openMoveToProjectDialog(page);
  const gammaChoice = moveDialog.getByRole("radio", { name: /Gamma/ });
  await expect(gammaChoice).toContainText("Link this imported Location when moving.");
  await gammaChoice.click();

  const confirmation = page.getByRole("dialog", { name: "Link Location and Move to Gamma?" });
  await expect(confirmation).toContainText("registers the imported working directory as a Location");
  await expect(confirmation).toContainText("can also change how future imported sessions in this directory are filed");
  await confirmation.getByRole("button", { name: "Link Location and Move" }).click();

  await expect(page.locator(".detail-crumbs .cctx-chip").filter({ hasText: "Gamma" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop Turn" })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => {
    const model = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model();
    const value = model.sessions.find((session) => session.id === "session-no-project");
    const gamma = model.projects.find((project) => project.id === "gamma");
    return [value?.projectId, value?.workspaceId, gamma?.locations[0]?.path];
  })).toEqual(["gamma", "loose-workspace", "/repos/loose"]);
});

test("personal sessions require explicit confirmation before joining a team Project", async ({ page }) => {
  await page.evaluate(() => {
    const model = window.__WOLLIPOG_PROJECT_INBOX_E2E__.model();
    const alpha = model.projects.find((project) => project.id === "alpha")!;
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.upsertProject({ ...alpha, audience: "team" });
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession("session-alpha", {
      projectId: null,
      projectName: null,
      projectLocationId: null,
      audience: "user",
    });
  });

  await page.getByRole("tab", { name: /No Project/ }).click();
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Expand Session" }).click();
  const moveDialog = await openMoveToProjectDialog(page);
  const alphaChoice = moveDialog.getByRole("radio", { name: /Alpha/ });
  await expect(alphaChoice).toContainText("Team Project. Linked to this exact Location.");
  await alphaChoice.click();

  const confirmation = page.getByRole("dialog", { name: "Share session with Alpha?" });
  await expect(confirmation).toContainText("lets that team read its transcript");
  await expect(confirmation).toContainText("Files and the execution Location stay unchanged.");
  await confirmation.getByRole("button", { name: "Share and Move" }).click();

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
  await page.getByRole("button", { name: "Expand Session" }).click();
  const moveDialog = await openMoveToProjectDialog(page);
  await moveDialog.getByRole("radio", { name: /Alpha/ }).click();

  const confirmation = page.getByRole("dialog", { name: "Confirm move to Alpha?" });
  await expect(confirmation).toContainText("does not report sharing details");
  await expect(confirmation).toContainText("may change who can read its transcript");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
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
  await expect(page.getByRole("button", { name: "Project Actions for Alpha" })).toHaveAttribute("tabindex", "0");
  await expect(page.getByRole("button", { name: "Project Actions for Gamma" })).toHaveAttribute("tabindex", "-1");
  const alphaActions = page.getByRole("button", { name: "Project Actions for Alpha" });
  await page.keyboard.press("Tab");
  await expect(alphaActions).toBeFocused();
  await alphaActions.press("Enter");
  const actionsMenu = page.getByRole("menu", { name: "Project Actions for Alpha" });
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
    const trigger = page.getByRole("button", { name: "Project Actions for Alpha" });
    await expect(trigger).toBeVisible();
    const box = await trigger.boundingBox();
    expect(box).not.toBeNull();
    const visibleTarget = await trigger.evaluate((element) => {
      const target = element.getBoundingClientRect();
      const clippingRow = element.closest(".inbox-tabs")!.getBoundingClientRect();
      return {
        width: Math.max(0, Math.min(target.right, clippingRow.right) - Math.max(target.left, clippingRow.left)),
        height: Math.max(0, Math.min(target.bottom, clippingRow.bottom) - Math.max(target.top, clippingRow.top)),
      };
    });
    expect(visibleTarget.width).toBeGreaterThanOrEqual(44);
    expect(visibleTarget.height).toBeGreaterThanOrEqual(44);
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const newSessionHere = page.getByRole("menuitem", { name: "New Session Here" });
    await expect(newSessionHere).toBeVisible();
    const actionBox = await newSessionHere.boundingBox();
    expect(actionBox).not.toBeNull();
    await page.touchscreen.tap(
      actionBox!.x + actionBox!.width / 2,
      actionBox!.y + actionBox!.height / 2,
    );
    await expect(page.getByRole("dialog", { name: "New Session" })).toBeVisible();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

test("Project management creates, hides, reloads, and reveals durable empty Projects", async ({ page }) => {
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Project", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "Create Project" });
  await createDialog.getByLabel("Project Name").fill("Durable Empty");
  await createDialog.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByRole("tab", { name: /Durable Empty/ })).toBeVisible();
  await openProjectManager(page, "Durable Empty");
  await expect(page.getByText("Projects organize related sessions. Locations are folders on connected machines where sessions run.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Durable Empty" })).toBeVisible();
  await expect(page.getByText("No Project Locations", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide Project" }).click();
  await expect(page.getByText("Hidden from Inbox", { exact: true })).toBeVisible();

  await page.reload();
  await openProjectManager(page);
  // `radio`, not `button`: the visibility filter is one choice of three, and it used to announce
  // itself as three independent toggles. That the query had to change is the point of the change.
  await page.getByRole("radio", { name: "Hidden", exact: true }).click();
  await expect(page.getByRole("button", { name: /Durable Empty/ })).toBeVisible();
  await page.getByRole("button", { name: /Durable Empty/ }).click();
  await page.getByRole("button", { name: "Show Project" }).click();
  await expect(page.getByText("Shown in Inbox", { exact: true })).toBeVisible();
});

test("Project management remains usable as a focused list and detail flow on mobile", async ({ page }) => {
  await openProjectManager(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
  const back = page.getByRole("button", { name: "Back to Projects" });
  await expect(back).toBeVisible();
  const box = await back.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await back.click();
  const alpha = page.getByRole("button", { name: /Alpha/ });
  await expect(alpha).toBeVisible();
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeHidden();
  await alpha.click();
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
  await expect(back).toBeVisible();
  await back.click();
  await expect(alpha).toBeVisible();
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeHidden();
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
  await expect(sessionDialog.getByLabel("Project", { exact: true })).toHaveValue("gamma");
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
  await expect(sessionDialog.getByLabel("Project", { exact: true })).toHaveValue("alpha");
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
  const confirmation = page.getByRole("dialog", { name: "Remove Alpha?" });
  await expect(confirmation).toContainText("The folder is not deleted");
  await expect(confirmation).toContainText("other Projects using this Location are unaffected");
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
  const dialog = page.getByRole("dialog", { name: "Delete Alpha?" });
  await expect(dialog).toContainText("Sessions will move to No Project");
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
