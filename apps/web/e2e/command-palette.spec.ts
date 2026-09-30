import { expect, test, type Page } from "@playwright/test";

/**
 * The command palette (#1978; docs/design-system.md §4.1 Search, §11.5, §12.2, §15.1) in the real
 * Shell: its desktop card, the active row in both themes, and the full-screen phone layout. The
 * section model and the triggers' focus return are unit and DOM tested (palette.test.ts,
 * CommandPalette.dom.test.tsx); this is what only a browser can measure.
 */

const shell = (path: string) => `/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent(path)}`;

async function openShell(page: Page, { path = "/inbox", theme = "dark" }: { path?: string; theme?: "dark" | "light" } = {}) {
  await page.addInitScript((value) => window.localStorage.setItem("wollipog.theme", value), theme);
  // The fixture's API is the real client; give the two palette endpoints an answer.
  await page.route("**/api/sessions?archived=true", (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/api/search?*", (route) => route.fulfill({
    json: { results: [{ sessionId: "session-no-project", seq: 1, title: "No Project Session", snippet: "…t the ⟪alpha⟫ release notes" }] },
  }));
  await page.goto(shell(path));
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

const palette = (page: Page) => page.getByRole("dialog", { name: "Search" });

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
}

/** A token resolved to the computed colour the browser paints, so it compares with getComputedStyle. */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

test.describe("at 1440×900 with a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a 640px card 96px from the top: 48px bar, labelled sections, 36px key hints", async ({ page }) => {
    await openShell(page);
    await openPalette(page);
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const card = document.querySelector(".palette")!;
      const style = getComputedStyle(card);
      return {
        width: box(".palette").width,
        top: box(".palette").top,
        radius: style.borderTopLeftRadius,
        shadow: style.boxShadow !== "none",
        bar: box(".palette-bar").height,
        foot: box(".palette-foot").height,
        hints: [...document.querySelectorAll(".palette-foot .shortcut-hint")].map((hint) => hint.textContent),
        labels: [...document.querySelectorAll(".palette-section-label")].map((label) => ({
          text: label.textContent,
          height: label.getBoundingClientRect().height,
          transform: getComputedStyle(label).textTransform,
        })),
      };
    });
    expect(geometry.width).toBe(640);
    expect(geometry.top).toBe(96);
    expect(geometry.radius).toBe("12px");
    expect(geometry.shadow).toBe(true);
    expect(geometry.bar).toBe(48);
    expect(geometry.foot).toBe(36);
    expect(geometry.hints).toEqual(["↑↓Move", "EnterOpen", "EscClose"]);
    expect(geometry.labels.map((label) => label.text)).toEqual(["Go To", "Actions"]);
    for (const label of geometry.labels) {
      expect(label.height).toBe(28);
      expect(label.transform).toBe("none");
    }
    await expect(page.getByRole("combobox", { name: "Search" })).toHaveAttribute("placeholder", "Search sessions and transcripts");
  });

  for (const theme of ["dark", "light"] as const) {
    test(`the active row has the selected fill and a 2px accent bar in the ${theme} theme`, async ({ page }) => {
      await openShell(page, { theme });
      await openPalette(page);
      const active = page.locator(".palette-item.on");
      await expect(active).toHaveCount(1);
      const look = await active.evaluate((row) => ({
        fill: getComputedStyle(row).backgroundColor,
        bar: getComputedStyle(row, "::before").backgroundColor,
        barWidth: getComputedStyle(row, "::before").width,
        next: getComputedStyle(row.parentElement!.querySelectorAll(".palette-item")[1]!).backgroundColor,
      }));
      expect(look.fill).toBe(await tokenColor(page, "--surface-selected"));
      expect(look.fill).not.toBe(look.next);
      expect(look.bar).toBe(await tokenColor(page, "--accent"));
      expect(look.barWidth).toBe("2px");
    });
  }

  test("Recent lists sessions opened through the palette, newest first", async ({ page }) => {
    await openShell(page);
    for (const title of ["Alpha Session", "No Project Session"]) {
      await openPalette(page);
      await page.keyboard.type(title);
      await expect(page.locator(".palette-item.on .palette-label")).toHaveText(title);
      await page.keyboard.press("Enter");
      await expect(palette(page)).toBeHidden();
      await expect(page.locator("#page-title")).toHaveText(title);
    }
    await openPalette(page);
    const recent = page.getByRole("group", { name: "Recent" });
    await expect(recent.locator(".palette-label")).toHaveText(["No Project Session", "Alpha Session"]);
    await expect(recent.locator(".palette-icon .status")).toHaveCount(2);
  });
});

test.describe("at 390×844 on a touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the app bar's Search opens a full-screen palette with Cancel, 48px rows and no key hints", async ({ page }) => {
    await openShell(page, { path: "/projects" });
    const trigger = page.locator(".page-header").getByRole("button", { name: "Search", exact: true });
    await trigger.tap();
    await expect(palette(page)).toBeVisible();
    const layout = await page.evaluate(() => {
      const card = document.querySelector(".palette")!.getBoundingClientRect();
      const input = document.querySelector<HTMLInputElement>(".palette-input")!;
      return {
        card: { top: card.top, left: card.left, width: card.width, height: card.height },
        bar: document.querySelector(".palette-bar")!.getBoundingClientRect().height,
        rows: [...document.querySelectorAll(".palette-item")].map((row) => row.getBoundingClientRect().height),
        clipped: [...document.querySelectorAll(".palette-body")].filter((body) => body.scrollHeight > body.clientHeight + 1).length,
        foot: getComputedStyle(document.querySelector(".palette-foot")!).display,
        fontSize: getComputedStyle(input).fontSize,
        placeholderFits: input.scrollWidth <= input.clientWidth,
      };
    });
    expect(layout.card).toEqual({ top: 0, left: 0, width: 390, height: 844 });
    expect(layout.bar).toBe(48);
    expect(Math.min(...layout.rows)).toBeGreaterThanOrEqual(48);
    expect(layout.clipped, "two-line rows show both lines").toBe(0);
    expect(layout.foot).toBe("none");
    expect(layout.fontSize).toBe("16px");
    expect(layout.placeholderFits, "the placeholder fits a 390px phone").toBe(true);
    await expect(palette(page).getByRole("option", { name: /Navigation Labels/ })).toHaveCount(0);

    // With a software keyboard that only shrinks the visual viewport, the palette ends above it and
    // its last row can still scroll into view (mobile-viewport.ts publishes the occlusion).
    await page.evaluate(() => document.documentElement.style.setProperty("--keyboard-inset", "300px"));
    const occluded = await page.evaluate(() => {
      const results = document.querySelector(".palette-results")!;
      results.scrollTop = results.scrollHeight;
      const rows = document.querySelectorAll(".palette-item");
      return {
        card: document.querySelector(".palette")!.getBoundingClientRect().bottom,
        last: rows[rows.length - 1]!.getBoundingClientRect().bottom,
      };
    });
    expect(occluded.card).toBe(544);
    expect(occluded.last).toBeLessThanOrEqual(544);
    await page.evaluate(() => document.documentElement.style.removeProperty("--keyboard-inset"));

    await palette(page).getByRole("button", { name: "Cancel" }).tap();
    await expect(palette(page)).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("a query shows sessions and transcript hits, each on its own lines", async ({ page }) => {
    await openShell(page, { path: "/projects" });
    await page.locator(".page-header").getByRole("button", { name: "Search", exact: true }).tap();
    await page.getByRole("combobox", { name: "Search" }).fill("alpha");
    await expect(page.getByRole("group", { name: "Sessions" }).locator(".palette-label")).toHaveText(["Alpha Session"]);
    const hit = page.getByRole("group", { name: "In Transcripts" }).getByRole("option");
    await expect(hit.locator(".palette-snippet")).toHaveText("…the alpha release notes");
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll(".palette-body")].filter((body) => body.scrollHeight > body.clientHeight + 1).length);
    expect(clipped).toBe(0);
  });
});
