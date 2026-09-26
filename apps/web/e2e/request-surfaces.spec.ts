import { expect, test, type Page } from "@playwright/test";

async function assertNoHorizontalOverflow(page: Page, selector: string) {
  const geometry = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

async function assertActionsInsideRequestPanel(page: Page) {
  const geometry = await page.locator(".request-panel-detail, .evidence-review-actions").evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().toJSON()));
  expect(geometry).toHaveLength(2);
  expect(geometry[1]!.top).toBeGreaterThanOrEqual(geometry[0]!.top - 1);
  expect(geometry[1]!.bottom).toBeLessThanOrEqual(geometry[0]!.bottom + 1);
}

async function assertActionsInsidePanel(page: Page, selector: string) {
  const geometry = await page.locator(`.right-panel, ${selector}`).evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().toJSON()));
  expect(geometry).toHaveLength(2);
  expect(geometry[1]!.top).toBeGreaterThanOrEqual(geometry[0]!.top - 1);
  expect(geometry[1]!.bottom).toBeLessThanOrEqual(geometry[0]!.bottom + 1);
}

test("evidence actions remain reachable in a short desktop panel with child requests", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 480 });
  await page.goto("/request-surfaces-e2e.html?scenario=evidence&items=8&children=1");
  await page.getByRole("button", { name: "Review Evidence" }).click();

  await expect(page.locator(".request-panel-row")).toHaveCount(13);
  await assertActionsInsideRequestPanel(page);
  const checks = page.locator('.evidence-review-item input[type="checkbox"]');
  await expect(checks.first()).toBeVisible();
  for (let index = 0; index < 8; index += 1) await checks.nth(index).check();
  await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled();
  const detail = page.locator(".request-panel-detail");
  await detail.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await assertActionsInsideRequestPanel(page);
  for (const button of ["Approve", "Deny"]) {
    const height = await page.getByRole("button", { name: button }).evaluate((element) =>
      element.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(44);
  }
});

test("short desktop evidence review preserves child identity and navigation", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 480 });
  await page.goto("/request-surfaces-e2e.html?scenario=evidence&children=1");
  await page.getByRole("button", { name: "Review Evidence" }).click();
  await page.getByRole("button", { name: /^Child Session 1 UI Evidence/u }).click();

  await expect(page.locator(".request-panel-detail-head h3")).toHaveText("Child Session 1");
  const openChild = page.getByRole("button", { name: "Open Child Session" });
  await expect(openChild).toBeVisible();
  await openChild.click();
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_REQUEST_SURFACES_E2E__.openedChild()?.sessionId)).toBe("child-1");
});
test("legacy inline evidence fixture reproduces the mobile over-height review", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/request-surfaces-e2e.html?scenario=legacy");
  await page.getByRole("button", { name: "Details" }).click();
  const approval = page.locator(".approval-bar");
  await expect(approval).toBeVisible();
  const bounds = await approval.boundingBox();
  expect(bounds!.height).toBeGreaterThan(844 * 0.7);
  const transcriptHeight = await page.getByRole("region", { name: "Session Activity" })
    .evaluate((element) => element.clientHeight);
  expect(transcriptHeight).toBeLessThan(120);
});

test("missing campaign continuation result is visible and explicitly acknowledged", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/request-surfaces-e2e.html?scenario=continuation");
  const notice = page.getByRole("status", { name: "Campaign Continuation: Missing Result" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("3 Pending Events · Attempt 2");
  await expect(notice).toContainText("It will not be replayed automatically");
  await page.getByRole("button", { name: "Acknowledge Missing Result" }).click();
  await expect(notice).toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([{
      commandId: "campaign_prompt_evidence",
      action: "dismiss",
    }]);
});

test("worker-owned approval stays canonical while its transcript row opens worker review", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/request-surfaces-e2e.html?scenario=worker");
  await expect(page.locator(".approval-bar")).toHaveCount(0);
  await page.getByRole("button", { name: "Review Request" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_REQUEST_SURFACES_E2E__.workerReviewOpened())).toBe(true);
});

for (const viewport of [
  { name: "mobile portrait", width: 390, height: 844 },
  { name: "mobile landscape", width: 844, height: 390 },
  { name: "desktop", width: 1280, height: 800 },
  { name: "desktop split pane", width: 900, height: 700 },
]) {
  test(`eight-item evidence review remains reachable at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=evidence");
    const transcript = page.getByRole("region", { name: "Session Activity" });
    await expect(transcript).toBeVisible();
    const initialHeight = await transcript.evaluate((element) => element.clientHeight);
    expect(initialHeight).toBeGreaterThan(Math.min(220, viewport.height * 0.35));
    await expect(page.locator(".approval-bar")).toHaveCount(0);

    const trigger = page.getByRole("button", { name: "Review Evidence" });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const panel = page.getByRole("complementary", { name: "Requests" });
    await expect(panel).toBeVisible();
    await expect(page.getByRole("button", { name: "Close Panel" })).toBeVisible();
    await expect(page.getByRole("status", { name: "" })).toContainText("0 of 8 Reviewed");
    await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
    await expect(page.locator(".evidence-review-item")).toHaveCount(8);
    await expect(page.locator(".approval-context")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("signature=hidden");
    await assertNoHorizontalOverflow(page, ".request-panel");

    if (viewport.width <= 760) {
      const overflow = await page.locator(".request-panel").evaluate((element) => ({
        own: getComputedStyle(element).overflowY,
        list: getComputedStyle(element.querySelector(".evidence-review-list")!).overflowY,
      }));
      expect(overflow.own).toBe("auto");
      expect(overflow.list).toBe("visible");
    } else {
      const bounds = await page.locator(".detail-chat, .right-panel").evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().toJSON()));
      expect(bounds[0]!.width).toBeGreaterThan(300);
      expect(bounds[1]!.width).toBeLessThanOrEqual(Math.floor(viewport.width * 0.4) + 1);
    }

    const checks = page.locator('.evidence-review-item input[type="checkbox"]');
    for (let index = 0; index < 3; index += 1) await checks.nth(index).check();
    await expect(page.locator(".evidence-review-summary").getByRole("status")).toContainText("3 of 8 Reviewed");
    await page.getByRole("button", { name: "Close Panel" }).click();
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.setViewportSize(viewport.width <= 760
      ? { width: viewport.height, height: viewport.width }
      : viewport);
    await trigger.click();
    await expect(page.locator(".evidence-review-summary").getByRole("status")).toContainText("3 of 8 Reviewed");
    for (let index = 3; index < 8; index += 1) await checks.nth(index).check();
    await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => page.evaluate(() =>
      window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([{
        requestId: "evidence-occurrence",
        optionId: "approve",
        evidenceReviewed: Array.from({ length: 8 }, (_, index) => `viewport-${index + 1}`),
      }]);
  });
}

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "split pane", width: 900, height: 800 },
  { name: "desktop", width: 1280, height: 800 },
]) {
  test(`descendant polling states remain readable on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=polling&pollStatus=loading");
    await page.getByRole("button", { name: "Needs Your Input: 1 Requests" }).click();
    await expect(page.getByRole("heading", { name: "Loading Requests" })).toBeVisible();
    await assertNoHorizontalOverflow(page, "#right-panel");

    await page.goto("/request-surfaces-e2e.html?scenario=polling&pollStatus=unavailable");
    await page.getByRole("button", { name: "Needs Your Input: 1 Requests" }).click();
    await expect(page.getByRole("heading", { name: "Requests Unavailable" })).toBeVisible();
    await expect(page.locator(".request-panel-empty button")).toHaveCount(0);
    await assertNoHorizontalOverflow(page, "#right-panel");
  });
}

for (const viewport of [
  { name: "mobile breakpoint", width: 760, height: 800 },
  { name: "desktop breakpoint", width: 761, height: 800 },
  { name: "split pane", width: 900, height: 800 },
  { name: "desktop", width: 1280, height: 800 },
]) {
  for (const itemCount of [3, 8]) {
    test(`evidence actions stay visible with ${itemCount} items at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/request-surfaces-e2e.html?scenario=evidence&items=${itemCount}`);
      await page.getByRole("button", { name: "Review Evidence" }).click();

      const actions = page.locator(".evidence-review-actions");
      await expect(actions.getByRole("button", { name: "Approve" })).toBeDisabled();
      await expect(actions.getByRole("button", { name: "Deny" })).toBeVisible();
      await assertActionsInsideRequestPanel(page);

      const scrollOwner = page.locator(viewport.width <= 760 ? ".request-panel" : ".evidence-review-list");
      await scrollOwner.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await assertActionsInsideRequestPanel(page);
    });
  }
}

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
]) {
  test(`standalone approval uses its transcript row and responsive review on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=standalone");

    const transcript = page.getByRole("region", { name: "Session Activity" });
    await expect(transcript).toBeVisible();
    expect(await transcript.evaluate((element) => element.clientHeight)).toBeGreaterThan(viewport.height * 0.35);
    await expect(page.locator(".approval-bar")).toHaveCount(0);
    const requestRow = page.locator(".tl-perm");
    await expect(requestRow).toHaveCount(1);
    await expect(requestRow).toContainText("Trust Worktree Setup Configuration?");
    const transcriptDetails = requestRow.locator(".perm-context");
    await expect(transcriptDetails).not.toHaveAttribute("open", "");
    await expect(transcriptDetails.locator("pre")).not.toBeVisible();

    const trigger = requestRow.getByRole("button", { name: "Review Request" });
    await trigger.scrollIntoViewIfNeeded();
    const transcriptPosition = await transcript.evaluate((element) => element.scrollTop);
    await trigger.click();
    const panel = page.getByRole("complementary", { name: "Requests" });
    await expect(panel).toBeVisible();
    await expect(page.locator(".approval-review-surface")).toBeVisible();
    await expect(page.locator(".approval-selector-context")).toContainText("wollipog.worktree_setup");
    await expect(page.locator(".approval-selector-context")).toContainText("fix/responsive-approval");
    const panelDetails = page.locator(".approval-review-details");
    await expect(panelDetails).not.toHaveAttribute("open", "");
    await expect(panelDetails.locator("pre")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Trust This Configuration" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Without Setup" })).toBeVisible();
    await assertActionsInsidePanel(page, ".approval-review-actions");

    await panelDetails.locator("summary").click();
    await expect(panelDetails.locator("pre")).toContainText("pnpm setup:step-12");
    const scrollOwner = page.locator(viewport.width <= 760 ? ".request-panel" : ".approval-review-body");
    await scrollOwner.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await assertActionsInsidePanel(page, ".approval-review-actions");

    await page.getByRole("button", { name: "Close Panel" }).click();
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(transcriptPosition);

    await trigger.click();
    await page.getByRole("button", { name: "Trust This Configuration" }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review Request" })).toHaveCount(0);
    await expect(requestRow).toHaveCount(1);
    await expect(requestRow).toContainText("trust");
    await expect.poll(() => page.evaluate(() =>
      window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([{
        requestId: "worktree-setup:one:hash",
        optionId: "trust",
      }]);
  });
}

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
]) {
  test(`high-count descendant requests use one inbox on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=descendants");
    await expect(page.locator(".descendant-request-region")).toHaveCount(0);
    const trigger = page.getByRole("button", { name: "Needs Your Input: 8 Requests" });
    await expect(trigger).toBeVisible();
    await expect(page.getByRole("button", { name: "Orchestrator Action: 4 Requests" })).toBeVisible();
    await trigger.click();
    await expect(page.locator(".request-panel-row")).toHaveCount(12);
    await expect(page.locator(".request-panel-count")).toContainText("Needs Your Input 8");
    await expect(page.locator(".request-panel-count")).toContainText("Orchestrator Action 4");
    await assertNoHorizontalOverflow(page, ".request-panel");

    const rows = page.locator(".request-panel-row");
    await rows.nth(8).scrollIntoViewIfNeeded();
    await rows.nth(8).click();
    await expect(page.locator(".request-owner")).toHaveText("Assigned to Orchestrator");
    await expect(page.locator(".request-readonly")).toContainText(
      "must respond through its session-management tools",
    );
    await expect(page.locator(".request-readonly .approval-actions")).toHaveCount(0);
    await page.getByRole("button", { name: "Open Child Session" }).click();
    await expect.poll(() => page.evaluate(() =>
      window.__WOLLIPOG_REQUEST_SURFACES_E2E__.openedChild()?.sessionId)).toBe("child-3");

    await rows.nth(11).scrollIntoViewIfNeeded();
    await expect(rows.nth(11)).toBeVisible();
    await page.getByRole("button", { name: "Close Panel" }).click();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(rows.nth(8)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: "Requests" })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile portrait", width: 390, height: 844 },
]) {
  test(`campaign held children are listed apart from requests and leave when the hold clears at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=held");
    const held = page.getByRole("region", { name: "Held Children" });
    await expect(held).toBeVisible();
    const entries = held.locator(".campaign-held-child");
    await expect(entries).toHaveCount(2);
    await expect(held).toContainText("1 other blocked child is not listed here, such as failed or stopped children.");

    const recovery = entries.nth(0);
    const link = recovery.getByRole("link", { name: "Fix #1650: Keep a Decision Resume Across Worktree Recovery" });
    await expect(link).toBeVisible();
    await expect(recovery).toContainText("Worktree Recovery");
    await expect(recovery).toContainText("is on branch main, not fix/issue-1650-decision-resume.");
    await expect(recovery.locator("dd code").first())
      .toHaveText("git -C /home/dev/worktrees/issue-1650 switch fix/issue-1650-decision-resume");
    await expect(recovery.locator("dt")).toHaveText(["Hold", "Reason", "Recovery Action", "Held Decision Resumes"]);
    await expect(recovery).toContainText("wd_occ_merge_1752");
    await expect(entries.nth(1)).toContainText("Handoff Barrier");
    await expect(entries.nth(1).locator("dt")).toHaveText(["Hold", "Reason", "Recovery Action"]);

    // A hold asks nothing: no control beyond the child link, and no row in the request inbox.
    await expect(held.getByRole("button")).toHaveCount(0);
    await expect(held.getByRole("textbox")).toHaveCount(0);
    await assertNoHorizontalOverflow(page, ".campaign-held-children");
    await page.getByRole("button", { name: "Needs Your Input: 8 Requests" }).click();
    await expect(page.locator(".request-panel-row")).toHaveCount(12);
    await expect(page.locator(".request-panel-row", { hasText: /Fix #165[01]/u })).toHaveCount(0);
    await page.getByRole("button", { name: "Close Panel" }).click();

    await link.click();
    await expect.poll(() => page.evaluate(() =>
      window.__WOLLIPOG_REQUEST_SURFACES_E2E__.openedHeldChild())).toBe("held-child-1");

    // The campaign projection drops a child once its hold clears; the entry and the count follow.
    await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.clearHold("held-child-1"));
    await expect(entries).toHaveCount(1);
    await expect(held).toContainText("1 other blocked child is not listed here");
    await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.clearHold("held-child-2"));
    await expect(held).toHaveCount(0);
  });
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile portrait", width: 390, height: 844 },
]) {
  test(`a held child whose handoff the runner bounds says when the work ends, not to restart, at ${viewport.name} (#1778)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=held&bounded=1");
    const held = page.getByRole("region", { name: "Held Children" });
    const entry = held.locator(".campaign-held-child");
    await expect(entry).toHaveCount(1);
    await expect(entry.getByRole("link", { name: "Fix #1778: Bound a Handoff Held by a Never-Ending Job" })).toBeVisible();
    await expect(entry).toContainText("Worktree Rebind");
    await expect(entry.locator("dt")).toHaveText(["Hold", "Reason", "Recovery Action", "Held Decision Resumes"]);
    await expect(entry).toContainText("waits for 1 background job with no terminal status (a monitor started at");
    await expect(entry).toContainText(new RegExp(
      "If it is still running at \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z, Wollipog ends it, records it as killed, and then runs " +
      "the handoff and the queued messages in order", "u"));
    await expect(entry).toContainText("Do not restart the session to get past this hold: a restart discards the queued messages.");
    await expect(entry).not.toContainText("restart_session");
    await expect(entry).toContainText("wd_occ_merge_1778");
    await assertNoHorizontalOverflow(page, ".campaign-held-children");
  });

  test(`a held child whose runner keeps the queue across a restart says what a restart keeps, at ${viewport.name} (#1779)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=held&bounded=legacy&restart=keeps");
    const entry = page.getByRole("region", { name: "Held Children" }).locator(".campaign-held-child");
    await expect(entry).toHaveCount(1);
    await expect(entry.locator("dt")).toHaveText(["Hold", "Reason", "Recovery Action", "Held Decision Resumes"]);
    await expect(entry).toContainText(
      "restart the session with restart_session, knowing what that costs: the provider and its background job end, and " +
      "the new conversation is told each job's result or that it cannot be recovered; the queued messages are kept and " +
      "run after the restart; and any approved workflow decision the session has not yet consumed is revoked, and the " +
      "restarted session is told which ones to request again.");
    await expect(entry).not.toContainText("discarded");
    await assertNoHorizontalOverflow(page, ".campaign-held-children");

    await page.goto("/request-surfaces-e2e.html?scenario=held&bounded=1&restart=keeps");
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("Prefer waiting to restarting the session: a restart keeps the queued messages but " +
      "ends every background job and starts a new conversation.");
    await expect(entry).not.toContainText("discards");
    await assertNoHorizontalOverflow(page, ".campaign-held-children");
  });
}
