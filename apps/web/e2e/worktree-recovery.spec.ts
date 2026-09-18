import { expect, test, type Page, type TestInfo } from "@playwright/test";

const captureEvidence = process.env.WORKTREE_RECOVERY_EVIDENCE === "1";
const evidenceDir = "test-results/worktree-recovery-evidence";

test.use({ video: captureEvidence ? "on" : "off" });

async function evidencePause(page: Page, milliseconds: number) {
  if (captureEvidence) await page.waitForTimeout(milliseconds);
}

async function openRecovery(page: Page, width: number, height: number, extra = "") {
  await page.setViewportSize({ width, height });
  await page.goto(`/recovery-notice-e2e.html?mode=expanded&height=${height - 40}&width=${width}&worktree-recovery=1&settled=1${extra}`);
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
  await expect(retry).toHaveAccessibleDescription(/Recover the selected worktree before retrying this message\./u);
  await expect(card.getByRole("button", { name: "Create Replacement" }))
    .toHaveAccessibleDescription(/no longer registered.*retained as Not Sent/u);
  await expect(page.locator(".composer-input")).toBeDisabled();
  await saveEvidence(page, testInfo, "desktop-recovery-required");

  const branch = card.getByLabel("Branch");
  await branch.fill("fix/my-restored-work");
  await page.evaluate(() => {
    (window as typeof window & { emitWorktreeRecoveryUpdate?: () => void }).emitWorktreeRecoveryUpdate?.();
  });
  await expect(branch).toHaveValue("fix/my-restored-work");

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

// Evidence runs hold each phase long enough to read at 1x; ordinary runs keep phases brisk.
const phaseMs = captureEvidence ? 3000 : 1500;

test("desktop replacement creation reports its phase and survives a reload", async ({ page }, testInfo) => {
  await openRecovery(page, 1100, 900, `&create-progress=complete&phase-ms=${phaseMs}`);
  const card = page.getByRole("region", { name: "Worktree Recovery Required" });
  const progress = card.getByRole("status", { name: "Replacement Worktree Progress" });
  const create = card.getByRole("button", { name: /Creat/u });
  await evidencePause(page, 2500);
  await card.getByRole("button", { name: "Create Replacement" }).click();
  await expect(create).toHaveText("Creating…");
  await expect(create).toBeDisabled();
  await expect(progress).toContainText("Fetching Remote");
  await expect(progress).toContainText("Step 1 of 4");
  await saveEvidence(page, testInfo, "desktop-create-fetching");
  await expect(progress).toContainText("Creating Worktree");
  await expect(progress).toContainText("Step 2 of 4");

  await page.reload();
  await expect(card).toBeVisible();
  await expect(progress).toContainText(/Creating Worktree|Running Setup/u);
  await expect(create).toBeDisabled();
  await expect(page.getByTestId("pending-prompt-prompt-worktree-recovery")
    .getByText("Not Sent", { exact: true })).toBeVisible();
  await saveEvidence(page, testInfo, "desktop-create-after-reload");
  await expect(progress).toContainText("Running Setup");
  await expect(progress).toContainText("Step 3 of 4");
  await saveEvidence(page, testInfo, "desktop-create-running-setup");

  await expect(card).toHaveCount(0, { timeout: phaseMs * 4 });
  await expect(page.getByRole("button", { name: "Retry Message" })).toBeEnabled();
  await evidencePause(page, 3500);
});

test("desktop failed replacement creation names the phase and keeps the prompt Not Sent", async ({ page }, testInfo) => {
  await openRecovery(page, 1100, 900, `&create-progress=fail&phase-ms=${phaseMs}`);
  const card = page.getByRole("region", { name: "Worktree Recovery Required" });
  await evidencePause(page, 2500);
  await card.getByRole("button", { name: "Create Replacement" }).click();
  const failure = card.getByRole("alert");
  await expect(failure).toHaveText(/Creation Failed: Running Setup Setup step "pnpm install" exited with code 1\./u,
    { timeout: phaseMs * 5 });
  const create = card.getByRole("button", { name: "Create Replacement" });
  await expect(create).toBeEnabled();
  await expect(create).toHaveAccessibleDescription(/Creation Failed: Running Setup/u);
  await expect(page.getByTestId("pending-prompt-prompt-worktree-recovery")
    .getByText("Not Sent", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry Message" })).toBeDisabled();
  await evidencePause(page, 3500);
  await saveEvidence(page, testInfo, "desktop-create-failed");
});

test("mobile replacement creation shows its phase without horizontal overflow", async ({ page }, testInfo) => {
  await openRecovery(page, 390, 844, `&create-progress=complete&phase-ms=${phaseMs}`);
  const card = page.getByRole("region", { name: "Worktree Recovery Required" });
  await card.getByRole("button", { name: "Create Replacement" }).click();
  const progress = card.getByRole("status", { name: "Replacement Worktree Progress" });
  await expect(progress).toContainText("Fetching Remote");
  await expect(progress).toBeInViewport();
  expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBe(390);
  await saveEvidence(page, testInfo, "mobile-create-fetching");
  await expect(progress).toContainText("Running Setup", { timeout: phaseMs * 4 });
  await saveEvidence(page, testInfo, "mobile-create-running-setup");
});
