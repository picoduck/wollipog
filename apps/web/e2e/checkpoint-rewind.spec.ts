import { expect, test } from "@playwright/test";

test("rewind stays compact on its user turn across pointer interactions", async ({ page }) => {
  await page.goto("/checkpoint-rewind-e2e.html");
  await expect(page.getByRole("separator", { name: "Start Turn 4" }))
    .toHaveAttribute("title", "Files snapshot taken at the start of turn 4");
  await expect(page.getByRole("separator", { name: "End Turn 4" }))
    .toHaveAttribute("title", "Conversation and files saved at the end of turn 4");
  const button = page.getByRole("button", { name: "Rewind Files to Before This Turn" });
  await expect(button).toBeVisible();
  await expect(button).toHaveCSS("opacity", "1");
  await expect(button).toHaveCSS("pointer-events", "auto");

  const before = await button.boundingBox();
  await button.hover();
  await expect(button).toBeVisible();
  expect(await button.boundingBox()).toEqual(before);
  await expect(page.locator(".tl-checkpoint").filter({ hasText: "Rewind Files" })).toHaveCount(0);

  await button.focus();
  await expect(button).toBeFocused();
  await expect(button).toBeVisible();
  expect(await button.boundingBox()).toEqual(before);
  await button.click();
  await expect(page.getByRole("status")).toHaveText("Rewind requested for turn 4.");
});

test("rewind is visible with a coarse pointer", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 760, height: 900 } });
  const page = await context.newPage();
  await page.goto("/checkpoint-rewind-e2e.html");
  const button = page.getByRole("button", { name: "Rewind Files to Before This Turn" });
  await expect(button).toBeVisible();
  await expect(button).toHaveCSS("opacity", "1");
  await context.close();
});
