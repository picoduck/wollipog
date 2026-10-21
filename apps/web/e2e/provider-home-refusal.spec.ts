import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

// A launch refused at the provider HOME's lease shows the state for its code and the recovery it
// needs (#3240).
const cases = [
  { query: "lease-refusal=foreign_owner", title: "Account Locked by Another Runner", actions: ["Open Machine Accounts", "Switch Account…"] },
  { query: "lease-refusal=busy", title: "Account In Use", actions: ["Restart Session", "Switch Account…"] },
  { query: "lease-refusal=profile_not_granted", title: "Profile Not Granted", actions: ["Open Machine Accounts", "Switch Account…"] },
  { query: "lease-refusal=foreign_owner&lease-refusal-account=none", title: "Account Locked by Another Runner", actions: ["Open Machine Accounts"] },
] as const;

for (const width of [390, 1280]) for (const theme of ["dark", "light"] as const) {
  test(`a lease-refused launch shows its state and recovery actions at ${width}px in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const [index, item] of cases.entries()) {
      await page.goto(`/session-usage-e2e.html?driver=claude-code&${item.query}`);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const notice = page.getByRole("status", { name: item.title });
      await expect(notice).toBeVisible();
      await expect(notice.locator(".notice-actions button")).toHaveText([...item.actions]);
      for (const name of item.actions) await expect(notice.getByRole("button", { name })).toBeEnabled();
      if (evidenceDir) {
        await page.screenshot({ path: join(evidenceDir, `refusal-${index + 1}-${width}-${theme}.png`), fullPage: true });
      }
    }
  });
}
