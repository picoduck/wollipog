import { expect, test } from "@playwright/test";

test("resolved question disclosure survives virtual recycling and transcript reprojection", async ({ page }) => {
  await page.goto("/timeline-reflow-e2e.html?question-history=1");
  const reader = page.getByTestId("reader");
  const first = page.locator('[data-virtual-key="item:question:301"] .question-history');
  const second = page.locator('[data-virtual-key="item:question:302"] .question-history');
  await expect(first).not.toHaveAttribute("open");
  await expect(second).not.toHaveAttribute("open");
  await first.locator("summary").click();
  await expect(first).toHaveAttribute("open");
  await expect(second).not.toHaveAttribute("open");

  // Scroll beyond overscan and blur the summary so focus retention cannot keep its row mounted.
  await reader.focus();
  await reader.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await page.getByTestId("stream-tail").click();
  await reader.evaluate((element) => { element.scrollTop = 0; });
  await expect(first).toHaveAttribute("open");
  await expect(second).not.toHaveAttribute("open");
  await expect(first.locator(".question-history-body strong")).toHaveText("destination 1");
  await expect(first.locator(".question-history-context code")).toHaveText("staging");
  await expect(first.getByRole("link", { name: "release checklist" })).toBeVisible();

  // Changing row positions must not transfer the first question's state to another event.
  await page.getByTestId("prepend-history").click();
  await reader.evaluate((element) => { element.scrollTop = 0; });
  await first.locator("summary").scrollIntoViewIfNeeded();
  await expect(first).toHaveAttribute("open");
  await second.locator("summary").click();
  await expect(second).toHaveAttribute("open");
  await first.locator("summary").click();
  await expect(first).not.toHaveAttribute("open");
  await reader.focus();
  await reader.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await reader.evaluate((element) => { element.scrollTop = 0; });
  await first.locator("summary").scrollIntoViewIfNeeded();
  await expect(first).not.toHaveAttribute("open");
  await expect(second).toHaveAttribute("open");
});
