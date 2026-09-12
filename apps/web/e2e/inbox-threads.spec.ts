import { expect, test, type Page } from "@playwright/test";
import { pinWidestFace } from "./font-geometry";
test.use({ video: "on" });

/**
 * #896: a parent session and its children read as one thread in the Sessions list, every card
 * still measures one card, and the thread is driven from the home row. The harness mounts the real
 * InboxView against a fixture socket (see sessions-board-main.tsx); `?threads=1` adds an
 * orchestrator with four children and gives one session three pending requests.
 */
const PAGE = "/sessions-board-e2e.html?threads=1";
const EVIDENCE = ".agents/tmp/inbox-threads";

async function openList(page: Page, path = "/") {
  await page.goto(`${PAGE}&path=${encodeURIComponent(path)}`);
  await expect(page.locator(".inbox-toolbar")).toBeVisible();
}

const titles = (page: Page) => page.locator(".inbox-row-title").allTextContents();
const grid = (page: Page) => page.getByRole("grid", { name: "Sessions", exact: true });
const parentRow = (page: Page) => page.locator(".inbox-row-shell", { hasText: "Ship the usage and cost overhaul" });

async function enableTouch(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  return cdp;
}

async function tapAt(cdp: Awaited<ReturnType<typeof enableTouch>>, point: { x: number; y: number }) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("a family sorts as one unit with the parent first, children indent under it, and every card keeps one height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openList(page);
  await expect(page.locator(".inbox-row")).toHaveCount(9);
  // Fired reminders lead as before. Then urgency before recency: the live family, two of whose
  // children are waiting, is ONE unit placed by that most urgent member, parent first and its
  // children by the same rule; the fixture's older waiting session follows; then the running and
  // queued rows; the snoozed row is hidden from Active.
  expect(await titles(page)).toEqual([
    "Review Session",
    "Ship the usage and cost overhaul",
    "#603: Normalize the allowance window",
    "#601: Link the cost source",
    "#600: Add the usage table",
    "#602: Roll the daily budget over",
    "Approval Session",
    "Queued Session",
    "Running Session",
  ]);
  // The two-row desktop shape is untouched by #934: its time stays in the signals column.
  await expect(page.locator(".inbox-row-signals > time")).toHaveCount(9);
  await expect(page.locator(".inbox-row-meta > time")).toHaveCount(0);
  const parent = parentRow(page);
  await expect(parent.locator(".inbox-thread-toggle")).toHaveAttribute("aria-label", "Collapse Thread");
  await expect(parent.locator(".inbox-thread-family-text")).toHaveText("4 Children · 2 Awaiting Input");
  await expect(parent.locator(".inbox-thread-family")).toHaveClass(/waiting/);
  await expect(parent.locator(".inbox-thread-dot")).toHaveCount(4);
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await expect(page.locator(".inbox-row-shell.thread-child.thread-last")).toHaveCount(1);
  // The three-request session: one pill per kind, the question first, the permissions counted.
  const approval = page.locator(".inbox-row-shell", { hasText: "Approval Session" });
  await expect(approval.locator(".inbox-status-pill.blocked")).toHaveText(["Answer Required", "Approval Required2"]);
  await expect(approval.locator(".inbox-status-pill.blocked").nth(1))
    .toHaveAttribute("aria-label", "Attention: Approval Required, 2 Requests");
  await expect(approval.locator(".inbox-status-pill.blocked").nth(1))
    .toHaveAttribute("title", "Main Agent: Run npm test\nVerifier · Tester: Run pnpm test");
  await expect(page.locator(".attention-requests")).toHaveCount(0);

  const geometry = await page.locator(".inbox-row-shell").evaluateAll((shells) => shells.map((shell) => {
    const box = shell.querySelector(".inbox-row")!.getBoundingClientRect();
    return { left: Math.round(box.left), height: Math.round(box.height), child: shell.classList.contains("thread-child") };
  }));
  const heights = new Set(geometry.map((row) => row.height));
  expect(heights.size, `every card measures the same: ${JSON.stringify(geometry)}`).toBe(1);
  const parentLeft = geometry[0]!.left;
  for (const row of geometry) expect(row.left - parentLeft).toBe(row.child ? 26 : 0);
  await page.screenshot({ path: `${EVIDENCE}/desktop-expanded.png`, fullPage: true });
});

test("t, Shift+T, p, and the arrows drive the thread, the chevron is the pointer path, and collapse persists", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openList(page);
  await parentRow(page).locator(".inbox-row").click();
  const list = grid(page);
  await expect(list).toBeFocused();
  await list.press("t");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  await expect(parentRow(page).locator(".inbox-thread-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(parentRow(page).locator(".inbox-thread-family-text")).toHaveText("4 Children · 2 Awaiting Input");
  await page.screenshot({ path: `${EVIDENCE}/desktop-collapsed.png`, fullPage: true });
  await page.reload();
  await expect(page.locator(".inbox-toolbar")).toBeVisible();
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  await expect(parentRow(page).locator(".inbox-thread-toggle")).toHaveAttribute("aria-expanded", "false");

  await parentRow(page).locator(".inbox-row").click();
  await list.press("t");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await list.press("j");
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("#603");
  await list.press("p");
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("Ship the usage");
  await list.press("ArrowRight");
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("#603");
  await list.press("t");
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("Ship the usage");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  await list.press("ArrowRight");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await list.press("ArrowLeft");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  await list.press("Shift+T");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await list.press("Shift+T");
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);

  // The chevron and the family chip toggle without selecting the row.
  await page.locator(".inbox-row-shell", { hasText: "Running Session" }).locator(".inbox-row").click();
  await parentRow(page).locator(".inbox-thread-toggle").click();
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("Running Session");
  await parentRow(page).locator(".inbox-thread-family").click();
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  await expect(page.locator('.inbox-row-shell[aria-selected="true"]')).toContainText("Running Session");
  expect(await page.evaluate(() => window.__approveCalls)).toEqual([]);
});

test("a pinned descendant names itself when expanded and only promotes its collapsed parent", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openList(page);
  const child = page.locator(".inbox-row-shell", { hasText: "#602: Roll the daily budget over" });
  await child.click({ button: "right" });
  await page.getByRole("menu", { name: /Session Actions/ }).getByRole("menuitem", { name: "Pin Session" }).click();
  await expect(child.getByLabel("Pinned Session")).toBeVisible();
  await expect(parentRow(page).getByLabel("Contains Pinned Session")).toHaveCount(0);
  await expect(parentRow(page).getByLabel("Pinned Session", { exact: true })).toHaveCount(0);

  await parentRow(page).locator(".inbox-thread-toggle").click();
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(0);
  await expect(parentRow(page).getByLabel("Contains Pinned Session")).toBeVisible();
  await expect(parentRow(page).getByLabel("Pinned Session", { exact: true })).toHaveCount(0);

  await parentRow(page).locator(".inbox-thread-toggle").click();
  await expect(child.getByLabel("Pinned Session")).toBeVisible();
  await expect(parentRow(page).getByLabel("Contains Pinned Session")).toHaveCount(0);
  await page.screenshot({ path: `${EVIDENCE}/desktop-pinned-descendant.png`, fullPage: true });
});

/**
 * Line one's geometry for every card, measured in the page.
 *
 * Self-contained on purpose: Playwright serialises this function, so it can call nothing from the
 * module around it. Both font passes in the phone test below share it verbatim.
 */
const measureLineOne = (shells: Element[]) => shells.map((shell) => {
    const row = shell.querySelector<HTMLElement>(".inbox-row")!;
    const box = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    const signals = row.querySelector<HTMLElement>(".inbox-row-signals")!.getBoundingClientRect();
    const time = row.querySelector<HTMLElement>("time")!;
    const sender = row.querySelector<HTMLElement>(".inbox-row-sender")!.getBoundingClientRect();
    // The label is its own clip box: `.inbox-row-sender > span` carries the overflow and ellipsis.
    const label = row.querySelector<HTMLElement>(".inbox-row-sender > span")!;
    const labelBox = label.getBoundingClientRect();
    // The agent's first word, measured as it is actually laid out rather than in assumed pixels:
    // a Range over those characters reports their real advance width in whatever font rendered them.
    const firstWord = (label.textContent ?? "").split(" ")[0] ?? "";
    const range = document.createRange();
    range.setStart(label.firstChild!, 0);
    range.setEnd(label.firstChild!, firstWord.length);
    const wordBox = range.getBoundingClientRect();
    range.detach();
    return {
      title: shell.querySelector(".inbox-row-title")!.textContent,
      left: Math.round(box.left),
      height: Math.round(box.height),
      child: shell.classList.contains("thread-child"),
      pills: row.querySelectorAll(".inbox-status-pill").length,
      timeCount: row.querySelectorAll("time").length,
      timeOnLineThree: time.parentElement!.classList.contains("inbox-row-meta"),
      timeText: time.textContent,
      timeHeight: time.getBoundingClientRect().height,
      timeOverflowRight: time.getBoundingClientRect().right - (box.right - parseFloat(style.paddingRight)),
      signalsOverflowRight: signals.right - (box.right - parseFloat(style.paddingRight)),
      signalsOverflowLeft: (box.left + parseFloat(style.paddingLeft)) - signals.left,
      senderWidth: sender.width,
      firstWord,
      firstWordWidth: wordBox.width,
      // Positive means the word is cut off by the label's clip box.
      firstWordClipped: wordBox.right - labelBox.right,
    };
});

test("a phone narrows the spine and keeps the family chip's dots", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openList(page);
  await expect(page.locator(".inbox-row").first().locator(":scope > *").first()).toHaveClass(/inbox-row-sender/);
  await expect(page.locator(".inbox-row-shell.thread-child")).toHaveCount(4);
  await expect(parentRow(page).locator(".inbox-thread-dot")).toHaveCount(4);
  await expect(parentRow(page).locator(".inbox-thread-family-text")).toBeHidden();
  // One compact attention pill on a phone: the top-priority kind and how many more requests.
  const approval = page.locator(".inbox-row-shell", { hasText: "Approval Session" });
  await expect(approval.locator(".inbox-status-pill.blocked")).toHaveCount(1);
  await expect(approval.locator(".inbox-status-pill.blocked")).toHaveAttribute("aria-label", "Attention: Answer Required, 3 Requests");
  await expect(approval.locator(".inbox-status-pill-count")).toHaveText("+2");
  const geometry = await page.locator(".inbox-row-shell").evaluateAll(measureLineOne);
  // Every phone card measures the same, whatever its pills (#917), and indenting changes nothing.
  expect(new Set(geometry.map((row) => row.height)).size, JSON.stringify(geometry)).toBe(1);
  for (const row of geometry) expect(row.left - geometry[0]!.left).toBe(row.child ? 14 : 0);
  // The time moved to line three's trailing edge (#934), once per card and with its suffix back.
  for (const row of geometry) {
    expect(row.timeCount, "one time element per card").toBe(1);
    expect(row.timeOnLineThree, `${row.title} keeps its time on line three`).toBe(true);
    expect(row.timeText).toMatch(/ ago$|^just now$|^—$/);
    expect(row.timeHeight, "the time is on one line").toBeLessThanOrEqual(20);
    expect(row.timeOverflowRight).toBeLessThanOrEqual(0.5);
  }
  // With line one carrying only the sender and its pills, the three-pill card (#603: Awaiting
  // Input, Approval Required, Stalled) shows the agent's whole first word beside the icon — the
  // criterion #916 could not meet while the time sat on that line. Asserted against the word's
  // own rendered width, so CI's wider fallback face cannot make it a pixel argument.
  const three = geometry.find((row) => row.title?.startsWith("#603"))!;
  expect(three.pills).toBe(3);
  expect(three.firstWord).toBe("Claude");
  expect(three.firstWordWidth).toBeGreaterThan(0);
  expect(three.firstWordClipped, `"${three.firstWord}" is clipped by ${three.firstWordClipped}px`)
    .toBeLessThanOrEqual(0.5);
  expect(three.signalsOverflowRight).toBeLessThanOrEqual(0.5);
  expect(three.signalsOverflowLeft).toBeLessThanOrEqual(0.5);

  /*
   * The same card again in the WIDEST face these fixtures render in.
   *
   * The app asks for Segoe UI and falls back through system-ui to plain sans-serif, so the text's
   * advance width depends on which faces the machine has: this box resolves it to Noto Sans, CI to
   * DejaVu Sans, about 8% wider, which leaves line one several pixels tighter. That gap is how the
   * first-word guarantee passed here and failed there (#934). Pinning the wide face makes the tight
   * case deterministic on every machine instead of only on the unlucky one.
   */
  //
  const wideFace = await pinWidestFace(page, page.locator(".inbox-row"));
  const wide = await page.locator(".inbox-row-shell").evaluateAll(measureLineOne);
  const wideThree = wide.find((row) => row.title?.startsWith("#603"))!;
  expect(wideThree.firstWordWidth, `${wideFace} is at least as wide as the ambient face`)
    .toBeGreaterThanOrEqual(three.firstWordWidth);
  expect(wideThree.firstWordClipped, `"${wideThree.firstWord}" is clipped by ${wideThree.firstWordClipped}px in the wide face`)
    .toBeLessThanOrEqual(0.5);
  expect(wideThree.signalsOverflowRight).toBeLessThanOrEqual(0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${EVIDENCE}/phone-expanded.png`, fullPage: true });
});

test("the mobile thread toggle confines paint beside both provider icons at both densities", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await enableTouch(page);
  for (const provider of ["claude", "openai"] as const) {
    await page.goto(`${PAGE}&thread-provider=${provider}`);
    await expect(page.locator(".inbox-toolbar")).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    for (const density of ["compact", "comfortable"] as const) {
      await page.evaluate((value) => {
        if (value === "comfortable") document.documentElement.dataset.density = value;
        else delete document.documentElement.dataset.density;
      }, density);
      const toggle = parentRow(page).locator(".inbox-thread-toggle");
      const before = await toggle.getAttribute("aria-expanded");
      const geometry = await parentRow(page).evaluate((shell) => {
        const target = shell.querySelector<HTMLElement>(".inbox-thread-toggle")!;
        const glyph = target.querySelector<HTMLElement>("span")!;
        const providerIcon = shell.querySelector<HTMLElement>(".inbox-row-sender .agent-icon")!;
        const targetBox = target.getBoundingClientRect();
        const glyphBox = glyph.getBoundingClientRect();
        const iconBox = providerIcon.getBoundingClientRect();
        return {
          targetWidth: targetBox.width,
          glyphRight: glyphBox.right,
          iconLeft: iconBox.left,
          targetBackground: getComputedStyle(target).backgroundColor,
        };
      });
      expect(geometry.targetWidth).toBeGreaterThanOrEqual(32);
      expect(geometry.glyphRight, `${provider}/${density}: painted glyph clears provider`)
        .toBeLessThanOrEqual(geometry.iconLeft);
      expect(geometry.targetBackground).toBe("rgba(0, 0, 0, 0)");
      const box = (await toggle.boundingBox())!;
      await tapAt(cdp, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await expect(toggle).toHaveAttribute("aria-expanded", before === "true" ? "false" : "true");
      await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
  }
  await page.screenshot({ path: `${EVIDENCE}/phone-toggle-clear.png`, fullPage: true });
});

test("Board cards carry the per-kind pills and the family chip without nesting", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openList(page, "/board");
  const card = page.locator(".card", { hasText: "Ship the usage and cost overhaul" });
  await expect(card.locator(".inbox-thread-family-text")).toHaveText("4 Children · 2 Awaiting Input");
  await expect(card.locator(".inbox-thread-dot")).toHaveCount(4);
  const approval = page.locator(".card", { hasText: "Approval Session" });
  await expect(approval.locator(".inbox-status-pill.blocked")).toHaveText(["Answer Required", "Approval Required2"]);
  await expect(page.locator(".attention-requests")).toHaveCount(0);
  await expect(page.locator(".card.thread-child")).toHaveCount(0);
  await page.screenshot({ path: `${EVIDENCE}/board.png`, fullPage: true });
});
