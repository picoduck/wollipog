import { expect, test, type Page } from "@playwright/test";

const opaque = (value: string) => Buffer.from(value, "utf16le").toString("base64url");
const sessionPath = (id: string) => `/sessions/~${opaque(id)}`;
const shell = (path: string) => `/sessions-board-e2e.html?full-shell=1&path=${encodeURIComponent(path)}`;
const entryShell = (path: string) => `${shell(path)}&entry-regressions=1`;
const attentionPath = (id: string, requestId?: string) => `${sessionPath(id)}/attention${requestId ? `/~${opaque(requestId)}` : ""}?epoch=7`;
const agents = (page: Page) => page.getByRole("complementary", { name: "Agents", exact: true });
const openPanelMode = async (page: Page, mode: string) => {
  if (!await page.locator("#right-panel").count()) await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  const back = page.getByRole("button", { name: "Back to Panel List", exact: true });
  if (await back.count()) await back.click();
  await page.getByRole("button", { name: mode, exact: true }).click();
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
  test(`ordinary entry with worker requests keeps the transcript visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(shell(sessionPath("s-approval")));
    await expect(page.locator(".session-detail.expanded .composer-input")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Agents", exact: true })).toHaveCount(0);
    await page.screenshot({ path: `/tmp/issue-2718-evidence/after-default-${width === 390 ? "mobile" : "desktop"}.png`, fullPage: true });
  });

  test(`Orchestrator-to-Standard and repeated entry discard Agents visibility at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(entryShell(sessionPath("s-approval")));
    await expect(page.locator(".request-dock")).toContainText("Where should the release go?");
    await expect(agents(page)).toHaveCount(0);
    await openPanelMode(page, "Agents");
    await expect(agents(page)).toBeVisible();
    await page.getByRole("button", { name: "Back to Sessions", exact: true }).click();
    await expandFromList(page, "Running Session");
    await expect(agents(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Back to Sessions", exact: true }).click();
    await expandFromList(page, "Approval Session");
    await expect(agents(page)).toHaveCount(0);
    await openPanelMode(page, "Agents");
    await expect(agents(page)).toBeVisible();
    await page.getByRole("button", { name: "Close Panel", exact: true }).click();
    await page.evaluate(() => {
      window.__updateEntrySession({ eventEpoch: 8 });
      window.__replayProviderLoginSnapshot();
    });
    await expect(page.locator(".request-dock")).toContainText("Where should the release go?");
    await expect(agents(page)).toHaveCount(0);
    await page.screenshot({ path: `/tmp/issue-2718-evidence/after-${width === 390 ? "mobile" : "desktop"}.png`, fullPage: true });
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
    await page.getByRole("button", { name: "Back to Sessions", exact: true }).click();
    await expandFromList(page, "Running Session");
    await openPanelMode(page, "Side Chat");
    await expect(page.getByRole("textbox", { name: "Side Chat Message", exact: true })).toHaveValue("");
    await openPanelMode(page, "Agents");
    await page.getByRole("button", { name: "Back to Sessions", exact: true }).click();
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
        await page.getByRole("button", { name: "Close Panel", exact: true }).click();
        await page.evaluate(() => window.__replayProviderLoginSnapshot());
        await expect(agents(page)).toHaveCount(0);
      }
    });
  }

  test(`descendant request navigation reveals its exact dock without Agents at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(entryShell(sessionPath("s-approval")));
    await openPanelMode(page, "Requests");
    await page.getByRole("button", { name: "Open Child Session", exact: true }).click();
    const heading = page.locator(".request-dock .request-card").getByRole("heading");
    await expect(heading).toHaveText("Primary Request");
    await expect(heading).toBeFocused();
    await expect(agents(page)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("path")).toBe(attentionPath("s-queued", "primary-1"));
  });
}
