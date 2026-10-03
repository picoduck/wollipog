import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`artifact discovery and server-backed preferences at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/artifact-uploads-e2e.html");
    const discovery = page.getByRole("note", { name: "Private Artifact Uploads" });
    await expect(discovery).toContainText("Uploads are manual by default");
    await expect(page.getByRole("link", { name: "Artifact Upload Settings" })).toHaveAttribute("href", "/settings/behavior");
    await page.screenshot({ path: testInfo.outputPath(`artifact-discovery-${width}.png`), fullPage: true });
    await page.getByRole("link", { name: "Artifact Upload Settings" }).click();
    await expect(page.locator("#settings-panel-heading")).toHaveText("Behavior");
    const picker = page.getByRole("button", { name: /^Artifact Uploads:/ });
    await expect(picker).toHaveAccessibleName("Artifact Uploads: Manual");
    await expect(picker).not.toHaveAttribute("aria-disabled", "true");
    await picker.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`artifact-settings-manual-${width}.png`), fullPage: true });
    for (const label of ["Use Wollipog Automatically", "Use External Hosting"]) {
      await picker.click();
      await page.getByRole("option", { name: label, exact: true }).click();
      await expect(picker).toHaveAccessibleName(`Artifact Uploads: ${label}`);
      await expect(page.getByRole("status")).toHaveText("Artifact upload preference saved.");
      await page.reload();
      await expect(picker).toHaveAccessibleName(`Artifact Uploads: ${label}`);
    }
    await expect(page.getByText(/Explicit task and project hosting requirements take priority/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`artifact-settings-external-${width}.png`), fullPage: true });
    await page.goto("/artifact-uploads-e2e.html");
    await page.getByRole("button", { name: "Dismiss Artifact Upload Notice" }).click();
    await expect(discovery).toHaveCount(0);
    await page.reload();
    await expect(discovery).toHaveCount(0);
    await page.goto("/artifact-uploads-e2e.html?entry=settings");
    await expect(picker).toHaveAccessibleName("Artifact Uploads: Use External Hosting");
  });
}

test("an unsupported endpoint explains the disabled preference", async ({ page }) => {
  await page.goto("/artifact-uploads-e2e.html?entry=settings&unsupported=1");
  await expect(page.getByRole("button", { name: "Artifact Uploads: Manual" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("alert")).toContainText("Update Wollipog");
});
