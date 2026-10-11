import { expect, test } from "@playwright/test";
import { installInboxFixture } from "./inbox-production-fixture.js";

for (const colorScheme of ["light", "dark"] as const) {
  test(`a late phone Sessions notice preserves rendered row positions in ${colorScheme} @production`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme });
    await installInboxFixture(page);
    await page.route("**/api/skills/*/recommendation", route => route.fulfill({ json: { ok: true } }));
    let release!: () => void;
    const pending = new Promise<void>(done => { release = done; });
    await page.route("**/api/skills", async route => {
      await pending;
      await route.fulfill({ json: { skills: ["orchestrate-issues", "using-wollipog"].map(name => ({
        id: name, name, builtIn: { release: "synthetic", heldUpdate: null },
        recommendation: { dismissed: false }, assignmentCount: 0,
      })) } });
    });
    await page.goto("/index.html");
    const first = page.locator(".inbox-row").first();
    await expect(first).toBeVisible();
    const top = (await first.boundingBox())!.y;
    if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/phone-${colorScheme}-pending.png` });
    release();
    await expect(page.getByRole("region", { name: "Recommended Skills", exact: true })).toBeVisible();
    await expect.poll(async () => (await first.boundingBox())!.y).toBe(top);
    await expect(first).toBeVisible();
    if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/phone-${colorScheme}-ready.png` });
    // The notice remains usable; a deliberate focus move during dismissal stays with the list.
    await page.getByRole("button", { name: "Dismiss All", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("grid", { name: "Sessions", exact: true }).focus();
    await expect(page.getByRole("region", { name: "Recommended Skills", exact: true })).toBeHidden();
    await expect(page.getByRole("grid", { name: "Sessions", exact: true })).toBeFocused();
    expect((await first.boundingBox())!.y).toBe(top);
  });
}

for (const width of [390, 760, 834, 1440]) {
  for (const response of ["empty", "error"] as const) {
    test(`a ${response} library leaves the ${width}px Sessions list usable @production`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await installInboxFixture(page);
      let release!: () => void;
      const pending = new Promise<void>(done => { release = done; });
      await page.route("**/api/skills", async route => {
        await pending;
        await route.fulfill(response === "empty" ? { json: { skills: [] } } : { status: 503, json: { error: "Synthetic library error" } });
      });
      await page.goto("/index.html");
      const first = page.locator(".inbox-row").first();
      await expect(first).toBeVisible();
      const top = (await first.boundingBox())!.y;
      const responseReceived = page.waitForResponse("**/api/skills");
      release();
      await responseReceived;
      await expect(page.locator(".inbox-list-notices")).toBeHidden();
      expect((await first.boundingBox())!.y).toBe(top);
      await expect(page.getByRole("button", { name: /Synthetic Session 1\b/ })).toBeVisible();
    });
  }
}

for (const mode of ["list", "board", "empty"] as const) {
  test(`a short phone preserves ${mode} space when the notice arrives and the viewport shrinks @production`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 400 });
    await installInboxFixture(page);
    if (mode === "empty") await page.routeWebSocket("**/ui**", socket => socket.send(JSON.stringify({
      type: "snapshot", runners: [], sessions: [], boxes: [], runs: [], pods: [],
    })));
    await page.route("**/api/skills", route => route.fulfill({ json: { skills: ["orchestrate-issues", "using-wollipog"].map(name => ({
      id: name, name, builtIn: { release: "synthetic", heldUpdate: null }, recommendation: { dismissed: false }, assignmentCount: 0,
    })) } }));
    await page.goto(mode === "board" ? "/board" : "/index.html");
    await expect(page.getByRole("region", { name: "Recommended Skills", exact: true })).toBeVisible();
    const content = page.locator(mode === "board" ? ".board-wrap" : mode === "empty" ? ".inbox-state" : ".inbox-list");
    await expect(content).toBeVisible();
    const action = page.getByRole("button", { name: "Dismiss All", exact: true });
    const actionInside = () => action.evaluate(button => {
      const b = button.getBoundingClientRect();
      const n = button.closest(".inbox-list-notices")!.getBoundingClientRect();
      const style = getComputedStyle(button);
      const outline = parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset));
      return style.outlineStyle !== "none" && outline > 0 && b.top - outline >= n.top && b.bottom + outline <= n.bottom;
    });
    for (const height of [400, 320]) {
      await page.setViewportSize({ width: 390, height });
      await expect.poll(async () => page.locator(".inbox-list-pane").evaluate(pane => {
        const notices = pane.querySelector<HTMLElement>(".inbox-list-notices")!;
        const content = pane.querySelector<HTMLElement>(".inbox-list, .board-wrap, .inbox-state")!;
        const p = pane.getBoundingClientRect(), n = notices.getBoundingClientRect(), c = content.getBoundingClientRect();
        return n.height <= p.height / 2 + 1 && c.height >= p.height / 2 - 1 && c.bottom <= n.top + 1 && notices.scrollHeight > notices.clientHeight;
      })).toBe(true);
      // Assert the already focused control after shrinking, before a new focus() could scroll it.
      if (height === 320) {
        await expect(action).toBeFocused();
        await expect.poll(actionInside).toBe(true);
      }
      await action.focus();
      await expect(action).toBeInViewport();
      await expect.poll(actionInside).toBe(true);
      if (process.env.EVIDENCE_DIR && mode === "list" && height === 320) {
        await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/phone-short-ready.png` });
      }
    }
  });
}
