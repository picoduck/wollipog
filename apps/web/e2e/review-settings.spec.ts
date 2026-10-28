import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectTextFits } from "./text-fit";

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const viewport = page.viewportSize()!;
  const height = await page.locator(".main-body").evaluate(element => element.scrollHeight);
  await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, height + 96) });
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
  await page.setViewportSize(viewport);
}

for (const width of [1280, 390]) test(`review defaults, same-family consent and project override at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/settings-rows-e2e.html?route=/settings/reviews&theme=dark");
  await expect(page.getByRole("spinbutton", { name: "Valid Rounds", exact: true })).toHaveValue("4");
  const claude = page.locator("section.settings-group").filter({ has: page.getByRole("heading", { name: "Claude Code Reviewer", exact: true }) });
  const codex = page.locator("section.settings-group").filter({ has: page.getByRole("heading", { name: "Codex App Server Reviewer", exact: true }) });
  await expect(claude.getByRole("button", { name: "Reviewer Harness: Codex", exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Reviewer Harness: Claude Code", exact: true })).toBeVisible();
  await capture(page, testInfo, `reviews-default-${width}.png`);

  await claude.getByRole("button", { name: "Reviewer Model: Automatic", exact: true }).click();
  await page.getByRole("option", { name: "GPT-6.1 Sol", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Valid Rounds", exact: true }).fill("7");
  await page.getByRole("button", { name: "Save Defaults", exact: true }).click();
  await expect(page.locator(".save-bar")).toHaveCount(0);
  await expect(page.locator(".settings-panel-scope")).toHaveText("Your Defaults");
  await capture(page, testInfo, `reviews-configured-${width}.png`);

  await claude.getByRole("button", { name: "Reviewer Harness: Codex", exact: true }).click();
  await page.getByRole("option", { name: "Claude Code", exact: true }).click();
  await expect(claude.getByText("This reviewer belongs to the implementer's model family. Choose another harness or explicitly allow it below.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Defaults", exact: true })).toHaveAttribute("aria-disabled", "true");
  await capture(page, testInfo, `reviews-refusal-${width}.png`);
  await claude.getByRole("switch", { name: "Allow Same-Family Reviews", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save Defaults", exact: true })).not.toHaveAttribute("aria-disabled", "true");
  await page.getByRole("button", { name: "Discard", exact: true }).click();

  await page.getByRole("button", { name: "Project: Your Defaults", exact: true }).click();
  await page.getByRole("option", { name: "Demo Project", exact: true }).click();
  await expect(page.getByText("Inherits Your Settings", { exact: true })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Valid Rounds", exact: true })).toHaveValue("7");
  await expect(claude.getByRole("button", { name: "Reviewer Model: GPT-6.1 Sol", exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Valid Rounds", exact: true }).fill("2");
  await page.getByRole("button", { name: "Save Project Override", exact: true }).click();
  await expect(page.getByText("Own Review Settings", { exact: true })).toBeVisible();
  await expect(page.getByText("This project's settings replace all of your review defaults. Changes apply only to your sessions in this project.")).toBeVisible();
  await capture(page, testInfo, `reviews-project-${width}.png`);
  await page.getByRole("button", { name: /Reset to User Settings/ }).click();
  await expect(page.getByText("Inherits Your Settings", { exact: true })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Valid Rounds", exact: true })).toHaveValue("7");
  await page.getByRole("spinbutton", { name: "Valid Rounds", exact: true }).fill("0");
  await expect(page.getByRole("button", { name: "Save Project Override", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expectTextFits(page.locator(".settings-panel"), "Reviews");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("the phone Settings index describes Reviews without truncation and opens its deep link", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings-rows-e2e.html?route=/settings&theme=dark");
  const review = page.locator(".settings-index a").filter({ has: page.getByText("Reviews", { exact: true }) });
  await expect(review).toBeVisible();
  const description = review.locator(".row-sub");
  await expect(description).toHaveText("Reviewers, rounds and project rules.");
  expect(await description.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("reviews-index-390.png") });
  await review.click();
  await expect(page.locator("#settings-panel-heading")).toHaveText("Reviews");
  expect(new URL(page.url()).searchParams.get("route")).toBe("/settings/reviews");
});
