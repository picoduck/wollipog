import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });

for (const theme of ["dark", "light"]) {
  for (const startedFollowing of [true, false]) {
    test(`a native touch history gesture stays paused after lift in ${theme}, started following=${startedFollowing} (#3188)`, async ({ page }) => {
      await page.goto(`/transcript-states-e2e.html?state=earlier&opening=one-turn&older=hold&theme=${theme}`);
      const reader = page.getByRole("region", { name: "Session Activity", exact: true });
      await expect(reader.getByText(/^Answer 20:/u)).toBeVisible();
      await expect.poll(() => reader.evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0);
      await expect(page.locator("body")).not.toHaveAttribute("data-earlier-request-count");
      await reader.focus();
      // Current-turn openings begin paused. Explicitly return to latest before trying to read back.
      if (startedFollowing) await page.keyboard.press("End");
      const initialState = startedFollowing ? "following" : "paused";
      await expect(reader).toHaveAttribute("data-follow-tail-state", initialState);
      const box = (await reader.boundingBox())!;
      const touch = await page.context().newCDPSession(page);
      const x = box.x + 8;
      const y = box.y + 80;
      // A genuine tap retains the pre-press state and does not request history (#2526).
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(reader).toHaveAttribute("data-follow-tail-state", initialState);
      await expect(page.locator("body")).not.toHaveAttribute("data-earlier-request-count");
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
      for (const dy of [10, 20, 30, 40]) {
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + dy, id: 1 }] });
      }
      await expect(page.locator("body")).toHaveAttribute("data-earlier-request-count", "1");
      await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
      await expect(reader).toBeFocused();
      const anchor = reader.getByText(/^Question 20:/u);
      const initialOffset = (await anchor.boundingBox())!.y - (await reader.boundingBox())!.y;
      await page.evaluate(() => window.__releaseEarlierHistory!());
      await expect(reader.getByText(/^Question 16:/u)).toBeAttached();
      await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
      await expect(reader.getByText(/^Question 20:/u)).toBeInViewport();
      await expect.poll(() => reader.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1);
      // A one-screen opening leaves bottom slack. After prepending, preserve the row's offset
      // as far as the native scroll range allows; recreating that slack would scroll past the tail.
      await expect.poll(() => anchor.evaluate((question, initialOffset) => {
        const reader = question.closest<HTMLElement>('[role="region"][aria-label="Session Activity"]')!;
        const offset = question.getBoundingClientRect().top - reader.getBoundingClientRect().top;
        const desiredTop = reader.scrollTop + offset - initialOffset;
        const boundedTop = Math.max(0, Math.min(reader.scrollHeight - reader.clientHeight, desiredTop));
        return Math.abs(reader.scrollTop - boundedTop);
      }, initialOffset)).toBeLessThanOrEqual(1);
      await expect(reader).toBeFocused();
      await expect(page.locator("body")).toHaveAttribute("data-earlier-request-count", "1");
      await page.keyboard.press("End");
      await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
    });
  }
}
