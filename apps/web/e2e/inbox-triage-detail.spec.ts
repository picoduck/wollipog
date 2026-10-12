import { expect, test, type Page, type Route } from "@playwright/test";
import type { SessionView } from "@wollipog/protocol";
import { encodeResourceId } from "../src/navigation.js";

type DetailRead = { id: string; route: Route; session: SessionView };

async function fixture(page: Page) {
  const reads: DetailRead[] = [];
  // The reader has its own hydration lifecycle. Isolate Inbox keyboard triage from those reads;
  // the real Inbox, Store, shortcuts, permissions and hydration fences remain under test.
  await page.route("**/src/components/SessionDetail.tsx*", (route) => route.fulfill({
    contentType: "application/javascript", body: "export function SessionDetail() { return null; }",
  }));
  await page.route("**/__inbox-triage-detail/*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    const session = await page.evaluate((id) => window.__WOLLIPOG_INBOX_TRIAGE_E2E__.detail(id), id);
    reads.push({ id, route, session });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/command-inbox-projects-e2e.html?sessionSummaries=1&scenario=inbox-triage&history=1");
  await page.getByRole("tab", { name: /^All \d/ }).click();
  const grid = page.locator(".inbox-list");
  await grid.focus();
  await page.keyboard.press("Home");
  await expect(grid).toHaveAttribute("aria-activedescendant", /session/);
  return { reads, grid };
}

async function expectReadCount(page: Page, reads: DetailRead[], count: number) {
  expect(await page.evaluate(() => window.__WOLLIPOG_INBOX_TRIAGE_E2E__.detailRequests().length)).toBe(count);
  await expect.poll(() => reads.length).toBe(count);
}

async function settleRead(page: Page, read: DetailRead, session = read.session) {
  const before = await page.evaluate(() => window.__WOLLIPOG_INBOX_TRIAGE_E2E__.settledDetails());
  await read.route.fulfill({ json: { session } });
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_INBOX_TRIAGE_E2E__.settledDetails())).toBe(before + 1);
}

async function actions(page: Page) {
  return page.evaluate(() => window.__WOLLIPOG_INBOX_TRIAGE_E2E__.actions());
}

async function capture(page: Page, name: string, caption: string) {
  if (!process.env.INBOX_TRIAGE_EVIDENCE_DIR) return;
  // Evidence-only annotation: no counters or instrumentation are added to the product UI.
  await page.evaluate((caption) => {
    let note = document.getElementById("triage-evidence-note");
    if (!note) {
      note = document.createElement("div");
      note.id = "triage-evidence-note";
      note.style.cssText = "position:fixed;bottom:20px;left:20px;z-index:99999;padding:16px;background:#fff;color:#111;border:2px solid #111;font:18px sans-serif";
      document.body.append(note);
    }
    note.textContent = caption;
  }, caption);
  await page.screenshot({ path: `${process.env.INBOX_TRIAGE_EVIDENCE_DIR}/${name}.png` });
}

for (const key of ["a", "d"]) {
  test(`repeated ${key} keys issue one summary detail read and one decision`, async ({ page }, testInfo) => {
    const { reads } = await fixture(page);
    await page.keyboard.press(key);
    await expect.poll(() => reads.length).toBe(1);
    for (let i = 0; i < 4; i++) await page.keyboard.press(key);
    const calls = await page.evaluate(() => window.__WOLLIPOG_INBOX_TRIAGE_E2E__.detailRequests().length);
    // Positive synchronization with every issued call, never a timing-based negative assertion.
    await expect.poll(() => reads.length).toBe(calls);
    if (process.env.INBOX_TRIAGE_EVIDENCE_DIR) {
      await capture(page, `${key}-pending`, `Synthetic Inbox triage: ${key.toUpperCase()} pressed 5 times; ${reads.length} pending detail reads; 0 decisions`);
      await testInfo.attach("Pending Detail Reads", { body: JSON.stringify(reads.map(({ id }) => id)), contentType: "application/json" });
    }
    expect(calls, "one detail invocation while repeated triage keys are pending").toBe(1);
    expect(reads.length, "one HTTP detail read while repeated triage keys are pending").toBe(1);
    await settleRead(page, reads[0]!);
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_INBOX_TRIAGE_E2E__.actions())).toEqual([
      { sessionId: reads[0]!.id, requestId: reads[0]!.session.pendingApproval!.requestId, optionId: key === "a" ? "allow" : "deny" },
    ]);
    await capture(page, `${key}-settled`, `Synthetic Inbox triage: response released; exactly 1 ${key === "a" ? "approval" : "denial"}`);
  });
}

for (const outcome of ["error", "abort"] as const) {
  test(`a ${outcome} releases the detail owner and preserves the error toast and retry`, async ({ page }) => {
    const { reads } = await fixture(page);
    await page.keyboard.press("a");
    await expect.poll(() => reads.length).toBe(1);
    if (outcome === "error") await reads[0]!.route.fulfill({ status: 503, body: "Synthetic failure" });
    else await reads[0]!.route.abort("failed");
    await expect(page.getByText(outcome === "error" ? "Synthetic detail read failed" : "Failed to fetch", { exact: true })).toBeVisible();
    await page.keyboard.press("d");
    await expect.poll(() => reads.length).toBe(2);
    await page.keyboard.press("a");
    await expectReadCount(page, reads, 2);
    await settleRead(page, reads[1]!);
    await expect.poll(() => actions(page)).toEqual([
      { sessionId: reads[1]!.id, requestId: reads[1]!.session.pendingApproval!.requestId, optionId: "deny" },
    ]);
  });
}

test("switching sessions preserves navigation, independent readiness, and a newer read's owner", async ({ page }) => {
  const { reads, grid } = await fixture(page);
  await page.keyboard.press("a");
  await expect.poll(() => reads.length).toBe(1);
  const firstId = reads[0]!.id;
  await page.keyboard.press("j");
  await expect(grid).not.toHaveAttribute("aria-activedescendant", `inbox-session-${encodeResourceId(firstId)}`);
  await page.keyboard.press("d");
  await expect.poll(() => reads.length).toBe(2);
  expect(reads[1]!.id).not.toBe(firstId);
  // Navigation preserves the already-issued A while the other session is selected and ready.
  await settleRead(page, reads[0]!);
  await expect.poll(() => actions(page)).toHaveLength(1);
  expect(await actions(page)).toEqual([
    { sessionId: firstId, requestId: reads[0]!.session.pendingApproval!.requestId, optionId: "allow" },
  ]);
  await expect(grid).toHaveAttribute("aria-activedescendant", `inbox-session-${encodeResourceId(reads[1]!.id)}`);
  await capture(page, "a-then-j-issued-action", "Synthetic Inbox triage: A then J; first response released while another row is selected; exactly 1 original approval");
  await settleRead(page, reads[1]!);
  await expect.poll(() => actions(page)).toHaveLength(2);
  await page.evaluate((id) => {
    const fixture = window.__WOLLIPOG_INBOX_TRIAGE_E2E__;
    fixture.summary(id, { pendingApproval: { ...fixture.detail(id).pendingApproval!, requestId: "return-request", kind: "policy_hook", title: "Review return", options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" },
    ] } });
  }, firstId);
  await page.keyboard.press("k");
  await page.keyboard.press("a");
  await expect.poll(() => reads.length).toBe(3);
  expect(reads[2]!.id).toBe(firstId);
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await page.keyboard.press("d");
  await expectReadCount(page, reads, 4);
  // The old, cancelled response arrives after ownership has transferred to a fresh read.
  await settleRead(page, reads[2]!);
  await page.keyboard.press("a");
  await expectReadCount(page, reads, 4);
  expect(await actions(page)).toHaveLength(2);
  await settleRead(page, reads[3]!);
  await expect.poll(() => actions(page)).toEqual([
    { sessionId: firstId, requestId: reads[0]!.session.pendingApproval!.requestId, optionId: "allow" },
    { sessionId: reads[1]!.id, requestId: reads[1]!.session.pendingApproval!.requestId, optionId: "deny" },
    { sessionId: firstId, requestId: "return-request", optionId: "deny" },
  ]);
});

for (const replacement of ["request", "history"] as const) {
  test(`${replacement} replacement rejects the old response without clearing a newer owner`, async ({ page }) => {
    const { reads } = await fixture(page);
    await page.keyboard.press("a");
    await expect.poll(() => reads.length).toBe(1);
    const id = reads[0]!.id;
    await page.evaluate(({ id, replacement }) => {
      const fixture = window.__WOLLIPOG_INBOX_TRIAGE_E2E__;
      const previous = fixture.detail(id);
      fixture.summary(id, replacement === "history" ? { eventEpoch: (previous.eventEpoch ?? 0) + 1 } : {
        pendingApproval: { ...previous.pendingApproval!, requestId: "replacement-request", occurrenceId: "replacement-occurrence" },
      });
    }, { id, replacement });
    await page.keyboard.press("d");
    await expect.poll(() => reads.length).toBe(2);
    await settleRead(page, reads[0]!);
    await page.keyboard.press("a");
    await expectReadCount(page, reads, 2);
    expect(await actions(page)).toEqual([]);
    await settleRead(page, reads[1]!);
    await expect.poll(() => actions(page)).toEqual([
      { sessionId: id, requestId: reads[1]!.session.pendingApproval!.requestId, optionId: "deny" },
    ]);
  });
}

test("authorization refusal and unsafe options retain their toasts and allow a later valid retry", async ({ page }) => {
  const { reads } = await fixture(page);
  await page.keyboard.press("a");
  await expect.poll(() => reads.length).toBe(1);
  const blocked = { ...reads[0]!.session, commandPermissions: {
    ...reads[0]!.session.commandPermissions,
    respond: { allowed: false, reason: "Synthetic principal cannot respond." },
  } } as SessionView;
  await settleRead(page, reads[0]!, blocked);
  await expect(page.getByText("Synthetic principal cannot respond.", { exact: true })).toBeVisible();
  expect(await actions(page)).toEqual([]);
  await page.evaluate((id) => {
    const fixture = window.__WOLLIPOG_INBOX_TRIAGE_E2E__;
    const session = fixture.detail(id);
    fixture.summary(id, { pendingApproval: { ...session.pendingApproval!, options: [] } });
  }, reads[0]!.id);
  await page.keyboard.press("a");
  await expect.poll(() => reads.length).toBe(2);
  await settleRead(page, reads[1]!);
  await expect(page.getByText("No safe one-key approval is available for this request.", { exact: true })).toBeVisible();
  expect(await actions(page)).toEqual([]);
  await page.evaluate((id) => {
    const fixture = window.__WOLLIPOG_INBOX_TRIAGE_E2E__;
    const session = fixture.detail(id);
    fixture.summary(id, { pendingApproval: { ...session.pendingApproval!, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
  }, reads[0]!.id);
  await page.keyboard.press("a");
  await expect.poll(() => reads.length).toBe(3);
  await settleRead(page, reads[2]!);
  await expect.poll(() => actions(page)).toHaveLength(1);
});

test("a question still opens its exact request without deciding it", async ({ page }) => {
  const { reads } = await fixture(page);
  await page.keyboard.press("a");
  await expect.poll(() => reads.length).toBe(1);
  const session = { ...reads[0]!.session, pendingApproval: {
    requestId: "question-request", occurrenceId: "question-occurrence", kind: "question" as const, title: "Which target?", options: [],
  } };
  await settleRead(page, reads[0]!, session);
  await expect.poll(() => new URL(page.url()).searchParams.get("path")).toBe(
    `/sessions/~${encodeResourceId(session.id)}/attention/~${encodeResourceId("question-request")}?epoch=0`,
  );
  expect(await actions(page)).toEqual([]);
});

test("repeated question denial dismisses one exact occurrence", async ({ page }) => {
  const { reads } = await fixture(page);
  await page.keyboard.press("d");
  await expect.poll(() => reads.length).toBe(1);
  await page.keyboard.press("d");
  await expectReadCount(page, reads, 1);
  const session = { ...reads[0]!.session, pendingApproval: {
    requestId: "question-request", occurrenceId: "question-occurrence", kind: "question" as const, title: "Which target?", options: [],
  } };
  await settleRead(page, reads[0]!, session);
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_INBOX_TRIAGE_E2E__.questionActions())).toEqual([
    { sessionId: session.id, body: { requestId: "question-request", occurrenceId: "question-occurrence", answers: {}, action: "dismiss" } },
  ]);
  expect(await actions(page)).toEqual([]);
});

test("a mismatched response releases its owner without hydrating or deciding another session", async ({ page }) => {
  const { reads } = await fixture(page);
  await page.keyboard.press("a");
  await expect.poll(() => reads.length).toBe(1);
  await settleRead(page, reads[0]!, { ...reads[0]!.session, id: "another-session" });
  expect(await actions(page)).toEqual([]);
  await page.keyboard.press("d");
  await expect.poll(() => reads.length).toBe(2);
  await settleRead(page, reads[1]!);
  await expect.poll(() => actions(page)).toHaveLength(1);
});

test("leaving Inbox cancels the pending fence before its late response", async ({ page }) => {
  const { reads } = await fixture(page);
  await page.keyboard.press("a");
  await expect.poll(() => reads.length).toBe(1);
  // Navigation released duplicate coordination; unmount must still own and cancel this fence.
  await page.keyboard.press("j");
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("path", "/projects");
    window.history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator(".inbox-list")).toHaveCount(0);
  await settleRead(page, reads[0]!);
  expect(await actions(page)).toEqual([]);
});
