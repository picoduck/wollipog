import { expect, test } from "@playwright/test";
test.use({ viewport: { width: 1280, height: 900 } });

for (const theme of ["light", "dark"]) {
  test(`Up recalls unloaded messages without paging or moving the transcript (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme as "light" | "dark", reducedMotion: "reduce" });
    await page.goto(`/recovery-notice-e2e.html?pagination=resolve&prompt-history=1&height=800&width=1000&theme=${theme}`);
    const composer = page.locator(".composer-input");
    const reader = page.locator(".detail-scroll");
    await expect(composer).toBeEnabled();
    // The reader completes its underfilled opening with one bounded automatic prepend.
    await expect(page.locator("body")).toHaveAttribute("data-tail-request-count", "2");
    await expect(page.locator(".tl-earlier")).toHaveAttribute("data-state", "idle");
    await expect(reader).toHaveAttribute("aria-busy", "false");
    const scrollTop = await reader.evaluate(element => element.scrollTop);
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(/^cached question 20 /);
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(/^cached question 19 /);
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(/^cached question 18 /);
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(/^cached question 17 /);
    await expect(page.locator("body")).toHaveAttribute("data-prompt-history-reads", "2");
    await expect(page.locator("body")).toHaveAttribute("data-tail-request-count", "2");
    await expect(reader).not.toContainText("cached question 17");
    await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBe(scrollTop);
    await composer.press("ArrowDown");
    await expect(composer).toHaveValue(/^cached question 18 /);
    await composer.press("ArrowDown");
    await expect(composer).toHaveValue(/^cached question 19 /);
    await composer.press("ArrowDown");
    await expect(composer).toHaveValue(/^cached question 20 /);
    await composer.press("ArrowDown");
    await expect(composer).toHaveValue("");
    await composer.fill("A draft\nwith two lines");
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("A draft\nwith two lines");
  });
}
