import { expect, test, type Locator, type Page } from "@playwright/test";
import { CONTROLLED_REVIEW_PROFILE, DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION,
  type FullControlLaunchRequest, type OrchestratorCampaignPolicy, type RunnerView } from "@wollipog/protocol";
import { execFileSync } from "node:child_process";
import { campaignLaunchPreflight } from "../../control-plane/src/campaign-launch-admission.js";

const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const captures = `test-results/full-control-source-fixture-${sourceHead}`;
const viewports = [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 390, height: 844 }];
const themes = ["dark", "light"];

/** The server's own readiness evaluation, so every blocker the browser shows is the exact
 * server-derived text. The runner fixtures differ only in what the runner reports: bwrap isolation
 * without the controlled reviewer, or provider isolation with the audited reviewer profile, and
 * whether its origin verified. Enabling an existing campaign uses its own Human-established scope. */
function serverPreflight(launch: FullControlLaunchRequest, runnerReady: boolean, existingCampaign = false, storedChildren = 3, verified = true) {
  const runner = { runnerId: "runner-1", connectedAt: 1, protocolVersion: PROTOCOL_VERSION, agents: [], workspaces: [],
    runtime: { dataDir: "/fixture", worktreeRoot: "/fixture/worktrees", maxConcurrentSessions: 4, campaignLaunchInspection: { version: 2 },
      executionIsolation: runnerReady ? { mode: "provider", network: "inherit" } : { mode: "bwrap", network: "deny" },
      ...(runnerReady ? { campaignReview: { profile: CONTROLLED_REVIEW_PROFILE, controllerSha256: "c".repeat(64), executableSha256: "e".repeat(64),
        cliVersion: "2.1.296", accounting: "provider_list_estimate", account: "runner_default_claude", agentId: "claude" } } : {}) },
  } as unknown as RunnerView;
  const policy = { ...structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS), version: 1 } as unknown as OrchestratorCampaignPolicy;
  // The server resolves the session's behavior overrides into the plan it evaluates.
  const children = launch.overrides?.session?.orchestrator?.behavior?.maximumConcurrentChildren;
  if (children !== undefined) policy.behavior.maximumConcurrentChildren = children;
  // Enabling evaluates the campaign's stored policy: the session fixture stores 3 unless told otherwise.
  if (existingCampaign) policy.behavior.maximumConcurrentChildren = storedChildren;
  const plan = { runnerId: "runner-1", workspaceId: launch.workspaceId, agentId: "claude", driver: "claude-code" as const,
    config: { model: "source-fixture-model", effort: "high", permissionMode: "orchestrator" }, useWorktree: true,
    executionTarget: { adapter: "host" as const }, policy, scope: { organizationId: "org", owner: { kind: "user" as const, userId: "user" } } };
  const issueNumbers = [...(launch.issueNumbers ?? [])].sort((a, b) => a - b);
  return campaignLaunchPreflight({ request: launch, plan: plan as never, runner, organizationId: "org", projectDefaults: null,
    ...(existingCampaign
      ? { campaignScope: { repository: "example/full-control-fixture", issueNumbers: [12], authorizedByCaller: true } }
      : { inspection: verified ? { type: "campaign_launch_inspection_result" as const, requestId: "fixture", workspaceId: launch.workspaceId, ok: true,
        repository: "example/full-control-fixture", issueNumbers, digest: "d".repeat(64) }
        : { type: "campaign_launch_inspection_result" as const, requestId: "fixture", workspaceId: launch.workspaceId, ok: false } }),
    accountingError: () => null, dailyLimit: false, invalidPolicyIds: [], imageReview: { effectiveOwner: "orchestrator" }, humanRequiredRules: false,
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
/** Under Full Control the dialog shows only its mode, its line and its action (#2940): the boundary
 * owns every gate, so no Custom owner, request choice or evidence note is shown. Once Full Control is
 * in effect Campaign Behavior stays, since it governs every child the campaign creates (#3580). */
async function expectFullControlOnly(page: Page, { inEffect }: { inEffect: boolean }) {
  const dialog = page.getByRole("dialog", { name: "Orchestrator Controls" });
  await expect(dialog.locator(".section-title")).toHaveText(inEffect ? ["Orchestrator Control", "Campaign Behavior"] : ["Orchestrator Control"]);
  await expect(dialog.getByRole("radiogroup", { name: "PR Merge Approval", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("radiogroup", { name: "Child Session Requests", exact: true })).toHaveCount(0);
  await expect(dialog.getByText("The Orchestrator runs this campaign end to end.").first()).toBeVisible();
}

async function shoot(page: Page, anchor: Locator, path: string) {
  // The pointer is left wherever the last action put it. Scrolling slides other controls under it,
  // and their hover transitions start and are cancelled while `settle` waits on them, so the capture
  // depended on which control happened to land there. A capture shows no hover.
  await page.mouse.move(0, 0);
  await anchor.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
  await settle(page);
  await page.screenshot({ path });
}

/** Deterministic API/Session fixtures for the three surfaces. These are visual and launch-fencing
 * checks only; they never attest live Full Control or evidence-provider readiness. */
/** New Session's Options (#2954): the Orchestrator policy sits under Role, inside Options. */
async function openSessionOptions(page: Page): Promise<void> {
  const head = page.getByRole("button", { name: "Options", exact: true });
  await expect(head).toBeVisible();
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
}

/** Orchestrator Policy (#2955): Customize… opens it over New Session; `edit` changes it on `tab`,
 * and Apply Policy returns the change. Full Control is chosen on its Decisions tab. */
async function editSessionPolicy(page: Page, tab: "Behavior" | "Decisions", edit: (policy: Locator) => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "Customize…" }).click();
  const policy = page.getByRole("dialog", { name: "Orchestrator Policy" });
  await policy.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
  await edit(policy);
  await policy.getByRole("button", { name: "Apply Policy" }).click();
  await expect(policy).toHaveCount(0);
}

/** Full Control adds nothing to fill in or review (#2940): no task, issues, limits, readiness or summary. */
async function expectNoFullControlForm(page: Page) {
  for (const label of ["Task", "Issue Numbers", "Cost Limit (USD)", "Tool Call Limit", "Follow-Ups Without Approval", "Maximum Issues"]) {
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  }
  for (const copy of [/Authorize and Start/, /Describe the task/, /Ready to (?:Authorize|Enable)/, /Can't (?:Start|Enable) Yet/, /Campaign Limits/, /No Limit/]) {
    await expect(page.getByText(copy)).toHaveCount(0);
  }
  await expect(page.locator("[role=\"dialog\"] textarea")).toHaveCount(0);
  await expect(page.locator("summary").filter({ hasText: "Advanced" })).toHaveCount(0);
}

const FULL_CONTROL_LINE = "The Orchestrator runs this campaign end to end.";

for (const viewport of viewports) {
  for (const theme of themes) {
    test(`launch ${viewport.name} ${theme}: Full Control starts like any Orchestrator, and the first message is the task`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const prefix = `${captures}/launch-${viewport.name}-${theme}`;
      await routeSettings(page, []);
      const preflights: FullControlLaunchRequest[] = [];
      const admissions: Array<Record<string, unknown>> = [];
      await page.route("**/api/full-control-campaigns/preflight", async (route) => {
        const launch = route.request().postDataJSON() as FullControlLaunchRequest;
        preflights.push(launch);
        await route.fulfill({ json: { preflight: serverPreflight(launch, true) } });
      });
      let releaseAdmission: () => void = () => undefined;
      const admitted = new Promise<void>((resolve) => { releaseAdmission = resolve; });
      await page.route("**/api/full-control-campaigns", async (route) => {
        admissions.push(route.request().postDataJSON());
        await admitted;
        await route.fulfill({ status: 201, json: { id: "session-full-control" } });
      });
      await page.goto(`/new-session-choices-e2e.html?defaults=orchestrator&openedView=1&theme=${theme}`);
      await openSessionOptions(page);
      const control = page.locator(".orchestrator-policy-summary");
      const start = page.getByRole("button", { name: "Create Session", exact: true });
      // Custom, for comparison: the same row and the same action.
      await expect(control).not.toContainText(FULL_CONTROL_LINE);
      await expect(start).toBeEnabled();
      await shoot(page, control, `${prefix}-custom.png`);
      await editSessionPolicy(page, "Decisions", async (policy) => {
        const choice = policy.getByRole("radiogroup", { name: "Orchestrator Control" });
        await expect(policy.getByRole("radiogroup", { name: "PR Merge Approval" })).toBeVisible();
        await choice.getByRole("radio", { name: "Full Control", exact: true }).click();
        await expect(policy.getByText(FULL_CONTROL_LINE).first()).toBeVisible();
        // The boundary owns every gate: Customize… shows no Custom owner under Full Control.
        await expect(policy.getByRole("radiogroup", { name: "PR Merge Approval" })).toHaveCount(0);
        await expect(policy.getByText("Who Decides at Each Gate", { exact: true })).toHaveCount(0);
        await expect(policy.getByText("Descendant Requests", { exact: true })).toHaveCount(0);
        await shoot(page, choice, `${prefix}-policy.png`);
      });
      await expect(control).toContainText("Full Control");
      await expect(control).toContainText(FULL_CONTROL_LINE);
      await expectNoFullControlForm(page);
      await expect(start).toBeEnabled();
      expect(preflights, "nothing is checked or shown before Start").toHaveLength(0);
      await shoot(page, control, `${prefix}-full-control.png`);

      await start.click();
      await expect(start).toHaveAttribute("aria-busy", "true");
      // The busy spinner animates until the admission answers, so wait for paint rather than for it.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.screenshot({ path: `${prefix}-starting.png` });
      releaseAdmission();
      await expect(page.getByRole("status").filter({ hasText: "session-full-control" })).toBeVisible();
      expect(preflights).toHaveLength(1);
      expect(preflights[0]!.task).toBeUndefined();
      expect(preflights[0]!.issueNumbers).toBeUndefined();
      expect(preflights[0]!.overrides!.budget).toBeUndefined();
      expect(admissions).toHaveLength(1);
      expect(admissions[0]!.preflightDigest).toBe(serverPreflight(admissions[0] as unknown as FullControlLaunchRequest, true).digest);
      expect(admissions[0]!.requestId).toMatch(/^[a-f0-9]{32}$/);
    });

    test(`launch blocked ${viewport.name} ${theme}: a genuine impossibility is one inline error where launch errors appear`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await routeSettings(page, []);
      const admissions: unknown[] = [];
      await page.route("**/api/full-control-campaigns/preflight", async (route) => {
        await route.fulfill({ json: { preflight: serverPreflight(route.request().postDataJSON() as FullControlLaunchRequest, true, false, 3, false) } });
      });
      await page.route("**/api/full-control-campaigns", async (route) => {
        admissions.push(route.request().postDataJSON());
        await route.fulfill({ status: 201, json: { id: "never" } });
      });
      await page.goto(`/new-session-choices-e2e.html?defaults=orchestrator&openedView=1&theme=${theme}`);
      await openSessionOptions(page);
      await editSessionPolicy(page, "Decisions", (policy) =>
        policy.getByRole("radiogroup", { name: "Orchestrator Control" }).getByRole("radio", { name: "Full Control", exact: true }).click());
      await page.getByRole("button", { name: "Create Session", exact: true }).click();
      const alert = page.getByRole("alert").filter({ hasText: "Couldn't Start the Session" });
      await expect(alert).toHaveCount(1);
      await expect(alert).toContainText("The registered workspace's origin could not be verified; check that it is a github.com repository.");
      await expectNoFullControlForm(page);
      expect(admissions).toHaveLength(0);
      await shoot(page, alert, `${captures}/launch-${viewport.name}-${theme}-blocked.png`);
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
      const bodies: unknown[] = [];
      await page.route("**/orchestrator-campaign/full-control/preflight", async (route) => {
        bodies.push(route.request().postDataJSON());
        await route.fulfill({ json: { preflight: serverPreflight({ runnerId: "runner-1", workspaceId: "w", task: "Review the source fixture" },
          true, true), expectedRevision: 3 } });
      });
      await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height}&composer=orchestrator&fullControlFixture=enable`);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.getByRole("button", { name: "Attach and Settings" }).click();
      await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
      const heading = page.getByRole("heading", { name: "Orchestrator Control", exact: true });
      await expect(page.getByText(/Effective Mode: Custom/)).toBeVisible();
      await page.getByRole("radio", { name: "Full Control", exact: true }).click();
      await expect(page.getByText(FULL_CONTROL_LINE)).toBeVisible();
      await expectNoFullControlForm(page);
      await expectFullControlOnly(page, { inEffect: false });
      const enable = page.getByRole("button", { name: "Enable Full Control", exact: true });
      const footer = page.locator(".modal-foot");
      await expect(footer.getByRole("button")).toHaveText(["Done", "Enable Full Control"]);
      await expect(enable).toBeEnabled();
      await expect(enable).toBeInViewport();
      expect(bodies, "nothing is checked or shown before the action").toHaveLength(0);
      await shoot(page, heading, `${prefix}-enable.png`);
      await enable.click();
      await expect(page.getByText(/Effective Mode: Full Control/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Revoke Full Control", exact: true })).toBeVisible();
      await expectFullControlOnly(page, { inEffect: true });
      await expect(footer.getByRole("button")).toHaveText(["Done"]);
      await shoot(page, heading, `${prefix}-enabled.png`);
      expect(bodies).toEqual([{}]);
    });

    test(`paused campaign ${viewport.name} ${theme}: a campaign that admits no children says why it can't enable`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await routeSettings(page, []);
      await page.route("**/orchestrator-campaign/full-control/preflight", async (route) => {
        await route.fulfill({ json: { preflight: serverPreflight({ runnerId: "runner-1", workspaceId: "w", task: "Review the source fixture" },
          true, true, 0), expectedRevision: 3 } });
      });
      await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height}&composer=orchestrator&fullControlFixture=enable&maxChildren=0`);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.getByRole("button", { name: "Attach and Settings" }).click();
      await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
      await page.getByRole("radio", { name: "Full Control", exact: true }).click();
      const enable = page.getByRole("button", { name: "Enable Full Control", exact: true });
      await enable.click();
      const alert = page.getByRole("alert").filter({ hasText: "Couldn't Enable Full Control" });
      await expect(alert).toContainText("This campaign pauses new children; raise Live Child Limit in Guardrails to enable Full Control.");
      await expect(page.getByText(/Effective Mode: Custom/)).toBeVisible();
      await expectNoFullControlForm(page);
      await expectFullControlOnly(page, { inEffect: false });
      await expect(enable).toBeInViewport();
      await shoot(page, alert, `${captures}/paused-${viewport.name}-${theme}-blocked.png`);
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
    await expectFullControlOnly(page, { inEffect: true });
    await shoot(page, heading, `${captures}/revoke-${viewport.name}-${theme}-full.png`);
    await page.getByRole("button", { name: "Revoke Full Control", exact: true }).click();
    await expect(page.getByText(/Effective Mode: Custom/)).toBeVisible();
    // Custom again: the per-gate and Child Session Requests choices are editable once more.
    await expect(page.getByRole("radiogroup", { name: "PR Merge Approval", exact: true })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Child Session Requests", exact: true })).toBeVisible();
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
    // Nothing editable until the root's control is known; the server's effective owners, read-only.
    const dialog = page.getByRole("dialog", { name: "Orchestrator Controls" });
    await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
    await expect(dialog.getByText("The root campaign's control isn't reported. Who answers these isn't known here, so they can't be changed until it is.")).toBeVisible();
    const fact = (term: string) => dialog.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
    await expect(fact("PR Merge Approval")).toHaveText("Orchestrator");
    await expect(fact("Merged Branch Deletion")).toHaveText("HumanSet by the root campaign.");
    await expect(fact("UI Evidence Approval")).toHaveText(/^Human.*does not accept image input\.$/);
    await shoot(page, page.getByRole("heading", { name: "Orchestrator Control", exact: true }), `${captures}/legacy-${viewport.name}-${theme}-unknown.png`);
    await shoot(page, dialog.getByRole("heading", { name: "Workflow Decisions", exact: true }), `${captures}/legacy-${viewport.name}-${theme}-owners.png`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Attach and Settings" }).click();
    await expect(page.getByRole("menuitem", { name: "Orchestrator Controls…" })).toHaveAccessibleDescription("4 of 6 decisions stay with a person.");
  });
  for (const theme of themes) test(`routed owner ${viewport.name} ${theme}: summaries count the server's effective owners`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height}&composer=orchestrator&owners=routed${viewport.name === "desktop" ? "&pinned=1" : ""}`);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    // Saved: two gates delegated plus UI Evidence Approval; effective: that one goes to a person here.
    const effective = "4 of 6 decisions stay with a person.";
    if (viewport.name === "desktop") {
      const summary = page.locator('aside.ps[aria-label="Pinned Summary"]');
      await expect(summary.getByRole("button", { name: /^Workflow Decisions/ })).toContainText(effective);
      await settle(page);
      await summary.screenshot({ path: `${captures}/routed-${viewport.name}-${theme}-pinned-summary.png` });
    }
    await page.getByRole("button", { name: "Attach and Settings" }).click();
    const row = page.getByRole("menuitem", { name: "Orchestrator Controls…" });
    await expect(row).toHaveAccessibleDescription(effective);
    await settle(page);
    await page.screenshot({ path: `${captures}/routed-${viewport.name}-${theme}-plus-menu.png` });
    await row.click();
    const dialog = page.getByRole("dialog", { name: "Orchestrator Controls" });
    // Custom keeps the saved choice editable and says where it goes instead.
    await expect(dialog.getByRole("radiogroup", { name: "UI Evidence Approval" }).getByRole("radio", { name: "Orchestrator" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText(/Goes to a person here: The Orchestrator model "text-only" does not accept image input\./)).toBeVisible();
    await shoot(page, dialog.getByRole("radiogroup", { name: "UI Evidence Approval" }), `${captures}/routed-${viewport.name}-${theme}-gate.png`);
  });
}

/** The limit-entry lifecycle (L1-L8 in the review brief), typed for real in the browser. Saved
 * Full Control defaults are the only limit entry left (#2940); its typed text is its only state. */
test.describe("limit entry lifecycle", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

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
