import { expect, test, type Page } from "@playwright/test";

/**
 * New Pod (#2982; docs/design-system.md §7.1–§7.3, §7.5, §8.4, §12.1–§12.2), measured in a real
 * browser: Filter Sessions narrows the rows by title and agent inside a body that is the dialog's
 * only scroller, Create Pod's reason shows in the footer at 1440px and on the phone sheet, a server
 * error is a notice at the body's end with the footer's buttons on one line, No Sessions Can Join
 * offers New Session…, and on a phone the full-height sheet keeps the filter at the top over 44px rows.
 */

async function open(page: Page, scenario = "default") {
  await page.goto(`/new-pod-e2e.html?scenario=${scenario}`);
  await expect(page.getByRole("dialog", { name: "New Pod" })).toBeVisible();
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "New Pod" });
const rowTitles = (page: Page) => dialog(page).locator(".choice-row-title");
const choose = (page: Page, title: string, agent: string) =>
  dialog(page).locator(".choice-row").filter({ hasText: title }).filter({ hasText: agent }).locator("input").check();

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

    test("with one session chosen Create Pod is disabled and says to choose at least 2 sessions", async ({ page }) => {
      await open(page);
      await dialog(page).getByRole("textbox", { name: "Name" }).fill("Retry Helper Migration");
      await choose(page, "Plan the retry helper migration", "Claude Code");
      const create = dialog(page).getByRole("button", { name: "Create Pod" });
      await expect(create).toBeDisabled();
      const reason = dialog(page).locator(".modal-foot .new-pod-reason");
      await expect(reason).toHaveText("Choose at least 2 sessions.");
      await expect(reason).toBeInViewport();
      await choose(page, "Migrate the API call sites to withRetry()", "Codex");
      await expect(create).toBeEnabled();
      await expect(reason).toHaveCount(0);
    });

    test("a server error is a notice at the end of the body and the footer's buttons stay on one line", async ({ page }) => {
      await open(page, "error");
      await dialog(page).getByRole("textbox", { name: "Name" }).fill("Retry Helper Migration");
      await choose(page, "Plan the retry helper migration", "Claude Code");
      await choose(page, "Migrate the API call sites to withRetry()", "Codex");
      await dialog(page).getByRole("button", { name: "Create Pod" }).click();
      const notice = dialog(page).locator(".modal-body > .notice.t-danger");
      await expect(notice).toContainText("The pod wasn't created. Try again.");
      expect(await dialog(page).locator(".modal-body > :last-child").evaluate((element) => element.classList.contains("notice")),
        "the notice ends the body").toBe(true);
      await expect(dialog(page).locator(".modal-foot .form-error")).toHaveCount(0);
      const buttons = await dialog(page).locator(".modal-foot button").evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect()).map(({ top, height }) => ({ top, height })));
      expect(buttons).toHaveLength(2);
      expect(Math.abs(buttons[0]!.top - buttons[1]!.top), "Cancel and Create Pod share one line").toBeLessThan(1);
      await notice.getByRole("button", { name: "Show Details" }).click();
      await expect(notice).toContainText("409 Conflict");
    });

    test("with no eligible sessions the dialog says No Sessions Can Join and offers New Session…", async ({ page }) => {
      await open(page, "empty");
      await expect(dialog(page).getByText("No Sessions Can Join")).toBeVisible();
      await expect(dialog(page).getByText("Only sessions with their own worktree that aren't in another pod can join.")).toBeVisible();
      await expect(dialog(page).getByRole("button", { name: "Create Pod" })).toBeDisabled();
      await expect(dialog(page).locator(".new-pod-reason")).toHaveText("Choose at least 2 sessions.");
      await dialog(page).getByRole("button", { name: "New Session…" }).click();
      await expect(page.locator("body")).toHaveAttribute("data-new-session", "1");
    });
  });
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Filter Sessions narrows the rows by title and agent, and the dialog's body is its only vertical scroller", async ({ page }) => {
    await open(page);
    await expect(rowTitles(page)).toHaveCount(12);
    expect(await verticalScrollers(page), "the long list scrolls the body, never a box of its own").toEqual(["modal-body"]);
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight > window.innerHeight)).toBe(false);

    const filter = dialog(page).getByRole("searchbox", { name: "Filter Sessions" });
    await filter.fill("retry helper");
    await expect(rowTitles(page)).toHaveText([
      "Plan the retry helper migration",
      "Document the retry helper in the API guide",
    ]);
    await filter.fill("opencode");
    await expect(rowTitles(page)).toHaveText([
      "Review the migrated call sites",
      "Restore the fetchProjects timeout",
      "Document the retry helper in the API guide",
    ]);
    expect(await verticalScrollers(page), "a short list scrolls nothing").toEqual([]);

    await filter.fill("terraform");
    await expect(dialog(page).getByText("No sessions match “terraform”.")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Clear Filter" }).click();
    await expect(rowTitles(page)).toHaveCount(12);
    await expect(filter).toHaveValue("");
  });

  test("no row names a runner, and Worktree starting… shows only where it applies", async ({ page }) => {
    await open(page);
    const text = await dialog(page).innerText();
    expect(text).not.toMatch(/runner-|Worktree Ready/u);
    await expect(dialog(page).locator(".choice-row-desc").filter({ hasText: "Worktree starting…" }))
      .toHaveText(["OpenCode · Wollipog · Build Box · Worktree starting…"]);
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("New Pod is a full-height sheet whose filter stays at the top over 44px rows while the list scrolls", async ({ page }) => {
    // Measured once the sheet has risen into place.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    const sheet = page.locator(".modal.sheet-full");
    await expect(sheet).toBeVisible();
    await sheet.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    const sheetBox = (await sheet.boundingBox())!;
    expect(sheetBox.height, "full height").toBe(844);
    await expect(rowTitles(page)).toHaveCount(12);
    for (const height of await dialog(page).locator(".pod-session-list > .choice-row").evaluateAll((rows) =>
      rows.map((row) => row.getBoundingClientRect().height))) {
      expect(height).toBeGreaterThanOrEqual(44);
    }
    expect(await verticalScrollers(page)).toEqual(["modal-body"]);

    const filter = dialog(page).getByRole("searchbox", { name: "Filter Sessions" });
    const body = dialog(page).locator(".modal-body");
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const bodyTop = (await body.boundingBox())!.y;
    const filterBox = (await filter.boundingBox())!;
    expect(filterBox.y, "the filter is pinned to the top of the body").toBeGreaterThanOrEqual(bodyTop);
    expect(filterBox.y).toBeLessThan(bodyTop + 24);
    // It covers the rows that scroll under it rather than letting them show through.
    const covering = await filter.evaluate((input) => {
      const { left, top, width } = input.getBoundingClientRect();
      return document.elementFromPoint(left + width / 2, top + 4)?.closest(".pod-session-filter") !== null;
    });
    expect(covering).toBe(true);
    await expect(dialog(page).locator(".modal-foot")).toBeInViewport();
  });
});
