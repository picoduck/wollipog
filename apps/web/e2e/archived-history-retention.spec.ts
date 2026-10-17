import { expect, test } from "@playwright/test";

/** Archived-history retention in a real browser (#2777): Settings › Storage, the archive's badge,
 * and a pruned session's transcript. */

test.use({ reducedMotion: "reduce" });

/** The harnesses' retention schedule is fixed: the last pass finished Oct 16 2026 09:00 UTC, the next
 * runs at 10:00, a policy turned on now arms at Oct 17 09:30, and the archive's own clock reads
 * Oct 16 12:00. The page reads the real clock, so pin it there: otherwise "Pruning starts" became
 * "Next pass" once the armed time passed and turned main red (#3388). Timers keep running. */
const FIXTURE_NOW = new Date(Date.UTC(2026, 9, 16, 12, 0));
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(FIXTURE_NOW); });

test("Settings › Storage confirms turning retention on before it saves, and lists what it would prune", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings-rows-e2e.html?theme=dark&section=storage&retention=off");
  const toggle = page.getByRole("switch", { name: "Prune Archived History" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Archived sessions keep their full history.", { exact: true })).toBeVisible();
  await expect(page.locator(".settings-panel-scope")).toHaveText("Your Organization");
  await expect(page.getByRole("spinbutton", { name: /Prune After/ })).toHaveValue("90");

  await toggle.click();
  const dialog = page.getByRole("dialog", { name: "Prune Archived History" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("more than 90 days ago is permanently removed from this control plane");
  await expect(dialog).toContainText("Prompts, the final response, usage and cost, and attachments are kept.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await toggle.click();
  await page.getByRole("dialog", { name: "Prune Archived History" }).getByRole("button", { name: "Prune History" }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/^Pruning starts /)).toBeVisible();
  await expect(page.getByText("128 sessions, about 604,115 events", { exact: true })).toBeVisible();
});

test("a member who is not an owner or admin reads Storage without changing it", async ({ page }) => {
  await page.goto("/settings-rows-e2e.html?theme=dark&section=storage&retention=viewer");
  await expect(page.getByRole("switch", { name: "Prune Archived History" })).toBeDisabled();
  await expect(page.getByText("Only an organization owner or admin can change this.", { exact: true })).toBeVisible();
});

test("the archive marks pruned sessions and keeps them openable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/archived-sessions-e2e.html");
  const row = page.getByRole("row", { name: /Migrate the Usage Dashboard to Daily Buckets/ });
  const badge = row.locator(".archive-state-badges .status", { hasText: "History Pruned" });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("title", /^Pruned .* by the 90-day retention policy$/);
  await expect(page.getByRole("row", { name: /Add Keyboard Shortcuts to the Board/ })
    .locator(".archive-state-badges .status", { hasText: "History Pruned" })).toHaveCount(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`a pruned transcript keeps its prompts and final response under a compact notice at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/transcript-states-e2e.html?state=pruned");
    const notice = page.getByRole("note", { name: "History Pruned" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/1,284 events removed .+\./);
    await expect(notice).not.toContainText("tool calls");
    await notice.getByRole("button", { name: "Show Details" }).click();
    await expect(notice).toContainText("removed tool calls and their output, file edits, reasoning, and intermediate messages.");
    await expect(page.getByText("Question 20:", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Answer 20:", { exact: false })).toBeVisible();
    // A streamed session keeps only its last answer.
    await expect(page.getByText("Answer 19:", { exact: false })).toHaveCount(0);
    await expect(page.getByText("No Messages")).toHaveCount(0);
    await expect(page.getByText("Read File 20")).toHaveCount(0);
    // The kept window is below the History Pruned band, never under it.
    await notice.getByRole("button", { name: "Hide Details" }).click();
    const scroller = (await page.locator(".detail-scroll").boundingBox())!;
    const box = (await notice.boundingBox())!;
    expect(scroller.y).toBeGreaterThanOrEqual(box.y + box.height);
    // On a phone the band stays a line or two, so the transcript keeps the screen.
    expect(box.height).toBeLessThan(viewport.height * 0.12);
  });
}

test("an archived session says when its history will be pruned above its transcript", async ({ page }) => {
  await page.goto("/transcript-states-e2e.html?state=prune-scheduled");
  await expect(page.getByRole("status", { name: "Session Archived" }))
    .toContainText(/This session is archived and stopped\. Its history will be pruned on .+\./);
  await expect(page.getByText("Answer 20:", { exact: false })).toBeVisible();
  await expect(page.getByText("No Messages")).toHaveCount(0);
});
