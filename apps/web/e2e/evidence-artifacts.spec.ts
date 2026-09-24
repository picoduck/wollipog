import { expect, test, type Page } from "@playwright/test";

const SHOT = "test-results/evidence-artifacts";

async function openReview(page: Page, query: string): Promise<void> {
  await page.goto(`/request-surfaces-e2e.html?scenario=evidence&${query}`);
  await page.getByRole("button", { name: "Review Evidence" }).click();
  await expect(page.getByRole("complementary", { name: "Requests" })).toBeVisible();
}

const artifactRequests = (page: Page) =>
  page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.artifactRequests());

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
  await expect(broken.getByRole("alert")).toContainText("matches its recorded digest but could not be displayed as an image");
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

test("mixed decisions show artifacts in place and keep a labelled external link for everything else", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReview(page, "items=4&artifacts=mixed");
  await expect(page.locator(".evidence-review-item").first().getByRole("img")).toBeVisible();
  for (const id of ["viewport-2", "interaction-clip"]) {
    const item = page.locator(".evidence-review-item", { hasText: id });
    await expect(item.getByRole("link", { name: `View External Evidence: ${id}` })).toBeVisible();
    await expect(item.locator(".evidence-artifact")).toHaveCount(0);
    await expect(item.getByRole("checkbox")).toBeEnabled();
  }
  expect((await artifactRequests(page)).every((id) => id !== "art_clip")).toBe(true);
  await page.screenshot({ path: `${SHOT}/desktop-mixed.png` });
});

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
