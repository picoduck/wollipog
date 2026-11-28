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

      test("saving one default sends only what changed, keeping another tab's newer edit", async ({ page }) => {
        await open(page);
        const limits = page.getByRole("region", { name: "Limits", exact: true });
        const budget = limits.getByRole("textbox", { name: "Budget per Thread USD" });
        await expect(budget).toHaveValue("25");
        // Another tab pauses launches after this page loaded.
        await page.evaluate(() => Reflect.get(window, "assistantsSaveLimitDefaultsElsewhere")({ launchedSessions: 0 }));
        await budget.fill("40");
        await page.getByRole("button", { name: "Save Defaults" }).click();
        const body = page.locator("body");
        await expect(body).toHaveAttribute("data-patched-limit-defaults", JSON.stringify({ costUsd: 40 }));
        await expect(body).toHaveAttribute("data-saved-limit-defaults", JSON.stringify({ costUsd: 40, launchedSessions: 0 }));
        // The form now shows what is saved, the other tab's pause included, with nothing left to save.
        const launches = limits.getByRole("textbox", { name: "Session Launches per Thread" });
        await expect(launches).toHaveValue("0");
        await expect(page.getByRole("button", { name: "Save Defaults" })).toHaveCount(0);
        // So the next save of another budget never lifts that pause.
        await budget.fill("45");
        await page.getByRole("button", { name: "Save Defaults" }).click();
        await expect(body).toHaveAttribute("data-saved-limit-defaults", JSON.stringify({ costUsd: 45, launchedSessions: 0 }));
      });

      test("an older control plane keeps another tab's limit and refuses an account for a replaced harness", async ({ page }) => {
        await open(page, "older-defaults");
        const limits = page.getByRole("region", { name: "Limits", exact: true });
        const budget = limits.getByRole("textbox", { name: "Budget per Thread USD" });
        await expect(budget).toHaveValue("25");
        await page.evaluate(() => Reflect.get(window, "assistantsSaveLimitDefaultsElsewhere")({ launchedSessions: 0 }));
        await budget.fill("40");
        await page.getByRole("button", { name: "Save Defaults" }).click();
        await expect(page.locator("body")).toHaveAttribute("data-saved-limit-defaults", JSON.stringify({ costUsd: 40, launchedSessions: 0 }));
        await expect(limits.getByRole("textbox", { name: "Session Launches per Thread" })).toHaveValue("0");

        // Another tab replaces the harness; an account chosen here for the old one is refused.
        const defaults = page.getByRole("region", { name: "Thread Defaults" });
        await page.evaluate(() => Reflect.get(window, "assistantsSaveHarnessElsewhere")("codex"));
        await defaults.getByRole("button", { name: /^Account:/ }).click();
        await page.getByRole("option", { name: /^DesignResearchAndEngineeringSubscription/ }).click();
        await page.getByRole("button", { name: "Save Defaults" }).click();
        await expect(page.getByText("The default harness changed.", { exact: false })).toBeVisible();
        await expect(page.locator("body")).not.toHaveAttribute("data-saved-launch-defaults", /DesignResearch|acct:/);
      });

      for (const limits of ["enabled", "older-defaults"]) {
        test(`a harness-only change keeps the account another tab saved for that harness (${limits})`, async ({ page }) => {
          await open(page, limits);
          const defaults = page.getByRole("region", { name: "Thread Defaults" });
          await expect(defaults.getByRole("button", { name: /^Harness:/ })).toHaveAccessibleName("Harness: Claude Code");
          // Another tab saves Codex with a specific account.
          await page.evaluate(() => Reflect.get(window, "assistantsSaveHarnessElsewhere")("codex", "acct:000000000000000a"));
          await defaults.getByRole("button", { name: /^Harness:/ }).click();
          await page.getByRole("option", { name: "Codex", exact: true }).click();
          await page.getByRole("button", { name: "Save Defaults" }).click();
          await expect(page.getByRole("button", { name: "Save Defaults" })).toHaveCount(0);
          const saved = await page.evaluate(() => Reflect.get(window, "assistantsSavedLaunchDefaults")());
          expect(saved).toMatchObject({ harness: "codex", providerAccount: { accountRef: "acct:000000000000000a" } });
        });
      }

      test("a scope edit joins the draft: Discard drops it, and Save Defaults saves it", async ({ page }) => {
        await open(page, "enabled", "stress&default-grant=all-before-releases");
        const delegation = page.getByRole("region", { name: "Decision Delegation", exact: true });
        const scope = delegation.getByRole("button", { name: /Projects and Campaigns/ });
        const pickProject = async () => {
          await scope.click();
          const editor = page.getByRole("dialog", { name: "Decision Delegation for New Threads" });
          const projects = editor.getByRole("group", { name: "Projects", exact: true });
          await projects.getByRole("radio", { name: "Selected Projects" }).click();
          await projects.getByRole("checkbox", { name: /Release Validation/ }).first().check();
          await editor.getByRole("button", { name: "Use Delegation Settings" }).click();
          await expect(editor).toHaveCount(0);
        };
        await expect(delegation).toContainText("All projects and campaigns.");
        await pickProject();
        // Staged, not saved: the summary shows it, and Discard takes it back.
        await expect(delegation).toContainText("1 project · all campaigns.");
        await expect(page.locator("body")).not.toHaveAttribute("data-saved-decision-default", /./);
        await page.getByRole("button", { name: "Discard" }).click();
        await expect(delegation).toContainText("All projects and campaigns.");
        await pickProject();
        await page.getByRole("button", { name: "Save Defaults" }).click();
        await expect(page.getByRole("button", { name: "Save Defaults" })).toHaveCount(0);
        const grant = JSON.parse(await page.locator("body").getAttribute("data-saved-decision-default") ?? "null");
        expect(grant.projects).toEqual(["project_0"]);
        expect(grant.campaigns).toBe("all");
      });

      test("Ask Me in the editor keeps a limited scope for returning to Delegate All", async ({ page }) => {
        await open(page, "enabled", "stress&default-grant=all-scoped");
        const delegation = page.getByRole("region", { name: "Decision Delegation", exact: true });
        await expect(delegation).toContainText("1 project · 1 campaign.");
        await delegation.getByRole("button", { name: /Projects and Campaigns/ }).click();
        const editor = page.getByRole("dialog", { name: "Decision Delegation for New Threads" });
        await editor.getByRole("radio", { name: "Ask Me", exact: true }).click();
        await editor.getByRole("button", { name: "Use Delegation Settings" }).click();
        await expect(delegation.getByRole("button", { name: /^New Threads:/ })).toHaveAccessibleName("New Threads: Ask Me");
        await delegation.getByRole("button", { name: /^New Threads:/ }).click();
        await page.getByRole("option", { name: /^Delegate All/ }).click();
        await expect(delegation).toContainText("1 project · 1 campaign.");
        // Back where it was saved: nothing to save, and the scope was never widened.
        await expect(page.getByRole("button", { name: "Save Defaults" })).toHaveCount(0);
        await delegation.getByRole("button", { name: /^Expires:/ }).click();
        await page.getByRole("option", { name: "30 Days", exact: true }).click();
        await page.getByRole("button", { name: "Save Defaults" }).click();
        const grant = JSON.parse(await page.locator("body").getAttribute("data-saved-decision-default") ?? "null");
        expect([grant.projects, grant.campaigns]).toEqual([["project_0"], ["campaign_0"]]);
      });

      test("new-thread defaults exclude the thread-only Campaign Recovery decision", async ({ page }) => {
        await open(page);
        const delegation = page.getByRole("region", { name: "Decision Delegation", exact: true });
        const mode = delegation.getByRole("button", { name: /^New Threads:/ });
        for (const choice of [/^Delegate All/, /^Choose Categories/]) {
          await mode.click();
          await page.getByRole("option", { name: choice }).click();
          await page.getByRole("button", { name: "Save Defaults" }).click();
          await expect(page.getByRole("button", { name: "Save Defaults" })).toHaveCount(0);
          const grant = JSON.parse(await page.locator("body").getAttribute("data-saved-decision-default") ?? "null");
          expect(grant.categories).not.toContain("campaign_recovery");
        }
      });

      test("choosing Delegate All again in the editor saves the categories supported since", async ({ page }) => {
        await open(page, "enabled", "stress&default-grant=all-before-releases");
        const delegation = page.getByRole("region", { name: "Decision Delegation", exact: true });
        await delegation.getByRole("button", { name: /Projects and Campaigns/ }).click();
        const editor = page.getByRole("dialog", { name: "Decision Delegation for New Threads" });
        await editor.getByRole("radio", { name: "Choose", exact: true }).click();
        await editor.getByRole("radio", { name: "Delegate All", exact: true }).click();
        await editor.getByRole("button", { name: "Use Delegation Settings" }).click();
        // A round trip through Ask Me returns to the refresh just staged, not the saved snapshot.
        const mode = delegation.getByRole("button", { name: /^New Threads:/ });
        await mode.click();
        await page.getByRole("option", { name: /^Ask Me/ }).click();
        await mode.click();
        await page.getByRole("option", { name: /^Delegate All/ }).click();
        await page.getByRole("button", { name: "Save Defaults" }).click();
        await expect(page.getByRole("button", { name: "Save Defaults" })).toHaveCount(0);
        const grant = JSON.parse(await page.locator("body").getAttribute("data-saved-decision-default") ?? "null");
        expect(grant.selectionMode).toBe("all");
        for (const added of ["ci_rerun", "release_tag", "release_publish"]) expect(grant.categories).toContain(added);
        expect(grant.categories).not.toContain("ui_evidence_review");
      });

      test("a model edit saves while the account another tab saved is on a Machine that is away", async ({ page }) => {
        await open(page, "enabled", "&model-patch=fail-once&codex-account=offline");
        const defaults = page.getByRole("region", { name: "Thread Defaults" });
        await expect(defaults.getByRole("button", { name: /^Harness:/ })).toHaveAccessibleName("Harness: Claude Code");
        await page.evaluate(() => Reflect.get(window, "assistantsSaveHarnessElsewhere")("codex", "acct:000000000000000a"));
        await defaults.getByRole("button", { name: /^Harness:/ }).click();
        await page.getByRole("option", { name: "Codex", exact: true }).click();
        await defaults.getByRole("button", { name: /^Model:/ }).click();
        await page.getByRole("option", { name: /GPT-5\.5/ }).click();
        await page.getByRole("button", { name: "Save Defaults" }).click();
        await expect(page.getByText("The saved account's Machine is offline.", { exact: false })).toBeVisible();
        // The account is the server's, not a choice made here: it never blocks the retry.
        await expect(defaults).toContainText("The saved account isn't available on an online Machine right now.");
        const retry = page.getByRole("button", { name: /^(Try Again|Save Defaults)$/ });
        await expect(retry).toBeEnabled();
        await retry.click();
        await expect(retry).toHaveCount(0);
        const saved = await page.evaluate(() => Reflect.get(window, "assistantsSavedLaunchDefaults")());
        expect(saved).toMatchObject({ harness: "codex", model: "gpt-5.5", providerAccount: { accountRef: "acct:000000000000000a" } });
      });

      test("retrying a failed model save keeps the account another tab saved", async ({ page }) => {
        await open(page, "enabled", "&model-patch=fail-once");
        const defaults = page.getByRole("region", { name: "Thread Defaults" });
        await expect(defaults.getByRole("button", { name: /^Harness:/ })).toHaveAccessibleName("Harness: Claude Code");
        await page.evaluate(() => Reflect.get(window, "assistantsSaveHarnessElsewhere")("codex", "acct:000000000000000a"));
        await defaults.getByRole("button", { name: /^Harness:/ }).click();
        await page.getByRole("option", { name: "Codex", exact: true }).click();
        await defaults.getByRole("button", { name: /^Model:/ }).click();
        await page.getByRole("option", { name: /GPT-5\.5/ }).click();
        await page.getByRole("button", { name: "Save Defaults" }).click();
        await expect(page.getByText("The saved account's Machine is offline.", { exact: false })).toBeVisible();
        await page.getByRole("button", { name: /^(Try Again|Save Defaults)$/ }).click();
        await expect(page.getByRole("button", { name: /^(Try Again|Save Defaults)$/ })).toHaveCount(0);
        const saved = await page.evaluate(() => Reflect.get(window, "assistantsSavedLaunchDefaults")());
        expect(saved).toMatchObject({ harness: "codex", model: "gpt-5.5", providerAccount: { accountRef: "acct:000000000000000a" } });
      });

      test("a launch write that fails after an earlier one landed keeps the earlier one", async ({ page }) => {
        await open(page, "enabled", "&account-patch=fail");
        const defaults = page.getByRole("region", { name: "Thread Defaults" });
        await defaults.getByRole("button", { name: /^Harness:/ }).click();
        await page.getByRole("option", { name: "Codex", exact: true }).click();
        await defaults.getByRole("button", { name: /^Account:/ }).click();
        await page.getByRole("option", { name: /^Codex Studio/ }).click();
        await page.getByRole("button", { name: "Save Defaults" }).click();
        await expect(page.getByText("The chosen account is no longer available", { exact: false })).toBeVisible();
        // The harness was saved; Discard returns to what is saved, not to the earlier harness.
        await page.getByRole("button", { name: "Discard" }).click();
        await expect(defaults.getByRole("button", { name: /^Harness:/ })).toHaveAccessibleName("Harness: Codex");
        await expect(defaults.getByRole("button", { name: /^Account:/ })).toHaveAccessibleName(/^Account: Machine Policy/);
      });

      test("Machine Policy clears a saved account even when no Machine can choose accounts", async ({ page }) => {
        await open(page, "enabled", "&saved-account=unavailable");
        const defaults = page.getByRole("region", { name: "Thread Defaults" });
        const account = defaults.getByRole("button", { name: /^Account:/ });
        await expect(account).toBeEnabled();
        await expect(defaults).toContainText("Update this Machine's runner to choose an account.");
        await account.click();
        await page.getByRole("option", { name: /^Machine Policy/ }).click();
        await page.getByRole("button", { name: "Save Defaults" }).click();
        await expect(page.locator("body")).toHaveAttribute("data-saved-launch-defaults", /"providerAccount":null/);
      });

      test("changing only a saved Delegate All's expiry never adds a category supported since", async ({ page }) => {
        // Saved before CI reruns and releases could be delegated; this control plane now supports both.
        await open(page, "enabled", "stress&default-grant=all-before-releases");
        const delegation = page.getByRole("region", { name: "Decision Delegation", exact: true });
        await expect(delegation.getByRole("button", { name: /^New Threads:/ })).toHaveAccessibleName("New Threads: Delegate All");
        await delegation.getByRole("button", { name: /^Expires:/ }).click();
        await page.getByRole("option", { name: "30 Days", exact: true }).click();
        await page.getByRole("button", { name: "Save Defaults" }).click();
        await expect(page.getByRole("button", { name: "Save Defaults" })).toHaveCount(0);
        const grant = JSON.parse(await page.locator("body").getAttribute("data-saved-decision-default") ?? "null");
        expect(grant.selectionMode).toBe("all");
        expect(grant.expiresAfterMs).toBe(30 * 24 * 60 * 60_000);
        expect(grant.categories).toContain("pr_merge");
        for (const added of ["ci_rerun", "release_tag", "release_publish", "ui_evidence_review"]) expect(grant.categories).not.toContain(added);
      });

      test("hidden emails keep two accounts distinguishable in the default Account", async ({ page }) => {
        await page.addInitScript(() => window.localStorage.setItem("wollipog.hide-account-emails", "true"));
        await page.clock.setFixedTime(new Date("2025-11-19T18:00:00Z"));
        await page.goto(`/assistants-e2e.html?path=${settings}&limits=enabled&accounts=emails`);
        const defaults = page.getByRole("region", { name: "Thread Defaults" });
        await defaults.getByRole("button", { name: /^Account:/ }).click();
        const list = page.getByRole("listbox", { name: "Account" });
        await expect(list.getByRole("option", { name: /^Hidden Account 1/ })).toBeVisible();
        await expect(list.getByRole("option", { name: /^Hidden Account 2/ })).toBeVisible();
        await expect(list).not.toContainText("@example");
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
