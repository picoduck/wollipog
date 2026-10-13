import { expect, test, type Page } from "@playwright/test";
import { pinWidestFace } from "./font-geometry";
import { expectTextFits } from "./text-fit";

test.use({ reducedMotion: "reduce" });

/**
 * Each pill of a two-option row in the shared value column: Answer Questions In (Settings ›
 * Approvals, #2158) and Enter Key (Behavior).
 */
async function expectPillsFit(page: Page, group: string, labels: string[], where: string) {
  const radios = page.getByRole("radiogroup", { name: group });
  await expect(radios.getByRole("radio")).toHaveCount(labels.length);
  for (const label of labels) {
    await expectTextFits(radios.getByRole("radio", { name: label, exact: true }), `the ${label} pill ${where}`);
  }
  await expectTextFits(radios, `the ${group} group ${where}`);
}

// #2506: as two equal pills in the shared 220px value column, "Composer Response" ran past its pill.
// The row moved to Approvals as Answer Questions In with the short labels Form and Composer, which
// fit as pills again. The margin depends on text advance width, so each width is measured again in
// the widest verified face.
for (const theme of ["dark", "light"]) {
  for (const width of [1440, 1100, 900, 390]) {
    test(`every Answer Questions In and Enter Key option fits its own box at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const [section, heading, group, labels] of [
        ["approvals", "Approvals", "Answer Questions In", ["Form", "Composer"]],
        ["behavior", "Behavior", "Enter Key", ["Send Message", "New Line"]],
      ] as const) {
        await page.goto(`/settings-rows-e2e.html?theme=${theme}&section=${section}`);
        await expect(page.locator("#settings-panel-heading")).toHaveText(heading);
        await expectPillsFit(page, group, [...labels], `at ${width}px in ${theme}`);
        const face = await pinWidestFace(page, page.locator("body"));
        await expectPillsFit(page, group, [...labels], `at ${width}px in ${theme} with ${face}`);
      }
    });
  }
}

test("Behavior no longer carries the question settings that moved to Approvals", async ({ page }) => {
  await page.goto("/settings-rows-e2e.html?theme=dark&section=behavior");
  await expect(page.locator("#settings-panel-heading")).toHaveText("Behavior");
  await expect(page.locator(".settings-panel")).not.toContainText(/Question Response Style|Routine Question/);
});

/** Each option's label is one line of text: a wrapped label has line boxes at two heights. */
async function expectOneLine(page: Page, group: string) {
  const lines = await page.getByRole("radiogroup", { name: group }).getByRole("radio").evaluateAll((radios) => radios.map((radio) => {
    const range = document.createRange();
    range.selectNodeContents(radio);
    return [radio.textContent?.trim(), new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size];
  }));
  for (const [label, count] of lines) expect(count, `"${label}" is on one line`).toBe(1);
}

for (const width of [1440, 390]) {
  test(`Behavior is six groups with their scopes, and Enter Key's labels are one line each at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings-rows-e2e.html?theme=dark&section=behavior");
    await expect(page.getByText("Upload only when the task or project asks for it.", { exact: true })).toBeVisible();
    const heads = await page.locator(".settings-panel .settings-group-head").evaluateAll((elements) => elements.map((head) => [
      head.querySelector(".settings-group-title")?.textContent, head.querySelector(".settings-group-scope")?.textContent,
    ]));
    expect(heads).toEqual([
      ["Input", "This Device"], ["Transcript", "This Device"], ["Privacy", "This Device"],
      ["Agent Defaults", "Your Account"], ["Session Titles", "Your Account"], ["Evidence", "Your Account"],
    ]);
    await expect(page.locator(".settings-panel")).not.toContainText(/Stored on this device|not built yet|Reduce Motion/);
    await expect(page.getByRole("radiogroup", { name: "Enter Key" }).getByRole("radio")).toHaveText(["Send Message", "New Line"]);
    await expectOneLine(page, "Enter Key");
  });
}

test("a failed Artifact Uploads save is a danger notice above the group's surface with Retry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings-rows-e2e.html?theme=dark&section=behavior&artifact=save-fails");
  const picker = page.getByRole("button", { name: "Artifact Uploads: Manual" });
  await expect(picker).toBeEnabled();
  await picker.click();
  await page.getByRole("option", { name: /^Use External Hosting/ }).click();
  const notice = page.getByRole("alert");
  await expect(notice).toHaveText(/^Couldn't reach Wollipog\. Check the connection, then try again\./);
  await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(picker).toHaveAccessibleName("Artifact Uploads: Manual");
  const [noticeBox, surfaceBox] = await Promise.all([
    notice.boundingBox(),
    page.locator(".settings-group", { has: notice }).locator(".settings-group-surface").boundingBox(),
  ]);
  expect(noticeBox!.y + noticeBox!.height, "the notice sits above the surface").toBeLessThanOrEqual(surfaceBox!.y);
});

/** The real shell (#3023), with history, so a redirect's entry and Back are the browser's own. */
const shell = (path: string) => `/command-inbox-projects-e2e.html?fullShell=1&history=1&path=${encodeURIComponent(path)}`;
const routedPath = (page: Page) => new URL(page.url()).searchParams.get("path");

test.describe("with a mouse at 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Show Shortcuts opens the reference, and Escape returns focus to it", async ({ page }) => {
    await page.goto(shell("/settings/behavior"));
    const show = page.getByRole("button", { name: "Show Shortcuts Keyboard Shortcuts" });
    await expect(show).toBeVisible();
    await expect(show).toHaveAccessibleDescription("Press ? anywhere to see them.");
    await show.click();
    const reference = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
    await expect(reference).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reference).toBeHidden();
    await expect(show).toBeFocused();
  });

  test("/settings/keyboard lands on Behavior with Show Shortcuts focused, and Back does not return to it", async ({ page }) => {
    await page.goto(shell("/settings"));
    await page.goto(shell("/settings/keyboard"));
    await expect(page.locator("#settings-panel-heading")).toHaveText("Behavior");
    expect(routedPath(page), "the redirect replaced its own entry").toBe("/settings/behavior");
    await expect(page.getByRole("button", { name: "Show Shortcuts Keyboard Shortcuts" })).toBeFocused();
    const sections = page.getByRole("navigation", { name: "Settings Sections" });
    await expect(sections.getByRole("link")).toHaveText(
      ["Appearance", "Notifications", "Behavior", "Approvals", "Orchestrator", "Network", "Experimental", "About"]);
    await sections.getByRole("link", { name: "Appearance" }).click();
    expect(routedPath(page)).toBe("/settings/appearance");
    await page.goBack();
    await expect(page.locator("#settings-panel-heading")).toHaveText("Behavior");
    expect(routedPath(page)).toBe("/settings/behavior");
    await page.goBack();
    expect(routedPath(page), "the entry before the redirect, not /settings/keyboard").toBe("/settings");
  });

  test("the palette has no Keyboard section and offers Keyboard Shortcuts, which opens the reference", async ({ page }) => {
    await page.goto(shell("/skills"));
    await expect(page.locator("#page-title")).toBeVisible();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Search" });
    await palette.getByRole("combobox").fill("keyboard");
    await expect(palette.getByRole("option")).toHaveText([/^Keyboard Shortcuts/]);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeVisible();
    await expect(palette).toBeHidden();
  });
});

test.describe("on a 390px phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the Keyboard Shortcuts row is absent, the index has no Keyboard entry, and the redirect focuses Input", async ({ page }) => {
    await page.goto(shell("/settings"));
    const index = page.getByRole("navigation", { name: "Settings Sections" });
    await expect(index.getByRole("link").first()).toBeVisible();
    await expect(index.getByRole("link", { name: /^Keyboard/ })).toHaveCount(0);
    await page.goto(shell("/settings/keyboard"));
    expect(routedPath(page)).toBe("/settings/behavior");
    await expect(page.getByRole("radiogroup", { name: "Enter Key" })).toBeVisible();
    await expect(page.getByText("Keyboard Shortcuts", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Input" })).toBeFocused();
  });
});

test.describe("on a touch-only tablet at 1024px", () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  test("the Keyboard Shortcuts row is absent", async ({ page }) => {
    await page.goto(shell("/settings/behavior"));
    expect(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches),
      "this runs where the touch-only query applies").toBe(true);
    expect(await page.evaluate(() => matchMedia("(max-width: 760px)").matches), "and not at phone width").toBe(false);
    await expect(page.getByRole("radiogroup", { name: "Enter Key" })).toBeVisible();
    await expect(page.getByText("Keyboard Shortcuts", { exact: true })).toHaveCount(0);
  });
});
