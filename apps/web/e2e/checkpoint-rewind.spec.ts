import { expect, test } from "@playwright/test";

test("rewind remains visible and stable across pointer interactions", async ({ page }) => {
  await page.goto("/checkpoint-rewind-e2e.html");
  const button = page.getByRole("button", { name: "Rewind Files to Here" });
  await expect(button).toBeVisible();
  await expect(button).toHaveCSS("opacity", "1");
  await expect(button).toHaveCSS("pointer-events", "auto");

  const before = await button.boundingBox();
  await button.hover();
  await expect(button).toBeVisible();
  expect(await button.boundingBox()).toEqual(before);

  await button.focus();
  await expect(button).toBeFocused();
  await expect(button).toBeVisible();
  expect(await button.boundingBox()).toEqual(before);
});

test("rewind is visible with a coarse pointer", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 760, height: 900 } });
  const page = await context.newPage();
  await page.goto("/checkpoint-rewind-e2e.html");
  const button = page.getByRole("button", { name: "Rewind Files to Here" });
  await expect(button).toBeVisible();
  await expect(button).toHaveCSS("opacity", "1");
  await context.close();
});
