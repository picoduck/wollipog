import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { assistantConnectionsView, viewPath } from "../src/navigation.js";
import { expectNoHorizontalOverflow, expectPageNoHorizontalOverflow, expectTextContrast, expectTouchTargets } from "./layout-invariants.js";

const thread = { name: "assistants", threadId: "thr_triage" } as const;
const threadPath = viewPath(thread);
const sizes = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];

async function open(page: Page, theme: string, path: string, query = "") {
  await page.clock.setFixedTime(Date.UTC(2026, 10, 20, 12, 48));
  await page.goto("/assistants-e2e.html?" + new URLSearchParams({ path, theme }) + "&" + query);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** Compare real text and control boxes, including the first line of wrapping text. */
async function expectAligned(rows: Locator, text: string, trailing: string, leading?: string) {
  await expect(rows.first()).toBeVisible();
  const failures = await rows.evaluateAll((elements, selectors) => elements.flatMap(row => {
    const label = row.querySelector(selectors.text);
    if (!label) return ["Missing row label"];
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    let line: DOMRect | undefined;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || node.parentElement?.closest(".sr-only")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      line = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
      if (line) break;
    }
    if (!line) return ["Missing first line of text"];
    const visible = (selector: string) => [...row.querySelectorAll(selector)].filter(node =>
      node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility === "visible");
    const controls = visible(selectors.trailing);
    if (!controls.length) return ["Missing visible trailing control for " + label.textContent];
    const neighbors = [...(selectors.leading ? visible(selectors.leading) : []), ...controls];
    const name = (node: Element) => node.getAttribute("aria-label") || node.textContent?.trim() || node.tagName;
    const center = (box: DOMRect) => box.top + box.height / 2;
    const errors = neighbors.flatMap(node => {
      const offset = Math.abs(center(node.getBoundingClientRect()) - center(line!));
      return offset > 1 ? [name(label) + " / " + name(node) + ": center difference " + offset + " CSS px"] : [];
    });
    const boxes = [label, ...neighbors].map(node => ({ name: name(node), box: node.getBoundingClientRect() }));
    for (const [index, a] of boxes.entries()) {
      for (const b of boxes.slice(index + 1)) {
        if (Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 0.5 &&
            Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 0.5) {
          errors.push(a.name + " overlaps " + b.name);
        }
      }
    }
    return errors;
  }), { text, trailing, leading });
  expect(failures).toEqual([]);
}

function buttonStandardViolations(surface: Locator) {
  return surface.evaluate(root => {
    const region = ".notice, .request-card, .assistant-dock-card, .modal-foot";
    return [root, ...root.querySelectorAll(region)].filter(node => node.matches(region)).flatMap(group => {
      if (!group.getClientRects().length) return [];
      const buttons = [...group.querySelectorAll("button, a.btn")].filter(node =>
        node.closest(region) === group && node.getClientRects().length &&
        !node.matches(".icon-btn, .notice-trailing *, .assistant-dock-details"));
      const labels = buttons.map(node => node.textContent?.trim() ?? "");
      const filled = buttons.filter(node => node.matches(".btn:not(.ghost)"));
      const deny = labels.indexOf("Deny");
      const approve = labels.findIndex(label => /^Approve(?: Once)?$/u.test(label));
      const problems = [];
      if (deny >= 0 && approve >= 0 && deny > approve) problems.push("Deny follows Approve");
      if (deny >= 0 && labels.findIndex(label => label.startsWith("Open ")) > deny) problems.push("Navigation follows Deny");
      if (filled.length > 1) problems.push("More than one filled action");
      if (filled.length === 1 && filled[0] !== buttons.at(-1)) problems.push("Filled action is not last");
      return problems.map(problem => problem + ": " + labels.join(", "));
    });
  });
}

async function expectButtonStandard(surface: Locator) {
  expect(await buttonStandardViolations(surface)).toEqual([]);
}

test("the ratchet detects an extra filled action and reversed request actions", async ({ page }) => {
  await open(page, "light", threadPath, "dock=owner&confirm=1");
  const card = page.locator(".assistant-dock-card");
  await expect(card.getByRole("button", { name: "Approve Once" })).toBeVisible();
  await expectButtonStandard(card);
  const deny = card.getByRole("button", { name: "Deny", exact: true });
  await deny.evaluate(button => button.classList.remove("ghost"));
  expect(await buttonStandardViolations(card)).toContainEqual(expect.stringContaining("More than one filled action"));
  await deny.evaluate(button => {
    button.classList.add("ghost");
    button.parentElement!.append(button);
  });
  expect(await buttonStandardViolations(card)).toContainEqual(expect.stringContaining("Deny follows Approve"));
});

async function check(surface: Locator, id: string, theme: string, state: string) {
  await expect(surface).toBeVisible();
  const page = surface.page();
  await expectPageNoHorizontalOverflow(page);
  await expectNoHorizontalOverflow(surface, id);
  await expectButtonStandard(surface);
  await expectTextContrast(surface);
  if (page.viewportSize()?.width === 390) {
    if (id === "thread-list") {
      // The middle scrollport clips rows above and below the fixed list chrome.
      const body = surface.locator(".assistant-group");
      const footer = surface.locator(".assistant-threads-foot");
      const listBox = (await body.boundingBox())!;
      const footerBox = (await footer.boundingBox())!;
      expect(listBox.y + listBox.height).toBeLessThanOrEqual(footerBox.y);
      for (const region of await surface.locator(".master-detail-list-head, .assistant-group, .assistant-threads-foot").all()) {
        await expectTouchTargets(region);
      }
    } else {
      await expectTouchTargets(surface);
    }
  } else {
    const smallButtons = await surface.getByRole("button").evaluateAll(buttons => buttons.flatMap(button => {
      const { width, height } = button.getBoundingClientRect();
      return width && height && Math.min(width, height) < 24
        ? [button.getAttribute("aria-label") || button.textContent?.trim()] : [];
    }));
    expect(smallButtons, id + " buttons are at least 24 × 24 CSS px").toEqual([]);
  }
  const { text, small } = await surface.evaluate(root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const visible: string[] = [];
    const small: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || !parent?.getClientRects().length) continue;
      if (parent.closest(".sr-only, [hidden]")) continue;
      const style = getComputedStyle(parent);
      if (style.visibility !== "visible") continue;
      if (Number.parseFloat(style.fontSize) < 12) small.push(node.textContent.trim());
      if (!parent.closest(".setting-row-value-text:has(+ button), .assistant-installation-row code, dd:has(> button)")) {
        visible.push(node.textContent);
      }
    }
    return { text: visible.join("\n"), small };
  });
  expect(small, id + " visible text is at least 12 CSS px").toEqual([]);
  expect(text, id + " operation names").not.toMatch(/\b[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+\b/u);
  expect(text, id + " internal IDs").not.toMatch(/\b(?:(?:s|thr|occ|asst|loc|usr|org|aoc|wd|cwi)_[\w-]+|sess-[\w-]+)\b/u);
  expect(text, id + " protocol prefixes").not.toMatch(/\b(?:acct:|mcp__|wollipog-assistant:|workflow_decision:)/iu);
  if (process.env.ASSISTANT_POLISH_EVIDENCE_DIR) {
    const { width, height } = page.viewportSize()!;
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: join(process.env.ASSISTANT_POLISH_EVIDENCE_DIR, [id, width + "x" + height, theme, state].join("-") + ".png"),
      animations: "disabled",
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const viewport of sizes) {
    const phone = viewport.width === 390;
    test.describe(theme + " " + viewport.width + "px", () => {
      test.use({ viewport, hasTouch: phone, isMobile: phone, colorScheme: theme, reducedMotion: "reduce", timezoneId: "UTC" });

      test("thread list aligns thread titles, timestamps and icons", async ({ page }) => {
        await open(page, theme, "/assistants", "threads=long&attention=3");
        const surface = page.getByRole("complementary", { name: "Assistants" });
        const rows = surface.locator(".assistant-inbox-row");
        await expect(rows.first()).toBeVisible();
        expect(await rows.count()).toBeGreaterThan(3);
        await expectAligned(rows, ".assistant-thread-list-title", ".assistant-thread-title-line > .row-sub", ".assistant-thread-glyph");
        await check(surface, "thread-list", theme, "long-titles");
      });

      test("title bar aligns the 120-character title with the actions", async ({ page }) => {
        await open(page, theme, threadPath, "threads=long&launched=many&spending=near&dock=owner");
        const bar = page.locator(".detail-bar:has(.assistant-bar-title)");
        await expect(bar.locator(".detail-bar-title")).toHaveText(/^.{120}$/u);
        await expectAligned(bar, ".detail-bar-title", ".detail-bar-actions button");
        await check(bar, "title-bar", theme, "long-title");
      });

      test("Waiting for You aligns its pager and orders actions for three requests", async ({ page }) => {
        await open(page, theme, threadPath, "threads=long&launched=many&dock=owner&confirm=3");
        const dock = page.locator(".assistant-dock");
        await expect(dock.getByRole("heading", { name: "Waiting for You 3" })).toBeVisible();
        await expectAligned(dock.locator(".assistant-dock-head"), "h3", ".assistant-dock-pager button");
        await check(dock, "waiting-dock", theme, "three-requests");
        await dock.getByRole("button", { name: "Show All" }).click();
        await expect(dock.getByRole("listitem")).toHaveCount(3);
        await dock.getByRole("button", { name: "Approve Once", exact: true }).first().scrollIntoViewIfNeeded();
        await check(dock, "waiting-dock", theme, "all-three-requests");
      });

      test("notices align the icon and overflow control with the title", async ({ page }) => {
        await open(page, theme, threadPath, "threads=long&launched=many&limits=enabled&spending=over&thread-health=stress");
        const notice = page.locator(".composer .session-notice-slot .notice");
        await expectAligned(notice, ".notice-title", ".notice-trailing button", ".notice-icon");
        await check(notice, "notices", theme, "multiple-problems");

        await open(page, theme, threadPath, "threads=long&launched=many&limits=enabled&spending=over");
        await expect(notice.getByRole("button", { name: "Raise Budget…", exact: true })).toBeVisible();
        await check(notice, "notices", theme, "over-budget");
        await open(page, theme, threadPath, "thread-health=turn_failed");
        await expect(notice.getByRole("button", { name: "Retry Turn", exact: true })).toBeVisible();
        await check(notice, "notices", theme, "retry-turn");
      });

      test("Inbox previews and campaign approvals use the same button standard", async ({ page }) => {
        await open(page, theme, "/inbox", "attention=3&campaign&confirm=3&threads=long");
        const notice = page.getByRole("region", { name: "Assistant Approvals" });
        await expect(notice.getByRole("button", { name: "Review", exact: true }).first()).toBeVisible();
        await check(notice, "notices", theme, "inbox-approvals");
        await notice.getByRole("button", { name: "Review", exact: true }).first().click();
        const campaigns = page.getByRole("dialog", { name: "Campaign Approvals", exact: true });
        const review = campaigns.getByRole("button", { name: "Review Campaign", exact: true }).first();
        await expect(review).toBeVisible();
        await expectButtonStandard(campaigns);
        await review.click();
        const request = page.getByRole("dialog", { name: "Start Campaign", exact: true });
        await expect(request.getByRole("button", { name: "Approve Once" })).toBeVisible();
        await check(request, "waiting-dock", theme, "campaign-approval");
      });

      async function openPanel(page: Page, tab: string) {
        await open(page, theme, threadPath, "threads=long&accounts=stress&launched=many&thread-panel=delegated&decision-history=stress&delegation=stress");
        const panel = page.locator("#right-panel");
        await page.getByRole("button", { name: /Side Panel/ }).click();
        await panel.getByRole("tab", { name: new RegExp("^" + tab) }).click();
        return panel;
      }

      for (const tab of ["Work", "Decisions", "Details"]) {
        test("side panel " + tab + " aligns tabs and trailing controls", async ({ page }) => {
          const panel = await openPanel(page, tab);
          await expectAligned(panel.locator(".rpanel-head"), '[aria-selected="true"]', ".rpanel-head > button");
          if (tab === "Work") await expect(panel.getByRole("tab", { name: "Work 42" })).toBeVisible();
          await check(panel, "side-panel-" + tab.toLowerCase(), theme, tab === "Work" ? "42-sessions" : "long-thread");
        });
      }

      test("delegated-decision log aligns the outcome icon, heading and time", async ({ page }) => {
        const panel = await openPanel(page, "Decisions");
        const log = panel.locator(".assistant-decision-history");
        await expect(log.locator(".assistant-decision-row")).toHaveCount(5);
        await expectAligned(log.locator(".assistant-decision-row"), ".assistant-decision-meta strong",
          ".assistant-decision-meta time", ".assistant-decision-outcome");
        await log.getByRole("button", { name: "Show Full Reason" }).click();
        await expect(log.getByRole("button", { name: "Show Less" })).toHaveAttribute("aria-expanded", "true");
        await check(log, "delegated-decision-log", theme, "expanded-reason");
      });

      test("Thread Settings aligns conversation rows and keeps Save reachable", async ({ page }) => {
        await open(page, theme, viewPath({ ...thread, limits: true }), "limits=enabled&accounts=composer-stress&recorded-thread-model");
        const dialog = page.getByRole("dialog", { name: "Thread Settings" });
        await expect(dialog.getByRole("button", { name: "Save Changes" })).toBeInViewport({ ratio: 1 });
        await expectAligned(dialog.getByRole("region", { name: "Conversation" }).locator(".setting-row"),
          ".setting-row-title", ".setting-row-control > button");
        await check(dialog, "thread-settings", theme, "conversation-and-spending");
      });

      test("Decision Delegation aligns its heading with the controls and keeps Save reachable", async ({ page }) => {
        await open(page, theme, viewPath({ ...thread, delegation: true }), "delegation=stress&evidence=available&long-scopes");
        const dialog = page.getByRole("dialog", { name: "Decision Delegation" });
        await expect(dialog.getByRole("button", { name: "Save Delegation" })).toBeInViewport({ ratio: 1 });
        await expectAligned(dialog.locator(".modal-head"), "h2", ".modal-head button");
        await dialog.getByRole("radio", { name: "Choose" }).click();
        await expect(dialog.getByRole("checkbox", { name: "Merge Pull Requests" })).toBeVisible();
        await check(dialog, "decision-delegation", theme, "delegation-options");
      });

      test("Assistant Settings aligns defaults with their controls", async ({ page }) => {
        await open(page, theme, "/settings/assistant", "limits=stress&accounts=stress&delegation=settings");
        const defaults = page.getByRole("region", { name: "Thread Defaults" });
        await expectAligned(defaults.locator(".setting-row"), ".setting-row-title", ".setting-row-control > button");
        await check(page.locator(".settings-panel"), "assistant-settings", theme, "defaults-and-delegations");
      });

      test("Assistant Connections aligns nine connection names with their chevrons", async ({ page }) => {
        await open(page, theme, viewPath(assistantConnectionsView()), "limits=stress");
        const surface = page.locator(".assistant-connections-page");
        const rows = surface.locator(".assistant-connection-row");
        await expect(rows).toHaveCount(9);
        await expectAligned(rows, ".setting-row-title", ".setting-row-chevron");
        await check(surface, "assistant-connections", theme, "nine-connections");
      });

      test("New Thread aligns option text with the trailing chevrons", async ({ page }) => {
        await open(page, theme, viewPath({ name: "assistants", newThread: true }), "accounts=composer-stress&limits=enabled");
        const surface = page.getByRole("form", { name: "What should the assistant work on?" });
        await expectAligned(surface.locator(".new-assistant-option"), "span", "svg:last-child");
        await surface.getByRole("textbox", { name: "First Message" }).fill("Review the open work for the next release.");
        await expect(surface.getByRole("button", { name: "Start Thread" })).toBeInViewport({ ratio: 1 });
        await check(surface, "new-thread", theme, "first-message");
        await surface.getByRole("button", { name: /^Account / }).click();
        const picker = page.getByRole("dialog", { name: "Account", exact: true });
        await expect(picker.getByRole("radio")).toHaveCount(8);
        await picker.locator("summary").click();
        await expect(picker.locator("details li")).toHaveCount(4);
        await check(picker, "new-thread", theme, "eleven-accounts");
      });

      test("toasts align the dismiss control and icon with the message", async ({ page }) => {
        await open(page, theme, threadPath, "dock=owner&confirm=3&long-confirmation-title");
        await page.getByRole("button", { name: "Approve Once", exact: true }).click();
        const toast = page.locator(".toast").filter({ hasText: /ran once/i });
        await expect(toast).toContainText("Cross-Platform Verification ran once.");
        await expect(toast).toBeInViewport({ ratio: 1 });
        await expectAligned(toast, ".toast-message", ".toast-actions > button", ".toast-icon");
        await check(toast, "toasts", theme, "request-approved");
      });
    });
  }
}
