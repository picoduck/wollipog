import { expect, test } from "@playwright/test";
import { campaignIssueLimitsRequirement, campaignIssueScopeChangesRequirement } from "@wollipog/protocol";

for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
  for (const [reason, message] of [
    ["legacy target", "Campaign scope requires a valid local or SSH host execution target belonging to its runner. Container and cloud targets are not supported."],
    ["stale network", "The campaign's saved network boundary no longer matches the runner's current isolation policy. Review the runner policy and saved placement before retrying."],
    ["unsupported host boundaries", "The campaign's saved secrets or billing boundary is unsupported for a host placement. Review the saved placement before retrying."],
  ]) {
    test(`${reason} scope refusal explains placement and refreshes after recovery at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      let recovered = false;
      await page.route("**/api/sessions/*/campaign/issue-scope", async (route) => {
        await route.fulfill({ status: recovered ? 200 : 409, contentType: "application/json", body: JSON.stringify(recovered
          ? { campaignSessionId: "s_root", repository: "team/repo", issueNumbers: [123], revision: 1,
            supported: true, canPropose: true, outsideScope: [], candidates: [] }
          : { error: message }) });
      });
      await page.goto("/campaign-status-e2e.html?scenario=campaign&scope=unsupported-target");
      const scope = page.getByRole("region", { name: "Authorized Issue Scope" });
      await expect(scope.getByRole("alert")).toContainText(message);
      await expect(scope.getByRole("alert")).not.toContainText("gh authentication");
      recovered = true;
      await scope.getByRole("button", { name: "Refresh Scope", exact: true }).click();
      await expect(scope.getByRole("alert")).toHaveCount(0);
      await expect(scope.getByText("team/repo#123", { exact: true })).toBeVisible();
      await expect(scope.getByRole("button", { name: "Request Scope Approval", exact: true })).toBeVisible();
    });
  }

  test(`a disconnected legacy scope shows unverified membership and recovers after reconnection at ${viewport.width}px (#2664)`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.clock.install();
    let reconnected = false;
    let reads = 0;
    const work = (workItemId: string, title: string, number: number) => ({ workItemId, title, issue: { repository: "team/repo", number }, sessionId: null });
    await page.route("**/api/sessions/*/campaign/issue-scope", async (route) => {
      reads += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reconnected
        ? { campaignSessionId: "s_root", repository: "team/repo", issueNumbers: [12], revision: 0, supported: true, canPropose: true,
          outsideScope: [work("w_stray", "Stray Work", 99)], candidates: [] }
        : { campaignSessionId: "s_root", repository: "", issueNumbers: [12], revision: 0, supported: false, canPropose: false, runnerDisconnected: true,
          compatibilityMessage: "The campaign runner is disconnected. Saved issue scope is shown; reconnect the runner to verify the repository and request changes.",
          unverifiedWork: [work("w_member", "Member Work", 12)], outsideScope: [work("w_stray", "Stray Work", 99)] }) });
    });
    await page.goto("/campaign-status-e2e.html?scenario=campaign&scope=unsupported-target");
    const scope = page.getByRole("region", { name: "Authorized Issue Scope" });
    const fact = (term: string) => scope.locator("dl.facts > div").filter({ has: page.getByRole("term").getByText(term, { exact: true }) }).locator("dd");
    await expect(fact("Repository")).toHaveText("Not Verified");
    await expect(fact("Authorized Issues")).toHaveText("#12");
    await expect(scope.locator(".notice").filter({ hasText: "Repository Not Verified" })).toBeVisible();
    await expect(scope.locator(".notice").filter({ hasText: "Work Awaiting Repository Verification" })).toContainText("team/repo#12: Member Work");
    const outside = scope.locator(".notice").filter({ hasText: "Work Outside Authorized Scope" });
    await expect(outside).toContainText("team/repo#99: Stray Work");
    await expect(outside).not.toContainText("#12");
    const unavailable = scope.locator(".notice").filter({ hasText: "Scope Changes Unavailable" });
    await expect(unavailable.getByRole("button", { name: "Refresh Scope", exact: true })).toBeVisible();
    const geometry = await scope.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    await scope.scrollIntoViewIfNeeded();
    await scope.screenshot({ path: info.outputPath(`scope-legacy-offline-${viewport.width}.png`) });
    // The runner reconnects at the same revision; the mounted panel finds out on its own.
    reconnected = true;
    const before = reads;
    await page.clock.runFor(10_000);
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(fact("Repository")).toHaveText("team/repo");
    await expect(fact("Authorized Issues")).toHaveText("team/repo#12");
    await expect(unavailable).toHaveCount(0);
    await expect(scope.locator(".notice").filter({ hasText: "Work Awaiting Repository Verification" })).toHaveCount(0);
    await expect(scope.getByRole("button", { name: "Request Scope Approval", exact: true })).toBeVisible();
    await scope.screenshot({ path: info.outputPath(`scope-reconnected-${viewport.width}.png`) });
  });

  test(`a multi-repository scope is grouped under Repositories and accepts issues from each at ${viewport.width}px (#4118)`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/sessions/*/campaign/issue-scope", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        campaignSessionId: "s_root", repository: "owner/app", issueNumbers: [5, 12], revision: 4, supported: true, canPropose: true, candidates: [],
        repositories: [{ repository: "owner/app", issueNumbers: [5, 12], state: "verified" },
          { repository: "owner/api", issueNumbers: [5, 40], state: "verified" },
          { repository: "owner/docs", issueNumbers: [], state: "no_location_online" }],
        outsideScope: [{ workItemId: "w_stray", title: "Stray Work", issue: { repository: "owner/api", number: 99 }, sessionId: null }] }) });
    });
    await page.goto("/campaign-status-e2e.html?scenario=campaign&scope=unsupported-target");
    const scope = page.getByRole("region", { name: "Authorized Issue Scope" });
    const repositories = scope.locator("dl.facts > div").filter({ has: page.getByRole("term").getByText("Repositories", { exact: true }) });
    await expect(repositories.locator("li")).toHaveText(["owner/app: #5, #12", "owner/api: #5, #40",
      "owner/docs (No Location Online): None"]);
    await expect(scope.locator("dl.facts > div").filter({ has: page.getByRole("term").getByText("Authorized Issues", { exact: true }) })).toHaveCount(0);
    await scope.getByLabel("Issue Additions", { exact: true }).fill("owner/api#41, owner/app#41");
    // The whole panel, with the qualified entry typed, at this width; a tall viewport fits it unscrolled.
    await page.setViewportSize({ width: viewport.width, height: 2400 });
    await scope.scrollIntoViewIfNeeded();
    await scope.screenshot({ path: info.outputPath(`scope-repositories-panel-${viewport.width}.png`) });
    // The same panel in place, at the full page width (Campaign Status is a side panel).
    await page.screenshot({ path: info.outputPath(`scope-repositories-page-${viewport.width}.png`) });
    await page.setViewportSize(viewport);
    await scope.getByRole("button", { name: "Request Scope Approval", exact: true }).click();
    await expect(scope.getByRole("status").filter({ hasText: "Scope is unchanged" })).toContainText("Scope is unchanged");
    expect(await page.evaluate(() => (window as unknown as { __SCOPE_PROPOSAL__: unknown }).__SCOPE_PROPOSAL__)).toMatchObject({
      expectedRevision: 4, additions: [{ repository: "owner/api", number: 41 }, { repository: "owner/app", number: 41 }], removals: [],
    });
    const geometry = await scope.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
  });

  test(`a multi-repository scope approval qualifies each change by its repository at ${viewport.width}px (#4118)`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=issue-scope&repositories=1");
    const fact = (term: string) => page.locator("dl.facts > div").filter({ has: page.getByRole("term").getByText(term, { exact: true }) }).locator("dd").first();
    await expect(fact("Additions")).toHaveText("team/repo#125, team/api#40");
    await expect(fact("Removals")).toHaveText("team/repo#124, team/api#5");
    await expect(fact("Affected Assignments")).toHaveText("team/repo#124: child, team/api#5: api-child");
    await page.screenshot({ path: info.outputPath(`scope-approval-repositories-${viewport.width}.png`), fullPage: true });
  });

  test(`human scope recovery and epic selection at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign");
    const scope = page.getByRole("region", { name: "Authorized Issue Scope" });
    await expect(scope.getByText("Work Outside Authorized Scope", { exact: true })).toBeVisible();
    await scope.getByRole("checkbox", { name: /team\/repo#123/ }).check();
    await scope.getByRole("checkbox", { name: /team\/repo#124/ }).check();
    await scope.getByRole("button", { name: "Request Scope Approval", exact: true }).click();
    await expect(scope.getByRole("status").filter({ hasText: "Scope is unchanged" })).toContainText("Scope is unchanged");
    expect(await page.evaluate(() => (window as unknown as { __SCOPE_PROPOSAL__: unknown }).__SCOPE_PROPOSAL__)).toMatchObject({
      expectedRevision: 0, additions: [{ repository: "team/repo", number: 123 }, { repository: "team/repo", number: 124 }], removals: [],
    });
    await scope.getByLabel("Issue Additions", { exact: true }).fill("other/repo#125");
    await scope.getByRole("button", { name: "Request Scope Approval", exact: true }).click();
    await expect(scope.getByRole("alert")).toContainText("Use repository-qualified issues from team/repo");
    const geometry = await scope.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
  });

  test(`a first message's context-only references sit beside its derived scope and promote through scope approval at ${viewport.width}px (#3920)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&scope=first-message");
    const scope = page.getByRole("region", { name: "Authorized Issue Scope" });
    const facts = scope.locator("dl.facts");
    await expect(facts.locator("div").filter({ hasText: "Authorized Issues" }).locator("dd")).toHaveText("team/repo#123, team/repo#124, team/repo#125");
    // The owner sees the context list once, as the selectable group, not also as a fact row.
    await expect(facts.locator("div").filter({ hasText: "Context-Only References" })).toHaveCount(0);
    await expect(scope.getByText("Context-Only References", { exact: true })).toHaveCount(1);
    const context = scope.getByRole("group", { name: "Context-Only References" });
    await expect(context).toHaveAccessibleDescription(/grant no authority/u);
    await expect(context.getByRole("checkbox")).toHaveCount(2);
    await context.getByRole("checkbox", { name: "team/repo#126" }).check();
    await scope.getByLabel("Issue Removals", { exact: true }).fill("team/repo#125");
    await scope.getByRole("button", { name: "Request Scope Approval", exact: true }).click();
    await expect(scope.getByRole("status").filter({ hasText: "Scope is unchanged" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __SCOPE_PROPOSAL__: unknown }).__SCOPE_PROPOSAL__)).toMatchObject({
      expectedRevision: 2, additions: [{ repository: "team/repo", number: 126 }], removals: [{ repository: "team/repo", number: 125 }],
    });
    const geometry = await scope.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
  });
}

for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
  for (const [scope, rows, notice] of [
    ["grant", { "Named Issues": "team/repo#123, team/repo#124", "Selection Count": "5", "Selection Constraints": "open; UI only",
      "Maximum Issues": "9 Derived", "Withheld by Your Message": "PR Merge, Merged Branch Deletion",
      "Decision Model": "claude-haiku-4-5 (low) · Claude Code on Studio" }, null],
    ["grant-default", { "Named Issues": "None", "Selection Count": "3 Defaulted", "Selection Criteria": "highest priority" }, null],
    ["grant-failed", { "Named Issues": "None", "Selection Count": "None", "Failure": "The Decision Model's provider was overloaded." }, "Scope Grant Unavailable"],
    ["grant-uncertain", { "Named Issues": "None", "Reason": "The message doesn't say whether #12 is a request or background." }, "Scope Grant Uncertain"],
  ] as const) {
    test(`Campaign Status shows the ${scope} Scope Grant at ${viewport.width}px (#4102)`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&scope=${scope}`);
      const grant = page.getByRole("region", { name: "Scope Grant" });
      await expect(grant).toBeVisible();
      for (const [term, value] of Object.entries(rows)) {
        await expect(grant.locator("dl.facts > div").filter({ has: page.getByRole("term").getByText(term, { exact: true }) }).locator("dd")).toHaveText(value);
      }
      if (notice) {
        await expect(grant.locator(".notice").filter({ hasText: notice })).toContainText("The Orchestrator's scope proposal comes to you for approval.");
      } else await expect(grant.locator(".notice")).toHaveCount(0);
      // The Scope Grant sits above the authorized scope it established.
      await expect(page.getByRole("region", { name: "Authorized Issue Scope" })).toBeVisible();
      const geometry = await grant.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
      await grant.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`scope-grant-${scope}-${viewport.width}.png`), fullPage: true });
    });
  }
}

for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
  test(`Campaign Status shows the Orchestrator's Scope Proposal with its rationale at ${viewport.width}px (#4282)`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&scope=proposal");
    const section = page.getByRole("region", { name: "Scope Proposal" });
    await expect(section).toBeVisible();
    await expect(page.getByRole("region", { name: "Scope Grant" })).toHaveCount(0);
    const latest = section.getByRole("article", { name: "Latest Proposal" });
    const row = (term: string) => latest.locator("dl.facts > div").filter({ has: page.getByRole("term").getByText(term, { exact: true }) }).locator("dd");
    await expect(latest.getByRole("heading", { level: 4 })).toContainText("Waiting for You");
    await expect(row("Scope")).toHaveText("Initial Scope");
    await expect(row("Count You Asked For")).toHaveText("5");
    await expect(row("Constraints It Read")).toHaveText("open; UI only");
    await expect(row("Withheld Operations")).toHaveText("PR Merge");
    await expect(row("Rationale")).toHaveText("You named #123 and #124. For the rest I ranked open UI issues by priority label, then by age.");
    await expect(row("Issues").getByText("Named by You", { exact: true })).toHaveCount(2);
    await expect(row("Issues").getByText("Chosen by Orchestrator", { exact: true })).toHaveCount(3);
    await expect(row("Checked By")).toContainText("your approval");
    await expect(section.getByRole("article", { name: "Earlier Proposal 1" }).getByRole("heading", { level: 4 })).toContainText("Replaced");
    const geometry = await section.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`scope-proposal-${viewport.width}.png`), fullPage: true });

    // Before the Orchestrator proposes, the section says nothing is dispatched yet.
    await page.goto("/campaign-status-e2e.html?scenario=campaign&scope=proposal-waiting");
    const waiting = page.getByRole("region", { name: "Scope Proposal" });
    await expect(waiting.locator(".notice").filter({ hasText: "Waiting for the Orchestrator's Proposal" })).toContainText("Nothing is dispatched until it is admitted.");
    await expect(waiting.getByRole("article")).toHaveCount(0);
  });
}

for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
  test(`the owner changes a defaulted selection count from the Scope Grant at ${viewport.width}px (#4102)`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&scope=grant-default");
    const grant = page.getByRole("region", { name: "Scope Grant" });
    const row = (term: string) => grant.locator("dl.facts > div").filter({ has: page.getByRole("term").getByText(term, { exact: true }) }).locator("dd");
    await expect(row("Selection Count")).toHaveText("3 Defaulted");
    await expect(row("Maximum Issues")).toHaveText("4 Derived");
    const change = grant.getByRole("button", { name: "Change Count", exact: true });
    await change.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`selection-count-defaulted-${viewport.width}.png`), fullPage: true });

    await change.click();
    const editor = grant.getByRole("group", { name: "Change Selection Count" });
    const input = editor.getByLabel("Issues to Select", { exact: true });
    await expect(input).toHaveValue("3");
    await expect(editor).toContainText("Maximum Issues moves by the same amount.");
    await input.fill("5");
    await editor.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`selection-count-editing-${viewport.width}.png`), fullPage: true });

    await editor.getByRole("button", { name: "Save Count", exact: true }).click();
    await expect(row("Selection Count")).toHaveText("5 Set by You");
    await expect(row("Maximum Issues")).toHaveText("6 Derived");
    await expect(grant.getByRole("group", { name: "Change Selection Count" })).toHaveCount(0);
    const sent = await page.evaluate(() => (window as unknown as { __SELECTION_COUNT__: { count: number; expectedRevision: number } }).__SELECTION_COUNT__);
    expect(sent.count).toBe(5);
    expect(Number.isSafeInteger(sent.expectedRevision)).toBe(true);
    const geometry = await grant.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    await row("Selection Count").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`selection-count-saved-${viewport.width}.png`), fullPage: true });
  });
}

for (const [scope, requirement] of [
  ["outdated-runner", campaignIssueScopeChangesRequirement(207)],
  ["issue-limits", campaignIssueLimitsRequirement(216)],
] as const) {
  test(`an ${scope} refusal names the runner update without a protocol number`, async ({ page }) => {
    await page.goto(`/campaign-status-e2e.html?scenario=campaign&scope=${scope}`);
    const panel = page.getByRole("region", { name: "Authorized Issue Scope" });
    const notice = panel.locator(".notice").filter({ hasText: "Scope Changes Unavailable" });
    await expect(notice).toContainText(requirement.error);
    await expect(notice).not.toContainText(/protocol|v\d/u);
    await expect(panel.getByRole("button", { name: "Request Scope Approval", exact: true })).toHaveCount(0);
  });
}

test("scope approval request shows exact changes and affected assignments",async({page})=>{
  await page.goto("/request-surfaces-e2e.html?scenario=issue-scope");
  await expect(page.locator(".request-dock .request-card-foot").getByRole("button", {name:/^Approve/u})).toBeEnabled();
  await expect(page.getByText("team/repo#125",{exact:true})).toBeVisible();
  await expect(page.getByText("team/repo#124",{exact:true})).toBeVisible();
  await expect(page.getByText("closure-member-124",{exact:true})).toBeVisible();
  await expect(page.getByText(/Issue closure still requires its own human approval/)).toBeVisible();
});

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  test(`an Orchestrator's proposal without lineage is one card with its issues and Maximum Issues increase filled in, ${viewport.name} (#4267)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/request-surfaces-e2e.html?scenario=issue-scope&ownerReview=1");
    const card = page.locator(".request-dock");
    await expect(card).toContainText("The Orchestrator proposed this change. No authorized epic, published follow-up or issue selection admits it, so it needs your approval.");
    await expect(card).toContainText("Approving adds the issues and raises Maximum Issues from 6 to 7; denying leaves both unchanged.");
    await expect(card).toContainText("You asked me to start #141 and #142 after launch.");
    await expect(card.getByText("team/repo#141, team/repo#142", { exact: true })).toBeVisible();
    await expect(card.getByText("Maximum Issues", { exact: true })).toBeVisible();
    await expect(card.getByText("6 to 7", { exact: true })).toBeVisible();
    await expect(card.locator(".request-card-foot").getByRole("button", { name: /^Approve/u })).toBeEnabled();
    await expect(card.locator(".request-card-foot").getByRole("button", { name: /^Deny/u })).toBeEnabled();
  });
}
