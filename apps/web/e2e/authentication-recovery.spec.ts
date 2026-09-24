import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/** Authentication Required account context (#1649) in a real SessionDetail. Set
 * WOLLIPOG_EVIDENCE_DIR to also write reviewable captures of each state. */
const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
const EMAIL = "morgan.lee@example.com";

async function capture(page: Page, name: string): Promise<void> {
  if (evidenceDir) await page.locator("#frame").screenshot({ path: join(evidenceDir, `${name}.png`) });
}

async function open(page: Page, query: string) {
  await page.goto(`/authentication-recovery-e2e.html?${query}`);
  // A standalone request is reviewed from its transcript row in the request panel.
  await page.getByRole("button", { name: "Review Request" }).click();
  const card = page.getByRole("region", { name: "Approval Review" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Authentication Required — Claude Code");
  const recovery = card.getByRole("group", { name: "Account Recovery" });
  await expect(recovery).toBeVisible();
  return { card, recovery };
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: the current email stays masked until revealed and is separate from the configured label`, async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    const { recovery } = await open(page, `theme=${theme}`);
    await expect(recovery.getByText("Checked at", { exact: false })).toBeVisible();
    await expect(recovery).toContainText("Configured Account");
    await expect(recovery).toContainText("A label chosen on this Machine. The provider has not verified it.");
    expect(await recovery.innerHTML()).not.toContain(EMAIL);
    await capture(page, `auth-recovery-masked-desktop-${theme}`);

    await recovery.getByRole("button", { name: "Show Current Account Email" }).click();
    await expect(recovery).toContainText(EMAIL);
    await capture(page, `auth-recovery-revealed-desktop-${theme}`);
    await recovery.getByRole("button", { name: "Hide Current Account Email" }).click();
    expect(await recovery.innerHTML()).not.toContain(EMAIL);
  });
}

test("every other account is listed with its status, and choosing one names this exact card", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  const { card, recovery } = await open(page, "theme=dark");
  const accounts = recovery.getByRole("region", { name: "Choose Another Account" });
  await expect(accounts.locator(".auth-recovery-account")).toHaveCount(3);
  await expect(accounts).toContainText("Personal Max");
  await expect(accounts).toContainText("Sign-In Required");
  await expect(accounts).toContainText("Status Unknown");
  await expect(accounts).not.toContainText("Work Subscription", { useInnerText: true });
  await expect(card.getByRole("button", { name: "Use Current Account" })).toBeVisible();

  await accounts.getByRole("button", { name: "Use Personal Max" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_AUTH_RECOVERY_E2E__.selections())).toEqual([{
    requestId: "provider-auth:recovery-e2e",
    providerAccountId: "claude-personal",
    expectedProviderAccountId: "claude-work",
  }]);
});

test("a refused selection keeps the card open and explains the next action", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  const { recovery } = await open(page, "theme=dark&scenario=refused");
  await recovery.getByRole("button", { name: "Check and Use Team Pilot" }).click();
  const row = recovery.locator('[data-availability="sign_in_required"]');
  const refusal = row.getByRole("alert");
  await expect(refusal).toContainText("signed out. Sign in to it, then choose it again.");
  // The refusal appears beside the chosen account and is scrolled into view, not below the fold.
  await expect(refusal).toBeInViewport();
  await expect(row.getByRole("button", { name: "Sign In" })).toBeInViewport();
  await capture(page, "auth-recovery-refused-desktop-dark");
});

test("a provider without an email says so instead of guessing", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  const { recovery } = await open(page, "theme=dark&scenario=no-email");
  await expect(recovery).toContainText("Claude Code did not supply an account email, so its identity cannot be displayed.");
  await expect(recovery.getByRole("button", { name: "Show Current Account Email" })).toHaveCount(0);
  await capture(page, "auth-recovery-no-email-desktop-dark");
});

test("a viewer who cannot manage the Machine gets an owner-directed next action", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  const { recovery } = await open(page, "theme=dark&scenario=readonly");
  const signedOut = recovery.locator('[data-availability="sign_in_required"]');
  await expect(signedOut).toContainText("Ask a Machine owner or organization admin to sign in to it");
  await expect(signedOut.getByRole("button", { name: "Sign In" })).toHaveCount(0);
});

test("an older runner keeps the existing actions with update guidance and no identity request", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  const { card, recovery } = await open(page, "theme=dark&scenario=older");
  await expect(recovery).toContainText("Update and restart the runner, or use this card's other actions.");
  await expect(card.getByRole("button", { name: "Recheck Authentication" })).toBeVisible();
  expect(await page.evaluate(() => window.__WOLLIPOG_AUTH_RECOVERY_E2E__.identityRequests())).toBe(0);
  await capture(page, "auth-recovery-older-runner-desktop-dark");
});

test("on a phone the card stays within the viewport and every action is reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { recovery } = await open(page, "theme=dark&width=390&height=844");
  await expect(recovery.getByText("Checked at", { exact: false })).toBeVisible();
  const overflow = await recovery.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const inner = [...element.querySelectorAll<HTMLElement>("*")].map((child) => child.getBoundingClientRect().right);
    return { right: Math.max(bounds.right, ...inner), viewport: window.innerWidth };
  });
  expect(overflow.right).toBeLessThanOrEqual(overflow.viewport + 0.5);
  const use = recovery.getByRole("button", { name: "Use Personal Max" });
  await use.scrollIntoViewIfNeeded();
  await expect(use).toBeVisible();
  await capture(page, "auth-recovery-masked-mobile-dark");
  await recovery.getByRole("button", { name: "Show Current Account Email" }).click();
  await expect(recovery).toContainText(EMAIL);
  await capture(page, "auth-recovery-revealed-mobile-dark");
});
