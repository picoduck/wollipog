import { expect, test, type Page, type Locator } from "@playwright/test";

async function wheelToCard(page: Page, card: Locator) {
  const geometry = () => card.evaluate((element) => {
    let scroller = element.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    const area = scroller!.getBoundingClientRect();
    const x = element.getBoundingClientRect().left + 2;
    const covers = (candidate: Element | null) => {
      for (let at = candidate; at && at !== scroller; at = at.parentElement) if (/sticky|fixed/.test(getComputedStyle(at).position)) return true;
      return !candidate || !scroller!.contains(candidate);
    };
    let visibleTop = Math.max(area.top, 0);
    while (visibleTop < area.bottom && covers(document.elementFromPoint(x, visibleTop))) visibleTop++;
    return { gap: element.getBoundingClientRect().top - visibleTop - 12,
      x: area.left + area.width / 2, y: Math.min(area.bottom - 20, innerHeight - 100) };
  });
  for (let step = 0; step < 8; step++) {
    const { gap, x, y } = await geometry();
    if (Math.abs(gap) < 3) break;
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, gap);
    await page.waitForTimeout(100);
  }
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await expect.poll(() => page.locator("aside.rpanel").evaluate((el) => el.scrollTop)).toBe(0);
}

for (const [device, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`a typed model ask waits for owner classification (${device})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&screen=ask");
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    if (device === "phone") await expect(page.getByRole("navigation", { name: "Primary Navigation" })).toBeInViewport();
    const waiting = page.locator(".campaign-status section", { has: page.getByRole("heading", { name: "Waiting for You" }) });
    await expect(waiting).toContainText("#4542 Migrate Provider Account Configuration");
    await expect(waiting).toContainText("Held for the owner's classification by the model credential screen.");
    await wheelToCard(page, waiting);
    await page.screenshot({ path: testInfo.outputPath(`typed-ask-work-item-${device}.png`) });
    const section = page.getByRole("region", { name: "Decision Model Checks" });
    await expect(section).toContainText("Waiting for you to classify it.");
    await expect(section).toContainText("The configuration migration design could involve provider sign-in");
    await expect(section).toContainText("The model screen returned “ask”; no deterministic credential rule matched.");
    await expect(section.locator("button:not([aria-expanded])")).toHaveText(["Decline", "Let the Orchestrator Answer", "Open Session"]);
    await wheelToCard(page, section);
    await page.screenshot({ path: testInfo.outputPath(`typed-ask-${device}.png`) });
    await section.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(section).toContainText("You declined it.");
    await expect(section.locator("button:not([aria-expanded])")).toHaveText(["Open Session"]);
    await section.getByRole("button", { name: "Open Session", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.openedSession())).toBe("s_child");
  });
}

/** Campaign Status's Decision Model Checks (#4104): each Decision Model verdict beside the request it
 * affected, and the owner's classification of one the model could not screen. */

for (const [label, viewport] of [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]] as const) {
  test(`the owner classifies a question the Decision Model could not screen (${label}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&screen=1&owner=1");
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    const section = page.getByRole("region", { name: "Decision Model Checks" });
    await expect(section).toBeVisible();
    const items = section.locator("li");
    await expect(items).toHaveCount(4);
    // Each screened request is its own group, ruled off from the next.
    for (let index = 0; index < 4; index += 1) {
      await expect(items.nth(index)).toHaveCSS("border-top-style", "solid");
    }
    await expect(items.nth(0)).toContainText("Only Discusses");
    await expect(items.nth(0)).toContainText("The Orchestrator decides it.");
    // #4367: a check names its target and the exact model that answered.
    const fact = (index: number, term: string) => items.nth(index).locator("dl.facts > div")
      .filter({ has: page.getByRole("term").getByText(term, { exact: true }) }).locator("dd");
    await expect(fact(0, "Target Model")).toContainText("Haiku, Low effort");
    await expect(fact(0, "Answered By")).toHaveText("claude-haiku-5-5");
    await expect(fact(2, "Target Model")).toContainText("Haiku, Low effort");
    await expect(fact(2, "Answered By")).toHaveCount(0);
    await expect(items.nth(1)).toContainText("Asks for Access");
    await expect(items.nth(1)).toContainText("Declined and recorded as blocked work.");
    await expect(items.nth(2)).toContainText("Timed Out");
    await expect(items.nth(2).getByRole("button")).toHaveText(["Decline", "Let the Orchestrator Answer", "Open Session"]);
    await expect(items.nth(3)).toContainText("Owner Decision");
    await expect(items.nth(3).getByRole("button")).toHaveText(["Decline", "Let Me Answer", "Open Session"]);
    // Every group's first button starts on the same edge as the facts above it.
    for (const index of [0, 2]) {
      const factsLeft = await items.nth(index).locator("dl").evaluate((element) => element.getBoundingClientRect().left);
      const buttonLeft = await items.nth(index).getByRole("button").first().evaluate((element) => element.getBoundingClientRect().left);
      expect(Math.abs(buttonLeft - factsLeft)).toBeLessThanOrEqual(1);
    }
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`question-screen-${label}-before.png`) });
    await items.nth(2).getByRole("button", { name: "Let the Orchestrator Answer" }).click();
    await expect(items.nth(2)).toContainText("You let the Orchestrator answer it.");
    await expect(items.nth(2).getByRole("button")).toHaveText(["Open Session"]);
    expect(await page.evaluate(() => (window as unknown as { __CLASSIFIED__: unknown }).__CLASSIFIED__))
      .toEqual({ occurrenceId: "dec_sessions", classification: "orchestrator" });
    await page.screenshot({ path: testInfo.outputPath(`question-screen-${label}-after.png`) });
    const geometry = await section.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });
}

for (const [label, viewport] of [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]] as const) {
  test(`follow-up relatedness and closure-reason checks read beside their request (${label}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&checks=1");
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    const section = page.getByRole("region", { name: "Decision Model Checks" });
    const items = section.locator("li");
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toContainText("Follow-Up Publication");
    await expect(items.nth(0)).toContainText("Related");
    await expect(items.nth(0)).toContainText("The Orchestrator may publish it.");
    await expect(items.nth(1)).toContainText("Unrelated");
    await expect(items.nth(1)).toContainText("Refused back to the Orchestrator.");
    await expect(items.nth(2)).toContainText("Issue Closure");
    await expect(items.nth(2)).toContainText("Reason Doesn't Fit");
    await expect(items.nth(3)).toContainText("Waiting for you to decide the closure.");
    await expect(items.nth(3)).toContainText("Timed Out");
    // These checks are decided on their own request: nothing here classifies them.
    for (let index = 0; index < 4; index += 1) await expect(items.nth(index).getByRole("button")).toHaveText(["Open Session"]);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`decision-checks-${label}.png`) });
    const geometry = await section.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });
}

// Tall enough that the panel shows every proposal whole, at the two widths.
for (const [label, viewport] of [["1440", { width: 1440, height: 1500 }], ["390", { width: 390, height: 1800 }]] as const) {
  test(`each selection proposal reads with its outcome, issues, rationale and reason (${label}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&selection=1");
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    const section = page.getByRole("region", { name: "Decision Model Checks" });
    const items = section.locator("li");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("Selection Proposal");
    await expect(items.nth(0)).toContainText("Admitted and added to the scope.");
    await expect(items.nth(0)).toContainText("#130 Crash when a session restarts during a merge");
    await expect(items.nth(0)).toContainText("The two oldest open issues labeled priority/high.");
    await expect(items.nth(0)).toContainText("Fits Your Selection");
    await expect(items.nth(1)).toContainText("Refused back to the Orchestrator.");
    await expect(items.nth(1)).toContainText("Doesn't Fit Your Selection");
    await expect(items.nth(1)).toContainText("Issue 140 is a wording change");
    await expect(items.nth(2)).toContainText("Waiting for your approval of the scope change.");
    await expect(items.nth(2)).toContainText("Uncertain");
    await expect(items.nth(2)).toContainText("didn't say whether UI regressions count");
    // Each item opens the Orchestrator's session; the pending one also opens the owner's scope
    // approval card. Nothing here classifies a selection.
    await expect(items.nth(0).getByRole("button")).toHaveText(["Open Session"]);
    await expect(items.nth(1).getByRole("button")).toHaveText(["Open Session"]);
    await expect(items.nth(2).getByRole("button")).toHaveText(["Open Request", "Open Session"]);
    await section.scrollIntoViewIfNeeded();
    // The whole Campaign Status panel in the page, not a crop of the section.
    await page.screenshot({ path: testInfo.outputPath(`selection-proposals-${label}.png`) });
    const geometry = await section.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });
}

// Typed questions (#4283): each check's answers read as a short checklist beside the verdict the
// server derived from them.
for (const [label, viewport] of [["1440", { width: 1440, height: 1900 }], ["390", { width: 390, height: 2600 }]] as const) {
  test(`a typed check's answers read as a checklist beside its verdict (${label}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&selection=1&typed=1");
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    const section = page.getByRole("region", { name: "Decision Model Checks" });
    const items = section.locator(".campaign-screen-item");
    await expect(items).toHaveCount(3);
    const answers = (index: number) => items.nth(index).getByRole("list", { name: "Answers" }).getByRole("listitem");
    await expect(answers(0)).toHaveCount(5);
    await expect(items.nth(1)).toContainText("Issue 140 violates 'Skip Security'.");
    await expect(answers(1)).toHaveText([
      /^Satisfies 'Count Matches'Yes \(96% confidence\)\./u,
      /^Issue 140 Satisfies 'UI Only'/u,
      /^Issue 140 Violates 'Skip Security'Violates \(92% confidence\); this answer decided the verdict\. It is labeled security\.$/u,
    ]);
    await expect(answers(2).nth(1)).toContainText("Issue 141 Unsure About 'UI Only'");
    await expect(answers(2).nth(1)).toContainText("(55% confidence); this answer decided the verdict");
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`typed-answers-${label}.png`) });
    const geometry = await section.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });
}

// The migrated kinds (#4283, slice 2): the credential screen, follow-up relatedness and closure-reason
// checks read their typed answers as the same checklist. "Before" is the single-verdict record,
// which keeps its form; "after" is the typed one.
for (const [label, viewport] of [["1440", { width: 1440, height: 1500 }], ["390", { width: 390, height: 2400 }]] as const) {
  test(`the migrated checks' typed answers read as a checklist beside their verdict (${label}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const section = page.getByRole("region", { name: "Decision Model Checks" });
    const items = section.locator(".campaign-screen-item");
    const answers = (index: number) => items.nth(index).getByRole("list", { name: "Answers" }).getByRole("listitem");
    for (const [scenario, count] of [["screen=1&owner=1", 4], ["checks=1", 4]] as const) {
      const name = scenario.startsWith("screen") ? "credential-screen" : "follow-up-closure";
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&${scenario}`);
      await page.getByRole("button", { name: "Expand All", exact: true }).click();
      await expect(items).toHaveCount(count);
      await expect(section.getByRole("list", { name: "Answers" })).toHaveCount(0);
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`typed-${name}-${label}-before.png`) });
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&${scenario}&typed=1`);
      await page.getByRole("button", { name: "Expand All", exact: true }).click();
      await expect(items).toHaveCount(count);
      if (name === "credential-screen") {
        await expect(answers(0)).toHaveText([
          /^Satisfies 'No Credential Handed Over'No \(97% confidence\)\./u,
          /^Satisfies 'No Sign-In Performed'/u,
          /^Satisfies 'No Access Granted'/u,
        ]);
        await expect(items.nth(1)).toContainText("Asks for Access");
        await expect(answers(1).nth(0)).toHaveText(
          /^Violates 'No Credential Handed Over'Yes \(98% confidence\); this answer decided the verdict\. "Paste a GitHub token here\."$/u);
        // A failed screen has no answers and is classified as before.
        await expect(items.nth(2).getByRole("list", { name: "Answers" })).toHaveCount(0);
        await expect(items.nth(2).getByRole("button")).toHaveText(["Decline", "Let the Orchestrator Answer", "Open Session"]);
        await expect(answers(3).nth(1)).toContainText("Unsure About 'No Sign-In Performed'");
        await expect(answers(3).nth(1)).toContainText("Yes (60% confidence); this answer decided the verdict");
        await expect(items.nth(3).getByRole("button")).toHaveText(["Decline", "Let Me Answer", "Open Session"]);
      } else {
        await expect(answers(0)).toHaveText([/^Satisfies 'Related to the Requested Work'A gap found in the requested work \(91% confidence\)\./u]);
        await expect(items.nth(1)).toContainText("The answer violates 'Related to the Requested Work'.");
        await expect(answers(1)).toHaveText([/^Violates 'Related to the Requested Work'Separate work \(93% confidence\); this answer decided the verdict\./u]);
        await expect(items.nth(2)).toContainText("Reason Doesn't Fit");
        await expect(answers(2)).toHaveText([
          /^Violates 'Evidence Supports the Reason'Doesn't support \(88% confidence\); this answer decided the verdict\./u,
          /^Satisfies 'Explanation Matches the Evidence'/u,
        ]);
        await expect(items.nth(3).getByRole("list", { name: "Answers" })).toHaveCount(0);
      }
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`typed-${name}-${label}-after.png`) });
      const geometry = await section.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    }
  });
}

for (const [label, viewport] of [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]] as const) {
  test(`a Custom campaign's epic seed reads beside the other checks (${label}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/campaign-status-e2e.html?scenario=campaign&checks=1&seed=1");
    await page.getByRole("button", { name: "Expand All", exact: true }).click();
    const section = page.getByRole("region", { name: "Decision Model Checks" });
    const items = section.locator("li");
    await expect(items).toHaveCount(6);
    await expect(items.nth(4)).toContainText("Epic Seed");
    await expect(items.nth(4)).toContainText("Message Read");
    await expect(items.nth(4)).toContainText("It seeded the epic's issues; approve the issue scope before work is delegated.");
    await expect(items.nth(4).getByRole("button")).toHaveText(["Open Session"]);
    await expect(items.nth(5)).toContainText("Waiting for you: approve the campaign's issue scope, or continue without an epic.");
    await expect(items.nth(5)).toContainText("Provider Overloaded");
    await expect(items.nth(5).getByRole("button")).toHaveText(["Continue Without an Epic", "Open Session"]);
    await items.nth(4).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`epic-seed-${label}-before.png`) });
    await items.nth(5).getByRole("button", { name: "Continue Without an Epic" }).click();
    await expect(items.nth(5)).toContainText("You let the Orchestrator delegate without an epic.");
    await expect(items.nth(5).getByRole("button")).toHaveText(["Open Session"]);
    expect(await page.evaluate(() => (window as unknown as { __CLASSIFIED__: unknown }).__CLASSIFIED__))
      .toEqual({ occurrenceId: "seed_failed", classification: "orchestrator" });
    await page.screenshot({ path: testInfo.outputPath(`epic-seed-${label}-after.png`) });
    const geometry = await section.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });
}

test("Campaign Status lists each check once: the Decision Model section keeps only calls without a section of their own (#4265)", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=campaign&checks=1&seed=1&decisions=1");
  await page.getByRole("button", { name: "Expand All", exact: true }).click();
  await expect(page.getByRole("region", { name: "Decision Model Checks" }).locator("li")).toHaveCount(6);
  const decisions = page.locator("section.campaign-status-handoffs").filter({ has: page.getByRole("heading", { name: "Decisions", exact: true }) });
  // Only the three calls the fixture adds for this section; no follow-up, closure or epic-seed check a second time.
  await expect(decisions.locator(".campaign-decision-item")).toHaveCount(3);
  await expect(decisions).not.toContainText("It removes a temp file the crash fix exposed.");
  await expect(decisions).not.toContainText("The person names epic #123");
});

test("Campaign Status shows no Decision Model Checks before the Decision Model screens anything", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=campaign");
  await page.getByRole("button", { name: "Expand All", exact: true }).click();
  await expect(page.locator(".campaign-status-summary")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Decision Model Checks" })).toHaveCount(0);
});
