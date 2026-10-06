import { expect, test, type Page } from "@playwright/test";

const reader = (page: Page) => page.getByRole("region", { name: /^Session (Preview )?Activity$/ });
const follow = (page: Page) => page.locator(".detail-scroll[data-follow-tail-state]");

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    let frames = 12;
    const next = () => --frames === 0 ? resolve() : requestAnimationFrame(next);
    requestAnimationFrame(next);
  }));
}

async function visibleAnchor(page: Page) {
  return reader(page).evaluate((element) => {
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

async function pause(page: Page) {
  await reader(page).evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.42;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(follow(page)).toHaveAttribute("data-follow-tail-state", "paused");
  await settle(page);
  const anchor = await visibleAnchor(page);
  expect(anchor).not.toBeNull();
  return anchor!;
}

async function expectAnchor(page: Page, anchor: { key: string; offset: number }) {
  await expect(follow(page)).toHaveAttribute("data-follow-tail-state", "paused");
  await expect.poll(async () => (await visibleAnchor(page))?.key).toBe(anchor.key);
  await expect.poll(async () => Math.abs((await visibleAnchor(page))!.offset - anchor.offset)).toBeLessThan(2);
}

async function reads(page: Page, start: number) {
  return page.evaluate((from) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests()
    .slice(from).filter((request) => request.sessionId === "session-alpha"), start);
}

async function open(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html?scenario=paused-history-gap");
  await page.getByRole("tab", { name: /All/ }).click();
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await expect(reader(page).locator("[data-virtual-row]").first()).toBeVisible();
  await expect(reader(page)).toHaveAttribute("aria-busy", "false");
  await settle(page);
  // Begin with an already-hydrated reader, as a resumed session does. The fixture's first Inbox
  // selection can mount before its Store admits the scope, so remount its retained window once.
  await page.getByRole("row", { name: /No Project Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-no-project']")).toBeVisible();
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await expect(reader(page)).toHaveAttribute("aria-busy", "false");
  await settle(page);
}

async function hideAndGap(page: Page, lastSeq: number, hold?: "forward" | "tail") {
  await page.getByRole("row", { name: /No Project Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-no-project']")).toBeVisible();
  await page.evaluate(({ lastSeq, hold }) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSyntheticSessionGap("session-alpha", lastSeq);
    if (hold) window.__WOLLIPOG_PROJECT_INBOX_E2E__.holdSyntheticHistoryRead(hold);
  }, { lastSeq, hold });
  const start = await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests().length);
  await page.getByRole("row", { name: /Alpha Session/ }).click();
  await expect(page.locator("[data-session-surface-id='session-alpha']")).toBeVisible();
  return start;
}

async function reconnectWithGap(page: Page, lastSeq: number) {
  const start = await page.evaluate((lastSeq) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSyntheticSessionGap("session-alpha", lastSeq);
    const start = window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests().length;
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.reconnectSyntheticHistory();
    return start;
  }, lastSeq);
  return start;
}

async function boundedRecovery(page: Page, start: number, firstCursor = 56) {
  // StrictMode's cancelled mount rehearsal may fetch the first page once more. It does not own
  // the four-page recovery chain. Reject a sixth attempt promptly instead of hydrating the gap.
  await expect.poll(async () => {
    const requests = await reads(page, start);
    return requests.filter((request) => request.direction !== "backward").length > 5 ||
      requests.some((request) => request.direction === "backward" && request.after === 0);
  }).toBe(true);
  const requests = await reads(page, start);
  const forward = requests.filter((request) => request.direction !== "backward");
  expect(forward.length).toBeLessThanOrEqual(5);
  const cursors = [...new Set(forward.map((request) => request.after))];
  expect(cursors).toHaveLength(4);
  expect(cursors).toEqual([firstCursor, firstCursor + 200, firstCursor + 400, firstCursor + 600]);
  expect(forward.filter((request) => request.after === cursors[0]).length).toBeLessThanOrEqual(2);
  for (const cursor of cursors.slice(1)) expect(forward.filter((request) => request.after === cursor)).toHaveLength(1);
  expect(requests.filter((request) => request.direction === "backward" && request.after === 0)).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Load Later Activity", exact: true })).toBeVisible();
  await expect(reader(page)).toHaveAttribute("aria-busy", "false");
  const settled = await reads(page, start);
  await page.waitForTimeout(350);
  expect(await reads(page, start)).toEqual(settled);
  return settled;
}

async function resumeLatest(page: Page, lastSeq: number, start: number) {
  const before = await reads(page, start);
  await reader(page).focus();
  await page.keyboard.press("End");
  await expect(follow(page)).toHaveAttribute("data-follow-tail-state", "following");
  await expect(reader(page).getByText(new RegExp(`Synthetic response ${lastSeq}\\.`))).toBeVisible();
  await settle(page);
  expect(await reads(page, start)).toEqual(before);
  await expect(page.getByRole("button", { name: "Load Later Activity", exact: true })).toHaveCount(0);
}

test("an initially empty reader populated by live events can pause and recover a large gap within the same bound", async ({ page }) => {
  const path = `/sessions/~${Buffer.from("session-alpha", "utf16le").toString("base64url")}`;
  await page.goto(`/command-inbox-projects-e2e.html?scenario=paused-history-gap&initialEmpty=1&sessionShell=1&path=${encodeURIComponent(path)}`);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.sessionEventPageRequests()
    .some((request) => request.sessionId === "session-alpha" && request.direction === "backward" && request.after === 0))).toBe(true);
  await expect(reader(page)).toHaveAttribute("aria-busy", "false");
  await expect(reader(page).locator("[data-virtual-row]")).toHaveCount(0);
  await page.evaluate(() => {
    for (let index = 1; index <= 16; index++) {
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitSessionEvent("session-alpha", index % 2 === 1
        ? { kind: "user_message", text: `Public live question ${index}.`, turnId: `empty-reader-turn-${index}` }
        : { kind: "agent_message", text: `Public live response ${index}. ${"Live context gives the reader room to pause. ".repeat(12)}`,
            final: true, messageId: `empty-reader-message-${index}` });
    }
  });
  await expect(reader(page).getByText(/^Public live response 16\./)).toBeVisible();
  await settle(page);
  const anchor = await pause(page);
  const start = await reconnectWithGap(page, 1_000_000);
  const background = await boundedRecovery(page, start, 16);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expectAnchor(page, anchor);
  await page.getByRole("button", { name: "Load Later Activity", exact: true }).click();
  await expect.poll(async () => (await reads(page, start)).length).toBe(background.length + 1);
  await expect(page.getByRole("button", { name: "Load Later Activity", exact: true })).toBeEnabled();
  await expectAnchor(page, anchor);
  expect((await reads(page, start)).at(-1)?.after).toBe(816);
  await resumeLatest(page, 1_000_000, start);
});

for (const lastSeq of [10_000, 1_000_000]) {
  test(`a paused reader recovers a ${lastSeq}-event gap within a fixed budget, then reads later activity`, async ({ page }) => {
    await open(page);
    const anchor = await pause(page);
    const start = await reconnectWithGap(page, lastSeq);
    const background = await boundedRecovery(page, start);
    await expectAnchor(page, anchor);
    const loadLater = page.getByRole("button", { name: "Load Later Activity", exact: true });
    await loadLater.click();
    await expect.poll(async () => (await reads(page, start)).length).toBe(background.length + 1);
    await expect(loadLater).toBeEnabled();
    await expectAnchor(page, anchor);
    const later = (await reads(page, start)).at(-1)!;
    expect(later.direction).toBeUndefined();
    expect(later.after).toBe(856);
    await resumeLatest(page, lastSeq, start);
  });
}

test("pausing during forward recovery preserves the chosen row while the remaining work stays bounded", async ({ page }) => {
  await open(page);
  const start = await hideAndGap(page, 10_000, "forward");
  await expect.poll(async () => (await reads(page, start)).some((request) => request.direction !== "backward")).toBe(true);
  const anchor = await pause(page);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.releaseSyntheticHistoryRead());
  await boundedRecovery(page, start);
  await expectAnchor(page, anchor);
  await resumeLatest(page, 10_000, start);
});

test("pausing while the current tail is pending retains the reader's window", async ({ page }) => {
  await open(page);
  const start = await hideAndGap(page, 10_000, "tail");
  await expect.poll(async () => new Set((await reads(page, start))
    .filter((request) => request.direction !== "backward").map((request) => request.after)).size).toBe(4);
  await expect.poll(async () => (await reads(page, start)).some((request) => request.direction === "backward")).toBe(true);
  const anchor = await pause(page);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.releaseSyntheticHistoryRead());
  await boundedRecovery(page, start);
  await expectAnchor(page, anchor);
  await resumeLatest(page, 10_000, start);
});

test("a late tail from a replaced epoch cannot resurrect the old gap", async ({ page }) => {
  await open(page);
  await pause(page);
  const start = await hideAndGap(page, 10_000, "tail");
  await expect.poll(async () => (await reads(page, start)).some((request) => request.direction === "backward")).toBe(true);
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionEventHistory("session-alpha",
      Array.from({ length: 48 }, (_, index) => ({ kind: "agent_message" as const,
        text: `Replacement epoch response ${index + 1}.`, final: true, messageId: `replacement-${index + 1}` })));
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.releaseSyntheticHistoryRead();
  });
  // An epoch reset keeps the reader's paused intent while replacing its old sequence space.
  await expect(reader(page).getByText(/^Replacement epoch response /).first()).toBeVisible();
  await reader(page).focus();
  await page.keyboard.press("End");
  await expect(reader(page).getByText("Replacement epoch response 48.")).toBeVisible();
  await settle(page);
  await expect(reader(page).getByText(/Synthetic response 10000\./)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load Later Activity", exact: true })).toHaveCount(0);
});

test("live activity after a staged tail stays available once without skipping the paused gap", async ({ page }) => {
  await open(page);
  const anchor = await pause(page);
  const start = await reconnectWithGap(page, 10_000);
  await boundedRecovery(page, start);
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitAgentMessage(
    "session-alpha", "Public live response after the staged tail.",
  ));
  await settle(page);
  await expectAnchor(page, anchor);
  const before = await reads(page, start);
  await reader(page).focus();
  await page.keyboard.press("End");
  await expect(reader(page).getByText("Public live response after the staged tail.")).toBeVisible();
  await expect(reader(page).getByText("Public live response after the staged tail.")).toHaveCount(1);
  expect(await reads(page, start)).toEqual(before);
});

for (const hold of ["forward", "tail"] as const) {
  test(`live activity received while the ${hold} page is held preserves the paused gap and appears once on resume`, async ({ page }) => {
    await open(page);
    const anchor = await pause(page);
    await page.evaluate((hold) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.holdSyntheticHistoryRead(hold), hold);
    const start = await reconnectWithGap(page, 10_000);
    await expect.poll(async () => (await reads(page, start)).some((request) =>
      hold === "tail" ? request.direction === "backward" : request.direction !== "backward",
    )).toBe(true);
    const liveText = `Public live response received during the held ${hold} page.`;
    await page.evaluate((text) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitAgentMessage("session-alpha", text), liveText);
    await settle(page);
    await expectAnchor(page, anchor);
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.releaseSyntheticHistoryRead());
    await boundedRecovery(page, start);
    await expectAnchor(page, anchor);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    const before = await reads(page, start);
    await reader(page).focus();
    await page.keyboard.press("End");
    await expect(follow(page)).toHaveAttribute("data-follow-tail-state", "following");
    await expect(reader(page).getByText(liveText, { exact: true })).toBeVisible();
    await expect(reader(page).getByText(liveText, { exact: true })).toHaveCount(1);
    await settle(page);
    expect(await reads(page, start)).toEqual(before);
  });
}

test("a mobile paused reader keeps its row while the reachable later-history control loads one page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const path = `/sessions/~${Buffer.from("session-alpha", "utf16le").toString("base64url")}`;
  await page.goto(`/command-inbox-projects-e2e.html?scenario=paused-history-gap&sessionShell=1&path=${encodeURIComponent(path)}`);
  await expect(reader(page).locator("[data-virtual-row]").first()).toBeVisible();
  await expect(reader(page)).toHaveAttribute("aria-busy", "false");
  await settle(page);
  const anchor = await pause(page);
  const start = await reconnectWithGap(page, 1_000_000);
  const background = await boundedRecovery(page, start);
  await expectAnchor(page, anchor);
  const control = page.getByRole("region", { name: "Later Activity" });
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  expect((await reader(page).boundingBox())!.height).toBeGreaterThan(80);
  await page.getByRole("button", { name: "Load Later Activity", exact: true }).click();
  await expect.poll(async () => (await reads(page, start)).length).toBe(background.length + 1);
  await expect(page.getByRole("button", { name: "Load Later Activity", exact: true })).toBeEnabled();
  await expectAnchor(page, anchor);
  const before = await reads(page, start);
  await page.getByRole("button", { name: "Jump to Latest", exact: true }).click();
  await expect(reader(page).getByText(/Synthetic response 1000000\./)).toBeVisible();
  await expect(reader(page)).toBeFocused();
  expect(await reads(page, start)).toEqual(before);
});

test("finishing later paging returns focus to the reader without moving its paused row", async ({ page }) => {
  await open(page);
  const anchor = await pause(page);
  const start = await reconnectWithGap(page, 1_000);
  await boundedRecovery(page, start);
  await expectAnchor(page, anchor);
  const load = page.getByRole("button", { name: "Load Later Activity", exact: true });
  await load.click();
  await expect(load).toHaveCount(0);
  await expect(reader(page)).toBeFocused();
  await expectAnchor(page, anchor);
  expect((await reads(page, start)).filter((request) => request.direction !== "backward").at(-1)?.after).toBe(856);
  const beforeLive = await reads(page, start);
  const liveText = "Public live response after later paging completely bridged the gap.";
  await page.evaluate((text) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitAgentMessage("session-alpha", text), liveText);
  await settle(page);
  await expectAnchor(page, anchor);
  await reader(page).focus();
  await page.keyboard.press("End");
  await expect(follow(page)).toHaveAttribute("data-follow-tail-state", "following");
  await expect(reader(page).getByText(liveText, { exact: true })).toBeVisible();
  await expect(reader(page).getByText(liveText, { exact: true })).toHaveCount(1);
  await settle(page);
  expect(await reads(page, start)).toEqual(beforeLive);
});
