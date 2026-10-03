import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Orchestrator Controls (#2192): the + menu keeps one Orchestrator Controls… row, and the dialog it
 * opens holds Child Session Requests, one Human | Orchestrator segmented control per workflow gate,
 * and the campaign's stored behavior. The fixture is the session-usage harness's Orchestrator.
 */

const SHOT = "test-results/orchestrator-controls";
const GATES = [
  ["Implementation Questions", "Orchestrator"],
  ["PR Merge Approval", "Human"],
  ["Merged Branch Deletion", "Human"],
  ["Follow-Up Issue Publication", "Orchestrator"],
  ["UI Evidence Approval", "Human"],
] as const;

async function openFixture(page: Page, width: number, height: number, extra = "") {
  await page.setViewportSize({ width, height });
  await page.goto(`/session-usage-e2e.html?width=${width}&height=${height}&composer=orchestrator${extra}`);
}

async function openControls(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Add and Modes" }).click();
  await page.getByRole("button", { name: "Orchestrator Controls…" }).click();
  const dialog = page.getByRole("dialog", { name: "Orchestrator Controls" });
  await expect(dialog).toBeVisible();
  // Captures show the settled dialog, not its fade-in.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  return dialog;
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const) {
  test(`${viewport.name}: the + menu has one Orchestrator Controls row and does not scroll`, async ({ page }) => {
    await openFixture(page, viewport.width, viewport.height);
    await page.getByRole("button", { name: "Add and Modes" }).click();
    const menu = page.locator('.menu[aria-label="Session Attachments, Modes, and Guardrails"]');
    const row = menu.getByRole("button", { name: "Orchestrator Controls…" });
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeInViewport();
    await expect(row).toHaveAccessibleDescription("3 of 5 decisions stay with a person.");
    await expect(menu.locator("dl, .ui-select")).toHaveCount(0);
    await expect(menu).not.toContainText("Campaign Behavior");
    await expect(menu).not.toContainText("approvals");
    const overflow = await menu.evaluate((node) => node.scrollHeight - node.clientHeight);
    expect(overflow, "the menu fits without scrolling").toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${SHOT}/${viewport.name}-plus-menu.png` });
  });

  for (const theme of ["dark", "light"] as const) {
    test(`${viewport.name} ${theme}: the dialog shows the requests, the gates and the campaign`, async ({ page }) => {
      await openFixture(page, viewport.width, viewport.height);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const dialog = await openControls(page);
      await expect(dialog.locator(".section-title")).toHaveText(["Child Session Requests", "Workflow Decisions", "Campaign Behavior"]);
      const requests = dialog.getByRole("radiogroup", { name: "Child Session Requests" });
      await expect(requests.getByRole("radio", { name: "Questions and Approvals" })).toBeChecked();
      for (const [label, checked] of GATES) {
        const gate = dialog.getByRole("radiogroup", { name: label });
        await expect(gate.getByRole("radio")).toHaveText(["Human", "Orchestrator"]);
        await expect(gate.getByRole("radio", { name: checked })).toHaveAttribute("aria-checked", "true");
      }
      await expect(dialog).toContainText("Goes to a person here: The Orchestrator model \"text-only\" does not accept image input.");
      const facts = dialog.locator("dl.facts");
      await expect(facts.locator(".status")).toContainText("Awaiting Decision");
      await expect(facts).toContainText("Policy Revision 4");
      await expect(facts).toContainText("1 Verified · 2 Active · 1 Waiting for Human · 0 Blocked");
      await expect(facts).toContainText("1 Duplicate Skipped");
      await expect(dialog.locator(".modal-foot button")).toHaveText(["Done"]);
      await page.screenshot({ path: `${SHOT}/${viewport.name}-${theme}-dialog.png` });
      await facts.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOT}/${viewport.name}-${theme}-campaign.png` });

      // One click changes a gate and saves it; the check shows for about two seconds.
      const merge = dialog.getByRole("radiogroup", { name: "PR Merge Approval" });
      await merge.scrollIntoViewIfNeeded();
      await merge.getByRole("radio", { name: "Orchestrator" }).click();
      const row = merge.locator("xpath=..");
      await expect(row.locator(".ui-row-saved")).toHaveText("Saved");
      await expect(merge.getByRole("radio", { name: "Orchestrator" })).toHaveAttribute("aria-checked", "true");
      await page.screenshot({ path: `${SHOT}/${viewport.name}-${theme}-gate-saved.png` });
      await expect(row.locator(".ui-row-saved")).toHaveCount(0, { timeout: 4_000 });

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    });
  }
}

test("without a campaign the dialog has no Campaign Behavior facts beyond the stored policy", async ({ page }) => {
  await openFixture(page, 1440, 900, "&campaign-state=off");
  const dialog = await openControls(page);
  await expect(dialog.locator("dl.facts")).not.toContainText("Campaign Status");
  await expect(dialog.locator("dl.facts")).toContainText("Child Model");
});

test.describe("phone with a coarse pointer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("below 560px each gate's control sits under its label, facts read label over value, and every control is 44px", async ({ page }) => {
    await page.goto("/session-usage-e2e.html?width=390&height=844&composer=orchestrator");
    const dialog = await openControls(page);
    for (const [label] of GATES) {
      const gate = dialog.getByRole("radiogroup", { name: label });
      const title = dialog.locator(".orchestrator-gate-label", { hasText: label });
      await gate.scrollIntoViewIfNeeded();
      const [gateBox, titleBox] = [await gate.boundingBox(), await title.boundingBox()];
      expect(gateBox!.y, `${label}'s control sits under its label`).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height - 1);
      // The segmented recipe draws a 38px option in a 44px track and lends it the track's inset
      // through ::after, so the hit area is the track's height.
      expect(gateBox!.height, `${label}'s track is 44px`).toBeGreaterThanOrEqual(43.5);
      for (const radio of await gate.getByRole("radio").all()) {
        const hit = await radio.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return [box.top - 2, box.bottom + 2].map((y) => node.contains(document.elementFromPoint(box.left + box.width / 2, y)));
        });
        expect(hit, `${label} options take taps across the full 44px`).toEqual([true, true]);
      }
    }
    for (const row of await dialog.getByRole("radiogroup", { name: "Child Session Requests" }).locator(".choice-row").all()) {
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    }
    const done = dialog.getByRole("button", { name: "Done" });
    expect((await done.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    const term = dialog.locator("dl.facts dt", { hasText: "Child Model" });
    const value = term.locator("xpath=following-sibling::dd[1]");
    const [termBox, valueBox] = [await term.boundingBox(), await value.boundingBox()];
    expect(valueBox!.y, "the value sits under its label").toBeGreaterThanOrEqual(termBox!.y + termBox!.height - 1);
    await page.screenshot({ path: `${SHOT}/phone-sheet.png` });
  });
});

for (const theme of ["dark", "light"] as const) {
  test(`desktop ${theme}: the Pinned Summary's Orchestrator rows state the routing and open the dialog`, async ({ page }) => {
    await openFixture(page, 1440, 900, "&pinned=1");
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const summary = page.locator('aside.ps[aria-label="Pinned Summary"]');
    const requests = summary.getByRole("button", { name: /^Child Session Requests/ });
    const decisions = summary.getByRole("button", { name: /^Workflow Decisions/ });
    await expect(requests).toContainText("Questions and Approvals");
    await expect(decisions).toContainText("3 of 5 decisions stay with a person.");
    await expect(requests.locator(".ps-go")).toBeVisible();
    await summary.screenshot({ path: `${SHOT}/desktop-${theme}-pinned-summary.png` });
    await decisions.click();
    const dialog = page.getByRole("dialog", { name: "Orchestrator Controls" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(decisions).toBeFocused();
  });
}
