import { expect, test, type Locator, type Page } from "@playwright/test";

async function assertTopRight(banner: Locator) {
  const [body, action, content] = await Promise.all([
    banner.locator(".notice-body").boundingBox(),
    banner.getByRole("button", { name: /Retry Now|Retrying…/u }).boundingBox(),
    banner.locator(".notice-content").boundingBox(),
  ]);
  expect(body).not.toBeNull();
  expect(action).not.toBeNull();
  expect(content).not.toBeNull();
  expect(Math.abs(action!.y - content!.y), "retry stays at the top").toBeLessThan(1);
  expect(Math.abs(action!.x + action!.width - content!.x - content!.width), "retry stays at the right").toBeLessThan(1);
  expect(body!.x + body!.width, "message and button do not overlap").toBeLessThanOrEqual(action!.x);
  expect(await banner.evaluate((element) => element.scrollWidth <= element.clientWidth), "banner has no horizontal overflow").toBe(true);
  expect(await banner.locator(".notice-body").evaluate((element) => {
    const css = getComputedStyle(element);
    return element.scrollWidth <= element.clientWidth && css.textOverflow !== "ellipsis";
  }), "message wraps without truncation").toBe(true);
}

async function capture(page: Page, width: number, theme: string, state: string) {
  if (process.env.EVIDENCE_DIR && [390, 1440].includes(width)) {
    await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/offline-${width}-${theme}-${state}.png` });
  }
}

for (const width of [320, 390, 760, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`retry stays top right through keyboard retry at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width > 760 ? 900 : 844 });
      await page.addInitScript((value) => localStorage.setItem("wollipog.theme", value), theme);
      await page.goto("/command-inbox-projects-e2e.html?fullShell=1&offlineBanner=1&path=%2Fsettings");
      const banner = page.getByRole("status").filter({ hasText: "Can't reach Wollipog" });
      await expect(banner).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // Freeze automatic retries so the actual store's pending retry is advanced by the keyboard.
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failOfflineAttempt());
      const retry = banner.getByRole("button", { name: /Retry Now|Retrying…/u });
      await expect(retry).not.toHaveAttribute("aria-disabled", "true");
      await capture(page, width, theme, "ready");
      await assertTopRight(banner);
      await retry.focus();
      await page.keyboard.press("Enter");
      await expect(retry).toHaveText("Retrying…");
      await expect(retry).toBeFocused();
      await expect(retry).toHaveAttribute("aria-busy", "true");
      await expect(retry).toHaveAttribute("aria-disabled", "true");
      await assertTopRight(banner);
      await capture(page, width, theme, "retrying");
      await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failOfflineAttempt());
      await expect(retry).toHaveText("Retry Now");
      await expect(retry).toBeFocused();
      await expect(retry).not.toHaveAttribute("aria-busy", "true");
      await assertTopRight(banner);
      // Development details can become long; expanding them must keep the action in place too.
      const details = banner.locator("details");
      await details.locator("summary").click();
      await expect(details).toHaveAttribute("open", "");
      await assertTopRight(banner);
    });
  }
}
