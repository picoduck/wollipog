import { expect, test, type Locator, type Page } from "@playwright/test";

const SHOT = "test-results/evidence-artifacts";

/** The session's own evidence is reviewed on the request dock's card above the composer (#2179),
 * as a grid of named tiles (#2197). */
async function openReview(page: Page, query: string): Promise<void> {
  await page.goto(`/request-surfaces-e2e.html?scenario=evidence&${query}`);
  await expect(page.locator(".request-dock .request-card")).toBeVisible();
}

const artifactRequests = (page: Page) =>
  page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.artifactRequests());

/** The tile of one evidence item, found by its id (the tile's secondary text). */
const tile = (page: Page, evidenceId: string) =>
  page.locator(".ev-tile").filter({ has: page.locator(".ev-id", { hasText: new RegExp(`^${evidenceId}$`, "u") }) });

const footNote = (page: Page) => page.locator(".request-card-reasons");

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
  test(`${viewport.name}: artifact-backed evidence is reviewed in its tile and approved without leaving the card`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openReview(page, "items=3&artifacts=ready");

    const first = tile(page, "viewport-1");
    await expect(first.getByRole("img", { name: "Screenshot 1" })).toBeVisible();
    await expect(first.locator(".ev-name")).toHaveText("Screenshot 1");
    await expect(first.locator(".ev-facts")).toHaveText("960 × 600");
    await expect(page.locator('a[href^="https://evidence.example"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("signature=hidden");
    // The tile is inside the card, not overflowing it, and its name is never cut short.
    const fits = await first.evaluate((element) => {
      const card = element.closest(".request-card")!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const name = element.querySelector<HTMLElement>(".ev-name")!;
      return box.left >= card.left - 1 && box.right <= card.right + 1 && name.scrollWidth <= name.clientWidth + 1;
    });
    expect(fits).toBe(true);
    await page.screenshot({ path: `${SHOT}/${viewport.name}-in-place.png` });

    // Open by keyboard, inspect, and return to the same tile.
    const thumb = first.getByRole("button", { name: "Open Screenshot 1" });
    await thumb.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Screenshot 1" });
    await expect(dialog.getByRole("img", { name: "Screenshot 1" })).toBeVisible();
    await page.screenshot({ path: `${SHOT}/${viewport.name}-enlarged.png` });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(thumb).toBeFocused();

    const approve = page.getByRole("button", { name: "Approve" });
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAccessibleDescription("Review 3 more to approve.");
    for (const [index, id] of ["viewport-1", "viewport-2", "viewport-3"].entries()) {
      const item = tile(page, id);
      await item.scrollIntoViewIfNeeded();
      await expect(item.getByRole("img", { name: `Screenshot ${index + 1}` })).toBeVisible();
      await item.getByRole("checkbox", { name: `Mark Screenshot ${index + 1} as Reviewed` }).check();
    }
    await expect(page.locator(".ev-progress")).toHaveText("3 of 3 reviewed");
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
    const swapped = tile(page, "viewport-2");
    await swapped.scrollIntoViewIfNeeded();
    await expect(swapped.locator(".ev-blocked-label")).toHaveText("Doesn't Match");
    await expect(swapped.getByRole("img")).toHaveCount(0);
    await expect(swapped.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveText("Deny this request and ask for a new capture.");
    await expect(footNote(page)).toHaveText("Can't approve until every item can be reviewed.");
    await page.screenshot({ path: `${SHOT}/${viewport.name}-mismatch.png` });

    await openReview(page, "items=3&artifacts=unavailable");
    const gone = tile(page, "viewport-2");
    await gone.scrollIntoViewIfNeeded();
    await expect(gone.locator(".ev-blocked-label")).toHaveText("Can't Load");
    if (viewport.name === "desktop") await expect(gone).toContainText("gone, or you don't have access");
    await expect(gone.getByRole("button", { name: /Retry/u })).toHaveCount(0);
    await expect(gone.getByRole("checkbox")).toHaveCount(0);
    for (const [name, id] of [["Screenshot 1", "viewport-1"], ["Screenshot 3", "viewport-3"]] as const) {
      const item = tile(page, id);
      await item.scrollIntoViewIfNeeded();
      await item.getByRole("checkbox", { name: `Mark ${name} as Reviewed` }).check();
    }
    await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Approve" }))
      .toHaveAccessibleDescription("Can't approve until every item can be reviewed.");
    await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();
    await page.screenshot({ path: `${SHOT}/${viewport.name}-unavailable.png` });
  });
}

test("a Reviewed mark that waits on its link shows the disabled cursor", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReview(page, "items=4&artifacts=mixed");
  const waiting = tile(page, "viewport-2").getByRole("checkbox");
  const open = tile(page, "viewport-1").getByRole("checkbox");
  await expect(page.getByRole("img", { name: "Screenshot 1" })).toBeVisible();
  await expect(waiting).toBeDisabled();
  // The Checkbox row (§8.4): a disabled row keeps its size and reads in --text-faint rather than
  // fading, and the box takes its row's cursor.
  const styles = (checkbox: Locator) => checkbox.evaluate((input) => {
    const label = input.closest("label")!;
    const probe = document.createElement("span");
    probe.style.color = "var(--text-faint)";
    label.append(probe);
    const faint = getComputedStyle(probe).color;
    probe.remove();
    return {
      label: getComputedStyle(label).cursor,
      faint: getComputedStyle(label).color === faint,
      checkbox: getComputedStyle(input).cursor,
    };
  });
  // The checkbox agrees with its label instead of keeping the browser's own default arrow.
  expect(await styles(waiting)).toEqual({ label: "not-allowed", faint: true, checkbox: "not-allowed" });
  // An enabled item is untouched: the whole mark is the target, and nothing faint leaks onto it.
  expect(await styles(open)).toEqual({ label: "pointer", faint: false, checkbox: "pointer" });
  await open.check();
  await expect(open).toBeChecked();
});

test("an artifact that matches its digest but cannot be drawn is never shown and cannot be marked reviewed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReview(page, "items=3&artifacts=undecodable");
  const broken = tile(page, "viewport-2");
  await broken.scrollIntoViewIfNeeded();
  await expect(broken.locator(".ev-blocked")).toHaveText("Can't LoadIt matches its digest but can't be drawn.");
  // No broken-image placeholder is left on screen, and nothing offers to open it.
  await expect(broken.locator("img:visible")).toHaveCount(0);
  await expect(broken.getByRole("button", { name: /^Open/u })).toHaveCount(0);
  await expect(broken.getByRole("checkbox")).toHaveCount(0);
  for (const [name, id] of [["Screenshot 1", "viewport-1"], ["Screenshot 3", "viewport-3"]] as const) {
    const item = tile(page, id);
    await item.scrollIntoViewIfNeeded();
    await expect(item.getByRole("img", { name })).toBeVisible();
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
    const item = tile(page, "viewport-1");
    await expect(item.getByRole("img", { name: "Screenshot" })).toBeVisible();
    await expect(item.getByRole("link")).toHaveCount(0);
    await expect(page.locator(".ev-checked")).toHaveText(
      "Shown screenshots were checked by this browser against the request's digest.");
    await expect(page.getByRole("note", { name: "HTTPS or Localhost Required" })).toHaveCount(0);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: testInfo.outputPath(`artifact-only-${theme}.png`) });
    }
    await item.getByRole("checkbox", { name: "Mark Screenshot as Reviewed" }).check();
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
  await expect(page.locator(".request-dock .request-card")).toBeVisible();
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
      await expect(notice).toHaveCount(1);
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(`This page is open at ${NETWORK_ORIGIN}.`);
      await expect(notice).toContainText("reopen Wollipog over HTTPS, for example through tailscale serve, or on localhost");
      const box = await notice.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      // Above the grid, in the card body's first place.
      expect(await notice.evaluate((element) =>
        Boolean(element.compareDocumentPosition(document.querySelector(".ev-grid")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);

      for (const id of ["viewport-1", "viewport-2"]) {
        const item = tile(page, id);
        await item.scrollIntoViewIfNeeded();
        await expect(item.locator(".ev-blocked-label")).toHaveText("Not Shown");
        if (viewport.name === "desktop") await expect(item.locator(".ev-blocked-detail")).toHaveText("Needs HTTPS or localhost.");
        await expect(item.getByRole("img")).toHaveCount(0);
        await expect(item.getByRole("link")).toHaveCount(0);
        await expect(item.getByRole("button")).toHaveCount(0);
        await expect(item.getByRole("checkbox")).toHaveCount(0);
      }
      await expect(page.locator('a[href^="https://evidence.example"]')).toHaveCount(0);
      await expect(page.locator(".ev-progress")).toHaveText("0 of 2 reviewed");
      await expect(page.getByRole("alert")).toHaveCount(0);
      const approve = page.getByRole("button", { name: "Approve" });
      await expect(approve).toBeDisabled();
      await expect(approve).toHaveAccessibleDescription("Approve needs HTTPS or localhost. Deny works from here.");
      await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();
      expect(await artifactRequests(page), "bytes nobody can check are not fetched").toEqual([]);
      await notice.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`plain-http-${evidence.name}.png`) });
      await page.getByRole("button", { name: "Deny" }).click();
      expect(await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions()))
        .toEqual([{ requestId: "evidence-occurrence", optionId: "deny" }]);
    });
  }
}

test("over plain HTTP a short desktop dock keeps the whole HTTPS notice reachable", async ({ page }, testInfo) => {
  // The dock is capped at this height, so the card scrolls inside it; the way forward and the
  // actions must stay reachable there.
  await page.setViewportSize({ width: 900, height: 480 });
  await openReviewFromNetworkAddress(page, "items=2&artifacts=artifact-only&children=1");
  const notice = page.getByRole("note", { name: "HTTPS or Localhost Required" });
  const card = page.locator(".request-dock .request-card");
  expect(await card.evaluate((element) =>
    Boolean(element.querySelector('.request-card-body .ev-review > .notice[aria-label="HTTPS or Localhost Required"]')))).toBe(true);
  await notice.scrollIntoViewIfNeeded();
  await expect(notice).toBeInViewport();
  await card.locator(".request-card-foot").scrollIntoViewIfNeeded();
  await expect(card.locator(".request-card-foot")).toBeInViewport({ ratio: 1 });
  await notice.scrollIntoViewIfNeeded();
  await expect(notice.getByText(`This page is open at ${NETWORK_ORIGIN}.`, { exact: false })).toBeVisible();
  await expect(notice.getByText("reopen Wollipog over HTTPS", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("plain-http-short-panel.png") });
});

test("mixed decisions show artifacts in their tiles and give link-only items an Open Link that must be used", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReview(page, "items=4&artifacts=mixed");
  await expect(tile(page, "viewport-1").getByRole("img")).toBeVisible();
  const link = tile(page, "viewport-2");
  await expect(link.locator(".ev-name")).toHaveText("Link");
  const openLink = link.getByRole("link", { name: "Open Link" });
  await expect(openLink).toBeVisible();
  // A button that is a link never underlines (§3.1).
  expect(await openLink.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe("none");
  await expect(link.locator(".ev-thumb")).toHaveCount(0);
  await expect(link.getByRole("checkbox")).toBeDisabled();
  await openLink.click();
  expect(await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.openedLinks()))
    .toEqual(["https://evidence.example/item-2.png?signature=hidden-2"]);
  await expect(link.getByRole("checkbox", { name: "Mark Link as Reviewed" })).toBeEnabled();
  const clip = tile(page, "interaction-clip");
  await clip.scrollIntoViewIfNeeded();
  await expect(clip.locator(".ev-name")).toHaveText("Recording");
  await expect(clip.locator(".ev-thumb video")).toBeVisible();
  await expect(clip.getByRole("checkbox")).toBeEnabled();
  expect(await artifactRequests(page)).toContain("art_clip");
  await page.screenshot({ path: `${SHOT}/desktop-mixed.png` });
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name}: an artifact the card cannot show is Can't Show, not linked out`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openReview(page, "items=4&artifacts=unrenderable");
    await expect(tile(page, "viewport-1").getByRole("img")).toBeVisible();
    await expect(page.locator('a[href*="diagram.svg"]')).toHaveCount(0);
    for (const [id, reason] of [
      ["vector-diagram", "image/svg+xml can't be shown here."],
      ["untyped-capture", "It declares no media type."],
    ]) {
      const item = tile(page, id);
      await item.scrollIntoViewIfNeeded();
      await expect(item.locator(".ev-blocked-label")).toHaveText("Can't Show");
      if (viewport.name === "desktop") await expect(item.locator(".ev-blocked-detail")).toHaveText(reason);
      await expect(item.getByRole("link")).toHaveCount(0);
      await expect(item.getByRole("checkbox")).toHaveCount(0);
    }
    const legacy = tile(page, "viewport-2");
    await legacy.getByRole("link", { name: "Open Link" }).click();
    await legacy.getByRole("checkbox").check();
    await tile(page, "viewport-1").getByRole("checkbox").check();
    expect(await artifactRequests(page)).not.toContain("art_svg");
    await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();
    await page.screenshot({ path: `${SHOT}/${viewport.name}-unrenderable.png` });
  });
}

test("a large review loads images as they approach the viewport, not all at once", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await openReview(page, "items=32&artifacts=ready");
  await expect(page.locator(".ev-tile")).toHaveCount(32);
  // The dock's card body is the scroller (#2179): the first tile comes into view within it.
  await page.locator(".ev-tile").first().scrollIntoViewIfNeeded();
  await expect(page.locator(".ev-tile").first().getByRole("img")).toBeVisible();
  const initial = await artifactRequests(page);
  expect(initial.length).toBeGreaterThan(0);
  expect(initial.length).toBeLessThan(32);
  expect(initial).not.toContain("art_32");

  const last = page.locator(".ev-tile").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last.getByRole("img", { name: "Screenshot 32" })).toBeVisible();
  expect(await artifactRequests(page)).toContain("art_32");
  // Nothing is fetched twice as the reviewer scrolls.
  const all = await artifactRequests(page);
  expect(new Set(all).size).toBe(all.length);
});

test("tiles are named in full and keep their targets on a touch phone", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await openReview(page, "items=4&artifacts=unavailable-retry");
    const first = tile(page, "viewport-1");
    await expect(first.getByRole("img", { name: "Screenshot 1" })).toBeVisible();
    for (const id of ["viewport-1", "viewport-2", "viewport-3", "viewport-4"]) {
      // Primary text never truncates in favour of the id under it.
      expect(await tile(page, id).locator(".ev-name").evaluate((name) => name.scrollWidth <= name.clientWidth + 1)).toBe(true);
    }
    const target = (locator: Locator) => locator.evaluate((element) => {
      // A 44px target in each direction, by the element's own box or the hit area its ::after
      // lends it on that axis (a tile's small buttons borrow height only).
      const box = element.getBoundingClientRect();
      const after = getComputedStyle(element, "::after");
      const borrowed = (side: string) => after.content === "none" ? 0 : Math.max(0, -parseFloat(side));
      return Math.min(box.width + 2 * borrowed(after.left), box.height + 2 * borrowed(after.top));
    });
    expect(await target(first.getByRole("button", { name: "Open Screenshot 1" }))).toBeGreaterThanOrEqual(44);
    expect(await target(first.locator("label.ev-mark"))).toBeGreaterThanOrEqual(44);
    const retry = tile(page, "viewport-2").getByRole("button", { name: "Retry Screenshot 2" });
    await expect(retry).toBeVisible();
    expect(await target(retry)).toBeGreaterThanOrEqual(44);
    await openReview(page, "items=4");
    expect(await target(tile(page, "viewport-1").getByRole("link", { name: "Open Link" }))).toBeGreaterThanOrEqual(44);
    // The borrowed hit areas never make the four-up strip scroll sideways.
    expect(await page.locator(".request-card-body").evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

/** The smaller of an element's laid-out width and height, unaffected by a dialog's opening animation. */
const drawnSize = (locator: Locator) => locator.evaluate((element: HTMLElement) =>
  Math.min(element.offsetWidth, element.offsetHeight));

test("at 1440×900 the Evidence Viewer steps through a four-item review and marks each item as it goes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReview(page, "items=4&artifacts=ready");
  await expect(page.getByRole("img", { name: "Screenshot 4" })).toBeVisible();
  await tile(page, "viewport-2").getByRole("button", { name: "Open Screenshot 2" }).click();
  const viewer = page.getByRole("dialog", { name: "Screenshot 2 of 4" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".ev-viewer-facts")).toHaveText("390 × 760");
  await expect(viewer.locator(".ev-viewer-id")).toHaveText("viewport-2");
  const primary = viewer.getByRole("button", { name: "Mark Reviewed and Next" });
  await expect(primary).toBeFocused();
  // The picture fits the stage, and the footer is in view without scrolling the dialog.
  const stage = await viewer.locator(".ev-viewer-stage").boundingBox();
  const picture = await viewer.locator(".ev-viewer-stage img").boundingBox();
  expect(stage && picture && picture.height <= stage.height + 1 && picture.width <= stage.width + 1).toBe(true);
  await expect(primary).toBeInViewport();
  // Every viewable item is in the filmstrip at 72×45, and a thumbnail opens its item.
  // The dialog's name follows the item it shows, so the filmstrip is found by role alone.
  const thumbs = page.getByRole("dialog").locator(".ev-strip-thumb");
  await expect(thumbs).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    expect(await thumbs.nth(index).evaluate((element: HTMLElement) => [element.offsetWidth, element.offsetHeight]))
      .toEqual([72, 45]);
  }
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "Screenshot 3 of 4" })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(viewer).toBeVisible();
  await primary.click();
  await expect(page.getByRole("dialog", { name: "Screenshot 3 of 4" })).toBeVisible();
  await expect(page.locator(".ev-progress")).toHaveText("1 of 4 reviewed");
  await expect(thumbs.nth(1)).toHaveAccessibleName("Screenshot 2, Reviewed");
  await expect(thumbs.nth(1).locator(".ev-strip-mark")).toBeVisible();
  await thumbs.nth(3).click();
  await page.getByRole("button", { name: "Mark Reviewed and Next" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".ev-progress")).toHaveText("2 of 4 reviewed");
  await expect(tile(page, "viewport-4").getByRole("button", { name: "Open Screenshot 4" })).toBeFocused();
  // The marks are the grid's own, so they are kept across a reload.
  await page.reload();
  await expect(page.getByRole("img", { name: "Screenshot 4" })).toBeVisible();
  await expect(page.locator(".ev-progress")).toHaveText("2 of 4 reviewed");
});

test("the Evidence Viewer never shows an item the grid shows as Doesn't Match", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReview(page, "items=4&artifacts=mismatch");
  await expect(tile(page, "viewport-2").locator(".ev-blocked-label")).toHaveText("Doesn't Match");
  await expect(tile(page, "viewport-2").locator(".ev-thumb")).toHaveCount(0);
  await tile(page, "viewport-1").getByRole("button", { name: "Open Screenshot 1" }).click();
  const viewer = page.getByRole("dialog");
  await expect(viewer.locator(".ev-strip-thumb")).toHaveCount(3);
  await page.keyboard.press("ArrowRight");
  await expect(viewer).toHaveAccessibleName("Screenshot 3 of 4");
});

test("on a 390px touch phone the Evidence Viewer is a full-height sheet with a back arrow and 44px targets", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await openReview(page, "items=4&artifacts=ready");
    await expect(page.getByRole("img", { name: "Screenshot 4" })).toBeVisible();
    // A tap on the middle of a strip tile opens the viewer: the Reviewed mark's touch target grows
    // out past the frame's corner, not over the picture.
    const thumb = tile(page, "viewport-2").getByRole("button", { name: "Open Screenshot 2" });
    expect(await thumb.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    })).toBe(true);
    await thumb.tap();
    const viewer = page.getByRole("dialog", { name: "Screenshot 2 of 4" });
    await expect(viewer).toBeVisible();
    expect(await page.locator(".modal.sheet-full").evaluate((element: HTMLElement) => [element.offsetWidth, element.offsetHeight]))
      .toEqual([390, 844]);
    for (const name of ["Previous", "Next", "Mark Reviewed and Next"]) {
      expect(await drawnSize(viewer.getByRole("button", { name, exact: true })), name).toBeGreaterThanOrEqual(44);
    }
    for (const box of await viewer.locator(".ev-strip-thumb").all()) expect(await drawnSize(box)).toBeGreaterThanOrEqual(44);
    await expect(viewer.getByRole("button", { name: "Mark Reviewed and Next" })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await viewer.getByRole("button", { name: "Next", exact: true }).tap();
    await expect(page.getByRole("dialog", { name: "Screenshot 3 of 4" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

/** Whether each element is drawn whole inside the card body's visible box, without a scroll. */
async function wholeInBody(page: Page, selector: string): Promise<boolean[]> {
  return page.locator(".request-card-body").evaluate((body, query) => {
    const frame = body.getBoundingClientRect();
    return [...body.querySelectorAll<HTMLElement>(query)].map((element) => {
      const box = element.getBoundingClientRect();
      return box.height > 0 && box.top >= frame.top - 0.5 && box.bottom <= frame.bottom + 0.5 &&
        element.scrollWidth <= element.clientWidth + 1;
    });
  }, selector);
}

for (const scenario of [
  { name: "reviewing", query: "items=4&artifacts=ready", caption: true },
  { name: "loading", query: "items=4&artifacts=ready&hold=1", caption: false },
  { name: "link only", query: "items=4", caption: false },
]) {
  test(`at 1440×900 a four-item ${scenario.name} review shows every tile's words, the caption and Show Details unscrolled`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReview(page, scenario.query);
    if (scenario.caption) await expect(page.getByRole("img", { name: "Screenshot 4" })).toBeVisible();
    const body = page.locator(".request-card-body");
    // Nothing waits below the fold: the body holds the whole review.
    expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    for (const selector of [".ev-name", ".ev-id", ".ev-frame", ".ev-progress", "details.disclosure > summary"]) {
      expect(await wholeInBody(page, selector), selector).not.toContain(false);
    }
    if (scenario.caption) {
      await expect(page.locator(".ev-checked")).toBeVisible();
      expect(await wholeInBody(page, ".ev-checked, .ev-facts")).not.toContain(false);
      expect(await wholeInBody(page, ".ev-facts")).toHaveLength(4);
    }
  });
}

test("at 1440×900 a failed tile keeps its words and Retry in view, and the capped card body scrolls to the rest", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReview(page, "items=4&artifacts=unavailable-retry");
  await expect(page.getByRole("img", { name: "Screenshot 4" })).toBeVisible();
  for (const selector of [".ev-name", ".ev-id", ".ev-frame", ".ev-blocked .btn"]) {
    expect(await wholeInBody(page, selector), selector).not.toContain(false);
  }
  // The danger notice brings the dock to its cap; the body is the scroller, never the grid.
  const grid = page.locator(".ev-grid");
  expect(await grid.evaluate((element) => [getComputedStyle(element).overflowY, element.scrollHeight - element.clientHeight]))
    .toEqual(["visible", 0]);
  await page.locator(".ev-checked").scrollIntoViewIfNeeded();
  expect(await wholeInBody(page, ".ev-checked")).toEqual([true]);
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
  test(`${viewport.name}: a private video artifact shows its first frame and plays when its tile is opened`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openReview(page, "items=1&artifacts=video");
    const item = tile(page, "interaction-clip");
    const frame = item.locator(".ev-thumb video");
    await expect(frame).toBeVisible();
    await expect.poll(() => frame.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
    await expect(item.locator(".ev-facts")).toHaveText("320 × 180");
    await item.getByRole("button", { name: "Open Recording" }).click();
    const video = page.getByRole("dialog", { name: "Recording" }).locator('video[aria-label="Play Recording"]');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
    await expect(video).toHaveAttribute("controls", "");
    await expect(video).toHaveAttribute("playsinline", "");
    await playDecodedVideoFrame(video);
    const box = await video.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(viewport.width - 24);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: testInfo.outputPath(`video-${theme}.png`) });
    }
    await page.keyboard.press("Escape");
    await item.getByRole("checkbox", { name: "Mark Recording as Reviewed" }).check();
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
