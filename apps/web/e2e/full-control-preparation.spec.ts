import { expect, test, type Locator, type Page } from "@playwright/test";
import { CONTROLLED_REVIEW_PROFILE, DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION,
  type FullControlLaunchRequest, type OrchestratorCampaignPolicy, type RunnerView } from "@wollipog/protocol";
import { execFileSync } from "node:child_process";
import { campaignLaunchPreflight } from "../../control-plane/src/campaign-launch-admission.js";

const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const captures = `test-results/full-control-source-fixture-${sourceHead}`;
const viewports = [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 390, height: 844 }];
const themes = ["dark", "light"];

/** The browser shows the server's own readiness evaluation, so every reason and the retention
 * disclosure are the exact server-derived text. The runner fixtures differ only in what the runner
 * reports: bwrap isolation without the controlled reviewer, or provider isolation with the audited
 * reviewer profile. Enabling an existing campaign uses its own Human-established scope. */
function serverPreflight(launch: FullControlLaunchRequest, runnerReady: boolean, existingCampaign = false) {
  const runner = { runnerId: "runner-1", connectedAt: 1, protocolVersion: PROTOCOL_VERSION, agents: [], workspaces: [],
    runtime: { dataDir: "/fixture", worktreeRoot: "/fixture/worktrees", maxConcurrentSessions: 4, campaignLaunchInspection: { version: 2 },
      executionIsolation: runnerReady ? { mode: "provider", network: "inherit" } : { mode: "bwrap", network: "deny" },
      ...(runnerReady ? { campaignReview: { profile: CONTROLLED_REVIEW_PROFILE, controllerSha256: "c".repeat(64), executableSha256: "e".repeat(64),
        cliVersion: "2.1.296", accounting: "provider_list_estimate", account: "runner_default_claude", agentId: "claude" } } : {}) },
  } as unknown as RunnerView;
  const policy = { ...structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS), version: 1 } as unknown as OrchestratorCampaignPolicy;
  const plan = { runnerId: "runner-1", workspaceId: launch.workspaceId, agentId: "claude", driver: "claude-code" as const,
    config: { model: "source-fixture-model", effort: "high", permissionMode: "orchestrator" }, useWorktree: true,
    executionTarget: { adapter: "host" as const }, policy, scope: { organizationId: "org", owner: { kind: "user" as const, userId: "user" } } };
  const issueNumbers = [...(launch.issueNumbers ?? [])].sort((a, b) => a - b);
  return campaignLaunchPreflight({ request: launch, plan: plan as never, runner, organizationId: "org", projectDefaults: null,
    ...(existingCampaign
      ? { campaignScope: { repository: "example/full-control-fixture", issueNumbers: [12], authorizedByCaller: true } }
      : { inspection: { type: "campaign_launch_inspection_result" as const, requestId: "fixture", workspaceId: launch.workspaceId, ok: true,
        repository: "example/full-control-fixture", issueNumbers, digest: "d".repeat(64) } }),
    accountingError: null, dailyLimit: false, invalidPolicyIds: [], imageReview: { effectiveOwner: "orchestrator" },
    pacedVideoPeer: false, disclosuresAvailable: true, savedBudget: null }).preflight;
}

async function routeSettings(page: Page, writes: unknown[], options: { answered?: Promise<void>; campaignBudget?: { costUsd: number; toolCalls: number } } = {}) {
  let saved = { ...structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS), ...(options.campaignBudget ? { campaignBudget: options.campaignBudget } : {}) };
  await page.route("**/api/orchestrator-settings", async (route) => {
    await options.answered;
    if (route.request().method() !== "GET") { writes.push(route.request().postDataJSON()); saved = route.request().postDataJSON().defaults; }
    const defaults = structuredClone(saved);
    defaults.behavior.childHarness = null; defaults.behavior.childModel = null; defaults.behavior.childEffort = null;
    await route.fulfill({ json: { defaults, source: "system_default", controlModeSupported: true,
      capabilities: { harnesses: [{ agentId: "claude", driver: "claude-code", context: { kind: "native" },
        name: "Source Fixture Harness", models: [{ id: "source-fixture-model", efforts: ["high"] }], effortLevels: ["high"],
        supportedPairs: [{ modelId: "source-fixture-model", effortLevels: ["high"] }], installations: 1 }],
        models: [{ id: "source-fixture-model", efforts: ["high"] }], effortLevels: ["high"],
        installations: 1, compatibleInstallations: 1, status: "available" } } });
  });
}

// A closed <details> is never rendered, so transitions inside it never finish; they cannot affect a screenshot.
const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((animation) => !(animation.effect as KeyframeEffect | null)?.target?.closest("details:not([open])"))
  .map((animation) => animation.finished))
  .then(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
/** Real typing of text a number field cannot read is an entry error on every limit, never a default. */
async function expectUnreadableLimitsBlock(page: Page, action: Locator) {
  for (const label of ["Cost Limit (USD)", "Tool Call Limit", "Concurrent Children", "Accepted Follow-Ups", "Maximum Issues"]) {
    const field = page.getByLabel(label, { exact: true }).first();
    const before = await field.inputValue();
    await field.fill("");
    await field.pressSequentially("1e");
    await expect(field).toHaveValue("1e");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Correct the highlighted limits to check readiness.", { exact: true })).toBeVisible();
    await expect(action).toBeDisabled();
    await field.fill(before);
  }
  await expect(action).toBeEnabled();
}

async function shoot(page: Page, anchor: Locator, path: string) {
  await anchor.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
  await settle(page);
  await page.screenshot({ path });
}

/** Deterministic API/Session fixtures for the three surfaces. These are visual and launch-fencing
 * checks only; they never attest live Full Control or evidence-provider readiness. */
for (const viewport of viewports) {
  for (const theme of themes) {
    test(`launch ${viewport.name} ${theme}: readiness is checked at once and one action authorizes and starts`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const prefix = `${captures}/launch-${viewport.name}-${theme}`;
      const writes: unknown[] = [];
      await routeSettings(page, writes);
      let runnerReady = false;
      const admissions: Array<Record<string, unknown>> = [];
      await page.route("**/api/full-control-campaigns/preflight", async (route) => {
        const launch = route.request().postDataJSON() as FullControlLaunchRequest;
        expect((launch as unknown as Record<string, unknown>).repository).toBeUndefined();
        await route.fulfill({ json: { preflight: serverPreflight(launch, runnerReady) } });
      });
      let releaseAdmission: () => void = () => undefined;
      const admitted = new Promise<void>((resolve) => { releaseAdmission = resolve; });
      await page.route("**/api/full-control-campaigns", async (route) => {
        admissions.push(route.request().postDataJSON());
        await admitted;
        await route.fulfill({ status: 201, json: { id: "session-full-control" } });
      });
      await page.goto(`/new-session-choices-e2e.html?defaults=orchestrator&openedView=1&theme=${theme}`);
      await page.getByRole("radio", { name: "Full Control", exact: true }).click();
      const control = page.getByRole("heading", { name: "Orchestrator Control", exact: true });
      await expect(page.getByText("Can't Start Yet", { exact: true })).toBeVisible();
      await expect(page.getByText(/This runner does not advertise the controlled native reviewer\. It needs executionIsolation\.mode "provider" \(current: bwrap\)/).first()).toBeVisible();
      await expect(page.getByText("No campaign budget yet: enter a cost limit and a tool-call limit.").first()).toBeVisible();
      const start = page.getByRole("button", { name: "Authorize and Start", exact: true });
      await expect(start).toBeDisabled();
      await expect(page.getByRole("button", { name: "Create Session", exact: true })).toHaveCount(0);
      await shoot(page, control, `${prefix}-blocked.png`);

      // The operator configures provider isolation and the reviewer; the person adds a task and budget.
      runnerReady = true;
      await page.getByLabel("Task", { exact: true }).fill("Review the source fixture");
      await page.getByLabel("Issue Numbers", { exact: true }).fill("12");
      await page.getByLabel("Cost Limit (USD)", { exact: true }).first().fill("20");
      await page.getByLabel("Tool Call Limit", { exact: true }).first().fill("200");
      const ready = page.getByText("Ready to Authorize and Start", { exact: true });
      await expect(ready).toBeVisible();
      await expect(page.getByText("example/full-control-fixture · #12", { exact: true })).toBeVisible();
      await expect(page.getByText(/Wollipog does not configure zero retention/)).toBeVisible();
      await expect(start).toBeEnabled();
      await shoot(page, ready, `${prefix}-ready.png`);

      const advanced = page.locator("summary").filter({ hasText: "Advanced" });
      await advanced.click();
      await expect(page.getByText("Campaign Limits", { exact: true })).toBeVisible();
      await expect(page.getByText(/Controlled Cross-Model Review \(Verified\)/)).toBeVisible();
      await shoot(page, advanced, `${prefix}-advanced.png`);
      await expectUnreadableLimitsBlock(page, start);
      await advanced.click();

      await start.click();
      await expect(start).toHaveAttribute("aria-busy", "true");
      // The busy spinner animates until the admission answers, so wait for paint rather than for it.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.screenshot({ path: `${prefix}-starting.png` });
      releaseAdmission();
      await expect(page.getByRole("status").filter({ hasText: "session-full-control" })).toBeVisible();
      await settle(page);
      await page.screenshot({ path: `${prefix}-started.png` });
      expect(admissions).toHaveLength(1);
      expect(admissions[0]!.preflightDigest).toBe(serverPreflight(admissions[0] as unknown as FullControlLaunchRequest, true).digest);
      expect(admissions[0]!.requestId).toMatch(/^[a-f0-9]{32}$/);
      expect((writes[0] as { defaults: { campaignBudget: unknown } }).defaults.campaignBudget).toEqual({ costUsd: 20, toolCalls: 200 });
    });

    test(`defaults ${viewport.name} ${theme}: Full Control saves a preference and a campaign budget, never authority`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/settings-rows-e2e.html?section=orchestrator&fullControlFixture=1&theme=${theme}`);
      await page.getByRole("radio", { name: "Full Control", exact: true }).click();
      const group = page.getByRole("heading", { name: "Full Control", exact: true });
      await expect(group).toBeVisible();
      await expect(page.getByText("Activation Unavailable", { exact: true })).toHaveCount(0);
      const save = page.getByRole("button", { name: "Save Defaults", exact: true });
      for (const id of ["#orchestrator-campaign-cost", "#orchestrator-campaign-tools", "#orchestrator-max-children"]) {
        const field = page.locator(id);
        const before = await field.inputValue();
        await field.fill("");
        // A lone `e` leaves the number field's value "", so React sees no change; only the input event can tell.
        await field.pressSequentially("e");
        await expect(save, `${id} holding e cannot save`).toHaveAttribute("aria-disabled", "true");
        await field.fill(before);
        await expect(save).not.toHaveAttribute("aria-disabled", "true");
      }
      await page.locator("#orchestrator-campaign-cost").fill("40");
      await page.locator("#orchestrator-campaign-tools").fill("400");
      await shoot(page, group, `${captures}/defaults-${viewport.name}-${theme}-full-control.png`);
      await page.getByRole("button", { name: "Save Defaults", exact: true }).click();
      await expect.poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.fullControlFixtureWrites ?? "[]").length)).toBe(1);
      const written = JSON.parse((await page.evaluate(() => JSON.parse(document.documentElement.dataset.fullControlFixtureWrites ?? "[]") as string[]))[0]!);
      expect(written.defaults.controlMode).toBe("full_control");
      expect(written.defaults.campaignBudget).toEqual({ costUsd: 40, toolCalls: 400 });
      expect(written.defaults.control).toBeUndefined();
    });

    test(`campaign ${viewport.name} ${theme}: an existing campaign enables Full Control through one action`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const prefix = `${captures}/campaign-${viewport.name}-${theme}`;
      await routeSettings(page, []);
      await page.route("**/orchestrator-campaign/full-control/preflight", async (route) => {
        const body = route.request().postDataJSON() as { overrides?: FullControlLaunchRequest["overrides"] };
        await route.fulfill({ json: { preflight: serverPreflight({ runnerId: "runner-1", workspaceId: "w", task: "Review the source fixture",
          overrides: body.overrides }, true, true), expectedRevision: 3 } });
      });
      await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height}&composer=orchestrator&fullControlFixture=enable`);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.getByRole("button", { name: "Attach and Settings" }).click();
      await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
      const heading = page.getByRole("heading", { name: "Orchestrator Control", exact: true });
      await expect(page.getByText(/Effective Mode: Custom/)).toBeVisible();
      await page.getByRole("radio", { name: "Full Control", exact: true }).click();
      await expect(page.getByText("Can't Enable Yet", { exact: true })).toBeVisible();
      const enable = page.getByRole("button", { name: "Enable Full Control", exact: true });
      await expect(enable).toBeDisabled();
      await shoot(page, heading, `${prefix}-enable-blocked.png`);
      await page.getByLabel("Cost Limit (USD)", { exact: true }).first().fill("30");
      await page.getByLabel("Tool Call Limit", { exact: true }).first().fill("300");
      const ready = page.getByText("Ready to Enable", { exact: true });
      await expect(ready).toBeVisible();
      await expect(page.getByText("example/full-control-fixture · #12", { exact: true })).toBeVisible();
      await expect(enable).toBeEnabled();
      await shoot(page, ready, `${prefix}-enable-ready.png`);
      const advanced = page.locator("summary").filter({ hasText: "Advanced" });
      await advanced.click();
      await expectUnreadableLimitsBlock(page, enable);
      await advanced.click();
      await enable.click();
      await expect(page.getByText(/Effective Mode: Full Control/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Revoke Full Control", exact: true })).toBeVisible();
      await shoot(page, heading, `${prefix}-enabled.png`);
    });
  }
}

for (const viewport of viewports) {
  for (const theme of themes) test(`root revoke ${viewport.name} ${theme}: fixture revision advances without changing defaults`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/session-usage-e2e.html?composer=orchestrator&fullControlFixture=1`);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.getByRole("button", { name: "Attach and Settings" }).click();
    await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
    const heading = page.getByRole("heading", { name: "Orchestrator Control", exact: true });
    await expect(page.getByText(/Effective Mode: Full Control/)).toBeVisible();
    await shoot(page, heading, `${captures}/revoke-${viewport.name}-${theme}-full.png`);
    await page.getByRole("button", { name: "Revoke Full Control", exact: true }).click();
    await expect(page.getByText(/Effective Mode: Custom/)).toBeVisible();
    await shoot(page, heading, `${captures}/revoke-${viewport.name}-${theme}-custom.png`);
  });
  for (const theme of themes) test(`legacy descendant ${viewport.name} ${theme}: unknown root state cannot imply Full authority`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/session-usage-e2e.html?composer=orchestrator&fullControlFixture=legacy`);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.getByRole("button", { name: "Attach and Settings" }).click();
    await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
    await expect(page.getByText(/Effective Mode: Current Root State Not Reported/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke Full Control", exact: true })).toHaveCount(0);
    await expect(page.locator('[data-control-mode="full_control"]')).toHaveCount(0);
    await shoot(page, page.getByRole("heading", { name: "Orchestrator Control", exact: true }), `${captures}/legacy-${viewport.name}-${theme}-unknown.png`);
  });
}

/** The limit-entry lifecycle (L1-L8 in the review brief), typed for real in the browser on each
 * surface. Every limit is a text entry whose typed text is its only state. */
test.describe("limit entry lifecycle", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });
  const invalidNotice = (page: Page) => page.getByText("Correct the highlighted limits to check readiness.", { exact: true });

  test("New Session: an entry survives collapse and blur, blocks submit, clears to the default, and a surface switch starts fresh", async ({ page }) => {
    await routeSettings(page, []);
    const admissions: unknown[] = [];
    await page.route("**/api/full-control-campaigns/preflight", async (route) => {
      await route.fulfill({ json: { preflight: serverPreflight(route.request().postDataJSON() as FullControlLaunchRequest, true) } });
    });
    await page.route("**/api/full-control-campaigns", async (route) => {
      admissions.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { id: "session-full-control" } });
    });
    await page.goto("/new-session-choices-e2e.html?defaults=orchestrator&openedView=1&theme=light");
    await page.getByRole("radio", { name: "Full Control", exact: true }).click();
    const start = page.getByRole("button", { name: "Authorize and Start", exact: true });
    const children = page.getByLabel("Concurrent Children", { exact: true });
    // L1: empty entries are the derived values.
    await expect(children).toHaveValue("");
    await page.getByLabel("Task", { exact: true }).fill("Review the source fixture");
    await page.getByLabel("Cost Limit (USD)", { exact: true }).first().fill("20");
    await page.getByLabel("Tool Call Limit", { exact: true }).first().fill("200");
    await expect(start).toBeEnabled();
    const advanced = page.locator("summary").filter({ hasText: "Advanced" });
    await advanced.click();
    // L4: invalid, valid, invalid again.
    await children.pressSequentially("1e");
    await expect(children).toHaveAttribute("aria-invalid", "true");
    await expect(start).toBeDisabled();
    await children.fill("6");
    await expect(start).toBeEnabled();
    await children.pressSequentially("e");
    await expect(children).toHaveValue("6e");
    await expect(start).toBeDisabled();
    // L6: blur changes nothing.
    await children.press("Tab");
    await expect(children).toHaveValue("6e");
    await expect(children).toHaveAttribute("aria-invalid", "true");
    // L2: collapsing Advanced keeps the entry and its error.
    await advanced.click();
    await expect(invalidNotice(page)).toBeVisible();
    await expect(start).toBeDisabled();
    await advanced.click();
    await expect(children).toHaveValue("6e");
    // L8: submitting by Enter starts nothing.
    await page.getByLabel("Issue Numbers", { exact: true }).press("Enter");
    await expect(page.getByText(/Full Control isn't ready yet/)).toBeVisible();
    // L5 and L7: clearing returns to the derived value.
    await children.fill("");
    await expect(children).toHaveAttribute("aria-invalid", "false");
    await expect(start).toBeEnabled();
    // L2: a surface switch mounts a fresh panel without stale entries or errors.
    await children.fill("1e");
    await expect(start).toBeDisabled();
    await page.getByRole("radio", { name: "Custom", exact: true }).click();
    await page.getByRole("radio", { name: "Full Control", exact: true }).click();
    await expect(page.getByLabel("Concurrent Children", { exact: true })).toHaveValue("");
    await expect(invalidNotice(page)).toHaveCount(0);
    expect(admissions).toHaveLength(0);
  });

  test("Campaign enable: a late saved default keeps typed amounts, an entry survives collapse and blur, and reopening starts fresh", async ({ page }) => {
    let answerSettings: () => void = () => undefined;
    await routeSettings(page, [], { answered: new Promise<void>((resolve) => { answerSettings = resolve; }), campaignBudget: { costUsd: 50, toolCalls: 500 } });
    await page.route("**/orchestrator-campaign/full-control/preflight", async (route) => {
      const body = route.request().postDataJSON() as { overrides?: FullControlLaunchRequest["overrides"] };
      await route.fulfill({ json: { preflight: serverPreflight({ runnerId: "runner-1", workspaceId: "w", task: "Review the source fixture",
        overrides: body.overrides }, true, true), expectedRevision: 3 } });
    });
    await page.goto("/session-usage-e2e.html?width=1440&height=1000&composer=orchestrator&fullControlFixture=enable");
    const open = async () => {
      await page.getByRole("button", { name: "Attach and Settings" }).click();
      await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
      await page.getByRole("radio", { name: "Full Control", exact: true }).click();
    };
    await open();
    const enable = page.getByRole("button", { name: "Enable Full Control", exact: true });
    // L1 and L3: amounts typed before the saved default arrives stay this campaign's override.
    await page.getByLabel("Cost Limit (USD)", { exact: true }).first().fill("30");
    await page.getByLabel("Tool Call Limit", { exact: true }).first().fill("300");
    await expect(enable).toBeEnabled();
    answerSettings();
    const advanced = page.locator("summary").filter({ hasText: "Advanced" });
    await advanced.click();
    await expect(page.locator("details").getByLabel("Cost Limit (USD)", { exact: true })).toHaveValue("30");
    await expect(page.getByText(/\$30 · 300 tool calls/)).toBeVisible();
    await expect(page.getByText(/Saved Default/)).toHaveCount(0);
    // L4, L6 and L2: invalid, blur, collapse, expand.
    const children = page.getByLabel("Concurrent Children", { exact: true });
    await children.pressSequentially("1e");
    await expect(enable).toBeDisabled();
    await children.press("Tab");
    await advanced.click();
    await expect(invalidNotice(page)).toBeVisible();
    await advanced.click();
    await expect(children).toHaveValue("1e");
    await expect(enable).toBeDisabled();
    // L5: clearing returns to the derived value.
    await children.fill("");
    await expect(enable).toBeEnabled();
    // L2: closing and reopening the dialog starts fresh.
    await children.fill("1e");
    await page.keyboard.press("Escape");
    await expect(enable).toHaveCount(0);
    await open();
    await expect(page.getByLabel("Concurrent Children", { exact: true })).toHaveValue("");
    await expect(invalidNotice(page)).toHaveCount(0);
  });

  test("Defaults: an entry survives unmounting, Discard after unmounting leaves a clean editor, and Save takes the typed text", async ({ page }) => {
    await page.goto("/settings-rows-e2e.html?section=orchestrator&fullControlFixture=1&theme=light");
    const save = page.getByRole("button", { name: "Save Defaults", exact: true });
    const cost = page.locator("#orchestrator-campaign-cost");
    const children = page.locator("#orchestrator-max-children");
    await page.getByRole("radio", { name: "Full Control", exact: true }).click();
    // L1: the saved values, or empty, with no error.
    await expect(cost).toHaveValue("");
    await expect(children).toHaveValue("4");
    // L4 and L6: a lone `e` is an error, kept through blur.
    await cost.pressSequentially("e");
    await expect(cost).toHaveValue("e");
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await cost.press("Tab");
    await expect(save).toHaveAttribute("aria-disabled", "true");
    // L2: unmounting keeps the entry; Discard after unmounting leaves a clean editor.
    await page.getByRole("radio", { name: "Custom", exact: true }).click();
    await expect(cost).toHaveCount(0);
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("radio", { name: "Full Control", exact: true }).click();
    await expect(cost).toHaveValue("e");
    await page.getByRole("radio", { name: "Custom", exact: true }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator(".save-bar")).toHaveCount(0);
    await page.getByRole("radio", { name: "Full Control", exact: true }).click();
    await expect(cost).toHaveValue("");
    await expect(page.getByText(/Enter both a cost limit/)).toHaveCount(0);
    // L4 and L5 on the child limit: unreadable and empty are errors, never 0.
    await children.fill("");
    await children.pressSequentially("1e");
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await children.fill("");
    await expect(save).toHaveAttribute("aria-disabled", "true");
    // L8: Save takes exactly the typed text.
    await children.fill("6");
    await cost.fill("40");
    await page.locator("#orchestrator-campaign-tools").fill("400");
    await expect(save).not.toHaveAttribute("aria-disabled", "true");
    await save.click();
    await expect.poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.fullControlFixtureWrites ?? "[]").length)).toBe(1);
    const written = JSON.parse((await page.evaluate(() => JSON.parse(document.documentElement.dataset.fullControlFixtureWrites ?? "[]") as string[]))[0]!);
    expect(written.defaults.behavior.maximumConcurrentChildren).toBe(6);
    expect(written.defaults.campaignBudget).toEqual({ costUsd: 40, toolCalls: 400 });
    await expect(cost).toHaveValue("40");
  });
});
