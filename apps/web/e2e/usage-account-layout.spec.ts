import { expect, test } from "@playwright/test";

test("account labels and controls remain readable on narrow usage cards", async ({ page }) => {
  const longLabel = "a-very-long-account-label-without-natural-breaks@example.com";

  for (const width of [320, 390, 701, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/usage-view-e2e.html?subscriptions=1");

    const card = page.locator(".subscription-source").filter({ hasText: "Codex App Server on build-box" });
    const account = card.locator(".subscription-account");
    const refresh = card.getByRole("button", { name: "Refresh Account" });
    await expect(account).toHaveText("Account: codex@example.com");
    await expect(card.locator(".subscription-state")).toBeVisible();
    await expect(refresh).toBeVisible();

    const emailLines = await account.evaluate((element) => {
      const label = element.lastChild!;
      const range = document.createRange();
      range.setStart(label, 0);
      range.setEnd(label, label.textContent!.length);
      return range.getClientRects().length;
    });
    expect(emailLines, `email should fit on one line at ${width}px`).toBe(1);

    if (width <= 701) {
      const refreshSize = await refresh.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        textLines: (() => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getClientRects().length;
        })(),
      }));
      expect(refreshSize.height).toBeGreaterThanOrEqual(44);
      expect(refreshSize.textLines).toBe(1);
    }

    await account.evaluate((element, label) => {
      element.lastChild!.textContent = ` ${label}`;
    }, longLabel);
    await expect(account).toHaveText(`Account: ${longLabel}`);
    await expect(refresh).toBeVisible();
    await expect(card.locator(".subscription-state")).toBeVisible();
    const geometry = await account.evaluate((element) => {
      const card = element.closest(".subscription-source")!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element.lastChild!);
      return {
        linesInsideCard: [...range.getClientRects()].every((line) =>
          line.left >= card.left && line.right <= card.right),
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(geometry.linesInsideCard).toBe(true);
    expect(geometry.documentWidth).toBeLessThanOrEqual(width);
  }
});
