import { expect, test } from "@playwright/test";

const path = "/checkpoint-rewind-e2e.html?surface=session&driver=claude-code&retry=";

test("an established Claude session restarts before Retry Turn resubmits the failed prompt", async ({ page }) => {
  await page.goto(path + "resume");
  const retry = page.getByRole("button", { name: "Retry Turn", exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.locator("body")).toHaveAttribute("data-retry-calls", JSON.stringify(["restart", "prompt"]));
  await expect(page.locator("body")).toHaveAttribute("data-prompted",
    "Continue the existing task after reloading the MCP configuration.");
});

for (const mode of ["fresh", "legacy"] as const) test(`Retry Turn explains a ${mode} session's unavailable continuity`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path + mode);
  const retry = page.getByRole("button", { name: "Retry Turn", exact: true });
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveAccessibleDescription(mode === "fresh"
    ? "Restarting starts a new conversation. Restart the session, then send the message again."
    : "The runner has not confirmed that restarting preserves this conversation. Update the runner, then try again.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
