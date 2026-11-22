import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectTextContrast } from "./layout-invariants.js";

const heading = "What should the assistant work on?";
const message = "Plan the next release\nReview the open work that's ready to ship.";
const firstLine = "Plan the next release";
const pane = (page: Page) => page.locator(".assistant-thread-pane");
const form = (page: Page) => page.getByRole("form", { name: heading });
const messageBox = (page: Page) => form(page).getByRole("textbox", { name: "First Message" });
const start = (page: Page) => form(page).getByRole("button", { name: "Start Thread" });
const list = (page: Page) => page.getByRole("complementary", { name: "Assistants" });
const transcript = (page: Page) => pane(page).getByRole("region", { name: "Session Activity" });
const sentMessage = (page: Page) => transcript(page).getByText("Review the open work that's ready to ship.", { exact: false });
const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;

async function expectTargetLayout(targets: Locator, phone: boolean) {
  const boxes = await targets.evaluateAll((nodes) => nodes.map((target) => {
    const { top, bottom, left, right, width, height } = target.getBoundingClientRect();
    return { top, bottom, left, right, width, height, name: target.textContent?.trim() };
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
        if (evidenceDir) {
          const dimensions = measured ? phone ? "-target44csspx-gap8csspx" : "-target24csspx" : "";
          await page.screenshot({ path: join(evidenceDir, prefix + "-" + state + dimensions + ".png"), animations: "disabled" });
        }
      }

      test("composes the first message and opens its conversation with the chosen settings", async ({ page }) => {
        await open(page, "accounts=composer-stress&limits=enabled");
        await list(page).getByRole("button", { name: "New Thread" }).click();
        await expect(pane(page).getByRole("heading", { name: heading })).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        if (phone) {
          await expect(list(page)).toBeHidden();
          await expect(page.getByRole("heading", { name: "New Thread", exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "Back to Assistants" })).toBeVisible();
        } else {
          await expect(list(page)).toBeVisible();
          await expect(list(page).locator("[data-thread-id]")).toHaveCount(3);
        }
        await expect(form(page).getByRole("button", { name: "Harness Claude Code" })).toBeVisible();
        await expect(form(page).getByRole("button", { name: "Account Machine Policy · Studio Subscription" })).toBeVisible();
        await expect(form(page).getByRole("button", { name: "Budget $25 · 10 Launches" })).toBeVisible();
        await expect(start(page)).toBeDisabled();
        await expectFullyInViewport(start(page), "Start Thread");
        await expectNoHorizontalOverflow(form(page), "New Thread");
        await expectPageNoHorizontalOverflow(page);
        await expectTargetLayout(form(page).locator("button.btn, textarea"), phone);
        await expectReadable(form(page));
        await capture(page, "empty", true);

        await messageBox(page).fill(" \n   ");
        await expect(start(page)).toBeDisabled();
        const starterPrompts = form(page).getByRole("group", { name: "Starter Prompts" });
        await expect(starterPrompts.getByRole("button")).toHaveCount(3);
        for (const [label, prompt] of [
          ["Check on Running Work", "Check on my running work and tell me what needs attention."],
          ["Review Open Decisions", "Show me the open decisions that need my input."],
          ["Plan a Task", "Help me plan a task and decide how to break it into sessions."],
        ]) {
          await starterPrompts.getByRole("button", { name: label }).click();
          await expect(messageBox(page)).toHaveValue(prompt!);
          await expect(messageBox(page)).toBeFocused();
        }
        await messageBox(page).fill(message);
        await expect(start(page)).toBeEnabled();
        await expectReadable(form(page));
        await capture(page, "typed");

        await form(page).getByRole("button", { name: /^Harness/ }).click();
        const harness = page.getByRole("dialog", { name: "Harness" });
        await expect(harness.getByRole("radio", { name: "Claude Code" })).toBeChecked();
        await expect(harness.getByRole("radio", { name: "Codex" })).toBeEnabled();
        await expectTargetLayout(harness.locator(".choice-row, .icon-btn"), phone);
        await expectReadable(harness);
        await capture(page, "harness", true);
        await page.keyboard.press("Escape");
        await expect(harness).toHaveCount(0);
        await expect(form(page).getByRole("button", { name: /^Harness/ })).toBeFocused();

        await form(page).getByRole("button", { name: /^Account/ }).click();
        const account = page.getByRole("dialog", { name: "Account" });
        const eligible = account.getByRole("radiogroup", { name: "Eligible Accounts" });
        await expect(eligible.getByRole("radio")).toHaveCount(8); // Seven accounts and Machine Policy.
        await expect(eligible.getByRole("radio", { name: "Machine Policy · Studio Subscription" })).toBeChecked();
        const unavailable = account.locator("details");
        await expect(unavailable).toHaveJSProperty("open", false);
        await expect(account.getByText("Field Subscription")).toBeHidden();
        expect(await eligible.evaluate((choices) =>
          Boolean(choices.compareDocumentPosition(choices.parentElement!.querySelector("details")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
        await expectNoHorizontalOverflow(account, "Account choices");
        await expectTargetLayout(account.locator(".choice-row, .icon-btn, summary"), phone);
        await expectReadable(account);
        await capture(page, "accounts-folded", true);

        await unavailable.locator("summary").click();
        await expect(unavailable).toHaveJSProperty("open", true);
        await expect(unavailable.locator("li")).toHaveCount(4);
        await account.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        for (const reason of [
          "This account needs sign-in.",
          "This account can't run in this agent's environment.",
          "This account would spend API credits.",
          "This account is at a usage limit until",
        ]) await expectFullyInViewport(unavailable.getByText(reason, { exact: !reason.endsWith("until") }), reason);
        await expect(unavailable.getByText(/usage limit until .+\./)).toBeVisible();
        await expectNoHorizontalOverflow(account, "Expanded account choices");
        await expectReadable(account);
        await capture(page, "accounts-expanded");

        await eligible.getByRole("radio", { name: /DesignResearchAndEngineering/ }).check();
        await account.getByRole("button", { name: "Close Account" }).click();
        const selectedAccount = form(page).getByRole("button", { name: /^Account DesignResearchAndEngineering/ });
        await expect(selectedAccount).toBeVisible();
        expect(await selectedAccount.evaluate((chip) => {
          const label = chip.querySelector("span")!.getBoundingClientRect();
          const box = chip.getBoundingClientRect();
          return label.top >= box.top && label.bottom <= box.bottom;
        })).toBe(true);
        await expectNoHorizontalOverflow(form(page), "New Thread with a long selected account");

        await form(page).getByRole("button", { name: /^Budget/ }).click();
        const budget = page.getByRole("dialog", { name: "Budget", exact: true });
        await expect(budget.getByRole("textbox", { name: "Budget (USD)" })).toHaveValue("25");
        await expect(budget.getByRole("textbox", { name: "Session Launch Limit" })).toHaveValue("10");
        await expectTargetLayout(budget.locator("input, button"), phone);
        await expectReadable(budget);
        await capture(page, "budget", true);
        await budget.getByRole("textbox", { name: "Budget (USD)" }).fill("40");
        await budget.getByRole("textbox", { name: "Session Launch Limit" }).fill("4");
        await budget.getByRole("button", { name: "Apply Budget" }).click();
        await expect(form(page).getByRole("button", { name: "Budget $40 · 4 Launches" })).toBeVisible();

        await start(page).click();
        await expect(page.locator("body")).toHaveAttribute("data-thread-create-count", "1");
        await expect(page.locator("body")).toHaveAttribute("data-created-account", "acct:0000000000000002");
        await expect(page.locator("body")).toHaveAttribute("data-thread-limits", JSON.stringify({ costUsd: 40, launchedSessions: 4 }));
        await expect(form(page)).toHaveCount(0);
        const title = phone ? page.locator("#page-title") : pane(page).getByRole("heading", { name: firstLine, exact: true });
        await expect(title).toHaveText(firstLine);
        await expect(sentMessage(page)).toBeVisible();
        await expectPageNoHorizontalOverflow(page);
        await capture(page, "created");
      });

      test("keeps the draft after creation is refused", async ({ page }) => {
        await open(page, "new-thread=create-failure&limits=enabled");
        await list(page).getByRole("button", { name: "New Thread" }).click();
        await messageBox(page).fill(message);
        await start(page).click();
        await expect(form(page).getByRole("alert")).toContainText("The selected Machine went offline.");
        await expect(messageBox(page)).toHaveValue(message);
        await expect(start(page)).toBeEnabled();
        await expectFullyInViewport(start(page), "Start Thread after refusal");
        await expectPageNoHorizontalOverflow(page);
        await capture(page, "create-failed");
      });

      test("opens the created thread with an unsent draft and retries without creating again", async ({ page }) => {
        await open(page, "new-thread=first-message-failure&limits=enabled");
        await list(page).getByRole("button", { name: "New Thread" }).click();
        await messageBox(page).fill(message);
        await start(page).click();
        await expect(form(page)).toHaveCount(0);
        const notice = pane(page).getByText("First Message Wasn't Sent", { exact: true });
        await expect(notice).toBeVisible();
        await expect(pane(page)).toContainText("The Machine did not accept the message.");
        const draft = pane(page).locator(".composer textarea");
        await expect(draft).toHaveValue(message);
        await expect(sentMessage(page)).toHaveCount(0);
        await expectFullyInViewport(pane(page).getByRole("button", { name: "Send", exact: true }), "Send");
        await expectPageNoHorizontalOverflow(page);
        await capture(page, "first-message-failed");

        await pane(page).getByRole("button", { name: "Send", exact: true }).click();
        await expect(sentMessage(page)).toBeVisible();
        await expect(notice).toHaveCount(0);
        await expect(page.locator("body")).toHaveAttribute("data-thread-create-count", "1");
      });

      for (const [scenario, explanation] of [
        ["owner-only", "Threads Are for Owners"],
        ["unavailable", "Threads Aren't Available Yet"],
      ]) {
        test(scenario + " explains the restriction and offers no creation control", async ({ page }) => {
          await open(page, "threads=" + scenario);
          await expect(list(page).getByText(explanation!, { exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "New Thread", exact: true })).toHaveCount(0);
          await expect(start(page)).toHaveCount(0);
          await expectPageNoHorizontalOverflow(page);
          await capture(page, scenario!);
        });
      }
    });
  }
}
