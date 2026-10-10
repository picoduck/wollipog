import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Review's commit bar in a real browser (#2847): in every Review state, at a 1440px desktop and a
 * 390px phone, the commit input, its commit button and the request button are on screen without
 * scrolling anything, because they sit in the panel's fixed foot. The DOM tests cover behaviour;
 * this covers what only layout can show.
 */

const SIZES = [
  { name: "1440px desktop", width: 1440, height: 900 },
  { name: "390px phone", width: 390, height: 844 },
] as const;

/** Each Review state, and the commit and request buttons it offers. */
const STATES = [
  { scenario: "staged", commit: "Commit Staged", request: "Open Pull Request…" },
  { scenario: "unstaged", commit: "Commit", request: "Open Pull Request…" },
  { scenario: "clean", commit: "Commit", request: "Open Pull Request…" },
  { scenario: "pr", commit: "Commit Staged", request: "Push to Pull Request" },
  { scenario: "gitlab", commit: "Commit Staged", request: "Open Merge Request…" },
  { scenario: "offline", commit: "Commit Staged", request: "Open Pull Request…" },
  { scenario: "older", commit: "Commit Staged", request: "Open Pull Request…" },
] as const;

async function openReview(page: Page, query: string) {
  await page.goto(`/commit-bar-e2e.html?${query}`);
  await expect(page.locator(".rpanel[data-mode='review'] .rpanel-foot .commit-bar")).toBeVisible();
}

/** Inside the viewport and the panel, and the topmost element at its centre: seen, not just laid out. */
async function expectOnScreen(page: Page, control: Locator, label: string) {
  await expect(control, label).toBeVisible();
  const placement = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const panel = element.closest(".rpanel")!.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      inViewport: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth,
      inPanel: box.top >= panel.top && box.bottom <= panel.bottom && box.left >= panel.left && box.right <= panel.right,
      onTop: hit === element || element.contains(hit),
      inScroller: element.closest(".rpanel-scroll") !== null,
    };
  });
  expect(placement, label).toEqual({ inViewport: true, inPanel: true, onTop: true, inScroller: false });
}

async function expectBarOnScreen(page: Page, commit: string, request: string) {
  const bar = page.getByRole("region", { name: "Commit" });
  await expectOnScreen(page, bar.getByRole("textbox", { name: "Commit Message" }), "the commit input");
  await expectOnScreen(page, bar.getByRole("button", { name: commit, exact: true }), commit);
  await expectOnScreen(page, bar.getByRole("button", { name: request, exact: true }), request);
  expect(await page.evaluate(() => scrollY), "the page itself did not scroll").toBe(0);
}

for (const size of SIZES) {
  test.describe(`Commit bar at a ${size.name}`, () => {
    for (const state of STATES) {
      test(`${state.scenario}: the commit input, ${state.commit} and ${state.request} are on screen`, async ({ page }) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        await openReview(page, `scenario=${state.scenario}`);
        await expectBarOnScreen(page, state.commit, state.request);
        // Scrolling the diff to its end leaves the bar where it was.
        await page.locator(".rpanel-scroll").evaluate((scroller) => { scroller.scrollTop = scroller.scrollHeight; });
        await expectBarOnScreen(page, state.commit, state.request);
      });
    }

    test("after a commit, its notice and the bar are on screen", async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await openReview(page, "scenario=staged");
      const bar = page.getByRole("region", { name: "Commit" });
      await bar.getByRole("button", { name: "Commit Staged", exact: true }).click();
      await expect(bar.getByText("Committed 1 staged file as 9d2a7da.")).toBeVisible();
      await expectOnScreen(page, bar.getByRole("button", { name: "Copy Hash" }), "Copy Hash");
      await expectBarOnScreen(page, "Commit Staged", "Open Pull Request…");
    });

    test("a rejected push with Show Details open keeps the bar on screen", async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await openReview(page, "scenario=pr&outcome=rejected");
      const bar = page.getByRole("region", { name: "Commit" });
      await bar.getByRole("button", { name: "Push to Pull Request" }).click();
      const notice = bar.getByRole("alert");
      await expect(notice).toContainText("The remote rejected the push");
      await notice.getByRole("button", { name: "Show Details" }).click();
      await expect(notice.locator(".code-well pre")).toContainText("failed to push some refs");
      await expectOnScreen(page, notice.getByRole("button", { name: "Try Again" }), "Try Again");
      await expectBarOnScreen(page, "Commit Staged", "Push to Pull Request");
      await expect(page.locator(".rpanel-scroll").getByRole("alert")).toHaveCount(0);
    });
  });
}

test("the Open Pull Request dialog is a sheet on a phone and shows its field error", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReview(page, "scenario=unstaged");
  await page.getByRole("region", { name: "Commit" }).getByRole("button", { name: "Open Pull Request…" }).click();
  const dialog = page.getByRole("dialog", { name: "Open Pull Request" });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(Math.round(box.width), "a full-width sheet").toBe(390);
  await dialog.getByLabel("Title").fill("");
  await dialog.getByRole("button", { name: "Open Pull Request", exact: true }).click();
  await expect(dialog.getByText("Enter a title for the pull request.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Open Pull Request", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => window.__COMMIT_BAR_E2E__.sent())).toEqual([]);
});

test("opening a pull request closes the dialog, adds the summary row and offers Open on GitHub", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReview(page, "scenario=clean");
  const bar = page.getByRole("region", { name: "Commit" });
  await bar.getByRole("button", { name: "Open Pull Request…" }).click();
  const dialog = page.getByRole("dialog", { name: "Open Pull Request" });
  await dialog.getByLabel("Description (Optional)").fill("Totals use each item's quantity.");
  await dialog.getByRole("button", { name: "Open Pull Request", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".review-summary").getByRole("group", { name: "Pull Request" })).toBeVisible();
  const link = bar.getByRole("link", { name: "Open on GitHub" });
  await expect(link).toHaveAttribute("href", "https://github.com/acme/shop/pull/412");
  expect(await link.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe("none");
  await expect(bar.getByRole("button", { name: "Push to Pull Request" })).toBeVisible();
});

test("a partial stage disables Open Pull Request in the dialog and says why in its footer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReview(page, "scenario=staged");
  await page.getByRole("region", { name: "Commit" }).getByRole("button", { name: "Open Pull Request…" }).click();
  const dialog = page.getByRole("dialog", { name: "Open Pull Request" });
  await expect(dialog.getByRole("button", { name: "Open Pull Request", exact: true })).toBeDisabled();
  await expect(dialog.getByText("Commit the staged changes first.")).toBeVisible();
});
