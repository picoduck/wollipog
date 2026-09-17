import { expect, test } from "@playwright/test";

test("a verified Pi agent discovers and adopts its external session", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 800 });
  await page.goto("/pi-session-adoption-e2e.html?theme=dark");

  const pi = page.getByRole("radio", { name: /Pi/ });
  await expect(pi).toBeEnabled();
  await pi.check();
  await page.getByRole("button", { name: "Find Sessions" }).click();
  await expect(page.getByText("Finish Pi Session Adoption", { exact: true })).toBeVisible();
  await expect(page.getByText("Pi RPC", { exact: true }).last()).toBeVisible();
  const adopt = page.getByRole("button", { name: "Adopt & Continue" });
  await expect(adopt).toBeEnabled();
  await page.screenshot({ path: ".agents/tmp/pi-session-adoption/discovery.png", fullPage: true });

  await adopt.click();
  await expect(page.getByText("No unmanaged sessions were found for this agent.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __piAdopted?: boolean }).__piAdopted)).toBe(true);
});

test("a protocol v155 runner explains why Pi adoption is unavailable", async ({ page }) => {
  await page.goto("/pi-session-adoption-e2e.html?legacy=1");
  const pi = page.getByRole("radio", { name: /Pi/ });
  await expect(pi).toBeDisabled();
  await expect(page.getByText("Runner Update Required", { exact: true })).toBeVisible();
  await expect(page.getByText(/Pi session discovery.*requires protocol v156/u)).toBeVisible();
});
