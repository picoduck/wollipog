import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/** Reviewable captures of a provider sign-in (#2996): the embedded sign-in Request Card in both flow
 * shapes. Runs only with WOLLIPOG_EVIDENCE_DIR set; WOLLIPOG_EVIDENCE_PREFIX names the set ("before",
 * "after"). Behaviour is asserted in machine-management.spec.ts and authentication-recovery.spec.ts. */
const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
const prefix = process.env.WOLLIPOG_EVIDENCE_PREFIX ?? "after";
const THEMES = ["dark", "light"] as const;

test.skip(!evidenceDir, "set WOLLIPOG_EVIDENCE_DIR to capture evidence");

async function capture(target: Locator | Page, name: string): Promise<void> {
  // Let fonts and any entrance motion settle; capture the still state.
  await (("page" in target) ? target.page() : target).waitForTimeout(400);
  await target.screenshot({ path: join(evidenceDir!, `${prefix}-${name}.png`), animations: "disabled" });
}

for (const theme of THEMES) {
  for (const [flow, query] of [["authorization-code", ""], ["device-code", "&deviceCode=1"]] as const) {
    test(`embedded Request Card, ${flow}, ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/authentication-recovery-e2e.html?scenario=signing-in${query}&theme=${theme}&width=1440&height=900`);
      const card = page.locator(".request-dock").getByRole("region", { name: "Signing In — Claude Code" });
      await expect(card).toBeVisible();
      await capture(card, `request-card-${flow}-1440-${theme}`);
    });
  }
}
