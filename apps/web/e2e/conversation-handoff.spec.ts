import { expect, test, type Locator } from "@playwright/test";
import { pinWidestFace } from "./font-geometry";
import { expectGeometry } from "./geometry-margins";

// Insets are measured to the text column: the description's --space-6 gutters are its own inline
// padding (#2184), so its border box may span the row on a phone while its text stays inset.
const readDescriptionLayout = (description: Locator) => description.evaluate((element) => {
  const descriptionRect = element.getBoundingClientRect();
  const eventRect = element.parentElement!.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    textAlign: style.textAlign,
    overflowWrap: style.overflowWrap,
    leftInset: descriptionRect.left + Number.parseFloat(style.paddingLeft) - eventRect.left,
    rightInset: eventRect.right - descriptionRect.right + Number.parseFloat(style.paddingRight),
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  };
});

const readLongTokenLayout = (description: Locator) => description.evaluate((element) => {
  const originalText = element.textContent;
  element.textContent = "destination".repeat(40);
  const layout = { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  element.textContent = originalText;
  return layout;
});

for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`checkpoint handoff remains unsent and reviewable at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const url = "/command-inbox-projects-e2e.html?scenario=conversation-handoff";
    await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
    await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Expand Session" });
    if (await expand.isVisible()) await expand.click();
    // The turn's footer holds the turn's menu: Hand Off, Fork and its prompt's Rewind are all there.
    const more = page.locator(".tl-turn-footer").getByRole("button", { name: "More Turn Actions" });
    await expect(more).toHaveCount(1);
    await expect(more).toBeVisible();
    await more.click();
    const menu = page.getByRole("menu", { name: "More Turn Actions" });
    const action = menu.getByRole("menuitem", { name: "Hand Off After This Turn…" });
    await expect(action).toBeEnabled();
    await expect(menu.getByRole("menuitem", { name: "Fork After This Turn…" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Rewind Files to Before This Turn…" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("handoff-source.png") });
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(109));
    await more.click();
    await expect(action).toBeDisabled();
    await expect(action.locator(".menu-desc")).toContainText("Update the runner");
    await page.screenshot({ path: test.info().outputPath("handoff-unavailable.png") });
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(110));
    await more.click();
    await action.click();
    await expect(page.getByRole("dialog")).toContainText("Creating the handoff sends nothing");
    await page.getByRole("dialog").getByRole("button", { name: "Effort: Default", exact: true }).click();
    await page.getByRole("option", { name: "High", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Permissions: Default", exact: true }).click();
    await page.getByRole("option", { name: "Plan Only (Read-Only)", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("handoff-settings.png") });
    // #875: the source runs a tier this destination does not advertise. The dialog has to say so
    // and refuse, rather than quietly creating the handoff on the destination's default tier.
    await expect(page.getByRole("dialog")).toContainText("does not support this service tier");
    await expect(page.getByRole("button", { name: "Create Handoff", exact: true })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath("handoff-tier-unsupported.png") });
    await page.getByRole("dialog").getByRole("button", { name: "Service Tier: flex", exact: true }).click();
    await page.getByRole("option", { name: "Priority", exact: true }).click();
    await expect(page.getByRole("button", { name: "Create Handoff", exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("handoff-tier-chosen.png") });
    await page.getByRole("button", { name: "Create Handoff", exact: true }).click();
    await expect(page.locator(".composer-input")).toHaveValue(/Keep the interface accessible on mobile/);
    const handoff = page.getByRole("separator", { name: "Handoff from codex to claude After Turn 1" });
    await expect(handoff).toBeVisible();
    const handoffDescriptionId = await handoff.getAttribute("aria-describedby");
    expect(handoffDescriptionId).toBeTruthy();
    const description = page.locator(`[id="${handoffDescriptionId}"]`);
    await expect(description).toContainText("Fresh provider conversation");
    const descriptionLayout = await readDescriptionLayout(description);
    // #2184: the description shares the divider label's centred axis.
    expect(descriptionLayout.textAlign).toBe("center");
    expect(descriptionLayout.overflowWrap).toBe("anywhere");
    expectGeometry(
      Math.abs(descriptionLayout.leftInset - descriptionLayout.rightInset),
      "the disclosure column stays horizontally centered",
    ).toBeLessThanOrEqual(0.61);
    if (width === 1280) {
      expectGeometry(descriptionLayout.leftInset, "the 60ch cap leaves the desktop column well inside the row")
        .toBeGreaterThanOrEqual(100);
    } else {
      // Fixed by the two --space-6 gutters rather than rendered text geometry.
      expect(descriptionLayout.leftInset).toBeGreaterThanOrEqual(23);
    }
    expect(descriptionLayout.scrollWidth).toBeLessThanOrEqual(descriptionLayout.clientWidth);
    const longTokenLayout = await readLongTokenLayout(description);
    expect(longTokenLayout.scrollWidth).toBeLessThanOrEqual(longTokenLayout.clientWidth);
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([]);
    // The chosen tier is what actually crossed the boundary.
    const handoffs = await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.handoffRequests());
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.config.serviceTier).toBe("priority");
    await page.screenshot({ path: test.info().outputPath("handoff-draft.png") });
    if (width === 1280) {
      const wideFace = await pinWidestFace(page, description);
      const wideLayout = await readDescriptionLayout(description);
      expectGeometry(wideLayout.leftInset, `the 60ch cap stays inside the row with ${wideFace}`)
        .toBeGreaterThanOrEqual(100);
    }
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);
  });
}
