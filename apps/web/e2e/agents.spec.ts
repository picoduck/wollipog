import { expect, test } from "@playwright/test";
test.use({ video: "on" });

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) for (const theme of ["dark", "light"]) {
  test(`agents preserve exact selection and requests on ${viewport.name} ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/agents-e2e.html?theme=${theme}`);
    const roster = page.getByRole("list", { name: "Agents", exact: true });
    await expect(roster.getByRole("listitem")).toHaveCount(3);
    await page.getByRole("button", { name: "Inspect Parser · Child Approval Required", exact: true }).click();
    await expect(page.getByRole("region", { name: "Selected Worker Request" })).toBeFocused();
    await expect(page.getByText("The parser tests are ready to run.")).toBeVisible();
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByRole("button", { name: "Inspect Parser · Child Approval Required", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Audit Storage · Child Approval Required", exact: true })).toBeVisible();
    await page.getByRole("radio", { name: "History (1)", exact: true }).click();
    await expect(roster.getByText("Review Documentation", { exact: true })).toBeVisible();
    await page.getByRole("radio", { name: "Active (3)", exact: true }).click();
    await roster.getByRole("button", { name: /Background Monitor/ }).click();
    await expect(page.getByText("Managed Background Job", { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.agents/tmp/wave2-evidence/agents-${viewport.name}-${theme}.png`, fullPage: true });
    await page.getByRole("button", { name: "Disconnect Runner", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Active (0)", exact: true })).toBeVisible();
  });
}
