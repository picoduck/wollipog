import { expect, test, type Page } from "@playwright/test";

/**
 * A workflow run's page (#2977; docs/design-system.md §2.10, §3.1, §4.3, §15.1, §15.2), measured in a
 * real browser: a 400px side column of steps and the selected step's panel flush with the page's
 * left edge beside the agent step's activity, 340px in the compact tier, and Steps and <Role>
 * Activity tabs on a phone, where the panel's buttons are 44px. A panel button is never wider than
 * its label and padding.
 */

async function open(page: Page, state: "gate" | "ready" | "retry" | "one") {
  await page.goto(`/run-workflow-e2e.html?state=${state}`);
  await expect(page.getByRole("heading", { level: 1, name: "Add backoff to webhook retries" })).toBeVisible();
  await expect(page.locator(".wf-panel")).toBeVisible();
}

/** Each step-panel button's box beside the box its label and padding need. */
function panelButtons(page: Page) {
  return page.locator(".wf-panel .notice-actions .btn").evaluateAll((buttons) => buttons.map((button) => {
    const style = getComputedStyle(button);
    const range = document.createRange();
    range.selectNodeContents(button);
    const rect = button.getBoundingClientRect();
    const px = (value: string) => Number.parseFloat(value) || 0;
    return {
      name: button.textContent ?? "",
      width: rect.width,
      height: rect.height,
      fit: range.getBoundingClientRect().width + px(style.paddingLeft) + px(style.paddingRight)
        + px(style.borderLeftWidth) + px(style.borderRightWidth),
    };
  }));
}

/** The side column and the activity column, against the run page and the viewport. */
function layout(page: Page) {
  return page.locator(".wf-run").evaluate((row) => {
    const side = row.querySelector<HTMLElement>(":scope > .wf-side")!.getBoundingClientRect();
    const main = row.querySelector<HTMLElement>(":scope > .wf-main")!.getBoundingClientRect();
    const page = row.closest<HTMLElement>(".run-detail")!.getBoundingClientRect();
    return {
      children: row.children.length,
      sideLeft: side.left - page.left,
      sideWidth: side.width,
      mainLeft: main.left - side.right,
      mainRight: page.right - main.right,
      mainBottom: main.bottom,
    };
  });
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a waiting gate: a 400px side column from the page's edge beside the builder's activity, and Reject confirms", async ({ page }) => {
    await open(page, "gate");
    const geometry = await layout(page);
    expect(geometry.children).toBe(2);
    expect(geometry.sideLeft, "no inset box: the side column starts at the page's left edge").toBe(0);
    expect(geometry.sideWidth).toBe(400);
    expect(geometry.mainLeft).toBe(0);
    expect(geometry.mainRight).toBe(0);
    expect(geometry.mainBottom, "the activity fills the page's height").toBeGreaterThanOrEqual(899);
    await expect(page.locator(".wf-step-button[aria-current='true'] .wf-step-role")).toHaveText("Step 2: Approver");
    await expect(page.locator(".wf-main .compare-member-agent")).toHaveText("Claude Code");
    await expect(page.locator(".wf-panel .notice")).toContainText("webhook-backoff.patch");
    for (const button of await panelButtons(page)) {
      expect(button.width, `${button.name} is sized by its label`).toBeLessThanOrEqual(button.fit + 1);
    }
    await page.getByRole("button", { name: "Reject…" }).click();
    const dialog = page.getByRole("dialog", { name: "Reject Patch" });
    await expect(dialog).toContainText("The run ends here and later steps don't start. This can't be undone.");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Reject" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("body")).toHaveAttribute("data-resolved", "approve:failure");
  });

  test("a ready step: Start Builder is control-sized, never stretched", async ({ page }) => {
    await open(page, "ready");
    const [start] = await panelButtons(page);
    expect(start?.name).toBe("Start Builder");
    expect(start!.width).toBeLessThanOrEqual(start!.fit + 1);
    expect(start!.height).toBe(28);
    await page.getByRole("button", { name: "Start Builder" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-dispatched", "build");
  });

  test("a delayed retry: Retry Builder is disabled with when it opens beside it", async ({ page }) => {
    await open(page, "retry");
    const retry = page.getByRole("button", { name: "Retry Builder" });
    await expect(retry).toBeDisabled();
    await expect(page.locator(".wf-panel-reason")).toHaveText(/^Available at \d{1,2}:\d{2}\s?[AP]M, in 4 minutes$/u);
    await expect(page.getByText(/just now/u)).toHaveCount(0);
  });

  test("a one-member workflow: the steps on the left and that member's transcript filling the right", async ({ page }) => {
    await open(page, "one");
    const geometry = await layout(page);
    expect(geometry.children).toBe(2);
    expect(geometry.mainRight).toBe(0);
    expect(geometry.mainBottom).toBeGreaterThanOrEqual(899);
    await expect(page.locator(".compare")).toHaveCount(0);
    await expect(page.locator(".compare-member")).toHaveCount(1);
  });
});

test.describe("at 834×1112, the compact tier", () => {
  test.use({ viewport: { width: 834, height: 1112 } });

  test("the side column is 340px", async ({ page }) => {
    await open(page, "gate");
    const geometry = await layout(page);
    expect(geometry.sideLeft).toBe(0);
    expect(geometry.sideWidth).toBe(340);
    expect(geometry.mainRight).toBe(0);
  });
});

test.describe("at 390×844, a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Steps and one <Role> Activity tab per agent step; the panel's buttons are 44px", async ({ page }) => {
    await open(page, "gate");
    await expect(page.getByRole("tab")).toHaveText(["Steps", "Builder Activity", "Reviewer Activity"]);
    await expect(page.getByRole("tab", { name: "Steps" })).toHaveAttribute("aria-selected", "true");
    const buttons = await panelButtons(page);
    expect(buttons.map((button) => button.name)).toEqual(["Continue", "Reject…"]);
    for (const button of buttons) {
      expect(button.height, `${button.name} is 44px`).toBe(44);
      expect(button.width).toBeLessThanOrEqual(button.fit + 1);
    }
    await page.getByRole("tab", { name: "Builder Activity" }).click();
    await expect(page.getByRole("tabpanel").locator(".compare-member-agent")).toHaveText("Claude Code");
    await expect(page.locator(".wf-panel")).toHaveCount(0);
  });
});
