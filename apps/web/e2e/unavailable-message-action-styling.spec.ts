import { expect, test, type Locator } from "@playwright/test";

/**
 * How an action icon paints: its glyph color, contrast against the transcript behind it, whether a
 * surface is raised under it, and whether the unavailable slash is drawn across it.
 */
async function paint(locator: Locator) {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data] as [number, number, number, number];
    };
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    let backdrop: Element | null = element.parentElement;
    while (backdrop && rgba(getComputedStyle(backdrop).backgroundColor)[3] === 0) backdrop = backdrop.parentElement;
    const ground = rgba(getComputedStyle(backdrop ?? document.body).backgroundColor);
    const style = getComputedStyle(element);
    const ink = rgba(style.color);
    const [hi, lo] = [luminance(ink), luminance(ground)].sort((a, b) => b - a) as [number, number];
    const slash = getComputedStyle(element, "::after");
    return {
      color: style.color,
      glyphAlpha: ink[3],
      contrast: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
      surfaceAlpha: rgba(style.backgroundColor)[3],
      opacity: style.opacity,
      slashed: slash.content === '""' && slash.width === "18px",
    };
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`unavailable message actions stay slashed at rest, on hover and on focus (${theme})`, async ({ page }) => {
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
    expect(enabledAtRest.slashed).toBe(false);
    expect(unavailableAtRest.slashed).toBe(true);
    // Still a pressable control: an opaque glyph that clears 3:1 non-text contrast, not a faded one.
    expect(unavailableAtRest.glyphAlpha).toBe(255);
    expect(unavailableAtRest.opacity).toBe("1");
    expect(unavailableAtRest.contrast).toBeGreaterThanOrEqual(3);
    expect(unavailableAtRest.contrast).toBeLessThan(enabledAtRest.contrast);
    // One shared treatment: Edit in Fork and Edit & Resend paint the same.
    expect(await paint(editInFork)).toEqual(unavailableAtRest);

    // Hover lifts an enabled action once its short color/background transition settles.
    await enabled.hover();
    await expect.poll(async () => (await paint(enabled)).surfaceAlpha).toBeGreaterThan(0);

    await resend.hover();
    expect(await paint(resend)).toEqual(unavailableAtRest);

    await page.mouse.move(0, 0);
    await resend.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(resend).toBeFocused();
    expect(await paint(resend)).toEqual(unavailableAtRest);
    const outline = await resend.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(outline).toEqual({ width: "2px", style: "solid" });

    // Pressing still discloses the reason under the same accessible name.
    await page.keyboard.press("Enter");
    await expect(page.locator(".tl-message-action-unavailable[open] > [role=status]"))
      .toContainText("Runner is offline.");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await paint(resend)).toEqual(unavailableAtRest);
  });
}
