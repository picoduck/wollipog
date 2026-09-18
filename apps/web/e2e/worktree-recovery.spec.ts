import { expect, test, type Page, type TestInfo } from "@playwright/test";

const captureEvidence = process.env.WORKTREE_RECOVERY_EVIDENCE === "1";
const evidenceDir = "test-results/worktree-recovery-evidence";

test.use({ video: captureEvidence ? "on" : "off" });

async function evidencePause(page: Page, milliseconds: number) {
  if (captureEvidence) await page.waitForTimeout(milliseconds);
}

async function openRecovery(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto(`/recovery-notice-e2e.html?mode=expanded&height=${height - 40}&width=${width}&worktree-recovery=1&settled=1`);
  await expect(page.getByRole("region", { name: "Worktree Recovery Required" })).toBeVisible();
  await expect(page.getByTestId("pending-prompt-prompt-worktree-recovery")
    .getByText("Not Sent", { exact: true })).toBeVisible();
}

async function saveEvidence(page: Page, testInfo: TestInfo, name: string) {
  if (!captureEvidence) return;
  await page.screenshot({ path: `${evidenceDir}/${name}.png`, fullPage: true });
  await testInfo.attach(name, { path: `${evidenceDir}/${name}.png`, contentType: "image/png" });
}

test("desktop recovery selects a verified session-linked worktree before Retry is enabled", async ({ page }, testInfo) => {
  await openRecovery(page, 1100, 900);
  const card = page.getByRole("region", { name: "Worktree Recovery Required" });
  const retry = page.getByRole("button", { name: "Retry Message" });
  await expect(card).toContainText("The provider was not launched");
  await expect(retry).toBeDisabled();
  await expect(page.locator(".composer-input")).toBeDisabled();
  await saveEvidence(page, testInfo, "desktop-recovery-required");

  await evidencePause(page, 2500);
  await card.getByRole("button", { name: "Worktree: fix/recovered-worktree" }).click();
  await evidencePause(page, 1200);
  await card.getByRole("option", { name: "fix/recovered-worktree" }).click();
  await evidencePause(page, 1200);
  await card.getByRole("button", { name: "Select Worktree" }).click();
  await expect(card).toHaveCount(0);
  await expect(retry).toBeEnabled();
  await expect(page.locator(".composer-input")).toBeEnabled();
  await evidencePause(page, 3500);
  await saveEvidence(page, testInfo, "desktop-recovered-not-sent");
});

test("mobile recovery keeps both actions reachable without enabling ordinary submission", async ({ page }, testInfo) => {
  await openRecovery(page, 390, 844);
  const card = page.getByRole("region", { name: "Worktree Recovery Required" });
  await expect(card.getByRole("button", { name: "Create Replacement" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Select Worktree" })).toBeVisible();
  await expect(page.locator(".composer-input")).toBeDisabled();
  expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBe(390);
  await saveEvidence(page, testInfo, "mobile-recovery-required");
});
