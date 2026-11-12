import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";

/**
 * #4512: the automation editor shows which account each run is expected to use, from the preview New
 * Session uses, and says the account is rechecked when each run starts. With no eligible account it
 * says why and Create Automation still saves.
 */

const RECHECK = "The account is rechecked when each run starts.";

/** Evidence for review, only when asked for: a screenshot of `target` with no stray selection. */
async function capture(page: Page, target: Locator, name: string) {
  if (!process.env.WOLLIPOG_EVIDENCE_DIR) return;
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await target.screenshot({ path: join(process.env.WOLLIPOG_EVIDENCE_DIR, `${name}.png`) });
}

function agentField(page: Page): Locator {
  return page.locator(".field").filter({ has: page.getByRole("button", { name: /^Agent:/ }) });
}

function whatToRun(page: Page): Locator {
  return page.getByRole("region", { name: "What to Run" });
}

for (const width of [1440, 390]) for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} at ${width}px`, () => {
    test.use({ viewport: { width, height: 1000 } });

    test("under Priority Order the Agent field names the expected account and why", async ({ page }) => {
      await page.goto(`/automations-e2e.html?theme=${theme}&accounts=priority`);
      await page.getByRole("button", { name: "New Automation" }).click();
      const helper = agentField(page).locator(".field-helper");
      await expect(helper).toHaveText("Each run is expected to use work@example.com. This is the first eligible account in the " +
        `machine's Priority Order. Skipped ahead of it: one is at a usage limit. ${RECHECK}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await capture(page, whatToRun(page), `priority-${width}-${theme}`);
    });

    test("under Default Account the Agent field names the saved default", async ({ page }) => {
      await page.goto(`/automations-e2e.html?theme=${theme}&accounts=default`);
      await page.getByRole("button", { name: "New Automation" }).click();
      await expect(agentField(page).locator(".field-helper"))
        .toHaveText(`Each run is expected to use work@example.com. This is the machine's Default Account. ${RECHECK}`);
      await capture(page, whatToRun(page), `default-${width}-${theme}`);
    });

    test("with no eligible account the Agent field says why and Create Automation stays enabled", async ({ page }) => {
      await page.goto(`/automations-e2e.html?theme=${theme}&accounts=none`);
      await page.getByRole("button", { name: "New Automation" }).click();
      const warning = agentField(page).locator(".field-warn");
      await expect(warning).toHaveText("No Claude account in this machine's Priority Order can start a run right now (one is at a " +
        "usage limit and one needs sign-in). Runs that start before this changes are refused. Review this machine's Provider " +
        `Accounts. You can still save. ${RECHECK}`);
      await expect(page.getByRole("button", { name: "Create Automation", exact: true })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await capture(page, whatToRun(page), `none-${width}-${theme}`);
    });

    test("an Orchestrator's Default account is explained under its choice and reached by keyboard", async ({ page }) => {
      const route = `/automations/~${Buffer.from("automation-nightly-sweep", "utf16le").toString("base64url")}/edit`;
      await page.goto(`/automations-e2e.html?campaign&accounts=priority&theme=${theme}&route=${encodeURIComponent(route)}`);
      const choice = page.getByRole("button", { name: /^Orchestrator Provider Account:/ });
      await expect(choice).toHaveAccessibleName("Orchestrator Provider Account: Default");
      await expect(choice).toHaveAccessibleDescription(/^Each run is expected to use work@example\.com\. .*rechecked when each run starts\.$/);
      await expect(agentField(page).locator(".field-helper")).toHaveCount(0);
      await page.getByRole("button", { name: /^Session Role:/ }).focus();
      await page.keyboard.press("Tab");
      await expect(choice).toBeFocused();
      const field = page.locator(".field").filter({ has: choice });
      await capture(page, field, `orchestrator-focus-${width}-${theme}`);
    });

    test("under Hide Account Emails the expected account is masked and revealed by keyboard", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
      await page.goto(`/automations-e2e.html?theme=${theme}&accounts=priority`);
      await page.getByRole("button", { name: "New Automation" }).click();
      const helper = agentField(page).locator(".field-helper");
      await expect(helper).toContainText("Each run is expected to use");
      await expect(helper).not.toContainText("work@example.com");
      const reveal = helper.getByRole("button", { name: "Show Account Email" });
      await page.getByRole("button", { name: /^Agent:/ }).focus();
      await page.keyboard.press("Tab");
      await expect(reveal).toBeFocused();
      await capture(page, agentField(page), `masked-focus-${width}-${theme}`);
      await page.keyboard.press("Enter");
      await expect(helper).toContainText("work@example.com");
    });
  });
}
