import { expect, test, type Page } from "@playwright/test";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #1992: a phone card header stacks its text above its status badge, and the badge keeps its own
 * width at the start of the row instead of stretching into a full-width bar (docs/design-system.md
 * §11.1). The Pod detail's Orchestration Controls and Reconcile Committed Work cards are the only
 * card headers that stack a status badge in a column at phone widths.
 */

const CARDS = [
  { section: "Pod Orchestration Policy", heading: "Orchestration Controls", badge: "Idle" },
  { section: "Pod Worktree Reconciliation", heading: "Reconcile Committed Work", badge: "Ready" },
] as const;

async function openPod(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html?view=pod");
  await expect(page.locator(".pod-detail").getByRole("heading", { level: 1, name: "Active Collaboration Pod" })).toBeVisible();
}

async function measure(page: Page, section: string) {
  return page.getByRole("region", { name: section, exact: true }).evaluate((card) => {
    const head = card.querySelector<HTMLElement>(":scope > .pod-relay-head")!;
    const text = head.firstElementChild!.getBoundingClientRect();
    const badge = head.querySelector<HTMLElement>(":scope > .status")!;
    const box = badge.getBoundingClientRect();
    // The badge's own width, read with nothing stretching it.
    badge.style.width = "max-content";
    const intrinsic = badge.getBoundingClientRect().width;
    badge.style.width = "";
    const style = getComputedStyle(card);
    const rect = card.getBoundingClientRect();
    const contentLeft = rect.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
    const contentRight = rect.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight);
    return {
      direction: getComputedStyle(head).flexDirection,
      badgeText: badge.textContent,
      badge: { left: box.left, right: box.right, top: box.top, width: box.width, centerY: box.top + box.height / 2 },
      text: { left: text.left, width: text.width, bottom: text.bottom, centerY: text.top + text.height / 2 },
      intrinsic,
      contentLeft,
      contentRight,
      contentWidth: contentRight - contentLeft,
    };
  });
}

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 1600 } });

  for (const card of CARDS) {
    test(`the ${card.heading} status badge keeps its width at the card's content edge`, async ({ page }) => {
      await openPod(page);
      const m = await measure(page, card.section);
      expect(m.badgeText).toBe(card.badge);
      expect(m.direction, "the phone header stacks its text above the badge").toBe("column");
      // The badge's box is its intrinsic width: a stretched badge measures the card's content width.
      expect(Math.abs(m.badge.width - m.intrinsic)).toBeLessThanOrEqual(0.5);
      expectGeometry(m.contentWidth - m.badge.width, "a short status label leaves most of the card empty")
        .toBeGreaterThan(m.contentWidth / 2);
      // Stylesheet-fixed positions: the badge and the text start on the card's content edge, and the
      // text keeps the full content width it has on a phone today.
      expect(Math.abs(m.badge.left - m.contentLeft)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(m.text.left - m.contentLeft)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(m.text.width - m.contentWidth)).toBeLessThanOrEqual(0.5);
      expect(m.badge.top, "the badge sits under the heading text").toBeGreaterThanOrEqual(m.text.bottom);
    });
  }

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

test.describe("at 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const card of CARDS) {
    test(`the ${card.heading} status badge stays at the end of its header row`, async ({ page }) => {
      await openPod(page);
      const m = await measure(page, card.section);
      expect(m.direction).toBe("row");
      expect(Math.abs(m.badge.width - m.intrinsic)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(m.badge.right - m.contentRight)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(m.badge.centerY - m.text.centerY)).toBeLessThanOrEqual(0.5);
    });
  }
});
