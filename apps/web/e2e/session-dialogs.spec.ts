import { waitForSessionPreview } from "./session-readiness.js";
import { expect, test, type Page } from "@playwright/test";
import type { SessionView } from "@wollipog/protocol";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * The session's own dialogs (#2162): Rename Session marks an invalid name on its field and keeps its
 * footer above a phone's software keyboard, and the lifecycle confirmations name the session and
 * offer Snooze as a desktop-only alternative to Archive and Stop.
 */

/** A generated title: only its first line names the session, and it is long enough to scroll. */
const FIRST_LINE = "Fix the half-cent rounding bug in the invoice totals, the export summary and the monthly statements";
const LONG_TITLE = `${FIRST_LINE}\nRequirements:\n- keep cents`;

async function openAlpha(page: Page, query = "") {
  await page.goto(`/command-inbox-projects-e2e.html?fullShell=1&reminders=1${query}`);
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  await waitForSessionPreview(page);
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".session-bar")).toBeVisible();
}

async function patchAlpha(page: Page, patch: Partial<SessionView>) {
  await page.evaluate((value) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", value), patch);
}

async function chooseMoreAction(page: Page, item: string) {
  await page.getByRole("button", { name: "More Actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("Rename Session opens on the title's first line with the caret at the start, and marks an empty name on the field", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAlpha(page);
  await patchAlpha(page, { title: LONG_TITLE });
  await expect(page.locator(".session-bar")).toContainText(FIRST_LINE);
  await chooseMoreAction(page, "Rename…");
  const dialog = page.getByRole("dialog", { name: "Rename Session" });
  const field = dialog.getByRole("textbox", { name: "Session Name" });
  await expect(field).toHaveValue(FIRST_LINE);
  await expect(field).toBeFocused();
  expect(await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.scrollLeft]))
    .toEqual([0, 0, 0]);
  expect(await field.evaluate((input: HTMLInputElement) => input.scrollWidth > input.clientWidth),
    "the title is long enough that the caret's position decides what shows").toBe(true);
  await expect(field).toHaveAccessibleDescription("Shown in the session list and at the top of this page.");

  await field.fill("");
  const primary = dialog.getByRole("button", { name: "Rename Session" });
  await primary.click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription("Enter a session name.");
  await expect(dialog.locator(".field-error")).toHaveText("Enter a session name.");
  await expect(dialog.locator(".field-helper")).toHaveCount(0);
  await expect(dialog.locator(".form-error")).toHaveCount(0);
  await expect(primary).toBeEnabled();
  await expect(field).toBeFocused();
  // The invalid edge is the shared --red rule, not the field's resting outline. Controls ease their
  // edge colour, so the transition finishes first.
  await page.waitForFunction(() => !document.getAnimations().some((animation) => animation instanceof CSSTransition));
  const edge = await field.evaluate((input) => getComputedStyle(input).borderColor);
  const red = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--red)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  expect(edge).toBe(red);

  await field.fill("Rounding fix");
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
  await primary.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".session-bar")).toContainText("Rounding fix");
});

for (const keyboard of [
  { name: "the layout viewport shrinks to the visual viewport", height: 480, inset: 0 },
  { name: "only the visual viewport shrinks", height: 844, inset: 364 },
]) {
  test(`at 390px with a 480px visual viewport, Rename Session's footer is fully visible when ${keyboard.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAlpha(page);
    await chooseMoreAction(page, "Rename…");
    const dialog = page.getByRole("dialog", { name: "Rename Session" });
    await expect(dialog.getByRole("textbox", { name: "Session Name" })).toBeFocused();
    if (keyboard.height !== 844) await page.setViewportSize({ width: 390, height: keyboard.height });
    // What installMobileViewportFallback publishes on a browser that shrinks only the visual viewport.
    if (keyboard.inset) {
      await page.evaluate((inset) => document.documentElement.style.setProperty("--keyboard-inset", `${inset}px`), keyboard.inset);
    }
    await dialogMotionSettled(page);
    const visibleBottom = keyboard.height - keyboard.inset;
    for (const name of ["Cancel", "Rename Session"]) {
      const box = await dialog.getByRole("button", { name }).boundingBox();
      expect(box, `${name} is laid out`).not.toBeNull();
      expect(box!.y, `${name} starts on screen`).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height, `${name} ends above the keyboard`).toBeLessThanOrEqual(visibleBottom + 0.5);
    }
    // The sheet still reads as a sheet: the field stays visible above the footer.
    const fieldBox = await dialog.getByRole("textbox", { name: "Session Name" }).boundingBox();
    expect(fieldBox!.y).toBeGreaterThanOrEqual(0);
  });
}

test("on desktop, Archive and Stop Session offers Snooze Instead…, which opens Snooze without archiving", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAlpha(page);
  await chooseMoreAction(page, "Archive and Stop…");
  const confirmation = page.getByRole("dialog", { name: "Archive and Stop Session" });
  await expect(confirmation).toContainText(
    "“Alpha Session” stops, its queued messages are canceled, and it moves to Archived Sessions. You can restore it later.");
  const buttons = confirmation.locator(".modal-foot button");
  await expect(buttons).toHaveText(["Snooze Instead…", "Cancel", "Archive and Stop"]);
  await expect(confirmation.getByRole("button", { name: "Snooze Instead…" })).toHaveClass(/\bghost\b/);
  await confirmation.getByRole("button", { name: "Snooze Instead…" }).click();
  await expect(confirmation).toHaveCount(0);
  const snooze = page.getByRole("dialog", { name: "Snooze" });
  await expect(snooze).toBeVisible();
  // The confirmation hands focus back on a timer after it settles; Snooze must keep it.
  await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 100)));
  expect(await snooze.evaluate((dialog) => dialog.contains(document.activeElement)), "focus stays in Snooze").toBe(true);
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().sessions
    .find((session) => session.id === "session-alpha")?.archived)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(snooze).toHaveCount(0);
  await expect(page.getByRole("button", { name: "More Actions" }), "closing Snooze returns to what asked to archive")
    .toBeFocused();
});

test("at 390px, Archive and Stop Session has no Snooze Instead… and two equal footer buttons", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAlpha(page);
  await chooseMoreAction(page, "Archive and Stop…");
  const confirmation = page.getByRole("dialog", { name: "Archive and Stop Session" });
  await expect(confirmation).toBeVisible();
  await dialogMotionSettled(page);
  const buttons = confirmation.locator(".modal-foot button");
  await expect(buttons).toHaveText(["Cancel", "Archive and Stop"]);
  const [cancel, confirm] = await Promise.all([buttons.nth(0).boundingBox(), buttons.nth(1).boundingBox()]);
  expect(Math.abs(cancel!.width - confirm!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(cancel!.height - confirm!.height)).toBeLessThanOrEqual(1);
});

test("Retry Stop opens with its primary, not a danger button, focused", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAlpha(page);
  await patchAlpha(page, {
    status: "stopped",
    archiveStatus: "stop_failed",
    archiveOperation: {
      operationId: "stop-1",
      status: "stop_failed",
      requestedAt: 1,
      lastAttemptAt: 2,
      attemptCount: 3,
      capacityReleased: false,
      failure: { code: "runner_rejected", message: "Stop failed.", failedAt: 3 },
    },
  });
  await chooseMoreAction(page, "Retry Stop…");
  const confirmation = page.getByRole("dialog", { name: "Retry Stop" });
  await expect(confirmation).toContainText(
    "The last stop didn't finish, so “Alpha Session” may still be running. Wollipog tries to stop it again, then archives it.");
  const primary = confirmation.getByRole("button", { name: "Retry Stop" });
  await expect(primary).toBeFocused();
  await expect(primary).toHaveClass(/\bprimary\b/);
  await expect(primary).not.toHaveClass(/\bdanger\b/);
  await expect(confirmation.locator(".modal-tone-icon")).toHaveCount(0);
  await expect(confirmation.getByRole("button", { name: "Snooze Instead…" })).toHaveCount(0);
});

test("Stop, Delete and Sign Out name the session, or the agent and machine, without mechanisms", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAlpha(page, "&acpLogout=1");
  await patchAlpha(page, { driver: "acp", agentName: "Gemini CLI", title: LONG_TITLE });
  const bodies: Record<string, string> = {};

  await chooseMoreAction(page, "Sign Out of Agent…");
  bodies.signOut = await page.getByRole("dialog", { name: "Sign Out" }).locator(".confirmation-message").innerText();
  await page.keyboard.press("Escape");

  // Sign Out waits for queued messages to be sent, so the queue is added after it.
  await patchAlpha(page, { queued: [{ id: "queued-1", text: "next", steerable: true, liveQueueObserved: true }] });
  await chooseMoreAction(page, "Stop Session…");
  bodies.stop = await page.getByRole("dialog", { name: "Stop Session" }).locator(".confirmation-message").innerText();
  await page.keyboard.press("Escape");

  await patchAlpha(page, { archived: true, status: "stopped", queued: [] });
  await chooseMoreAction(page, "Delete Session…");
  bodies.delete = await page.getByRole("dialog", { name: "Delete Session" }).locator(".confirmation-message").innerText();
  await page.keyboard.press("Escape");

  expect(bodies).toEqual({
    signOut: "Gemini CLI signs out on Studio Mac, and new sessions with it will ask you to sign in again. "
      + "Saved credentials stay on that machine.",
    stop: `“${FIRST_LINE}” stops now and its 1 queued message is discarded. `
      + "To interrupt only the current turn, use Stop Turn in the composer.",
    delete: `“${FIRST_LINE}” and its history are removed from Wollipog. This can't be undone.`,
  });
  for (const body of Object.values(bodies)) expect(body).not.toMatch(/runner host|runtime capacity|process/i);
});
