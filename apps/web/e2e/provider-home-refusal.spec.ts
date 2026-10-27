import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PROVIDER_HOME_RECOVERY_CAUSES, PROVIDER_HOME_RECOVERY_CAUSE_CODES } from "@wollipog/protocol";
import { providerHomeRecoveryCauseCopy } from "../src/provider-home-refusal.js";

const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

// A launch refused at the provider HOME's lease shows the state for its code and the recovery it
// needs (#3240).
const cases = [
  { query: "lease-refusal=foreign_owner", title: "Account Locked by Another Runner", actions: ["Open Machine Accounts", "Switch Account…"] },
  { query: "lease-refusal=busy", title: "Account in Use", actions: ["Restart Session", "Switch Account…"] },
  { query: "lease-refusal=profile_not_granted", title: "Profile Not Granted", actions: ["Open Machine Accounts", "Switch Account…"] },
  { query: "lease-refusal=foreign_owner&lease-refusal-account=none", title: "Account Locked by Another Runner", actions: ["Open Machine Accounts"] },
  ...PROVIDER_HOME_RECOVERY_CAUSES.map(cause => ({
    query: `lease-refusal=${PROVIDER_HOME_RECOVERY_CAUSE_CODES[cause]}&lease-cause=${cause}`,
    title: providerHomeRecoveryCauseCopy(cause, "Work Account").title,
    actions: ["holder_alive", "boundary_survivor", "process_survivor"].includes(cause)
      ? ["Restart Session", "Switch Account…"] : ["Switch Account…", "Open Machine Accounts"],
  })),
] as const;

for (const width of [390, 1280]) for (const theme of ["dark", "light"] as const) {
  test(`a lease-refused launch shows its state and recovery actions at ${width}px in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const [index, item] of cases.entries()) {
      await page.goto(`/session-usage-e2e.html?driver=claude-code&width=${width}&height=844&${item.query}`);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const notice = page.getByRole("status", { name: item.title });
      await expect(notice).toBeVisible();
      expect((await notice.boundingBox())!.width).toBeLessThanOrEqual(width);
      await expect(notice.locator(".notice-actions button")).toHaveText([...item.actions]);
      for (const name of item.actions) await expect(notice.getByRole("button", { name })).toBeEnabled();
      if (evidenceDir) {
        await page.screenshot({ path: join(evidenceDir, `refusal-${index + 1}-${width}-${theme}.png`), fullPage: true });
      }
    }
    await page.goto(`/machine-management-e2e.html?leases&machine=native-t14s&lease-cause=process_uninspectable_not_delegated`);
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const region = page.getByRole("region", { name: /^Provider Accounts/ });
    const row = region.locator(".surface > .row").filter({ has: page.locator(".row-title", { hasText: "Codex Team" }) });
    await row.getByRole("button", { name: "More Actions for Codex Team" }).click();
    const menu = page.getByRole("menu", { name: "Codex Team", exact: true });
    await expect(menu.getByRole("menuitem", { name: /^Recover Account/ })).toBeDisabled();
    await expect(menu).toContainText("save your work and restart the machine");
    expect(await menu.textContent()).not.toMatch(/systemd|delegat|PID|journal|cgroup|inspectability/iu);
    await menu.getByRole("menuitem", { name: "View Recovery Details…", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Account Recovery Details" });
    await expect(details).toContainText("process_uninspectable_not_delegated");
    await expect(details).toContainText("PID 4242, start time 987654, uninspectable process, cgroup membership unavailable");
  });
}
