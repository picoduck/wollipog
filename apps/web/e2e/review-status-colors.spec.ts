import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) for (const theme of ["dark", "light"]) for (const mode of ["list", "board"]) {
  test(`review families retain a distinct readable tone at ${width}px in ${theme} ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((theme) => localStorage.setItem("wollipog.theme", theme), theme);
    await page.goto(`/sessions-board-e2e.html?threads=1&family-follow-up=review&path=${encodeURIComponent(mode === "board" ? "/board" : "/")}`);
    await expect(page.locator(".page-tabs .tabs-bar, .sessions-app-bar")).toBeVisible();
    if (mode === "board" && width === 390) await page.getByRole("tab", { name: /^Running/ }).click();
    const parent = page.locator(mode === "list" ? ".inbox-row-shell" : ".card", { hasText: "Ship the usage and cost overhaul" });
    const family = parent.locator(".inbox-thread-family");
    await expect(family).toBeVisible();
    await expect(family).toHaveAttribute("aria-label", /Ready for Review/);
    await expect(family).toHaveClass(/t-review/);
    await expect(parent.locator(".status")).toHaveText(["Awaiting Prompt", "Ready for Review"]);
    await expect(parent.getByLabel("Status: Awaiting Prompt", { exact: true })).toHaveClass(/t-neutral/);
    await expect(parent.getByLabel("Status: Ready for Review", { exact: true })).toHaveClass(/t-review/);
    if (mode === "list") {
      const approval = page.locator(".inbox-row-shell", { hasText: "Approval Session" });
      await expect(approval.locator(".status")).toHaveText(["Awaiting Prompt", "Answer Required"]);
      const answer = approval.getByLabel("Status: Answer Required", { exact: true });
      await expect(answer).toHaveClass(/t-warning/);
      await expect(answer).toHaveAccessibleName("Status: Answer Required");
    }
    for (const scheme of ["wollipog", "github", "one-dark", "dracula", "monokai"]) {
      await page.evaluate((scheme) => {
        if (scheme === "wollipog") delete document.documentElement.dataset.scheme;
        else document.documentElement.dataset.scheme = scheme;
      }, scheme);
      const colors = await family.evaluate((chip) => {
        const style = getComputedStyle(chip);
        const root = getComputedStyle(document.documentElement);
        return { tone: style.getPropertyValue("--tone").trim(), purple: root.getPropertyValue("--purple").trim(),
          amber: root.getPropertyValue("--amber").trim(), gray: root.getPropertyValue("--text-faint").trim() };
      });
      expect(colors.tone, `${scheme}/${theme}`).toBe(colors.purple);
      expect(colors.tone).not.toBe(colors.amber);
      expect(colors.tone).not.toBe(colors.gray);
    }
    await page.evaluate(() => { delete document.documentElement.dataset.scheme; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.WOLLIPOG_CAPTURE_EVIDENCE === "1") {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().filter((animation) =>
          animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
      });
      await page.screenshot({ path: `/tmp/3278-evidence/after-${width}-${theme}-${mode}.png`, fullPage: true });
    }
    await page.emulateMedia({ forcedColors: "active" });
    await expect(family).toHaveAttribute("aria-label", /Ready for Review/);
  });
}

for (const width of [1440, 390]) for (const theme of ["dark", "light"]) for (const mode of ["list", "board"]) {
  test(`active families hold review colors at ${width}px in ${theme} ${mode} (#3328)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((theme) => localStorage.setItem("wollipog.theme", theme), theme);
    await page.goto(`/sessions-board-e2e.html?threads=1&family-follow-up=review-active&path=${encodeURIComponent(mode === "board" ? "/board" : "/")}`);
    await expect(page.locator(".page-tabs .tabs-bar, .sessions-app-bar")).toBeVisible();
    if (mode === "board" && width === 390) await page.getByRole("tab", { name: /^Running/ }).click();
    const parent = page.locator(mode === "list" ? ".inbox-row-shell" : ".card", { hasText: "Ship the usage and cost overhaul" });
    const family = parent.locator(".inbox-thread-family");
    await expect(family).toHaveAttribute("aria-label", /Working/);
    await expect(family).not.toHaveAttribute("aria-label", /Ready for Review/);
    await expect(family).not.toHaveClass(/t-review/);
    await expect(parent.locator(".status")).toHaveText(["Awaiting Prompt", "Children Working"]);
    await expect(parent.getByLabel("Status: Awaiting Prompt", { exact: true })).toHaveClass(/t-neutral/);
    await expect(parent.getByLabel("Status: Children Working", { exact: true })).toHaveClass(/t-info/);
  });
}
