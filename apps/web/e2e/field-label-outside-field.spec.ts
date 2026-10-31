import { expect, test, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * #2366: two forms stack labels over their controls outside a `.field`, and their labels are the
 * field label of docs/design-system.md §8.1: --type-label (12px/500 on a 16px line) in --text, 8px
 * above the control. Archived Sessions: the search label and the filters' `.field-label`s. The
 * New Webhook Trigger (#2972) and New Subscription dialogs' fields: each `.field-label`; a field's
 * helper stays dim, 4px under the control. The Automation editor became a page of `.field`s (#2967), whose
 * labels are checked here too. The labels that open redesigns owned went with them: Snooze's with #2181,
 * whose Snooze Until is a §8.1 field, Rename Project's with #2199, which made it one `.field`, and
 * the message-action form with #2185, which loads Edit as a New Turn straight into the composer.
 */

type Theme = "dark" | "light";

/** Every label of the Automation editor (#2967): each `.field`'s first child, before its control. */
const EDITOR_LABELS = ".automation-editor-form .field > span:first-child";

/** A token's computed colour, read the way the browser paints it. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((property) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${property})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

/**
 * Each label's text, its look, and the distance from the bottom of its text line to the top of the
 * control under it. A label element that wraps its control (`<label>Name<input/></label>`) starts
 * with its text, so its line ends one line height under its top; any other label is the box before
 * its control. Both are boxes, so the machine's font stack cancels out.
 */
async function labels(locator: Locator) {
  return locator.evaluateAll((elements) => elements.map((label) => {
    const style = getComputedStyle(label);
    const wrapped = label.querySelector("input, select, textarea, .ui-select");
    const top = label.getBoundingClientRect().top;
    const lineBottom = wrapped ? top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) : label.getBoundingClientRect().bottom;
    const control = (wrapped ?? label.nextElementSibling!).getBoundingClientRect();
    const text = wrapped ? [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)?.textContent : label.textContent;
    return {
      text: text?.trim(),
      look: { color: style.color, size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight },
      gap: control.top - lineBottom,
    };
  }));
}

async function expectLabelStyle(page: Page, locator: Locator, names: string[]) {
  const text = await token(page, "--text");
  const measured = await labels(locator);
  expect(measured.map((label) => label.text)).toEqual(names);
  for (const label of measured) {
    expect(label.look, `${label.text} is --type-label (12/16, 500) in --text`)
      .toEqual({ color: text, size: "12px", lineHeight: "16px", weight: "500" });
    expect(label.gap, `${label.text} sits 8px above its control`).toBeCloseTo(8, 1);
  }
}

async function setTheme(page: Page, theme: Theme) {
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390]) {
    test.describe(`${theme} at ${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });

      test("the Archived Sessions Filters sheet uses §8.1 field labels", async ({ page }) => {
        const url = `/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent(viewPath({ name: "archived" }))}`;
        await page.goto(url);
        await page.evaluate(() => localStorage.clear());
        await page.goto(url);
        await setTheme(page, theme);
        if (width === 1440) await page.setViewportSize({ width: 834, height: 900 });
        await page.getByRole("button", { name: /^Filters/ }).click();
        await page.setViewportSize({ width, height: 900 });
        await dialogMotionSettled(page);
        await expectLabelStyle(page, page.getByRole("dialog", { name: "Filters", exact: true }).locator(".field:visible > span:first-child"),
          [...(width === 390 ? ["Show"] : []), "Project", "Location", "Agent", "Status"]);
      });

      test("New Automation's labels are §8.1 field labels", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}&capabilities`);
        await page.getByRole("button", { name: "New Automation" }).click();
        await expectLabelStyle(page, page.locator(EDITOR_LABELS), [
          "Name", "Action", "Machine", "Folder", "Agent", "Model", "Reasoning Effort", "Permission Mode",
          "Workspace Strategy", "Prompt", "Schedule", "Time Zone", "If a Run Is Missed", "If the Machine Is Offline",
          "If the Last Run Is Still Going", "Cost Limit", "Tool Call Limit", "Web Push",
        ]);
      });

      test("a workflow automation's agent labels are §8.1 field labels", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}&workflow-machine-switch&orchestrator-bound&inherited-alternate-pins`);
        await page.getByRole("button", { name: /Nightly Dependency Sweep/ }).click();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        const agents = page.locator(EDITOR_LABELS).filter({ hasText: / Agent$/ });
        await expect(agents).toHaveCount(4);
        await expectLabelStyle(page, agents,
          ["Auditor Agent", "Orchestrator Agent", "Other Auditor Agent", "Other Orchestrator Agent"]);
      });

      test("the New Subscription dialog has §8.1 field labels", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}&route=${encodeURIComponent("/automations/outbound")}`);
        await page.getByRole("button", { name: "New Subscription" }).click();
        const dialog = page.getByRole("dialog", { name: "New Subscription" });
        await expect(dialog).toBeVisible();
        await dialogMotionSettled(page);
        await expectLabelStyle(page, dialog.locator(".field > .field-label"), ["Send Events For", "Callback URL"]);
      });

      test("the New Webhook Trigger dialog's labels are §8.1 field labels, and its helper stays dim 4px under the control", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}`);
        await page.getByRole("button", { name: /Nightly Dependency Sweep/ }).click();
        await page.locator(".detail-bar").getByRole("button", { name: "More Actions" }).click();
        await page.getByRole("menuitem", { name: "Add Webhook Trigger…" }).click();
        const dialog = page.getByRole("dialog", { name: "New Webhook Trigger" });
        await expect(dialog).toBeVisible();
        await dialogMotionSettled(page);
        await dialog.getByRole("switch", { name: "Let Callers Add Details" }).click();
        await expectLabelStyle(page, dialog.locator(".field > .field-label"),
          ["Name", "Named Values", "If a Referenced Value Is Missing"]);

        const dim = await token(page, "--text-dim");
        const helper = await dialog.locator(".field > .field-helper").filter({ hasText: "Separate names with commas." }).evaluate((small) => {
          const style = getComputedStyle(small);
          const control = small.parentElement!.querySelector("input")!.getBoundingClientRect();
          return {
            look: { color: style.color, size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight },
            gap: small.getBoundingClientRect().top - control.bottom,
          };
        });
        expect(helper.look, "the helper is --type-small in --text-dim").toEqual({ color: dim, size: "12px", lineHeight: "16px", weight: "400" });
        expect(helper.gap, "the helper sits 4px under the control").toBeCloseTo(4, 1);
      });
    });
  }
}
