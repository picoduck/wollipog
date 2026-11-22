import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAssistantControlLayout } from "./assistant-control-layout.js";
import { expectFullyInViewport, expectNoHorizontalOverflow } from "./layout-invariants.js";

const evidence = process.env.ASSISTANT_SETTINGS_EVIDENCE_DIR;
const settings = encodeURIComponent("/settings/assistant");
const budgetValues = ["$25", "$50", "$100", "$250", "Custom…", "No Limit"];
const defaultDelegation = "Decision Delegation for New Threads";

test.use({ timezoneId: "UTC", locale: "en-US", reducedMotion: "reduce" });

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${width}×${height} ${theme}`, () => {
      test.use({ viewport: { width, height }, hasTouch: width === 390, colorScheme: theme });

      async function open(page: Page, limits = "enabled", delegation = "") {
        await page.clock.setFixedTime(new Date("2025-11-19T18:00:00Z"));
        await page.goto(`/assistants-e2e.html?path=${settings}&limits=${limits}&accounts=stress&delegation=${delegation}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      }

      async function capture(scope: Locator, state: string, claim: string, targets = "button") {
        await expectAssistantControlLayout(scope, width, targets);
        await expectNoHorizontalOverflow(scope.page().locator(".settings-panel"), "Assistant Settings");
        const fontSizes = await scope.locator(".setting-row-title, .setting-row-desc, .status, .choice-row-title, .field > span")
          .evaluateAll((nodes) => nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)));
        expect(fontSizes.every((size) => size >= 12), "Labels and row text are at least 12 CSS px").toBe(true);
        if (!evidence) return;
        const id = `assistant-settings-${width}x${height}-${theme}-${state}${width === 390 ? "-target44csspx-gap8csspx" : "-target24csspx"}`;
        mkdirSync(evidence, { recursive: true });
        await scope.page().screenshot({ path: join(evidence, `${id}.png`), animations: "disabled" });
        appendFileSync(join(evidence, "claims.jsonl"), JSON.stringify({ id, claim }) + "\n");
      }

      test("each default has its own value, budget exposes exactly six choices, and delegation can be changed", async ({ page }) => {
        await open(page);
        const defaults = page.getByRole("region", { name: "Thread Defaults" });
        const values = ["Claude Code Harness", "Machine Policy Account", "$25 Budget per Thread",
          "10 Session Launches per Thread", `Ask Me ${defaultDelegation}`];
        for (const name of values) await expectFullyInViewport(defaults.getByRole("button", { name, exact: true }), name);
        await expect(defaults.getByRole("button")).toHaveCount(5);
        await capture(defaults, "defaults-ask-me", "Five visible value buttons show Claude Code, Machine Policy, $25, 10 launches and Ask Me.");

        await defaults.getByRole("button", { name: "$25 Budget per Thread", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Budget per Thread" });
        await expect(dialog.getByRole("radio")).toHaveCount(budgetValues.length);
        for (const name of budgetValues) await expect(dialog.getByRole("radio", { name, exact: true })).toBeVisible();
        const saveBudget = dialog.getByRole("button", { name: "Save Default" });
        await expectFullyInViewport(saveBudget, "Save Default");
        await capture(dialog, "budget-presets", "Exactly $25, $50, $100, $250, Custom… and No Limit are available. Save Default is fully visible.", "button");
        await dialog.getByRole("radio", { name: "Custom…", exact: true }).click();
        const amount = dialog.getByRole("textbox", { name: "Custom Budget (USD)" });
        await amount.fill("73.50");
        await expect(amount).toHaveValue("73.50");
        await expectFullyInViewport(saveBudget, "Save Default");
        await capture(dialog, "budget-custom", "Custom… shows the amount field populated with 73.50 and Save Default remains fully visible.", "button, input:not([type=radio])");
        await saveBudget.click();
        await expect(defaults.getByRole("button", { name: "$73.50 Budget per Thread", exact: true })).toBeVisible();

        await defaults.getByRole("button", { name: `Ask Me ${defaultDelegation}`, exact: true }).click();
        const editor = page.getByRole("dialog", { name: defaultDelegation });
        await expect(editor.getByText("Decisions stay with you.")).toBeVisible();
        await editor.getByRole("radio", { name: "Delegate All", exact: true }).click();
        await expect(editor.getByText("The expiry starts when each thread is created.")).toBeVisible();
        await expect(editor.getByText("Approving UI evidence requires accepting the provider disclosure in each thread.")).toBeVisible();
        const saveDelegation = editor.getByRole("button", { name: "Save Delegation" });
        await expectFullyInViewport(saveDelegation, "Save Delegation");
        await capture(editor, "default-delegation-editor", "Delegate All describes creation-time expiry and the per-thread provider disclosure. Save Delegation is fully visible.");
        await saveDelegation.click();
        const delegated = defaults.getByRole("button", { name: `Delegate All · 7 Days ${defaultDelegation}`, exact: true });
        await expectFullyInViewport(delegated, "Delegated default");
        await capture(defaults, "defaults-delegated", "The default row displays Delegate All · 7 Days after saving.");
        await delegated.click();
        await editor.getByRole("radio", { name: "Ask Me", exact: true }).click();
        await saveDelegation.click();
        await expect(defaults.getByRole("button", { name: `Ask Me ${defaultDelegation}`, exact: true })).toBeVisible();

        await defaults.getByRole("button", { name: "Machine Policy Account" }).click();
        const account = page.getByRole("dialog", { name: "Account", exact: true });
        await account.getByRole("radio", { name: /^DesignResearchAndEngineeringSubscription/ }).check();
        await account.getByRole("button", { name: "Save Default" }).click();
        const accountValue = defaults.getByRole("button", { name: /^DesignResearchAndEngineeringSubscription.* Account$/ });
        await expectFullyInViewport(accountValue, "The saved long account value");
        await expectNoHorizontalOverflow(defaults, "Defaults with a long account name");
      });

      test("revokes an active grant with confirmation and removes an expired grant", async ({ page }) => {
        await open(page, "enabled", "active-expired");
        const grants = page.getByRole("region", { name: "Active Delegations" });
        const active = grants.getByRole("button", { name: "Revoke… Triage Open Issues" });
        const expired = grants.getByRole("button", { name: "Remove Release Follow-Up" });
        await expect(grants.getByText("Active", { exact: true })).toBeVisible();
        await expect(grants.getByText("Expired", { exact: true })).toBeVisible();
        await expect(grants.getByText("Delegate All · Expires in 11 days", { exact: true })).toBeVisible();
        await expect(grants.getByText("Choose · Expired", { exact: true })).toBeVisible();
        await grants.scrollIntoViewIfNeeded();
        await expectFullyInViewport(active, "Revoke…");
        await expectFullyInViewport(expired, "Remove");
        await capture(grants, "active-expired", "The Active row shows Delegate All · Expires in 11 days and Revoke…. The Expired row shows Choose · Expired and Remove.");

        const confirmation = page.getByRole("dialog", { name: "Revoke Delegation" });
        await active.click();
        await expect(confirmation).toContainText("“Triage Open Issues” will lose permission to resolve decisions on your behalf.");
        const revoke = confirmation.getByRole("button", { name: "Revoke Delegation" });
        await expectFullyInViewport(revoke, "Revoke Delegation");
        await capture(confirmation, "revoke-confirmation", "The confirmation names Triage Open Issues and describes the loss of permission. Revoke Delegation is fully visible.");
        await confirmation.getByRole("button", { name: "Cancel" }).click();
        await expect(active).toBeVisible();
        await active.click();
        await revoke.click();
        await expect(grants.getByText("Triage Open Issues", { exact: true })).toHaveCount(0);
        await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", "null");
        await expired.click();
        await expect(grants.getByText("Release Follow-Up", { exact: true })).toHaveCount(0);
        await expect(grants.getByText("No Delegation Grants")).toBeVisible();
      });

      test("many grants and long connection names fit the Settings page", async ({ page }) => {
        await open(page, "stress", "many");
        const grants = page.getByRole("region", { name: "Active Delegations" });
        await expect(grants.getByRole("button")).toHaveCount(10);
        const longGrant = grants.getByRole("button", { name: /^Remove Ship the release notes/ });
        await grants.getByRole("heading").evaluate((heading) => heading.scrollIntoView({ block: "start" }));
        await expectFullyInViewport(longGrant, "Remove for the long thread name");
        await capture(grants, "many-delegations", "The page is scrolled to Active Delegations. Remove for the long thread name is fully visible, and the group contains 10 actions.");

        const connections = page.getByRole("region", { name: "Assistant Connections", exact: true });
        await expect(connections.locator(".assistant-connection-row")).toHaveCount(3);
        const all = connections.getByRole("button", { name: "All Connections 9" });
        await connections.scrollIntoViewIfNeeded();
        await expectFullyInViewport(all, "All Connections");
        await expectFullyInViewport(connections.getByRole("button", { name: "New Connection" }), "New Connection");
        await capture(connections, "long-connection-names", "The page is scrolled to Assistant Connections. The preview contains three rows, All Connections 9 and New Connection.");
      });

      test("the connection preview shows availability, access and last use and opens the Settings pages", async ({ page }) => {
        await open(page);
        const connections = page.getByRole("region", { name: "Assistant Connections", exact: true });
        const previews = connections.locator(".assistant-connection-row");
        await expect(previews).toHaveCount(3);
        const configured = previews.filter({ hasText: "Configured Access" });
        await expect(configured).toContainText("Active");
        const revoked = previews.filter({ hasText: "Revoked" });
        await expect(revoked).toContainText("Full Access");
        await expect(connections.locator("time")).toHaveAttribute("datetime", "2025-11-19T18:00:00.000Z");
        await expect(previews.filter({ hasText: "Never Used" })).toHaveCount(2);
        const all = connections.getByRole("button", { name: "All Connections 3" });
        const create = connections.getByRole("button", { name: "New Connection", exact: true });
        await connections.scrollIntoViewIfNeeded();
        await expectFullyInViewport(create, "New Connection");
        await expectFullyInViewport(all, "All Connections");
        await capture(connections, "connections", "The page is scrolled to Assistant Connections. Three rows show active or revoked status, full or configured access, and recorded or no use. All Connections shows 3.");
        await all.click();
        await expect(page.getByRole("heading", { name: "Assistant Connections", exact: true })).toBeVisible();
        await expect(page.getByRole("region", { name: "Connections", exact: true }).getByRole("button")).toHaveCount(3);
        await page.goBack();
        await create.click();
        await expect(page.getByRole("heading", { name: "New Connection", exact: true })).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Connection Name" })).toBeVisible();
      });

      test("a control plane without the feature still shows the four earlier defaults", async ({ page }) => {
        await open(page, "older-defaults");
        const defaults = page.getByRole("region", { name: "Thread Defaults" });
        await expect(defaults.getByRole("button")).toHaveCount(4);
        await expect(defaults.getByText(defaultDelegation, { exact: true })).toHaveCount(0);
        await capture(defaults, "older-server", "Thread Defaults has four value buttons and no Decision Delegation for New Threads row.");
      });
    });
  }
}
