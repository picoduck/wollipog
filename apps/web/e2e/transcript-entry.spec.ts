import { expect, test, type Page } from "@playwright/test";

const opaque = (value: string) => Buffer.from(value, "utf16le").toString("base64url");
const sessionPath = (id: string) => `/sessions/~${opaque(id)}`;
const shell = (path: string) => `/sessions-board-e2e.html?full-shell=1&path=${encodeURIComponent(path)}`;
const entryShell = (path: string) => `${shell(path)}&entry-regressions=1`;
const attentionPath = (id: string, requestId?: string) => `${sessionPath(id)}/attention${requestId ? `/~${opaque(requestId)}` : ""}?epoch=7`;
const agents = (page: Page) => page.locator('#right-panel[data-mode="subagents"]');
const navigateWithinShell = async (page: Page, path: string) => {
  await page.evaluate((path) => {
    const url = new URL(location.href);
    url.searchParams.set("path", path);
    history.pushState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
};
const openPanelMode = async (page: Page, mode: string) => {
  if (!await page.locator("#right-panel").count()) await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  // Every tool is in the header's tool switcher (#2843).
  await page.locator("#right-panel .rpanel-switcher").click();
  await page.getByRole("menuitemradio", { name: mode, exact: true }).click();
};
/** Leaves the session for the list: its bar's Back, or on a phone whose open panel covers that bar
 * (#2843), the Sessions tab. */
const leaveSession = async (page: Page) => {
  const back = page.getByRole("button", { name: "Back to Sessions", exact: true });
  if (await back.isVisible()) await back.click();
  else await page.getByRole("link", { name: "Sessions", exact: true }).click();
};
const expandFromList = async (page: Page, title: string) => {
  const row = page.locator(".inbox-row-shell", { hasText: title }).locator(".inbox-row");
  await row.click();
  await expect(page.locator(".session-detail")).toBeVisible();
  if (!await page.locator(".session-detail.expanded").count()) {
    await page.getByRole("button", { name: "Open Session", exact: true }).click();
  }
  await expect(page.locator(".session-detail.expanded .composer-input")).toBeVisible();
};

// Record every mounted Agents surface, including one that disappears before a settled assertion.
const observeAgents = async (page: Page) => {
  await page.addInitScript(() => {
    (window as unknown as { __agentsMounts: number }).__agentsMounts = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('aside[aria-label="Agents"]') || node.querySelector('aside[aria-label="Agents"]')) {
          (window as unknown as { __agentsMounts: number }).__agentsMounts += 1;
        }
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
};

for (const width of [390, 1440]) {
  test(`same-session worker attention preserves the deliberate Agents surface at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(entryShell(sessionPath("s-approval")));
    await page.evaluate(() => window.__updateEntrySession({ pendingApproval: {
      requestId: "worker-question", ownerToolUseId: "fixture-child", kind: "question",
      title: "Choose the Worker Check", options: [], questions: [{ id: "check", header: "Check",
        question: "Which check should the worker run?", options: [{ label: "Unit Tests" }] }],
    } }));
    await openPanelMode(page, "Agents");
    await agents(page).evaluate((panel) => panel.setAttribute("data-entry-mount", "original"));
    if (width === 1440) {
      await page.locator(".session-bar .session-status-button").click();
      await page.getByRole("dialog", { name: "Session Status" }).getByRole("button", { name: "Answer", exact: true }).click();
    } else {
      await navigateWithinShell(page, attentionPath("s-approval", "worker-question"));
    }
    await expect(agents(page)).toHaveAttribute("data-entry-mount", "original");
    await expect(agents(page).getByRole("region", { name: "Selected Worker Request" })).toBeFocused();
    // Returning to this session's ordinary route is a new transcript entry.
    await navigateWithinShell(page, sessionPath("s-approval"));
    await expect(agents(page)).toHaveCount(0);
  });

  test(`own attention preserves desktop panels and dismisses phone overlays at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(entryShell(sessionPath("s-approval")));
    await openPanelMode(page, "Side Chat");
    await page.getByRole("textbox", { name: "Side Chat Message", exact: true }).fill("Keep this draft");
    await navigateWithinShell(page, attentionPath("s-approval", "async-question"));
    await expect(page.locator(".request-dock").getByRole("heading").first()).toBeFocused();
    await expect(page.locator("#right-panel")).toHaveCount(width === 1440 ? 1 : 0);
    if (width === 1440) await expect(page.getByRole("textbox", { name: "Side Chat Message", exact: true })).toHaveValue("Keep this draft");
  });

  test(`ordinary entry keeps the transcript visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(shell(sessionPath("s-approval")));
    await expect(page.locator(".session-detail.expanded .composer-input")).toBeVisible();
    await expect(page.locator('#right-panel[data-mode="subagents"]')).toHaveCount(0);
  });

  test(`Orchestrator-to-Standard and repeated entry discard Agents visibility at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(entryShell(sessionPath("s-approval")));
    await expect(page.locator(".request-dock")).toContainText("Where should the release go?");
    await expect(agents(page)).toHaveCount(0);
    await openPanelMode(page, "Agents");
    await expect(agents(page)).toBeVisible();
    await leaveSession(page);
    await expandFromList(page, "Running Session");
    await expect(agents(page)).toHaveCount(0);
    await leaveSession(page);
    await expandFromList(page, "Approval Session");
    await expect(agents(page)).toHaveCount(0);
    await openPanelMode(page, "Agents");
    await expect(agents(page)).toBeVisible();
    await page.getByRole("button", { name: /^(Close Panel|Back to Session)$/u }).click();
    await page.evaluate(() => {
      window.__updateEntrySession({ eventEpoch: 8 });
      window.__replayProviderLoginSnapshot();
    });
    await expect(page.locator(".request-dock")).toContainText("Where should the release go?");
    await expect(agents(page)).toHaveCount(0);
  });

  test(`persisted Agents-open state keeps ordinary entry on the transcript at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const keys = ["open", "mode", "width"].map((key) => `wollipog.rightpanel.${key}`);
    await page.addInitScript(({ keys }) => {
      for (const [index, value] of ["1", "subagents", "432"].entries()) localStorage.setItem(keys[index]!, value);
    }, { keys });
    await observeAgents(page);
    await page.goto(entryShell(sessionPath("s-approval")));
    await expect(page.locator(".request-dock")).toContainText("Where should the release go?");
    await expect(agents(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __agentsMounts: number }).__agentsMounts)).toBe(0);
    await page.getByRole("button", { name: "Side Panel", exact: true }).click();
    await expect(agents(page)).toBeVisible();
    if (width === 1440) await expect(page.getByRole("separator", { name: "Resize Panel" })).toHaveAttribute("aria-valuenow", "432");
  });

  test(`late ordinary hydration and leaving a cold worker link cannot open Agents at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await observeAgents(page);
    await page.goto(`${entryShell(sessionPath("s-approval"))}&entry-cold=1`);
    await expect.poll(() => page.evaluate(() => typeof window.__hydrateEntrySession)).toBe("function");
    await page.evaluate(() => window.__hydrateEntrySession());
    await expect(page.locator(".request-dock")).toContainText("Where should the release go?");
    await expect(agents(page)).toHaveCount(0);
    await page.goto(`${entryShell(attentionPath("s-approval", "worker-question"))}&entry-cold=1`);
    await expect.poll(() => page.evaluate(() => typeof window.__hydrateEntrySession)).toBe("function");
    await page.getByRole("link", { name: "Sessions", exact: true }).click();
    await expandFromList(page, "Running Session");
    await page.evaluate(() => window.__hydrateEntrySession());
    await expect(page.locator(".session-detail.expanded .composer-input")).toBeVisible();
    await expect(agents(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __agentsMounts: number }).__agentsMounts)).toBe(0);
  });

  test(`panel drafts survive Agents dismissal and session navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(entryShell(sessionPath("s-approval")));
    await openPanelMode(page, "Side Chat");
    await page.getByRole("textbox", { name: "Side Chat Message", exact: true }).fill("Keep this unsent panel draft");
    await openPanelMode(page, "Agents");
    await leaveSession(page);
    await expandFromList(page, "Running Session");
    await openPanelMode(page, "Side Chat");
    await expect(page.getByRole("textbox", { name: "Side Chat Message", exact: true })).toHaveValue("");
    await openPanelMode(page, "Agents");
    await leaveSession(page);
    await expandFromList(page, "Approval Session");
    await openPanelMode(page, "Side Chat");
    await expect(page.getByRole("textbox", { name: "Side Chat Message", exact: true })).toHaveValue("Keep this unsent panel draft");
  });

  for (const requestId of ["async-question", "worker-question"]) {
    test(`cold ${requestId} attention waits for the exact surface at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await observeAgents(page);
      await page.goto(`${entryShell(attentionPath("s-approval", requestId))}&entry-cold=1`);
      await expect.poll(() => page.evaluate(() => typeof window.__hydrateEntrySession)).toBe("function");
      await expect(agents(page)).toHaveCount(0);
      await page.evaluate(() => window.__hydrateEntrySession());
      const surface = requestId === "async-question" ? page.locator(".request-dock") : agents(page);
      await expect(surface).toContainText(requestId === "async-question" ? "Where should the release go?" : "Which check should the worker run?");
      if (requestId === "async-question") {
        await expect(surface.getByRole("heading").first()).toBeFocused();
        expect(await page.evaluate(() => (window as unknown as { __agentsMounts: number }).__agentsMounts)).toBe(0);
      } else {
        await expect(surface.getByRole("region", { name: "Selected Worker Request" })).toBeFocused();
        await surface.getByRole("radio", { name: "Unit Tests", exact: true }).check();
        await expect(surface.getByRole("radio", { name: "Unit Tests", exact: true })).toBeChecked();
        await page.getByRole("button", { name: /^(Close Panel|Back to Session)$/u }).click();
        await page.evaluate(() => window.__replayProviderLoginSnapshot());
        await expect(agents(page)).toHaveCount(0);
      }
    });
  }

  test(`descendant request navigation reveals its exact dock without Agents at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(entryShell(sessionPath("s-approval")));
    await openPanelMode(page, "Requests");
    await page.locator(".request-panel-row").first().click();
    // #2206 moves the child-session control into the selected request's detail link.
    const childLink = page.locator(".request-panel-child");
    if (await childLink.count()) await childLink.click();
    else await page.getByRole("button", { name: "Open Child Session", exact: true }).click();
    const heading = page.locator(".request-dock .request-card").getByRole("heading");
    await expect(heading).toHaveText("Primary Request");
    await expect(heading).toBeFocused();
    await expect(agents(page)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("path")).toBe(attentionPath("s-queued", "primary-1"));
  });
}

for (const width of [834, 940, 1099, 1100, 1440]) for (const entry of ["link", "status"]) {
  test(`own request ${entry} dismisses an overlapping Requests panel only in compact layouts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(entryShell(sessionPath("s-approval")));
    if (entry === "status") await page.evaluate(() => window.__updateEntrySession({ pendingApproval: {
      requestId: "async-question", kind: "question", title: "Choose the Release Target", async: true,
      options: [], questions: [{ id: "target", header: "Target", question: "Where should the release go?",
        options: [{ label: "Staging" }, { label: "Production" }], allowOther: true }],
    } }));
    await openPanelMode(page, "Requests");
    await expect(page.locator(".request-panel-row").first()).toBeVisible();
    if (entry === "link") await navigateWithinShell(page, attentionPath("s-approval", "async-question"));
    else {
      await page.locator(".session-bar .session-status-button").click();
      await page.getByRole("dialog", { name: "Session Status" }).getByRole("button", { name: "Answer", exact: true }).click();
    }
    await expect(page.locator(".request-dock").getByRole("heading").first()).toBeFocused();
    await expect(page.locator("#right-panel")).toHaveCount(width < 1100 ? 0 : 1);
  });
}
