import { expect, test } from "@playwright/test";

const EVIDENCE_CAPTURE = Boolean(process.env.EVIDENCE_CAPTURE);
test.use({ video: EVIDENCE_CAPTURE ? "on" : "off" });

test("a stale Snooze save reconciles without live delivery and preserves the draft", async ({ page }, testInfo) => {
  const pause = (milliseconds: number) => EVIDENCE_CAPTURE
    ? page.waitForTimeout(milliseconds)
    : Promise.resolve();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/sessions-board-e2e.html?reminder-conflict=1");
  await expect(page.locator(".inbox-toolbar")).toBeVisible();
  await page.getByRole("radio", { name: "Snoozed, 1 Session" }).click();
  await page.locator(".inbox-row-shell", { hasText: "Snoozed Session" }).getByRole("button").first().click();
  await page.getByRole("button", { name: "Snooze", exact: true }).click();

  const expression = page.getByLabel("Natural Language");
  const exact = page.getByLabel("Exact Date and Time");
  const update = page.getByRole("button", { name: "Update Reminder" });
  await expression.fill("today at 3:30 pm");
  await exact.fill("2099-04-05T06:30");
  await page.getByRole("radio", { name: /Regardless/ }).click();
  await exact.focus();
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("before-conflict.png") });
  await pause(2_500);

  await update.focus();
  await pause(1_000);
  await update.click();
  const conflict = page.getByRole("alert").filter({ hasText: "Stored Reminder Changed" });
  await expect(conflict).toContainText("updated in another client");
  await expect(conflict).toContainText("Your local draft is preserved");
  await expect(expression).toHaveValue("today at 3:30 pm");
  await expect(exact).toHaveValue("2099-04-05T06:30");
  await expect(page.getByRole("radio", { name: /Regardless/ })).toHaveAttribute("aria-checked", "true");
  await expect(update).toBeFocused();
  expect(await page.evaluate(() => window.__reminderWriteCalls)).toBe(1);
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("after-conflict.png") });
  await pause(4_000);

  await page.getByRole("button", { name: "Reload Reminder" }).click();
  await expect(conflict).toHaveCount(0);
  await expect(expression).toHaveValue("");
  await expect(exact).toHaveValue("2099-05-06T21:45");
  await expect(page.getByRole("radio", { name: /Until Activity/ })).toHaveAttribute("aria-checked", "true");
  await expect(expression).toBeFocused();
  expect(await page.evaluate(() => window.__reminderWriteCalls)).toBe(1);
  await pause(3_500);
});

test("a removed reminder can create a new reminder from its preserved draft", async ({ page }, testInfo) => {
  const pause = (milliseconds: number) => EVIDENCE_CAPTURE
    ? page.waitForTimeout(milliseconds)
    : Promise.resolve();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/sessions-board-e2e.html?reminder-conflict=removed");
  await expect(page.locator(".inbox-toolbar")).toBeVisible();
  await page.getByRole("radio", { name: "Snoozed, 1 Session" }).click();
  await page.locator(".inbox-row-shell", { hasText: "Snoozed Session" }).getByRole("button").first().click();
  await page.getByRole("button", { name: "Snooze", exact: true }).click();

  const expression = page.getByLabel("Natural Language");
  const exact = page.getByLabel("Exact Date and Time");
  const update = page.getByRole("button", { name: "Update Reminder" });
  await expression.fill("today at 3:30 pm");
  await exact.fill("2099-04-05T06:30");
  await page.getByRole("radio", { name: /Regardless/ }).click();
  const draftTimeZone = await page.locator(".snooze-preview span").last().textContent();
  await exact.focus();
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("preserved-draft-before-removal.png") });
  await pause(2_500);

  await update.click();
  const conflict = page.getByRole("alert").filter({ hasText: "Stored Reminder Changed" });
  await expect(conflict).toContainText("removed in another client");
  await expect(conflict).toContainText("Create a new reminder from this draft");
  await expect(page.getByRole("button", { name: "Create New Reminder from Draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start New Reminder" })).toBeVisible();
  await expect(update).toBeFocused();
  expect(await page.evaluate(() => window.__reminderWriteCalls)).toBe(1);
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("preserved-draft-removal-conflict.png") });
  await pause(4_000);

  await page.getByRole("button", { name: "Create New Reminder from Draft" }).click();
  await expect(page.getByRole("heading", { name: "Create New Reminder" })).toBeVisible();
  await expect(page.getByText(/preserved schedule, time zone, and wake policy will create a new reminder/i)).toBeVisible();
  await expect(page.getByRole("dialog").locator('[role="status"].sr-only'))
    .toContainText("Creating a new reminder from the preserved draft");
  await expect(expression).toHaveValue("today at 3:30 pm");
  await expect(exact).toHaveValue("2099-04-05T06:30");
  await expect(page.getByRole("radio", { name: /Regardless/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".snooze-preview span").last()).toHaveText(draftTimeZone ?? "");
  await expect(expression).toBeFocused();
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("preserved-draft-create-mode.png") });
  await pause(4_000);

  await page.getByRole("button", { name: "Create New Reminder", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.__reminderWriteCalls)).toBe(2);
  await pause(2_000);
});
