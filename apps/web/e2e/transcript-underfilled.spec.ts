import { expect, test } from "@playwright/test";

test.use({ reducedMotion: "reduce" });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const theme of ["dark", "light"]) {
    test.describe(`one-screen history at ${viewport.width}px in ${theme} (#3156)`, () => {
      test.use({ viewport });
      const mobile = viewport.width < 761;
      for (const input of ["wheel", mobile ? "ArrowUp" : "k", "PageUp"]) {
        test(`${input} loads history and reading keys continue scrolling`, async ({ page }) => {
          await page.goto(`/transcript-states-e2e.html?state=earlier&opening=one-turn&theme=${theme}`);
          const reader = page.getByRole("region", { name: "Session Activity", exact: true });
          await expect(reader.getByRole("button", { name: /^Load Earlier Activity/u })).toBeInViewport();
          await expect(reader.getByText(/^Answer 20:/u)).toBeVisible();
          await expect.poll(() => reader.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
          await reader.focus();
          // Downward navigation and focus do not fetch the remaining history.
          await page.keyboard.press(mobile ? "ArrowDown" : "j");
          await expect(page.locator("body")).not.toHaveAttribute("data-tail-request-count");
          if (input === "wheel") {
            await reader.hover();
            await page.mouse.wheel(0, -120);
          } else await page.keyboard.press(input);
          await expect(page.locator("body")).toHaveAttribute("data-tail-request-count", "1");
          await expect(reader.getByText(/^Question 16:/u)).toBeAttached();
          await expect.poll(() => reader.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1);
          await expect(reader).toBeFocused();
          await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
          await expect(reader.getByText(/^Question 20:/u)).toBeInViewport();
          const anchor = await reader.evaluate(element => element.scrollTop);
          await page.keyboard.press(mobile ? "ArrowUp" : "k");
          await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBeLessThan(anchor);
          const earlierTop = await reader.evaluate(element => element.scrollTop);
          await page.keyboard.press(mobile ? "ArrowDown" : "j");
          await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBeGreaterThan(earlierTop);
          await expect(page.locator("body")).toHaveAttribute("data-tail-request-count", "1");
        });
      }
    });
  }
}
