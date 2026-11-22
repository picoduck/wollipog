import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viewPath } from "../src/navigation.js";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectTextContrast } from "./layout-invariants.js";

const cases = [
  { fixture: "usage_limit", tone: "warning", title: "Account at Its Usage Limit", badge: "Usage Limit",
    body: /Studio Subscription reached its usage limit.*resets at 2:00 PM, in 1 hour 12 minutes/, actions: ["Switch Account…"] },
  { fixture: "turn_failed", tone: "danger", title: "Turn Failed", badge: "Turn Failed",
    body: /The connection to the provider was lost\. Your message is kept\./, actions: ["Retry Turn", "Show Details"] },
  { fixture: "turn_rejected", tone: "danger", title: "Provider Rejected the Turn", badge: "Turn Rejected",
    body: /The provider rejected the turn before it started\./, actions: ["Show Details"] },
  { fixture: "automatic_turns_held", tone: "warning", title: "Automatic Turns Held", badge: "Automatic Turns Held",
    body: /The provider rejected two turns in a row with the same error/, actions: ["Show Details"] },
  { fixture: "sign_in_needed", tone: "danger", title: "Sign In Needed", badge: "Sign In Needed",
    body: /Sign in to Studio Subscription to continue this thread\./, actions: ["Sign In…", "Switch Account…"] },
  { fixture: "machine_offline", tone: "warning", title: "Build Box Is Offline", badge: "Machine Offline",
    body: /Messages wait until it reconnects\./, actions: ["Open Machine"] },
  { fixture: "tools_unavailable", tone: "danger", title: "Assistant Tools Unavailable", badge: "Tools Unavailable",
    body: /Wollipog rejected this thread’s tool key/, actions: ["Restart Thread"] },
  { fixture: "reconnecting", tone: "info", title: "Reconnecting to Wollipog…", badge: "Reconnecting",
    body: /Messages are queued\./, actions: [] },
];

const bar = ".assistant-thread-bar, .page > .detail-bar";
const openThread = "thr_triage";
const noticeSelector = ".composer .session-notice-slot .notice";

async function open(page: Page, theme: string, fixture: string) {
  await page.clock.setFixedTime(Date.UTC(2026, 10, 20, 12, 48));
  await page.goto("/assistants-e2e.html?path=" + encodeURIComponent(viewPath({ name: "assistants", threadId: openThread })) + "&theme=" + theme +
    "&accounts=choices&thread-health=" + fixture + (fixture === "stress" ? "&threads=long" : ""));
  await expect(page.locator(bar).locator(".assistant-bar-title")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  if (fixture === "reconnecting") await page.evaluate(() => {
    (window as unknown as { assistantsDisconnect: () => void }).assistantsDisconnect();
  });
}

async function capture(page: Page, theme: string, state: string) {
  if (process.env.ASSISTANT_NOTICE_EVIDENCE !== "1") return;
  const { width, height } = page.viewportSize()!;
  const id = "assistant-notices-" + width + "x" + height + "-" + theme + "-" + state;
  await page.screenshot({ path: join("playwright-report", "4813", id + ".png"), animations: "disabled" });
}

async function checkTargets(controls: Locator, phone: boolean) {
  const targets = await controls.evaluateAll((nodes) => nodes.map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }));
  const size = phone ? 44 : 24;
  for (const [index, first] of targets.entries()) {
    expect(first.width).toBeGreaterThanOrEqual(size);
    expect(first.height).toBeGreaterThanOrEqual(size);
    if (!phone) continue;
    for (const second of targets.slice(index + 1)) {
      const horizontalGap = Math.max(first.x, second.x) - Math.min(first.x + first.width, second.x + second.width);
      const verticalGap = Math.max(first.y, second.y) - Math.min(first.y + first.height, second.y + second.height);
      expect(Math.max(horizontalGap, verticalGap)).toBeGreaterThanOrEqual(8);
    }
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const phone of [false, true]) {
    test.describe(theme + (phone ? " phone" : " desktop"), () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        isMobile: phone, hasTouch: phone, colorScheme: theme, timezoneId: "UTC", locale: "en-US" });

      for (const { fixture, tone, title, badge, body, actions } of cases) {
        test(title, async ({ page }) => {
          await open(page, theme, fixture);
          const notice = page.locator(noticeSelector);
          await expect(notice).toHaveCount(1);
          await expect(notice).toHaveClass(new RegExp("t-" + tone));
          await expect(notice.locator(".notice-title")).toHaveText(title);
          await expect(notice.locator(".notice-body")).toHaveText(body);
          await expect(notice.getByRole("button")).toHaveText(actions);
          if (fixture === "reconnecting") await expect(notice).toHaveClass(/compact/);
          await expect(page.locator(bar).locator(".status")).toHaveText(badge);
          const composer = page.locator(".composer");
          await expect(composer.locator(".composer-box")).toBeVisible();
          await expectFullyInViewport(notice);
          await expectNoHorizontalOverflow(composer);
          await expectPageNoHorizontalOverflow(page);
          await expectTextContrast(notice);
          await checkTargets(notice.getByRole("button"), phone);
          const bodySize = await notice.locator(".notice-body").evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
          expect(bodySize).toBeGreaterThanOrEqual(12);
          await capture(page, theme, fixture);
          if (actions.includes("Show Details")) {
            await expect(page.getByRole("list", { name: "Session Activity" }).getByText(title, { exact: true })).toHaveCount(0);
            await notice.getByRole("button", { name: "Show Details" }).click();
            await expect(notice.getByRole("button", { name: "Hide Details" })).toBeVisible();
            await expect(notice.locator(".notice-details-body")).toBeVisible();
          }
          if (fixture === "turn_failed") {
            await notice.getByRole("button", { name: "Retry Turn" }).click();
            await expect(page.locator("body")).toHaveAttribute("data-assistant-prompt", "sess-triage:Check the failed build again.");
          } else if (fixture === "sign_in_needed") {
            await notice.getByRole("button", { name: "Sign In…" }).click();
            await expect(page.locator("body")).toHaveAttribute("data-approved", "sess-triage:fixture-auth:auth:login");
          } else if (fixture === "tools_unavailable") {
            await notice.getByRole("button", { name: "Restart Thread" }).click();
            await expect(page.locator("body")).toHaveAttribute("data-restarted-thread", "sess-triage");
          } else if (fixture === "usage_limit") {
            await notice.getByRole("button", { name: "Switch Account…" }).click();
            await expect(page.getByRole("dialog", { name: "Change Account" })).toBeVisible();
          } else if (fixture === "machine_offline") {
            await notice.getByRole("button", { name: "Open Machine" }).click();
            await expect(page.getByRole("article", { name: "Build Box" })).toBeVisible();
          }
        });
      }

      test("the most severe notice stays between the waiting dock and the composer on a long transcript", async ({ page }) => {
        await open(page, theme, "stress");
        const notice = page.locator(noticeSelector);
        await expect(notice.locator(".notice-title")).toHaveText("Assistant Tools Unavailable");
        const dock = page.locator(".assistant-dock");
        const transcript = page.locator(".detail-body");
        const composerInput = page.locator(".composer").locator(".composer-box");
        await expect(dock.getByText("Waiting for You", { exact: false }).first()).toBeVisible();
        await expect(transcript.getByText(/Check release candidate 10/)).toBeVisible();
        await expectFullyInViewport(composerInput);
        expect((await dock.boundingBox())!.y + (await dock.boundingBox())!.height).toBeLessThanOrEqual((await notice.boundingBox())!.y);
        expect((await notice.boundingBox())!.y + (await notice.boundingBox())!.height).toBeLessThanOrEqual((await composerInput.boundingBox())!.y);
        const badge = page.locator(bar).locator(".status");
        await expect(badge).toHaveText("Tools Unavailable");
        await expectFullyInViewport(badge);
        const row = page.locator('[data-thread-id="thr_triage"]');
        if (!phone) {
          await expect(page.locator(".assistant-thread-list > li")).toHaveCount(12);
          await expect(row.locator(".status")).toHaveText("Tools Unavailable");
        }
        const more = notice.getByRole("button", { name: "+3 More" });
        await expect(more).toHaveAttribute("aria-expanded", "false");
        await expectPageNoHorizontalOverflow(page);
        await expectNoHorizontalOverflow(page.locator(".composer"));
        await checkTargets(notice.getByRole("button"), phone);
        await capture(page, theme, "stress-collapsed");
        await more.click();
        const menu = page.getByRole("menu", { name: "Session Notices" });
        const entries = menu.getByRole("menuitem");
        await expect(entries).toHaveText(["Account at Its Usage Limit", "Automatic Turns Held", "Build Box Is Offline"]);
        await checkTargets(entries, phone);
        await expectTextContrast(menu);
        await capture(page, theme, "stress-expanded");
        await entries.last().click();
        await expect(notice.locator(".notice-title")).toHaveText("Build Box Is Offline");
        await expect(badge).toHaveText("Tools Unavailable");
        if (phone) {
          await page.getByRole("button", { name: "Back to Assistants" }).click();
          await expect(page.locator(".assistant-thread-list > li")).toHaveCount(12);
          await expect(row.locator(".status")).toHaveText("Tools Unavailable");
          await expectNoHorizontalOverflow(page.locator(".assistant-thread-list"));
          await expectFullyInViewport(row);
          await capture(page, theme, "stress-list");
        }
      });
    });
  }
}

test("an older control plane leaves the Assistant notice slot absent", async ({ page }) => {
  await open(page, "light", "legacy");
  await expect(page.locator(noticeSelector)).toHaveCount(0);
  await expect(page.locator(".composer").locator(".composer-box")).toBeVisible();
});
