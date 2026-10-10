import { expect, test, type Page } from "@playwright/test";

/**
 * Conditions that arrive while the side panel hides the chat column (#2894; docs/design-system.md
 * §4.9): desktop Expanded (#2845) and the phone sheet (#2843). A failure brings the column back; a
 * request keeps the layout and shows its indicator, the session bar's status control on desktop and
 * a button at the end of the sheet's bar on a phone. Both are announced from outside the column.
 */
const SESSION = "session-alpha";

async function openSession(page: Page, width: number, height = 860) {
  await page.setViewportSize({ width, height });
  await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&reviewReady=1&fullShell=1");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  const open = page.getByRole("button", { name: "Open Session", exact: true });
  if (await open.isVisible()) await open.click();
  await expect(page.locator(".composer-input")).toBeAttached();
}

const panel = (page: Page) => page.locator("#right-panel");
const head = (page: Page) => panel(page).locator(".rpanel-head");
const announcement = (page: Page) => page.locator("[data-hidden-column-announcement]");

async function update(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(([id, value]) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateSession(id as string, value as never),
    [SESSION, patch] as const);
}

const failedDelivery = (state: "failed" | "uncertain" | "pending") => ({
  queued: [{ id: "queue-hidden", text: "Ship the release notes today", steerable: false,
    durableDeliveryState: state, durableDeliveryError: "The machine restarted before it took the message." }],
});

const permission = (requestId: string, title: string) => ({
  requestId, occurrenceId: `${requestId}-1`, kind: "permission", title,
  options: [{ optionId: "approve", name: "Approve", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
});
const oneRequest = { status: "input_required", pendingApproval: permission("hidden-ask", "Run the release script?") };
const twoRequests = {
  status: "input_required",
  pendingApproval: { ...permission("hidden-ask", "Run the release script?"),
    additionalRequests: [permission("hidden-ask-2", "Push the release tag?")] },
};

async function expandReview(page: Page) {
  await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  await panel(page).locator(".rpanel-switcher").click();
  await page.getByRole("menuitemradio", { name: "Review", exact: true }).click();
  await head(page).getByRole("button", { name: "Expand Panel", exact: true }).click();
  await expect(panel(page)).toHaveAttribute("data-presentation", "expanded");
}

test.describe("desktop Expanded", () => {
  test("a queued message's delivery failure restores the panel once, shows the notice and keeps focus in the panel (#2894)", async ({ page }) => {
    await openSession(page, 1440);
    await expandReview(page);
    const restore = head(page).getByRole("button", { name: "Restore Panel", exact: true });
    await restore.focus();

    await update(page, failedDelivery("failed"));
    await expect(panel(page)).toHaveAttribute("data-presentation", "docked");
    await expect(page.locator(".detail-body")).toBeVisible();
    const notice = page.locator(".session-notice-slot").getByRole("alert", { name: "Message Not Delivered" });
    await expect(notice).toBeVisible();
    await expect(announcement(page)).toHaveText(/Message Not Delivered\./);
    // Restore Panel became Expand Panel in place: focus stays on the panel's control.
    await expect(head(page).getByRole("button", { name: "Expand Panel", exact: true })).toBeFocused();

    // Expanded again, the same failure does not take the layout back.
    await head(page).getByRole("button", { name: "Expand Panel", exact: true }).click();
    await update(page, { title: "Alpha Session" });
    await page.waitForTimeout(200);
    await expect(panel(page)).toHaveAttribute("data-presentation", "expanded");
  });

  test("a new request keeps the panel expanded; the session bar's status control opens it on the dock (#2894)", async ({ page }) => {
    await openSession(page, 1440);
    await expandReview(page);
    await update(page, oneRequest);
    await expect(announcement(page)).toHaveText("New request waiting.");
    await page.waitForTimeout(200);
    await expect(panel(page)).toHaveAttribute("data-presentation", "expanded");
    await expect(head(page).locator(".rpanel-request")).toHaveCount(0);

    const status = page.locator(".session-bar .session-status-button");
    await expect(status).toBeVisible();
    await status.click();
    await page.getByRole("button", { name: /^(Answer|Review Request)$/ }).first().click();
    await expect(panel(page)).toHaveAttribute("data-presentation", "docked");
    await expect(page.locator(".request-dock [data-session-request-focus]")).toBeFocused();
  });

  test("a delivery still being retried does not move the layout (#2894)", async ({ page }) => {
    await openSession(page, 1440);
    await expandReview(page);
    await update(page, failedDelivery("pending"));
    await page.waitForTimeout(300);
    await expect(panel(page)).toHaveAttribute("data-presentation", "expanded");
    await expect(announcement(page)).toHaveText("");
  });
});

test.describe("the phone sheet at 390px", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("a request puts Answer Request at the end of the sheet's bar without pushing the title off it (#2894)", async ({ page }) => {
    await openSession(page, 390, 844);
    await page.getByRole("button", { name: "Side Panel", exact: true }).click();
    await expect(panel(page)).toBeVisible();
    await expect(head(page).locator(".rpanel-request")).toHaveCount(0);

    await update(page, oneRequest);
    const button = head(page).getByRole("button", { name: "Answer Request", exact: true });
    await expect(button).toBeVisible();
    await expect(announcement(page)).toHaveText("New request waiting.");
    await expect(panel(page)).toBeVisible();

    const fits = async (label: string) => {
      const bar = (await head(page).boundingBox())!;
      expect(bar.height, `${label}: the bar stays 48px`).toBe(48);
      const back = (await head(page).getByRole("button", { name: "Back to Session" }).boundingBox())!;
      const switcher = (await head(page).locator(".rpanel-switcher").boundingBox())!;
      const name = (await head(page).locator(".rpanel-switcher-name").boundingBox())!;
      const request = (await head(page).locator(".rpanel-request").boundingBox())!;
      expect(request, `${label}: a 44px touch target`).toMatchObject({ width: 44, height: 44 });
      expect(switcher.x, `${label}: the title follows Back`).toBeGreaterThanOrEqual(back.x + back.width - 0.5);
      expect(switcher.x + switcher.width, `${label}: the title ends before the request button`)
        .toBeLessThanOrEqual(request.x + 0.5);
      expect(request.x + request.width, `${label}: the button stays on the bar`).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
      expect(name.width, `${label}: the title keeps its name`).toBeGreaterThan(40);
      const clipped = await head(page).locator(".rpanel-switcher-name").evaluate((element) => element.scrollWidth > element.clientWidth);
      expect(clipped, `${label}: the title is not cut off`).toBe(false);
    };
    await fits("one request");

    await update(page, twoRequests);
    const both = head(page).getByRole("button", { name: "Review 2 Requests", exact: true });
    await expect(both).toBeVisible();
    await expect(both.locator(".count-badge")).toHaveText("2");
    await fits("two requests");

    await both.tap();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator(".request-dock [data-session-request-focus]")).toBeFocused();
  });

  test("a delivery failure closes the sheet and focuses its notice (#2894)", async ({ page }) => {
    await openSession(page, 390, 844);
    await page.getByRole("button", { name: "Side Panel", exact: true }).click();
    await expect(panel(page)).toBeVisible();

    await update(page, failedDelivery("failed"));
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator(".detail-body")).not.toHaveAttribute("inert", /.*/);
    const slot = page.locator(".session-notice-slot");
    await expect(slot).toHaveAttribute("data-notice-key", "queued-delivery:queue-hidden");
    await expect(slot.getByRole("alert", { name: "Message Not Delivered" })).toBeVisible();
    await expect(slot).toBeFocused();
    // Closing the panel returns focus to its opener a frame later; the failure keeps it.
    await page.waitForTimeout(200);
    await expect(slot).toBeFocused();
  });
});
