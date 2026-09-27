import { expect, test, type Locator } from "@playwright/test";

/** The glyph's rendered alpha (0–255) and whether a surface is drawn behind it. */
async function paint(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const alphaOf = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3]!;
    };
    return { glyphAlpha: alphaOf(style.color), surfaceAlpha: alphaOf(style.backgroundColor), color: style.color };
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`unavailable message actions render muted at rest, on hover and on focus (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const url = "/command-inbox-projects-e2e.html?scenario=edit-in-fork";
    await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Expand Session" });
    if (await expand.isVisible()) await expand.click();

    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
    const resend = page.getByLabel("Edit User Message as a New Turn Unavailable").last();
    const editInFork = page.getByLabel("Edit User Message in a New Conversation Fork Unavailable");
    await expect(resend).toBeVisible();
    await expect(editInFork).toBeVisible();
    // Copy stays usable offline, so it is the enabled action on the same row.
    const row = page.locator(".tl-message-actions").filter({ has: editInFork });
    const enabled = row.locator("button.tl-message-icon").first();
    await expect(enabled).toBeEnabled();

    const enabledAtRest = await paint(enabled);
    const unavailableAtRest = await paint(resend);
    expect(enabledAtRest.glyphAlpha).toBe(255);
    expect(unavailableAtRest.glyphAlpha).toBeLessThan(160);
    // One shared treatment: Edit in Fork and Edit & Resend paint the same.
    expect((await paint(editInFork)).color).toBe(unavailableAtRest.color);

    // Hover lifts an enabled action once its short color/background transition settles.
    await enabled.hover();
    await expect.poll(async () => (await paint(enabled)).surfaceAlpha).toBeGreaterThan(0);
    expect((await paint(enabled)).glyphAlpha).toBe(255);

    await resend.hover();
    expect(await paint(resend)).toEqual(unavailableAtRest);

    await page.mouse.move(0, 0);
    await resend.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(resend).toBeFocused();
    expect(await paint(resend)).toEqual(unavailableAtRest);
    // The focus ring is not faded with the glyph.
    const outline = await resend.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle, opacity: style.opacity };
    });
    expect(outline).toEqual({ width: "2px", style: "solid", opacity: "1" });

    // Pressing still discloses the reason under the same accessible name.
    await page.keyboard.press("Enter");
    await expect(page.locator(".tl-message-action-unavailable[open] > [role=status]"))
      .toContainText("Runner is offline.");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await paint(resend)).toEqual(unavailableAtRest);
  });
}
