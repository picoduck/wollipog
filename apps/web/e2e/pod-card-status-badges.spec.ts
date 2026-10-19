import { expect, test, type Page } from "@playwright/test";

/**
 * #1992: a phone status badge keeps its own width instead of stretching into a full-width bar
 * (docs/design-system.md §11.1). The Pod page's Orchestration Controls and Reconcile Committed Work
 * cards, whose stacked headers once stretched theirs, became dialogs from ⋯ (#2980); every badge
 * left on the page still keeps its width.
 */

async function openPod(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html?view=pod");
  await expect(page.locator(".pod-detail").getByRole("heading", { level: 1, name: "Active Collaboration Pod" })).toBeVisible();
}

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 1600 } });

  test("no status badge in the Pod detail stretches past its own width", async ({ page }) => {
    await openPod(page);
    const stretched = await page.locator(".pod-detail .status").evaluateAll((badges) => badges
      .filter((badge) => badge.getClientRects().length > 0)
      .map((badge) => {
        const element = badge as HTMLElement;
        const width = element.getBoundingClientRect().width;
        element.style.width = "max-content";
        const intrinsic = element.getBoundingClientRect().width;
        element.style.width = "";
        return { label: element.textContent, width, intrinsic };
      })
      .filter(({ width, intrinsic }) => width - intrinsic > 0.5));
    expect(stretched).toEqual([]);
  });
});
