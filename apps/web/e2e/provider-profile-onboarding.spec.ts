import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

// Set Up Managed Profile and Recover Existing Profile (#3240): the session's refusal notice offers
// them, and the Machine's Provider Accounts section opens them on arrival.
const DESIGN_WORKSTATION = "machine=native-t14s";
const providerAccounts = (page: Page) => page.getByRole("region", { name: /^Provider Accounts/ });
const accountRow = (page: Page, label: string) =>
  providerAccounts(page).locator(".surface > .row").filter({ has: page.locator(".row-title", { hasText: label }) });
const signInSteps = (page: Page, label: string) =>
  accountRow(page, label).locator("xpath=following-sibling::*[1][contains(concat(' ', @class, ' '), ' provider-account-expansion ')]");

async function capture(page: Page, name: string) {
  if (!evidenceDir) return;
  // Evidence only: let a dialog finish its entrance so the capture is legible.
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
}

for (const width of [390, 1280]) {
  test(`a refused session offers Set Up Managed Profile and Recover Existing Profile at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/session-usage-e2e.html?driver=claude-code&lease-refusal=busy&lease-refusal-account=none&lease-viewer=member");
    const shared = page.getByRole("status", { name: "Account in Use" });
    await expect(shared).toBeVisible();
    await expect(shared.locator(".notice-actions button")).toHaveText(["Restart Session", "Set Up Managed Profile…"]);
    await capture(page, `notice-set-up-${width}`);

    await page.goto("/session-usage-e2e.html?driver=claude-code&lease-refusal=foreign_owner&lease-viewer=owner");
    const locked = page.getByRole("status", { name: "Account Locked by Another Runner" });
    await expect(locked.locator(".notice-actions button")).toHaveText(["Recover Existing Profile…", "Switch Account…"]);
    await capture(page, `notice-recover-${width}`);

    await page.goto("/session-usage-e2e.html?driver=claude-code&lease-refusal=foreign_owner&lease-viewer=member");
    await expect(page.getByRole("status", { name: "Account Locked by Another Runner" }).locator(".notice-actions button"))
      .toHaveText(["Open Machine Accounts", "Switch Account…"]);
  });
}

test("Set Up Managed Profile opens Add Account for the provider, and the new account can serve new sessions", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?profiles&${DESIGN_WORKSTATION}&accounts=add-claude`);
  const dialog = page.getByRole("dialog", { name: "Add Account" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
  await capture(page, "set-up-add-account");
  await dialog.getByLabel("Account Label").fill("Second Control Plane");
  await dialog.getByRole("button", { name: "Start Sign-In" }).click();
  const steps = signInSteps(page, "Second Control Plane");
  await steps.getByLabel("Paste the Code It Shows").fill("fixture-code");
  await steps.getByRole("button", { name: "Submit Code" }).click();

  const offer = providerAccounts(page).getByRole("status", { name: "Use for New Sessions" });
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("New Claude sessions on this machine that don't choose an account will use it.");
  await capture(page, "set-up-use-for-new-sessions");
  await offer.getByRole("button", { name: "Use for New Sessions" }).click();
  await expect(page.getByText("New Claude sessions on this machine use this account.")).toBeVisible();
  await expect(offer).toHaveCount(0);
});

test("Recover Existing Profile adopts and unlocks a configured account in one confirmation", async ({ page }) => {
  await page.goto(`/machine-management-e2e.html?profiles&leases&${DESIGN_WORKSTATION}&accounts=recover-claude-personal`);
  const confirm = page.getByRole("dialog", { name: "Recover Existing Profile" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("adopts the account as its profile");
  await expect(confirm).toContainText("Locked since");
  await capture(page, "recover-existing-profile");
  await confirm.getByRole("button", { name: "Recover Existing Profile" }).click();
  await expect(page.getByText("Profile recovered.")).toBeVisible();
  await expect(accountRow(page, "Personal").locator(".provider-account-lease")).toHaveCount(0);
  await capture(page, "recover-existing-profile-done");
});
