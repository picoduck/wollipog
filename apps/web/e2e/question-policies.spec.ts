import { expect, test, type Locator, type Page } from "@playwright/test";

/** Settings › Approvals in the question-policies harness (#2158). */
const APPROVALS = "/question-policies-e2e.html?set=approvals";
const EVIDENCE = process.env.APPROVALS_EVIDENCE;

/** The viewport, not the full page: the section scrolls inside `.main-body`, and a full-page capture
 * resizes the window, which dismisses an open popover. */
async function capture(page: Page, name: string) {
  if (!EVIDENCE) return;
  // Popovers and sheets fade in; a capture on their first frame shows nothing.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map((animation) => animation.finished)));
  await page.screenshot({ path: `${EVIDENCE}/${name}.png` });
}

function routine(page: Page): Locator {
  return page.getByRole("region", { name: "Routine Questions" });
}

function tools(page: Page): Locator {
  return page.getByRole("region", { name: "Tool Policies" });
}

test.use({ reducedMotion: "reduce" });

test("starter categories start off, persist independently, and keep their stored fields", async ({ page }) => {
  await page.goto(APPROVALS);
  const switches = routine(page).getByRole("switch");
  await expect(switches).toHaveCount(3);
  for (const control of await switches.all()) await expect(control).toHaveAttribute("aria-checked", "false");
  await switches.nth(0).click();
  await expect(switches.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(switches.nth(1)).toHaveAttribute("aria-checked", "false");
  await expect(routine(page).getByText("Saved", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const policies = JSON.parse(sessionStorage.getItem("question-policies")!);
    policies[0].scope.runnerId = "chosen-runner";
    policies[0].priority = 7;
    sessionStorage.setItem("question-policies", JSON.stringify(policies));
  });
  await page.reload();
  await switches.nth(0).click();
  await expect(switches.nth(0)).toHaveAttribute("aria-checked", "false");
  await switches.nth(0).click();
  await expect(switches.nth(0)).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("question-policies")!)[0].scope.runnerId)).toBe("chosen-runner");
  await switches.nth(2).click();
  await expect(switches.nth(2)).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(switches.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(switches.nth(1)).toHaveAttribute("aria-checked", "false");
  await expect(switches.nth(2)).toHaveAttribute("aria-checked", "true");
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("Approvals sits between Behavior and Orchestrator and holds the three groups", async ({ page }) => {
      await page.goto(`${APPROVALS}&custom`);
      await expect(page.locator(".settings-section-link")).toContainText(["Behavior", "Approvals", "Orchestrator"]);
      const titles = await page.locator(".settings-section-link").allTextContents();
      expect(titles.indexOf("Approvals")).toBe(titles.indexOf("Behavior") + 1);
      expect(titles.indexOf("Orchestrator")).toBe(titles.indexOf("Approvals") + 1);
      await expect(page.locator(".settings-section-link[aria-current=page]")).toHaveText("Approvals");
      await expect(page.locator("#settings-panel-heading")).toHaveText("Approvals");
      await expect(page.locator(".settings-group > h3")).toHaveText(["Answering Questions", "Routine Questions", "Tool Policies"]);
      await expect(routine(page).locator(".ui-row-title")).toHaveText([
        "Review Sharing and Retries", "Push and Open Pull Requests", "Evidence Upload", "Release Notes Drafts",
      ]);
      await expect(tools(page).locator(".ui-row-title")).toHaveText([
        "Deny Shell Commands in Production", "Ask Before Deploys", "Allow Running the Web Unit Tests",
        "Block the Staging Network", "Review Agent-Created Sessions",
      ]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      // A name is the row's content: it is never cut short for the labels and meta beside it.
      for (const title of await page.locator(".settings-panel .ui-row-title").all()) {
        expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), await title.innerText()).toBe(true);
      }
    });

    test("a custom question policy is listed after the starters and toggles through the same route", async ({ page }) => {
      await page.goto(`${APPROVALS}&custom`);
      const custom = routine(page).getByRole("switch", { name: "Release Notes Drafts" });
      await expect(custom.getByText("Custom", { exact: true })).toBeVisible();
      await expect(custom).toHaveAttribute("aria-checked", "true");
      await expect(routine(page)).not.toContainText("Bob's Own Policy");
      await custom.click();
      await expect(custom).toHaveAttribute("aria-checked", "false");
      expect(await page.evaluate(() => (window as unknown as { governanceWrites: string[] }).governanceWrites))
        .toEqual(["questions:custom:release-notes:alice"]);
    });

    test("a failed save stays on its row with Try Again, and nothing else moves", async ({ page }) => {
      await page.goto(`${APPROVALS}&custom&failure`);
      const rows = page.locator(".settings-panel .ui-row");
      const boxes = async () => (await rows.evaluateAll((elements) => elements.map((element) => {
        const box = element.getBoundingClientRect();
        return [Math.round(box.top), Math.round(box.height)];
      })));
      await expect(tools(page).locator(".ui-row")).toHaveCount(5);
      const before = await boxes();
      const scroll = await page.evaluate(() => document.querySelector(".main-body")!.scrollTop);
      const push = routine(page).getByRole("switch", { name: "Push and Open Pull Requests" });
      await push.click();
      const failure = routine(page).locator(".ui-row-failure");
      await expect(failure).toHaveCount(1);
      await expect(failure).toHaveText("Couldn't save this change. Try Again");
      await expect(push).toHaveAttribute("aria-checked", "false");
      await expect(failure.getByRole("button", { name: "Try Again" })).toBeVisible();
      expect(await boxes(), "no row moves or changes height").toEqual(before);
      expect(await page.evaluate(() => document.querySelector(".main-body")!.scrollTop)).toBe(scroll);
      await capture(page, `row-error-${viewport.width}`);
      await failure.getByRole("button", { name: "Try Again" }).click();
      await expect(failure).toHaveText("Couldn't save this change. Try Again");
      expect(await page.evaluate(() => (window as unknown as { governanceWrites: string[] }).governanceWrites))
        .toEqual(["questions:push:alice", "questions:push:alice"]);
    });

    test("tool policies are read-only: rows open Policy Details and never write", async ({ page }) => {
      await page.goto(`${APPROVALS}&custom`);
      const builtIn = tools(page).getByRole("button", { name: /^Review Agent-Created Sessions/ });
      await expect(builtIn.locator(".policy-meta-item").first()).toHaveText("Built In");
      await expect(builtIn.locator(".policy-meta-item svg")).toHaveCount(1);
      await expect(tools(page).getByRole("switch")).toHaveCount(0);
      const deny = tools(page).getByRole("button", { name: /^Deny Shell Commands in Production/ });
      await expect(deny.locator(".status")).toHaveText("Deny");
      await expect(deny.locator(".policy-meta-item")).toHaveText([
        "Tool: Bash", "Scope: one machine, branch main", "Conditions: cost at least $5.00, not escalated",
      ]);
      const gap = await deny.locator(".policy-meta-item").nth(1).evaluate((element) => getComputedStyle(element).marginInlineStart);
      expect(gap).toBe("12px");
      await expect(tools(page).getByRole("button", { name: /^Ask Before Deploys/ }).locator(".policy-meta-item"))
        .toHaveText(["Tool: deploy", "Scope: every machine", "Timeout: 10 min"]);
      await deny.click();
      const dialog = page.getByRole("dialog", { name: "Policy Details" });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("dt")).toHaveText(["Name", "Effect", "Priority", "State", "Source", "Tool", "Machine",
        "Workspace", "Agent", "Branch", "Conditions", "Policy ID", "Updated"]);
      await expect(dialog.locator(".modal-foot button")).toHaveText(["Done"]);
      await capture(page, `policy-details-${viewport.width}`);
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toBeHidden();
      await expect(deny).toBeFocused();
      for (const row of await tools(page).locator(".ui-row").all()) {
        await row.click();
        await page.getByRole("dialog", { name: "Policy Details" }).getByRole("button", { name: "Done" }).click();
      }
      expect(await page.evaluate(() => (window as unknown as { governanceWrites: string[] }).governanceWrites)).toEqual([]);
    });

    test("a policy link opens Approvals scrolled to that policy", async ({ page }) => {
      await page.goto(`${APPROVALS}&custom&policy=builtin:session-spawn-human-gate`);
      const row = tools(page).getByRole("button", { name: /^Review Agent-Created Sessions/ });
      await expect(row).toBeFocused();
      await expect(row).toBeInViewport({ ratio: 1 });
      await expect(row).toHaveAttribute("data-targeted", "");
      await capture(page, `policy-link-${viewport.width}`);
    });

    test("loading shows skeleton rows per group, and a failed load offers Retry", async ({ page }) => {
      await page.goto(`${APPROVALS}&load=pending`);
      await expect(page.locator(".approvals-skeleton")).toHaveCount(2);
      await expect(page.locator(".approvals-skeleton-row")).toHaveCount(6);
      await expect(page.getByRole("radiogroup", { name: "Answer Questions In" })).toBeVisible();
      await capture(page, `loading-${viewport.width}`);
      await page.goto(`${APPROVALS}&load=fail`);
      const notice = page.locator(".settings-panel > .notice");
      await expect(notice).toContainText("Couldn't Load Approvals");
      await expect(page.locator(".settings-panel > :is(.notice, section)").first()).toHaveClass(/notice/);
      await capture(page, `load-error-${viewport.width}`);
      await notice.getByRole("button", { name: "Retry" }).click();
      await expect(notice).toBeHidden();
      await expect(tools(page).locator(".ui-row")).toHaveCount(5);
    });
  });
}

test.describe("on a coarse pointer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("switches, rows and Try Again are 44px targets", async ({ page }) => {
    await page.goto(`${APPROVALS}&custom&failure`);
    await expect(tools(page).locator(".ui-row")).toHaveCount(5);
    for (const row of await page.locator(".settings-panel .ui-row").all()) {
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await routine(page).getByRole("switch", { name: "Evidence Upload" }).click();
    const retry = routine(page).getByRole("button", { name: "Try Again" });
    const reach = await retry.evaluate((element) => {
      const after = getComputedStyle(element, "::after");
      return after.content !== "none" && after.position === "absolute";
    });
    expect(reach, "Try Again borrows a 44px band on touch").toBe(true);
    const track = routine(page).locator(".ui-switch").first();
    const box = await track.evaluate((element) => {
      const hit = getComputedStyle(element, "::before");
      const rect = element.getBoundingClientRect();
      return { height: rect.height - 2 * Number.parseFloat(hit.top), width: rect.width - 2 * Number.parseFloat(hit.left) };
    });
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  });
});

/**
 * UI evidence (#2158): every state the issue lists, at 1440px and 390px, dark and light. Opt-in;
 * the states themselves are asserted by the tests above.
 */
test.describe("evidence", () => {
  test.skip(!EVIDENCE, "set APPROVALS_EVIDENCE to a directory to capture");
  for (const theme of ["dark", "light"]) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      test(`Approvals in ${theme} at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const suffix = `${theme}-${viewport.width}`;
        await page.goto(`${APPROVALS}&custom&theme=${theme}`);
        await expect(tools(page).locator(".ui-row")).toHaveCount(5);
        await capture(page, `section-${suffix}`);
        await tools(page).locator(".ui-row").last().scrollIntoViewIfNeeded();
        await capture(page, `tool-policies-${suffix}`);
        await page.goto(`${APPROVALS}&custom&failure&theme=${theme}`);
        await routine(page).getByRole("switch", { name: "Push and Open Pull Requests" }).click();
        await expect(routine(page).locator(".ui-row-failure")).toHaveCount(1);
        await capture(page, `row-error-${suffix}`);
        await page.goto(`${APPROVALS}&load=pending&theme=${theme}`);
        await expect(page.locator(".approvals-skeleton-row")).toHaveCount(6);
        await capture(page, `loading-${suffix}`);
        await page.goto(`${APPROVALS}&load=fail&theme=${theme}`);
        await expect(page.locator(".settings-panel > .notice")).toBeVisible();
        await capture(page, `load-error-${suffix}`);
        await page.goto(`${APPROVALS}&custom&theme=${theme}`);
        await tools(page).getByRole("button", { name: /^Deny Shell Commands in Production/ }).click();
        await expect(page.getByRole("dialog", { name: "Policy Details" })).toBeVisible();
        await capture(page, `policy-details-${suffix}`);
        await page.goto(`${APPROVALS}&custom&theme=${theme}`);
        await page.getByRole("button", { name: "How Routine Answers Work" }).click();
        const popover = page.getByRole("dialog", { name: "How Routine Answers Work" });
        await expect(popover).toBeVisible();
        await capture(page, `how-routine-answers-work-${suffix}`);
      });
    }
  }
});

test("policy attribution fits mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/question-policies-e2e.html?theme=dark");
  const governanceRow = page.locator("[data-audit-id=\"hook-audit\"]").first();
  await expect(governanceRow.locator("summary")).toHaveAccessibleName("Blocked Tool Request by Deny Shell Commands");
  // Compact by default: the audit facts stay behind a disclosure that is keyboard operable.
  await expect(governanceRow.getByText("Decided By", { exact: true })).toBeHidden();
  await governanceRow.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(governanceRow.getByText("Decided By", { exact: true })).toBeVisible();
  await expect(governanceRow).not.toContainText("deny-shell");
  const policyAnswer = page.getByRole("list", { name: "Policy Attribution Example" }).locator(".tl-question");
  await expect(policyAnswer.locator(".tl-step-status")).toHaveText("Answered by Policy");
  await expect(policyAnswer.locator(".tl-step-detail")).toHaveText("Answer: Proceed · Policy: Review Sharing and Retries");
  await expect(policyAnswer).not.toContainText("→");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("governance history pages older decisions and keeps the native decision after its tool request", async ({ page }) => {
  await page.goto("/question-policies-e2e.html");
  const timeline = page.getByRole("list", { name: "Native Governance Event" });
  await timeline.getByRole("button", { name: /^Worked.*1 Command/ }).click();
  await expect(timeline.getByText("Run Shell Command", { exact: true })).toBeVisible();
  await expect(timeline.locator('[data-audit-id="hook-audit"]')).toBeVisible();
  const timelineText = await timeline.innerText();
  expect(timelineText.indexOf("Run Shell Command")).toBeLessThan(timelineText.indexOf("Blocked"));

  const history = page.getByRole("list", { name: "Governance History" });
  await expect(history.locator("[data-audit-id]")).toHaveCount(1);
  if (process.env.GOVERNANCE_EVIDENCE) {
    await page.screenshot({ path: process.env.GOVERNANCE_EVIDENCE + "/governance-history-before.png", fullPage: true });
  }
  await page.getByRole("button", { name: "Load Older Decisions" }).click();
  await expect(history.locator("[data-audit-id]")).toHaveCount(2);
  await expect(history.locator("summary").last()).toHaveAccessibleName("Allowed Tool Request by You");
  await expect(page.getByRole("button", { name: "Load Older Decisions" })).toHaveCount(0);
  if (process.env.GOVERNANCE_EVIDENCE) {
    await page.screenshot({ path: process.env.GOVERNANCE_EVIDENCE + "/governance-history-after.png", fullPage: true });
  }
});

/**
 * The title is a decision row's content: who decided gets only the room the whole title leaves and
 * never more than 40% of the line. A short title ("Deploy") reads in full beside a long policy or
 * session name; a title is clipped only once "by …" has given up all of its room.
 */
async function expectTitlesKeepPriority(rows: Locator) {
  const layout = await rows.locator("summary").evaluateAll((summaries) => summaries.map((summary) => {
    const title = summary.querySelector<HTMLElement>(".tl-decision-title")!;
    const by = summary.querySelector<HTMLElement>(".tl-decision-by");
    const line = summary.querySelector<HTMLElement>(".tl-decision-line")!.getBoundingClientRect().width;
    const byWidth = by ? by.getBoundingClientRect().width : 0;
    return { title: title.textContent, titleClipped: title.scrollWidth > title.clientWidth, byWidth, byShare: byWidth / line };
  }));
  for (const row of layout) {
    expect(row.byShare, `"by …" beside "${row.title}" takes at most 40% of the line`).toBeLessThanOrEqual(0.401);
    if (row.titleClipped) expect(row.byWidth, `"${row.title}" is clipped only after "by …" gave way`).toBeLessThan(1);
  }
  for (const short of ["Bash", "Deploy", "Write"]) {
    expect(layout.find((row) => row.title === short)?.titleClipped, `"${short}" reads in full`).toBe(false);
  }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`decision records read as one past-tense line with their facts behind the chevron at ${viewport.width}px (#2204)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/question-policies-e2e.html?set=decisions");
    const timeline = page.getByRole("list", { name: "Decision Records" });
    const rows = timeline.locator("details.tl-decision");
    await expect(rows).toHaveCount(6);
    await expect.poll(() => rows.locator("summary").evaluateAll((summaries) =>
      summaries.map((summary) => summary.getAttribute("aria-label")))).toEqual([
      "Allowed Run the Web Unit Tests",
      "Rejected Delete the Build Cache",
      "Allowed Push the Release Branch by Release Orchestrator",
      "Blocked Bash by No Shell in Production",
      "Timed Out Deploy by Ask Before Deploys",
      "Blocked Write by Wollipog",
    ]);
    await expectTitlesKeepPriority(rows);
    await expect(timeline).not.toContainText("→");
    await expect(timeline).not.toContainText(/approved_for_session|session-release-orchestrator|no-shell-in-production|audit-/);
    for (const summary of await rows.locator("summary").all()) {
      const box = (await summary.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(box.height).toBeLessThan(40);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    const parent = rows.nth(2);
    await parent.locator("summary").click();
    await expect(parent.getByRole("button", { name: "Release Orchestrator" })).toBeVisible();
    await expect(parent.locator("dt")).toHaveText(["Decided By", "Tool", "Path", "Branch", "Command", "Recorded"]);
    await expect(parent.locator(".code-well pre")).toHaveText("git push origin release/v0.31.0");
    await expect(parent.getByRole("button", { name: "Copy Audit ID" })).toBeVisible();
  });
}

test.describe("on a coarse pointer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("decision record summaries are 44px touch targets (#2204)", async ({ page }) => {
    await page.goto("/question-policies-e2e.html?set=decisions");
    const summaries = page.getByRole("list", { name: "Decision Records" }).locator("details.tl-decision > summary");
    await expect(summaries).toHaveCount(6);
    for (const summary of await summaries.all()) {
      expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // Touch type is larger, so this is where a title is most at risk of being squeezed.
    await expectTitlesKeepPriority(page.getByRole("list", { name: "Decision Records" }).locator("details.tl-decision"));
  });
});
