import { expect, test } from "@playwright/test";
import { join } from "node:path";

for (const width of [1440, 390]) for (const theme of ["dark", "light"]) {
  test(`scheduled campaign settings and recurring child tasks survive editing at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const route = `/automations/~${Buffer.from("automation-nightly-sweep", "utf16le").toString("base64url")}/edit`;
    await page.goto(`/automations-e2e.html?campaign&theme=${theme}&route=${encodeURIComponent(route)}`);
    await expect(page.getByRole("heading", { name: /^Edit Nightly/ })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Campaign Repository" })).toHaveValue("example/project");
    await expect(page.getByRole("button", { name: "Session Role" })).toContainText("Orchestrator");
    await expect(page.getByRole("textbox", { name: "Task Title" }).first()).toHaveValue("Maintenance Review");
    const summary = page.locator(".field").filter({ has: page.locator(".field-label", { hasText: /^Orchestrator Policy$/ }) });
    expect((await summary.boundingBox())!.width).toBeGreaterThan(width === 390 ? 300 : 400);
    await page.getByRole("button", { name: "Customize…" }).click();
    const dialog = page.getByRole("dialog", { name: "Orchestrator Policy" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Child Model:/ })).toContainText("Child Model");
    if (process.env.WOLLIPOG_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.WOLLIPOG_EVIDENCE_DIR, `campaign-policy-${width}-${theme}.png`) });
    await dialog.getByRole("button", { name: "Apply Policy" }).click();
    await page.getByRole("textbox", { name: "Task Prompt" }).first().fill("Investigate stale flags, deduplicate findings, and report recommendations.");
    await page.getByRole("button", { name: "Add Child Task", exact: true }).click();
    await page.getByRole("textbox", { name: "Task Title" }).last().fill("Documentation Review");
    await page.getByRole("textbox", { name: "Task Prompt" }).last().fill("Find outdated public documentation.");
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { savedCampaignAutomation?: unknown }).savedCampaignAutomation)).toMatchObject({
      action: { kind: "create_session", request: { role: "orchestrator", config: { model: "parent-model", effort: "high" },
        orchestrator: { behavior: { childModel: "child-model", childEffort: "high", childHarness: { driver: "codex-app-server" } } },
        campaign: { controlMode: "full_control", repository: "example/project", tasks: [
          { key: "maintenance", title: "Maintenance Review", prompt: "Investigate stale flags, deduplicate findings, and report recommendations." },
          { key: "coverage", title: "Coverage Review" }, { title: "Documentation Review" },
        ] },
      } },
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
