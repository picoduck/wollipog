import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const imagePath = fileURLToPath(new URL("../public/icons/icon-512.png", import.meta.url));
const videoPath = fileURLToPath(new URL("./fixtures/inline-media.webm", import.meta.url));
const replayAttachmentPage = {
  events: [{
    id: 501, sessionId: "attachment-replay-e2e", seq: 1, ts: 2_000,
    payload: { kind: "artifact_attached", artifact: {
      artifactId: "replay-proof", sessionId: "attachment-replay-e2e", kind: "screenshot",
      name: "proof.png", mimeType: "image/png", encoding: "base64", sizeBytes: 70_182,
      sha256: "1f3a9c4feced44d27b2b68bb4027ce7fa3cd0b4594ff00d78c9d46e004bd9fb4",
      createdBy: { kind: "agent", id: "attachment-replay-e2e" }, createdAt: 2_000,
    } },
  }], eventEpoch: 1, nextAfter: 1, hasMore: false,
};

function routeReplayAttachments(page: import("@playwright/test").Page) {
  return page.route("**/api/sessions/attachment-replay-e2e/retained-attachment-events?*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(replayAttachmentPage) }));
}

test("runner history replay returns a retained attachment to its conversation position", async ({ page }) => {
  const imageBody = await readFile(fileURLToPath(new URL("../public/icons/icon-192.png", import.meta.url)));
  await page.route("**/api/artifacts/replay-proof/export", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: imageBody }));
  await routeReplayAttachments(page);
  await page.goto("/inline-media-e2e.html?attachmentReplay=1");
  await expect(page.locator("[data-virtual-key='item:artifact_attached:1']")).toBeVisible();
  await page.getByRole("button", { name: "Replay Runner History" }).click();
  await expect(page.locator("[data-virtual-key='item:user_message:3']")).toBeVisible();
  const rows = await page.locator("[data-virtual-key^='item:']").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-virtual-key")));
  expect(rows).toEqual([
    "item:user_message:2", "item:artifact_attached:1", "item:user_message:3",
  ]);
  await expect(page.getByText("proof.png")).toHaveCount(1);
});

test("fresh tail shows a retained attachment outside its ordinary event page", async ({ page }) => {
  const imageBody = await readFile(fileURLToPath(new URL("../public/icons/icon-192.png", import.meta.url)));
  await page.route("**/api/artifacts/replay-proof/export", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: imageBody }));
  await routeReplayAttachments(page);
  await page.goto("/inline-media-e2e.html?attachmentReplay=1&freshTail=1");
  await expect(page.locator("[data-virtual-key='item:artifact_attached:1']")).toBeVisible();
  const rows = await page.locator("[data-virtual-key^='item:']").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-virtual-key")));
  expect(rows).toEqual([
    "item:user_message:2", "item:artifact_attached:1", "item:user_message:3",
  ]);
  await expect(page.getByText("proof.png")).toHaveCount(1);
});

test("HTTPS transcript media is a captioned figure that resizes its virtual row, and failed media leaves its caption", async ({ page }) => {
  let releaseImage!: () => void;
  let imageRequests = 0;
  const imageReleased = new Promise<void>((resolve) => { releaseImage = resolve; });
  const imageBody = await readFile(imagePath);
  await page.route("https://evidence.example/session-review.png?*", async (route) => {
    imageRequests += 1;
    await imageReleased;
    await route.fulfill({ status: 200, contentType: "image/png", body: imageBody });
  });
  await page.route("https://evidence.example/session-walkthrough.webm?*", (route) =>
    route.fulfill({ status: 410, contentType: "text/plain", body: "expired" }));

  await page.goto("/inline-media-e2e.html", { waitUntil: "domcontentloaded" });
  const mediaRow = page.locator("[data-virtual-key='item:agent_message:2']");
  await expect(mediaRow).toBeVisible();
  const heightBefore = await mediaRow.evaluate((element) => element.getBoundingClientRect().height);
  const imageFigure = mediaRow.locator("figure.md-media").filter({ hasText: "session-review.png" });
  const videoFigure = mediaRow.locator("figure.md-media").filter({ hasText: "session-walkthrough.webm" });
  const fullSize = imageFigure.getByRole("link", { name: "Open Full Size" });
  await expect(fullSize).toHaveAttribute("href", /^https:\/\/evidence\.example\/session-review\.png\?X-Amz-Signature=redacted$/);
  await expect(fullSize).toHaveAccessibleDescription("session-review.png");
  await expect(imageFigure.locator(".md-media-meta")).toHaveCount(0);

  // The failed video collapses to its caption: icon, name, reason and Open Link, with no media box.
  await expect(videoFigure.locator("video")).toHaveCount(0);
  await expect(videoFigure.locator("svg.lucide-image-off")).toBeVisible();
  await expect(videoFigure.locator(".md-media-meta")).toHaveText("Couldn't load this video");
  const openLink = videoFigure.getByRole("link", { name: "Open Link" });
  await expect(openLink).toHaveAttribute("target", "_blank");
  await expect(openLink).toHaveAttribute("rel", "noopener noreferrer");
  await fullSize.focus();
  await page.keyboard.press("Tab");
  await expect(openLink).toBeFocused();

  releaseImage();
  const image = imageFigure.locator("img.md-media-image");
  await expect(image).toHaveAttribute("data-load-state", "loaded");
  await expect(image).toHaveAttribute("alt", "session-review.png");
  await expect(image).toHaveAttribute("loading", "lazy");
  await expect(imageFigure.locator(".md-media-meta")).toHaveText("512 × 512");
  expect(await mediaRow.innerText()).not.toMatch(/X-Amz|\?/);

  const heightAfter = await mediaRow.evaluate((element) => element.getBoundingClientRect().height);
  expect(heightAfter).toBeGreaterThan(heightBefore + 100);
  await image.evaluate((element) => { element.dataset.reviewIdentity = "loaded"; });
  await page.getByTestId("reader").dispatchEvent("scroll");
  await page.waitForTimeout(200);
  await expect(image).toHaveAttribute("data-review-identity", "loaded");
  await expect(image).toHaveAttribute("data-load-state", "loaded");
  expect(imageRequests).toBe(1);
  expect(await mediaRow.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(heightAfter, 0);

  const nextRow = page.locator("[data-virtual-key='item:user_message:4']");
  await expect(nextRow).toBeVisible();
  const geometry = await page.locator("[data-virtual-key='item:agent_message:2'], [data-virtual-key='item:user_message:4']")
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect()).map(({ top, bottom }) => ({ top, bottom })));
  expect(geometry[1]!.top).toBeGreaterThanOrEqual(geometry[0]!.bottom - 0.5);
});

test("inline transcript media stays bounded on desktop and mobile", async ({ page }) => {
  const imageBody = await readFile(imagePath);
  const videoBody = await readFile(videoPath);
  await page.route("https://evidence.example/session-review.png?*", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: imageBody }));
  await page.route("https://evidence.example/session-walkthrough.webm?*", (route) =>
    route.fulfill({ status: 200, contentType: "video/webm", body: videoBody }));

  for (const viewport of [{ width: 1280, height: 840 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/inline-media-e2e.html");
    const image = page.locator("img.md-media-image");
    const video = page.locator("video.md-media-video");
    await expect(image).toHaveAttribute("data-load-state", "loaded");
    await expect.poll(() => video.evaluate((element) => element.readyState)).toBeGreaterThan(0);
    await expect(video).toHaveAttribute("controls", "");
    await expect(video).not.toHaveAttribute("autoplay", "");
    await expect(image).toHaveAttribute("alt", "session-review.png");
    await expect(video).toHaveAttribute("aria-label", "session-walkthrough.webm");
    await expect(page.getByRole("link", { name: "Open Full Size" })).toHaveCount(2);
    const box = await image.boundingBox();
    const videoBox = await video.boundingBox();
    expect(box).not.toBeNull();
    expect(videoBox).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(viewport.width - 40);
    expect(box!.height).toBeLessThanOrEqual(viewport.height * 0.6 + 1);
    expect(videoBox!.width).toBeLessThanOrEqual(viewport.width - 40);
    expect(videoBox!.height).toBeLessThanOrEqual(viewport.height * 0.6 + 1);
  }
});

test.describe("on a coarse pointer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Open Full Size keeps its visual size and borrows a 44px hit band", async ({ page }) => {
    const imageBody = await readFile(imagePath);
    const videoBody = await readFile(videoPath);
    await page.route("https://evidence.example/session-review.png?*", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: imageBody }));
    await page.route("https://evidence.example/session-walkthrough.webm?*", (route) =>
      route.fulfill({ status: 200, contentType: "video/webm", body: videoBody }));
    await page.goto("/inline-media-e2e.html");
    await expect(page.locator("img.md-media-image")).toHaveAttribute("data-load-state", "loaded");
    const fullSize = page.locator("figure.md-media").first().getByRole("link", { name: "Open Full Size" });
    const measured = await fullSize.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      band: parseFloat(getComputedStyle(element, "::after").height),
      position: getComputedStyle(element).position,
    }));
    expect(measured.height).toBeLessThanOrEqual(20);
    expect(measured.band).toBe(44);
    expect(measured.position).toBe("relative");
  });

  test("each collapsed caption is a 44px row, so one link's band never reaches the next", async ({ page }) => {
    await page.route("https://evidence.example/**", (route) =>
      route.fulfill({ status: 403, contentType: "text/plain", body: "expired" }));
    await page.goto("/inline-media-e2e.html?expired=1");
    const captions = page.locator("[data-virtual-key='item:agent_message:2'] .md-media-cap");
    await expect(captions).toHaveCount(2);
    await expect(captions.first().locator(".md-media-meta")).toHaveText("Link expired");
    const rows = await captions.evaluateAll((elements) => elements.map((element) => {
      const row = element.getBoundingClientRect();
      const link = element.querySelector("a.link")!;
      const box = link.getBoundingClientRect();
      const band = parseFloat(getComputedStyle(link, "::after").height);
      const bandTop = box.top + box.height / 2 - band / 2;
      return { rowTop: row.top, rowBottom: row.bottom, bandTop, bandBottom: bandTop + band };
    }));
    for (const row of rows) {
      expect(row.rowBottom - row.rowTop).toBeGreaterThanOrEqual(44);
      expect(row.bandTop).toBeGreaterThanOrEqual(row.rowTop - 0.5);
      expect(row.bandBottom).toBeLessThanOrEqual(row.rowBottom + 0.5);
    }
  });
});

test("streamed signed URLs issue no media request until authoritative completion", async ({ page }) => {
  const imageBody = await readFile(imagePath);
  const videoBody = await readFile(videoPath);
  const imageRequests: string[] = [];
  const videoRequests: string[] = [];
  await page.route("https://evidence.example/session-review.png?*", async (route) => {
    imageRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "image/png", body: imageBody });
  });
  await page.route("https://evidence.example/session-walkthrough.webm?*", async (route) => {
    videoRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "video/webm", body: videoBody });
  });

  await page.goto("/inline-media-e2e.html?streaming=1", { waitUntil: "domcontentloaded" });
  const mediaRow = page.locator("[data-virtual-key='item:agent_message:2']");
  const advance = page.getByTestId("advance-media-stream");
  await expect(mediaRow.locator("figure.md-media")).toHaveCount(2);
  await expect(mediaRow.locator("img, video")).toHaveCount(0);
  expect(imageRequests).toEqual([]);
  expect(videoRequests).toEqual([]);

  await advance.evaluate((button: HTMLButtonElement) => button.click());
  await expect(mediaRow.locator('a[href$="X-Amz-Signature=re"]')).toBeAttached();
  await expect(mediaRow.locator("img, video")).toHaveCount(0);
  expect(imageRequests).toEqual([]);
  expect(videoRequests).toEqual([]);

  await advance.evaluate((button: HTMLButtonElement) => button.click());
  const image = mediaRow.locator("img.md-media-image");
  await expect(image).toHaveAttribute("data-load-state", "loaded");
  await expect.poll(() => mediaRow.locator("video.md-media-video").evaluate((element) => element.readyState))
    .toBeGreaterThan(0);
  expect(imageRequests).toEqual([
    "https://evidence.example/session-review.png?X-Amz-Signature=redacted",
  ]);
  expect(videoRequests).toEqual([
    "https://evidence.example/session-walkthrough.webm?X-Amz-Signature=redacted",
  ]);
});
