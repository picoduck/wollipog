import { expect, test } from "@playwright/test";
import { automationApprovalExpiration } from "./fixtures/automation-approval-expiration.js";

test.use({ video: process.env.AUTOMATION_EXPIRATION_CAPTURE === "1" ? "on" : "off" });

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`expired automation approval releases role conversion at ${width}px ${theme}`, async ({ page }, info) => {
    const h = automationApprovalExpiration();
    const capture = process.env.AUTOMATION_EXPIRATION_CAPTURE === "1";
    try {
      await page.route("**/api/sessions/same-session/role**", async (route) => {
        const request = route.request();
        if (request.method() === "GET") {
          const role = new URL(request.url()).searchParams.get("role") === "normal" ? "normal" : "orchestrator";
          return route.fulfill({ json: h.conversions.preview("same-session", role, h.defaults, () => null) });
        }
        const body = request.postDataJSON();
        await h.conversions.change("same-session", body.role, body.expectedRole, h.defaults, () => null, body.orchestrator);
        return route.fulfill({ json: h.db.getSession("same-session") });
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/session-role-e2e.html?scenario=approval-expiration&theme=${theme}`);
      const open = async () => {
        await page.getByRole("button", { name: "More Actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Change Session Role…", exact: true }).click();
        return page.getByRole("dialog", { name: "Change Session Role", exact: true });
      };
      const blocked = await open();
      await expect(blocked).toContainText("Resolve or dismiss pending requests and unconsumed decisions");
      await expect(blocked.getByRole("button", { name: "Change to Orchestrator", exact: true })).toBeDisabled();
      if (capture) {
        await page.waitForTimeout(3000);
        await page.screenshot({ path: info.outputPath("before-expiration.png") });
      }
      await blocked.getByRole("button", { name: "Cancel", exact: true }).click();
      h.expire();
      const available = await open();
      await expect(available.getByRole("button", { name: "Change to Orchestrator", exact: true })).toBeEnabled();
      expect(h.db.workflowDecisionByOccurrence(h.decision.occurrenceId)!.status).toBe("revoked");
      if (capture) {
        await page.waitForTimeout(3000);
        await page.screenshot({ path: info.outputPath("after-expiration.png") });
      }
      await available.getByRole("button", { name: "Change to Orchestrator", exact: true }).click();
      await expect(page.getByTestId("session-role")).toHaveText("Orchestrator");
      if (capture) await page.waitForTimeout(3000);
      expect(h.db.listAutomations()).toHaveLength(0);
    } finally { h.db.close(); }
  });
}
