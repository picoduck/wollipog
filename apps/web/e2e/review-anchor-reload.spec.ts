import { expect, test } from "@playwright/test";

/**
 * #1286 through the rendered pane: a freshly loaded Review holds no anchor history, so the verdict
 * has to come from the finding itself. The fixture mounts once per navigation, which is what makes
 * each of these a reload rather than a refresh inside a session that already carried its anchors.
 *
 * The body text appears in the findings list either way, so the assertions read the two places that
 * actually differ: the inline comment attached to the diff line, and the stale badge on the row.
 */

const BODY = "This recurses without a delay — back off before retrying.";

test("a finding whose line is unchanged stays anchored after a reload", async ({ page }) => {
  await page.goto("/review-anchor-reload-e2e.html?theme=dark");
  await expect(page.locator(".diff-inline-finding-body")).toHaveText(BODY);
  await expect(page.locator(".review-stale")).toHaveCount(0);
});

test("a finding written before the anchored line was recorded keeps the old fallback", async ({ page }) => {
  // The pre-#1286 shape: no stored line, no client-side history, so hash equality is all there is.
  // It must keep working — degraded, never broken — which is what this contrast pins.
  await page.goto("/review-anchor-reload-e2e.html?theme=dark&stored=0");
  await expect(page.locator(".review-stale")).toHaveText("Stale Diff Anchor");
  await expect(page.locator(".diff-inline-finding-body")).toHaveCount(0);
  await expect(page.locator(".review-finding-row")).toContainText(BODY);
});
