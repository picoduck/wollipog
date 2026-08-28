import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const imagePath = fileURLToPath(new URL("../public/icons/icon-512.png", import.meta.url));

test("HTTPS transcript media embeds resize virtual rows and failed media leaves its link", async ({ page }) => {
  let releaseImage!: () => void;
  const imageReleased = new Promise<void>((resolve) => { releaseImage = resolve; });
  const imageBody = await readFile(imagePath);
  await page.route("https://evidence.example/session-review.png?*", async (route) => {
    await imageReleased;
    await route.fulfill({ status: 200, contentType: "image/png", body: imageBody });
  });
  await page.route("https://evidence.example/session-walkthrough.webm?*", (route) =>
    route.fulfill({ status: 410, contentType: "text/plain", body: "expired" }));

  await page.goto("/inline-media-e2e.html", { waitUntil: "domcontentloaded" });
  const mediaRow = page.locator("[data-virtual-key='item:agent_message:2']");
  await expect(mediaRow).toBeVisible();
  const heightBefore = await mediaRow.evaluate((element) => element.getBoundingClientRect().height);

  releaseImage();
  const image = mediaRow.locator("img.md-media-image");
  await expect(image).toHaveAttribute("data-load-state", "loaded");
  await expect(image).toHaveAttribute("loading", "lazy");
  await expect(image.locator("xpath=..")).toHaveAttribute("target", "_blank");
  await expect(mediaRow.locator("video")).toHaveCount(0);
  await expect(mediaRow.getByRole("link", { name: /session-walkthrough\.webm/ })).toBeVisible();

  const heightAfter = await mediaRow.evaluate((element) => element.getBoundingClientRect().height);
  expect(heightAfter).toBeGreaterThan(heightBefore + 100);
  const nextRow = page.locator("[data-virtual-key='item:user_message:3']");
  await expect(nextRow).toBeVisible();
  const geometry = await page.locator("[data-virtual-key='item:agent_message:2'], [data-virtual-key='item:user_message:3']")
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect()).map(({ top, bottom }) => ({ top, bottom })));
  expect(geometry[1]!.top).toBeGreaterThanOrEqual(geometry[0]!.bottom - 0.5);
});

test("inline transcript images stay bounded on desktop and mobile", async ({ page }) => {
  const imageBody = await readFile(imagePath);
  await page.route("https://evidence.example/session-review.png?*", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: imageBody }));
  await page.route("https://evidence.example/session-walkthrough.webm?*", (route) =>
    route.fulfill({ status: 410, contentType: "text/plain", body: "expired" }));

  for (const viewport of [{ width: 1280, height: 840 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/inline-media-e2e.html");
    const image = page.locator("img.md-media-image");
    await expect(image).toHaveAttribute("data-load-state", "loaded");
    const box = await image.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(viewport.width - 40);
    expect(box!.height).toBeLessThanOrEqual(viewport.height * 0.6 + 1);
  }
});
