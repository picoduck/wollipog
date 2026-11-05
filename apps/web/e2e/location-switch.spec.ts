import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

for (const width of [1440, 390]) {
  test(`a Location switch names both repositories and sends only the person's choice at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/request-surfaces-e2e.html?scenario=location-switch&unavailable=1");
    const details = page.getByRole("region", { name: "Location Switch Details" });
    await expect(details).toContainText("This task belongs to repository acme/docs. This session is currently in repository acme/app.");
    for (const text of ["Current Location", "App", "/home/dev/src/app", "Proposed Location", "Docs Site", "/home/dev/src/docs",
      "Docs Mirror on Build Server: The Location's machine is offline."]) await expect(details).toContainText(text);
    const foot = page.locator(".request-dock .request-card-foot");
    await expect(foot.getByRole("button", { name: "Stay Here", exact: true })).toBeVisible();
    await expect(foot.getByRole("button", { name: "Start a New Session", exact: true })).toBeVisible();
    if (evidenceDir) {
      await page.screenshot({ path: join(evidenceDir, `location-switch-one-${width}.png`), fullPage: true });
      // A tall window gives the docked card room to show its whole body in one capture.
      await page.setViewportSize({ width, height: 1900 });
      await page.screenshot({ path: join(evidenceDir, `location-switch-one-tall-${width}.png`), fullPage: true });
    }
    await foot.getByRole("button", { name: "Stay Here", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([
      { requestId: "evidence-occurrence", optionId: "__workflow_deny__" },
    ]);
  });

  test(`several matching Locations are chosen from, and Start a New Session uses the chosen one at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/request-surfaces-e2e.html?scenario=location-switch&locations=2");
    const choices = page.getByRole("radiogroup", { name: "Choose a Location" });
    await expect(choices.getByRole("radio")).toHaveCount(2);
    await expect(choices.getByRole("radio", { name: /Docs Site This Machine/ })).toBeChecked();
    await choices.getByText("Docs Site (Laptop)").click();
    await expect(choices.getByRole("radio", { name: /Docs Site \(Laptop\) Another Machine/ })).toBeChecked();
    await expect(page.getByRole("region", { name: "Location Switch Details" }))
      .toContainText("That Location is on another machine, so the task continues in a new session there");
    if (evidenceDir) {
      await page.screenshot({ path: join(evidenceDir, `location-switch-choose-${width}.png`), fullPage: true });
      await page.setViewportSize({ width, height: 1900 });
      await page.screenshot({ path: join(evidenceDir, `location-switch-choose-tall-${width}.png`), fullPage: true });
    }
    await page.locator(".request-dock .request-card-foot").getByRole("button", { name: "Start a New Session", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([
      { requestId: "evidence-occurrence", optionId: "new_session:loc-docs-laptop" },
    ]);
  });
}
