import { expect, test } from "@playwright/test";
import { CONTROLLED_REVIEW_PROFILE, DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION,
  type FullControlLaunchRequest, type OrchestratorCampaignPolicy, type RunnerView } from "@wollipog/protocol";
import { execFileSync } from "node:child_process";
import { campaignLaunchPreflight } from "../../control-plane/src/campaign-launch-admission.js";

const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const captures = `test-results/full-control-source-fixture-${sourceHead}`;

/** The launch preview uses the server's own readiness evaluation, so every reason and the
 * retention disclosure the browser shows are the exact server-derived text. The two runner
 * fixtures differ only in what the runner reports: bwrap isolation without the controlled
 * reviewer (blocked), or provider isolation with the audited reviewer profile (ready). */
function serverPreflight(launch: FullControlLaunchRequest, ready: boolean) {
  const runner = { runnerId: "runner-1", connectedAt: 1, protocolVersion: PROTOCOL_VERSION, agents: [], workspaces: [],
    runtime: { dataDir: "/fixture", worktreeRoot: "/fixture/worktrees", maxConcurrentSessions: 4, campaignLaunchInspection: { version: 2 },
      executionIsolation: ready ? { mode: "provider", network: "inherit" } : { mode: "bwrap", network: "deny" },
      ...(ready ? { campaignReview: { profile: CONTROLLED_REVIEW_PROFILE, controllerSha256: "c".repeat(64), executableSha256: "e".repeat(64),
        cliVersion: "2.1.296", accounting: "provider_list_estimate", account: "runner_default_claude", agentId: "claude" } } : {}) },
  } as unknown as RunnerView;
  const policy = { ...structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS), version: 1 } as unknown as OrchestratorCampaignPolicy;
  const plan = { runnerId: "runner-1", workspaceId: launch.workspaceId, agentId: "claude", driver: "claude-code" as const,
    config: { model: "source-fixture-model", effort: "high", permissionMode: "orchestrator" }, useWorktree: true,
    executionTarget: { adapter: "host" as const }, policy, scope: { organizationId: "org", owner: { kind: "user" as const, userId: "user" } } };
  const issueNumbers = [...(launch.issueNumbers ?? [])].sort((a, b) => a - b);
  return campaignLaunchPreflight({ request: launch, plan: plan as never, runner, organizationId: "org", projectDefaults: null,
    inspection: { type: "campaign_launch_inspection_result", requestId: "fixture", workspaceId: launch.workspaceId, ok: true,
      repository: "example/full-control-fixture", issueNumbers, digest: "d".repeat(64) },
    accountingError: null, dailyLimit: false, invalidPolicyIds: [], imageReview: { effectiveOwner: "orchestrator" },
    pacedVideoPeer: false, disclosuresAvailable: true }).preflight;
}

/** Exercise the real three surfaces on deterministic API/Session fixtures. These are visual and
 * launch-fencing checks only; they never attest live Full Control or evidence-provider readiness. */
for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 390, height: 844 }]) {
  for (const theme of ["dark", "light"]) {
    for (const surface of ["defaults", "launch", "campaign"] as const) {
      test(`${surface} ${viewport.name} ${theme}: ${surface === "launch" ? "Full Control launches only from a ready server preflight" : "Full Control remains an unsupported preview"}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const writes: string[] = [];
        let savedDefaults = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
        if (surface !== "defaults") await page.route("**/api/orchestrator-settings", async (route) => {
          if (route.request().method() !== "GET") {
            writes.push(route.request().postData() ?? "");
            savedDefaults = route.request().postDataJSON().defaults;
          }
          const defaults = structuredClone(savedDefaults);
          defaults.behavior.childHarness = null;
          defaults.behavior.childModel = null;
          defaults.behavior.childEffort = null;
          await route.fulfill({ json: { defaults, source: "system_default", controlModeSupported: true,
            capabilities: { harnesses: [{ agentId: "claude", driver: "claude-code", context: { kind: "native" },
              name: "Source Fixture Harness", models: [{ id: "source-fixture-model", efforts: ["high"] }], effortLevels: ["high"],
              supportedPairs: [{ modelId: "source-fixture-model", effortLevels: ["high"] }], installations: 1 }],
              models: [{ id: "source-fixture-model", efforts: ["high"] }], effortLevels: ["high"],
              installations: 1, compatibleInstallations: 1, status: "available" } } });
        });
        if (surface === "defaults") {
          await page.goto(`/settings-rows-e2e.html?section=orchestrator&fullControlFixture=1&theme=${theme}`);
        } else if (surface === "launch") {
          await page.goto(`/new-session-choices-e2e.html?defaults=orchestrator&openedView=1&theme=${theme}`);
        } else {
          await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height}&composer=orchestrator`);
          await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
          await page.getByRole("button", { name: "Attach and Settings" }).click();
          await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
        }
        const full = page.getByRole("radio", { name: "Full Control", exact: true });
        await expect(full).toBeVisible();
        const group = page.getByRole("radiogroup", { name: "Orchestrator Control", exact: true });
        const controlAnchor = surface === "defaults" ? group : page.getByRole("heading", { name: "Orchestrator Control", exact: true });
        await controlAnchor.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
        const prefix = `${captures}/${surface}-${viewport.name}-${theme}`;
        await page.screenshot({ path: `${prefix}-custom.png` });
        await full.click();
        await expect(full).toBeChecked();
        await expect(page.getByText("Activation Unavailable", { exact: true })).toHaveCount(surface === "launch" ? 0 : 1);
        await expect(page.getByRole("button", { name: surface === "launch" ? "Authorize and Create Session" : "Authorize Full Control", exact: true })).toBeDisabled();
        await expect(page.getByText(/Agent JSON, saved defaults, and this preview cannot grant authorization/)).toBeAttached();
        if (surface === "defaults") {
          await controlAnchor.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await page.screenshot({ path: `${prefix}-draft-preference.png` });
          await page.getByRole("button", { name: "Save Defaults", exact: true }).click();
          await expect(full).toBeChecked();
          await expect.poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.fullControlFixtureWrites ?? "[]").length)).toBe(1);
          writes.push(...await page.evaluate(() => JSON.parse(document.documentElement.dataset.fullControlFixtureWrites ?? "[]") as string[]));
          expect(JSON.parse(writes[0]!).defaults.controlMode).toBe("full_control");
          expect(JSON.parse(writes[0]!).defaults.control).toBeUndefined();
        }
        const settle = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        if (surface === "launch") {
          await expect(page.getByRole("button", { name: "Create Session", exact: true })).toBeDisabled();
          await page.locator("form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
          await expect(page.getByRole("alert").filter({ hasText: "Check the Full Control preflight, then use Authorize and Create Session" })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.dataset.createSessionCount)).toBeUndefined();
          let runnerReady = false;
          const admissions: Array<Record<string, unknown>> = [];
          await page.route("**/api/full-control-campaigns/preflight", async (route) => {
            const launch = route.request().postDataJSON() as FullControlLaunchRequest;
            expect((launch as unknown as Record<string, unknown>).repository).toBeUndefined();
            await route.fulfill({ json: { preflight: serverPreflight(launch, runnerReady) } });
          });
          await page.route("**/api/full-control-campaigns", async (route) => {
            admissions.push(route.request().postDataJSON());
            await route.fulfill({ status: 201, json: { id: "session-full-control" } });
          });
          const fields: Record<string, string> = { "Issue Numbers": "12", Objective: "Review the source fixture",
            "Campaign Cost Limit (USD)": "20", "Campaign Tool Call Limit": "200", "Campaign Concurrency Limit": "2", "Maximum Authorized Issues": "10" };
          for (const [name, value] of Object.entries(fields)) await page.getByLabel(name, { exact: true }).fill(value);
          const check = page.getByRole("button", { name: "Check Full Control Preflight", exact: true });
          const authorizer = page.getByRole("button", { name: "Authorize and Create Session", exact: true });
          await check.click();
          const blocked = page.getByText("Full Control Launch Blocked", { exact: true });
          await expect(blocked).toBeVisible();
          await expect(authorizer).toBeDisabled();
          await page.getByRole("heading", { name: "Exact Human Launch Proposal", exact: true }).evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
          await settle();
          await page.screenshot({ path: `${prefix}-blocked-proposal.png` });
          await blocked.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
          await expect(page.getByText(/Controlled Cross-Model Review \(Blocks Launch\): This runner does not advertise the controlled native reviewer\. It needs executionIsolation\.mode "provider" \(current: bwrap\)/)).toBeInViewport();
          await expect(page.getByText("Full Control activation is unavailable", { exact: false })).toHaveCount(0);
          await settle();
          await page.screenshot({ path: `${prefix}-blocked-preflight.png` });

          // The operator configures provider isolation and the audited reviewer; the same proposal is now ready.
          runnerReady = true;
          await check.click();
          const ready = page.getByText("Ready for Exact Human Authorization", { exact: true });
          await expect(ready).toBeVisible();
          await expect(authorizer).toBeEnabled();
          await ready.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
          await expect(page.getByText("Blocks Launch", { exact: false })).toHaveCount(0);
          await expect(page.getByText("The Orchestrator reviews screenshots. Video and external evidence need your review.", { exact: true })).toBeVisible();
          await expect(page.getByText(/Wollipog does not configure zero retention/)).toBeVisible();
          await settle();
          await page.screenshot({ path: `${prefix}-ready-preflight.png` });
          await authorizer.scrollIntoViewIfNeeded();
          await settle();
          await page.screenshot({ path: `${prefix}-ready-authorize.png` });
          expect(await group.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
          await authorizer.click();
          await expect.poll(() => admissions.length).toBe(1);
          const reviewed = serverPreflight(admissions[0] as unknown as FullControlLaunchRequest, true);
          expect(admissions[0]!.preflightDigest).toBe(reviewed.digest);
          expect(admissions[0]!.requestId).toMatch(/^[a-f0-9]{32}$/);
          await expect(page.getByRole("status").filter({ hasText: "session-full-control" })).toBeVisible();
          await settle();
          await page.screenshot({ path: `${prefix}-authorized.png` });
          return;
        } else {
          await controlAnchor.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
          await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
          await page.screenshot({ path: `${prefix}-preflight.png` });
          await page.getByRole("heading", { name: "Human Required and Unsupported Capabilities", exact: true })
            .evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
          await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
          // Finish the browser's paint following scroll/conditional layout, without recording delays.
          await settle();
          await page.screenshot({ path: `${prefix}-exceptions.png` });
        }
        // Layout engines, rather than DOM mocks, prove labels/facts fit the phone and desktop.
        const overflow = await group.evaluate((node) => node.scrollWidth - node.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        expect(writes.length).toBe(surface === "defaults" ? 1 : 0);
        await page.getByRole("radio", { name: "Custom", exact: true }).click();
        await expect(page.getByRole("radio", { name: "Custom", exact: true })).toBeChecked();
        await expect(page.getByText("Activation Unavailable", { exact: true })).toHaveCount(0);
      });
    }
  }
}

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 390, height: 844 }]) {
  for (const theme of ["dark", "light"]) test(`root revoke ${viewport.name} ${theme}: fixture revision advances without changing defaults`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/session-usage-e2e.html?composer=orchestrator&fullControlFixture=1`);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.getByRole("button", { name: "Attach and Settings" }).click();
    await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
    const heading = page.getByRole("heading", { name: "Orchestrator Control", exact: true });
    await expect(page.getByText(/Effective Mode: Full Control/)).toBeVisible();
    await heading.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
    await page.screenshot({ path: `${captures}/revoke-${viewport.name}-${theme}-full.png` });
    await page.getByRole("button", { name: "Revoke Full Control", exact: true }).click();
    await expect(page.getByText(/Effective Mode: Custom/)).toBeVisible();
    await heading.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: `${captures}/revoke-${viewport.name}-${theme}-custom.png` });
  });
  for (const theme of ["dark", "light"]) test(`legacy descendant ${viewport.name} ${theme}: unknown root state cannot imply Full authority`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/session-usage-e2e.html?composer=orchestrator&fullControlFixture=legacy`);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.getByRole("button", { name: "Attach and Settings" }).click();
    await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
    await expect(page.getByText(/Effective Mode: Current Root State Not Reported/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke Full Control", exact: true })).toHaveCount(0);
    await page.getByRole("heading", { name: "Orchestrator Control", exact: true }).evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: `${captures}/legacy-${viewport.name}-${theme}-unknown.png` });
  });
}
