import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectTextContrast } from "./layout-invariants.js";

const thread = viewPath({ name: "assistants", threadId: "thr_triage" });
const threadFixture = (theme: string, state: string) => "/assistants-e2e.html?theme=" + theme +
  "&thread-panel=delegated&delegation=stress&decision-history=" + state + "&path=" + encodeURIComponent(thread);
const campaignFixture = (theme: string) => "/campaign-status-e2e.html?scenario=campaign&delegation=stress&decision-history=stress&theme=" + theme;
const history = (container: Locator) => container.getByRole("list", { name: "Delegated Decisions" });
const rows = (container: Locator) => history(container).getByRole("listitem");
const log = (container: Locator) => container.locator(".assistant-decision-history");

async function openLog(page: Page, theme: string, state = "stress") {
  await page.goto(threadFixture(theme, state));
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  const toggle = page.getByRole("button", { name: /Side Panel/ });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await page.getByRole("tab", { name: /^Decisions/ }).click();
  return page.getByRole("tabpanel", { name: /^Decisions/ });
}

async function expectControls(logRoot: Locator, phone: boolean) {
  const measurements = await logRoot.locator("button, a").evaluateAll((controls) => controls.flatMap((control) => {
    const rect = control.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    return [{
      name: control.textContent?.trim(),
      width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
      font: parseFloat(getComputedStyle(control).fontSize),
    }];
  }));
  for (const [index, box] of measurements.entries()) {
    expect(box.width, box.name + " width").toBeGreaterThanOrEqual(phone ? 44 : 24);
    expect(box.height, box.name + " height").toBeGreaterThanOrEqual(phone ? 44 : 24);
    expect(box.font, box.name + " font").toBeGreaterThanOrEqual(12);
    if (!phone) continue;
    for (const other of measurements.slice(index + 1)) {
      const separation = Math.max(other.left - box.right, box.left - other.right, other.top - box.bottom, box.top - other.bottom);
      expect(separation, box.name + " gap to " + other.name).toBeGreaterThanOrEqual(8);
    }
  }
}

async function capture(page: Page, surface: string, theme: string, state: string) {
  const dir = process.env.DELEGATED_DECISIONS_EVIDENCE_DIR;
  if (!dir) return;
  const { width, height } = page.viewportSize()!;
  if (process.env.DELEGATED_DECISIONS_EVIDENCE_ROUND === "2" &&
      state !== "older-decisions-page2" && !(width === 390 && (state === "loading" || state === "error"))) return;
  await page.screenshot({
    path: join(dir, [surface, width + "x" + height, theme, state].join("-") + ".png"),
    animations: "disabled",
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const phone = width === 390;
    test.describe(theme + " at " + width + "×" + height, () => {
      test.use({ viewport: { width, height }, isMobile: phone, hasTouch: phone, colorScheme: theme,
        timezoneId: "UTC", locale: "en-US", reducedMotion: "reduce" });

      async function check(page: Page, root: Locator) {
        await expectPageNoHorizontalOverflow(page);
        await expectNoHorizontalOverflow(log(root));
        await expectTextContrast(log(root));
        await expectControls(log(root), phone);
      }

      test("the thread shows all outcomes, clamps long reasons and pages from the bottom", async ({ page }) => {
        await page.clock.setFixedTime(Date.UTC(2026, 9, 19, 20));
        const decisions = await openLog(page, theme);
        await expect(decisions.getByRole("button", { name: "Manage…" })).toBeVisible();
        await expect(rows(decisions)).toHaveCount(5);
        const chips = decisions.getByRole("group", { name: "Filter Delegated Decisions" });
        await expect(chips.getByRole("button")).toHaveText(["All 24", "Approved 8", "Denied 8", "Answered 8"]);
        await expect(chips.getByRole("button", { name: "All 24" })).toHaveAttribute("aria-pressed", "true");
        for (const outcome of ["Approved", "Denied", "Answered"]) {
          await expect(rows(decisions).getByRole("img", { name: outcome, exact: true }).first()).toBeVisible();
        }
        await expect(history(decisions).getByRole("link", { name: "Triage Open Issues" })).toHaveCount(0);
        await expect(rows(decisions).first().getByText("Merge Pull Requests")).toBeVisible();
        await expect(rows(decisions).first().locator("time")).toHaveAttribute("datetime", "2026-10-19T16:00:00.000Z");
        for (const identifier of ["picoduck/wollipog#126", "44699507825", /^feature\/ReleaseValidation/]) {
          const code = history(decisions).locator("code").filter({ hasText: identifier });
          await expect(code).toBeVisible();
          await expect(code).toHaveCSS("font-family", /mono/i);
        }
        const longReason = rows(decisions).nth(1).locator(".assistant-decision-reason");
        const show = decisions.getByRole("button", { name: "Show Full Reason" });
        expect(await longReason.textContent()).toMatch(/^\S{300}$/);
        const bounds = () => longReason.evaluate((reason) => ({
          rendered: reason.clientHeight, content: reason.scrollHeight, line: parseFloat(getComputedStyle(reason).lineHeight),
          wraps: getComputedStyle(reason).overflowWrap, width: reason.clientWidth, scrollWidth: reason.scrollWidth,
        }));
        const clamped = await bounds();
        expect(clamped.wraps).toBe("anywhere");
        expect(clamped.scrollWidth).toBe(clamped.width);
        expect(clamped.rendered).toBeCloseTo(2 * clamped.line, 0);
        expect(clamped.content).toBeGreaterThan(clamped.rendered);
        await expect(show).toHaveAttribute("aria-expanded", "false");
        await expectFullyInViewport(show, "Show Full Reason");
        await check(page, decisions);
        if (!phone) await expectFullyInViewport(page.locator(".composer"), "Composer alongside Decisions");
        await capture(page, "decisions", theme, phone ? "all-mixed-clamped-target44csspx-gap8csspx" : "all-mixed-clamped-target24csspx");

        await show.click();
        await expect(decisions.getByRole("button", { name: "Show Less" })).toHaveAttribute("aria-expanded", "true");
        const expanded = await bounds();
        expect(expanded.rendered).toBe(expanded.content);
        expect(expanded.rendered).toBeGreaterThan(clamped.rendered);
        expect(expanded.scrollWidth).toBe(expanded.width);
        await expectFullyInViewport(longReason, "Expanded 300-character reason");
        await check(page, decisions);
        await capture(page, "decisions", theme, "reason-expanded");
        await decisions.getByRole("button", { name: "Show Less" }).click();
        await expect(show).toHaveAttribute("aria-expanded", "false");

        for (const outcome of ["Approved", "Denied", "Answered"]) {
          const chip = chips.getByRole("button", { name: outcome + " 8" });
          await chip.click();
          await expect(chip).toBeFocused();
          await expect(chip).toHaveAttribute("aria-pressed", "true");
          await expect(rows(decisions)).toHaveCount(5);
          await expect(rows(decisions).getByRole("img", { name: outcome, exact: true })).toHaveCount(5);
          await check(page, decisions);
          await capture(page, "decisions", theme, "filter-" + outcome.toLowerCase());
        }

        await chips.getByRole("button", { name: "All 24" }).click();
        await expect(history(decisions).getByText("picoduck/wollipog#126")).toBeVisible();
        const more = decisions.getByRole("button", { name: "Older Decisions" });
        await more.scrollIntoViewIfNeeded();
        await expectFullyInViewport(more, "Older Decisions");
        expect((await more.boundingBox())!.y).toBeGreaterThanOrEqual(
          (await history(decisions).boundingBox())!.y + (await history(decisions).boundingBox())!.height,
        );
        await capture(page, "decisions", theme, "older-decisions");
        await more.click();
        await expect(rows(decisions)).toHaveCount(5);
        await expectFullyInViewport(history(decisions).getByText("picoduck/wollipog#120"), "Page Two Pull Request");
        await expect(history(decisions).getByText("picoduck/wollipog#126")).toHaveCount(0);
        await capture(page, "decisions", theme, "older-decisions-page2");
        await decisions.getByRole("button", { name: "Newer Decisions" }).click();
        await expect(history(decisions).getByText("picoduck/wollipog#126")).toBeVisible();

        await chips.getByRole("button", { name: "Denied 8" }).click();
        await expect(rows(decisions).getByRole("img", { name: "Denied", exact: true })).toHaveCount(5);
        await more.click();
        await expect(rows(decisions).getByRole("img", { name: "Denied", exact: true })).toHaveCount(3);
        await expect(more).toHaveCount(0);

        await page.getByRole("button", { name: "Close Panel" }).click();
        await page.getByRole("button", { name: "Thread Actions", exact: true }).click();
        const menu = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Open as Session", exact: true }) });
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: "Delegated Decisions", exact: true })).toHaveCount(0);
        await expectPageNoHorizontalOverflow(page);
        await capture(page, "thread-actions", theme, "history-entry-removed");
      });

      test("Campaign Status uses the same rows and links to the responsible thread", async ({ page }) => {
        await page.clock.setFixedTime(Date.UTC(2026, 9, 19, 20));
        await page.goto(campaignFixture(theme));
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.getByRole("button", { name: /^Go to Section/ }).click();
        await page.getByRole("menuitem", { name: /^Delegated Decisions/ }).click();
        const section = page.locator('[data-campaign-section="Delegated Decisions"]');
        await expect(rows(section)).toHaveCount(5);
        await expect(rows(section).first().getByRole("img", { name: "Approved" })).toBeVisible();
        await expect(rows(section).nth(1).getByRole("img", { name: "Answered" })).toBeVisible();
        await expect(rows(section).nth(2).getByRole("img", { name: "Denied" })).toBeVisible();
        const longThread = rows(section).nth(1).getByRole("link", { name: /^Triage Open Issues With/ });
        await expect(longThread).toHaveAttribute("href", thread);
        await expect(longThread).toBeVisible();
        await expectNoHorizontalOverflow(page.locator(".campaign-status"), "Campaign Status");
        await check(page, section);
        await capture(page, "campaign-decisions", theme, "mixed-long-thread");
      });

      test("the thread designs empty, loading and recoverable error states", async ({ page }) => {
        let decisions = await openLog(page, theme, "empty");
        await expect(decisions).toContainText("No delegated decisions yet.");
        await expect(history(decisions)).toHaveCount(0);
        await check(page, decisions);
        await capture(page, "decisions", theme, "empty");

        decisions = await openLog(page, theme, "loading");
        const skeleton = log(decisions).getByRole("status");
        await expect(skeleton).toContainText("Loading delegated decisions…");
        await expect(skeleton.locator(".skeleton-row").first()).toBeVisible();
        await check(page, decisions);
        await page.getByRole("tab", { name: /^Decisions/ }).evaluate((tab: HTMLElement) => tab.blur());
        await capture(page, "decisions", theme, "loading");
        await page.evaluate(() => Reflect.get(window, "releaseDecisionHistory")());
        await expect(rows(decisions)).toHaveCount(5);

        decisions = await openLog(page, theme, "error");
        const alert = decisions.getByRole("alert");
        await expect(alert).toContainText("Couldn't load delegated decisions.");
        const retry = alert.getByRole("button", { name: "Retry", exact: true });
        await expectFullyInViewport(retry, "Retry");
        await check(page, decisions);
        await page.getByRole("tab", { name: /^Decisions/ }).evaluate((tab: HTMLElement) => tab.blur());
        await capture(page, "decisions", theme, "error");
        await retry.click();
        await expect(rows(decisions)).toHaveCount(5);
        await expect(alert).toHaveCount(0);
      });

      test("keyboard focus fits inside the tab strip with space around the label", async ({ page }) => {
        await openLog(page, theme);
        const strip = page.getByRole("tablist", { name: "Thread Panel" });
        const work = strip.getByRole("tab", { name: /^Work/ });
        const decisions = strip.getByRole("tab", { name: /^Decisions/ });
        await decisions.press("Home");
        for (const tab of [work, decisions]) {
          await expect(tab).toBeFocused();
          const ring = await tab.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const stripBounds = element.parentElement!.getBoundingClientRect();
            const style = getComputedStyle(element, "::before");
            return {
              width: parseFloat(style.outlineWidth),
              outsideLabel: -parseFloat(style.left),
              insideStrip: bounds.left + parseFloat(style.left) >= stripBounds.left &&
                bounds.right - parseFloat(style.right) <= stripBounds.right,
              topGap: bounds.top + parseFloat(style.top) - stripBounds.top,
              bottomGap: stripBounds.bottom - (bounds.bottom - parseFloat(style.bottom)),
            };
          });
          expect(ring.width).toBe(2);
          expect(ring.insideStrip).toBe(true);
          expect(ring.outsideLabel).toBeGreaterThan(ring.width);
          expect(ring.topGap).toBeGreaterThanOrEqual(4);
          expect(ring.bottomGap).toBeGreaterThanOrEqual(4);
          if (tab === work) await work.press("ArrowRight");
        }
      });
    });
  }
}

test("older history servers keep page-local filtering and paging usable", async ({ page }) => {
  const decisions = await openLog(page, "light", "legacy");
  const chips = decisions.getByRole("group", { name: "Filter Delegated Decisions" });
  await expect(chips.getByRole("button")).toHaveText(["All 5", "Approved 2", "Denied 1", "Answered 2"]);
  await expect(decisions.getByText("Counts reflect this page.")).toBeVisible();
  await chips.getByRole("button", { name: "Denied 1" }).click();
  await expect(rows(decisions).getByRole("img", { name: "Denied" })).toHaveCount(1);
  await decisions.getByRole("button", { name: "Older Decisions" }).click();
  await expect(rows(decisions).getByRole("img", { name: "Denied" })).toHaveCount(2);
});

test("the evidence action label matches the recorded approval or denial", async ({ page }) => {
  const decisions = await openLog(page, "light", "evidence");
  const evidenceRows = rows(decisions).filter({ hasText: "Screenshots" });
  await expect(evidenceRows.filter({ has: page.getByRole("img", { name: "Approved" }) })).toContainText("Approve UI Evidence");
  await expect(evidenceRows.filter({ has: page.getByRole("img", { name: "Denied" }) })).toContainText("Send Back UI Evidence");
});

test("campaigns without delegated decisions omit the section", async ({ page }) => {
  await page.goto(campaignFixture("light").replace("decision-history=stress", "decision-history=empty"));
  await page.getByRole("button", { name: /^Go to Section/ }).click();
  await expect(page.getByRole("menuitem", { name: /^Summary/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Delegated Decisions/ })).toHaveCount(0);
});
