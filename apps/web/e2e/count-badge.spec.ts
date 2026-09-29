import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The count badge (§11.4) measured in a browser, in both themes: its size and type, the token each
 * tone reads, and where the on-icon badge sits and what colour its ring takes. The badges are the
 * ones the colour-schemes fixture renders through `CountBadge`, which is also where their contrast
 * is measured in every scheme.
 */
test.use({ reducedMotion: "reduce" });

async function open(page: Page, theme: "dark" | "light") {
  await page.goto(`/colour-schemes-e2e.html?theme=${theme}`);
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-contrast-fixture-ready")
    || document.documentElement.hasAttribute("data-contrast-fixture-error"));
  expect(await page.locator("html").getAttribute("data-contrast-fixture-error")).toBeNull();
}

/** A token's computed colour, read through a probe so it serialises exactly as a used colour does. */
async function token(page: Page, name: string, within?: Locator): Promise<string> {
  const read = (host: Element, property: string) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${property})`;
    host.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  return within ? within.evaluate(read, name) : page.locator("body").evaluate(read, name);
}

async function look(badge: Locator) {
  return badge.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      numeric: style.fontVariantNumeric,
      background: style.backgroundColor,
      color: style.color,
    };
  });
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`in the ${theme} theme`, () => {
    test("a count badge is a 16px pill of 11px, weight-600 tabular numbers in its tone's token pair", async ({ page }) => {
      await open(page, theme);
      const type = { height: 16, fontSize: "11px", fontWeight: "600", numeric: "tabular-nums" };

      const warning = page.getByTestId("count-badge-inline").locator(".count-badge");
      await expect(warning).toHaveText("3");
      expect(await look(warning)).toEqual({
        ...type,
        background: await token(page, "--amber"),
        color: await token(page, "--count-warning-fg"),
      });

      const danger = page.getByTestId("count-badge-inline-danger").locator(".count-badge.danger");
      await expect(danger).toHaveText("12");
      expect(await look(danger)).toEqual({
        ...type,
        background: await token(page, "--danger-bg"),
        color: await token(page, "--danger-fg"),
      });

      // The on-icon modifier moves the badge; it does not resize or recolour it.
      for (const [id, tone] of [["count-badge-icon", "--amber"], ["count-badge-icon-danger", "--danger-bg"]] as const) {
        const badge = page.getByTestId(id).locator(".count-badge.on-icon");
        expect(await look(badge)).toMatchObject({ ...type, background: await token(page, tone) });
      }
    });

    test("an on-icon badge sits on the icon's top-right shoulder with a 2px ring its surface sets", async ({ page }) => {
      await open(page, theme);
      for (const id of ["count-badge-icon", "count-badge-icon-danger"]) {
        const host = page.getByTestId(id);
        const geometry = await host.evaluate((element) => {
          const icon = element.querySelector("svg")!.getBoundingClientRect();
          const badge = element.querySelector(".count-badge")!.getBoundingClientRect();
          return { icon: { width: icon.width, height: icon.height }, top: badge.top - icon.top, left: badge.left - icon.right, rightOfIcon: badge.right - icon.right, bottom: badge.bottom - icon.top };
        });
        expect(geometry.icon).toEqual({ width: 20, height: 20 });
        // Above the icon's top edge and past its right edge, overlapping only its top-right corner,
        // and growing rightward so a three-digit count covers no more of the icon than one digit.
        expect(geometry.top, id).toBe(-6);
        expect(geometry.left, id).toBe(-8);
        expect(geometry.rightOfIcon, id).toBeGreaterThanOrEqual(8);
        expect(geometry.bottom, id).toBe(10);
      }

      const badge = page.getByTestId("count-badge-icon").locator(".count-badge.on-icon");
      const ring = () => badge.evaluate((element) => getComputedStyle(element).boxShadow);
      expect(await ring()).toBe(`${await token(page, "--bg-elev")} 0px 0px 0px 2px`);

      // A surface that is not --bg-elev sets the property once, on an ancestor, and the ring follows.
      const host = page.getByTestId("count-badge-icon");
      await host.evaluate((element) => { (element as HTMLElement).style.setProperty("--count-badge-ring", "var(--surface-selected)"); });
      const selected = await token(page, "--surface-selected", host);
      expect(selected).not.toBe(await token(page, "--bg-elev"));
      // Polled: the app's reduced-motion transition still runs for a millisecond, serialised as oklab().
      await expect.poll(ring).toBe(`${selected} 0px 0px 0px 2px`);
    });

    test("in forced colors the on-icon ring survives as a 2px Canvas outline", async ({ page }) => {
      await open(page, theme);
      const badge = page.getByTestId("count-badge-icon").locator(".count-badge.on-icon");
      const outline = () => badge.evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, shadow: style.boxShadow };
      });
      // Outside forced colors the ring is the box-shadow alone.
      expect((await outline()).style).toBe("none");

      await page.emulateMedia({ forcedColors: "active" });
      const canvas = await page.locator("body").evaluate((host) => {
        const probe = document.createElement("span");
        probe.style.color = "Canvas";
        host.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      });
      // Forced colors drops the box-shadow; the outline is what separates the badge from the icon.
      await expect.poll(outline).toEqual({ style: "solid", width: "2px", color: canvas, shadow: "none" });
    });
  });
}
