import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAssistantControlLayout } from "./assistant-control-layout.js";
import { expectFullyInViewport, expectNoHorizontalOverflow } from "./layout-invariants.js";

const evidence = process.env.ASSISTANT_SETTINGS_EVIDENCE_DIR;
const settings = encodeURIComponent("/settings/assistant");

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

      test("each default is edited in place and saved together with Save Defaults", async ({ page }) => {
        await open(page);
        const defaults = page.getByRole("region", { name: "Thread Defaults" });
        const limits = page.getByRole("region", { name: "Limits", exact: true });
        const delegation = page.getByRole("region", { name: "Decision Delegation", exact: true });
        const select = (scope: Locator, title: string) => scope.getByRole("button", { name: new RegExp(`^${title}:`) });
        const budget = limits.getByRole("textbox", { name: "Budget per Thread USD" });
        const launches = limits.getByRole("textbox", { name: "Session Launches per Thread" });
        const save = page.getByRole("button", { name: "Save Defaults" });
        // Values are the rows' own controls, as on the Orchestrator and Reviews pages: no button per
        // value that opens its own dialog and saves on its own.
        await expect(defaults.getByRole("button")).toHaveCount(4);
        await expect(select(defaults, "Harness")).toHaveAccessibleName("Harness: Claude Code");
        await expect(select(defaults, "Model")).toHaveAccessibleName("Model: Automatic");
        await expect(select(defaults, "Effort")).toHaveAccessibleName("Effort: Automatic");
        await expect(select(defaults, "Account")).toHaveAccessibleName(/^Account: Machine Policy/);
        await expect(budget).toHaveValue("25");
        await expect(launches).toHaveValue("10");
        await expect(select(delegation, "New Threads")).toHaveAccessibleName("New Threads: Ask Me");
        await expect(select(delegation, "Expires")).toHaveCount(0);
        await expect(save).toHaveCount(0);
        await capture(defaults, "defaults", "Thread Defaults shows Harness, Model, Effort and Account as select rows; nothing is unsaved.");

        await select(defaults, "Model").click();
        await page.getByRole("option", { name: /Opus 4\.7/ }).click();
        await select(defaults, "Effort").click();
        await page.getByRole("option", { name: "Max", exact: true }).click();
        await budget.fill("73.50");
        await launches.fill("0");
        await select(delegation, "New Threads").click();
        await page.getByRole("option", { name: /^Choose Categories/ }).click();
        await expect(select(delegation, "Expires")).toHaveAccessibleName("Expires: 7 Days");
        const category = (title: string) => delegation.getByRole("radiogroup", { name: title, exact: true });
        await expect(category("Merge Pull Requests").getByRole("radio", { name: "Assistant" })).toBeChecked();
        // Approving UI evidence needs each thread's own provider disclosure, so a default can't grant it.
        await expect(category("Approve UI Evidence").getByRole("radio", { name: "Assistant" })).toHaveAttribute("aria-disabled", "true");
        await expect(delegation).toContainText("Approving UI evidence needs the provider disclosure");
        await category("Publish Releases").getByRole("radio", { name: "You" }).click();
        await expectFullyInViewport(save, "Save Defaults");
        // The You / Assistant pills are the shared settings segmented control, whose touch target is
        // its 44px row (settings-rows checks every section); the selects and Save bar are measured here.
        await capture(delegation, "unsaved", "Choose Categories shows a You or Assistant row per category, Approve UI Evidence explains why it stays with you, and Save Defaults is fully visible.",
          "button:not(.seg-option)");

        await save.click();
        await expect(save).toHaveCount(0);
        const body = page.locator("body");
        await expect(body).toHaveAttribute("data-saved-launch-defaults",
          JSON.stringify({ harness: "claude-code", providerAccount: null, model: "claude-opus-4-7", effort: "max" }));
        await expect(body).toHaveAttribute("data-saved-limit-defaults", JSON.stringify({ costUsd: 73.5, launchedSessions: 0 }));
        const grant = JSON.parse(await body.getAttribute("data-saved-decision-default") ?? "null");
        expect(grant.selectionMode).toBe("choose");
        expect(grant.categories).toContain("pr_merge");
        expect(grant.categories).not.toContain("release_publish");
        expect(grant.categories).not.toContain("ui_evidence_review");
        expect(grant.expiresAfterMs).toBe(7 * 24 * 60 * 60_000);

        // Another harness's models aren't this one's; Discard puts back what was saved.
        await select(defaults, "Harness").click();
        await page.getByRole("option", { name: "Codex" }).click();
        await expect(select(defaults, "Model")).toHaveAccessibleName("Model: Automatic");
        await page.getByRole("button", { name: "Discard" }).click();
        await expect(select(defaults, "Harness")).toHaveAccessibleName("Harness: Claude Code");
        await expect(select(defaults, "Model")).toHaveAccessibleName("Model: Opus 4.7");

        await select(defaults, "Account").click();
        await page.getByRole("option", { name: /^DesignResearchAndEngineeringSubscription/ }).click();
        await save.click();
        await expect(save).toHaveCount(0);
        await expectFullyInViewport(select(defaults, "Account"), "The saved long account value");
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
        await expect(grants.getByRole("heading", { name: "Active Delegations" })).toBeFocused();
        await expect(page.locator("body")).toHaveAttribute("data-delegation-grant", "null");
        await expired.click();
        await expect(grants.getByText("Release Follow-Up", { exact: true })).toHaveCount(0);
        await expect(grants.getByText("No Delegation Grants")).toBeVisible();
        await expect(grants.getByRole("heading", { name: "Active Delegations" })).toBeFocused();
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

      test("a control plane without the newer defaults shows only the ones it saves", async ({ page }) => {
        await open(page, "older-defaults");
        const defaults = page.getByRole("region", { name: "Thread Defaults" });
        await expect(defaults.getByRole("button")).toHaveCount(2);
        await expect(defaults.getByRole("button", { name: /^Model:/ })).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Decision Delegation", exact: true })).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Limits", exact: true }).getByRole("textbox")).toHaveCount(2);
        await capture(defaults, "older-server", "Thread Defaults has Harness and Account only, and there is no Decision Delegation group.");
      });
    });
  }
}
