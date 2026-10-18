import { expect, test, type Page } from "@playwright/test";

/**
 * #3224, #3259: Codex Non-Interactive (`codex exec`) is retired. The REAL New Session dialog must
 * never offer it, must not start a saved exec default without a choice, and must explain an App
 * Server that failed its check instead of quietly falling back to exec.
 */

async function open(page: Page, query: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/new-session-choices-e2e.html?codexDiscovery=1&${query}`);
  await expect(page.getByRole("heading", { name: "New Session" })).toBeVisible();
}

async function agentOptions(page: Page) {
  await page.getByRole("combobox", { name: "Agent" }).click();
  return page.getByRole("listbox", { name: "Agent" }).getByRole("option");
}

test("a saved exec default asks for a choice and offers Codex App Server", async ({ page }) => {
  await open(page, "savedAgent=codex-exec");
  const warning = page.locator(".agent-default-warning");
  await expect(warning).toContainText("which is no longer supported");
  await expect(page.getByRole("combobox", { name: "Agent" })).toHaveValue("");
  // No agent chosen yet is not a hard block (#2952): Create Session lands on Agent and names it.
  await page.getByRole("button", { name: "Create Session" }).click();
  await expect(page.locator(".modal-body .field-error")).toHaveText("Choose an installed agent.");
  await expect(page.getByRole("combobox", { name: "Agent" })).toBeFocused();
  await expect(page.getByRole("dialog", { name: "New Session" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Use Codex App Server" }).click();
  await expect(page.getByRole("combobox", { name: "Agent" })).toHaveValue("Codex App Server");
  await expect(warning).toHaveCount(0);
  const options = await agentOptions(page);
  await expect(options.filter({ hasText: "Codex App Server" })).toHaveCount(1);
  await expect(options.filter({ hasText: /Non-Interactive|codex exec/ })).toHaveCount(0);
});

test("an App Server whose check timed out needs setup with the runner's reason", async ({ page }) => {
  await open(page, "appServerCheck=timeout");
  const codex = (await agentOptions(page)).filter({ hasText: "Codex" });
  await expect(codex).toHaveCount(1);
  await expect(codex).toHaveAttribute("aria-disabled", "true");
  await expect(codex).toContainText("Needs setup. Wollipog couldn't check this Codex installation in time. Rediscover to try again.");
});
