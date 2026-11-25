import { test, expect } from "@playwright/test";

for (const width of [1440, 390]) for (const theme of ["dark", "light"]) {
  test(`#4187 image reviewer cleanup at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`/campaign-status-e2e.html?scenario=campaign&activity=cleanup&imageReviewers=1&theme=${theme}&chrome=1`);
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    const cleanup = page.locator('[data-campaign-section="Cleanup"]');
    await cleanup.getByText("Image Reviewer", { exact: true }).first().scrollIntoViewIfNeeded();
    await expect(cleanup.getByText("Image Reviewer", { exact: true })).toHaveCount(8);
    await expect(cleanup.getByText("Wollipog stops and archives the reviewer when its runner confirms release.", { exact: false })).toHaveCount(8);
    expect(await page.locator(".campaign-status").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const reviewer = cleanup.getByText("Image Reviewer", { exact: true }).first();
    await reviewer.evaluate(element => {
      const scroller = element.closest(".campaign-status")!;
      scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        - scroller.querySelector(".campaign-section-index")!.getBoundingClientRect().height - 16;
    });
    await expect(cleanup.getByRole("link").first()).toBeInViewport();
    await expect(cleanup.getByText("Nothing is needed from you.", { exact: true }).first()).toBeInViewport();
    if (process.env.IMAGE_REVIEWER_EVIDENCE_DIR) {
      await page.screenshot({ path: `${process.env.IMAGE_REVIEWER_EVIDENCE_DIR}/reviewers-${width}-${theme}.png` });
    }
  });
}

for (const [width, theme] of [[390, "light"], [1440, "dark"]] as const) {
  test(`#4187 failed reviewer retirement at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`/campaign-status-e2e.html?scenario=campaign&activity=cleanup&imageReviewers=1&failedReviewer=1&theme=${theme}&chrome=1`);
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    const cleanup = page.locator('[data-campaign-section="Cleanup"]');
    await cleanup.getByText("Image Reviewer", { exact: true }).first().evaluate(element => {
      const scroller = element.closest(".campaign-status")!;
      scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        - scroller.querySelector(".campaign-section-index")!.getBoundingClientRect().height - 16;
    });
    await expect(cleanup.getByText("Open the reviewer session and choose Retry Stop, or reconnect its runner.", { exact: true })).toHaveCount(8);
    expect(await page.locator(".campaign-status").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    if (process.env.IMAGE_REVIEWER_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.IMAGE_REVIEWER_EVIDENCE_DIR}/failed-${width}-${theme}.png` });
  });
}
