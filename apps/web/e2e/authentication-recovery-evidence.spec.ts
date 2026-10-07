import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/** Reviewable captures of every sign-in card state (#2198) and of Choose Another Account (#2208) at
 * desktop and phone sizes in both themes. Runs only with WOLLIPOG_EVIDENCE_DIR set;
 * WOLLIPOG_EVIDENCE_PREFIX names the set ("before", "after"). Behaviour is asserted in
 * authentication-recovery.spec.ts. */
const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
const prefix = process.env.WOLLIPOG_EVIDENCE_PREFIX ?? "after";

const CARD_SCENARIOS = ["email", "signed-out", "methods", "readonly", "not-manager", "older", "signing-in"] as const;
/** Choose Another Account's states: the harness scenario each starts from, and what is done to reach it. */
const CHOOSER_SCENARIOS = {
  "chooser-hidden": { query: "scenario=email&emailLabels=1" },
  "chooser-shown": { query: "scenario=email&emailLabels=1" },
  refused: { query: "scenario=refused" },
  "removed-while-open": { query: "scenario=email&emailLabels=1" },
  "cant-switch": { query: "scenario=not-resumable" },
  "no-other-accounts": { query: "scenario=none" },
} as const;
const SIZES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

test.skip(!evidenceDir, "set WOLLIPOG_EVIDENCE_DIR to capture evidence");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
});

async function chooseAnotherAccount(page: Page, card: Locator): Promise<void> {
  const choose = card.getByRole("button", { name: "Choose Another Account…" });
  if (await choose.isVisible()) {
    await choose.click();
  } else {
    await card.getByRole("button", { name: "More Choices" }).click();
    await page.getByRole("menuitem", { name: "Choose Another Account…" }).click();
  }
}

/** The dialog when there is one (#2208), else the card, where the accounts were listed before it. */
function chooser(page: Page, card: Locator): Locator {
  return page.getByRole("dialog", { name: "Choose Another Account" }).or(card);
}

/** Choose an account and submit it, in the dialog or in the card's former list. */
async function use(page: Page, card: Locator, account: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Choose Another Account" });
  if (await dialog.isVisible()) {
    await dialog.getByRole("radio", { name: new RegExp(`^${account}`) }).check();
    await dialog.getByRole("button", { name: /^(Use Account|Check and Use)$/ }).click();
  } else {
    await card.getByRole("button", { name: new RegExp(`(Use|Check and Use) ${account}$`) }).click();
  }
}

async function capture(page: Page, name: string): Promise<void> {
  // Sheets slide in and lists settle; capture the still state.
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(evidenceDir!, `${prefix}-${name}.png`) });
}

for (const size of SIZES) {
  for (const theme of ["dark", "light"] as const) {
    const frame = `&theme=${theme}&width=${size.width}&height=${size.height}`;

    for (const scenario of CARD_SCENARIOS) {
      test(`${scenario} ${size.name} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(`/authentication-recovery-e2e.html?scenario=${scenario}${frame}`);
        const card = page.locator(".request-dock .request-card").first();
        await expect(card).toBeVisible();
        // Identity and accounts settle before the capture.
        await page.waitForTimeout(300);
        await page.locator("#frame").screenshot({ path: join(evidenceDir!, `${prefix}-${scenario}-${size.name}-${theme}.png`) });
        // On a phone, where Dismiss Recovery and Choose Another Account… went: the card's ⋯, open.
        if (scenario === "email" && size.name === "phone") {
          const more = card.getByRole("button", { name: "More Choices" });
          await expect(more).toBeVisible();
          await more.click();
          await expect(page.getByRole("menuitem").last()).toBeInViewport({ ratio: 1 });
          await page.waitForTimeout(600);
          await page.locator("#frame").screenshot({ path: join(evidenceDir!, `${prefix}-${scenario}-${size.name}-${theme}-menu.png`) });
        }
      });
    }

    for (const [scenario, { query }] of Object.entries(CHOOSER_SCENARIOS)) {
      test(`${scenario} ${size.name} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(`/authentication-recovery-e2e.html?${query}${frame}`);
        const card = page.locator(".request-dock .request-card").first();
        await expect(card).toBeVisible();
        await page.waitForTimeout(300);
        await chooseAnotherAccount(page, card);
        const scope = chooser(page, card);
        await page.waitForTimeout(300);
        if (scenario === "chooser-shown") {
          // One Show Emails in the dialog; before it, a reveal on each row, which becomes Hide once used.
          for (const name of ["Show Emails", "Show Account Email"]) {
            const reveals = scope.getByRole("button", { name, exact: true });
            while (await reveals.count() > 0) await reveals.first().click();
          }
        } else if (scenario === "refused") {
          // A signed-in account that the runner then finds signed out (the harness reports it so).
          await use(page, card, "Personal Max");
          await expect(scope.locator(".field-error, [role='alert']").first()).toBeVisible();
        } else if (scenario === "removed-while-open") {
          await page.evaluate(() => window.__WOLLIPOG_AUTH_RECOVERY_E2E__.removeAccount("claude-personal"));
        } else if (scenario === "cant-switch") {
          await use(page, card, "Personal Max");
          await expect(card.locator(".notice, [role='alert']").first()).toBeVisible();
        }
        await capture(page, `${scenario}-${size.name}-${theme}`);
      });
    }
  }
}
