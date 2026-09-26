import { expect, test, type Locator, type Page } from "@playwright/test";

const SHOT = "test-results/evidence-artifacts";

async function openReview(page: Page, query: string): Promise<void> {
  await page.goto(`/request-surfaces-e2e.html?scenario=evidence&${query}`);
  await page.getByRole("button", { name: "Review Evidence" }).click();
  await expect(page.getByRole("complementary", { name: "Requests" })).toBeVisible();
}

const artifactRequests = (page: Page) =>
  page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.artifactRequests());

async function playDecodedVideoFrame(video: Locator): Promise<void> {
  const dimensions = await video.evaluate((element: HTMLVideoElement) => [element.videoWidth, element.videoHeight]);
  expect(dimensions).toEqual([320, 180]);
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1.25);
  const presented = await video.evaluate((element: HTMLVideoElement) => new Promise<number>((resolve) => {
    element.requestVideoFrameCallback((_now, metadata) => resolve(metadata.mediaTime));
  }));
  expect(presented).toBeGreaterThan(1);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name}: artifact-backed evidence is reviewed in place and approved without leaving the card`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openReview(page, "items=3&artifacts=ready");

    const first = page.locator(".evidence-review-item").first();
    await expect(first.getByRole("img", { name: "Evidence: viewport-1" })).toBeVisible();
    await expect(page.locator('a[href^="https://evidence.example"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("signature=hidden");
    // The image is inside the panel, not overflowing it.
    const fits = await first.locator(".evidence-artifact-thumb").evaluate((element) => {
      const panel = element.closest(".right-panel, .request-panel-detail")!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return box.left >= panel.left - 1 && box.right <= panel.right + 1 && box.width > 120;
    });
    expect(fits).toBe(true);
    await page.screenshot({ path: `${SHOT}/${viewport.name}-in-place.png` });

    // Enlarge by keyboard, inspect, and return to the same item.
    const thumb = first.getByRole("button", { name: "Enlarge Evidence: viewport-1" });
    await thumb.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "viewport-1" });
    await expect(dialog.getByRole("img", { name: "Evidence: viewport-1" })).toBeVisible();
    await page.screenshot({ path: `${SHOT}/${viewport.name}-enlarged.png` });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(thumb).toBeFocused();

    const approve = page.getByRole("button", { name: "Approve" });
    await expect(approve).toBeDisabled();
    for (const id of ["viewport-1", "viewport-2", "viewport-3"]) {
      const item = page.locator(".evidence-review-item", { hasText: id });
      await item.scrollIntoViewIfNeeded();
      await expect(item.getByRole("img", { name: `Evidence: ${id}` })).toBeVisible();
      await item.getByRole("checkbox", { name: `Mark ${id} as Reviewed` }).check();
    }
    await expect(approve).toBeEnabled();
    await approve.click();
    const submitted = await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions());
    expect(submitted).toHaveLength(1);
    expect((submitted[0] as { evidenceReviewed: string[] }).evidenceReviewed.sort())
      .toEqual(["viewport-1", "viewport-2", "viewport-3"]);
  });

  test(`${viewport.name}: a mismatched and an unavailable artifact read differently and block approval`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openReview(page, "items=3&artifacts=mismatch");
    const swapped = page.locator(".evidence-review-item", { hasText: "viewport-2" });
    await swapped.scrollIntoViewIfNeeded();
    await expect(swapped.getByRole("alert")).toContainText("does not match the digest recorded in the request");
    await expect(swapped.getByRole("img")).toHaveCount(0);
    await expect(swapped.getByRole("checkbox")).toBeDisabled();
    await page.screenshot({ path: `${SHOT}/${viewport.name}-mismatch.png` });

    await openReview(page, "items=3&artifacts=unavailable");
    const gone = page.locator(".evidence-review-item", { hasText: "viewport-2" });
    await gone.scrollIntoViewIfNeeded();
    await expect(gone.getByRole("alert")).toContainText("no longer available, or you do not have access");
    await expect(gone.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(gone.getByRole("checkbox")).toBeDisabled();
    for (const id of ["viewport-1", "viewport-3"]) {
      const item = page.locator(".evidence-review-item", { hasText: id });
      await item.scrollIntoViewIfNeeded();
      await item.getByRole("checkbox").check();
    }
    await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();
    await page.locator(".evidence-review-item", { hasText: "viewport-1" }).getByRole("checkbox").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT}/${viewport.name}-unavailable.png` });
  });
}

test("an artifact that matches its digest but cannot be drawn is never shown and cannot be marked reviewed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReview(page, "items=3&artifacts=undecodable");
  const broken = page.locator(".evidence-review-item", { hasText: "viewport-2" });
  await broken.scrollIntoViewIfNeeded();
  await expect(broken.getByRole("alert")).toHaveText(/matches its recorded digest but could not be displayed\.$/u);
  // No broken-image placeholder is left on screen, and nothing offers to enlarge it.
  await expect(broken.locator("img:visible")).toHaveCount(0);
  await expect(broken.getByRole("button", { name: /Enlarge Evidence/ })).toHaveCount(0);
  await expect(broken.getByRole("checkbox")).toBeDisabled();
  for (const id of ["viewport-1", "viewport-3"]) {
    const item = page.locator(".evidence-review-item", { hasText: id });
    await item.scrollIntoViewIfNeeded();
    await expect(item.getByRole("img", { name: `Evidence: ${id}` })).toBeVisible();
    await item.getByRole("checkbox").check();
  }
  await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
  await broken.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT}/desktop-undecodable.png` });
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name}: an artifact-only capture completes human review without an external URL`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openReview(page, "items=1&artifacts=artifact-only");
    const item = page.locator(".evidence-review-item");
    await expect(item.getByRole("img", { name: "Evidence: viewport-1" })).toBeVisible();
    await expect(item.getByRole("link")).toHaveCount(0);
    await expect(item.getByText("Checked by this browser against the request's digest.")).toBeVisible();
    await expect(page.getByRole("note", { name: "HTTPS or Localhost Required" })).toHaveCount(0);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: testInfo.outputPath(`artifact-only-${theme}.png`) });
    }
    await item.getByRole("checkbox", { name: "Mark viewport-1 as Reviewed" }).check();
    await page.getByRole("button", { name: "Approve" }).click();
    expect(await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions()))
      .toEqual([{ requestId: "evidence-occurrence", optionId: "approve", evidenceReviewed: ["viewport-1"],
        evidenceReviewDigest: "a".repeat(64) }]);
  });
}

// A plain-HTTP page at a network address, as a phone on the LAN would open it. The hostname is
// answered by the test server through the route, so the browser treats the page as a real
// non-secure context: no SubtleCrypto, exactly as in the field.
const NETWORK_ORIGIN = "http://reviewer-lan.test:4174";

async function openReviewFromNetworkAddress(page: Page, query: string): Promise<void> {
  const served = new URL(test.info().project.use.baseURL!);
  await page.route(`${NETWORK_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    url.host = served.host;
    await route.fulfill({ response: await route.fetch({ url: url.href }) });
  });
  await page.goto(`${NETWORK_ORIGIN}/request-surfaces-e2e.html?scenario=evidence&${query}`);
  expect(await page.evaluate(() => [window.isSecureContext, Boolean(globalThis.crypto?.subtle)])).toEqual([false, false]);
  await page.getByRole("button", { name: "Review Evidence" }).click();
  await expect(page.getByRole("complementary", { name: "Requests" })).toBeVisible();
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  for (const evidence of [
    { name: "artifact-only", artifacts: "artifact-only" },
    { name: "artifact-plus-uri", artifacts: "ready" },
  ]) {
    test(`${viewport.name}: over plain HTTP at a network address, ${evidence.name} evidence says how to finish and cannot be approved unseen`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await openReviewFromNetworkAddress(page, `items=2&artifacts=${evidence.artifacts}`);

      const notice = page.getByRole("note", { name: "HTTPS or Localhost Required" });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(`This page is open at ${NETWORK_ORIGIN}.`);
      await expect(notice).toContainText("reopen Wollipog over HTTPS, for example through tailscale serve, or on localhost");
      const box = await notice.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);

      for (const id of ["viewport-1", "viewport-2"]) {
        const item = page.locator(".evidence-review-item", { hasText: id });
        await item.scrollIntoViewIfNeeded();
        await expect(item.getByRole("status")).toHaveText(
          "Not shown: this browser can check the artifact against the request's digest only over HTTPS or on localhost.");
        await expect(item.getByRole("img")).toHaveCount(0);
        await expect(item.getByRole("link")).toHaveCount(0);
        await expect(item.getByRole("checkbox", { name: `Mark ${id} as Reviewed` })).toBeDisabled();
      }
      await expect(page.locator('a[href^="https://evidence.example"]')).toHaveCount(0);
      await expect(page.getByText("0 of 2 Reviewed")).toBeVisible();
      await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();
      expect(await artifactRequests(page), "bytes nobody can check are not fetched").toEqual([]);
      await notice.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`plain-http-${evidence.name}.png`) });
    });
  }
}

test("over plain HTTP a short desktop panel with child requests keeps the whole HTTPS notice", async ({ page }, testInfo) => {
  // The compact layout drops the summary's own lines at this height; the way forward must survive it
  // without crowding out the items or spilling past the actions.
  await page.setViewportSize({ width: 900, height: 480 });
  await openReviewFromNetworkAddress(page, "items=2&artifacts=artifact-only&children=1");
  const notice = page.getByRole("note", { name: "HTTPS or Localhost Required" });
  const layout = await page.locator(".evidence-review-surface").evaluate((surface) => ({
    overflow: surface.scrollHeight - surface.clientHeight,
    listHeight: surface.querySelector(".evidence-review-list")!.clientHeight,
    noticeInList: Boolean(surface.querySelector(".evidence-review-list .evidence-secure-context-notice")),
  }));
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.listHeight).toBeGreaterThan(40);
  expect(layout.noticeInList).toBe(true);
  await notice.scrollIntoViewIfNeeded();
  await expect(notice.getByText(`This page is open at ${NETWORK_ORIGIN}.`, { exact: false })).toBeVisible();
  await expect(notice.getByText("reopen Wollipog over HTTPS", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("plain-http-short-panel.png") });
});

test("mixed decisions show artifacts in place and keep a labelled external link for everything else", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReview(page, "items=4&artifacts=mixed");
  await expect(page.locator(".evidence-review-item").first().getByRole("img")).toBeVisible();
  for (const id of ["viewport-2"]) {
    const item = page.locator(".evidence-review-item", { hasText: id });
    await expect(item.getByRole("link", { name: `View External Evidence: ${id}` })).toBeVisible();
    await expect(item.locator(".evidence-artifact")).toHaveCount(0);
    await expect(item.getByRole("checkbox")).toBeEnabled();
  }
  const clip = page.locator(".evidence-review-item", { hasText: "interaction-clip" });
  await clip.scrollIntoViewIfNeeded();
  await expect(clip.locator("video")).toBeVisible();
  await expect(clip.getByRole("checkbox")).toBeEnabled();
  expect(await artifactRequests(page)).toContain("art_clip");
  await page.screenshot({ path: `${SHOT}/desktop-mixed.png` });
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name}: an artifact the card cannot show is blocked with its media type, not linked out`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openReview(page, "items=4&artifacts=unrenderable");
    await expect(page.locator(".evidence-review-item").first().getByRole("img")).toBeVisible();
    await expect(page.locator('a[href*="diagram.svg"]')).toHaveCount(0);
    for (const [id, reason] of [
      ["vector-diagram", "This artifact is image/svg+xml, which the review card cannot show"],
      ["untyped-capture", "This artifact declares no media type"],
    ]) {
      const item = page.locator(".evidence-review-item", { hasText: id });
      await item.scrollIntoViewIfNeeded();
      await expect(item.getByRole("alert")).toContainText(reason);
      await expect(item.getByRole("link")).toHaveCount(0);
      await expect(item.getByRole("checkbox")).toBeDisabled();
    }
    const legacy = page.locator(".evidence-review-item", { hasText: "viewport-2" });
    await expect(legacy.getByRole("link", { name: "View External Evidence: viewport-2" })).toBeVisible();
    await legacy.getByRole("checkbox").check();
    await page.locator(".evidence-review-item", { hasText: "viewport-1" }).getByRole("checkbox").check();
    expect(await artifactRequests(page)).not.toContain("art_svg");
    await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();
    await page.screenshot({ path: `${SHOT}/${viewport.name}-unrenderable.png` });
  });
}

test("a large review loads images as they approach the viewport, not all at once", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await openReview(page, "items=32&artifacts=ready");
  await expect(page.locator(".evidence-review-item")).toHaveCount(32);
  await expect(page.locator(".evidence-review-item").first().getByRole("img")).toBeVisible();
  const initial = await artifactRequests(page);
  expect(initial.length).toBeGreaterThan(0);
  expect(initial.length).toBeLessThan(16);
  expect(initial).not.toContain("art_32");

  const last = page.locator(".evidence-review-item").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last.getByRole("img", { name: "Evidence: viewport-32" })).toBeVisible();
  expect(await artifactRequests(page)).toContain("art_32");
  // Nothing is fetched twice as the reviewer scrolls.
  const all = await artifactRequests(page);
  expect(new Set(all).size).toBe(all.length);
});

test("a virtualized transcript screenshot loads once when its row is revisited", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/request-surfaces-e2e.html?scenario=artifact-timeline&items=1&artifacts=ready");
  const scroller = page.getByRole("region", { name: "Session Activity" });
  const image = page.getByRole("img", { name: "Session Screenshot.png" });
  await scroller.evaluate((element) => { element.scrollTop = 1850; });
  await expect(image).toBeVisible();
  expect(await artifactRequests(page)).toEqual(["art_1"]);
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator(".tl-artifact")).toHaveCount(0);
  await scroller.evaluate((element) => { element.scrollTop = 1850; });
  await expect(image).toBeVisible();
  expect(await artifactRequests(page)).toEqual(["art_1"]);
  await page.screenshot({ path: testInfo.outputPath("transcript-screenshot-revisited.png") });
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name}: a private video artifact plays inline in human review`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openReview(page, "items=1&artifacts=video");
    const item = page.locator(".evidence-review-item");
    const video = item.locator('video[aria-label="Play Evidence: interaction-clip"]');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
    await expect(video).toHaveAttribute("controls", "");
    await expect(video).toHaveAttribute("playsinline", "");
    await playDecodedVideoFrame(video);
    const box = await video.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(viewport.width - 24);
    await video.scrollIntoViewIfNeeded();
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: testInfo.outputPath(`video-${theme}.png`) });
    }
    await item.getByRole("checkbox", { name: "Mark interaction-clip as Reviewed" }).check();
    await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  test(`${viewport.name}: a transcript video loads only after its inline action`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=artifact-timeline&items=1&artifacts=video");
    const row = page.locator(".tl-artifact");
    await expect(row).toContainText("Session Walkthrough.webm");
    expect(await artifactRequests(page)).toEqual([]);
    await row.getByRole("button", { name: "Load Video" }).click();
    const video = row.locator('video[aria-label="Play Session Walkthrough.webm"]');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
    expect(await artifactRequests(page)).toEqual(["art_clip"]);
    await playDecodedVideoFrame(video);
    const box = await video.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(viewport.width - 24);
    await video.scrollIntoViewIfNeeded();
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: testInfo.outputPath(`transcript-video-${theme}.png`) });
    }
  });
}
