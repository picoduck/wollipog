import { expect, test, type Locator, type Page } from "@playwright/test";

/** Every Request Card marks a clipped edge one way (#2715, §13.2): while its body scrolls, each edge
 * it can still scroll past shows a `--border` hairline, never a fade. A question card that scrolls
 * whole marks its own edges the same way (#2698, agent-questions.spec.ts). */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
});

const KINDS = [
  { kind: "sign_in", url: "/authentication-recovery-e2e.html?scenario=email" },
  { kind: "question", url: "/agent-questions-e2e.html?set=long" },
  // A worktree setup request: a long command in a code well.
  { kind: "permission", url: "/request-surfaces-e2e.html?scenario=standalone" },
] as const;

async function dockedBody(page: Page, url: string): Promise<{ card: Locator; body: Locator }> {
  await page.goto(url);
  const card = page.locator(".request-dock .request-card").first();
  await expect(card).toBeVisible();
  return { card, body: card.locator(".request-card-body") };
}

/** The body's edges: which hairlines are drawn, how far it scrolls, and whether anything dims it. */
const bodyEdges = (body: Locator) => body.evaluate((element) => {
  const drawn = (pseudo: "::before" | "::after", side: "Top" | "Bottom") => {
    const style = getComputedStyle(element, pseudo);
    return style.content !== "none" && style[`border${side}Style`] === "solid" && style[`border${side}Width`] === "1px";
  };
  const style = getComputedStyle(element);
  return {
    above: drawn("::before", "Bottom"),
    below: drawn("::after", "Top"),
    range: element.scrollHeight - element.clientHeight,
    dimmed: style.maskImage !== "none" || style.opacity !== "1",
  };
});

for (const { kind, url } of KINDS) {
  test(`at 1440×900 a ${kind} card's scrolling body draws a hairline at each edge it can still scroll past, and none at the end`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { card, body } = await dockedBody(page, url);
    await expect(card).toHaveAttribute("data-request-kind", kind);
    // At the start more waits below: the lower edge says so, and nothing is dimmed.
    const start = await bodyEdges(body);
    expect(start).toEqual({ above: false, below: true, range: start.range, dimmed: false });
    expect(start.range).toBeGreaterThan(20);
    // The line spans the card across its padding, wider than anything framed in the body (a code
    // well's own border), so it reads as the edge it marks and never as that box closing.
    const span = await body.evaluate((element) => ({
      line: parseFloat(getComputedStyle(element, "::after").width),
      card: element.closest<HTMLElement>(".request-card")!.clientWidth,
      content: Math.max(...[...element.children].map((child) => child.getBoundingClientRect().width)),
    }));
    expect(Math.abs(span.line - span.card)).toBeLessThanOrEqual(1);
    expect(span.line).toBeGreaterThan(span.content + 16);
    // Midway both edges have content past them; the lines take no room.
    await body.evaluate((element) => { element.scrollTop = 12; });
    await expect.poll(() => bodyEdges(body)).toEqual({ above: true, below: true, range: start.range, dimmed: false });
    // At the end nothing is left below, and the line clears.
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => bodyEdges(body)).toEqual({ above: true, below: false, range: start.range, dimmed: false });
    // Back at the start, only the lower line again.
    await body.evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(() => bodyEdges(body)).toEqual({ above: false, below: true, range: start.range, dimmed: false });
  });
}

test("a question card scrolling whole draws its edge lines across the card too (#2698)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  const { card } = await dockedBody(page, "/agent-questions-e2e.html?set=paragraph&more=1");
  await expect(card).toHaveAttribute("data-card-scrolls", "");
  await card.evaluate((element) => { element.scrollTop = 60; });
  await expect(card).toHaveAttribute("data-clip-start", "");
  await expect(card).toHaveAttribute("data-clip-end", "");
  const spans = await card.evaluate((element) => ({
    above: parseFloat(getComputedStyle(element, "::before").width),
    below: parseFloat(getComputedStyle(element.querySelector(".request-card-foot")!, "::before").width),
    card: element.clientWidth,
  }));
  expect(Math.abs(spans.above - spans.card)).toBeLessThanOrEqual(1);
  expect(Math.abs(spans.below - spans.card)).toBeLessThanOrEqual(1);
});

test("a body that fits draws no edge lines", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { body } = await dockedBody(page, "/agent-questions-e2e.html?set=short");
  expect(await bodyEdges(body)).toEqual({ above: false, below: false, range: 0, dimmed: false });
});

test("in forced colors the body's edge lines are still drawn", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ forcedColors: "active" });
  for (const { kind, url } of KINDS) {
    const { card, body } = await dockedBody(page, url);
    await body.evaluate((element) => { element.scrollTop = 12; });
    await expect.poll(() => bodyEdges(body), kind).toMatchObject({ above: true, below: true });
    const [above, below, background] = await body.evaluate((element) => [
      getComputedStyle(element, "::before").borderBottomColor,
      getComputedStyle(element, "::after").borderTopColor,
      getComputedStyle(element.closest(".request-card")!).backgroundColor,
    ]);
    expect(above, kind).not.toBe(background);
    expect(below, kind).not.toBe(background);
    await expect(card).toBeVisible();
  }
});
