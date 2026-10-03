import { devices, expect, test, type Page } from "@playwright/test";

/**
 * Where focus lands when the composer's Add and Modes panel opens (#1904).
 *
 * The panel focuses its first enabled control. On a phone, focusing a text field would summon the
 * software keyboard over the sheet the user just opened, so a coarse pointer must never land on one.
 * Since the guardrail fields moved into the Guardrails dialog (#2175) the panel holds no text field:
 * with Attach Image disabled (no image support) and no Plan Mode item, the first enabled control is
 * the Guardrails… row, on either pointer.
 */

const phone = devices["Pixel 7"];
const PANEL = "Session Attachments, Modes, and Guardrails";

async function openSession(page: Page, { images, plan }: { images: boolean; plan: boolean }) {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(
    ({ images, plan }) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands(
      [],
      plan ? ["default", "acceptEdits", "plan"] : ["default", "acceptEdits"],
      { supportsImages: images },
    ),
    { images, plan },
  );
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".composer-input")).toBeEnabled();
}

/** Two frames: long enough for the open effect and any focus recovery that runs a frame later. */
async function settle(page: Page) {
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** The focused element, described by what matters here: its tag, and whether the panel holds it. */
async function focused(page: Page) {
  return page.evaluate((label) => {
    const active = document.activeElement;
    const panel = document.querySelector(`[role="dialog"][aria-label="${label}"]`);
    return {
      tag: active?.tagName.toLowerCase() ?? null,
      isPanel: active !== null && active === panel,
      inPanel: Boolean(panel && active && panel.contains(active)),
      name: active?.getAttribute("aria-label") ?? active?.textContent?.trim() ?? null,
    };
  }, PANEL);
}

test.describe("on a coarse pointer", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent: phone.userAgent,
    deviceScaleFactor: phone.deviceScaleFactor,
  });

  test("opening with images and Plan both unsupported focuses the Guardrails… row, not a field", async ({ page }) => {
    await openSession(page, { images: false, plan: false });
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      "this emulation must report the coarse pointer the rule is keyed on").toBe(true);

    await page.getByRole("button", { name: "Add and Modes" }).tap();
    const panel = page.getByRole("dialog", { name: PANEL });
    await expect(panel).toBeVisible();
    // The case the bug needed: nothing above the guardrail rows can take focus.
    await expect(page.getByRole("button", { name: "Attach Image", exact: true })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "Plan Mode" })).toHaveCount(0);
    await settle(page);

    const state = await focused(page);
    expect(["input", "textarea", "select"], "no text-entry field may take focus on open").not.toContain(state.tag);
    await expect(page.getByRole("button", { name: "Guardrails…" }), "focus lands on the first enabled row").toBeFocused();
    await expect(panel).toHaveAttribute("aria-label", PANEL);
  });

  for (const { images, plan } of [
    { images: true, plan: false },
    { images: false, plan: true },
    { images: true, plan: true },
  ]) {
    test(`opening with images ${images ? "supported" : "unsupported"} and Plan ${plan ? "supported" : "unsupported"} never focuses a field`, async ({ page }) => {
      await openSession(page, { images, plan });
      await page.getByRole("button", { name: "Add and Modes" }).tap();
      await expect(page.getByRole("dialog", { name: PANEL })).toBeVisible();
      await settle(page);

      const state = await focused(page);
      expect(["input", "textarea", "select"]).not.toContain(state.tag);
      expect(state.inPanel || state.isPanel, "focus moves into the opened panel").toBe(true);
    });
  }
});

test.describe("on a fine pointer", () => {
  for (const key of ["Enter", " ", "ArrowDown"]) {
    test(`${key === " " ? "Space" : key} opens into the first control, and Escape returns to the trigger`, async ({ page }) => {
      await openSession(page, { images: false, plan: false });
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);

      const trigger = page.getByRole("button", { name: "Add and Modes" });
      await trigger.focus();
      await page.keyboard.press(key);
      await expect(page.getByRole("dialog", { name: PANEL })).toBeVisible();
      await settle(page);

      const state = await focused(page);
      expect(state.inPanel, "keyboard opening moves focus into the panel").toBe(true);
      // Today's rule, unchanged: the first enabled control, here the Guardrails… row.
      await expect(page.getByRole("button", { name: "Guardrails…" })).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: PANEL })).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }
});
