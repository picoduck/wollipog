import { expect, test, type Locator, type Page } from "@playwright/test";
import { choosePageAction } from "./page-actions";

/**
 * #2538: a `.field-row` keeps two equal columns on desktop and is one column in a container under
 * 480px (docs/design-system.md §8.1). The dialog body is the container, so on a phone sheet every
 * row's fields are full width and stacked. These three dialogs use the bare row; Hand Off and
 * Import from Git are measured in their own specs.
 */

const dialogs: Array<{ name: string; open: (page: Page) => Promise<Locator> }> = [
  {
    name: "Connect via SSH",
    open: async (page) => {
      await page.goto("/machine-management-e2e.html");
      await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
      await choosePageAction(page, "Connect via SSH");
      return page.getByRole("dialog", { name: "Connect via SSH" });
    },
  },
  {
    name: "New Run",
    open: async (page) => {
      await page.goto("/new-session-choices-e2e.html?dialog=run");
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Project", { exact: true }).selectOption({ label: "No Project" });
      return dialog;
    },
  },
  {
    name: "Onboard Runner",
    open: async (page) => {
      await page.route("**/api/onboarding", (route) => route.fulfill({ json: {
        runnerWsUrl: "ws://127.0.0.1:8787/runner", host: "127.0.0.1", port: 8787, lanIps: [], existingRunnerIds: [],
      } }));
      await page.goto("/machine-management-e2e.html");
      await expect(page.getByRole("heading", { name: "Design Workstation" })).toBeVisible();
      await choosePageAction(page, "Add Native Runner");
      return page.getByRole("dialog", { name: "Add a Runner" });
    },
  },
];

for (const width of [1440, 390]) for (const { name, open } of dialogs) {
  test(`${name} at ${width}px: the field row is ${width === 390 ? "one column of full-width fields" : "two equal columns"}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const dialog = await open(page);
    const row = dialog.locator(".field-row");
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
    const geometry = await row.evaluate((element) => {
      const body = element.closest(".modal-body")!;
      const rect = element.getBoundingClientRect();
      return {
        columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
        bodyOverflow: body.scrollWidth - body.clientWidth,
        row: { left: rect.left, right: rect.right },
        fields: [...element.children].map((child) => {
          const box = child.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        }),
      };
    });
    expect(geometry.bodyOverflow, "no horizontal overflow").toBeLessThanOrEqual(0);
    const [first, second] = geometry.fields;
    if (width === 390) {
      expect(geometry.columns).toBe(1);
      for (const field of geometry.fields) {
        expect(Math.abs(field.left - geometry.row.left), "full width").toBeLessThanOrEqual(0.5);
        expect(Math.abs(field.right - geometry.row.right), "full width").toBeLessThanOrEqual(0.5);
      }
      expect(second!.top, "stacked").toBeGreaterThanOrEqual(first!.bottom);
    } else {
      expect(geometry.columns).toBe(2);
      expect(Math.abs(first!.top - second!.top), "side by side").toBeLessThan(1);
      expect(Math.abs((first!.right - first!.left) - (second!.right - second!.left)), "equal columns").toBeLessThanOrEqual(0.5);
    }
  });
}
