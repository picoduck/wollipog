import { expect, test } from "@playwright/test";

for (const [device, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`one Owner Approval shows and approves mixed follow-up payloads on ${device} (#4537)`, async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-13T06:30:00Z"));
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=follow-up-batch");
    const activity = page.getByRole("region", { name: "Session Activity", exact: true });
    await activity.hover();
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => activity.evaluate(node => node.scrollTop)).toBe(0);
    await page.getByRole("button", { name: "Review 2 Follow-Up Approvals", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Owner Approval", exact: true });
    await expect(dialog).toContainText("Retry the Merge Group When Main Is Red");
    await expect(dialog).toContainText("Show Runner Contention in Campaign Status");
    await expect(dialog).toContainText("Issue Publication");
    await expect(dialog).toContainText("picoduck/wollipog");
    await expect(dialog.locator("pre")).toHaveText("## Problem\n\nA merge retry can wait after main recovers.\n\n## Expected Behavior\n\nRetry the unchanged reviewed head after verifying main and the exact approval.");
    const body = dialog.locator(".modal-body");
    await body.hover();
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(0);
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    if (process.env.FOLLOW_UP_APPROVAL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.FOLLOW_UP_APPROVAL_EVIDENCE_DIR}/owner-approval-${device}.png` });
    if (device === "phone") {
      await page.mouse.wheel(0, 10000);
      await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      if (process.env.FOLLOW_UP_APPROVAL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.FOLLOW_UP_APPROVAL_EVIDENCE_DIR}/owner-approval-phone-body.png` });
    }
    await dialog.getByRole("button", { name: "Approve All 2 Payloads", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([
      { requestId: "follow-up-admission", optionId: "approve" }, { requestId: "follow-up-publication", optionId: "approve" },
    ]);
  });

  test(`follow-up recovery names the limit on ${device} (#4537)`, async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-13T06:30:00Z"));
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&recovery=follow_up_limit");
    const notice = page.locator(".notice").filter({ hasText: "This follow-up needs your approval because it is past the follow-up limit you set" });
    await expect(notice).toBeVisible();
    await expect(notice).not.toContainText("Human Required rule");
    await notice.hover();
    await page.mouse.wheel(0, -10000);
    if (process.env.FOLLOW_UP_APPROVAL_EVIDENCE_DIR) await notice.screenshot({ path: `${process.env.FOLLOW_UP_APPROVAL_EVIDENCE_DIR}/limit-recovery-${device}.png` });
  });

  test(`the limit editor explains preserved approvals on ${device} (#4537)`, async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-13T06:30:00Z"));
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&budget=1");
    const section = page.getByRole("region", { name: "Follow-Ups", exact: true });
    await section.getByRole("button", { name: "Change Limit", exact: true }).click();
    await expect(section).toContainText("Raising the limit keeps exact approved follow-up admissions that still fit.");
    await section.hover();
    await page.mouse.wheel(0, -10000);
    if (process.env.FOLLOW_UP_APPROVAL_EVIDENCE_DIR) await section.screenshot({ path: `${process.env.FOLLOW_UP_APPROVAL_EVIDENCE_DIR}/limit-editor-${device}.png` });
  });
}
