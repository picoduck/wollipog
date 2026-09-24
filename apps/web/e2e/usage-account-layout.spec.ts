import { expect, test } from "@playwright/test";

test("account labels and controls remain readable on narrow usage cards", async ({ page }) => {
  const longLabel = "a-very-long-account-label-without-natural-breaks@example.com";

  for (const width of [320, 390, 600, 701, 875, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/usage-view-e2e.html?subscriptions=1");

    const card = page.locator(".subscription-source").filter({ hasText: "Codex App Server on build-box" });
    const account = card.locator(".subscription-account");
    const refresh = card.getByRole("button", { name: "Refresh Account" });
    // #1648: the email is masked on every layout until the person reveals it.
    await expect(account).not.toContainText("codex@example.com");
    expect(await card.innerHTML()).not.toContain("codex@example.com");
    const reveal = account.getByRole("button", { name: "Show Account Email" });
    await expect(reveal).toBeVisible();
    await reveal.click();
    const value = account.locator(".personal-identifier-value");
    await expect(value).toHaveText("codex@example.com");
    await expect(account.getByRole("button", { name: "Hide Account Email" })).toBeVisible();
    await expect(card.locator(".subscription-state")).toBeVisible();
    await expect(refresh).toBeVisible();

    const emailLines = await value.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    });
    expect(emailLines, `email should fit on one line at ${width}px`).toBe(1);

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

    if (width === 875) {
      await card.locator(".subscription-state").evaluate((element) => {
        element.textContent = "Temporarily Unavailable";
      });
      const linesWithLongStatus = await value.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      });
      expect(linesWithLongStatus).toBe(1);
    }

    await value.evaluate((element, label) => {
      element.textContent = label;
    }, longLabel);
    await expect(value).toHaveText(longLabel);
    await expect(refresh).toBeVisible();
    await expect(card.locator(".subscription-state")).toBeVisible();
    const geometry = await value.evaluate((element) => {
      const card = element.closest(".subscription-source")!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      return {
        linesInsideCard: [...range.getClientRects()].every((line) =>
          line.left >= card.left && line.right <= card.right),
        controlsInsideCard: [...element.closest(".subscription-source")!.querySelectorAll(
          ".subscription-state, header > .btn, .personal-identifier-toggle",
        )]
          .every((control) => {
            const bounds = control.getBoundingClientRect();
            return bounds.left >= card.left && bounds.right <= card.right;
          }),
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(geometry.linesInsideCard).toBe(true);
    expect(geometry.controlsInsideCard).toBe(true);
    expect(geometry.documentWidth).toBeLessThanOrEqual(width);
  }
});

test.describe("touch", () => {
  // `isMobile` makes Chromium report `(pointer: coarse)`, which the touch-target rule targets.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the account email reveal keeps a 44px touch target around its compact glyph (#1648)", async ({ page }) => {
    await page.goto("/usage-view-e2e.html?subscriptions=1");
    const card = page.locator(".subscription-source").filter({ hasText: "Codex App Server on build-box" });
    const reveal = card.getByRole("button", { name: "Show Account Email" });
    await expect(reveal).toBeVisible();
    const box = (await reveal.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Probe 20px from the glyph's centre on every side: all still land on the reveal control.
    const hits = await page.evaluate(([x, y]) => [[x, y - 20], [x, y + 20], [x - 20, y], [x + 20, y]]
      .map(([px, py]) => Boolean(document.elementFromPoint(px!, py!)?.closest(".personal-identifier-toggle"))), [cx, cy]);
    expect(hits).toEqual([true, true, true, true]);
    await page.touchscreen.tap(cx + 18, cy);
    await expect(card.locator(".personal-identifier-value")).toHaveText("codex@example.com");
  });
});
