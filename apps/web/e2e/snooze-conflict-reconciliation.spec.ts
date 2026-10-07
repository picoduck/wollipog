import { expect, test } from "@playwright/test";

const EVIDENCE_CAPTURE = Boolean(process.env.EVIDENCE_CAPTURE);
test.use({ video: EVIDENCE_CAPTURE ? "on" : "off" });

test("a stale Snooze save reconciles without live delivery and preserves the draft", async ({ page }, testInfo) => {
  const pause = (milliseconds: number) => EVIDENCE_CAPTURE
    ? page.waitForTimeout(milliseconds)
    : Promise.resolve();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/sessions-board-e2e.html?reminder-conflict=1");
  await expect(page.locator(".page-tabs .tabs-bar, .sessions-app-bar")).toBeVisible();
  await page.getByRole("button", { name: "Snoozed, 1", exact: true }).click();
  await page.locator(".inbox-row-shell", { hasText: "Snoozed Session" }).getByRole("button").first().click();
  await page.getByRole("button", { name: "Snooze", exact: true }).first().click();

  // A timed reminder opens on Custom…, its Snooze Until field holding the stored words (#2181).
  const expression = page.getByRole("combobox", { name: "Snooze Until" });
  const returnEarly = page.getByRole("checkbox", { name: "Return Early If It Needs Me" });
  const update = page.getByRole("button", { name: "Update Reminder" });
  await expect(page.getByRole("radio", { name: "Custom…" })).toHaveAttribute("aria-checked", "true");
  await expect(expression).toHaveValue("tomorrow");
  await expression.fill("tomorrow 3pm");
  await returnEarly.uncheck();
  await expression.focus();
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("before-conflict.png") });
  await pause(2_500);

  await update.focus();
  await pause(1_000);
  await update.click();
  const conflict = page.getByRole("alert").filter({ hasText: "Reminder Changed" });
  await expect(conflict).toContainText("updated in another client");
  await expect(conflict).toContainText("Your changes here are kept");
  await expect(expression).toHaveValue("tomorrow 3pm");
  await expect(returnEarly).not.toBeChecked();
  await expect(update).toBeFocused();
  await expect(update).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".modal-foot .snooze-blocked-reason")).toHaveText("Reload the reminder before saving.");
  expect(await page.evaluate(() => window.__reminderWriteCalls)).toBe(1);
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("after-conflict.png") });
  await pause(4_000);

  await page.getByRole("button", { name: "Reload Reminder" }).click();
  await expect(conflict).toHaveCount(0);
  await expect(expression).toHaveValue("2099-05-06T21:45");
  await expect(returnEarly).toBeChecked();
  await expect(page.locator(".snooze-summary")).toHaveText(/^Returns Wednesday, May 6, 2099 at \d{1,2}:45 [AP]M\.$/);
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
  await expect(page.locator(".page-tabs .tabs-bar, .sessions-app-bar")).toBeVisible();
  await page.getByRole("button", { name: "Snoozed, 1", exact: true }).click();
  await page.locator(".inbox-row-shell", { hasText: "Snoozed Session" }).getByRole("button").first().click();
  await page.getByRole("button", { name: "Snooze", exact: true }).first().click();

  const expression = page.getByRole("combobox", { name: "Snooze Until" });
  const returnEarly = page.getByRole("checkbox", { name: "Return Early If It Needs Me" });
  const update = page.getByRole("button", { name: "Update Reminder" });
  await expression.fill("tomorrow 3pm");
  await returnEarly.uncheck();
  const draftSummary = await page.locator(".snooze-summary").textContent();
  await expression.focus();
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("preserved-draft-before-removal.png") });
  await pause(2_500);

  await update.click();
  const conflict = page.getByRole("alert").filter({ hasText: "Reminder Changed" });
  await expect(conflict).toContainText("removed in another client");
  await expect(conflict).toContainText("Create a new reminder from them, or start over.");
  await expect(page.getByRole("button", { name: "Create New Reminder from Draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start New Reminder" })).toBeVisible();
  await expect(update).toBeFocused();
  expect(await page.evaluate(() => window.__reminderWriteCalls)).toBe(1);
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("preserved-draft-removal-conflict.png") });
  await pause(4_000);

  await page.getByRole("button", { name: "Create New Reminder from Draft" }).click();
  await expect(page.getByRole("heading", { name: "Create New Reminder" })).toBeVisible();
  await expect(page.getByRole("dialog").locator('.snooze-form > [role="status"].sr-only'))
    .toContainText("Creating a new reminder from the preserved draft");
  await expect(expression).toHaveValue("tomorrow 3pm");
  await expect(returnEarly).not.toBeChecked();
  await expect(page.locator(".snooze-summary")).toHaveText(draftSummary ?? "");
  await expect(expression).toBeFocused();
  if (EVIDENCE_CAPTURE) await page.screenshot({ path: testInfo.outputPath("preserved-draft-create-mode.png") });
  await pause(4_000);

  await page.getByRole("button", { name: "Create New Reminder", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.__reminderWriteCalls)).toBe(2);
  await pause(2_000);
});
