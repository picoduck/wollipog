import { join } from "node:path";
import { expect, test } from "@playwright/test";

/** Reviewable captures of every sign-in card state (#2198) at desktop and phone sizes in both themes.
 * Runs only with WOLLIPOG_EVIDENCE_DIR set; WOLLIPOG_EVIDENCE_PREFIX names the set ("before",
 * "after"). Behaviour is asserted in authentication-recovery.spec.ts. */
const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
const prefix = process.env.WOLLIPOG_EVIDENCE_PREFIX ?? "after";

const SCENARIOS = ["email", "signed-out", "methods", "refused", "readonly", "not-manager", "older", "signing-in"] as const;
const SIZES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

test.skip(!evidenceDir, "set WOLLIPOG_EVIDENCE_DIR to capture evidence");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
});

for (const scenario of SCENARIOS) {
  for (const size of SIZES) {
    for (const theme of ["dark", "light"] as const) {
      test(`${scenario} ${size.name} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(`/authentication-recovery-e2e.html?scenario=${scenario}&theme=${theme}` +
          `&width=${size.width}&height=${size.height}`);
        const card = page.locator(".request-dock .request-card").first();
        await expect(card).toBeVisible();
        if (scenario === "refused") {
          // The refusal is the state: choose a signed-out account from the card's account list.
          const choose = card.getByRole("button", { name: "Choose Another Account…" });
          if (await choose.isVisible()) {
            await choose.click();
          } else {
            await card.getByRole("button", { name: "More Choices" }).click();
            await page.getByRole("menuitem", { name: "Choose Another Account…" }).click();
          }
          await card.getByRole("button", { name: "Check and Use Team Pilot" }).click();
          await expect(card.getByRole("alert")).toBeVisible();
        } else {
          // Identity and accounts settle before the capture.
          await page.waitForTimeout(300);
        }
        await page.locator("#frame").screenshot({ path: join(evidenceDir!, `${prefix}-${scenario}-${size.name}-${theme}.png`) });
        // On a phone, where Dismiss Recovery and Choose Another Account… went: the card's ⋯, open.
        const more = card.locator(".request-card-phone-more");
        if (scenario === "email" && size.name === "phone" && await more.isVisible()) {
          await more.click();
          // The phone menu is a bottom sheet that slides in; capture it settled.
          await expect(page.getByRole("menuitem").last()).toBeInViewport({ ratio: 1 });
          await page.waitForTimeout(600);
          await page.locator("#frame").screenshot({ path: join(evidenceDir!, `${prefix}-${scenario}-${size.name}-${theme}-menu.png`) });
        }
      });
    }
  }
}
