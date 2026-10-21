import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * An automation's Run History and Run Details (#2970), in a real browser: the table at desktop
 * width, two-line rows with a 44px ⋯ on a touch phone, the dialog as a bottom sheet, and the states
 * its UI evidence names at 1440px and 390px in both themes. `AutomationDetail.dom.test.tsx` covers
 * the words and the logic against a fake DOM. With `WOLLIPOG_EVIDENCE_DIR` set, each state is also
 * captured as UI evidence.
 */

/** `/automations/~<id>`: the id as UTF-16LE base64url, as `encodeResourceId` writes it. */
const ROUTE = encodeURIComponent(`/automations/~${Buffer.from("automation-nightly-sweep", "utf16le").toString("base64url")}`);

async function open(page: Page, theme: string, scenario = "run-history") {
  await page.goto(`/automations-e2e.html?theme=${theme}&route=${ROUTE}&${scenario}`);
  await expect(page.locator(".automation-detail .glance")).toBeVisible();
}

const history = (page: Page) => page.locator('section[aria-labelledby="automation-history"]');
const runRow = (page: Page, executionId: string) => page.locator(`table.automation-runs tr[data-execution-id="${executionId}"]`);
const runMenu = (page: Page, executionId: string) => runRow(page, executionId).locator('.actions-cell button[aria-haspopup="menu"]');

async function openRunDetails(page: Page, executionId: string): Promise<Locator> {
  await runMenu(page, executionId).click();
  await page.getByRole("menuitem", { name: "Run Details…" }).click();
  const dialog = page.locator('[role="dialog"].automation-run-details');
  await expect(dialog).toBeVisible();
  await dialogMotionSettled(page);
  return dialog;
}

async function capture(page: Page, name: string, fullPage = false) {
  const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
  if (!evidenceDir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const theme of ["light", "dark"]) {
    test(`governance pause receipt at ${viewport.width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      // Both states are synthetic receipts: the legacy runner's original generic cancellation,
      // and the same execution with authenticated structured ceiling evidence.
      await open(page, theme, "ceiling-run&before-ceiling");
      await expect(runRow(page, "axe_ceiling")).toContainText("Failed");
      const before = await openRunDetails(page, "axe_ceiling");
      await expect(before.locator(".notice.t-danger")).toContainText("provider cancelled");
      await capture(page, `316-before-${viewport.width}-${theme}`);
      await open(page, theme, "ceiling-run");
      await expect(runRow(page, "axe_ceiling").locator(".status.t-warning")).toHaveText("Ceiling Paused");
      // A bound sentence must never become a narrow wrapping column in the phone's metadata.
      await expect(runRow(page, "axe_ceiling").locator(".automation-run-reason")).toHaveCount(0);
      await expect(page.locator(".automation-detail")).toContainText("$6.00 per run");
      await expect(page.locator(".automation-detail")).toContainText("100 tool calls per run");
      await capture(page, `316-after-history-${viewport.width}-${theme}`, true);
      const dialog = await openRunDetails(page, "axe_ceiling");
      await expect(dialog.locator(".notice.t-warning")).toContainText("Paused at the $6.00 cost ceiling. Partial or complete output may be available.");
      await expect(dialog.locator(".notice.t-danger")).toHaveCount(0);
      await expect(dialog.locator(".notice.t-warning")).toContainText("Open the session to inspect it.");
      await expect(dialog.locator(".facts > div").filter({ has: page.locator("dt", { hasText: /^Result$/ }) }).locator("dd")).toHaveText("Ceiling Paused");
      await expect(dialog.getByRole("button", { name: "Open Session" })).toBeVisible();
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      expect(fits).toBe(true);
      await capture(page, `316-after-details-${viewport.width}-${theme}`);
      await open(page, theme, "ceiling-run&tool-ceiling");
      const tool = await openRunDetails(page, "axe_ceiling");
      await expect(tool.locator(".notice.t-warning")).toContainText("Paused at the 100 tool-call ceiling.");
      if (viewport.width === 1440 && theme === "light") await capture(page, "316-after-tool-ceiling");
    });
  }
}

/** The box a pointer can hit: the element plus any absolutely positioned ::after that extends it. */
async function hitArea(control: Locator) {
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const after = getComputedStyle(element, "::after");
    const extended = after.content !== "none" && after.position === "absolute";
    const inset = (side: string) => extended ? Math.min(0, Number.parseFloat(after.getPropertyValue(side)) || 0) : 0;
    return {
      width: rect.width - inset("left") - inset("right"),
      height: rect.height - inset("top") - inset("bottom"),
    };
  });
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Run History is a table of runs in words, ten at first, and Run Details keeps the run key under Show Technical Details", async ({ page }) => {
    await open(page, "dark");
    const table = history(page).locator(".table-wrap > table.table.automation-runs");
    await expect(table.locator("thead th")).toHaveText(["Started", "Result", "Started By", "Took", "Actions"]);
    await expect(table.locator("thead")).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(10);
    await expect(runRow(page, "axe_signed").locator("td").nth(1)).toHaveText("Signed Trigger");
    await expect(runRow(page, "axe_workflow").getByRole("button", { name: "Open Run" })).toBeVisible();
    // Desktop rows are one line; the reason waits for Run Details or the phone's second line.
    await expect(runRow(page, "axe_skipped").locator(".automation-run-reason")).toBeHidden();
    const tbody = await table.locator("tbody").innerText();
    expect(tbody).not.toMatch(/\d:\d\d:\d\d|schedule:|Digest|axe_|cmd_/);
    await history(page).getByRole("button", { name: "Show 5 More" }).click();
    await expect(table.locator("tbody tr")).toHaveCount(15);

    // A skip is stamped legacy by the control plane but was never sent: no steps, no delivery line.
    const skipped = await openRunDetails(page, "axe_skipped");
    await expect(skipped.locator(".automation-run-steps-section")).toHaveCount(0);
    await expect(skipped).not.toContainText("Sent once");
    await skipped.getByRole("button", { name: "Done" }).click();
    await expect(skipped).toHaveCount(0);
    // The legacy run that was delivered still says so.
    const legacy = await openRunDetails(page, "axe_legacy");
    await expect(legacy.locator(".automation-run-legacy")).toHaveText("Sent once, without delivery receipts.");
    await legacy.getByRole("button", { name: "Done" }).click();

    const dialog = await openRunDetails(page, "axe_failed");
    await expect(dialog.locator(".notice.t-danger .notice-body")).toHaveText("The agent exited before it finished the report.");
    await expect(dialog.locator(".automation-run-steps > li")).toHaveCount(3);
    const technical = dialog.locator("details.disclosure");
    await expect(technical.locator(".code-well")).toBeHidden();
    await technical.locator("summary").click();
    const well = technical.locator(".code-well.one-line");
    await expect(well).toBeVisible();
    // The single-line well: one line that would end in an ellipsis rather than wrap.
    const fits = await well.locator("code").evaluate((code) => ({
      oneLine: code.getBoundingClientRect().height < 2 * Number.parseFloat(getComputedStyle(code).lineHeight),
      whiteSpace: getComputedStyle(code).whiteSpace,
      textOverflow: getComputedStyle(code).textOverflow,
    }));
    expect(fits).toEqual({ oneLine: true, whiteSpace: "nowrap", textOverflow: "ellipsis" });
    await expect(well.locator("code")).toHaveText(/^schedule:automation-nightly-sweep:\d{4}-\d\d-\d\dT/);
    await expect(well.getByRole("button", { name: "Copy Run Key" })).toBeVisible();
    await expect(dialog.locator(".modal-foot button")).toHaveText(["Open Session", "Done"]);
  });
});

test.describe("at 390×844 on a touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("each run is two lines with ⋯ at 44px, a skip keeps its reason, and Run Details is a bottom sheet", async ({ page }) => {
    await open(page, "dark");
    const table = history(page).locator("table.automation-runs");
    const header = await table.locator("thead").evaluate((element) => element.getBoundingClientRect().height);
    expect(header, "the header row is off screen").toBeLessThanOrEqual(1);
    const lines = await table.locator("tbody tr").evaluateAll((rows) => rows.map((tr) => {
      const started = tr.children[0]!.getBoundingClientRect();
      const result = tr.children[1]!.getBoundingClientRect();
      const startedBy = tr.children[2]!.getBoundingClientRect();
      return {
        resultOnLine1: Math.abs(result.top - started.top) < 4,
        metaBelow: startedBy.top > started.bottom - 1,
      };
    }));
    for (const line of lines) expect(line).toEqual({ resultOnLine1: true, metaBelow: true });
    await expect(runRow(page, "axe_scheduled")).toContainText(/Schedule\s*Took 4m 2s/);
    await expect(runRow(page, "axe_skipped").locator(".automation-run-reason")).toBeVisible();
    await expect(runRow(page, "axe_skipped").locator(".automation-run-reason")).toHaveText("Skipped because the last run was still going.");
    for (const executionId of ["axe_signed", "axe_skipped", "axe_failed"]) {
      const box = await hitArea(runMenu(page, executionId));
      expect(box.width, `${executionId} ⋯ width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${executionId} ⋯ height`).toBeGreaterThanOrEqual(44);
    }

    const sheet = await openRunDetails(page, "axe_failed");
    const box = await sheet.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, width: rect.width, bottom: Math.round(rect.bottom) };
    });
    expect(box).toEqual({ left: 0, width: 390, bottom: 844 });
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});

for (const { label, viewport } of [
  { label: "1440", viewport: { width: 1440, height: 900 } },
  { label: "390", viewport: { width: 390, height: 844 } },
]) for (const theme of ["dark", "light"] as const) {
  test.describe(`${label} ${theme} states`, () => {
    test.use({ viewport });

    test("Run History", async ({ page }) => {
      await open(page, theme);
      await expect(history(page).locator("tbody tr")).toHaveCount(10);
      await history(page).scrollIntoViewIfNeeded();
      await capture(page, `run-history-${label}-${theme}`, true);
    });

    test("Empty", async ({ page }) => {
      await open(page, theme, "no-runs");
      await expect(history(page).locator(".automation-empty")).toHaveText(/^No runs yet\. The first run is Tomorrow, 2:00 [AP]M\.$/);
      await expect(history(page).locator("table")).toHaveCount(0);
      await capture(page, `run-history-empty-${label}-${theme}`, true);
    });

    test("Run Details for a Failed Run", async ({ page }) => {
      await open(page, theme);
      const dialog = await openRunDetails(page, "axe_failed");
      await dialog.locator("details.disclosure > summary").click();
      await expect(dialog.locator(".code-well.one-line")).toBeVisible();
      await capture(page, `run-details-failed-${label}-${theme}`);
    });
  });
}
