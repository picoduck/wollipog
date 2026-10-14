import { expect, test } from "@playwright/test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS } from "@wollipog/protocol";
import { execFileSync } from "node:child_process";

const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const captures = `test-results/full-control-source-fixture-${sourceHead}`;

/** Exercise the real three surfaces on deterministic API/Session fixtures. These are visual and
 * launch-fencing checks only; they never attest live Full Control or evidence-provider readiness. */
for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 390, height: 844 }]) {
  for (const theme of ["dark", "light"]) {
    for (const surface of ["defaults", "launch", "campaign"] as const) {
      test(`${surface} ${viewport.name} ${theme}: Full Control remains an unsupported preview`, async ({ page }) => {
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
          await page.goto(`/new-session-choices-e2e.html?defaults=orchestrator&theme=${theme}`);
        } else {
          await page.goto(`/session-usage-e2e.html?width=${viewport.width}&height=${viewport.height}&composer=orchestrator`);
          await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
          await page.getByRole("button", { name: "Attach and Settings" }).click();
          await page.getByRole("menuitem", { name: "Orchestrator Controls…" }).click();
        }
        const full = page.getByRole("radio", { name: "Full Control", exact: true });
        await expect(full).toBeVisible();
        const group = page.getByRole("radiogroup", { name: "Orchestrator Control", exact: true });
        const controlHeading = page.getByRole("heading", { name: "Orchestrator Control", exact: true });
        await controlHeading.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
        const prefix = `${captures}/${surface}-${viewport.name}-${theme}`;
        await page.screenshot({ path: `${prefix}-custom.png` });
        await full.check();
        await expect(page.getByText("Activation Unavailable", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: surface === "launch" ? "Authorize and Create Session" : "Authorize Full Control", exact: true })).toBeDisabled();
        await expect(page.getByText(/Agent JSON, saved defaults, and this preview cannot grant authorization/)).toBeAttached();
        if (surface === "defaults") {
          await controlHeading.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await page.screenshot({ path: `${prefix}-draft-preference.png` });
          await page.getByRole("button", { name: "Save Defaults", exact: true }).click();
          await expect(full).toBeChecked();
          await expect.poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.fullControlFixtureWrites ?? "[]").length)).toBe(1);
          writes.push(...await page.evaluate(() => JSON.parse(document.documentElement.dataset.fullControlFixtureWrites ?? "[]") as string[]));
          expect(JSON.parse(writes[0]!).defaults.controlMode).toBe("full_control");
          expect(JSON.parse(writes[0]!).defaults.control).toBeUndefined();
        }
        if (surface === "launch") {
          await expect(page.getByRole("button", { name: "Create Session", exact: true })).toBeDisabled();
          await page.locator("form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
          await expect(page.getByRole("alert").filter({ hasText: "Full Control activation is unavailable" })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.dataset.createSessionCount)).toBeUndefined();
          await page.route("**/api/full-control-campaigns/preflight", async (route) => {
            const { session, proposal } = route.request().postDataJSON();
            await route.fulfill({ json: { preflight: { supported: false, digest: "a".repeat(64), proposal,
              plan: { ...session, config: { model: "source-fixture-model", effort: "high", permissionMode: "orchestrator" } },
              capabilities: [{ capability: "Complete Execution Enforcement", state: "unsupported", reason: "Complete current enforcement is not proven." },
                { capability: "Native Review and Usage", state: "unsupported", reason: "Native delivery and complete managed usage are not proven." },
                { capability: "Evidence Delivery and Quality", state: "unsupported", reason: "Actual media delivery and quality are not proven." }], humanRequired: [],
            } } });
          });
          const fields: Record<string, string> = { Repository: "example/full-control-fixture", "Issue Numbers": "12", Objective: "Review the source fixture",
            "Campaign Cost Limit (USD)": "20", "Campaign Tool Call Limit": "200", "Campaign Concurrency Limit": "2", "Maximum Authorized Issues": "10" };
          for (const [name, value] of Object.entries(fields)) await page.getByLabel(name, { exact: true }).fill(value);
          await page.getByRole("button", { name: "Check Full Control Preflight", exact: true }).click();
          await expect(page.getByText("Full Control Launch Blocked", { exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "Authorize and Create Session", exact: true })).toBeDisabled();
          await page.getByRole("heading", { name: "Exact Human Launch Proposal", exact: true }).evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await page.screenshot({ path: `${prefix}-blocked-proposal.png` });
        }
        await controlHeading.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
        await page.screenshot({ path: `${prefix}-preflight.png` });
        await page.getByRole("heading", { name: "Human Required and Unsupported Capabilities", exact: true })
          .evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
        // Finish the browser's paint following scroll/conditional layout, without recording delays.
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.screenshot({ path: `${prefix}-exceptions.png` });
        // Layout engines, rather than DOM mocks, prove labels/facts fit the phone and desktop.
        const overflow = await group.evaluate((node) => node.scrollWidth - node.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        expect(writes.length).toBe(surface === "defaults" ? 1 : 0);
        await page.getByRole("radio", { name: "Custom", exact: true }).check();
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
