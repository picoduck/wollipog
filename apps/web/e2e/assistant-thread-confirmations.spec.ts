import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A thread's owner confirmations in the open thread (#4665): the destructive command its assistant
 * asked to run is drawn ahead of the work cards, with what approving does, its exact target, impact
 * and arguments, and Approve Once and Deny. With `ASSISTANT_CONFIRMATION_EVIDENCE_DIR` set, each
 * theme and width is captured as UI evidence.
 */
const EVIDENCE_DIR = process.env.ASSISTANT_CONFIRMATION_EVIDENCE_DIR;

async function openThread(page: Page, theme: "dark" | "light", count = 1) {
  await page.goto(`/assistants-e2e.html?theme=${theme}&confirm=${count}&path=${encodeURIComponent("/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA")}`);
}

const requests = (page: Page) => page.getByRole("list", { name: "Approvals Needed" }).getByRole("listitem");
const card = (page: Page) => requests(page).first();

/** Every request's actions can be scrolled to and seen whole, without answering an earlier one. */
async function expectEveryRequestReachable(page: Page, count: number) {
  await expect(requests(page)).toHaveCount(count);
  for (let index = 0; index < count; index += 1) {
    for (const name of ["Approve Once", "Deny"]) {
      const button = requests(page).nth(index).getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport({ ratio: 1 });
    }
  }
}

test("the open thread shows its owner confirmation first, and Approve Once settles it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openThread(page, "dark");
  const request = card(page);
  await expect(request).toBeVisible();
  await expect(request).toContainText("Approval Needed");
  await expect(request).toContainText("Stops the session. Its transcript is kept, but it takes no further messages until it is restarted.");
  await expect(request.getByRole("definition").filter({ hasText: "Fix the Flaky Upload Test (sess-flaky)" })).toBeVisible();
  await expect(request.locator("dl[aria-label='Arguments']")).toContainText("sess-flaky");
  // Drawn ahead of the work cards it would unblock.
  const first = page.getByRole("region", { name: "Launched Work" }).getByRole("listitem").first();
  await expect(first).toHaveAccessibleName("Stop Session");
  for (const name of ["Open Session", "Deny", "Approve Once"]) await expect(request.getByRole("button", { name, exact: true })).toBeVisible();
  await request.getByRole("button", { name: "Approve Once", exact: true }).click();
  await expect(page.getByText("Stop Session ran once.", { exact: true })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-confirmation-answer", "aoc_0_sess-flaky:approve");
});

test("at a narrow desktop width the request keeps a readable width and the transcript stays in view", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await openThread(page, "dark");
  const box = await card(page).boundingBox();
  expect(box!.width, "the request is not squeezed by the work cards beside it").toBeGreaterThanOrEqual(300);
  expect(box!.height, "its facts and actions do not wrap into a tall column").toBeLessThan(450);
  // The work cards start right after the request, with no empty stretch between them.
  const cards = await page.locator(".assistant-work-cards").boundingBox();
  expect(cards!.x - (box!.x + box!.width), "the work cards follow the request").toBeLessThan(24);
  await expect(page.locator(".composer")).toBeInViewport();
});

for (const width of [1024, 800]) {
  test(`at ${width}px two requests and the work cards all stay reachable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openThread(page, "dark", 2);
    const cards = await page.locator(".assistant-work-cards").boundingBox();
    expect(cards!.width, "the work cards keep at least a card's width").toBeGreaterThanOrEqual(270);
    await expectEveryRequestReachable(page, 2);
    for (const work of await page.locator(".assistant-work-cards > li").all()) {
      await work.scrollIntoViewIfNeeded();
      await expect(work).toBeInViewport();
    }
    await expect(page.locator(".composer")).toBeInViewport();
  });
}

test("on a phone three requests scroll in a bounded area, and every action and the composer stay reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openThread(page, "light", 3);
  const area = await page.locator(".assistant-work").boundingBox();
  expect(area!.height, "the requests and work cards take at most 60% of the screen").toBeLessThanOrEqual(844 * 0.6 + 1);
  await expect(page.locator(".composer")).toBeInViewport();
  await expectEveryRequestReachable(page, 3);
});

test("Deny refuses it on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openThread(page, "light");
  // The whole request shows, frame and actions included, above the work cards' scrolling column.
  await expect(card(page)).toBeInViewport({ ratio: 1 });
  const [request, cards] = await Promise.all([card(page).boundingBox(), page.locator(".assistant-work-cards").boundingBox()]);
  expect(request!.y + request!.height, "the request ends before the scrolling work cards begin").toBeLessThanOrEqual(cards!.y);
  await card(page).getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByText("Stop Session was denied. Nothing ran.", { exact: true })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-confirmation-answer", "aoc_0_sess-flaky:deny");
});

test("captures the thread's confirmation card in both themes at desktop and phone widths", async ({ page }) => {
  test.skip(!EVIDENCE_DIR, "evidence capture only");
  mkdirSync(EVIDENCE_DIR!, { recursive: true });
  for (const theme of ["dark", "light"] as const) {
    for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openThread(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(card(page)).toBeVisible();
      await card(page).scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(EVIDENCE_DIR!, `thread-card-${viewport.name}-${theme}.png`) });
    }
  }
});
