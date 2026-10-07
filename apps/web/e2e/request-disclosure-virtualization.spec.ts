import { expect, test, type Page } from "@playwright/test";

const disclosures = [
  { name: "review decision", selector: '[data-virtual-key="item:review_decision:321"] details.tl-decision', fragment: "Review%20the%20bounded%20disclosure%20operation" },
  { name: "pending permission", selector: '[data-virtual-key="item:permission:322"] details.perm-context' },
  { name: "resolved permission", selector: '[data-virtual-key="item:permission:323"] details.tl-decision' },
];

async function recycle(page: Page) {
  const reader = page.getByTestId("reader");
  await reader.focus();
  // Disclosure measurement can settle an old reading anchor after activation. Keep scrolling
  // to the tail until that settles, then assert actual DOM removal rather than just invisibility.
  await expect.poll(async () => {
    await reader.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    return await page.locator(disclosures.map(({ selector }) => selector).join(", ")).count();
  }).toBe(0);
  await reader.evaluate((element) => { element.scrollTop = 0; });
  for (const { selector } of disclosures) await expect(page.locator(selector)).toHaveCount(1);
}

for (const surface of disclosures) {
  for (const nextOpen of [true, false]) {
    test(`${surface.name} ${nextOpen ? "expansion" : "collapse"} survives recycling before native toggle (#2716)`, async ({ page }) => {
      await page.goto("/timeline-reflow-e2e.html?request-disclosures=1");
      const target = page.locator(surface.selector);
      const [otherSurface, untouched] = disclosures.filter((item) => item !== surface);
      const other = page.locator(otherSurface!.selector);
      await other.locator("summary").click();
      if (!nextOpen) await target.locator("summary").click();
      await recycle(page);
      expect(await target.evaluate((element: HTMLDetailsElement) => element.open)).toBe(!nextOpen);
      await expect(other).toHaveAttribute("open");

      // Summary activation, blur, and scroll share one task: React must persist the choice before
      // the browser can deliver its queued native toggle to a recycled element.
      await target.evaluate((details) => {
        details.querySelector("summary")!.click();
        const reader = document.querySelector<HTMLElement>('[data-testid="reader"]')!;
        reader.focus();
        reader.scrollTop = reader.scrollHeight;
        reader.dispatchEvent(new Event("scroll"));
      });
      await page.getByTestId("reader").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      for (const { selector } of disclosures) await expect(page.locator(selector)).toHaveCount(0);
      await page.getByTestId("stream-tail").click();
      await page.getByTestId("prepend-history").click();
      await page.getByTestId("reader").evaluate((element) => { element.scrollTop = 0; });
      await target.locator("summary").scrollIntoViewIfNeeded();
      expect(await target.evaluate((element: HTMLDetailsElement) => element.open)).toBe(nextOpen);
      await expect(other).toHaveAttribute("open");
      await expect(page.locator(untouched!.selector)).not.toHaveAttribute("open");
    });
  }

  test(`${surface.name} supports keyboard activation and browser expansion (#2716)`, async ({ page }) => {
    const fragment = "fragment" in surface ? `#:~:text=${surface.fragment}` : "";
    await page.goto(`/timeline-reflow-e2e.html?request-disclosures=1${fragment}`);
    const target = page.locator(surface.selector);
    if (!fragment) {
      // Chromium text fragments do not reveal these preformatted command bodies. Exercise the
      // same native synchronization path with a real trusted toggle, never a synthetic event.
      const trusted = await target.evaluate((element: HTMLDetailsElement) => new Promise<boolean>((resolve) => {
        element.addEventListener("toggle", (event) => resolve(event.isTrusted), { once: true });
        element.open = true;
      }));
      expect(trusted).toBe(true);
    }
    await expect(target).toHaveAttribute("open");
    await recycle(page);
    await expect(target).toHaveAttribute("open");
    await target.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(target).not.toHaveAttribute("open");
    await recycle(page);
    await expect(target).not.toHaveAttribute("open");
    await target.locator("summary").focus();
    await page.keyboard.press("Space");
    await expect(target).toHaveAttribute("open");
    await recycle(page);
    await expect(target).toHaveAttribute("open");
  });
}
