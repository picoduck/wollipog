import { expect, test, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * #2403: the shared Select draws its value in a button, and the base reset gives fields, not buttons,
 * their weight back, so the trigger took its container's type: a filter's 650 in Archived Sessions,
 * a wrapping label's 500 on a 16px line in Outbound Events. The trigger now sets the §8.1 control
 * type itself (docs/design-system.md): --type-body's weight and line, wherever it is placed. Its
 * weight matches a native field's value in the same form, and its line is the same in every form.
 *
 * Native fields are a weight reference only. Their lines differ by placement (a field inside a
 * wrapping label takes the label's 16px line, and Chromium resets a native `select` to `normal`),
 * so the line reference is --type-body's.
 */

type Theme = "dark" | "light";
type Look = { weight: string; lineHeight: string };

/** --type-body's weight and line, read the way the browser resolves the token. */
async function bodyType(page: Page): Promise<Look> {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.font = "var(--type-body)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const look = { weight: style.fontWeight, lineHeight: style.lineHeight };
    probe.remove();
    return look;
  });
}

/** Each trigger's label (its name is "Label: Value") with its own look and its value's, which is what the reader sees. */
async function triggers(scope: Locator) {
  return scope.locator(".ui-select-trigger").evaluateAll((elements) => elements.map((trigger) => {
    const look = (element: Element) => {
      const style = getComputedStyle(element);
      return { weight: style.fontWeight, lineHeight: style.lineHeight };
    };
    return { name: trigger.getAttribute("aria-label")?.split(":")[0], trigger: look(trigger), value: look(trigger.querySelector(".ui-select-value")!) };
  }));
}

async function weight(field: Locator): Promise<string> {
  return field.evaluate((element) => getComputedStyle(element).fontWeight);
}

/** Every trigger in `scope` takes --type-body's weight and line, and the native field's weight. */
async function expectTriggerType(page: Page, scope: Locator, names: string[], native: Locator) {
  const body = await bodyType(page);
  expect(body).toEqual({ weight: "400", lineHeight: "20px" });
  const nativeWeight = await weight(native);
  expect(nativeWeight, "a native field's value is weight 400 (the base reset)").toBe(body.weight);
  const measured = await triggers(scope);
  expect(measured.map((select) => select.name)).toEqual(names);
  for (const select of measured) {
    expect(select.trigger, `${select.name}'s trigger is --type-body`).toEqual(body);
    expect(select.value, `${select.name}'s value is --type-body`).toEqual(body);
    expect(select.value.weight, `${select.name} reads at the native field's weight`).toBe(nativeWeight);
  }
}

async function setTheme(page: Page, theme: Theme) {
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
}

/** The Machine Version dialog with one compatible machine and a library of one version. */
async function openMachineVersion(page: Page) {
  const version = { id: "skillv_a1a1a1a1a1a1a1a1a1a1", versionNumber: 1, digest: "a".repeat(64), createdAt: Date.now(), note: "Initial reviewed version",
    files: [{ path: "SKILL.md", encoding: "utf8", content: "Instructions" }] };
  const { files: _files, ...summary } = version;
  await page.route("**/api/skills/skill-1/versions", (route) => route.fulfill({ json: { versions: [summary], nextCursor: null } }));
  await page.route("**/api/skills/skill-1/machines/runner-1/version-policy", (route) => route.fulfill({ json: { policy: null } }));
  await page.route(/\/api\/skills\/skill-1\/machines\/runner-1\/version(\?.*)?$/, (route) => route.fulfill({
    json: { policy: null, currentVersion: version, proposedVersion: version, expectedLatestVersionId: version.id } }));
  await page.goto("/skills-removals-e2e.html");
  await page.locator(".master-detail-list").getByRole("button", { name: /code-review/i }).click();
  await page.locator(".skill-detail-head, .detail-bar").getByRole("button", { name: "More Actions" }).click();
  await page.getByRole("menuitem", { name: "Machine Version…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Machine Version" });
  await dialogMotionSettled(page);
  return dialog;
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390]) {
    test.describe(`${theme} at ${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });

      test("the Archived Sessions filters read at the search field's weight on the body line", async ({ page }) => {
        const url = `/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent(viewPath({ name: "archived" }))}`;
        await page.goto(url);
        await page.evaluate(() => localStorage.clear());
        await page.goto(url);
        await setTheme(page, theme);
        await expect(page.locator(".archive-filter").first()).toBeVisible();
        const search = page.locator(".archive-search input");
        await expectTriggerType(page, page.locator(".archive-filters"),
          ["Project", "Location", "Agent", "Archive State", "Lifecycle State"], search);
        // The search field is on the body line too, so here the two read identically.
        expect(await search.evaluate((input) => getComputedStyle(input).lineHeight)).toBe("20px");
        // The filters' own labels keep §8.1's --type-label (#2366).
        expect(await page.locator(".archive-filter > .field-label").first().evaluate((label) => {
          const style = getComputedStyle(label);
          return { weight: style.fontWeight, lineHeight: style.lineHeight };
        })).toEqual({ weight: "500", lineHeight: "16px" });
      });

      test("New Automation's Selects read at its native fields' weight on the body line", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}&capabilities`);
        await page.getByRole("button", { name: "New Automation" }).click();
        const grid = page.locator(".automation-form-grid");
        await expectTriggerType(page, grid, ["Model", "Reasoning Effort", "Permission Mode", "Workspace Strategy"],
          grid.getByRole("combobox", { name: "Action", exact: true }));
        expect(await weight(grid.getByRole("textbox", { name: "Name", exact: true }))).toBe("400");
      });

      test("the Outbound Events Selects, inside their labels, read at the Callback URL's weight on the body line", async ({ page }) => {
        await page.goto(`/automations-e2e.html?theme=${theme}`);
        await page.getByRole("button", { name: "New Subscription" }).click();
        const editor = page.locator(".outbound-event-editor");
        await expectTriggerType(page, editor, ["Scope Type", "Project"], editor.getByRole("textbox", { name: "Callback URL", exact: true }));
        // The wrapping labels keep §8.1's --type-label (#2366); only the trigger inside stopped taking it.
        expect(await editor.locator(".automation-form-grid > label").first().evaluate((label) => {
          const style = getComputedStyle(label);
          return { weight: style.fontWeight, lineHeight: style.lineHeight };
        })).toEqual({ weight: "500", lineHeight: "16px" });
      });

      test("Machine Version's Machine Select reads at a native field's weight on the body line", async ({ page }) => {
        const dialog = await openMachineVersion(page);
        await setTheme(page, theme);
        await expect(dialog.getByRole("radio").first()).toBeVisible();
        await expectTriggerType(page, dialog, ["Machine"], dialog.getByRole("radio").first());
      });
    });
  }
}
