import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { dialogMotionSettled } from "./dialog-motion.js";
import { verticalHitAreas, type VerticalHitArea } from "./hit-area.js";

/**
 * Outbound Events, the second tab of Automations (#2973; docs/design-system.md §5.2, §5.5, §7, §8.5,
 * §14), in a real browser: two-line subscription rows with one badge, an opened row's Deliveries
 * table (two-line rows on a phone), the New Subscription dialog's address check (a sheet on a phone),
 * the one-time secret, the empty state, and Rotate Secret's confirmation replacing a phone's ⋯
 * sheet. `OutboundEventSubscriptions.dom.test.tsx` covers the logic against a fake DOM. With
 * `WOLLIPOG_EVIDENCE_DIR` set, each state is also captured as UI evidence.
 */

const ROUTE = encodeURIComponent("/automations/outbound");

async function open(page: Page, theme: string, scenario = "") {
  await page.goto(`/automations-e2e.html?theme=${theme}&route=${ROUTE}${scenario ? `&${scenario}` : ""}`);
  await expect(page.getByRole("tab", { name: "Outbound Events" })).toHaveAttribute("aria-selected", "true");
}

function subscription(page: Page, address: string) {
  return page.locator(".outbound-subscription").filter({ has: page.locator(".outbound-subscription-address", { hasText: address }) });
}

const FAILING = "events.example.com/wollipog";
const HEALTHY = "hooks.acme.dev/wollipog/events";

async function capture(page: Page, name: string, fullPage = false) {
  const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
  if (!evidenceDir) return;
  // Let a dialog's entrance and any transition settle into a representative frame.
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage });
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("rows are 56px with one badge, New Subscription is the header's primary, and the badge keeps its tone", async ({ page }) => {
    await open(page, "dark");
    await expect(page.locator(".page-actions .btn.primary")).toHaveText("New Subscription");
    await expect(page.getByRole("button", { name: "Close Subscription Form" })).toHaveCount(0);
    for (const height of await page.locator(".outbound-subscription-row").evaluateAll((rows) =>
      rows.map((row) => row.getBoundingClientRect().height))) {
      expect(height).toBe(56);
    }
    await expect(subscription(page, HEALTHY).locator(".outbound-subscription-row .status")).toHaveText("Active");
    await expect(subscription(page, FAILING).locator(".outbound-subscription-row .status")).toHaveText("Delivery Failed");
    // The meta line's dim text must not reach the badge beside the title.
    const badge = await subscription(page, FAILING).locator(".outbound-subscription-row .status").evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--danger-text)";
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return { actual: getComputedStyle(element).color, dim: getComputedStyle(element.closest(".row")!.querySelector(".row-sub")!).color, danger };
    });
    expect(badge.actual).not.toBe(badge.dim);
    await expect(subscription(page, HEALTHY).locator(".outbound-subscription-meta")).toHaveText(
      /^Project: acme-storefront4 eventsLast delivered 4 minutes ago$/);
    await expect(subscription(page, FAILING).locator(".outbound-subscription-meta")).toHaveText(
      /^Automation: Nightly Dependency Sweep and Long-Running Audit Report4 eventsLast delivery failed 3 minutes ago$/);
  });

  test("an opened failing row says why it paused and lists its deliveries in words", async ({ page }) => {
    await open(page, "dark");
    const row = subscription(page, FAILING);
    await row.locator(".outbound-subscription-open").click();
    await expect(row.locator(".notice.t-warning")).toContainText("Paused after 6 bounded delivery attempts");
    await expect(row.locator(".notice.t-warning").getByRole("button", { name: "Resume" })).toBeVisible();
    const cells = await row.locator("tbody tr").evaluateAll((rows) => rows.map((tr) =>
      [...tr.children].map((cell) => (cell as HTMLElement).innerText.trim())));
    expect(cells).toEqual([
      ["Checks Failed", "HTTP 500", "2", "In 6 minutes"],
      ["Session Created", "Connection Refused", "6", "Gave up"],
      ["Pull Request Opened", "Delivered", "1", ""],
    ]);
    await expect(row).not.toContainText("—");
    await expect(row).not.toContainText(/Included|Excluded/);
    await subscription(page, HEALTHY).locator(".outbound-subscription-open").click();
    await expect(subscription(page, HEALTHY).locator(".facts")).toContainText("Also IncludesSession names");
  });

  test("the ⋯ ends with Revoke Subscription… after a separator, and confirmations name the host", async ({ page }) => {
    await open(page, "dark");
    await subscription(page, FAILING).getByRole("button", { name: "events.example.com Actions" }).click();
    const menu = page.getByRole("menu", { name: "events.example.com Actions" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Copy Callback URL", "Resume", "Rotate Secret…", "Revoke Subscription…"]);
    expect(await menu.evaluate((element) => {
      const items = [...element.querySelectorAll('[role="menuitem"], [role="separator"]')];
      return items.map((item) => item.getAttribute("role"));
    })).toEqual(["menuitem", "menuitem", "menuitem", "separator", "menuitem"]);
    await menu.getByRole("menuitem", { name: "Revoke Subscription…" }).click();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: "Revoke Subscription" });
    await expect(dialog).toContainText("Events stop going to events.example.com, and pending deliveries are dropped. This can't be undone.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the dialog is a sheet, the table is two-line rows, and Rotate Secret replaces the ⋯ sheet", async ({ page }) => {
    await open(page, "dark");
    await page.getByRole("button", { name: "New Subscription" }).click();
    const sheet = page.getByRole("dialog", { name: "New Subscription" });
    await expect(sheet).toBeVisible();
    await dialogMotionSettled(page);
    const box = await sheet.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, width: rect.width, bottom: Math.round(rect.bottom) };
    });
    expect(box).toEqual({ left: 0, width: 390, bottom: 844 });
    await sheet.getByRole("button", { name: "Cancel" }).click();

    const row = subscription(page, FAILING);
    await row.locator(".outbound-subscription-open").click();
    const header = await row.locator("thead").evaluate((element) => element.getBoundingClientRect().height);
    expect(header, "the header row is off screen").toBeLessThanOrEqual(1);
    const lines = await row.locator("tbody tr").evaluateAll((rows) => rows.map((tr) => {
      const first = tr.children[0]!.getBoundingClientRect();
      const result = tr.children[1]!.getBoundingClientRect();
      const attempts = tr.children[2]!.getBoundingClientRect();
      return { height: tr.getBoundingClientRect().height, resultOnLine1: Math.abs(result.top - first.top) < 4, metaBelow: attempts.top > first.bottom - 1 };
    }));
    for (const line of lines) {
      expect(line.height).toBeGreaterThanOrEqual(56);
      expect(line.resultOnLine1).toBe(true);
      expect(line.metaBelow).toBe(true);
    }
    await expect(row.locator("tbody tr").first()).toContainText("Attempts: 2");
    await expect(row.locator("tbody tr").first()).toContainText("Next Retry: In 6 minutes");

    await row.getByRole("button", { name: "events.example.com Actions" }).click();
    const menu = page.getByRole("menu", { name: "events.example.com Actions" });
    await menu.getByRole("menuitem", { name: "Rotate Secret…" }).click();
    const confirmation = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: "Rotate Secret" });
    await expect(confirmation).toContainText("The subscription to events.example.com gets a new signing secret.");
    await expect(menu).toHaveCount(0);
    await confirmation.getByRole("button", { name: "Back to More Actions" }).click();
    await expect(menu).toBeVisible();
  });
});

test.describe("at 390×844 on touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a subscription row's disclosure fills its row and borrows no hit area from the next row", async ({ page }) => {
    await open(page, "dark");
    const rows = await verticalHitAreas(page.locator(".outbound-subscription-open"));
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [VerticalHitArea, VerticalHitArea];
    expect(first.bottom - first.top, "the row is a touch target itself").toBeGreaterThanOrEqual(44);
    // The rows touch, so a tap just inside the next row belongs to the next row, and the reverse.
    expect(second.top - first.bottom).toBeLessThan(2);
    expect(first.hitBottom, "the first row stops where the second starts").toBeLessThanOrEqual(second.top + 0.5);
    expect(second.hitTop, "the second row starts where the first stops").toBeGreaterThanOrEqual(first.bottom - 0.5);
  });
});

for (const { label, viewport } of [
  { label: "1440", viewport: { width: 1440, height: 900 } },
  { label: "390", viewport: { width: 390, height: 844 } },
]) for (const theme of ["dark", "light"] as const) {
  test.describe(`${label} ${theme} states`, () => {
    test.use({ viewport });

    test("Loaded", async ({ page }) => {
      await open(page, theme);
      await expect(page.locator(".outbound-subscription")).toHaveCount(2);
      await capture(page, `outbound-loaded-${label}-${theme}`);
    });

    test("Delivery Failing, Expanded", async ({ page }) => {
      await open(page, theme);
      const row = subscription(page, FAILING);
      await row.locator(".outbound-subscription-open").click();
      await expect(row.locator("tbody tr")).toHaveCount(3);
      await capture(page, `outbound-delivery-failing-${label}-${theme}`, true);
    });

    test("Invalid URL", async ({ page }) => {
      await open(page, theme);
      await page.getByRole("button", { name: "New Subscription" }).click();
      const dialog = page.getByRole("dialog", { name: "New Subscription" });
      const url = dialog.getByRole("textbox", { name: "Callback URL" });
      await url.fill("not a url");
      await url.blur();
      await expect(url).toHaveAttribute("aria-invalid", "true");
      await expect(dialog.locator(".field-error")).toHaveText("Enter a full HTTPS address, such as https://example.com/hooks.");
      await dialog.getByRole("button", { name: "Create Subscription" }).click();
      await expect(url).toBeFocused();
      await dialogMotionSettled(page);
      await capture(page, `outbound-invalid-url-${label}-${theme}`);
    });

    test("Secret Shown", async ({ page }) => {
      await open(page, theme);
      await page.getByRole("button", { name: "New Subscription" }).click();
      const dialog = page.getByRole("dialog", { name: "New Subscription" });
      await dialog.getByRole("textbox", { name: "Callback URL" }).fill("https://ops.acme.dev/hooks/wollipog");
      await dialog.getByRole("button", { name: "Create Subscription" }).click();
      await expect(dialog).toHaveCount(0);
      const secret = page.locator(".outbound-events-secret");
      await expect(secret.locator(".notice-title")).toHaveText("Copy the Signing Secret Now");
      await expect(secret.locator(".code-well.one-line code")).toHaveText(/^wollipogwhsec_/);
      await expect(secret.getByRole("button", { name: "Copy Secret" })).toBeVisible();
      await capture(page, `outbound-secret-shown-${label}-${theme}`);
      await secret.getByRole("button", { name: "Done" }).click();
      await expect(secret).toHaveCount(0);
    });

    test("Empty", async ({ page }) => {
      await open(page, theme, "outbound-empty");
      await expect(page.locator(".state")).toContainText("No Outbound Events Yet");
      await expect(page.getByRole("button", { name: "New Subscription" })).toHaveCount(1);
      await capture(page, `outbound-empty-${label}-${theme}`);
    });
  });
}
