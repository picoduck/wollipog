import { expect, test, type Locator, type Page } from "@playwright/test";

// These cases exercise the explicitly enabled privacy mode. Default-off behavior has separate coverage.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
});

/** #1954: a masked email says what it hides, and its reveal control is a real square small button. */
const SURFACES: Array<{ name: string; open: (page: Page) => Promise<Locator>; reveal: string; email: string }> = [
  {
    name: "the authentication account picker",
    open: async (page) => {
      await page.goto("/authentication-recovery-e2e.html?emailLabels=1");
      await page.getByRole("button", { name: "Review Request" }).click();
      const recovery = page.getByRole("group", { name: "Account Recovery" });
      await expect(recovery.getByText("Checked at", { exact: false })).toBeVisible();
      return recovery.locator(".auth-recovery-account").filter({ hasText: "Signed In" });
    },
    reveal: "Show Account Email",
    email: "jordan.personal@example.net",
  },
  {
    name: "a Usage subscription row",
    open: async (page) => {
      await page.goto("/usage-view-e2e.html?subscriptions=1");
      return page.locator(".subscription-source").filter({ hasText: "Codex App Server on build-box" }).locator(".subscription-account");
    },
    reveal: "Show Account Email",
    email: "codex@example.com",
  },
  {
    name: "People & Devices",
    open: async (page) => {
      await page.goto("/people-devices-e2e.html");
      await expect(page.getByRole("region", { name: "Paired Devices" }).getByText("Pat's Phone")).toBeVisible();
      return page.locator(".access-row-main").filter({ hasText: "Owner" }).first();
    },
    reveal: "Show Person Name",
    email: "owner@example.com",
  },
];

/** The focus ring's outer box, and whether any clipping ancestor cuts into it. */
async function focusRing(control: Locator) {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    const width = parseFloat(style.outlineWidth);
    const reach = width + Math.max(0, parseFloat(style.outlineOffset));
    const box = element.getBoundingClientRect();
    const ring = { left: box.left - reach, top: box.top - reach, right: box.right + reach, bottom: box.bottom + reach };
    const clippedBy: string[] = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(parent);
      if (overflowX === "visible" && overflowY === "visible") continue;
      const clip = parent.getBoundingClientRect();
      if (ring.left < clip.left || ring.right > clip.right || ring.top < clip.top || ring.bottom > clip.bottom) {
        clippedBy.push(`${parent.tagName.toLowerCase()}.${[...parent.classList].join(".")}`);
      }
    }
    return { visible: element.matches(":focus-visible") && style.outlineStyle !== "none" && width > 0, clippedBy };
  });
}

for (const surface of SURFACES) {
  test(`${surface.name}: the mask names an email and the reveal is a 28px square with an unclipped focus ring`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const scope = await surface.open(page);
    const mask = scope.locator(".pid-mask");
    await expect(mask).toHaveText("Email Hidden");
    await expect(mask.locator("svg")).toHaveCount(1);
    await expect(scope).not.toContainText("••");
    expect(await scope.innerHTML()).not.toContain(surface.email);

    const reveal = scope.getByRole("button", { name: surface.reveal });
    const box = (await reveal.boundingBox())!;
    // A small control's height with a mouse (§3.1), measured the same way as a small text button.
    expect(box.width).toBe(28);
    expect(box.height).toBe(28);

    await page.keyboard.press("Tab");
    await reveal.focus();
    expect(await focusRing(reveal)).toEqual({ visible: true, clippedBy: [] });

    await page.keyboard.press("Enter");
    await expect(scope.locator(".pid-value")).toHaveText(surface.email);
    const hide = scope.getByRole("button", { name: surface.reveal.replace("Show", "Hide") });
    await expect(hide).toBeFocused();
    expect(await focusRing(hide)).toEqual({ visible: true, clippedBy: [] });
    await page.keyboard.press("Enter");
    expect(await scope.innerHTML()).not.toContain(surface.email);
  });
}

test.describe("touch", () => {
  // `isMobile` makes Chromium report `(pointer: coarse)`, which the touch-target rule targets.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  for (const surface of SURFACES) {
    test(`${surface.name}: the reveal keeps a 44px touch target`, async ({ page }) => {
      const scope = await surface.open(page);
      const reveal = scope.getByRole("button", { name: surface.reveal });
      const box = (await reveal.boundingBox())!;
      expect(box.width).toBe(box.height);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      // 21px from the centre on every side is inside a 44px target: all land on the reveal control.
      const hits = await page.evaluate(([x, y]) => [[x, y - 21], [x, y + 21], [x - 21, y], [x + 21, y]]
        .map(([px, py]) => Boolean(document.elementFromPoint(px!, py!)?.closest(".pid-toggle"))), [cx, cy]);
      expect(hits).toEqual([true, true, true, true]);
    });
  }
});
