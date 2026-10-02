import { expect, test, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * #2366: two forms stack labels over their controls outside a `.field`, and their labels are the
 * field label of docs/design-system.md §8.1: --type-label (12px/500 on a 16px line) in --text, 8px
 * above the control. Archived Sessions: the search label and the filters' `.field-label`s. The
 * Automations editor (and the Outbound Events form on its grid): each grid label's own text, each
 * `.automation-field`'s `.field-label`, and its fieldset legends; a grid label's helper stays dim,
 * 4px under the control. The labels that open
 * redesigns own (Snooze #2181, Rename Project #2199, the message-action form #2185) keep the older
 * dim rule until those land; whichever lands first drops its case below.
 */

type Theme = "dark" | "light";

/** Every label of the Automations editor's grid: a label wrapping its control, or a `.field-label`. */
const AUTOMATION_LABELS = ".automation-form-grid > label, .automation-field > .field-label";

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

/** A fieldset legend titles a group, not one control: it takes the label's look, not its spacing. */
async function expectLegendStyle(page: Page, locator: Locator, names: string[]) {
  const text = await token(page, "--text");
  const measured = await locator.evaluateAll((elements) => elements.map((legend) => {
    const style = getComputedStyle(legend);
    return { text: legend.textContent, color: style.color, size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight };
  }));
  expect(measured).toEqual(names.map((name) => ({ text: name, color: text, size: "12px", lineHeight: "16px", weight: "500" })));
}

async function setTheme(page: Page, theme: Theme) {
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390]) {
    test.describe(`${theme} at ${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });

      test("the Archived Sessions search and filter labels are §8.1 field labels", async ({ page }) => {
        const url = `/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent(viewPath({ name: "archived" }))}`;
        await page.goto(url);
        await page.evaluate(() => localStorage.clear());
        await page.goto(url);
        await setTheme(page, theme);
        await expect(page.locator(".archive-filter").first()).toBeVisible();
        await expectLabelStyle(page, page.locator(".archive-search > span, .archive-filter > .field-label"),
          ["Search Sessions and Transcripts", "Project", "Location", "Agent", "Archive State", "Lifecycle State"]);
      });

      test("New Automation's labels are §8.1 field labels", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}&capabilities`);
        await page.getByRole("button", { name: "New Automation" }).click();
        await expectLabelStyle(page, page.locator(AUTOMATION_LABELS), [
          "Name", "Cron (Minute Hour Day Month Weekday)", "Timezone", "Action", "Machine", "Workspace", "Agent",
          "Model", "Reasoning Effort", "Permission Mode", "Workspace Strategy", "Prompt", "Misfire",
          "Runner Availability", "Concurrency", "Max Additional Cost (USD)", "Max Tool Calls",
        ]);
        await expectLegendStyle(page, page.locator(".automation-form-grid legend"), ["Web Push Events"]);
      });

      test("a workflow automation's agent labels are §8.1 field labels", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}&workflow-machine-switch&orchestrator-bound&inherited-alternate-pins`);
        await page.getByRole("button", { name: /Nightly Dependency Sweep/ }).click();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await expect(page.locator(".automation-field > .field-label")).toHaveCount(4);
        await expectLabelStyle(page, page.locator(".automation-field > .field-label"),
          ["Agent-1 Agent", "Orchestrator Agent", "Alternate Agent-1 Agent", "Alternate Orchestrator Agent"]);
      });

      test("the Outbound Events subscription form, on the same grid, has §8.1 field labels", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}`);
        await page.getByRole("button", { name: "New Subscription" }).click();
        const editor = page.locator(".outbound-event-editor");
        await expectLabelStyle(page, editor.locator(AUTOMATION_LABELS), ["Scope Type", "Project", "Callback URL"]);
        await expectLegendStyle(page, editor.locator(".automation-form-grid legend"), ["Event Kinds"]);
      });

      test("the signed trigger editor's labels are §8.1 field labels, and its helper stays dim 4px under the control", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}`);
        await page.getByRole("button", { name: /Nightly Dependency Sweep/ }).click();
        await page.getByRole("button", { name: "Add Webhook" }).click();
        await page.getByRole("checkbox", { name: "Accept Delivery Fields" }).check();
        const editor = page.locator(".automation-trigger-editor");
        await expectLabelStyle(page, editor.locator(AUTOMATION_LABELS), ["Name", "Kind", "Missing References", "Parameter Names"]);

        const dim = await token(page, "--text-dim");
        const helper = await editor.locator(".automation-form-grid > label > small").evaluate((small) => {
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


  test.describe(`${theme}: labels other redesigns own`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    /** The older rule these labels keep: --text-sm, weight 500, in --text-dim, on the body's line. */
    async function expectUnchanged(page: Page, label: Locator, margin: string) {
      const dim = await token(page, "--text-dim");
      const look = await label.evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight, margin: style.margin };
      });
      expect(look).toEqual({ color: dim, size: "12px", lineHeight: "20px", weight: "500", margin });
    }

    test("Snooze (#2181) keeps its labels", async ({ page }) => {
      await page.goto("/sessions-board-e2e.html");
      await setTheme(page, theme);
      await expect(page.locator(".inbox-list-pane > .toolbar")).toBeVisible();
      await page.locator(".inbox-row-shell", { hasText: "Running Session" }).getByRole("button").first().click();
      const directSnooze = page.getByRole("button", { name: "Snooze", exact: true });
      if (await directSnooze.isVisible()) {
        await directSnooze.click();
      } else {
        await page.getByRole("button", { name: "More Actions" }).click();
        await page.getByRole("menuitem", { name: "Snooze…", exact: true }).click();
      }
      const dialog = page.getByRole("dialog", { name: "Snooze Session" });
      await expect(dialog.locator(".field-label").first()).toBeVisible();
      for (const label of await dialog.locator(".field-label").all()) await expectUnchanged(page, label, "4px 0px -4px");
    });

    test("Rename Project (#2199) keeps its label", async ({ page }) => {
      await page.goto("/command-inbox-projects-e2e.html");
      await page.evaluate(() => localStorage.clear());
      await page.goto("/command-inbox-projects-e2e.html");
      await setTheme(page, theme);
      await page.getByRole("tab", { name: /Alpha/ }).hover();
      await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
      await page.getByRole("menuitem", { name: /^Rename Project/ }).click();
      const dialog = page.getByRole("dialog", { name: "Rename Project" });
      await dialogMotionSettled(page);
      await expectUnchanged(page, dialog.locator(".field-label"), "0px 0px 6px");
    });

    test("the message-action form (#2185) keeps its label", async ({ page }) => {
      const url = "/command-inbox-projects-e2e.html?scenario=edit-in-fork";
      await page.goto(url);
      await page.evaluate(() => localStorage.clear());
      await page.goto(url);
      await setTheme(page, theme);
      await page.getByRole("button", { name: /Alpha Session/ }).click();
      const expand = page.getByRole("button", { name: "Expand Session" });
      if (await expand.isVisible()) await expand.click();
      await page.getByRole("button", { name: "Edit User Message as a New Turn" }).last().click();
      await expectUnchanged(page, page.getByRole("dialog").locator(".field-label"), "0px 0px 6px");
    });
  });
}
