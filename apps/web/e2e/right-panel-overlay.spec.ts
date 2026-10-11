import { waitForSessionPreview } from "./session-readiness.js";
import { expect, test, type Page } from "@playwright/test";

/**
 * The right panel docks beside the chat column, or opens over it as a sheet from the right with a
 * scrim when docking would leave the chat column under 480px (docs/design-system.md §15.2; #2725).
 * Every mode answers the same way at the same width, in the real Shell with its rail.
 */
const CHAT_MIN = 480;

async function openSession(page: Page, width: number, labelled: boolean) {
  await page.setViewportSize({ width, height: 860 });
  await page.goto("/command-inbox-projects-e2e.html?scenario=git-visibility&reviewReady=1&fullShell=1");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  if (labelled) {
    await page.getByRole("navigation", { name: "Primary Navigation" })
      .getByRole("button", { name: "Expand Navigation", exact: true }).click();
    await expect(page.locator(".app-rail.labelled")).toBeVisible();
  }
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  await waitForSessionPreview(page);
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator("header.session-bar")).toBeVisible();
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width } : null;
    };
    return {
      columns: rect(".detail-columns")!,
      body: rect(".detail-body")!,
      panel: rect("#right-panel")!,
      bar: rect("header.session-bar")!,
      scrim: rect(".rpanel-scrim"),
      handle: rect(".rpanel-resizer"),
      presentation: (document.querySelector("#right-panel") as HTMLElement | null)?.dataset.presentation,
    };
  });
}

/** Checks one open mode's geometry and returns whether it overlays. */
async function expectPresentation(page: Page, label: string): Promise<boolean> {
  const at = await measure(page);
  // The resize handle straddles the panel's edge and takes no room (#2843).
  const overlays = at.columns.width - at.panel.width < CHAT_MIN;
  expect(at.presentation, label).toBe(overlays ? "overlay" : "docked");
  if (overlays) {
    // Over the transcript from the right edge of the session body, over a scrim on the chat column.
    expect(at.scrim, `${label}: scrim`).not.toBeNull();
    expect(at.handle, `${label}: no handle`).toBeNull();
    expect(Math.abs(at.panel.right - at.columns.right), `${label}: flush right`).toBeLessThanOrEqual(1);
    expect(at.body.width, `${label}: the chat keeps its width`).toBeCloseTo(at.columns.width, 0);
    expect(Math.abs(at.scrim!.left - at.columns.left), `${label}: scrim covers the chat`).toBeLessThanOrEqual(1);
    // The session bar stays outside the scrim.
    expect(at.scrim!.top, `${label}: scrim under the session bar`).toBeGreaterThanOrEqual(at.bar.bottom - 1);
  } else {
    expect(at.scrim, `${label}: no scrim`).toBeNull();
    expect(at.handle, `${label}: handle`).not.toBeNull();
    expect(at.body.right, `${label}: the chat ends before the panel`).toBeLessThanOrEqual(at.panel.left);
    expect(at.body.width, `${label}: the chat keeps 480px`).toBeGreaterThanOrEqual(CHAT_MIN);
  }
  return overlays;
}

const CASES = [
  // The 64px rail at 940px leaves the chat 490px beside a 386px panel (its drag ceiling, #2845);
  // with the 208px labelled rail even a 320px one leaves 412px. At 1099px both keep 480px beside the
  // 400px default.
  { width: 940, labelled: false, overlays: false },
  { width: 940, labelled: true, overlays: true },
  { width: 1099, labelled: false, overlays: false },
  { width: 1099, labelled: true, overlays: false },
  // #2843's widths: a 400px panel docks at 1100px; at 834px (an iPad) a 320px one leaves 450px.
  { width: 1100, labelled: false, overlays: false },
  { width: 834, labelled: false, overlays: true },
  // At the tier's narrowest width even the default rail leaves too little.
  { width: 800, labelled: false, overlays: true },
] as const;

for (const { width, labelled, overlays } of CASES) {
  test(`at ${width}px with the labelled rail ${labelled ? "on" : "off"}, every panel mode ${overlays ? "overlays the chat" : "docks beside the chat"} (#2725)`, async ({ page }) => {
    await openSession(page, width, labelled);
    await page.getByRole("button", { name: "Side Panel", exact: true }).click();
    await expect(page.locator(".session-tools")).toBeVisible();
    expect(await expectPresentation(page, "Session Tools")).toBe(overlays);
    // Every enabled row but Terminal, which opens the bottom dock rather than a panel mode.
    const rows = page.locator(".session-tools .session-tool:not([aria-disabled='true']):not([data-tool='terminal'])");
    const count = await rows.count();
    expect(count, "the launcher offers modes").toBeGreaterThan(3);
    for (let index = 0; index < count; index += 1) {
      const name = (await rows.nth(index).locator(".row-title").innerText()).trim();
      await rows.nth(index).click();
      await expect(page.locator(".session-tools")).toHaveCount(0);
      // Switching modes keeps the same presentation at the same width.
      expect(await expectPresentation(page, name), name).toBe(overlays);
      // Session Tools is the switcher's first item (#2843).
      await page.locator("#right-panel .rpanel-switcher").click();
      await page.getByRole("menuitemradio", { name: "Session Tools", exact: true }).click();
      await expect(page.locator(".session-tools")).toBeVisible();
    }
  });
}

test("a press on the scrim closes an overlaid panel and returns focus to the control that opened it (#2725)", async ({ page }) => {
  await openSession(page, 940, true);
  const toggle = page.getByRole("button", { name: "Side Panel", exact: true });
  await toggle.click();
  await expect(page.locator("#right-panel")).toHaveAttribute("data-presentation", "overlay");
  const scrim = (await page.locator(".rpanel-scrim").boundingBox())!;
  await page.mouse.click(scrim.x + 40, scrim.y + 200);
  await expect(page.locator("#right-panel")).toHaveCount(0);
  await expect(toggle).toBeFocused();
});

test("the stored panel width survives an overlay: docked again, the panel has the width it had (#2725)", async ({ page }) => {
  await openSession(page, 1099, false);
  await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  const docked = (await measure(page)).panel.width;
  await page.setViewportSize({ width: 800, height: 860 });
  await expect(page.locator("#right-panel")).toHaveAttribute("data-presentation", "overlay");
  await page.setViewportSize({ width: 1099, height: 860 });
  await expect(page.locator("#right-panel")).toHaveAttribute("data-presentation", "docked");
  expect((await measure(page)).panel.width).toBe(docked);
});

test("a phone keeps its full-screen panel, with no scrim (#2725)", async ({ page }) => {
  await openSession(page, 390, false);
  await page.getByRole("button", { name: "Side Panel", exact: true }).click();
  const at = await measure(page);
  expect(at.presentation).toBe("docked");
  expect(at.scrim).toBeNull();
  expect(at.panel.left).toBe(0);
  expect(at.panel.width).toBe(390);
});
