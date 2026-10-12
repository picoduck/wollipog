import { expect, test, type Page } from "@playwright/test";
import { installInboxFixture } from "./inbox-production-fixture.js";

async function openDelayedDismissal(page: Page, empty = false, partialFailure = false) {
  const fixture = await installInboxFixture(page);
  if (empty) await page.routeWebSocket("**/ui**", socket => socket.send(JSON.stringify({
    type: "snapshot", runners: [], sessions: [], boxes: [], runs: [], pods: [],
  })));
  await page.route("**/api/skills", route => route.fulfill({ json: { skills: ["using-wollipog", "orchestrate-issues"].map(name => ({
    id: name, name, builtIn: { release: "synthetic", heldUpdate: null },
    recommendation: { dismissed: false }, assignmentCount: 0,
  })) } }));
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  let requests = 0;
  await page.route("**/api/skills/*/recommendation", async route => {
    requests++;
    await pending;
    await route.fulfill(partialFailure && requests <= 2 && route.request().url().includes("orchestrate-issues")
      ? { status: 503, json: { error: "Synthetic dismissal failure" } }
      : { json: { ok: true } });
  });
  await page.goto("/index.html");
  const notice = page.getByRole("region", { name: "Recommended Skills", exact: true });
  await expect(notice).toBeVisible();
  const all = notice.getByRole("button", { name: "Dismiss All", exact: true });
  await all.focus();
  await page.keyboard.press("Enter");
  await expect(all).toBeDisabled();
  await expect.poll(() => requests).toBe(2);
  // Cross a browser task/frame boundary while both requests remain held. An immediate mocked
  // response cannot expose focus that native disabled clears before the removal commit.
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return { notice, release, disconnect: fixture.disconnect,
    target: empty ? page.locator(".inbox-state") : page.getByRole("grid", { name: "Sessions", exact: true }) };
}

for (const width of [390, 1440]) {
  for (const empty of [false, true]) {
    test(`delayed keyboard Dismiss All restores the ${empty ? "empty state" : "Sessions list"} at ${width}px @production`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const { notice, release, target } = await openDelayedDismissal(page, empty);
      release();
      await expect(notice).toBeHidden();
      await expect(target).toBeFocused();
    });
  }
}

test("deliberate focus movement during delayed Dismiss All stays on its new control @production", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { notice, release } = await openDelayedDismissal(page);
  const other = page.getByRole("button", { name: "New Session", exact: true });
  await other.focus();
  await expect(other).toBeFocused();
  release();
  await expect(notice).toBeHidden();
  await expect(other).toBeFocused();
});

test("deliberately clearing focus during delayed Dismiss All stays cleared @production", async ({ page }) => {
  const { notice, release } = await openDelayedDismissal(page);
  const other = page.getByRole("button", { name: "New Session", exact: true });
  await other.focus();
  await other.evaluate(button => button.blur());
  await page.evaluate(() => new Promise<void>(done => queueMicrotask(done)));
  release();
  await expect(notice).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
});

test("partial dismissal retains the failed skill and a keyboard retry recovers focus @production", async ({ page }) => {
  const { notice, release, target } = await openDelayedDismissal(page, false, true);
  release();
  await expect(notice.getByRole("alert")).toHaveText("Could not dismiss orchestrate-issues. Try again.");
  await expect(notice.getByRole("link")).toHaveText(["orchestrate-issues"]);
  await expect(notice).toBeFocused();
  const last = notice.getByRole("button", { name: "Dismiss orchestrate-issues", exact: true });
  await expect(last).toBeEnabled();
  await last.focus();
  await page.keyboard.press("Enter");
  await expect(notice).toBeHidden();
  await expect(target).toBeFocused();
});

test("disconnecting while dismissal is pending hides the notice and keeps the Sessions target usable @production", async ({ page }) => {
  const { notice, release, disconnect, target } = await openDelayedDismissal(page);
  disconnect();
  await expect(notice).toBeHidden();
  await expect(target).toBeFocused();
  release();
  await expect(target).toBeFocused();
  await expect(notice).toBeHidden();
});
