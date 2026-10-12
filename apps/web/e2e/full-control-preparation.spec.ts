import { expect, test } from "@playwright/test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS } from "@wollipog/protocol";

/** Exercise the real three surfaces on deterministic API/Session fixtures. These are visual and
 * launch-fencing checks only; they never attest live Full Control or evidence-provider readiness. */
for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 390, height: 844 }]) {
  for (const theme of ["dark", "light"]) {
    for (const surface of ["defaults", "launch", "campaign"] as const) {
      test(`${surface} ${viewport.name} ${theme}: Full Control remains an unsupported preview`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const writes: string[] = [];
        await page.route("**/api/orchestrator-settings", async (route) => {
          if (route.request().method() !== "GET") writes.push(route.request().postData() ?? "");
          const defaults = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
          defaults.behavior.childHarness = null;
          defaults.behavior.childModel = null;
          defaults.behavior.childEffort = null;
          await route.fulfill({ json: { defaults, source: "system_default",
            capabilities: { harnesses: [], models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available" } } });
        });
        if (surface === "defaults") {
          await page.goto(`/settings-rows-e2e.html?section=orchestrator&theme=${theme}`);
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
        await group.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
        const prefix = `test-results/full-control-preparation/${surface}-${viewport.name}-${theme}`;
        await page.screenshot({ path: `${prefix}-custom.png` });
        await full.check();
        await expect(page.getByText("Activation Unavailable", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Authorize Full Control", exact: true })).toBeDisabled();
        await expect(page.getByText(/Agent JSON, saved defaults, and this preview cannot grant authorization/)).toBeAttached();
        if (surface === "defaults") await expect(page.getByRole("button", { name: "Save Defaults", exact: true })).toBeDisabled();
        if (surface === "launch") {
          await expect(page.getByRole("button", { name: "Create Session", exact: true })).toBeDisabled();
          await page.locator("form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
          await expect(page.getByRole("alert").filter({ hasText: "Full Control activation is unavailable" })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.dataset.createSessionCount)).toBeUndefined();
        }
        await group.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
        await page.screenshot({ path: `${prefix}-preflight.png` });
        await page.getByRole("heading", { name: "Human Required and Unsupported Capabilities", exact: true })
          .evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
        await page.screenshot({ path: `${prefix}-exceptions.png` });
        // Layout engines, rather than DOM mocks, prove labels/facts fit the phone and desktop.
        const overflow = await group.evaluate((node) => node.scrollWidth - node.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        expect(writes).toEqual([]);
        await page.getByRole("radio", { name: "Custom", exact: true }).check();
        await expect(page.getByText("Activation Unavailable", { exact: true })).toHaveCount(0);
      });
    }
  }
}
