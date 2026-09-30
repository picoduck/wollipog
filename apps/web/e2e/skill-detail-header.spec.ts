import { expect, test, type Page } from "@playwright/test";

/**
 * The skill detail's header and section frame (#1962; docs/design-system.md §3, §4.5, §5.1, §9.1,
 * §11.3), in the real Shell with `?skills=detail`: one ⋯ for the skill's actions, a two-line
 * description that expands, numbered versions, and unboxed sections in their order.
 */
const skillPath = (id: string) => `/skills/~${Buffer.from(id, "utf16le").toString("base64url")}`;
async function open(page: Page, id: string, query = "") {
  await page.goto(`/command-inbox-projects-e2e.html?fullShell=1&history=1&skills=detail${query}&path=${encodeURIComponent(skillPath(id))}`);
  await expect(page.locator(".skill-detail-head")).toBeVisible();
}

const head = (page: Page) => page.locator(".skill-detail-head");
const toggle = (page: Page) => head(page).locator(".skill-detail-desc-toggle");
const description = (page: Page) => head(page).locator(".skill-detail-desc");

/** Every shown button in the detail, against the width its own label and padding need. */
const stretchedButtons = (page: Page) => page.locator(".master-detail-detail").evaluate((detail) => {
  const stretched: string[] = [];
  for (const button of detail.querySelectorAll<HTMLElement>("button.btn")) {
    if (button.getClientRects().length === 0) continue;
    const width = button.getBoundingClientRect().width;
    const saved = button.style.cssText;
    button.style.cssText += ";width:max-content !important;justify-self:start !important;align-self:start !important;flex:none !important";
    const natural = button.getBoundingClientRect().width;
    button.style.cssText = saved;
    if (width > natural + 1) stretched.push(`${button.textContent?.trim()}: ${Math.round(width)} > ${Math.round(natural)}`);
  }
  return stretched;
});

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("no button is wider than its label, and the skill's actions are Add Assignment… and one ⋯", async ({ page }) => {
    for (const id of ["skill-1", "skill-2", "skill-3", "skill-4", "skill-5"]) {
      await open(page, id);
      expect(await stretchedButtons(page), id).toEqual([]);
      const actions = head(page).locator(".skill-detail-title-row > .actions > *");
      await expect(actions).toHaveCount(2);
      await expect(actions.nth(0)).toHaveAccessibleName("Add Assignment…");
      await expect(actions.nth(1).getByRole("button")).toHaveAccessibleName("More Actions");
      await expect(page.getByRole("button", { name: "Version History", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Machine Versions", exact: true })).toHaveCount(0);
    }
  });

  test("⋯ lists Version History…, Machine Version…, Check for Updates…, then Delete Skill… in danger text after a separator", async ({ page }) => {
    await open(page, "skill-3");
    await head(page).getByRole("button", { name: "More Actions" }).click();
    const menu = page.getByRole("menu", { name: "More Actions" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Version History…", "Machine Version…", "Check for Updates…", "Delete Skill…"]);
    const colors = await menu.evaluate((element) => {
      const items = [...element.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const probe = document.createElement("span");
      probe.style.color = "var(--danger-text)";
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return { last: getComputedStyle(items.at(-1)!).color, other: getComputedStyle(items[0]!).color, danger,
        separated: items.at(-1)!.previousElementSibling?.getAttribute("role") === "separator" };
    });
    expect(colors.last).toBe(colors.danger);
    expect(colors.other).not.toBe(colors.danger);
    expect(colors.separated).toBe(true);
  });

  test("a built-in skill's Check for Updates… is disabled and says why", async ({ page }) => {
    await open(page, "skill-4");
    await head(page).getByRole("button", { name: "More Actions" }).click();
    const check = page.getByRole("menuitem", { name: "Check for Updates…" });
    await expect(check).toBeDisabled();
    await expect(check).toHaveAccessibleDescription("Built-in skills update with each Wollipog release.");
  });

  test("the orchestrate-issues description shows two lines, expands to every character, and collapses", async ({ page }) => {
    await open(page, "skill-1");
    const lineHeight = await description(page).evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
    expect(await description(page).evaluate((element) => element.clientHeight)).toBe(2 * lineHeight);
    await expect(toggle(page)).toHaveText("Show Full Description");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await toggle(page).click();
    await expect(toggle(page)).toHaveText("Show Less");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    const expanded = await description(page).evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }));
    expect(expanded.client).toBe(expanded.scroll);
    expect(expanded.client).toBeGreaterThan(2 * lineHeight);
    await toggle(page).click();
    expect(await description(page).evaluate((element) => element.clientHeight)).toBe(2 * lineHeight);
  });

  test("a 1,024-character description keeps its line breaks and every character when expanded", async ({ page }) => {
    await open(page, "skill-2");
    await toggle(page).click();
    const shown = await description(page).evaluate((element) => ({
      text: element.textContent ?? "", whiteSpace: getComputedStyle(element).whiteSpace, inner: (element as HTMLElement).innerText,
    }));
    expect(shown.text).toHaveLength(1024);
    expect(shown.whiteSpace).toBe("pre-line");
    expect(shown.inner.split("\n").length).toBeGreaterThanOrEqual(5);
  });

  test("the description is 13px and the meta 12px; the meta shows v3 with its facts and no digest", async ({ page }) => {
    await open(page, "skill-1");
    const sizes = await head(page).evaluate((element) => ({
      description: getComputedStyle(element.querySelector(".skill-detail-desc")!).fontSize,
      meta: getComputedStyle(element.querySelector(".skill-detail-meta")!).fontSize,
      title: getComputedStyle(element.querySelector(".skill-detail-title")!).fontSize,
      weight: getComputedStyle(element.querySelector(".skill-detail-title")!).fontWeight,
      icons: [...element.querySelectorAll(".skill-detail-meta svg")].map((icon) => icon.getBoundingClientRect().width),
    }));
    expect(sizes).toEqual({ description: "13px", meta: "12px", title: "16px", weight: "600", icons: [14, 14, 14, 14, 14] });
    await expect(head(page).locator(".skill-detail-meta > li")).toHaveText(["Group: Campaigns", "Version: v3", "Updated 4m ago", "3 files", "Source: Library"]);
  });

  test("against a control plane without version numbers the meta shows the short digest", async ({ page }) => {
    await open(page, "skill-1", "&numbers=0");
    await expect(head(page).locator(".skill-detail-meta .mono")).toHaveText("0001cccccccc");
    await expect(head(page).locator(".skill-detail-meta")).not.toContainText("v3");
  });

  test("sections are Deployment, Assignments, Instructions, Source, with no border or fill", async ({ page }) => {
    await open(page, "skill-3");
    const sections = page.locator(".skill-detail > section.section");
    await expect(sections.locator(":scope > .section-head > .section-title")).toHaveText(["Deployment", "Assignments", "Instructions", "Source"]);
    const boxes = await page.locator(".skill-detail").evaluate((detail) =>
      [...detail.querySelectorAll<HTMLElement>(":scope > section.section, .skills-section")].map((element) => {
        const style = getComputedStyle(element);
        // A card has an edge on every side; the hairline between two machines is only on top.
        return `${style.borderLeftWidth} ${style.borderBottomWidth} ${style.backgroundColor}`;
      }));
    expect(new Set(boxes)).toEqual(new Set(["0px 0px rgba(0, 0, 0, 0)"]));
    // §4.5: a title row, 12px to its content, 32px between sections.
    const rhythm = await page.locator(".skill-detail").evaluate((detail) => {
      const sections = [...detail.querySelectorAll<HTMLElement>(":scope > section.section")];
      return {
        toContent: sections.map((section) => Math.round(section.querySelector(".section-head")!.nextElementSibling!.getBoundingClientRect().top -
          section.querySelector(".section-head")!.getBoundingClientRect().bottom)),
        between: sections.slice(1).map((section, index) => Math.round(section.getBoundingClientRect().top - sections[index]!.getBoundingClientRect().bottom)),
      };
    });
    expect(rhythm).toEqual({ toContent: [12, 12, 12, 12], between: [32, 32, 32] });
    // A block's own heading inside a section (Git Source) keeps no browser margin either.
    const gitHeading = page.locator(".skills-git-source h4");
    expect(await gitHeading.evaluate((element) => getComputedStyle(element).marginBottom)).toBe("0px");
  });
});

test("a description that fits in two lines loses its toggle when the window widens from 900px to 1440px", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await open(page, "skill-5");
  await expect(toggle(page)).toHaveText("Show Full Description");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(toggle(page)).toHaveCount(0);
  // A description that fits at both widths never had one.
  await open(page, "skill-3");
  await expect(toggle(page)).toHaveCount(0);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(toggle(page)).toHaveCount(0);
});

test("on the 390px detail route the detail bar's ⋯ holds Add Assignment… and the menu, and the description expands", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await open(page, "skill-1");
    await expect(page.locator(".detail-bar h1")).toHaveText("orchestrate-issues");
    await expect(head(page).locator(".skill-detail-title-row")).toHaveCount(0);
    expect(await stretchedButtons(page)).toEqual([]);
    await expect(toggle(page)).toHaveText("Show Full Description");
    // The toggle keeps its drawn size and borrows a 44px band on touch (§15.3).
    const band = await toggle(page).evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      band: parseFloat(getComputedStyle(element, "::after").height),
    }));
    expect(band.height).toBeLessThan(44);
    expect(band.band).toBe(44);
    await toggle(page).click();
    await expect(toggle(page)).toHaveText("Show Less");
    await page.locator(".detail-bar").getByRole("button", { name: "More Actions" }).click();
    await expect(page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem"))
      .toHaveText(["Add Assignment…", "Version History…", "Machine Version…", "Delete Skill…"]);
  } finally {
    await context.close();
  }
});
