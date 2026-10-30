import { expect, test, type Page } from "@playwright/test";

/**
 * New Multi-Agent Run (#2978; docs/design-system.md §7.1–§7.3, §7.5, §8.4–§8.5, §13.2), measured in
 * a real browser: the primary's reason shows in the footer at 1440px and on the phone sheet, a
 * server error is a notice at the body's end while the footer's buttons and the primary's label each
 * stay on one line in the 560px dialog, No Machines Online leads the body, the body is the dialog's
 * only scroller, and on a phone it is a full-height sheet.
 */

async function open(page: Page, scenario = "default") {
  await page.goto(`/new-run-e2e.html?scenario=${scenario}`);
  await expect(dialog(page)).toBeVisible();
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "New Multi-Agent Run" });
const reason = (page: Page) => dialog(page).locator(".modal-foot .new-run-reason");

async function chooseProject(page: Page, name: string) {
  await dialog(page).getByRole("button", { name: /^Project:/ }).click();
  await page.getByRole("option", { name }).click();
}

/** Every element in the dialog that scrolls vertically, by class. */
async function verticalScrollers(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('[role="dialog"], [role="dialog"] *')]
    .filter((element) => {
      const overflow = getComputedStyle(element).overflowY;
      return (overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight + 1;
    })
    .map((element) => element.className.toString()));
}

for (const width of [1440, 390]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 1440 ? 900 : 844 } });

    test("the primary's reason is in the footer, in view, and follows the fields", async ({ page }) => {
      await open(page);
      const run = dialog(page).getByRole("button", { name: /^Run (\d )?Agents?$/ });
      await expect(run).toBeDisabled();
      await expect(reason(page)).toHaveText("Enter a task to continue.");
      await expect(reason(page)).toBeInViewport();
      await dialog(page).getByRole("textbox", { name: "Task" }).fill("Add retry with backoff to the uploads client");
      await expect(reason(page)).toHaveText("Choose a project to continue.");
      await expect(reason(page)).toBeInViewport();
      await chooseProject(page, "Wollipog");
      await expect(reason(page)).toHaveCount(0);
      await expect(dialog(page).getByRole("button", { name: "Run 3 Agents" })).toBeEnabled();
    });

    test("a server error is a notice at the body's end and the footer's buttons stay on one line", async ({ page }) => {
      await open(page, "error");
      await dialog(page).getByRole("textbox", { name: "Task" }).fill("Add retry with backoff to the uploads client");
      await chooseProject(page, "Wollipog");
      await dialog(page).getByRole("button", { name: "Run 3 Agents" }).click();
      const notice = dialog(page).locator(".modal-body > .notice.t-danger");
      await expect(notice).toContainText("The run didn't start. Check the choices above and try again.");
      expect(await dialog(page).locator(".modal-body > :last-child").evaluate((element) => element.classList.contains("notice")),
        "the notice ends the body").toBe(true);
      await expect(dialog(page).locator(".modal-foot .form-error")).toHaveCount(0);
      const buttons = await dialog(page).locator(".modal-foot button").evaluateAll((elements) =>
        elements.map((element) => {
          const { top, height } = element.getBoundingClientRect();
          const line = Number.parseFloat(getComputedStyle(element).lineHeight);
          return { top, height, text: element.textContent, lines: Math.round((element as HTMLElement).clientHeight / line) };
        }));
      expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Run 3 Agents"]);
      expect(Math.abs(buttons[0]!.top - buttons[1]!.top), "Cancel and Run 3 Agents share one line").toBeLessThan(1);
      expect(Math.abs(buttons[0]!.height - buttons[1]!.height), "Run 3 Agents is one line, as tall as Cancel").toBeLessThan(1);
      if (width === 1440) {
        expect((await page.locator(".modal").boundingBox())!.width, "the dialog is the 560px form size").toBe(560);
      }
      await notice.getByRole("button", { name: "Show Details" }).click();
      await expect(notice).toContainText("409 Conflict");
    });

    test("with no Machine online a warning leads the body and the form stays visible", async ({ page }) => {
      await open(page, "offline");
      const first = dialog(page).locator(".modal-body > :first-child");
      await expect(first).toHaveClass(/notice/);
      await expect(first).toContainText("No Machines Online");
      await expect(first).toContainText("Start Wollipog on a machine to run agents.");
      await expect(dialog(page).getByRole("textbox", { name: "Task" })).toBeVisible();
      await expect(reason(page)).toHaveText("Bring a machine online to continue.");
      await expect(reason(page)).toBeInViewport();
      await first.getByRole("button", { name: "Open Connections" }).click();
      await expect(page.locator("body")).toHaveAttribute("data-opened", JSON.stringify({ name: "runners", section: "machines" }));
    });
  });
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the body is the form's only scroller, and no text names a runner", async ({ page }) => {
    await open(page);
    await dialog(page).getByRole("textbox", { name: "Task" }).fill("Add retry with backoff to the uploads client");
    await chooseProject(page, "Wollipog");
    // Six agents outgrow 900px: the body scrolls (§7.1), never a box of its own inside it.
    expect(await verticalScrollers(page), "nothing scrolls inside the body").toEqual(["modal-body"]);
    await dialog(page).getByRole("radio", { name: "Run a Workflow" }).click();
    expect(await verticalScrollers(page), "the workflow form fits without scrolling").toEqual([]);
    expect(await dialog(page).innerText()).not.toMatch(/runner/iu);
    await dialog(page).getByRole("button", { name: /^Location:/ }).click();
    const options = await page.getByRole("option").allInnerTexts();
    expect(options.map((text) => text.split("\n")[0])).toEqual(["wollipog on Build Server", "wollipog on Studio Mac"]);
    for (const text of options) expect(text).not.toMatch(/runner-/u);
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("New Multi-Agent Run is a full-height sheet whose footer stays in view", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    const sheet = page.locator(".modal.sheet-full");
    await expect(sheet).toBeVisible();
    await sheet.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    expect((await sheet.boundingBox())!.height, "full height").toBe(844);
    await expect(dialog(page).locator(".modal-foot")).toBeInViewport();
    expect(await verticalScrollers(page).then((classes) => classes.filter((name) => name !== "modal-body")),
      "only the body scrolls").toEqual([]);
  });
});
