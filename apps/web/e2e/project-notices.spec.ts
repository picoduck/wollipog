import { expect, test, type Page } from "@playwright/test";
import { chooseSessionGroup } from "./session-groups.js";
import { expectGeometry } from "./geometry-margins.js";

/**
 * #1977: the Project setup suggestion is one notice above that Project's Sessions tab and a compact
 * info condition in its session, never a card inside a list row; the skills-unavailable notice is a
 * dismissible info condition whose fact the Pinned Summary keeps. The harness's Payments Service is
 * eligible for the suggestion and its first session runs in a container with two skills assigned.
 */

const PHONE = { width: 390, height: 844 };

async function openSessions(page: Page, query = "") {
  await page.goto(`/project-notices-e2e.html${query}`);
  await expect(page.getByText("Add Refund Webhooks").first()).toBeVisible();
}

async function openProjectTab(page: Page) {
  // A phone chooses the group in its app bar's picker (#2211).
  await chooseSessionGroup(page, /Payments Service/u);
}

function row(page: Page, title: string) {
  return page.locator('[role="row"]', { hasText: title });
}

test("at phone width the Project's first row keeps its normal height, and one notice sits above the list", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openSessions(page);
  await expect(page.getByRole("complementary", { name: /^Set Up/u })).toHaveCount(0);
  await openProjectTab(page);

  const notices = page.getByRole("complementary", { name: /^Set Up/u });
  await expect(notices).toHaveCount(1);
  await expect(notices).toHaveAccessibleName("Set Up Payments Service");
  await expect(page.locator('[role="row"] .notice')).toHaveCount(0);

  // The eligible session's row against a sibling with the same shape: no extra card under it.
  const first = await row(page, "Add Refund Webhooks").boundingBox();
  const second = await row(page, "Retry Failed Payouts").boundingBox();
  expect(first && second).toBeTruthy();
  expectGeometry(Math.abs(first!.height - second!.height), "the two rows have the same lines, so only a card could differ")
    .toBeLessThanOrEqual(0.61);

  const notice = (await notices.boundingBox())!;
  expectGeometry(first!.y - (notice.y + notice.height), "the notice ends above the first row")
    .toBeGreaterThanOrEqual(0);
  expectGeometry(notice.x, "the notice stays inside the phone's left edge").toBeGreaterThanOrEqual(0);
  expectGeometry(PHONE.width - (notice.x + notice.width), "the notice stays inside the phone's right edge")
    .toBeGreaterThanOrEqual(0);
});

test("a failed Generate shows one sentence and no raw error", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSessions(page, "?generate=fail");
  await openProjectTab(page);
  const notice = page.getByRole("complementary", { name: "Set Up Payments Service" });
  await notice.getByRole("button", { name: "Generate Setup File" }).click();
  await expect(notice.getByRole("alert")).toHaveText(
    "Couldn’t read the repository on Build Box. Check that it’s online, then try again.",
  );
  await expect(notice).not.toContainText("ls-files");
  await expect(notice.getByRole("link", { name: "Learn More" })).toHaveCSS("text-decoration-line", "none");
});

test("at phone width the session's slot shows one notice, the rest behind +1 More", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/project-notices-e2e.html?surface=session&adapter=container");
  const slot = page.locator(".session-notice-slot");
  await expect(slot.getByRole("status", { name: "Skills Unavailable" })).toBeVisible();
  await expect(slot.locator(".notice")).toHaveCount(1);
  await slot.getByRole("button", { name: "+1 More" }).click();
  await page.getByRole("menuitem", { name: "Set Up Payments Service" }).click();
  await expect(slot.getByRole("complementary", { name: "Set Up Payments Service" })).toBeVisible();
  await expect(slot.locator(".notice")).toHaveCount(1);
  const box = await slot.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= PHONE.width).toBe(true);
});

test("a dismissed skills notice stays dismissed after a reload, and the Pinned Summary keeps the fact", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/project-notices-e2e.html?surface=session&adapter=container&pinned=1");
  const slot = page.locator(".session-notice-slot");
  await slot.getByRole("status", { name: "Skills Unavailable" }).getByRole("button", { name: "Dismiss Notice" }).click();
  await page.reload();
  await expect(slot.getByRole("complementary", { name: "Set Up Payments Service" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Skills Unavailable" })).toHaveCount(0);
  const skills = page.getByRole("complementary", { name: "Pinned Summary" }).locator(".ps-row", { hasText: "Skills" });
  await expect(skills).toContainText("Not Available");
  await expect(skills).toContainText("Skills from Build Box aren’t available in container sessions.");
});
