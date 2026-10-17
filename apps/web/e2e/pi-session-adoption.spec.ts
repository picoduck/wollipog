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

test("a result's metadata stays inside its row on a 320px phone (CR-1.2)", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/pi-session-adoption-e2e.html?theme=dark");
  await page.getByRole("button", { name: "Find Sessions" }).click();
  await page.getByRole("button", { name: "Continue Here" }).waitFor();
  const box = await page.locator(".agent-session-results > li").evaluate((row) => {
    const body = row.querySelector(".row-body")!.getBoundingClientRect();
    const trail = row.querySelector(".row-trail")!.getBoundingClientRect();
    const path = row.querySelector(".agent-session-path")!.getBoundingClientRect();
    const action = row.querySelector("button")!.getBoundingClientRect();
    return { bodyRight: body.right, trailRight: trail.right, actionLeft: action.left, pathWidth: path.width };
  });
  expect(box.trailRight).toBeLessThanOrEqual(box.bodyRight + 1);
  expect(box.trailRight).toBeLessThanOrEqual(box.actionLeft);
  expect(box.pathWidth, "the path keeps some room beside the time and count").toBeGreaterThan(24);
});

test("a protocol v155 runner explains why Pi adoption is unavailable", async ({ page }) => {
  await page.goto("/pi-session-adoption-e2e.html?legacy=1");
  const pi = page.getByRole("radio", { name: /Pi/ });
  await expect(pi).toBeDisabled();
  await expect(pi).not.toBeChecked();
  await expect(page.getByText("Update this machine's runner to find this agent's sessions.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find Sessions" })).toBeDisabled();
});
