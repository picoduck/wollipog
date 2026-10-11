import { waitForSessionPreview } from "./session-readiness.js";
import { expect, test, type Page } from "@playwright/test";

/**
 * #1979 — the desktop window's title bar and title, from the web content's side (docs/design-system.md
 * §4.1). A browser cannot draw the macOS window, so `desktopApp=mac` lays the real Shell out as the
 * macOS app does: the instance tile in the rail and the strip the traffic lights sit in.
 */
const shell = (path: string, desktopApp?: "mac") =>
  `/command-inbox-projects-e2e.html?fullShell=1${desktopApp ? `&desktopApp=${desktopApp}` : ""}&path=${encodeURIComponent(path)}`;

async function openShell(page: Page, path: string, desktopApp?: "mac") {
  await page.goto(shell(path, desktopApp));
  await expect(page.locator(".app-rail .rail-destinations")).toBeVisible();
}

/** tauri.conf.json's `trafficLightPosition`: the close button's top-left corner. */
const TRAFFIC_LIGHTS = { x: 8, y: 18 };
/** AppKit's buttons: 14pt wide with 20pt between their left edges, and about 16pt tall. */
const BUTTON = { width: 14, height: 16, pitch: 20 };

async function railGeometry(page: Page) {
  return page.evaluate(({ lights, button }) => {
    const rail = document.querySelector<HTMLElement>(".app-rail")!;
    const strip = document.querySelector<HTMLElement>(".rail-drag-strip")!;
    const controls = [...rail.querySelectorAll<HTMLElement>(".instance-tile-trigger, .rail-item, .rail-foot button")];
    const box = (element: Element) => element.getBoundingClientRect();
    // Every point of each traffic light's box: what the page has under the native buttons.
    const covered = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const left = lights.x + index * button.pitch;
      for (let x = left; x <= left + button.width; x += 2) {
        for (let y = lights.y; y <= lights.y + button.height; y += 2) {
          const hit = document.elementFromPoint(x, y);
          covered.add(hit === strip ? "strip" : hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join(".")}` : "nothing");
        }
      }
    }
    return {
      railWidth: box(rail).width,
      strip: getComputedStyle(strip).display === "none" ? null : {
        top: box(strip).top,
        left: box(strip).left,
        width: box(strip).width,
        height: box(strip).height,
        drag: strip.getAttribute("data-tauri-drag-region"),
      },
      underTrafficLights: [...covered],
      firstControlTop: Math.min(...controls.map((control) => box(control).top)),
      tileTop: box(rail.querySelector(".instance-tile-trigger")!).top,
      bottom: Math.max(...controls.map((control) => box(control).bottom)),
      railScroll: rail.scrollHeight - rail.clientHeight,
      viewportHeight: window.innerHeight,
      count: controls.length,
    };
  }, { lights: TRAFFIC_LIGHTS, button: BUTTON });
}

// 600 is the window's minimum height; at 701 the rail's items are back to 40px (#1969's short tier
// ends at 700), which is where the strip leaves the least room.
for (const viewport of [{ width: 940, height: 600 }, { width: 940, height: 701 }, { width: 1320, height: 860 }]) {
  test.describe(`the macOS app at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    for (const labelled of [false, true]) {
      test(`the traffic lights sit in the ${labelled ? "labelled" : "64px"} rail's strip, above the instance tile, and every control still fits`, async ({ page }) => {
        await openShell(page, "/skills", "mac");
        if (labelled) {
          await page.getByRole("button", { name: "Expand Navigation" }).click();
          await expect(page.locator(".app-rail.labelled")).toBeVisible();
        }
        const rail = await railGeometry(page);
        expect(rail.strip, "a 40px strip across the top of the rail").toEqual({
          top: 0,
          left: 0,
          width: rail.railWidth - 1,
          height: 40,
          drag: "",
        });
        expect(rail.underTrafficLights, "nothing but the strip under the traffic lights").toEqual(["strip"]);
        expect(rail.tileTop, "the instance tile sits below the strip").toBeGreaterThanOrEqual(40);
        expect(rail.firstControlTop).toBe(rail.tileTop);
        // The tile, Search, nine destinations, Settings and the labels toggle.
        expect(rail.count).toBe(13);
        expect(rail.bottom, "the labels toggle stays in the window").toBeLessThanOrEqual(rail.viewportHeight);
        expect(rail.railScroll, "and the rail does not scroll").toBeLessThanOrEqual(0);
      });
    }
  });
}

test.describe("the browser build", () => {
  test.use({ viewport: { width: 1320, height: 860 } });

  test("keeps its rail as it was: no strip, and the first item at the top", async ({ page }) => {
    await openShell(page, "/skills");
    const layout = await page.evaluate(() => ({
      strip: getComputedStyle(document.querySelector(".rail-drag-strip")!).display,
      paddingTop: getComputedStyle(document.querySelector(".app-rail")!).paddingTop,
      titleBarClass: document.documentElement.classList.contains("macos-title-bar"),
      drag: document.querySelectorAll("[data-tauri-drag-region='deep']").length,
    }));
    expect(layout).toEqual({ strip: "none", paddingTop: "6px", titleBarClass: false, drag: 0 });
  });

  test("titles the tab \"<Page> – Wollipog\" and follows navigation, a Session by its own title", async ({ page }) => {
    await openShell(page, "/skills");
    await expect(page).toHaveTitle("Agent Skills – Wollipog");
    await page.getByRole("navigation", { name: "Primary Navigation" }).getByRole("link", { name: "Usage and Cost", exact: true }).click();
    await expect(page).toHaveTitle("Usage and Cost – Wollipog");
    await page.getByRole("navigation", { name: "Primary Navigation" }).getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page).toHaveTitle("Settings – Wollipog");
    await page.getByRole("navigation", { name: "Primary Navigation" }).getByRole("link", { name: "Sessions", exact: true }).click();
    await expect(page).toHaveTitle("Sessions – Wollipog");

    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    await waitForSessionPreview(page);
    if (await expand.isVisible()) await expand.click();
    const title = (await page.locator(".session-bar h1").textContent())!.trim();
    expect(title).toContain("Alpha Session");
    await expect(page).toHaveTitle(`${title} – Wollipog`);
  });
});
