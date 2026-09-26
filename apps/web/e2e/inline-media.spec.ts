import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const imagePath = fileURLToPath(new URL("../public/icons/icon-512.png", import.meta.url));
const videoPath = fileURLToPath(new URL("./fixtures/inline-media.webm", import.meta.url));

test("runner history replay returns a retained attachment to its conversation position", async ({ page }) => {
  const imageBody = await readFile(fileURLToPath(new URL("../public/icons/icon-192.png", import.meta.url)));
  await page.route("**/api/artifacts/replay-proof/export", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: imageBody }));
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
  await page.route("**/api/sessions/attachment-replay-e2e/retained-attachment-events?*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      events: [{
        id: 501, sessionId: "attachment-replay-e2e", seq: 1, ts: 2_000,
        payload: { kind: "artifact_attached", artifact: {
          artifactId: "replay-proof", sessionId: "attachment-replay-e2e", kind: "screenshot",
          name: "proof.png", mimeType: "image/png", encoding: "base64", sizeBytes: 70_182,
          sha256: "1f3a9c4feced44d27b2b68bb4027ce7fa3cd0b4594ff00d78c9d46e004bd9fb4",
          createdBy: { kind: "agent", id: "attachment-replay-e2e" }, createdAt: 2_000,
        } },
      }], eventEpoch: 1, nextAfter: 1, hasMore: false,
    }) }));
  await page.goto("/inline-media-e2e.html?attachmentReplay=1&freshTail=1");
  await expect(page.locator("[data-virtual-key='item:artifact_attached:1']")).toBeVisible();
  const rows = await page.locator("[data-virtual-key^='item:']").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-virtual-key")));
  expect(rows).toEqual([
    "item:user_message:2", "item:artifact_attached:1", "item:user_message:3",
  ]);
  await expect(page.getByText("proof.png")).toHaveCount(1);
});

test("HTTPS transcript media embeds resize virtual rows and failed media leaves its link", async ({ page }) => {
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
  const plainImageLink = mediaRow.locator('a[href^="https://evidence.example/session-review.png"]:not(.md-media-image-link)');
  const fullSizeLink = mediaRow.locator("a.md-media-image-link");
  await expect(fullSizeLink).not.toHaveAttribute("href", /.+/);
  await expect(fullSizeLink).toHaveAttribute("aria-hidden", "true");
  await expect(fullSizeLink).not.toHaveAttribute("aria-label", /.+/);
  await plainImageLink.focus();
  await page.keyboard.press("Tab");
  await expect(mediaRow.locator('a[href^="https://evidence.example/session-walkthrough.webm"]')).toBeFocused();

  releaseImage();
  const image = mediaRow.locator("img.md-media-image");
  await expect(image).toHaveAttribute("data-load-state", "loaded");
  await expect(image).toHaveAttribute("alt", "session-review.png");
  await expect(image).toHaveAttribute("loading", "lazy");
  await expect(image.locator("xpath=..")).toHaveAttribute("target", "_blank");
  expect(await fullSizeLink.getAttribute("aria-hidden")).toBeNull();
  await expect(fullSizeLink).toHaveAttribute("aria-label", "Open session-review.png Full Size");
  await plainImageLink.focus();
  await page.keyboard.press("Tab");
  await expect(fullSizeLink).toBeFocused();
  await expect(mediaRow.locator("video")).toHaveCount(0);
  await expect(mediaRow.getByRole("link", { name: /session-walkthrough\.webm/ })).toBeVisible();

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
    await expect(page.locator("a.md-media-image-link")).toHaveAttribute(
      "aria-label",
      "Open session-review.png Full Size",
    );
    await expect(video).toHaveAttribute("aria-label", "session-walkthrough.webm");
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
  await expect(mediaRow.locator(".md-media-embed")).toHaveCount(0);
  expect(imageRequests).toEqual([]);
  expect(videoRequests).toEqual([]);

  await advance.evaluate((button: HTMLButtonElement) => button.click());
  await expect(mediaRow.locator('a[href$="X-Amz-Signature=re"]')).toBeAttached();
  await expect(mediaRow.locator(".md-media-embed")).toHaveCount(0);
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
