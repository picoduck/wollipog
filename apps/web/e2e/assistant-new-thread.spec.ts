import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectTextContrast } from "./layout-invariants.js";

const message = "Plan the next release\nReview the open work that's ready to ship.";
const firstLine = "Plan the next release";
const pane = (page: Page) => page.locator(".assistant-thread-pane");
const dialog = (page: Page) => page.getByRole("dialog", { name: "New Thread" });
const create = (page: Page) => dialog(page).getByRole("button", { name: "Create Thread" });
const picker = (page: Page, label: string) => dialog(page).getByRole("button", { name: new RegExp(`^${label}:`) });
const list = (page: Page) => page.getByRole("complementary", { name: "Assistants" });
const transcript = (page: Page) => pane(page).getByRole("region", { name: "Session Activity" });
const sentMessage = (page: Page) => transcript(page).getByText("Review the open work that's ready to ship.", { exact: false });
const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
const evidenceStates = process.env.WOLLIPOG_EVIDENCE_STATES?.split(",");

async function expectTargetLayout(targets: Locator, phone: boolean) {
  // Only targets a person can reach where they are now: one scrolled under a sticky footer is not
  // drawn there. Callers scroll and measure again to cover the rest.
  const boxes = await targets.evaluateAll((nodes) => nodes.flatMap((target) => {
    if (!target.getClientRects().length) return [];
    const { top, bottom, left, right, width, height } = target.getBoundingClientRect();
    const hit = document.elementFromPoint(left + width / 2, top + height / 2);
    if (!hit || !(target === hit || target.contains(hit))) return [];
    return [{ top, bottom, left, right, width, height, name: target.getAttribute("aria-label") ?? target.textContent?.trim() }];
  }));
  expect(boxes.length).toBeGreaterThan(0);
  for (const [index, a] of boxes.entries()) {
    const minimum = phone ? 44 : 24;
    // Layout and transformed descendants can differ in the last decimals of a CSS pixel.
    expect(Number(a.width.toFixed(2)), a.name + " target width").toBeGreaterThanOrEqual(minimum);
    expect(Number(a.height.toFixed(2)), a.name + " target height").toBeGreaterThanOrEqual(minimum);
    if (!phone) continue;
    for (const b of boxes.slice(index + 1)) {
      const gapX = Math.max(a.left - b.right, b.left - a.right);
      const gapY = Math.max(a.top - b.bottom, b.top - a.bottom);
      expect(Number(Math.max(gapX, gapY).toFixed(2)), a.name + " gap from " + b.name).toBeGreaterThanOrEqual(8);
    }
  }
}

async function expectReadable(surface: Locator) {
  const smallText = await surface.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const tooSmall = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (node.textContent?.trim() && parent?.getClientRects().length &&
          !parent.closest(".sr-only") && parseFloat(getComputedStyle(parent).fontSize) < 12) {
        tooSmall.push(node.textContent.trim());
      }
    }
    return tooSmall;
  });
  expect(smallText).toEqual([]);
  await expectTextContrast(surface);
}

for (const theme of ["light", "dark"] as const) {
  for (const phone of [false, true]) {
    const viewport = phone ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    const prefix = ["new-assistant-thread", viewport.width + "x" + viewport.height, theme].join("-");
    test.describe(prefix, () => {
      test.use({ viewport, colorScheme: theme, isMobile: phone, hasTouch: phone, reducedMotion: "reduce" });

      async function open(page: Page, query: string, path = "/assistants") {
        await page.clock.setFixedTime(new Date("2026-11-19T16:00:00Z"));
        await page.goto("/assistants-e2e.html?theme=" + theme + "&path=" + encodeURIComponent(path) + "&" + query);
      }

      async function capture(page: Page, state: string, measured = false) {
        if (evidenceDir && (!evidenceStates || evidenceStates.includes(state))) {
          const dimensions = measured ? phone ? "-target44csspx-gap8csspx" : "-target24csspx" : "";
          await page.screenshot({ path: join(evidenceDir, prefix + "-" + state + dimensions + ".png"), animations: "disabled" });
        }
      }

      test("creates a thread from the dialog with the chosen harness, account, model, effort and limits", async ({ page }) => {
        await open(page, "accounts=composer-stress&limits=enabled");
        await list(page).getByRole("button", { name: "New Thread" }).click();
        await expect(dialog(page)).toBeVisible();
        // A dialog over the list, as New Session is, never a screen of its own in the thread pane.
        if (!phone) await expect(list(page).locator("[data-thread-id]")).toHaveCount(3);
        await expect(dialog(page).getByText("Write your first message once it opens.", { exact: false })).toBeVisible();
        await expect(picker(page, "Harness")).toHaveAccessibleName("Harness: Claude Code");
        await expect(picker(page, "Account")).toHaveAccessibleName(/^Account: Machine Policy/);
        await expect(picker(page, "Model")).toHaveAccessibleName("Model: Automatic");
        await expect(picker(page, "Effort")).toHaveAccessibleName("Effort: Automatic");
        await expect(picker(page, "Decision Delegation")).toHaveAccessibleName("Decision Delegation: Ask Me");
        const budget = dialog(page).getByRole("textbox", { name: "Budget USD" });
        const launches = dialog(page).getByRole("textbox", { name: "Session Launches" });
        await expect(budget).toHaveValue("25");
        await expect(launches).toHaveValue("10");
        // No first message is needed: the thread opens ready for one, as a new session does.
        await expect(create(page)).toBeEnabled();
        await expectFullyInViewport(create(page), "Create Thread");
        await expectNoHorizontalOverflow(dialog(page), "New Thread");
        await expectPageNoHorizontalOverflow(page);
        await expectTargetLayout(dialog(page).locator("button"), phone);
        await expectReadable(dialog(page));
        await capture(page, "dialog", true);
        // The rows below the fold, once scrolled to, are as reachable as the ones above it.
        await picker(page, "Decision Delegation").scrollIntoViewIfNeeded();
        await expectFullyInViewport(picker(page, "Decision Delegation"), "Decision Delegation");
        await expectTargetLayout(dialog(page).locator("button"), phone);
        await capture(page, "dialog-scrolled", true);

        await picker(page, "Account").click();
        await expect(page.getByRole("option", { name: /^Machine Policy/ })).toHaveAttribute("aria-selected", "true");
        const signIn = page.getByRole("option", { name: /Field Subscription/ });
        await expect(signIn).toHaveAttribute("aria-disabled", "true");
        await expect(signIn).toContainText("This account needs sign-in.");
        await capture(page, "accounts");
        await page.getByRole("option", { name: /DesignResearchAndEngineering/ }).click();
        await expect(picker(page, "Account")).toHaveAccessibleName(/DesignResearchAndEngineering/);
        await expectNoHorizontalOverflow(dialog(page), "New Thread with a long selected account");

        await picker(page, "Model").click();
        await expect(page.getByRole("option")).toHaveText([/Automatic/, /Opus 4\.7/, /Sonnet 4\.6/, /Haiku 4\.5/]);
        await capture(page, "models");
        await page.getByRole("option", { name: /Sonnet 4\.6/ }).click();
        await picker(page, "Effort").click();
        // Sonnet's own efforts, not the harness's Max.
        await expect(page.getByRole("option")).toHaveText([/Automatic/, "Low", "Medium", "High"]);
        await page.getByRole("option", { name: "High", exact: true }).click();
        await expect(picker(page, "Effort")).toHaveAccessibleName("Effort: High");

        await budget.fill("4.005");
        await expect(create(page)).toBeDisabled();
        await expect(dialog(page)).toContainText("Enter an amount in whole cents, such as 2.50.");
        await budget.fill("40");
        await launches.fill("4");
        await picker(page, "Decision Delegation").click();
        await page.getByRole("option", { name: /^Delegate All/ }).click();
        await expect(create(page)).toBeEnabled();
        await expectReadable(dialog(page));
        await capture(page, "chosen");

        await create(page).click();
        const body = page.locator("body");
        await expect(body).toHaveAttribute("data-thread-create-count", "1");
        await expect(body).toHaveAttribute("data-created-account", "acct:0000000000000002");
        await expect(body).toHaveAttribute("data-created-model", "claude-sonnet-4-6");
        await expect(body).toHaveAttribute("data-created-effort", "high");
        await expect(body).toHaveAttribute("data-thread-limits", JSON.stringify({ costUsd: 40, launchedSessions: 4 }));
        await expect(body).toHaveAttribute("data-delegation-grant", /"selectionMode":"all"/);
        await expect(dialog(page)).toHaveCount(0);

        // The new thread opens on its own composer, where the first message is written.
        const composer = pane(page).locator(".composer");
        const input = composer.locator("textarea.composer-input");
        await expect(composer).toBeVisible();
        // A phone's idle composer is a capsule until it is tapped.
        if (!await input.isVisible()) await composer.locator(".composer-box").click();
        await expect(input).toBeVisible();
        // The composer's own Model Settings carry what the dialog chose, for this and later turns.
        await expect(pane(page).getByRole("button", { name: /^Model Settings:/ })).toHaveAccessibleName("Model Settings: claude-sonnet-4-6, High");
        await expectPageNoHorizontalOverflow(page);
        await capture(page, "created");
        await input.fill(message);
        await pane(page).getByRole("button", { name: "Send", exact: true }).click();
        await expect(sentMessage(page)).toBeVisible();
        const title = phone ? page.locator("#page-title") : pane(page).getByRole("heading", { name: firstLine, exact: true });
        await expect(title).toHaveText(firstLine);
        await expect(body).toHaveAttribute("data-thread-create-count", "1");
      });

      test("keeps every choice after creation is refused", async ({ page }) => {
        await open(page, "new-thread=create-failure&limits=enabled");
        await list(page).getByRole("button", { name: "New Thread" }).click();
        await picker(page, "Model").click();
        await page.getByRole("option", { name: /Opus 4\.7/ }).click();
        await create(page).click();
        await expect(dialog(page).getByRole("alert")).toContainText("The selected Machine went offline.");
        await expect(picker(page, "Model")).toHaveAccessibleName("Model: Opus 4.7");
        await expect(create(page)).toBeEnabled();
        await expectFullyInViewport(create(page), "Create Thread after refusal");
        await expectPageNoHorizontalOverflow(page);
        await capture(page, "create-failed");
        await dialog(page).getByRole("button", { name: "Cancel" }).click();
        await expect(dialog(page)).toHaveCount(0);
        await expect(page.locator("body")).not.toHaveAttribute("data-thread-create-count", /./);
      });

      test("changing the harness starts from that harness's own model and effort", async ({ page }) => {
        await open(page, "limits=enabled");
        await list(page).getByRole("button", { name: "New Thread" }).click();
        await picker(page, "Model").click();
        await page.getByRole("option", { name: /Opus 4\.7/ }).click();
        await picker(page, "Harness").click();
        await page.getByRole("option", { name: "Codex" }).click();
        await expect(picker(page, "Model")).toHaveAccessibleName("Model: Automatic");
        await picker(page, "Model").click();
        await expect(page.getByRole("option")).toHaveText([/Automatic/, /GPT-5\.5/]);
      });

      for (const [scenario, explanation] of [
        ["owner-only", "Threads Are for Owners"],
        ["unavailable", "Threads Aren't Available Yet"],
      ]) {
        test(scenario + " explains the restriction and offers no creation control", async ({ page }) => {
          await open(page, "threads=" + scenario);
          await expect(list(page).getByText(explanation!, { exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "New Thread", exact: true })).toHaveCount(0);
          await expectPageNoHorizontalOverflow(page);
          await capture(page, scenario!);
        });
      }
    });
  }
}
