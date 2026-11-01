import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";

/**
 * Session artifacts in chat, the Browser and the viewer (#3924): bounded previews and a counted
 * View All, Open in Browser and artifact links beyond the first list page, and a viewer that steps,
 * swipes, pinches and pans. Touch is real touch: Chromium's own touch input through CDP, so the
 * pointer events the viewer reads are the ones a phone produces, not a resized desktop.
 */
const SHOT = process.env.ARTIFACT_GALLERY_EVIDENCE_DIR ?? "test-results/artifact-gallery";

const exportsSoFar = (page: Page) => page.evaluate(() =>
  (window as unknown as { __ARTIFACT_GALLERY_E2E__: { exports: () => string[] } }).__ARTIFACT_GALLERY_E2E__.exports());
const listCursors = (page: Page) => page.evaluate(() =>
  (window as unknown as { __ARTIFACT_GALLERY_E2E__: { listCursors: () => Array<string | null> } }).__ARTIFACT_GALLERY_E2E__.listCursors());
const openLink = (page: Page, artifactId?: string) => page.evaluate((id) =>
  (window as unknown as { __ARTIFACT_GALLERY_E2E__: { openLink: (id?: string) => void } }).__ARTIFACT_GALLERY_E2E__.openLink(id), artifactId);

const viewer = (page: Page) => page.getByRole("dialog");
const position = (page: Page) => viewer(page).locator(".art-gallery-position");
const stage = (page: Page) => viewer(page).locator(".art-gallery-stage");
const transcript = (page: Page) => page.getByRole("region", { name: "Session Activity" });

async function open(page: Page) {
  await page.goto("/artifact-gallery-e2e.html");
  await expect(transcript(page).locator(".tl-artifact").first()).toBeVisible();
  await expect(transcript(page).locator(".tl-artifact .art-image").first()).toBeVisible();
}

/**
 * Chromium touch input: each finger's path, stepped together, then every finger lifts. A drag comes
 * to rest before it lifts, as a finger does: one lifted still moving starts a fling, and Chromium
 * spends the next tap stopping it rather than clicking what it lands on.
 */
async function touchPaths(cdp: CDPSession, paths: Array<Array<[number, number]>>, stepMs = 16) {
  const steps = Math.max(...paths.map((path) => path.length));
  const pointsAt = (step: number) => paths.map((path, id) => {
    const [x, y] = path[Math.min(step, path.length - 1)]!;
    return { x, y, id, radiusX: 4, radiusY: 4, force: 1 };
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pointsAt(0) });
  const rest = steps > 1 ? 6 : 0;
  for (let step = 1; step < steps + rest; step++) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pointsAt(step) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const line = (from: [number, number], to: [number, number], steps = 8): Array<[number, number]> =>
  Array.from({ length: steps + 1 }, (_, index) => [
    from[0] + ((to[0] - from[0]) * index) / steps,
    from[1] + ((to[1] - from[1]) * index) / steps,
  ]);
/** A capture once the dialog or sheet has finished arriving, so the evidence shows the settled state. */
async function snap(page: Page, name: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  await page.screenshot({ path: `${SHOT}/${name}` });
}

/** Where to touch: the stage's center once the sheet has finished sliding in, so a gesture lands on
 * the stage a person would see rather than where it was mid-animation. */
async function center(locator: Locator): Promise<[number, number]> {
  await locator.page().evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  const box = (await locator.boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2];
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test("eight artifacts in a turn show three previews and one counted View All, and the viewer reaches all eight", async ({ page }) => {
    await open(page);
    const cards = transcript(page).locator(".tl-artifact:not(.tl-artifact-more)");
    const viewAll = transcript(page).getByRole("button", { name: "View All 8 Artifacts" });
    await expect(viewAll).toHaveCount(1);
    await expect(transcript(page).locator(".tl-artifact-more")).toContainText("5 more from this turn");
    // Three of the first turn's eight: the repeat of the first is not drawn again.
    await expect(cards.locator(".art-image")).toHaveCount(3);
    // Only what is drawn loads: never the five behind View All.
    await expect(cards.locator(".art-image").nth(2)).toBeVisible();
    const loaded = new Set(await exportsSoFar(page));
    expect([...loaded].sort()).toEqual(["sessions-desktop", "sessions-phone", "transcript-desktop"]);
    // A thumbnail stays bounded.
    const thumb = (await cards.first().locator(".art-image").boundingBox())!;
    expect(thumb.height).toBeLessThanOrEqual(240.5);
    await snap(page, "desktop-transcript.png");
    // The next turn's log, further down, is a file card.
    await transcript(page).evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(transcript(page).locator(".tl-artifact").filter({ hasText: "artifact-gallery.log" }))
      .toContainText("No inline preview for this type.");
    await snap(page, "desktop-transcript-file-card.png");

    // Back to the first turn's View All, and let the virtual list finish measuring the rows it
    // brings back, so the scroll the viewer must keep is the one a person left.
    await transcript(page).evaluate((element) => { element.scrollTop = 0; });
    await viewAll.scrollIntoViewIfNeeded();
    let scrollBefore = -1;
    await expect.poll(async () => {
      const previous = scrollBefore;
      await page.waitForTimeout(250);
      scrollBefore = await transcript(page).evaluate((element) => element.scrollTop);
      return scrollBefore === previous;
    }).toBe(true);
    await page.getByRole("textbox", { name: "Message" }).fill("Draft that must survive the viewer");
    await viewAll.click();
    await expect(viewer(page)).toBeVisible();
    await expect(position(page)).toHaveText("4 of 8");
    await expect(viewer(page).locator(".art-gallery-media")).toBeVisible();
    await snap(page, "desktop-viewer.png");
    await page.keyboard.press("ArrowRight");
    await expect(position(page)).toHaveText("5 of 8");
    const next = viewer(page).getByRole("button", { name: "Next" });
    for (let step = 0; step < 3; step++) await next.click();
    await expect(position(page)).toHaveText("8 of 8");
    await expect(next).toBeDisabled();
    await viewer(page).getByRole("button", { name: "Previous" }).click();
    await expect(position(page)).toHaveText("7 of 8");

    // Double-click zooms in at the pointer; Fit to Screen returns.
    await stage(page).dblclick();
    await expect(stage(page)).toHaveAttribute("data-zoomed", "true");
    await snap(page, "desktop-viewer-zoomed.png");
    await viewer(page).getByRole("button", { name: "Fit to Screen" }).click();
    await expect(stage(page)).not.toHaveAttribute("data-zoomed", "true");

    await viewer(page).getByRole("button", { name: "Done" }).click();
    await expect(viewer(page)).toHaveCount(0);
    await expect(viewAll).toBeFocused();
    expect(await transcript(page).evaluate((element) => element.scrollTop)).toBe(scrollBefore);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Draft that must survive the viewer");
  });

  test("Open in Browser opens Browser → Artifacts on that artifact, and a link beyond the first page finds its artifact", async ({ page }) => {
    await open(page);
    const first = transcript(page).locator(".tl-artifact").first();
    await first.getByRole("button", { name: "Open in Browser" }).click();
    const panel = page.getByRole("complementary", { name: "Side Panel" });
    await expect(panel.locator(".art-meta")).toBeVisible();
    await expect(panel.locator(".art-image")).toBeVisible();
    await expect(panel).toContainText("Screenshot");
    await snap(page, "desktop-open-in-browser.png");

    // The seventh capture is on the list's third page of three.
    await openLink(page, "settings-desktop");
    await expect(panel.locator(".art-image")).toHaveAttribute("alt", "settings-desktop.png");
    // The Browser read the list as far as the link's page; the transcript's cited ids may read it too.
    expect(await listCursors(page)).toEqual(expect.arrayContaining([null, "3", "6"]));
    // Tapping its image opens the same viewer over the Browser's list, stepping through what it loaded.
    await panel.locator(".art-image-open").click();
    await expect(position(page)).toHaveText(/^7 of \d+$/);
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
    await expect(panel.locator(".art-image-open")).toBeFocused();

    await openLink(page, "deleted-artifact");
    await expect(panel.getByRole("status").filter({ hasText: "Artifact Unavailable" })).toBeVisible();
    await expect(panel).not.toContainText("deleted-artifact");
    await snap(page, "desktop-unavailable.png");
  });
});

test("an artifact link opens its session's Browser on the artifact in the real shell, after a refresh and in a new tab", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.clear();
  });
  // The link Copy Link copies, as the shell parses it on arrival.
  const link = viewPath({ name: "session", id: "session-alpha", artifacts: { artifactId: "run-art-log" } });
  const url = `/command-inbox-projects-e2e.html?fullShell=1&runArtifacts=1&path=${encodeURIComponent(link)}`;
  const expectOpen = async (target: Page) => {
    const panel = target.locator("#right-panel");
    await expect(panel.locator(".rpanel-page-title")).toHaveText("e2e shard 3 of 5.log");
    await expect(panel.locator(".rpanel-head").getByRole("button", { name: "Back to Browser" })).toBeVisible();
    await expect(panel.locator("pre")).toContainText("checkout.spec.ts › case 1 ");
  };
  await page.goto(url);
  await expectOpen(page);
  await snap(page, "desktop-shell-link.png");
  await page.reload();
  await expectOpen(page);
  const tab = await context.newPage();
  await tab.setViewportSize({ width: 1440, height: 900 });
  await tab.goto(url);
  await expectOpen(tab);
});

/** The last reply: it cites two artifacts the session saved but never attached, and one it has not. */
async function citingReply(page: Page) {
  await transcript(page).evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const message = transcript(page).locator(".tl-agent-msg").filter({ hasText: "The two that matter are" });
  await expect(message).toBeVisible();
  await message.scrollIntoViewIfNeeded();
  return message;
}

test.describe("cited artifacts (#3970)", () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test("ids a reply cites become chips that open the viewer, and the turn's unattached ones preview under it", async ({ page }) => {
    await open(page);
    const message = await citingReply(page);
    const chips = message.locator(".art-ref");
    await expect(chips).toHaveText(["review-summary.png", "checkout-flow.png"]);
    // An id the session has no artifact for, and an id in fenced code, stay as written.
    await expect(message).toContainText("art_f0e19e000ff0 belongs to another session");
    await expect(message.locator("pre")).toContainText("art_c17ed0000a01");
    const previews = message.locator(".tl-artifact-refs .tl-artifact");
    await expect(previews).toHaveCount(2);
    await expect(previews.locator(".art-image")).toHaveCount(2);
    await snap(page, "desktop-cited-artifacts.png");

    await chips.first().click();
    await expect(position(page)).toHaveText("1 of 2");
    await expect(viewer(page).locator(".art-gallery-media")).toHaveAttribute("alt", "review-summary.png");
    await page.keyboard.press("ArrowRight");
    await expect(position(page)).toHaveText("2 of 2");
    await expect(viewer(page).getByRole("button", { name: "Open in Browser" })).toBeVisible();
    await snap(page, "desktop-cited-viewer.png");
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
    await expect(chips.first()).toBeFocused();
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a tapped image opens the viewer; a swipe steps, a pinch zooms, a zoomed drag pans, and Fit to Screen returns", async ({ page }) => {
    await open(page);
    const cdp = await page.context().newCDPSession(page);
    await snap(page, "phone-transcript.png");
    const thumb = transcript(page).locator(".art-image-open").first();
    await thumb.tap();
    await expect(viewer(page)).toBeVisible();
    await expect(position(page)).toHaveText("1 of 8");
    await expect(viewer(page).locator(".art-gallery-media")).toBeVisible();
    await snap(page, "phone-viewer.png");

    const [cx, cy] = await center(stage(page));
    await touchPaths(cdp, [line([cx + 120, cy], [cx - 120, cy])]);
    await expect(position(page)).toHaveText("2 of 8");
    await touchPaths(cdp, [line([cx - 120, cy], [cx + 120, cy])]);
    await expect(position(page)).toHaveText("1 of 8");
    // A mostly vertical drag is not a swipe.
    await touchPaths(cdp, [line([cx, cy - 120], [cx + 20, cy + 120])]);
    await expect(position(page)).toHaveText("1 of 8");

    await touchPaths(cdp, [line([cx - 30, cy], [cx - 140, cy]), line([cx + 30, cy], [cx + 140, cy])]);
    await expect(stage(page)).toHaveAttribute("data-zoomed", "true");
    const zoomedTransform = await viewer(page).locator(".art-gallery-media").evaluate((image) => (image as HTMLElement).style.transform);
    expect(zoomedTransform).toMatch(/scale\(/);
    await snap(page, "phone-viewer-pinched.png");

    // Zoomed, a horizontal drag pans the image and stays on the same artifact.
    await touchPaths(cdp, [line([cx + 100, cy], [cx - 100, cy])]);
    await expect(position(page)).toHaveText("1 of 8");
    const pannedTransform = await viewer(page).locator(".art-gallery-media").evaluate((image) => (image as HTMLElement).style.transform);
    expect(pannedTransform).not.toBe(zoomedTransform);
    await snap(page, "phone-viewer-panned.png");

    await viewer(page).getByRole("button", { name: "Fit to Screen" }).tap();
    await expect(stage(page)).not.toHaveAttribute("data-zoomed", "true");
    await touchPaths(cdp, [line([cx + 120, cy], [cx - 120, cy])]);
    await expect(position(page)).toHaveText("2 of 8");
    await expect(viewer(page).locator(".art-gallery-media")).toHaveAttribute("alt", "sessions-phone.png");

    // A double tap zooms in and back out.
    await touchPaths(cdp, [[[cx, cy]]]);
    await touchPaths(cdp, [[[cx, cy]]]);
    await expect(stage(page)).toHaveAttribute("data-zoomed", "true");
    await touchPaths(cdp, [[[cx, cy]]]);
    await touchPaths(cdp, [[[cx, cy]]]);
    await expect(stage(page)).not.toHaveAttribute("data-zoomed", "true");

    await viewer(page).getByRole("button", { name: "Done" }).tap();
    await expect(viewer(page)).toHaveCount(0);
  });

  test("a tapped citation chip opens the viewer, and a swipe steps to the reply's other cited artifact", async ({ page }) => {
    await open(page);
    const cdp = await page.context().newCDPSession(page);
    const message = await citingReply(page);
    await expect(message.locator(".art-ref")).toHaveCount(2);
    await snap(page, "phone-cited-artifacts.png");
    await message.locator(".art-ref").first().tap();
    await expect(position(page)).toHaveText("1 of 2");
    await expect(viewer(page).locator(".art-gallery-media")).toBeVisible();
    const [cx, cy] = await center(stage(page));
    await touchPaths(cdp, [line([cx + 120, cy], [cx - 120, cy])]);
    await expect(position(page)).toHaveText("2 of 2");
    await snap(page, "phone-cited-viewer.png");
  });

  test("the Browser's image opens the same viewer, with the same pinch and swipe", async ({ page }) => {
    await open(page);
    const cdp = await page.context().newCDPSession(page);
    await openLink(page, "browser-phone");
    const panel = page.getByRole("complementary", { name: "Side Panel" });
    await expect(panel.locator(".art-image")).toHaveAttribute("alt", "browser-phone.png");
    await snap(page, "phone-browser.png");
    await panel.locator(".art-image-open").tap();
    // The viewer steps through what the Browser loaded: the two pages that reached the link's artifact.
    await expect(position(page)).toHaveText("6 of 6");
    await expect(viewer(page).locator(".art-gallery-media")).toBeVisible();
    const [cx, cy] = await center(stage(page));
    await touchPaths(cdp, [line([cx - 120, cy], [cx + 120, cy])]);
    await expect(position(page)).toHaveText("5 of 6");
    await expect(viewer(page).locator(".art-gallery-media")).toHaveAttribute("alt", "browser-desktop.png");
    await touchPaths(cdp, [line([cx - 30, cy], [cx - 140, cy]), line([cx + 30, cy], [cx + 140, cy])]);
    await expect(stage(page)).toHaveAttribute("data-zoomed", "true");
    await snap(page, "phone-browser-viewer-pinched.png");
  });
});
