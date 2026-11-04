import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/** Reviewable captures of a Choose Another Account row whose sign-in runs in the dialog (#3520):
 * the row reads Signing In without Sign In while it runs, shows the account's own status without
 * Sign In once it ends as Sign-In Failed or Sign-In Timed Out, and offers Sign In again after the
 * ending is dismissed; at 1440px and 390px, dark and light. Runs only with WOLLIPOG_EVIDENCE_DIR set;
 * WOLLIPOG_EVIDENCE_PREFIX names the set ("before", "after"). Behaviour is asserted in
 * ChooseAccountDialog.dom.test.tsx. */
const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
const prefix = process.env.WOLLIPOG_EVIDENCE_PREFIX ?? "after";

test.skip(!evidenceDir, "set WOLLIPOG_EVIDENCE_DIR to capture evidence");

async function capture(page: Page, name: string): Promise<void> {
  // Let fonts and any entrance motion settle; capture the still state.
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(evidenceDir!, `${prefix}-${name}.png`), animations: "disabled" });
}

async function openChooser(page: Page, query: string, width: number, theme: string): Promise<Locator> {
  const height = width === 1440 ? 900 : 844;
  await page.setViewportSize({ width, height });
  await page.goto(`/authentication-recovery-e2e.html?scenario=email${query}&theme=${theme}&width=${width}&height=${height}`);
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
  await expect(dialog).toBeVisible();
  return dialog;
}

const teamRow = (dialog: Locator) =>
  dialog.locator(".choice-row").filter({ has: dialog.page().getByRole("radio", { name: /^Team Pilot/ }) });

for (const width of [1440, 390] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`Choose Another Account row while its sign-in runs, ${width}, ${theme}`, async ({ page }) => {
      const dialog = await openChooser(page, "&chooserSignIn=1", width, theme);
      const row = teamRow(dialog);
      await expect(row.locator(".choice-row-status")).toHaveText("Signing In");
      await expect(row.getByRole("button", { name: /^Sign In/ })).toHaveCount(0);
      await expect(dialog.locator("article.signin-card ol.steps > li")).toHaveCount(2);
      await row.scrollIntoViewIfNeeded();
      await capture(page, `chooser-row-running-${width}-${theme}`);
    });

    for (const [ending, title] of [["failed", "Sign-In Failed"], ["timed_out", "Sign-In Timed Out"]] as const) {
      test(`Choose Another Account row after ${ending} and after dismissal, ${width}, ${theme}`, async ({ page }) => {
        const dialog = await openChooser(page, `&chooserSignIn=${ending}`, width, theme);
        const row = teamRow(dialog);
        const signIn = dialog.locator("article.signin-card");
        await expect(signIn.locator(".notice-title")).toHaveText(title);
        await expect(row.locator(".choice-row-status")).toHaveText("Sign-In Required");
        await expect(row.getByRole("button", { name: /^Sign In/ })).toHaveCount(0);
        await signIn.scrollIntoViewIfNeeded();
        await capture(page, `chooser-row-${ending}-${width}-${theme}`);

        await signIn.getByRole("button", { name: "Dismiss" }).click();
        await expect(signIn).toHaveCount(0);
        await expect(row.getByRole("button", { name: "Sign In to Team Pilot" })).toBeEnabled();
        await row.scrollIntoViewIfNeeded();
        await capture(page, `chooser-row-${ending}-dismissed-${width}-${theme}`);
      });
    }
  }
}
