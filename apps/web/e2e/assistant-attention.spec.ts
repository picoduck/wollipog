import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { instanceStorageKey } from "../src/instance-storage.js";
import { RAIL_PREFERENCES_STORAGE_KEY } from "../src/rail-preferences.js";
import { expectFullyInViewport, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const themes = ["light", "dark"] as const;
type Theme = typeof themes[number];
type Placement = "labelled" | "collapsed" | "bar" | "more";
const rail = (page: Page) => page.getByRole("navigation", { name: "Primary Navigation" });
const assistants = (page: Page) => rail(page).getByRole("link", { name: "Assistants", exact: true });
const badge = (destination: Locator) => destination.locator(".count-badge");
const thread = (page: Page, id: string) => page.locator(`[data-thread-id="${id}"]`);
const approvals = (page: Page) => page.getByRole("list", { name: "Approvals Needed" });

test.use({ timezoneId: "UTC" });

async function open(page: Page, theme: Theme, placement: Placement, count: number, options = "") {
  const phone = placement === "bar" || placement === "more";
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.clock.setFixedTime(new Date("2026-11-19T19:00:00Z"));
  await page.addInitScript(({ key, placement }) => {
    localStorage.setItem(key, JSON.stringify({
      v: 1, order: [], hidden: [], labels: placement === "labelled",
      phoneBar: placement === "more" ? ["inbox", "projects", "runners", "automations"] : undefined,
    }));
  }, { key: instanceStorageKey(RAIL_PREFERENCES_STORAGE_KEY, "assistants-e2e"), placement });
  await page.goto(`/assistants-e2e.html?theme=${theme}&attention=${count}${options}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.getByRole("heading", { level: 1, name: "Assistants", exact: true })).toBeVisible();
}

async function capture(page: Page, name: string) {
  const dir = process.env.ASSISTANT_ATTENTION_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), animations: "disabled" });
}

async function expectCount(destination: Locator, count: number) {
  await expect(destination).toHaveAccessibleName("Assistants");
  if (count === 0) {
    await expect(badge(destination)).toHaveCount(0);
    await expect(destination).toHaveAccessibleDescription("");
  } else {
    await expect(badge(destination)).toHaveText(String(count));
    await expect(destination).toHaveAccessibleDescription(`${count} ${count === 1 ? "thread" : "threads"} waiting on you`);
  }
}

test("the badge counts each waiting thread once and clears as confirmations and questions are answered", async ({ page }) => {
  await open(page, "light", "labelled", 2, "&confirm=2");
  const destination = assistants(page);
  const sessions = rail(page).getByRole("link", { name: "Sessions", exact: true });
  await expectCount(destination, 2);
  await expect(thread(page, "thr_triage")).toContainText("Needs You");
  await expect(thread(page, "thr_release")).toContainText("Needs You");
  await expect(thread(page, "thr_cleanup")).toContainText("Done");
  await capture(page, "desktop-light-two");
  const inboxBefore = await sessions.getAttribute("data-rail-note");
  await thread(page, "thr_triage").click();
  await approvals(page).getByRole("button", { name: "Approve Once", exact: true }).first().click();
  await expect(approvals(page).getByRole("listitem")).toHaveCount(1);
  await expectCount(destination, 2);
  await approvals(page).getByRole("button", { name: "Deny", exact: true }).click();
  await expectCount(destination, 1);
  await expect(thread(page, "thr_triage")).toContainText("Working");
  expect(await sessions.getAttribute("data-rail-note")).toBe(inboxBefore);
  await thread(page, "thr_release").click();
  await page.getByRole("radio", { name: "Next Release" }).click();
  await page.getByRole("button", { name: "Submit Answers", exact: true }).click();
  await expectCount(destination, 0);
  await expect(thread(page, "thr_release")).toContainText("Working");
  await capture(page, "desktop-light-cleared");
});

test("a phone tab shows two waiting threads and updates when a confirmation is approved", async ({ page }) => {
  await open(page, "dark", "bar", 2);
  await expectCount(assistants(page), 2);
  await expect(thread(page, "thr_triage")).toBeVisible();
  await capture(page, "phone-dark-two");
  await thread(page, "thr_triage").click();
  await approvals(page).getByRole("button", { name: "Approve Once", exact: true }).click();
  await expectCount(assistants(page), 1);
});

test("More signals two waiting threads and its Assistants row shows the count", async ({ page }) => {
  await open(page, "light", "more", 2);
  const more = rail(page).getByRole("button", { name: /^More Destinations/ });
  await expect(more).toHaveAccessibleDescription("Assistants: 2 threads waiting on you");
  await more.click();
  const destination = page.getByRole("menuitem", { name: "Assistants", exact: true });
  await expectCount(destination, 2);
});

test("no badge is shown when the owner thread API is unavailable", async ({ page }) => {
  await open(page, "dark", "collapsed", 0, "&threads=unavailable");
  await expect(page.getByText("Assistant threads aren't available on this control plane yet.").first()).toBeVisible();
  await expectCount(assistants(page), 0);
  await capture(page, "desktop-dark-zero");
});

test("one waiting thread is described in the singular", async ({ page }) => {
  await open(page, "light", "bar", 1);
  await expectCount(assistants(page), 1);
  await expect(thread(page, "thr_triage")).toBeVisible();
  await capture(page, "phone-light-one");
});

for (const theme of themes) {
  for (const placement of ["labelled", "collapsed", "bar", "more"] as const) {
    test(`a large count fits the ${theme} ${placement} navigation`, async ({ page }) => {
      await open(page, theme, placement, 105);
      const newThread = page.getByRole("button", { name: "New Thread", exact: true });
      await expectFullyInViewport(newThread, "New Thread");
      await expect(thread(page, "thr_triage")).toBeInViewport();
      let destination = assistants(page);
      if (placement === "more") {
        const more = rail(page).getByRole("button", { name: /^More Destinations/ });
        await expect(more).toHaveAccessibleDescription("Assistants: 105 threads waiting on you");
        await expect(more.locator(".rail-attention-dot")).toHaveCount(1);
        await more.click();
        destination = page.getByRole("menuitem", { name: "Assistants", exact: true });
      }
      await expectCount(destination, 105);
      await expectFullyInViewport(badge(destination), "Assistant attention badge");
      await expectPageNoHorizontalOverflow(page);
      await capture(page, `${placement}-${theme}-stress`);
    });
  }
}
