import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { receiptStressReason, receiptStressTitle } from "../src/e2e/assistant-receipt-fixture.js";
import { expectAssistantControlLayout } from "./assistant-control-layout.js";
import { expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const evidenceDir = process.env.WOLLIPOG_TRANSCRIPT_RECEIPTS_EVIDENCE_DIR;
const evidenceStates = process.env.WOLLIPOG_TRANSCRIPT_RECEIPTS_EVIDENCE_STATES?.split(",");
const threadPath = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const sessionPath = (id: string) => "/sessions/~" + Buffer.from(id, "utf16le").toString("base64url");

async function open(page: Page, theme: string, state: string, extra: Record<string, string> = {}) {
  await page.goto("/assistants-e2e.html?" + new URLSearchParams({
    theme, path: threadPath, "transcript-receipts": state, ...extra,
  }));
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

const launchMessage = (page: Page) => page.locator(".tl-agent-msg").filter({ hasText: "I’m starting the verification sessions." });
const decision = (page: Page) => page.locator('[data-prompt-origin="delegated_decision"]');
const { defaultBrowserType: _browser, ...phone } = devices["iPhone 13"]!;

for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    test(`${theme} ${width}×${height} Assistant transcript receipts`, async ({ browser }) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({
        ...(width === 390 ? phone : {}), viewport: { width, height }, colorScheme: theme,
        deviceScaleFactor: 1, timezoneId: "America/Chicago",
      });
      try {
        const page = await context.newPage();
        async function capture(state: string, row: Locator, targets = ".assistant-transcript-receipt", composer = true) {
          await expect(async () => {
            await row.scrollIntoViewIfNeeded();
            await expect(row).toBeInViewport({ ratio: 0.95, timeout: 500 });
          }).toPass({ timeout: 5_000 });
          if (composer) await expect(page.locator(".composer")).toBeInViewport({ ratio: 1 });
          await expectPageNoHorizontalOverflow(page);
          if (targets) await expectAssistantControlLayout(row, width, targets);
          const badgeSizes = await row.locator(".assistant-transcript-launch > .status").evaluateAll((nodes) =>
            nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)));
          for (const size of badgeSizes) expect(size).toBeGreaterThanOrEqual(12);
          if (evidenceDir && (!evidenceStates || evidenceStates.includes(`${width}:${state}`))) {
            mkdirSync(evidenceDir, { recursive: true });
            await page.screenshot({ path: join(evidenceDir, `assistant-receipts-${width}x${height}-${theme}-${state}.png`) });
          }
        }

        for (const [title, id] of [["Fix the Flaky Upload Test", "sess-flaky"], ["Bump the Vite Group", "sess-deps"]]) {
          await open(page, theme, "two");
          const message = launchMessage(page);
          await expect(message.locator(".assistant-transcript-launch")).toHaveCount(2);
          await expect(message.getByRole("button", { name: /Fix the Flaky Upload Test/ })).toContainText("Running");
          await expect(message.getByRole("button", { name: /Bump the Vite Group/ })).toContainText("Running");
          await page.evaluate(() => (window as Window & { assistantsAdvance: () => void }).assistantsAdvance());
          await expect(message.getByRole("button", { name: /Fix the Flaky Upload Test/ })).toContainText("Completed");
          if (id === "sess-flaky") await capture("two-live-launches", message);
          await message.getByRole("button", { name: new RegExp(title!) }).click();
          await expect(page).toHaveURL((url) => url.searchParams.get("path") === sessionPath(id!));
        }

        await open(page, theme, "many");
        const message = launchMessage(page);
        const launches = message.locator(".assistant-transcript-launch");
        await expect(launches).toHaveCount(3);
        await expect(launches.locator(":scope > span:first-child")).toHaveText([
          "Verification Session 1", "Verification Session 2", "Verification Session 3",
        ]);
        await capture("ten-launches", message);
        await message.getByRole("button", { name: "+7 more", exact: true }).click();
        const work = page.getByRole("tabpanel", { name: /^Work/ });
        await expect(page.getByRole("tab", { name: "Work 10", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(work.getByRole("button", { name: /Verification Session 9/ })).toBeVisible();
        if (width === 390) {
          const tabs = await page.getByRole("tablist", { name: "Thread Panel" }).getByRole("tab").evaluateAll((nodes) =>
            nodes.map((node) => {
              const { left, right, width, height } = node.getBoundingClientRect();
              return { label: node.textContent?.trim(), left, right, width, height };
            }));
          expect(tabs).toHaveLength(3);
          for (const [index, tab] of tabs.entries()) {
            expect(tab.width, tab.label).toBeGreaterThanOrEqual(44);
            expect(tab.height, tab.label).toBeGreaterThanOrEqual(44);
            if (index > 0) expect(tab.left - tabs[index - 1]!.right).toBeGreaterThanOrEqual(8);
          }
          console.log(`Existing phone Work tabs (${theme}), CSS px: ${tabs.map(({ label, width, height }) =>
            `${label} ${width}×${height}`).join(", ")}. Gaps: ${tabs.slice(1).map(({ left }, index) => left - tabs[index]!.right).join(", ")}.`);
        }
        await capture("work-tab", page.locator(".assistant-thread-panel"), "", width !== 390);
        await page.getByRole("button", { name: "Close Panel", exact: true }).click();

        await open(page, theme, "decision");
        const eventRow = decision(page);
        await expect(eventRow).toContainText("This thread approved merging picoduck/wollipog#126 for you");
        await expect(eventRow).toContainText("Under Delegate All · Required checks passed.");
        await expect(eventRow.locator("details")).not.toHaveAttribute("open");
        const positioned = await eventRow.evaluate((row) => {
          const before = [...document.querySelectorAll(".tl-agent-msg")].find((item) => item.textContent?.includes("I’ll review the release"));
          const after = [...document.querySelectorAll(".tl-agent-msg")].find((item) => item.textContent?.includes("The release approval is recorded."));
          const time = (item: Element | undefined) =>
            Date.parse(item?.querySelector("time")?.getAttribute("datetime") ?? "");
          return Boolean(before && after && (before.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            (row.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            time(before) < time(row) && time(row) < time(after));
        });
        expect(positioned).toBe(true);
        await capture("delegated-decision", eventRow, "summary");
        await eventRow.getByText("Details", { exact: true }).click();
        await expect(eventRow.locator("pre")).toHaveText("Required checks passed.");
        await capture("decision-details", eventRow, "summary");

        await open(page, theme, "request");
        const requestMessage = page.locator(".tl-agent-msg").filter({ hasText: "I asked you before stopping the upload session." });
        const waiting = requestMessage.getByRole("button", { name: "Waiting for you: Stop Session", exact: true });
        const dock = page.getByRole("region", { name: /^Waiting for You/ });
        await expect(dock.getByRole("heading", { name: "Archive Session" })).toBeVisible();
        const transcriptColumn = page.locator(".detail-main[data-assistant-transcript]");
        if (width === 390) {
          await expect(transcriptColumn).toHaveCSS("margin-block-end", "0px");
          await page.evaluate(() => document.documentElement.style.setProperty("--keyboard-inset", "320px"));
          await expect(transcriptColumn).toHaveCSS("margin-block-end", "0px");
          await page.evaluate(() => document.documentElement.style.removeProperty("--keyboard-inset"));
        }
        await capture("request-waiting", requestMessage);
        await waiting.click();
        await expect(dock.getByRole("listitem", { name: "Stop Session" })).toBeFocused();
        await capture("request-focused", dock, ".assistant-dock-actions > button, .assistant-dock-resolve > button");
        await dock.getByRole("button", { name: "Deny", exact: true }).click();
        await expect(waiting).toHaveCount(0);
        await expect(requestMessage.getByText("Request Closed: Stop Session")).toBeVisible();
        if (width === 390) {
          const toast = page.locator(".toast-region").filter({ hasText: "Stop Session was denied. Nothing ran." });
          const transcript = page.getByRole("region", { name: "Session Activity" });
          await expect(toast).toBeVisible();
          await expect.poll(async () => {
            const [reader, notice] = await Promise.all([transcript.boundingBox(), toast.boundingBox()]);
            return reader && notice ? Math.ceil(reader.y + reader.height - notice.y) : Infinity;
          }).toBeLessThanOrEqual(1);
        }
        await capture("request-answered", requestMessage, "");
        if (width === 390) {
          await page.evaluate(() => document.documentElement.style.setProperty("--keyboard-inset", "320px"));
          await expect.poll(() => transcriptColumn.evaluate((column) => {
            const height = document.querySelector<HTMLElement>(".toast-region")?.offsetHeight;
            return height === undefined ? Infinity : Number.parseFloat(getComputedStyle(column).marginBlockEnd) - height;
          })).toBe(8);
          await page.getByRole("button", { name: "Dismiss Notification" }).click();
          await expect(transcriptColumn).toHaveCSS("margin-block-end", "0px");
        }

        await open(page, theme, "stress");
        await expect(launchMessage(page).getByRole("button", { name: new RegExp(receiptStressTitle) })).toBeVisible();
        await capture("stress", launchMessage(page));
        await expect(decision(page)).toContainText(receiptStressTitle + "#126");
        await decision(page).getByText("Details", { exact: true }).click();
        await expect(decision(page).locator("pre")).toHaveText(receiptStressReason);
        await capture("stress-decision", decision(page), "summary");

        const errors: Error[] = [];
        page.on("pageerror", (error) => errors.push(error));
        await open(page, theme, "old");
        await expect(page.getByText("I asked you before stopping the upload session.")).toBeVisible();
        await expect(page.locator(".assistant-transcript-receipts")).toHaveCount(0);
        await expect(decision(page)).toHaveCount(0);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}

test("an approved campaign gains a launch receipt at its original request", async ({ page }) => {
  await open(page, "light", "campaign", { campaign: "", confirm: "1" });
  const message = page.locator(".tl-agent-msg").filter({ hasText: "I asked you to review the campaign." });
  await message.getByRole("button", { name: "Waiting for you: Start Campaign" }).click();
  await page.getByRole("button", { name: "Review Campaign…" }).click();
  const review = page.getByRole("dialog");
  await review.getByRole("button", { name: "Approve Once" }).click();
  const launch = message.getByRole("button", { name: /Plan the Release/ });
  await expect(launch).toContainText("Running");
  await launch.click();
  await expect(page).toHaveURL((url) => url.searchParams.get("path") === sessionPath("session_aoc_campaign_0"));
});
