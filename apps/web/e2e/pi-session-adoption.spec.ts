import { expect, test } from "@playwright/test";

test("a verified Pi agent discovers and adopts its external session", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 800 });
  await page.goto("/pi-session-adoption-e2e.html?theme=dark");

  // The only agent that can be scanned is selected on open (#2994).
  const pi = page.getByRole("radio", { name: /Pi/ });
  await expect(pi).toBeChecked();
  await page.getByRole("button", { name: "Find Sessions" }).click();
  await expect(page.getByText("Finish Pi Session Adoption", { exact: true })).toBeVisible();
  await expect(page.getByText("Pi RPC", { exact: true })).toBeVisible();
  const adopt = page.getByRole("button", { name: "Continue Here" });
  await expect(adopt).toBeEnabled();
  await page.screenshot({ path: ".agents/tmp/pi-session-adoption/discovery.png", fullPage: true });

  await adopt.click();
  await expect(page.getByText("No Sessions Found", { exact: true })).toBeVisible();
  await expect(page.getByText("Pi RPC has no sessions on this machine that Wollipog isn't already showing.", { exact: true }))
    .toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __piAdopted?: boolean }).__piAdopted)).toBe(true);
});

test("a protocol v155 runner explains why Pi adoption is unavailable", async ({ page }) => {
  await page.goto("/pi-session-adoption-e2e.html?legacy=1");
  const pi = page.getByRole("radio", { name: /Pi/ });
  await expect(pi).toBeDisabled();
  await expect(pi).not.toBeChecked();
  await expect(page.getByText("Update this machine's runner to find this agent's sessions.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find Sessions" })).toBeDisabled();
});
