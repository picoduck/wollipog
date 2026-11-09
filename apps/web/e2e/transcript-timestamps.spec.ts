import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`message dates remain visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/transcript-scroll-e2e.html");
    const userTime = page.locator(".tl-message-stack.user .tl-message-timestamp").last();
    const agentTime = page.locator(".tl-agent-msg .tl-message-timestamp").last();
    await expect(userTime).toBeVisible();
    await expect(agentTime).toBeVisible();
    for (const time of [userTime, agentTime]) {
      const expected = await time.evaluate((element) => new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium", timeStyle: "medium",
      }).format(new Date(element.getAttribute("datetime")!)));
      await expect(time).toHaveText(expected);
    }
    const reader = page.getByTestId("reader");
    expect(await reader.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/transcript-timestamps-${width}.png` });
  });
}
