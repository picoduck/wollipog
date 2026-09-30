import { expect, test, type Page } from "@playwright/test";

// The skill review diff (#1948), driven through the real Import Edit as New Version dialog.
const digest = "4f1c".padEnd(64, "0");
const observedDigest = "9b2e".padEnd(64, "0");
const lines = (count: number, changedAt?: number) => Array.from({ length: count }, (_, index) =>
  index + 1 === changedAt ? `Step ${index + 1}: check the tests before approving.` : `Step ${index + 1}: review the diff.`);
const library = `---\nname: code-review\n---\n${lines(197).join("\n")}\n`;
const edited = `---\nname: code-review\n---\n${lines(197, 97).join("\n")}\n`;
const drifted = {
  removalReporting: "supported",
  driftReporting: "supported",
  desired: [{ name: "code-review", versionDigest: digest, targets: [{ agentId: "claude", invocation: "agent" }] }],
  reported: {
    deployed: [{ name: "code-review", digest, links: [{ agentId: "claude", status: "conflict", detail: "Edited." }] }],
    unmanaged: [],
    drift: [{ name: "code-review", digest, variant: "agent", observedDigest, held: true, detail: "Held." }],
    updatedAt: 1_700_000_000_000,
  },
};

async function openReview(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/api/runners/runner-1/skills", (route) => route.fulfill({ json: drifted }));
  await page.route("**/api/runners/runner-1/skill-drift/preview", (route) => route.fulfill({ json: {
    previewId: "review-1",
    drift: { name: "code-review", digest, variant: "agent", observedDigest },
    files: [
      { path: "SKILL.md", content: edited, encoding: "utf8" },
      { path: "scripts/check.sh", content: "#!/bin/sh\nset -eu\nnpm test\n", encoding: "utf8" },
    ],
    previousFiles: [
      { path: "SKILL.md", content: library, encoding: "utf8" },
      { path: "scripts/check.sh", content: "#!/bin/sh\nnpm test\n", encoding: "utf8" },
    ],
    digest: observedDigest, importable: true, disposition: "update", publishedFromLatest: true, pinned: false, assignmentCount: 2,
  } }));
  await page.route("**/api/skill-drift/review-1", (route) => route.fulfill({ status: 204, body: "" }));
  await page.goto("/skills-removals-e2e.html?drift=1");
  await page.getByRole("button", { name: /code-review/i }).click();
  await page.locator(".skills-machine").getByRole("button", { name: "Import Edit as New Version" }).click();
  const dialog = page.getByRole("dialog", { name: "Import Edit as New Version" });
  await expect(dialog.locator(".skill-diff-file")).toHaveCount(2);
  return dialog;
}

test("a one-line change in a 200-line SKILL.md is one hunk with three context lines each side", async ({ page }) => {
  const dialog = await openReview(page, 1280);
  const file = dialog.locator(".skill-diff-file", { hasText: "SKILL.md" });
  await expect(file.locator(".skill-diff-hunk")).toHaveCount(1);
  await expect(file.locator(".diff-hunk-header")).toHaveText("@@ -97,7 +97,7 @@");
  const rows = file.locator(".diff-line");
  await expect(rows).toHaveCount(8);
  await expect(file.locator(".diff-line-ctx")).toHaveCount(6);
  await expect(file.locator(".diff-line-del .diff-gutter-old")).toHaveText("100");
  await expect(file.locator(".diff-line-del .diff-gutter >> nth=1")).toHaveText("");
  await expect(file.locator(".diff-line-add .diff-gutter-old")).toHaveText("");
  await expect(file.locator(".diff-line-add .diff-gutter >> nth=1")).toHaveText("100");
  await expect(file.locator(".skill-diff-counts")).toContainText("+1 −1");
  // Tinted: the added and removed rows carry the diff washes, context rows none.
  const background = (selector: string) => file.locator(selector).first().evaluate((row) => getComputedStyle(row).backgroundColor);
  expect(await background(".diff-line-add")).not.toBe("rgba(0, 0, 0, 0)");
  expect(await background(".diff-line-del")).not.toBe("rgba(0, 0, 0, 0)");
  expect(await background(".diff-line-ctx")).toBe("rgba(0, 0, 0, 0)");
  // The change is not conveyed by colour alone: each changed line is named for assistive technology.
  const snapshot = await file.locator(".skill-diff-lines").ariaSnapshot();
  expect(snapshot).toContain("Removed line 100");
  expect(snapshot).toContain("Added line 100");
  // The script's header flags it and counts its change.
  const script = dialog.locator(".skill-diff-file", { hasText: "scripts/check.sh" });
  await expect(script.locator(".skill-diff-file-head .status")).toHaveText(["Script", "Changed"]);
  await expect(script.locator(".skill-diff-counts")).toContainText("+1 −0");
  await expect(script.locator(".skill-diff-file-head")).toHaveAccessibleName(/scripts\/check\.sh.*1 added line, 0 removed lines/);
});

test("Split is offered on a full-width review dialog and shows old and new side by side", async ({ page }) => {
  const dialog = await openReview(page, 1440);
  expect(await dialog.evaluate((panel) => (panel.closest(".modal") as HTMLElement).offsetWidth)).toBeGreaterThanOrEqual(800);
  const layout = dialog.getByRole("radiogroup", { name: "Diff Layout" });
  await expect(layout.getByRole("radio")).toHaveText(["Unified", "Split"]);
  await expect(layout.getByRole("radio", { name: "Unified" })).toHaveAttribute("aria-checked", "true");
  await layout.getByRole("radio", { name: "Split" }).click();
  const file = dialog.locator(".skill-diff-file", { hasText: "SKILL.md" });
  const changed = file.locator(".diff-split-row", { has: page.locator(".diff-line-del") });
  await expect(changed).toHaveCount(1);
  await expect(changed.locator(".diff-split-cell").nth(0)).toContainText("Step 97: review the diff.");
  await expect(changed.locator(".diff-split-cell").nth(1)).toContainText("Step 97: check the tests before approving.");
  const [left, right] = await changed.locator(".diff-split-cell").evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect()));
  expect(right!.left).toBeGreaterThanOrEqual(left!.right - 1);
  expect(Math.abs(right!.top - left!.top)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

for (const width of [820, 390]) {
  test(`below an 800px dialog only Unified is offered at ${width}`, async ({ page }) => {
    const dialog = await openReview(page, width);
    expect(await dialog.evaluate((panel) => (panel.closest(".modal") as HTMLElement).offsetWidth)).toBeLessThan(800);
    await expect(dialog.getByRole("radiogroup", { name: "Diff Layout" })).toHaveCount(0);
    await expect(dialog.locator(".diff-split-row")).toHaveCount(0);
    await expect(dialog.locator(".skill-diff-file", { hasText: "SKILL.md" }).locator(".diff-line")).toHaveCount(8);
  });
}

test("a Split choice falls back to Unified when the dialog narrows", async ({ page }) => {
  const dialog = await openReview(page, 1440);
  await dialog.getByRole("radio", { name: "Split" }).click();
  await expect(dialog.locator(".diff-split-row").first()).toBeVisible();
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(dialog.getByRole("radiogroup", { name: "Diff Layout" })).toHaveCount(0);
  await expect(dialog.locator(".diff-split-row")).toHaveCount(0);
});

test("the consent sits in the footer beside the disabled primary and unlocks it", async ({ page }) => {
  const dialog = await openReview(page, 1440);
  const footer = dialog.locator(".modal-foot");
  const consent = footer.getByRole("checkbox", { name: "Deploy to 2 existing assignments", exact: true });
  const primary = footer.getByRole("button", { name: "Import Edit as New Version" });
  await expect(primary).toBeDisabled();
  const consentBox = await footer.locator(".review-consent").boundingBox();
  const primaryBox = await primary.boundingBox();
  expect(Math.abs((consentBox!.y + consentBox!.height / 2) - (primaryBox!.y + primaryBox!.height / 2))).toBeLessThanOrEqual(4);
  await consent.check();
  await expect(primary).toBeEnabled();
  await consent.uncheck();
  await expect(primary).toBeDisabled();
});

test("on a phone sheet the consent is a full-width row above the two footer buttons", async ({ page }) => {
  const dialog = await openReview(page, 390);
  const footer = dialog.locator(".modal-foot");
  const [consent, cancel, primary] = await Promise.all([
    footer.locator(".review-consent").boundingBox(),
    footer.getByRole("button", { name: "Cancel" }).boundingBox(),
    footer.getByRole("button", { name: "Import Edit as New Version" }).boundingBox(),
  ]);
  expect(consent!.y + consent!.height).toBeLessThanOrEqual(cancel!.y + 1);
  expect(Math.abs(cancel!.y - primary!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(cancel!.width - primary!.width)).toBeLessThanOrEqual(1);
});

test("in forced colours each changed line keeps a visible edge and its sign", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  const dialog = await openReview(page, 1280);
  const file = dialog.locator(".skill-diff-file", { hasText: "SKILL.md" });
  const edge = (selector: string) => file.locator(selector).first().evaluate((row) => {
    const style = getComputedStyle(row);
    return { width: style.borderInlineStartWidth, style: style.borderInlineStartStyle };
  });
  expect(await edge(".diff-line-add")).toEqual({ width: "4px", style: "solid" });
  expect(await edge(".diff-line-del")).toEqual({ width: "4px", style: "dashed" });
  await expect(file.locator(".diff-line-add .diff-sign")).toHaveText("+");
  await expect(file.locator(".diff-line-del .diff-sign")).toHaveText("−");
});
