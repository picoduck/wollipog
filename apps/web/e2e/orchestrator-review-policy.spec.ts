import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

async function select(page: Page, title: string, option: string) {
  await page.getByRole("button", { name: new RegExp(`^${title}:`) }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function captureSettings(page: Page, info: TestInfo, name: string) {
  const viewport = page.viewportSize()!;
  const height = await page.locator(".main-body").evaluate(e => e.scrollHeight);
  await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, height + 96) });
  await page.screenshot({ path: info.outputPath(name), fullPage: true });
  await page.setViewportSize(viewport);
}

for (const width of [1280, 390]) {
  test(`review policy defaults and discovered configuration persist at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings-rows-e2e.html?theme=dark&section=orchestrator&reviewPolicy=legacy");
    await expect(page.getByRole("button", { name: /^Review Harness:/ })).toHaveCount(0);
    await captureSettings(page, info, `review-policy-before-${width}.png`);
    await page.goto("/settings-rows-e2e.html?theme=dark&section=orchestrator");
    for (const label of ["Review Harness", "Review Model", "Review Effort", "Review Round Budget"]) {
      await expect(page.getByRole("button", { name: `${label}: Automatic`, exact: true })).toBeVisible();
    }
    await captureSettings(page, info, `review-policy-default-${width}.png`);
    await select(page, "Review Harness", "Codex");
    await select(page, "Review Model", "GPT-6.1 Sol");
    await select(page, "Review Effort", "High");
    await select(page, "Review Round Budget", "2");
    await expect(page.getByText(/Same-family reviews still require explicit consent/)).toBeVisible();
    await page.getByRole("button", { name: "Save Defaults", exact: true }).click();
    await expect(page.locator(".save-bar")).toHaveCount(0);
    await captureSettings(page, info, `review-policy-configured-${width}.png`);
    if (width < 720) {
      await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
      await page.locator(".settings-index").getByRole("link").filter({ hasText: "Orchestrator" }).click();
    } else {
      await page.locator(".settings-nav").getByRole("link", { name: "Appearance", exact: true }).click();
      await page.locator(".settings-nav").getByRole("link", { name: "Orchestrator", exact: true }).click();
    }
    await expect(page.getByRole("button", { name: "Review Model: GPT-6.1 Sol", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review Round Budget: 2", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test(`launch policy supports fixed review fields and per-field reset at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/new-session-choices-e2e.html?defaults=orchestrator&policy=1");
    const before = page.getByRole("dialog", { name: "New Session" });
    const beforeOptions = before.getByRole("button", { name: "Options", exact: true });
    if (await beforeOptions.getAttribute("aria-expanded") !== "true") await beforeOptions.click();
    await before.getByRole("button", { name: "Customize…" }).click();
    await expect(page.getByRole("button", { name: /^Review Harness:/ })).toHaveCount(0);
    await dialogMotionSettled(page);
    await page.screenshot({ path: info.outputPath(`review-policy-launch-before-${width}.png`) });
    await page.goto("/new-session-choices-e2e.html?defaults=orchestrator&policy=1&reviewPolicy=1");
    const session = page.getByRole("dialog", { name: "New Session" });
    const options = session.getByRole("button", { name: "Options", exact: true });
    if (await options.getAttribute("aria-expanded") !== "true") await options.click();
    await session.getByRole("button", { name: "Customize…" }).click();
    const policy = page.getByRole("dialog", { name: "Orchestrator Policy" });
    await expect(policy).toBeVisible();
    await dialogMotionSettled(page);
    await select(page, "Review Harness", "Claude Code");
    await select(page, "Review Model", "Claude Opus");
    await select(page, "Review Effort", "High");
    await select(page, "Review Round Budget", "3");
    const round = policy.locator(".setting-row").filter({ has: page.getByRole("button", { name: "Review Round Budget: 3", exact: true }) });
    await round.getByRole("button", { name: "Reset to Automatic", exact: true }).click();
    await expect(policy.getByRole("button", { name: "Review Round Budget: Automatic", exact: true })).toBeVisible();
    await select(page, "Review Round Budget", "3");
    await policy.locator(".setting-row").filter({ has: page.getByRole("button", { name: "Review Harness: Claude Code", exact: true }) }).evaluate(e => e.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: info.outputPath(`review-policy-launch-${width}.png`) });
    await policy.getByRole("button", { name: "Apply Policy", exact: true }).click();
    await session.getByRole("button", { name: "Customize…" }).click();
    await expect(policy.getByRole("button", { name: "Review Model: Claude Opus", exact: true })).toBeVisible();
    await expect(policy.getByRole("button", { name: "Review Round Budget: 3", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

for (const width of [1280, 390]) test(`campaign status displays the stored review policy at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/session-usage-e2e.html?width=${width}&height=900&composer=orchestrator`);
  await page.getByRole("button", { name: "Attach and Settings" }).click();
  await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
  const before = page.getByRole("dialog", { name: "Orchestrator Controls" });
  await expect(before).toBeVisible();
  await expect(before.getByText("Review Harness", { exact: true })).toHaveCount(0);
  await dialogMotionSettled(page);
  await before.getByText("Campaign Behavior", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`review-policy-status-before-${width}.png`) });
  await page.goto(`/session-usage-e2e.html?width=${width}&height=900&composer=orchestrator&reviewPolicy=1`);
  await page.getByRole("button", { name: "Attach and Settings" }).click();
  await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
  const dialog = page.getByRole("dialog", { name: "Orchestrator Controls" });
  await expect(dialog).toBeVisible();
  await dialogMotionSettled(page);
  for (const label of ["Review Harness", "Review Model", "Review Effort", "Review Round Budget"]) await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  await dialog.getByText("Review Harness", { exact: true }).evaluate(e => e.closest(".orchestrator-fact")?.scrollIntoView({ block: "start" }) ?? e.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: info.outputPath(`review-policy-status-${width}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
