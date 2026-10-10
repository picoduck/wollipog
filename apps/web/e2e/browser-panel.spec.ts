import { expect, test, type Page } from "@playwright/test";

/**
 * The Browser tool (#2854; docs/design-system.md §10.1, §5.2, §4.7, §8.5, §12): Artifacts and Web
 * Preview as tabs, two-line artifact rows, an address row that stays one line, and a page that
 * loads, reloads or turns out to be blocked.
 */
const PAGE = "http://preview.test/dashboard";
const BLOCKED = "http://blocked.test/refuses-framing";

async function openBrowser(page: Page, width: number, query = "") {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/browser-panel-e2e.html${query}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("tablist", { name: "Browser" })).toBeVisible();
}

const tab = (page: Page, name: string) => page.getByRole("tablist", { name: "Browser" }).getByRole("tab", { name });
const address = (page: Page) => page.locator(".browser-address");

async function openWebPreview(page: Page) {
  await tab(page, "Web Preview").click();
  await expect(tab(page, "Web Preview")).toHaveAttribute("aria-selected", "true");
}

/** Every visible control in the address row sits on one line: one vertical centre, inside the row. */
async function addressRowIsOneLine(page: Page) {
  const boxes = await address(page).evaluate((form) => [...form.children]
    .filter((child) => child.getClientRects().length > 0 && getComputedStyle(child).position !== "absolute")
    .map((child) => {
      const box = child.getBoundingClientRect();
      return { name: child.getAttribute("aria-label") ?? child.textContent?.trim() ?? child.tagName, middle: box.top + box.height / 2, right: box.right };
    }));
  const form = (await address(page).boundingBox())!;
  for (const box of boxes) {
    expect(box.middle, `${box.name} shares the row's line`).toBeCloseTo(boxes[0]!.middle, 0);
    expect(box.right, `${box.name} stays inside the row`).toBeLessThanOrEqual(form.x + form.width + 0.5);
  }
  return boxes.map((box) => box.name);
}

test.describe("on a desktop", () => {
  test("the tabs switch between Artifacts and Web Preview and nothing reads Web URL", async ({ page }) => {
    await openBrowser(page, 1440);
    await expect(tab(page, "Artifacts")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Artifacts").locator(".count")).toHaveText("5+");
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByText("Web URL")).toHaveCount(0);

    await tab(page, "Artifacts").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "Web Preview")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Web Preview")).toBeFocused();
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "browser-web-tab");
    await expect(page.locator(".browser-web .state-title")).toHaveText("Preview a Web Page");

    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "Artifacts")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".browser-artifact-list .row")).toHaveCount(5);
  });

  test("artifact rows are 56px, name their kind, keep the size on one line, and Show More loads the rest", async ({ page }) => {
    await openBrowser(page, 1440);
    const rows = page.locator(".browser-artifact-list .row");
    await expect(rows).toHaveCount(5);
    for (const height of await rows.evaluateAll((all) => all.map((row) => row.getBoundingClientRect().height))) {
      expect(height).toBe(56);
    }
    const html = rows.filter({ hasText: "Dashboard preview" });
    await expect(html.locator(".art-row-meta > span")).toHaveText("HTML preview");
    const size = html.locator(".art-size");
    await expect(size).toHaveText("1.7 KB");
    const lineHeight = await size.evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
    expect((await size.boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 1);
    expect(await rows.first().locator(".art-kind").evaluate((tile) => {
      const box = tile.getBoundingClientRect();
      return [box.width, box.height];
    })).toEqual([32, 32]);

    await page.locator(".list-foot").getByRole("button", { name: "Show More" }).click();
    await expect(rows).toHaveCount(7);
    await expect(page.locator(".list-foot")).toHaveCount(0);
    await expect(tab(page, "Artifacts").locator(".count")).toHaveText("7");
  });

  test("the artifact list shows its loading, empty and error states", async ({ page }) => {
    await openBrowser(page, 1440, "?artifacts=loading");
    await expect(page.locator(".browser-artifacts .skeleton .skeleton-row")).toHaveCount(3);

    await openBrowser(page, 1440, "?artifacts=empty");
    await expect(page.locator(".browser-artifacts .state-title")).toHaveText("No Artifacts Yet");
    await page.getByRole("button", { name: "Open Web Preview" }).click();
    await expect(tab(page, "Web Preview")).toHaveAttribute("aria-selected", "true");

    await openBrowser(page, 1440, "?artifacts=error");
    const error = page.locator(".browser-artifacts .state-error");
    await expect(error).toContainText("Couldn't Load Artifacts");
    await expect(error.getByRole("button", { name: "Retry" })).toBeVisible();
    await error.getByRole("button", { name: "Show Details" }).click();
    await expect(error).toContainText("503 Service Unavailable");
  });

  test("an address without a scheme is a field error under the row and no notice", async ({ page }) => {
    await openBrowser(page, 1440);
    await openWebPreview(page);
    const field = page.getByLabel("Web Preview URL");
    await field.fill("localhost:3000");
    await field.press("Enter");
    await expect(page.locator("#browser-url-error")).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator(".browser-web .notice")).toHaveCount(0);
    await expect(page.locator(".browser-web-frame")).toHaveCount(0);
  });

  test("a page shows the load bar until it loads, then Reload and Open in New Tab", async ({ page }) => {
    let release: () => void = () => undefined;
    const served = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${PAGE}*`, async (route) => {
      await served;
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Dashboard</title><h1>Dashboard</h1>" });
    });
    await openBrowser(page, 1440);
    await openWebPreview(page);
    await page.getByLabel("Web Preview URL").fill(PAGE);
    await page.getByRole("button", { name: "Open", exact: true }).click();

    const bar = page.locator(".browser-load-bar");
    await expect(bar).toBeVisible();
    expect((await bar.boundingBox())!.height).toBe(2);
    await expect(address(page).getByRole("button", { name: "Reload" })).toHaveCount(0);

    release();
    await expect(bar).toHaveCount(0);
    await expect(address(page).getByRole("button", { name: "Reload" })).toBeVisible();
    const external = address(page).getByRole("link", { name: "Open in New Tab" });
    await expect(external).toHaveAttribute("href", PAGE);
    await expect(external).toHaveAttribute("rel", "noopener noreferrer");
    await expect(address(page).getByRole("button", { name: "Open", exact: true })).toHaveCount(0);
    await expect(page.frameLocator(".browser-web-frame").getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // The frame fills the rest of the panel.
    const frame = (await page.locator(".browser-web-frame").boundingBox())!;
    const panel = (await page.locator("#right-panel").boundingBox())!;
    expect(frame.y + frame.height).toBeCloseTo(panel.y + panel.height, 0);
    expect(frame.width).toBeCloseTo(panel.width - 1, 0);
  });

  test("a page that never loads within 8 seconds shows Page Blocked with Open in New Tab", async ({ page }) => {
    await page.clock.install();
    await page.route(`${BLOCKED}*`, () => undefined);
    await openBrowser(page, 1440);
    await openWebPreview(page);
    await page.getByLabel("Web Preview URL").fill(BLOCKED);
    await page.getByLabel("Web Preview URL").press("Enter");
    await expect(page.locator(".browser-load-bar")).toBeVisible();

    await page.clock.fastForward(8_000);
    const notice = page.locator(".browser-web-view .notice");
    await expect(notice).toContainText("This page can't be shown inside Wollipog.");
    await expect(notice.getByRole("link", { name: "Open in New Tab" })).toHaveAttribute("href", BLOCKED);
    await expect(page.locator(".browser-web-frame")).toBeHidden();
    await expect(page.locator(".browser-load-bar")).toHaveCount(0);
  });
});

test.describe("on a phone", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("artifact rows are 64px on touch", async ({ page }) => {
    await openBrowser(page, 390);
    const rows = page.locator(".browser-artifact-list .row");
    await expect(rows).toHaveCount(5);
    for (const height of await rows.evaluateAll((all) => all.map((row) => row.getBoundingClientRect().height))) {
      expect(height).toBe(64);
    }
  });

  test("at a 320px panel the address row is one line before and after a page loads", async ({ page }) => {
    await page.route(`${PAGE}*`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><h1>Dashboard</h1>" }));
    await openBrowser(page, 320);
    expect((await page.locator("#right-panel").boundingBox())!.width).toBe(320);
    await openWebPreview(page);
    await page.getByLabel("Web Preview URL").fill("https://a-rather-long-host-name.preview.test:3000/dashboard/settings");
    expect(await addressRowIsOneLine(page)).toEqual([expect.anything(), "Open"]);

    await page.getByLabel("Web Preview URL").fill(PAGE);
    await page.getByLabel("Web Preview URL").press("Enter");
    await expect(address(page).getByRole("button", { name: "Reload" })).toBeVisible();
    expect(await addressRowIsOneLine(page)).toEqual(["Reload", expect.anything(), "Open in New Tab"]);
  });
});

/**
 * An opened artifact (#2855; docs/design-system.md §11.9): one 48px header with the title from its
 * leading edge and one back control, a plain meta line, Download's menu carrying the warning, the
 * bodies and their states, at the panel's 400px and on a 390px phone.
 */
async function openArtifact(page: Page, name: string) {
  await page.locator(".browser-artifact-list .row").filter({ hasText: name }).click();
  await expect(page.locator(".art-bar .art-title")).toHaveText(name);
}

for (const [label, width, touch] of [["a 400px panel", 1440, false], ["a 390px phone", 390, true]] as const) {
  test.describe(`an artifact preview in ${label}`, () => {
    test.use({ hasTouch: touch, isMobile: touch });

    test("the title is left-aligned in a 48px header with one back control", async ({ page }) => {
      await openBrowser(page, width);
      await openArtifact(page, "Review of the Browser panel rebuild");
      const bar = page.locator(".rpanel-toolbar > .art-bar");
      expect((await bar.boundingBox())!.height).toBe(48);
      const back = bar.getByRole("button", { name: "Back to Artifacts" });
      await expect(back).toBeFocused();
      await expect(page.getByRole("button", { name: /^Back/u })).toHaveCount(1);
      const title = (await bar.locator(".art-title").boundingBox())!;
      const backBox = (await back.boundingBox())!;
      expect(title.x - (backBox.x + backBox.width), "the title starts right after Back").toBeLessThanOrEqual(8);
      await expect(page.locator(".art-meta")).toContainText("Review report");
      await expect(page.locator(".art-meta .art-verified")).toHaveText("Verified");
      await expect(page.locator(".art-meta")).not.toContainText("text/markdown");
      await expect(page.locator(".art-markdown h1")).toHaveCount(0);
      await back.click();
      await expect(page.locator(".browser-artifact-list .row").first()).toBeFocused();
    });

    test("Download's menu carries the warning, and a JSON verdict reads in a code well", async ({ page }) => {
      await openBrowser(page, width);
      await openArtifact(page, "verdict.json");
      await expect(page.getByText("Not redacted.", { exact: false })).toHaveCount(0);
      await page.locator(".art-bar").getByRole("button", { name: "Download" }).click();
      const original = page.getByRole("menuitem", { name: "Download Original File" });
      await expect(original).toHaveAccessibleDescription("Not redacted. It may contain secrets or personal data.");
      await expect(page.getByRole("menuitem", { name: "Copy Checksum" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".art-code .diff-syntax-string").first()).toBeVisible();
      expect(await page.locator(".art-code pre").evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/Cascadia|Consolas|mono/iu);
    });

    test("Enlarge opens the screenshot in a full dialog and returns focus to Enlarge", async ({ page }) => {
      await openBrowser(page, width);
      await openArtifact(page, "Settings at 390px, dark theme.png");
      await expect(page.locator(".art-checker img")).toBeVisible();
      const enlarge = page.locator(".art-bar").getByRole("button", { name: "Enlarge" });
      await enlarge.click();
      const dialog = page.getByRole("dialog", { name: "Settings at 390px, dark theme.png" });
      await expect(dialog.locator(".art-stage img")).toBeVisible();
      const box = (await dialog.boundingBox())!;
      expect(box.width).toBeGreaterThan(width === 390 ? 380 : 1000);
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(enlarge).toBeFocused();
    });

    test("loading and a failed checksum show their states", async ({ page }) => {
      await openBrowser(page, width, "?preview=loading");
      await openArtifact(page, "web unit suite.log");
      await expect(page.locator(".art-skeleton")).toContainText("Loading and checking the preview…");

      await openBrowser(page, width, "?preview=mismatch");
      await openArtifact(page, "Dashboard preview");
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("Couldn't Verify This Artifact");
      await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
      await alert.getByRole("button", { name: "Show Details" }).click();
      await expect(alert).toContainText("digest does not match");
      await expect(page.locator("iframe")).toHaveCount(0);
    });
  });
}
