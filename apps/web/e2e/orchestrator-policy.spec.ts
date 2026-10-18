import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * New Session's Orchestrator Policy (#2955): a summary row under Role, and a dialog with Behavior,
 * Permissions and Decisions tabs that stacks over New Session on desktop and takes over its sheet,
 * with Back, on a phone. `?policy=1` answers with saved defaults that execute approved follow-ups
 * and run up to six children; `?defaults=orchestrator` makes Orchestrator the saved role.
 */

const PAGE = "/new-session-choices-e2e.html?defaults=orchestrator&policy=1";

async function openNewSession(page: Page, query = PAGE): Promise<Locator> {
  await page.goto(query);
  const dialog = page.getByRole("dialog", { name: "New Session" });
  await expect(dialog).toBeVisible();
  const head = dialog.getByRole("button", { name: "Options", exact: true });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await dialogMotionSettled(page);
  return dialog;
}

function summaryRow(dialog: Locator): Locator {
  return dialog.locator(".orchestrator-policy-summary");
}

async function openPolicy(dialog: Locator): Promise<Locator> {
  await dialog.getByRole("button", { name: "Customize…" }).click();
  const policy = dialog.page().getByRole("dialog", { name: "Orchestrator Policy" });
  await expect(policy).toBeVisible();
  await dialogMotionSettled(dialog.page());
  return policy;
}

async function chooseFollowUps(page: Page, policy: Locator, label: string): Promise<void> {
  await policy.getByRole("button", { name: /^Follow-Ups:/ }).click();
  await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
}

test("at 1440px the policy is one summary row with five facts, and Customize… stacks Orchestrator Policy over New Session", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dialog = await openNewSession(page);
  const row = summaryRow(dialog);
  await expect(row.locator(".orchestrator-policy-facts > span")).toHaveText([
    "Up to 6 Children", "Executes Approved Follow-Ups", "Keeps Finished Children", "Integration Isolation", "No Decisions Delegated",
  ]);
  await expect(row.getByRole("button", { name: "Customize…" })).toBeVisible();
  // No policy control is inline any more: Options holds Role, the summary, and its other rows.
  await expect(dialog.getByRole("spinbutton", { name: "Maximum Concurrent Children" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /^Child Harness:/ })).toHaveCount(0);
  // The summary is one row: no taller than the Role row above it plus a line.
  const heights = await dialog.evaluate((node) => {
    const rowOf = (selector: string) => node.querySelector(selector)!.closest(".setting-row")!.getBoundingClientRect().height;
    const description = node.querySelector(".modal-desc")!.getBoundingClientRect();
    const foot = node.querySelector(".modal-foot")!.getBoundingClientRect();
    const body = node.querySelector(".modal-body")!;
    return {
      summary: rowOf(".orchestrator-policy-summary .btn"),
      role: rowOf('[role="radiogroup"][aria-label="Role"]'),
      // From the description to the footer, as the whole body would lay out unscrolled.
      descriptionToFooter: foot.top - description.top + body.scrollHeight - body.clientHeight,
    };
  });
  testInfo.annotations.push({ type: "New Session description to footer (px)", description: String(Math.round(heights.descriptionToFooter)) });
  expect(heights.summary).toBeLessThanOrEqual(heights.role + 24);

  const policy = await openPolicy(dialog);
  // Stacked under one shared dim: New Session stays open and visible beneath it (§7.1).
  await expect(dialog).toBeVisible();
  await expect(page.locator(".modal-backdrop.stacked")).toHaveCount(1);
  await expect(policy.getByRole("tab")).toHaveText(["Behavior", "Permissions", "Decisions"]);
  await expect(policy.getByRole("button", { name: "Close" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("stacked-1440.png") });

  // Maximum Concurrent Children is a 96px field, as tall as the Selects above it.
  const limit = policy.getByRole("spinbutton", { name: "Maximum Concurrent Children" });
  const field = await limit.evaluate((input) => input.closest(".input-affix")!.getBoundingClientRect());
  const select = await policy.getByRole("button", { name: /^Child Effort:/ }).boundingBox();
  expect(Math.round(field.width)).toBe(96);
  expect(Math.abs(field.height - select!.height)).toBeLessThanOrEqual(0.5);
  // An out-of-range value: the error in its row, Apply Policy disabled with the reason in the footer.
  await limit.fill("65");
  await expect(policy.locator(".setting-row-number .field-error")).toHaveText("Enter a whole number from 0 to 64.");
  await expect(policy.getByRole("button", { name: "Apply Policy" })).toBeDisabled();
  await expect(policy.locator(".modal-foot .orchestrator-policy-reason")).toHaveText("Enter a whole number from 0 to 64.");
  // The footer keeps every button on one line beside its reason.
  const footer = await policy.locator(".modal-foot button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  expect(new Set(footer.map(Math.round)).size).toBe(1);
  await limit.fill("6");

  // Select lists open at least 280px wide, so two-line options fit.
  await policy.getByRole("button", { name: /^Follow-Ups:/ }).click();
  const list = await page.getByRole("listbox", { name: "Follow-Ups" }).boundingBox();
  expect(list!.width).toBeGreaterThanOrEqual(280);
  await page.keyboard.press("Escape");
});

for (const theme of ["dark", "light"] as const) {
  test(`at 390px Orchestrator Policy replaces the sheet's content with Back, and Back keeps the draft (${theme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await openNewSession(page, `${PAGE}&theme=${theme}`);
    // A change applied first is part of New Session's draft.
    let policy = await openPolicy(dialog);
    await chooseFollowUps(page, policy, "Recommend Only");
    await policy.getByRole("button", { name: "Apply Policy" }).click();
    await expect(policy).toHaveCount(0);
    await expect(summaryRow(dialog)).toContainText("1 change");

    policy = await openPolicy(dialog);
    // One sheet: New Session's content is covered, never a second sheet over it (§7.5).
    await expect(dialog).toBeHidden();
    await expect(page.locator(".modal-backdrop")).toHaveCount(1);
    const back = policy.getByRole("button", { name: "Back to New Session" });
    await expect(back).toBeVisible();
    await expect(policy.getByRole("button", { name: "Reset to Defaults" })).toBeHidden();
    await expect(policy.locator(".modal-foot button:visible")).toHaveText(["Cancel", "Apply Policy"]);
    await page.screenshot({ path: testInfo.outputPath(`phone-policy-${theme}.png`) });
    await policy.getByRole("radiogroup", { name: "Completion" }).getByRole("radio", { name: "Stop and Archive" }).click();
    await expect(policy.getByRole("tab", { name: /^Behavior/ })).toHaveText("Behavior2 Changed");
    await back.click();

    // Back returns to New Session with everything it held, and discards only the unapplied change.
    await expect(policy).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(summaryRow(dialog)).toContainText("1 change");
    await expect(summaryRow(dialog)).toContainText("Recommends Follow-Ups");
    await expect(summaryRow(dialog)).toContainText("Keeps Finished Children");
    await expect(dialog.getByRole("button", { name: /^Project:/ })).toContainText("Wollipog");
    await expect(dialog.getByRole("button", { name: "Customize…" })).toBeFocused();
    await dialog.getByRole("button", { name: "Create Session" }).click();
    const request = JSON.parse(await page.locator("html").getAttribute("data-create-session-request") ?? "{}");
    expect(request.orchestrator).toEqual({ behavior: { followUps: "recommend_only" }, delegation: {} });
  });
}

test("a defaults load failure is a compact danger notice with Retry, never the raw error", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dialog = await openNewSession(page, "/new-session-choices-e2e.html?defaults=orchestrator&policy=error");
  const notice = dialog.locator(".session-options-body .notice.t-danger.compact");
  await expect(notice).toContainText("Couldn't load your Orchestrator defaults.");
  await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(dialog).not.toContainText("Failed to fetch");
  await expect(dialog).not.toContainText("protocol-v");
  await expect(dialog.getByRole("button", { name: "Customize…" })).toHaveCount(0);
});
