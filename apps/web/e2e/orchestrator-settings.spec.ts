import { expect, test } from "@playwright/test";
import { expectTextFits } from "./text-fit";

test.use({ reducedMotion: "reduce" });

for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
  test(`Orchestrator settings are responsive and keyboard operable at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/settings-rows-e2e.html?theme=dark&section=orchestrator");
    await expect(page.locator("#settings-panel-heading")).toHaveText("Orchestrator");
    await expect(page.getByRole("heading", { name: "Behavior", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Execution Permissions", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Decision Delegation", exact: true })).toBeVisible();
    await expect(page.getByText("Human-Only Decisions", { exact: true })).toBeVisible();
    await expect(page.getByText(/provider may retain images in provider-local transcripts or media logs/)).toBeVisible();
    await expect(page.getByText(/Video evidence otherwise requires human review, including video attached as a Session artifact/)).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Maximum Concurrent Children" })).toHaveValue("4");
    await expect(page.getByRole("radiogroup", { name: "Strict Project Isolation" })
      .getByRole("radio", { name: "Disabled" })).toBeChecked();
    await expect(page.getByText(/does not claim operating-system read-only enforcement/)).toBeVisible();

    const childHarness = page.getByRole("button", { name: /Child Harness: Automatic/ });
    await childHarness.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("listbox", { name: "Child Harness" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(childHarness).toBeFocused();

    const childModel = page.getByRole("button", { name: /Child Model: Automatic/ });
    await childModel.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("listbox", { name: "Child Model" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(childModel).toBeFocused();

    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(horizontalOverflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`orchestrator-settings-${viewport.width}.png`), fullPage: true });

    await childHarness.click();
    await page.getByRole("option", { name: /Codex App Server · Codex App Server · Native/ }).click();
    await page.getByRole("button", { name: /Child Model: Automatic/ }).click();
    await page.getByRole("option", { name: /GPT-5.6 Sol/ }).click();
    await page.getByRole("button", { name: /Child Effort: Automatic/ }).click();
    await page.getByRole("option", { name: /High/ }).click();
    await expect(page.getByRole("button", { name: /Child Harness: Codex App Server · Codex App Server · Native/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Child Model: GPT-5.6 Sol/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Child Effort: High/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`orchestrator-settings-fixed-${viewport.width}.png`), fullPage: true });

    await page.getByRole("button", { name: "Save Defaults" }).scrollIntoViewIfNeeded();
    await expect(page.getByText("UI Evidence Approval", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`orchestrator-delegation-${viewport.width}.png`), fullPage: true });
  });
}

test("Orchestrator settings retain drifted values with actionable compatibility information", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/settings-rows-e2e.html?theme=light&section=orchestrator&defaults=agent-repair");
  await expect(page.getByRole("button", { name: /Child Model: retired-model \(Unavailable\)/i })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Choose Automatic or another advertised combination");
  await page.screenshot({ path: testInfo.outputPath("orchestrator-settings-drift.png"), fullPage: true });
});

// #2413: as three equal pills in the panel's 260px value column, "Questions and Approvals" drew over
// its neighbour at every width. Each option is measured in the listbox and, once chosen, in the trigger.
for (const theme of ["dark", "light"]) {
  for (const width of [390, 1100, 1440]) {
    test(`every Descendant Requests option fits its own box at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/settings-rows-e2e.html?theme=${theme}&section=orchestrator`);
      await expect(page.getByRole("heading", { name: "Decision Delegation", exact: true })).toBeVisible();
      const trigger = page.getByRole("button", { name: /^Descendant Requests:/ });
      for (const label of ["Human", "Questions", "Questions and Approvals"]) {
        await trigger.click();
        const listbox = page.getByRole("listbox", { name: "Descendant Requests" });
        await expect(listbox).toBeVisible();
        const options = listbox.getByRole("option");
        await expect(options).toHaveCount(3);
        for (const option of await options.all()) {
          await expectTextFits(option, `${await option.getAttribute("aria-labelledby")} at ${width}px in ${theme}`);
        }
        await listbox.getByRole("option", { name: label, exact: true }).click();
        await expect(listbox).toBeHidden();
        await expect(trigger).toHaveAccessibleName(`Descendant Requests: ${label}`);
        await expect(trigger.locator(".ui-select-value")).toHaveText(label);
        await expectTextFits(trigger, `the ${label} trigger at ${width}px in ${theme}`);
      }
    });
  }
}
