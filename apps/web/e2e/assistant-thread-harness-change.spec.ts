import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const threadPath = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const evidenceDir = process.env.ASSISTANT_HARNESS_EVIDENCE_DIR;
const accountName = "Engineering Shared Subscription With a Long Account Display Name 1";

async function open(page: Page, theme: "dark" | "light", scenario: "ready" | "fail" | "old") {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/assistants-e2e.html?harness-change=${scenario}&limits=enabled&path=${encodeURIComponent(threadPath)}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function settings(page: Page) {
  await page.getByRole("button", { name: "Thread Settings", exact: true }).click();
  return page.getByRole("dialog", { name: "Thread Settings", exact: true });
}

async function chooseHarness(page: Page) {
  await (await settings(page)).getByRole("button", { name: /^Change Harness…/ }).click();
  const picker = page.getByRole("dialog", { name: "Change Harness", exact: true });
  await picker.getByRole("radio", { name: /Codex App Server With a Long Installation Label/ }).check();
  await expect(picker.getByRole("radio")).toHaveCount(10);
  await picker.getByRole("radio", { name: accountName, exact: true }).check();
  await expectNoHorizontalOverflow(picker, "The harness and account picker with nine long-named accounts");
  await expectFullyInViewport(picker.getByRole("button", { name: "Review Change" }), "Review Change");
  return picker;
}

async function confirmChange(page: Page) {
  await page.getByRole("button", { name: "Review Change" }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm Harness Change" });
  await expect(confirmation).toContainText("Future messages will go to OpenAI");
  await expect(confirmation).toContainText(accountName);
  await expect(confirmation).toContainText("The new conversation starts fresh");
  await expectNoHorizontalOverflow(confirmation, "The confirmation with long provider and account names");
  return confirmation;
}

for (const [layout, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
  for (const theme of ["light", "dark"] as const) {
    const capture = async (page: Page, state: string) => {
      await expectPageNoHorizontalOverflow(page);
      if (!evidenceDir) return;
      mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({ path: join(evidenceDir, `${layout}-${theme}-${state}.png`), animations: "disabled" });
    };
    test(`changes harness and keeps the conversation history on ${layout} in ${theme}`, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2025-11-19T18:00:00Z"));
      await page.setViewportSize({ width, height });
      await open(page, theme, "ready");
      await chooseHarness(page);
      await capture(page, "picker");
      const confirmation = await confirmChange(page);
      await capture(page, "confirmation");
      await confirmation.getByRole("button", { name: "Change Harness", exact: true }).click();
      await expect(confirmation.getByText("Starting the selected harness. The original conversation is kept until the new harness is ready.")).toBeVisible();
      await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
      await capture(page, "in-progress");
      await page.evaluate(() => Reflect.get(window, "finishAssistantHarnessChange")());
      await expect(confirmation).toHaveCount(0);
      await expect(page.getByText(/Switched from Claude Code to Codex/)).toBeVisible();
      await expect(page.getByLabel("Thread Details")).toContainText("$8.13 of $25.00 spent");
      await expect(page.getByLabel("Thread Details")).toContainText("2 of 10 sessions launched");
      await expectFullyInViewport(page.locator(".composer"), "The new conversation composer");
      await capture(page, "success");
      await page.getByRole("button", { name: "Earlier Conversation (Claude Code)" }).click();
      const history = page.getByRole("dialog", { name: "Earlier Conversation (Claude Code)" });
      await expect(history).toContainText("Last night's CI had two failures.");
      await expect(history.getByRole("textbox")).toHaveCount(0);
      await capture(page, "history");
      await history.getByRole("button", { name: "Done" }).click();
      await (await settings(page)).getByText("Decision Delegation", { exact: true }).click();
      const delegation = page.getByRole("dialog", { name: "Decision Delegation" });
      await expect(delegation.getByText("Confirm Provider Disclosure")).toBeVisible();
      await expect(delegation.getByText(/Codex App Server · gpt-6.2-sol/)).toBeVisible();
      await capture(page, "disclosure");
    });

    test(`cancel, rollback and older peers keep the original harness on ${layout} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, theme, "fail");
      await chooseHarness(page);
      let confirmation = await confirmChange(page);
      await confirmation.getByRole("button", { name: "Cancel" }).click();
      await expect(confirmation).toHaveCount(0);
      await expect(page.getByLabel("Thread Details")).toContainText("Claude Code");
      await expect(page.getByRole("button", { name: /Earlier Conversation/ })).toHaveCount(0);
      await capture(page, "cancelled");

      await chooseHarness(page);
      confirmation = await confirmChange(page);
      await confirmation.getByRole("button", { name: "Change Harness", exact: true }).click();
      await expect(confirmation.getByText(/The original conversation is kept until/)).toBeVisible();
      await page.evaluate(() => Reflect.get(window, "finishAssistantHarnessChange")());
      await expect(confirmation.getByRole("alert")).toContainText("The original conversation is ready to use.");
      await capture(page, "rollback");
      await confirmation.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByLabel("Thread Details")).toContainText("Claude Code");
      await expectFullyInViewport(page.locator(".composer"), "The original conversation composer");
      await expect(page.getByText(/Switched from/)).toHaveCount(0);

      await open(page, theme, "old");
      const fallback = await settings(page);
      await expect(fallback).toContainText("This thread's conversation belongs to this harness.");
      await expect(fallback.getByRole("button", { name: /^New Thread/ })).toBeVisible();
      await expect(fallback.getByRole("button", { name: /^Change Harness/ })).toHaveCount(0);
      await capture(page, "older-peer");
    });
  }
}
