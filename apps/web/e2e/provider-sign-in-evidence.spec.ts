import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/** Reviewable captures of a provider sign-in (#2996): each state of the in-row steps and endings in
 * Provider Accounts, and Choose Another Account's, at 1440px and 390px, dark and light, with Hide
 * Account Emails on and off (the accounts are named by email, so both readings show); and the
 * embedded sign-in Request Card in both flow shapes. Runs only with WOLLIPOG_EVIDENCE_DIR set;
 * WOLLIPOG_EVIDENCE_PREFIX names the set ("before", "after"). Behaviour is asserted in
 * machine-management.spec.ts and authentication-recovery.spec.ts. */
const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
const prefix = process.env.WOLLIPOG_EVIDENCE_PREFIX ?? "after";
const THEMES = ["dark", "light"] as const;
const WIDTHS = [1440, 390] as const;
/** The machine harness's `?signIn=` fixtures (machine-management-main.tsx). */
const ACCOUNT_STATES = ["device", "code", "rejected", "failed", "timed-out", "duplicate"] as const;
const ROW: Record<(typeof ACCOUNT_STATES)[number], { hidden: string; shown: string }> = {
  device: { hidden: "Signing In to Codex", shown: "team@example.com" },
  code: { hidden: "Signing In to Claude", shown: "work@example.com" },
  rejected: { hidden: "Signing In to Claude", shown: "work@example.com" },
  failed: { hidden: "Email Hidden", shown: "work@example.com" },
  "timed-out": { hidden: "Email Hidden", shown: "work@example.com" },
  duplicate: { hidden: "Email Hidden", shown: "work.two@example.com" },
};

test.skip(!evidenceDir, "set WOLLIPOG_EVIDENCE_DIR to capture evidence");

async function capture(target: Locator | Page, name: string): Promise<void> {
  // Let fonts and any entrance motion settle; capture the still state.
  await (("page" in target) ? target.page() : target).waitForTimeout(400);
  await target.screenshot({ path: join(evidenceDir!, `${prefix}-${name}.png`), animations: "disabled" });
}

async function hideEmails(page: Page, hide: boolean): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem("wollipog.hide-account-emails", value), String(hide));
}

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    for (const hide of [true, false]) {
      const emails = hide ? "hidden" : "shown";
      for (const state of ACCOUNT_STATES) {
        test(`Provider Accounts, ${state}, ${width}, ${theme}, emails ${emails}`, async ({ page }) => {
          await hideEmails(page, hide);
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.goto(`/machine-management-e2e.html?signIn=${state}&emailLabels&theme=${theme}&machine=native-t14s`);
          const section = page.getByRole("region", { name: /^Provider Accounts/ });
          await expect(section).toBeVisible();
          if (width !== 1440) await page.setViewportSize({ width, height: 844 });
          await expect(section.locator(".surface > .row .row-title", { hasText: ROW[state][emails] }).first()).toBeVisible();
          if (state === "rejected") {
            await section.getByLabel("Paste the Code It Shows").fill("not-the-code");
            await section.getByRole("button", { name: "Submit Code" }).click();
            await expect(section.locator(".field-error")).toBeVisible();
          }
          await section.scrollIntoViewIfNeeded();
          await capture(section, `accounts-${state}-${width}-${theme}-emails-${emails}`);
        });
      }
      test(`Choose Another Account sign-in, ${width}, ${theme}, emails ${emails}`, async ({ page }) => {
        await hideEmails(page, hide);
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        await page.goto(`/authentication-recovery-e2e.html?scenario=email&emailLabels=1&chooserSignIn=1&theme=${theme}` +
          `&width=${width}&height=${width === 1440 ? 900 : 844}`);
        const card = page.locator(".request-dock").getByRole("region", { name: "Authentication Required — Claude Code" });
        await expect(card).toBeVisible();
        const choose = card.getByRole("button", { name: "Choose Another Account…" });
        if (await choose.isVisible()) {
          await choose.click();
        } else {
          await card.getByRole("button", { name: "More Choices" }).click();
          await page.getByRole("menuitem", { name: "Choose Another Account…" }).click();
        }
        const dialog = page.getByRole("dialog", { name: "Choose Another Account" });
        const signIn = dialog.locator("article.signin-card");
        await expect(signIn.locator("ol.steps > li")).toHaveCount(2);
        await signIn.scrollIntoViewIfNeeded();
        await capture(page, `chooser-code-${width}-${theme}-emails-${emails}`);
      });
    }
  }
}

for (const width of WIDTHS) {
  const height = width === 1440 ? 900 : 844;
  for (const theme of THEMES) {
    for (const [flow, query] of [["authorization-code", ""], ["device-code", "&deviceCode=1"]] as const) {
      test(`embedded Request Card, ${flow}, ${width}, ${theme}`, async ({ page, context }) => {
        await page.setViewportSize({ width, height });
        await page.goto(`/authentication-recovery-e2e.html?scenario=signing-in${query}&theme=${theme}&width=${width}&height=${height}`);
        const card = page.locator(".request-dock").getByRole("region", { name: "Signing In — Claude Code" });
        await expect(card).toBeVisible();
        await capture(card, `request-card-${flow}-${width}-${theme}`);
        if (flow !== "device-code") return;
        // Copy Device Code's confirmation (#3521), pressed from the keyboard so its focus ring shows.
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        const copy = card.getByRole("button", { name: "Copy Device Code" });
        await copy.focus();
        await page.keyboard.press("Enter");
        await expect(copy).toHaveClass(/copy-status-copied/);
        await capture(card, `request-card-${flow}-copied-${width}-${theme}`);
      });
    }
  }
}
