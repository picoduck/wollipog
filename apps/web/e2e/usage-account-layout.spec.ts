import { expect, test, type Page } from "@playwright/test";

// These cases exercise the explicitly enabled privacy mode. Default-off behavior has separate coverage.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
});

const codexAccount = (page: Page) =>
  page.locator(".subscription-plan").filter({ hasText: "Codex App Server on build-box" });

test("account labels and controls stay inside their surface at every width (#3014)", async ({ page }) => {
  const longLabel = "a-very-long-account-label-without-natural-breaks@example.com";

  for (const width of [320, 390, 600, 701, 875, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/usage-view-e2e.html?tab=subscriptions&subscriptions=1");

    const surface = codexAccount(page);
    const account = surface.locator(".subscription-plan-account");
    const refresh = surface.getByRole("button", { name: "Refresh Account" });
    // #1648: the email is masked on every layout until the person reveals it.
    await expect(account).not.toContainText("codex@example.com");
    expect(await surface.innerHTML()).not.toContain("codex@example.com");
    const reveal = surface.getByRole("button", { name: "Show Account Email" });
    await expect(reveal).toBeVisible();
    await reveal.click();
    const value = account.locator(".pid-value");
    await expect(value).toHaveText("codex@example.com");
    await expect(surface.getByRole("button", { name: "Hide Account Email" })).toBeVisible();
    await expect(refresh).toBeVisible();

    const emailLines = await value.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    });
    expect(emailLines, `email should fit on one line at ${width}px`).toBe(1);

    // Both account controls are small square icon buttons with a mouse (§3.1, §11.8); on a touch
    // screen they borrow a 44px hit area (the touch test below).
    for (const control of [refresh, surface.getByRole("button", { name: "Hide Account Email" })]) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBe(28);
      expect(box.height).toBe(28);
    }

    await value.evaluate((element, label) => {
      element.textContent = label;
    }, longLabel);
    await expect(value).toHaveText(longLabel);
    await expect(refresh).toBeVisible();
    const geometry = await surface.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const inside = (node: Element) => {
        const box = node.getBoundingClientRect();
        return box.left >= bounds.left && box.right <= bounds.right;
      };
      const value = element.querySelector(".pid-value")!;
      const range = document.createRange();
      range.selectNodeContents(value);
      return {
        linesInside: [...range.getClientRects()].every((line) => line.left >= bounds.left && line.right <= bounds.right),
        controlsInside: [...element.querySelectorAll(".subscription-plan-actions > button, .subscription-window .status")].every(inside),
        rowsInside: [...element.querySelectorAll(".subscription-window > *")].every(inside),
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(geometry.linesInside).toBe(true);
    expect(geometry.controlsInside).toBe(true);
    expect(geometry.rowsInside).toBe(true);
    expect(geometry.documentWidth).toBeLessThanOrEqual(width);
  }
});

test.describe("touch", () => {
  // `isMobile` makes Chromium report `(pointer: coarse)`, which the touch-target rule targets.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("at 390px nothing scrolls sideways, and Refresh Account and the reveal are 44px targets (#1648, #3014)", async ({ page }) => {
    await page.goto("/usage-view-e2e.html?tab=subscriptions&subscriptions=1");
    const surface = codexAccount(page);
    await expect(surface).toBeVisible();
    await page.locator("#usage-subscriptions-panel details.disclosure > summary").click();
    await expect(page.locator(".subscription-unavailable-row")).toHaveCount(3);
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      wide: [...document.querySelectorAll("#usage-subscriptions-panel *")]
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 0.5)
        .map((element) => element.className),
    }));
    expect(overflow.document).toBeLessThanOrEqual(390);
    expect(overflow.wide).toEqual([]);

    for (const [name, target] of [["Refresh Account", "button[aria-label=\"Refresh Account\"]"], ["Show Account Email", ".pid-toggle"]] as const) {
      const control = surface.getByRole("button", { name });
      // Opening the disclosure scrolled the page; hit-test the control where it can be seen.
      await control.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const box = (await control.boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      // 21px from the centre on every side is inside a 44px target: all land on the control.
      const hits = await page.evaluate(([x, y, selector]) => [[x, y - 21], [x, y + 21], [x - 21, y], [x + 21, y]]
        .map(([px, py]) => Boolean(document.elementFromPoint(px as number, py as number)?.closest(selector as string))), [cx, cy, target]);
      expect(hits, name).toEqual([true, true, true, true]);
    }
    await surface.getByRole("button", { name: "Show Account Email" }).tap();
    await expect(surface.locator(".pid-value")).toHaveText("codex@example.com");
  });
});
