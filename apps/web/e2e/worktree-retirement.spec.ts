import { expect, test } from "@playwright/test";

const path = "/home/dev/worktrees/wollipog/s_079714ea231c";
const state = { worktreeId: "worktree_079714ea231c", path, registeredBranch: "fix/export-history", branch: "fix/export-history",
  headSha: "8c5e97f3c824db6750fbb994347e822d5f6e4619", clean: true, pathIdentity: "2049:834518" };

for (const [device, viewport] of [
  ["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }],
] as const) test(`person-only worktree inspection and exact confirmation fit ${device}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  let confirmed: unknown;
  let refuse = true;
  await page.route("**/orchestrator-campaign/cleanup/worktree/inspect", route => route.fulfill({ json: { state } }));
  await page.route("**/orchestrator-campaign/cleanup/worktree/confirm", route => {
    confirmed = route.request().postDataJSON();
    return route.fulfill(refuse ? { status: 409, json: { error: "The branch or tip changed. Inspect again before confirming." } }
      : { json: { retirement: { status: "removed" } } });
  });
  await page.goto("/campaign-status-e2e.html?scenario=campaign&activity=cleanup&automation=complete&retirement=1&theme=light");
  const cleanup = page.locator(".campaign-status section", { has: page.getByRole("heading", { name: "Cleanup", exact: true }) });
  const row = cleanup.locator("li").filter({ hasText: path });
  await expect(row).not.toContainText(/ask the Orchestrator to retire/iu);
  await row.getByRole("button", { name: "Inspect Worktree", exact: true }).scrollIntoViewIfNeeded();
  await page.mouse.move(2, 2); await page.mouse.wheel(0, -100_000);
  await expect.poll(() => page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
  const evidence = process.env.WORKTREE_RETIREMENT_EVIDENCE_DIR;
  if (evidence) await row.screenshot({ path: `${evidence}/retirement-${device}-cleanup.png` });
  await row.getByRole("button", { name: "Inspect Worktree", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Retire Worktree", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("dt")).toHaveText(["Path", "Branch", "Tip", "Working Tree"]);
  await expect(dialog).toContainText(path);
  await expect(dialog).toContainText(state.branch);
  await expect(dialog).toContainText(state.headSha);
  await expect(dialog).toContainText("Clean");
  const retire = dialog.getByRole("button", { name: "Retire Worktree", exact: true });
  await expect(retire).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await expect(retire).toBeEnabled();
  await dialog.locator(".modal-body").hover(); await page.mouse.wheel(0, -100_000);
  await expect.poll(() => dialog.locator(".modal-body").evaluate(element => element.scrollTop)).toBe(0);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  if (evidence) await dialog.screenshot({ path: `${evidence}/retirement-${device}-confirmation.png` });
  await retire.click();
  expect(confirmed).toMatchObject({ state });
  await expect(row).toContainText("The branch or tip changed.");
  await expect(dialog).toHaveCount(0);
  refuse = false;
  await row.getByRole("button", { name: "Inspect Worktree", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Retire Worktree", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Retire Worktree", exact: true }).click();
  await expect(row).toContainText("Local branch refs were kept");
});
