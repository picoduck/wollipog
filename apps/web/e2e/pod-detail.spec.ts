import { expect, test, type Page } from "@playwright/test";

/**
 * A pod's page (#2981; docs/design-system.md §2.10, §4.3, §15.1, §15.2), measured in a real
 * browser: full-height member columns beside a 360px Huddle whose log and composer show without
 * scrolling the page at 1440×900, Load Earlier that leaves the composer where it is, a 320px Huddle
 * in the compact tier, and Huddle and member tabs on a phone, with the chosen tab kept across a
 * reload.
 */

async function open(page: Page, query = "") {
  await page.goto(`/pod-detail-e2e.html?scenario=manual${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Retry Helper Migration" })).toBeVisible();
}

test.describe("at 1440×900 with three members", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("every member column is at least 400px tall and the Huddle shows its log and composer without scrolling the page", async ({ page }) => {
    await open(page);
    await expect(page.locator(".pod-huddle-entry")).toHaveCount(4);
    await expect(page.locator(".compare-member-meta:empty")).toHaveCount(0);
    await expect(page.locator(".compare-grid")).toHaveCount(0);
    await expect(page.locator('[style*="grid-template-columns"]')).toHaveCount(0);
    const geometry = await page.evaluate(() => {
      const rect = (element: Element) => element.getBoundingClientRect();
      const huddle = document.querySelector(".pod-huddle")!;
      const log = document.querySelector(".pod-huddle-log")!;
      return {
        pageScrolls: document.scrollingElement!.scrollHeight > window.innerHeight,
        columns: [...document.querySelectorAll(".compare > .compare-member")].map((column) => ({
          height: rect(column).height,
          bottom: rect(column).bottom,
          width: rect(column).width,
        })),
        huddle: { width: rect(huddle).width, top: rect(huddle).top, bottom: rect(huddle).bottom },
        log: { height: rect(log).height, top: rect(log).top, bottom: rect(log).bottom },
        newest: rect(document.querySelector(".pod-huddle-entry:last-child")!),
        composer: rect(document.querySelector(".pod-composer")!),
        relay: rect([...document.querySelectorAll(".pod-composer button")].find((button) => button.textContent?.startsWith("Relay"))!),
      };
    });
    expect(geometry.pageScrolls, "the page itself never scrolls").toBe(false);
    expect(geometry.columns).toHaveLength(3);
    for (const column of geometry.columns) {
      expect(column.height, "each member column is at least 400px tall").toBeGreaterThanOrEqual(400);
      expect(column.bottom, "and reaches the bottom of the page").toBeGreaterThanOrEqual(899);
      expect(column.width).toBeGreaterThanOrEqual(320);
    }
    expect(geometry.huddle.width, "the Huddle is 360px").toBe(360);
    expect(geometry.huddle.bottom, "at full height").toBeGreaterThanOrEqual(899);
    expect(geometry.log.height, "the log has room of its own").toBeGreaterThanOrEqual(200);
    // Newest last: the log opens at its end, so the newest entry is in view above the composer.
    expect(geometry.newest.bottom).toBeLessThanOrEqual(geometry.log.bottom + 1);
    expect(geometry.newest.top).toBeGreaterThanOrEqual(geometry.log.top - 1);
    expect(geometry.composer.bottom, "the composer is on screen").toBeLessThanOrEqual(900);
    expect(geometry.relay.bottom).toBeLessThanOrEqual(900);
  });

  test("Load Earlier puts older entries above the current ones without moving the composer or what was in view", async ({ page }) => {
    await open(page);
    await expect(page.locator(".pod-huddle-entry")).toHaveCount(4);
    const measure = () => page.evaluate(() => ({
      composer: document.querySelector(".pod-composer")!.getBoundingClientRect().top,
      newest: document.querySelector(".pod-huddle-entry:last-child")!.getBoundingClientRect().top,
    }));
    const before = await measure();
    await page.getByRole("button", { name: "Load Earlier" }).click();
    await expect(page.locator(".pod-huddle-entry")).toHaveCount(7);
    await expect(page.getByRole("button", { name: "Load Earlier" })).toHaveCount(0);
    const after = await measure();
    expect(after.composer, "the composer stays put").toBe(before.composer);
    expect(Math.abs(after.newest - before.newest), "the entries in view stay put").toBeLessThanOrEqual(1);
    await expect(page.locator(".pod-huddle-entry").first()).toContainText("Kickoff");
  });
});

test.describe("in the compact tier at 1024×768", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("the Huddle is 320px wide", async ({ page }) => {
    await open(page);
    const width = await page.locator(".pod-huddle").evaluate((huddle) => huddle.getBoundingClientRect().width);
    expect(width).toBe(320);
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the page shows Huddle and member tabs, and reloading on a member tab keeps it", async ({ page }) => {
    await open(page);
    const tabs = page.getByRole("tablist", { name: "Pod" }).getByRole("tab");
    await expect(tabs).toHaveText(["Huddle", "Claude Code, Awaiting Prompt", "Codex App Server, Awaiting Prompt", "OpenCode, Awaiting Prompt"]);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".pod-layout")).toHaveCount(0);
    const composer = await page.locator(".pod-composer").boundingBox();
    expect(composer!.y + composer!.height, "the composer is on screen on the Huddle tab").toBeLessThanOrEqual(844);

    await tabs.nth(2).click();
    await expect(page).toHaveURL(/[?&]member=s-worker(&|$)/u);
    await expect(page.getByRole("tabpanel").locator(".compare-member-agent")).toHaveText("Codex App Server");
    await page.reload();
    await expect(page.getByRole("tablist", { name: "Pod" }).getByRole("tab").nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel").locator(".compare-member-agent")).toHaveText("Codex App Server");

    await page.getByRole("tablist", { name: "Pod" }).getByRole("tab").first().click();
    await expect(page).toHaveURL(/[?&]tab=huddle(&|$)/u);
    await page.reload();
    await expect(page.getByRole("tablist", { name: "Pod" }).getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  });
});
