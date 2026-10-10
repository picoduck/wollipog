import { expect, test, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation";

/**
 * The Session page while its session is not loaded, and an archived session (#2202; docs/design-system.md
 * §12, §13.2, §4.3). The real Shell is mounted, so the desktop bar, the phone top bar and the shell's
 * banners are the ones people see. The helper's copy and the DOM details are unit and DOM tested
 * (detail-placeholder.test.ts, SessionDetail.placeholder.dom.test.tsx); this is what only the shell shows.
 */

const MISSING = viewPath({ name: "session", id: "session-gone" });
const ALPHA = viewPath({ name: "session", id: "session-alpha" });

function shell(path: string, query = "") {
  return `/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent(path)}${query}`;
}

async function open(page: Page, width: number, path: string, query = "") {
  await page.setViewportSize({ width, height: width > 760 ? 900 : 844 });
  await page.goto(shell(path, query));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

test("at 1440px a missing session has one h1, Session Not Found, and both next steps work", async ({ page }) => {
  await open(page, 1440, MISSING, "&history=1");
  const title = page.locator("#page-title");
  await expect(title).toHaveText("Session Not Found");
  await expect(page.locator("h1")).toHaveCount(1);
  expect(await title.evaluate((element) => element.tagName)).toBe("H1");
  const bar = page.locator("header.session-bar");
  // The bar keeps only Back: no title, status, actions or panel toggles for a session that is not there.
  await expect(bar.locator("button")).toHaveCount(1);
  await expect(bar.getByRole("button", { name: "Back to Sessions" })).toBeVisible();
  await expect(page.getByText("It may have been deleted, or you may not have access.")).toBeVisible();

  await page.getByRole("button", { name: "Search Sessions" }).click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);

  await page.locator(".state").getByRole("button", { name: "Back to Sessions" }).click();
  await expect(page).toHaveURL(/path=%2F(&|$)/u);
  await expect(page.locator("#page-title")).toHaveText("Sessions");
});

test("at 390px a missing session's top bar shows the state's title and no panel toggles", async ({ page }) => {
  await open(page, 390, MISSING);
  const topbar = page.locator("header.topbar");
  await expect(topbar.locator("#page-title")).toHaveText("Session Not Found");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(topbar.locator(".topbar-mobile-controls")).toHaveCount(0);
  await expect(page.locator(".state-title")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search Sessions" })).toBeVisible();
});

test("at 390px a session deleted elsewhere hands focus from its panel toggle to the page title", async ({ page }) => {
  await open(page, 390, ALPHA);
  const toggle = page.locator("header.topbar .topbar-mobile-controls button").last();
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.deleteSession("session-alpha"));
  await expect(page.locator("header.topbar #page-title")).toHaveText("Session Not Found");
  await expect(page.locator("header.topbar .topbar-mobile-controls")).toHaveCount(0);
  await expect(page.locator("header.topbar #page-title")).toBeFocused();
});

test("a load error says Couldn't Load Session, hides the raw error behind Show Details, and Retry looks again", async ({ page }) => {
  await open(page, 1440, ALPHA, "&lookup=error");
  await expect(page.locator("header.session-bar .session-bar-title")).toHaveText("Alpha Session");
  // The fixture's sessions are in the snapshot; take this one out so the page looks it up by id.
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { archived: true, status: "stopped" });
  });
  await expect(page.locator("#page-title")).toHaveText("Couldn't Load Session");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByText("Something went wrong while opening this session.")).toBeVisible();
  await expect(page.getByText(/upstream connect error/u)).toHaveCount(0);
  await page.getByRole("button", { name: "Show Details" }).click();
  await expect(page.getByText(/HTTP 502: upstream connect error/u)).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("header.session-bar .session-bar-title")).toHaveText("Alpha Session");
});

test("Loading shows skeleton rows and no sentence about the control plane", async ({ page }) => {
  // Not before 300ms is pinned in SessionDetail.placeholder.dom.test.tsx, where time is controlled.
  await open(page, 1440, MISSING, "&lookup=pending");
  await expect(page.locator("#page-title")).toHaveText("Loading Session…");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator(".transcript-skeleton")).toBeVisible();
  await expect(page.locator(".state-body")).toHaveCount(0);
  await expect(page.locator("[data-placeholder]")).not.toContainText(/control[ -]plane/iu);
});

test("offline and unpaired states name the next step without Wollipog's internals", async ({ page }) => {
  await open(page, 1440, MISSING, "&offlineBanner=1");
  await expect(page.locator("#page-title")).toHaveText("Waiting to Reconnect");
  await expect(page.getByText("Wollipog opens this session when the connection comes back.")).toBeVisible();

  await open(page, 1440, MISSING, "&pairingRequired=1");
  await expect(page.locator("#page-title")).toHaveText("Pair to Load Session");
  await expect(page.getByText("This device needs to be paired before it can open sessions.")).toBeVisible();
  // The pairing banner above is the next step; the page itself never names Wollipog's internals.
  await expect(page.locator("[data-placeholder]")).not.toContainText(/control[ -]plane/iu);
  // Nor does the banner (#2303): the startup-link command waits behind Show Details.
  const banner = page.locator(".notice.page-banner");
  await expect(banner).toContainText("Pair this device to use Wollipog");
  await expect(banner).not.toContainText(/control[ -]plane|print-pair-url/iu);
  await banner.getByRole("button", { name: "Show Details" }).click();
  await expect(banner.locator(".notice-details-body code")).toHaveText(["wollipog pair url", "--print-pair-url"]);
  await expect(banner).not.toContainText(/control[ -]plane/iu);
});

async function openArchived(page: Page, width: number, query = "&unarchiveRestart=1") {
  await open(page, width, ALPHA, query);
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { archived: true, status: "stopped" });
  });
  await expect(page.locator(".session-notice-slot")).toBeVisible();
}

test("an archived session reads Archived, says so above the composer, and Unarchive and Restart restores it", async ({ page }) => {
  await openArchived(page, 1440);
  await expect(page.locator("header.session-bar .session-status-button")).toHaveAccessibleName(/^Session Status: Archived/u);
  const notice = page.locator(".session-notice-slot .notice");
  await expect(notice.locator(".notice-title")).toHaveText("Session Archived");
  await expect(notice).toContainText("This session is archived and stopped.");
  await expect(page.locator(".composer-box textarea")).toHaveAttribute("placeholder", "Unarchive the session to send a message.");
  await notice.getByRole("button", { name: "Unarchive and Restart" }).click();
  await expect(page.locator(".session-notice-slot")).toHaveCount(0);
  await expect(page.locator("header.session-bar .session-status-button")).not.toHaveAccessibleName(/Archived/u);
});

// #2301: the control plane refuses to restart an archived session, so the composer offers no Restart.
test("an archived session's composer offers no Restart Session, and the notice is the way back", async ({ page }) => {
  await openArchived(page, 1440);
  const composer = page.locator(".composer-box");
  await expect(composer.getByRole("button", { name: "Restart Session" })).toHaveCount(0);
  const send = composer.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await send.click({ force: true });
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.restartRequests())).toEqual([]);

  // A stopped session that is not archived keeps its working Restart Session.
  await page.evaluate(() => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", { archived: false });
  });
  const restart = composer.getByRole("button", { name: "Restart Session" });
  await expect(restart).toBeEnabled();
  await restart.click();
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.restartRequests())).toEqual(["session-alpha"]);
});

test("at 390px Unarchive and Restart from the keyboard hands focus to the collapsed composer", async ({ page }) => {
  await openArchived(page, 390);
  const action = page.locator(".session-notice-slot").getByRole("button", { name: "Unarchive and Restart" });
  await action.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".session-notice-slot")).toHaveCount(0);
  // The collapsed composer's own control takes focus, so the layout does not change under the person.
  const edit = page.locator(".composer-idle-preview");
  await expect(edit).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".composer-box textarea")).toBeFocused();
});

test("an older control plane offers Unarchive, and a Viewer sees it disabled with the reason", async ({ page }) => {
  await openArchived(page, 390, "");
  await expect(page.locator(".session-notice-slot").getByRole("button", { name: "Unarchive", exact: true })).toBeEnabled();
  const refusal = "Only the session's owner or an admin can unarchive it.";
  await page.evaluate((reason) => {
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
      commandPermissions: {
        stop: { allowed: false, reason }, restart: { allowed: false, reason }, stopBackgroundJob: { allowed: false, reason },
        unarchive: { allowed: false, reason },
      },
    });
  }, refusal);
  // The archived session is outside the snapshot; open it again to read its new permissions.
  await page.reload();
  const action = page.locator(".session-notice-slot").getByRole("button", { name: "Unarchive", exact: true });
  await expect(action).toBeDisabled();
  await expect(page.locator(".session-notice-slot")).toContainText(refusal);
});
