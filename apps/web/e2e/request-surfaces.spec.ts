import { expect, test, type Locator, type Page } from "@playwright/test";

async function assertNoHorizontalOverflow(page: Page, selector: string) {
  const geometry = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

async function assertInside(page: Page, outer: string, inner: Locator) {
  const container = await page.locator(outer).boundingBox();
  const box = await inner.boundingBox();
  expect(container && box).toBeTruthy();
  expect(box!.y).toBeGreaterThanOrEqual(container!.y - 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(container!.y + container!.height + 1);
}

/** The reading column, the dock and the transcript as boxes (#2179): the dock's cap and the
 * transcript's half are measured against the column that holds them both. */
async function dockGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const body = document.querySelector<HTMLElement>(".request-card-body");
    return {
      reading: box(".chat-reading").height,
      slot: box(".chat-reading > .session-notice-slot").height,
      dock: box(".request-dock").height,
      transcript: document.querySelector<HTMLElement>(".detail-scroll")!.clientHeight,
      dockBottom: box(".chat-reading > .session-notice-slot").bottom,
      composerTop: box(".composer").top,
      bodyScrolls: body ? body.scrollHeight > body.clientHeight + 1 : false,
      bodyOverflow: body ? getComputedStyle(body).overflowY : null,
      headVisible: box(".request-card-head").top >= box(".chat-reading").top,
      footBottom: box(".request-card-foot").bottom,
      slotBottom: box(".chat-reading > .session-notice-slot").bottom,
    };
  });
}

const card = (page: Page) => page.locator(".request-dock .request-card");
const footButton = (page: Page, name: string) => card(page).locator(".request-card-foot").getByRole("button", { name, exact: true });
const submissions = (page: Page) => page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions());

/** The session bar's one status control, and its popover row's Open Requests (#2182, #2206). */
const statusControl = (page: Page) => page.locator("header.session-bar .session-status-button");
async function openRequests(page: Page) {
  await statusControl(page).click();
  await page.getByRole("dialog", { name: "Session Status" }).getByRole("button", { name: "Open Requests" }).click();
}
const panelRows = (page: Page) => page.locator(".request-panel-row");

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`a pending permission is allowed on the card above the composer without the side panel at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=permission");
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole("heading", { name: "Run pnpm deploy?" })).toBeVisible();
    const geometry = await dockGeometry(page);
    // Directly above the composer: nothing but the composer's divider between them.
    expect(Math.abs(geometry.composerTop - geometry.dockBottom)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("complementary", { name: "Requests" })).toHaveCount(0);
    // The transcript keeps no Review Request and no "awaiting decision…" for the row.
    await expect(page.locator(".tl-perm")).toContainText("Run pnpm deploy?");
    await expect(page.getByRole("button", { name: "Review Request" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("awaiting decision");
    await expect(page.locator(".tl-request-card, .approval-bar, .approval-review-surface")).toHaveCount(0);
    if (viewport.width <= 760) {
      // One footer row on a phone.
      const tops = await card(page).locator(".request-card-foot > button").evaluateAll((buttons) =>
        buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
    }

    await footButton(page, "Allow").click();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Requests" })).toHaveCount(0);
    await expect.poll(() => submissions(page)).toEqual([{ requestId: "permission-deploy", optionId: "allow" }]);
    await expect(page.getByRole("textbox", { name: "Composer" })).toBeFocused();
  });
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`reading back shrinks the dock to a 44px strip, and the live tail restores the card, at ${viewport.name} (#2195)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=permission&follow=1");
    const reader = page.getByRole("region", { name: "Session Activity" });
    const strip = page.locator(".request-dock .dock-strip");
    const expand = strip.getByRole("button", { name: "Expand Request", exact: true });
    const readBack = async () => {
      await reader.hover();
      await page.mouse.wheel(0, -600);
      await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
      await expect(strip).toBeVisible();
    };
    await expect(card(page)).toBeVisible();
    await expect(reader).toHaveAttribute("data-follow-tail-state", "following");

    await readBack();
    await expect(card(page)).toBeHidden();
    expect((await strip.boundingBox())!.height).toBe(44);
    expect((await page.locator(".request-dock").boundingBox())!.height).toBe(44);
    await expect(strip.locator(".dock-strip-title")).toHaveText("Run pnpm deploy?");
    await expect(strip.locator(".dock-strip-position")).toHaveText("1 of 1");
    if (viewport.width <= 760) {
      // Icon-only, and the title keeps the row: it is never cut to a few characters for the rest.
      await expect(expand.locator(".dock-strip-expand-label")).toBeHidden();
      const title = (await strip.locator(".dock-strip-title").boundingBox())!;
      expect(title.width).toBeGreaterThan((await strip.boundingBox())!.width / 2);
    } else {
      await expect(expand).toHaveText("Expand");
    }
    await assertNoHorizontalOverflow(page, ".request-dock");

    // A and D do nothing while the request cannot be read.
    await reader.focus();
    await page.keyboard.press("a");
    await page.keyboard.press("d");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await submissions(page)).toEqual([]);

    // Back at the live tail, the card returns and focus stays in the reader.
    await page.keyboard.press("End");
    await expect(reader).toHaveAttribute("data-follow-tail-state", "following");
    await expect(card(page).getByRole("heading", { name: "Run pnpm deploy?" })).toBeVisible();
    await expect(reader).toBeFocused();

    // Activating the strip restores the card and moves focus to its heading.
    await readBack();
    await strip.locator(".dock-strip-title").click();
    await expect(card(page).getByRole("heading", { name: "Run pnpm deploy?" })).toBeFocused();
    await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");

    // A request arriving while collapsed takes the strip when it outranks the first, and is announced.
    await reader.focus();
    await page.keyboard.press("End");
    await readBack();
    await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.addRequest("budget"));
    await expect(strip.locator(".dock-strip-title")).toHaveText("Cost budget reached — $5.02 of $5.00. Continue?");
    await expect(strip.locator(".dock-strip-position")).toHaveText("1 of 2");
    await expect(page.locator("[data-request-dock-announcement]"))
      .toHaveText("Approval Required: Cost budget reached — $5.02 of $5.00. Continue?");
    await expand.click();
    await expect(card(page).getByRole("heading")).toBeFocused();
  });
}

test("the footer is Reject, the ⋯ menu, then Allow, and Always Allow is only in the menu with its description", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/request-surfaces-e2e.html?scenario=permission");
  const names = await card(page).locator(".request-card-foot > button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label") ?? button.childNodes[0]?.textContent));
  expect(names).toEqual(["Reject", "More Choices", "Allow"]);
  await expect(card(page).locator(".request-card-foot .btn.primary")).toHaveText(/^Allow/u);
  await expect(card(page).locator(".request-card-foot")).not.toContainText("Always Allow");
  for (const button of await card(page).locator(".request-card-foot > button").all()) {
    expect((await button.boundingBox())!.height).toBe(32);
  }
  await card(page).getByRole("button", { name: "More Choices" }).click();
  const item = page.getByRole("menuitem", { name: "Always Allow in This Session" });
  await expect(item).toBeVisible();
  await expect(item).toContainText("Allows pnpm deploy without asking until the session ends.");
  await item.click();
  await expect.poll(() => submissions(page)).toEqual([{ requestId: "permission-deploy", optionId: "allow-always" }]);
});

test("A and D act on the expanded request, and the keycaps show with a mouse", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/request-surfaces-e2e.html?scenario=permission");
  await expect(footButton(page, "Allow").locator("kbd")).toBeVisible();
  await expect(footButton(page, "Reject").locator("kbd")).toBeVisible();
  await page.getByRole("region", { name: "Session Activity" }).focus();
  await page.keyboard.press("d");
  await expect.poll(() => submissions(page)).toEqual([{ requestId: "permission-deploy", optionId: "deny" }]);

  await page.goto("/request-surfaces-e2e.html?scenario=multiple");
  await page.getByRole("button", { name: /\+2 More Requests/u }).click();
  await page.getByRole("button", { name: /Run pnpm deploy\?/u }).click();
  await expect(card(page).getByRole("heading")).toHaveText("Run pnpm deploy?");
  await page.keyboard.press("a");
  await expect.poll(() => submissions(page)).toEqual([{ requestId: "permission-deploy", optionId: "allow" }]);
});

test.describe("on a coarse pointer", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("typing in the composer caps the dock at 40%, where the keyboard resizes the layout viewport", async ({ page }) => {
    await page.goto("/request-surfaces-e2e.html?scenario=permission&tall=1");
    await expect(card(page)).toBeVisible();
    expect((await dockGeometry(page)).slot).toBeGreaterThan((await dockGeometry(page)).reading * 0.4 + 1);
    await page.getByRole("textbox", { name: "Composer" }).focus();
    const geometry = await dockGeometry(page);
    expect(geometry.slot).toBeLessThanOrEqual(geometry.reading * 0.4 + 1);
  });

  test("the keycaps are absent and the buttons are 44px", async ({ page }) => {
    await page.goto("/request-surfaces-e2e.html?scenario=permission");
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator("kbd").first()).toBeHidden();
    for (const button of await card(page).locator(".request-card-foot > button").all()) {
      expect((await button.boundingBox())!.height).toBe(44);
    }
  });
});

for (const variant of [
  { query: "runner=offline", reason: "Decisions are unavailable until the runner reconnects." },
  { query: "respond=viewer", reason: "Your Viewer role can read this session but not answer its requests." },
]) {
  test(`Allow and Reject are disabled with the reason as visible text (${variant.query})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/request-surfaces-e2e.html?scenario=permission&${variant.query}`);
    await expect(card(page).locator(".request-card-reasons")).toHaveText(variant.reason);
    for (const name of ["Allow", "Reject"]) {
      await expect(footButton(page, name)).toBeDisabled();
      await expect(footButton(page, name)).toHaveAccessibleDescription(variant.reason);
      await expect(footButton(page, name)).not.toHaveAttribute("title", /.+/u);
    }
  });
}

test("a policy ask shows who asked and counts down to its automatic rejection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/request-surfaces-e2e.html?scenario=policy");
  const line = card(page).locator(".request-card-policy");
  await expect(line).toHaveText(/^Asked by Deploy Guard · Rejects automatically in 9:4\d$/u);
  const first = await line.textContent();
  await expect.poll(() => line.textContent(), { timeout: 3_000 }).not.toBe(first);
});

test("request cards use the one warning surface, never the danger colour", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const scenario of ["permission", "budget", "tool-calls", "workflow", "evidence", "policy"]) {
    await page.goto(`/request-surfaces-e2e.html?scenario=${scenario}`);
    const colours = await card(page).evaluate((element) => {
      const probe = (tone: string) => {
        const notice = document.createElement("div");
        notice.className = `notice t-${tone}`;
        element.parentElement!.append(notice);
        const style = getComputedStyle(notice);
        const result = { background: style.backgroundColor, border: style.borderTopColor };
        notice.remove();
        return result;
      };
      const style = getComputedStyle(element);
      return { card: { background: style.backgroundColor, border: style.borderTopColor }, warning: probe("warning"), danger: probe("danger") };
    });
    expect(colours.card, scenario).toEqual(colours.warning);
    expect(colours.card.background, scenario).not.toBe(colours.danger.background);
    expect(colours.card.border, scenario).not.toBe(colours.danger.border);
  }
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, cap: 0.4 },
  { name: "phone", width: 390, height: 844, cap: 0.5 },
  { name: "phone with the keyboard open", width: 390, height: 844, cap: 0.4, keyboard: true },
]) {
  test(`a body taller than the space keeps the dock at its cap and the transcript at least half at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/request-surfaces-e2e.html?scenario=permission&tall=1${viewport.keyboard ? "&keyboard=1" : ""}`);
    await expect(card(page)).toBeVisible();
    const geometry = await dockGeometry(page);
    expect(geometry.slot).toBeLessThanOrEqual(geometry.reading * viewport.cap + 1);
    expect(geometry.dock).toBeLessThanOrEqual(geometry.reading * viewport.cap + 1);
    expect(geometry.transcript).toBeGreaterThanOrEqual(geometry.reading * 0.5 - 1);
    // Only the body scrolls: the head, title and footer stay inside the dock.
    expect(geometry.bodyOverflow).toBe("auto");
    expect(geometry.bodyScrolls).toBe(true);
    expect(geometry.headVisible).toBe(true);
    expect(geometry.footBottom).toBeLessThanOrEqual(geometry.slotBottom + 1);
    await expect(footButton(page, "Allow")).toBeInViewport();
  });
}

test("several requests: the sign-in is expanded, +2 More Requests lists the others, a row expands, a decision brings the next", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/request-surfaces-e2e.html?scenario=multiple");
  await expect(card(page).getByRole("heading")).toHaveText("Sign In to Claude Code");
  const more = page.getByRole("button", { name: /\+2 More Requests/u });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toContainText("Budget, Permission");
  await more.click();
  const rows = page.getByRole("list", { name: "Waiting Requests" }).getByRole("button");
  await expect(rows).toHaveText([/Cost budget reached/u, /Run pnpm deploy\?/u]);
  await rows.nth(1).click();
  await expect(card(page).getByRole("heading")).toHaveText("Run pnpm deploy?");
  await expect(card(page).getByRole("heading")).toBeFocused();
  await footButton(page, "Allow").click();
  await expect.poll(() => submissions(page)).toEqual([{ requestId: "permission-deploy", optionId: "allow" }]);
  await expect(card(page).getByRole("heading")).toHaveText("Sign In to Claude Code");
  await expect(page.getByRole("button", { name: /\+1 More Request/u })).toContainText("Budget");
});

test("the session's notices wait behind the card's +N More and the request comes back from the notice's", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/request-surfaces-e2e.html?scenario=permission&notices=1");
  const trailing = card(page).locator(".request-card-head").getByRole("button", { name: "+2 More" });
  await trailing.click();
  await expect(page.getByRole("menuitem")).toHaveText(["Message Not Sent", "Skills Unavailable"]);
  await page.getByRole("menuitem", { name: "Message Not Sent" }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator(".session-notice-slot .notice.t-danger")).toContainText("Message Not Sent");
  // The chosen notice keeps the dock's capped place and scrolls there, never spilling over the composer.
  const slot = await page.locator(".chat-reading > .session-notice-slot").evaluate((element) => ({
    overflow: getComputedStyle(element).overflowY,
    bottom: element.getBoundingClientRect().bottom,
    composerTop: document.querySelector(".composer")!.getBoundingClientRect().top,
  }));
  expect(slot.overflow).toBe("auto");
  expect(slot.bottom).toBeLessThanOrEqual(slot.composerTop + 1);
  await page.locator(".session-notice-slot").getByRole("button", { name: "+2 More" }).click();
  await page.getByRole("menuitem", { name: "Pending Request" }).click();
  await expect(card(page).getByRole("heading")).toHaveText("Run pnpm deploy?");

  // A control elsewhere (the status control, the working line's Review) asking for the request
  // while a notice holds its place brings the dock back, focused on the request.
  await trailing.click();
  await page.getByRole("menuitem", { name: "Skills Unavailable" }).click();
  await expect(card(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.reveal("permission-deploy"))).toBe(true);
  await expect(card(page).getByRole("heading")).toHaveText("Run pnpm deploy?");
  await expect(card(page).getByRole("heading")).toBeFocused();
});

test("a decision that fails is a danger notice above the footer, and the choice can be retried", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/request-surfaces-e2e.html?scenario=budget");
  await page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.failNextDecision());
  await footButton(page, "Continue").click();
  await expect(card(page).getByRole("alert")).toHaveText("Your decision wasn't sent. The runner did not accept the decision.");
  await footButton(page, "Continue").click();
  await expect(card(page)).toHaveCount(0);
  await expect.poll(() => submissions(page)).toHaveLength(2);
});

test("child evidence actions stay reachable in a short desktop panel", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 480 });
  await page.goto("/request-surfaces-e2e.html?scenario=descendants");
  await openRequests(page);
  await expect(panelRows(page)).toHaveCount(12);
  await panelRows(page).first().click();
  const panelCard = page.locator(".request-panel-detail .request-card");
  await expect(panelCard).toHaveAttribute("data-presentation", "panel");
  await assertInside(page, ".request-panel-detail", panelCard.locator(".request-card-foot"));
  // A link-only item is marked once its link was opened (#2197).
  await panelCard.getByRole("link", { name: "Open Link" }).click();
  await panelCard.locator('.ev-tile input[type="checkbox"]').check();
  await expect(panelCard.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  for (const name of ["Approve", "Deny"]) {
    // One control height with this mouse (#1799); a touch screen makes it 44px.
    expect((await panelCard.getByRole("button", { name, exact: true }).boundingBox())!.height).toBe(32);
  }
  await page.getByRole("link", { name: "Child Session 1" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_REQUEST_SURFACES_E2E__.openedChild()?.sessionId)).toBe("child-1");
});

test("missing campaign continuation result is visible and explicitly acknowledged", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/request-surfaces-e2e.html?scenario=continuation");
  const notice = page.getByRole("status", { name: "Update Result Missing" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("The Orchestrator accepted an update but never reported a result. " +
    "It won't be sent again automatically.");
  // The counts and the provider's error wait behind Show Details (#2157).
  await expect(notice).not.toContainText("Attempt");
  await notice.getByRole("button", { name: "Show Details" }).click();
  await expect(notice.locator(".facts dt")).toHaveText(["Pending Updates", "Attempt", "Error"]);
  await expect(notice.locator(".facts dd")).toHaveText(["3", "2", "Provider accepted the turn but no terminal result was persisted."]);
  await page.getByRole("button", { name: "Acknowledge" }).click();
  await expect(notice).toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([{
      commandId: "campaign_prompt_evidence",
      action: "dismiss",
    }]);
});

test("a worker-owned approval stays out of the dock, and its transcript row has no review button", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/request-surfaces-e2e.html?scenario=worker");
  await expect(page.locator(".tl-perm")).toContainText("Trust Worktree Setup Configuration?");
  await expect(page.locator(".request-dock")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review Request" })).toHaveCount(0);
});

for (const viewport of [
  { name: "mobile portrait", width: 390, height: 844 },
  { name: "mobile landscape", width: 844, height: 390 },
  { name: "desktop", width: 1280, height: 800 },
  { name: "desktop split pane", width: 900, height: 700 },
]) {
  test(`eight-item evidence review stays reachable on the dock at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=evidence");
    const transcript = page.getByRole("region", { name: "Session Activity" });
    await expect(transcript).toBeVisible();
    const geometry = await dockGeometry(page);
    expect(geometry.transcript).toBeGreaterThanOrEqual(geometry.reading * 0.5 - 1);
    await expect(page.getByRole("complementary", { name: "Requests" })).toHaveCount(0);
    await expect(card(page).locator(".ev-progress")).toHaveText("0 of 8 reviewed");
    const approve = card(page).locator(".request-card-foot").getByRole("button", { name: /^Approve/u });
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAccessibleDescription("Review 8 more to approve.");
    await expect(card(page).locator(".request-card-foot").getByRole("button", { name: /^Deny/u })).toBeVisible();
    await expect(page.locator(".ev-tile")).toHaveCount(8);
    await expect(page.locator("body")).not.toContainText("signature=hidden");
    await assertNoHorizontalOverflow(page, ".request-card-body");

    // Each link-only item is marked once its link was opened (#2197).
    const links = page.locator(".ev-tile").getByRole("link", { name: "Open Link" });
    const checks = page.locator('.ev-tile input[type="checkbox"]');
    for (let index = 0; index < 3; index += 1) {
      await links.nth(index).click();
      await checks.nth(index).check();
    }
    await expect(card(page).locator(".ev-progress")).toHaveText("3 of 8 reviewed");
    await expect(approve).toHaveAccessibleDescription("Review 5 more to approve.");
    // The review survives a reload and a rotation.
    await page.setViewportSize(viewport.width <= 844 ? { width: viewport.height, height: viewport.width } : viewport);
    await page.reload();
    await expect(card(page).locator(".ev-progress")).toHaveText("3 of 8 reviewed");
    for (let index = 3; index < 8; index += 1) {
      await links.nth(index).click();
      await checks.nth(index).check();
    }
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(card(page)).toHaveCount(0);
    await expect.poll(() => submissions(page)).toEqual([{
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
    await openRequests(page);
    // Skeleton rows at the rows' height and anatomy (§12.3), announced once.
    const skeleton = page.locator(".request-panel-skeleton");
    await expect(skeleton).toHaveAttribute("role", "status");
    await expect(skeleton.locator(".row.row-2")).toHaveCount(4);
    expect((await skeleton.locator(".row").first().boundingBox())!.height).toBe(56);
    await assertNoHorizontalOverflow(page, "#right-panel");

    await page.goto("/request-surfaces-e2e.html?scenario=polling&pollStatus=unavailable");
    await openRequests(page);
    const notice = page.locator(".request-panel .notice.t-danger");
    await expect(notice).toContainText("Couldn't Load Requests");
    await expect(page.locator(".request-panel button")).toHaveText(["Retry"]);
    await notice.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.retries())).toBe(1);
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
      const foot = card(page).locator(".request-card-foot");
      await expect(foot.getByRole("button", { name: /^Approve/u })).toBeDisabled();
      await expect(foot.getByRole("button", { name: /^Deny/u })).toBeVisible();
      await expect(foot).toBeInViewport({ ratio: 1 });
      await card(page).locator(".request-card-body").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(foot).toBeInViewport({ ratio: 1 });
      await expect(card(page).locator(".request-card-head")).toBeInViewport({ ratio: 1 });
    });
  }
}

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
]) {
  test(`a worktree setup request is answered on the dock with its command, facts and visible trust primary on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=standalone");

    const geometry = await dockGeometry(page);
    expect(geometry.transcript).toBeGreaterThanOrEqual(geometry.reading * 0.5 - 1);
    const requestRow = page.locator(".tl-perm");
    await expect(requestRow).toHaveCount(1);
    await expect(requestRow).toContainText("Trust Worktree Setup Configuration?");
    await expect(requestRow.getByRole("button", { name: "Review Request" })).toHaveCount(0);
    await expect(card(page).locator(".facts")).toContainText("wollipog.worktree_setup");
    await expect(card(page).locator(".facts")).toContainText("fix/responsive-approval");
    await expect(card(page).locator(".code-well")).toContainText("pnpm setup:step-12");
    // With no allow_once, the trust option is the one visible primary, last, and nothing waits in a
    // menu (#2641).
    const foot = card(page).locator(".request-card-foot");
    // D's keycap names the one-time Create Without Setup; the lasting trust takes a click, so no A.
    await expect(foot.getByRole("button")).toHaveText(["Create Without SetupD", "Trust This Configuration"]);
    await expect(foot.locator(".btn.primary")).toHaveCount(1);
    const trust = foot.locator(".btn.primary");
    await expect(trust).toHaveText("Trust This Configuration");
    await expect(trust.locator("kbd")).toHaveCount(0);
    await expect(trust).toBeInViewport({ ratio: 1 });
    // Two long labels do not fit one phone row: they wrap inside the footer rather than run off the
    // card's edge.
    const footBox = (await foot.boundingBox())!;
    for (const button of await foot.getByRole("button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(footBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(footBox.x + footBox.width);
    }
    await expect(card(page).getByRole("button", { name: "More Choices" })).toHaveCount(0);

    await trust.click();
    await expect(card(page)).toHaveCount(0);
    // The resolved request becomes its Decision Record (#2204): the outcome word, never the option id.
    await expect(requestRow).toHaveCount(0);
    const record = page.locator("details.tl-decision");
    await expect(record).toHaveCount(1);
    await expect(record.locator(".tl-decision-outcome")).toHaveText("Allowed");
    await expect(record.locator(".tl-decision-title")).toHaveText("Trust Worktree Setup Configuration?");
    await expect(record).not.toContainText(/\btrust\b|→/);
    await expect.poll(() => submissions(page)).toEqual([{
      requestId: "worktree-setup:one:hash",
      optionId: "trust",
    }]);
  });
}

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
]) {
  test(`child requests are one status, and the Requests panel is a list that opens each on its card, on ${viewport.name} (#2206)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=descendants");
    await expect(page.locator(".descendant-request-region")).toHaveCount(0);
    // One "8 Child Requests" condition, and no other request badge in the bar.
    await expect(statusControl(page)).toHaveAccessibleName("Session Status: 8 Child Requests");
    await expect(page.locator("header.session-bar .status")).toHaveText(["8 Child Requests"]);
    await expect(page.locator("header.session-bar")).not.toContainText(/Orchestrator Action|Needs Your Input/u);
    await openRequests(page);

    await expect(page.locator(".request-panel-group-head")).toHaveText(["Waiting for You8", "Orchestrator Is Handling4"]);
    await expect(panelRows(page)).toHaveCount(12);
    for (const height of await panelRows(page).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))) {
      // Two-line rows (§5.2): 56px under this mouse; a touch screen makes them 64px.
      expect(height).toBe(56);
    }
    await expect(page.locator(".request-panel-list")).not.toContainText(/Pending|Human/u);
    await assertNoHorizontalOverflow(page, ".request-panel-list");

    // Arrow keys move through the rows; a row opens its request in the list's place.
    await panelRows(page).first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(panelRows(page).nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".request-panel-list")).toHaveCount(0);
    await expect(page.locator(".request-panel-position")).toHaveText("Request 2 of 8");
    const questionCard = page.locator(".request-panel-detail .question-card");
    await expect(questionCard).toHaveAttribute("data-presentation", "panel");
    await expect(questionCard.locator(".request-card-foot")).toHaveCSS("position", "sticky");
    await page.getByRole("button", { name: "Next Request" }).click();
    await expect(page.locator(".request-panel-position")).toHaveText("Request 3 of 8");
    await page.getByRole("button", { name: "All Requests" }).click();
    await expect(panelRows(page)).toHaveCount(12);
    await expect(panelRows(page).nth(2)).toBeFocused();

    // A request the Orchestrator handles: the same card, read-only. The list keeps its place across
    // the visit (§6.2).
    const list = page.locator(".request-panel-list");
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const scrolled = await list.evaluate((element) => element.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    await panelRows(page).nth(8).click();
    await expect(page.locator(".request-panel-position")).toHaveText("Request 1 of 4");
    const readOnly = page.locator(".request-panel-detail .request-card[data-read-only]");
    await expect(readOnly).toHaveAttribute("data-presentation", "panel");
    await expect(readOnly.locator(".notice")).toHaveText("The Orchestrator is handling this request.");
    await expect(readOnly.getByRole("button")).toHaveCount(0);
    await page.getByRole("link", { name: "Child Session 3" }).click();
    await expect.poll(() => page.evaluate(() =>
      window.__WOLLIPOG_REQUEST_SURFACES_E2E__.openedChild()?.sessionId)).toBe("child-3");

    await page.getByRole("button", { name: "All Requests" }).click();
    await expect(panelRows(page).nth(8)).toBeFocused();
    expect(await list.evaluate((element) => element.scrollTop)).toBe(scrolled);
    const close = page.getByRole("button", { name: "Close Panel" });
    await expect(close).toHaveText("");
    await expect(close.locator("svg")).toHaveCount(1);
    await close.click();
    await expect(statusControl(page)).toBeFocused();
    await openRequests(page);
    await expect(panelRows(page)).toHaveCount(12);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: "Requests" })).toHaveCount(0);
  });
}

test.describe("on a phone's touch screen", () => {
  test.use({ hasTouch: true });
  test("at 390px tapping a row opens its request as the panel's own full-screen view, with a back control (#2206)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/request-surfaces-e2e.html?scenario=descendants");
    await openRequests(page);
    const panel = page.locator("#right-panel");
    const box = (await panel.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBe(390);
    await panelRows(page).nth(1).tap();
    await expect(page.locator(".request-panel-list")).toHaveCount(0);
    await expect(page.locator(".request-panel-detail .question-card")).toBeVisible();
    // One back control out of a request: All Requests, not also the panel list's.
    await expect(page.getByRole("button", { name: "Back to Panel List" })).toHaveCount(0);
    await page.getByRole("button", { name: "All Requests" }).tap();
    await expect(panelRows(page)).toHaveCount(12);
    await expect(page.locator(".request-panel-row.is-selected, .request-panel-row[aria-current]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Back to Panel List" })).toBeVisible();
  });
});

test("where docking would leave the chat under 480px the Requests panel opens over the transcript from the right, with a scrim that closes it (#2206, #2725)", async ({ page }) => {
  // This fixture has no rail: at 800px a 320px panel (40% of the window) and its handle leave 470px.
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto("/request-surfaces-e2e.html?scenario=descendants");
  const chatBefore = (await page.locator(".detail-chat").boundingBox())!;
  await openRequests(page);
  const panel = (await page.locator("#right-panel").boundingBox())!;
  const chat = (await page.locator(".detail-chat").boundingBox())!;
  expect(chat.width).toBe(chatBefore.width);
  expect(panel.x + panel.width).toBeCloseTo(chat.x + chat.width, 0);
  expect(panel.x).toBeLessThan(chat.x + chat.width - 200);
  const scrim = page.locator(".rp-scrim");
  await expect(scrim).toBeVisible();
  await page.mouse.click(chat.x + 40, chat.y + 200);
  await expect(page.getByRole("complementary", { name: "Requests" })).toHaveCount(0);
  // Wider, the panel docks beside the transcript and there is no scrim.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRequests(page);
  await expect(scrim).toBeHidden();
  const docked = (await page.locator("#right-panel").boundingBox())!;
  const narrowed = (await page.locator(".detail-chat").boundingBox())!;
  expect(narrowed.x + narrowed.width).toBeLessThanOrEqual(docked.x);
});

test("with nothing pending the launcher's Requests row opens Nothing Waiting, which links to Decision History (#2206)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/request-surfaces-e2e.html?scenario=empty&panel=launcher");
  // No child-request condition when nothing waits for the person.
  await expect(page.locator("header.session-bar .status")).not.toContainText(/Child Request/u);
  const row = page.locator(".rp-launcher .rp-row", { hasText: /^Requests$/u });
  await expect(row).toBeEnabled();
  await expect(row).not.toHaveAttribute("title", /.+/u);
  await row.click();
  const state = page.locator(".request-panel .state");
  await expect(state.locator(".state-title")).toHaveText("Nothing Waiting");
  await expect(state).toContainText("Requests from this session and its child sessions appear here.");
  await state.getByRole("button", { name: "Decision History" }).click();
  await expect(page.locator(".rp-title")).toHaveText("Decision History");
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile portrait", width: 390, height: 844 },
]) {
  test(`campaign held children are listed apart from requests and leave when the hold clears at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=held");
    const held = page.getByRole("region", { name: "Held Children" });
    await expect(held).toBeVisible();
    const entries = held.locator(".held-children > li");
    await expect(entries).toHaveCount(2);
    await expect(held).toContainText("1 other blocked child is not listed here, such as failed or stopped children.");

    const recovery = entries.nth(0);
    const link = recovery.getByRole("link", { name: "Fix #1650: Keep a Decision Resume Across Worktree Recovery" });
    await expect(link).toBeVisible();
    await expect(recovery).toContainText("Worktree Recovery");
    await expect(recovery).toContainText("is on branch main, not fix/issue-1650-decision-resume.");
    await expect(recovery.locator("dd code").first())
      .toHaveText("git -C /home/dev/worktrees/issue-1650 switch fix/issue-1650-decision-resume");
    await expect(recovery).toContainText("select or create another worktree for this session with select_worktree or create_worktree.");
    await expect(recovery.locator("dt")).toHaveText(["Hold", "Reason", "Recovery Action", "Held Decision Resumes"]);
    await expect(recovery).toContainText("wd_occ_merge_1752");
    await expect(entries.nth(1)).toContainText("Handoff Barrier");
    await expect(entries.nth(1).locator("dt")).toHaveText(["Hold", "Reason", "Recovery Action"]);

    // A hold asks nothing: no control beyond the child link, and no row in the request inbox.
    await expect(held.getByRole("button")).toHaveCount(0);
    await expect(held.getByRole("textbox")).toHaveCount(0);
    await assertNoHorizontalOverflow(page, ".campaign-notices");
    await openRequests(page);
    await expect(panelRows(page)).toHaveCount(12);
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

  test(`Held Children is a neutral notice whose list scrolls within its cap by keyboard at ${viewport.name} (#2157)`, async ({ page }) => {
    // Tall enough that the cap, not the half-column budget, sets the list's height.
    await page.setViewportSize({ width: viewport.width, height: 1100 });
    await page.goto("/request-surfaces-e2e.html?scenario=held");
    const held = page.getByRole("region", { name: "Held Children" });
    await expect(held).toHaveClass(/\bt-neutral\b/u);
    await expect(held.locator(".notice-title")).toHaveText("Held Children 2");
    const list = held.locator("ul.held-children");
    const cap = viewport.width <= 760 ? 220 : 280;
    expect(Math.round((await list.boundingBox())!.height)).toBe(cap);
    // On phones each hold stacks its label over its value.
    const term = held.locator("dl.facts dt").first();
    const value = held.locator("dl.facts dd").first();
    const [termBox, valueBox] = [(await term.boundingBox())!, (await value.boundingBox())!];
    if (viewport.width <= 760) expect(valueBox.y).toBeGreaterThan(termBox.y + termBox.height - 1);
    else expect(valueBox.x).toBeGreaterThan(termBox.x + termBox.width);

    const overflows = await list.evaluate((element) => element.scrollHeight > element.clientHeight);
    expect(overflows).toBe(true);
    await list.focus();
    await expect(list).toBeFocused();
    await page.keyboard.press("PageDown");
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });

  test(`both campaign notices head the chat column on its edges, Campaign Continuation first, at ${viewport.name} (#2157)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=both");
    const continuation = page.getByRole("status", { name: "Couldn't Resume the Orchestrator" });
    const held = page.getByRole("region", { name: "Held Children" });
    await expect(continuation).toBeVisible();
    await expect(continuation).toHaveClass(/\bt-danger\b/u);
    await expect(held).toBeVisible();
    const bar = (await page.locator(".session-bar").boundingBox())!;
    const first = (await continuation.boundingBox())!;
    const second = (await held.boundingBox())!;
    const composer = (await page.locator(".composer-box").boundingBox())!;
    expect(first.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    expect(second.y).toBeGreaterThan(first.y + first.height - 1);
    for (const box of [first, second]) {
      expect(Math.abs(box.x - composer.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.x + box.width - (composer.x + composer.width))).toBeLessThanOrEqual(1);
    }
    await expect(continuation.getByRole("button", { name: "Retry Now" })).toBeVisible();
    await assertNoHorizontalOverflow(page, ".campaign-notices");
  });

  test(`in a short window the campaign notices leave the transcript and composer at least half, at ${viewport.name} (#2157)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 480 });
    await page.goto("/request-surfaces-e2e.html?scenario=both");
    const band = page.locator(".campaign-notices");
    await expect(page.getByRole("region", { name: "Held Children" })).toBeVisible();
    const chat = (await page.locator(".detail-chat").boundingBox())!;
    const bandBox = (await band.boundingBox())!;
    expect(bandBox.height).toBeLessThanOrEqual(chat.height / 2 + 1);
    expect((await page.locator(".held-children").boundingBox())!.height).toBeLessThanOrEqual(480 * 0.4 + 1);
    expect((await page.getByRole("region", { name: "Session Activity" }).boundingBox())!.height).toBeGreaterThan(100);
    const composer = (await page.locator(".composer-box").boundingBox())!;
    expect(composer.y + composer.height).toBeLessThanOrEqual(480);
    // Held Children keeps a usable view (10rem, 12rem on phones) and the band scrolls past it; what
    // either cannot show scrolls into view from the keyboard.
    const held = page.getByRole("region", { name: "Held Children" });
    expect((await held.boundingBox())!.height).toBeGreaterThanOrEqual(viewport.width <= 760 ? 191 : 159);
    expect(await held.evaluate((element) => element.scrollHeight <= element.clientHeight + 1 ||
      getComputedStyle(element).overflowY === "auto")).toBe(true);
    await page.getByRole("link", { name: "Fix #1651: Queue Prompts Behind a Handoff Barrier" }).focus();
    await expect(page.getByRole("link", { name: "Fix #1651: Queue Prompts Behind a Handoff Barrier" })).toBeInViewport();
  });

  test(`a long continuation error behind Show Details leaves Held Children a usable view, at ${viewport.name} (#2157)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 600 });
    await page.goto("/request-surfaces-e2e.html?scenario=both");
    await page.getByRole("status", { name: "Couldn't Resume the Orchestrator" })
      .getByRole("button", { name: "Show Details" }).click();
    const held = page.getByRole("region", { name: "Held Children" });
    // Held Children keeps 10rem (12rem on phones) and the band scrolls instead of crushing it.
    expect((await held.boundingBox())!.height).toBeGreaterThanOrEqual(viewport.width <= 760 ? 191 : 159);
    expect(await page.locator(".campaign-notices").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const link = held.getByRole("link", { name: "Fix #1650: Keep a Decision Resume Across Worktree Recovery" });
    await link.focus();
    await expect(link).toBeInViewport();
    const composer = (await page.locator(".composer-box").boundingBox())!;
    expect(composer.y + composer.height).toBeLessThanOrEqual(600);
  });

  test(`with both campaign notices in a common window, Held Children's list gives up height and nothing is cut, at ${viewport.name} (#2157)`, async ({ page }) => {
    await page.setViewportSize(viewport.width <= 760 ? viewport : { width: 1440, height: 900 });
    await page.goto("/request-surfaces-e2e.html?scenario=both");
    const band = page.locator(".campaign-notices");
    const held = page.getByRole("region", { name: "Held Children" });
    await expect(held).toBeVisible();
    expect(await band.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    expect(await held.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    const listHeight = (await held.locator("ul.held-children").boundingBox())!.height;
    expect(listHeight).toBeGreaterThanOrEqual(96);
    expect(listHeight).toBeLessThan(viewport.width <= 760 ? 220 : 280);
    const chat = (await page.locator(".detail-chat").boundingBox())!;
    expect((await band.boundingBox())!.height).toBeLessThanOrEqual(chat.height / 2 + 1);
  });

  test(`a Viewer's worktree-recovery advice names who can recover it, not the worktree tools, at ${viewport.name} (#1867)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=held&reader=viewer");
    const recovery = page.getByRole("region", { name: "Held Children" }).locator(".held-children > li").nth(0);
    await expect(recovery.getByRole("link", { name: "Fix #1650: Keep a Decision Resume Across Worktree Recovery" }))
      .toBeVisible();
    await expect(recovery).toContainText(
      "Only the session owner or its controlling Orchestrator can recover this session's worktree: ask them to restore " +
      "branch fix/issue-1650-decision-resume in /home/dev/worktrees/issue-1650");
    await expect(recovery.locator("dd code").first())
      .toHaveText("git -C /home/dev/worktrees/issue-1650 switch fix/issue-1650-decision-resume");
    await expect(recovery).not.toContainText("select_worktree");
    await expect(recovery).not.toContainText("create_worktree");
    await assertNoHorizontalOverflow(page, ".campaign-notices");
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
    const entry = held.locator(".held-children > li");
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
    await assertNoHorizontalOverflow(page, ".campaign-notices");
  });

  test(`a held child whose runner keeps the queue across a restart says what a restart keeps, at ${viewport.name} (#1779)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/request-surfaces-e2e.html?scenario=held&bounded=legacy&restart=keeps");
    const entry = page.getByRole("region", { name: "Held Children" }).locator(".held-children > li");
    await expect(entry).toHaveCount(1);
    await expect(entry.locator("dt")).toHaveText(["Hold", "Reason", "Recovery Action", "Held Decision Resumes"]);
    await expect(entry).toContainText(
      "restart the session with restart_session, knowing what that costs: the provider and its background job end, " +
      "with unfinished work recorded as killed and unrecoverable and a finished result still owed reported to the new " +
      "conversation; the queued messages are kept and run after the restart; and any approved workflow " +
      "decision the session has not yet consumed is revoked, and the " +
      "restarted session is told which ones to request again.");
    await expect(entry).not.toContainText("discarded");
    await assertNoHorizontalOverflow(page, ".campaign-notices");

    await page.goto("/request-surfaces-e2e.html?scenario=held&bounded=1&restart=keeps");
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("Prefer waiting to restarting the session: a restart keeps the queued messages but " +
      "ends every background job and starts a new conversation.");
    await expect(entry).not.toContainText("discards");
    await assertNoHorizontalOverflow(page, ".campaign-notices");
  });

  // The harness renders each held child's advice as the projection carries it, as Held Children does
  // for a child the dashboard has not loaded (#1875).
  test(`a queue-held child's advice names only what the person reading it may do, at ${viewport.name} (#1875)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const entry = page.getByRole("region", { name: "Held Children" }).locator(".held-children > li");
    const recovery = entry.locator("dd").nth(2);

    await page.goto("/request-surfaces-e2e.html?scenario=held&bounded=legacy&stoppable=1");
    await expect(entry).toHaveCount(1);
    await expect(recovery).toContainText("stop it by its job id with stop_background_job");
    await expect(recovery).toContainText("or with Stop Job in the Background Work panel");
    await expect(recovery).toContainText("Do not restart the session to get past this hold");

    await page.goto("/request-surfaces-e2e.html?scenario=held&bounded=legacy&stoppable=1&reader=viewer");
    await expect(entry).toHaveCount(1);
    await expect(recovery).toContainText(
      "Only the session owner or its controlling Orchestrator can end it sooner; ask them if it must end now.");
    await expect(recovery).not.toContainText("stop_background_job");
    await expect(recovery).not.toContainText("Stop Job");
    await expect(recovery).not.toContainText("restart");
    await assertNoHorizontalOverflow(page, ".campaign-notices");

    await page.goto("/request-surfaces-e2e.html?scenario=held&bounded=legacy&stoppable=1&reader=admin");
    await expect(entry).toHaveCount(1);
    await expect(recovery).toContainText(
      "Only the session owner or its controlling Orchestrator can end it sooner; ask them if it must end now.");
    await expect(recovery).toContainText("Do not restart the session to get past this hold: a restart discards the queued messages.");
    await expect(recovery).not.toContainText("stop_background_job");
    await expect(recovery).not.toContainText("Stop Job");

    await page.goto("/request-surfaces-e2e.html?scenario=held&bounded=legacy&reader=viewer");
    await expect(entry).toHaveCount(1);
    await expect(recovery).toContainText(
      "the hold clears only when someone who can act on this session steps in; ask its owner.");
    await expect(recovery).not.toContainText("restart_session");
    await assertNoHorizontalOverflow(page, ".campaign-notices");
  });
}
