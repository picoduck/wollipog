import { expect, test, type Page } from "@playwright/test";

/**
 * #1981: Deployment is one table for every machine, in the real Shell. `?skills=notices&deployment=1`
 * adds six agents that can't receive managed skills, container and cloud targets, and a long
 * machine-reported error to the #1972 notice fixture.
 */

const skillPath = (id: string) => `/skills/~${Buffer.from(id, "utf16le").toString("base64url")}`;
const open = async (page: Page, id: string) => {
  await page.goto(`/command-inbox-projects-e2e.html?fullShell=1&history=1&skills=notices&deployment=1&path=${encodeURIComponent(skillPath(id))}`);
  const table = page.locator("table.skill-deployment");
  await expect(table).toBeVisible();
  return table;
};

/** Every agent row's name cell, per machine: where it starts and whether its words wrapped. */
const agentColumns = (page: Page) => page.locator("table.skill-deployment").evaluate((table) =>
  [...table.querySelectorAll("tbody")].map((group) => ({
    machine: group.getAttribute("aria-label"),
    rows: [...group.querySelectorAll<HTMLElement>("tr.skill-deployment-agent")].map((row) => {
      const name = row.querySelector<HTMLElement>(".skill-deployment-agent-name")!;
      const lineHeight = Number.parseFloat(getComputedStyle(name).lineHeight);
      return { x: row.querySelector("th")!.getBoundingClientRect().left, wrapped: name.getBoundingClientRect().height > lineHeight * 1.5 };
    }),
  })));

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("every machine's agents line up under one header, and nothing wraps inside a word", async ({ page }) => {
    const table = await open(page, "skill-n6");
    // The long detail is the Studio's; the Laptop's rows still start where the Studio's do.
    await expect(table.getByRole("rowgroup", { name: "Studio Workstation" })).toContainText("is owned by root");
    const groups = await agentColumns(page);
    expect(groups.map((group) => group.machine)).toEqual(["Studio Workstation", "Travel Laptop"]);
    const xs = new Set(groups.flatMap((group) => group.rows.map((row) => Math.round(row.x))));
    expect(xs.size).toBe(1);
    expect(groups.flatMap((group) => group.rows).some((row) => row.wrapped)).toBe(false);
    const headers = await table.locator("thead th").evaluateAll((cells) => cells.map((cell) => ({
      text: cell.textContent, fits: cell.scrollWidth <= cell.clientWidth,
    })));
    expect(headers).toEqual(["Agent", "Invocation", "Assigned By", "Status"].map((text) => ({ text, fits: true })));
  });

  test("Codex can't run a Manual Only rule: Error on Codex, Linked on Claude Code, and 1 of 2 Linked", async ({ page }) => {
    const table = await open(page, "skill-n1");
    const laptop = table.getByRole("rowgroup", { name: "Travel Laptop" });
    await expect(laptop.locator(".skill-deployment-machine")).toContainText("1 of 2 Linked");
    await expect(laptop.locator(".skill-deployment-machine .status")).toHaveText("Offline");
    await expect(laptop.locator("tr", { hasText: "Claude Code" }).locator(".cell-status")).toHaveText("Linked");
    const codex = laptop.locator("tr", { hasText: "Codex" });
    await expect(codex.locator(".cell-status")).toHaveText("Error");
    await expect(codex).toContainText("Can't run manual-only skills.");
    await expect(page.locator(".skill-notice-slot .notice-title")).toHaveText("Codex and Pi Can't Run Manual-Only Skills");
  });

  test("six agents that can't receive managed skills fold into one row", async ({ page }) => {
    const table = await open(page, "skill-n1");
    const studio = table.getByRole("rowgroup", { name: "Studio Workstation" });
    const toggle = studio.getByRole("button", { name: "6 Agents Can't Receive Managed Skills", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(studio.locator("tr.skill-deployment-agent")).toHaveCount(3);
    await toggle.click();
    await expect(studio.locator("tr.skill-deployment-agent")).toHaveCount(9);
    await expect(studio).toContainText("Assigned skills load only in host sessions, so they don't reach Offline Container or Cloud Sandbox.");
  });

  test("a built-in skill assigned nowhere says why", async ({ page }) => {
    await open(page, "skill-n5");
    const notice = page.getByRole("region", { name: "Deployment" }).locator(".notice");
    await expect(notice.locator(".notice-title")).toHaveText("Not Deployed Anywhere");
    await expect(notice).toContainText("It isn't assigned yet. Built-in skills reach a machine only after you assign them.");
  });
});

for (const [label, options] of [
  ["on an 834px coarse-pointer tablet", { viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true }],
  ["on a 390px phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
] as const) {
  test.describe(label, () => {
    test.use(options);

    test("Deployment is two-line rows with no horizontal scroll", async ({ page }) => {
      const table = await open(page, "skill-n1");
      const row = table.locator("tr.skill-deployment-agent").first();
      await expect(row).toHaveCSS("display", "flex");
      // Line 1 is the agent and its status; line 2 its invocation and assigned-by.
      const lines = await row.evaluate((element) => {
        const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
        const name = box("th"); const status = box(".cell-status"); const meta = [...element.querySelectorAll(".cell-meta")].map((cell) => cell.getBoundingClientRect());
        return { nameTop: name.top, statusTop: status.top, metaTops: meta.map((cell) => cell.top), nameBottom: name.bottom };
      });
      expect(Math.abs(lines.statusTop - lines.nameTop)).toBeLessThan(4);
      for (const top of lines.metaTops) expect(top).toBeGreaterThanOrEqual(lines.nameBottom - 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await table.evaluate((element) => element.closest(".table-wrap")!.scrollWidth <= element.closest(".table-wrap")!.clientWidth)).toBe(true);
    });
  });
}
