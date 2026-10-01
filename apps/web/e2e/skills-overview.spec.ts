import { expect, test, type Page } from "@playwright/test";

/**
 * The Library Overview (#1971; docs/design-system.md §6.1), the Agent Skills default detail, in the
 * real Shell. `?skills=overview` holds one deployment error, one edited copy, one held Git update,
 * four orphaned copies and a recommended built-in skill; `?skills=healthy` is the same library with
 * nothing to review and an offline second machine.
 */
const shell = (path: string, mode: "overview" | "healthy" = "overview") =>
  `/command-inbox-projects-e2e.html?fullShell=1&history=1&skills=${mode}&path=${encodeURIComponent(path)}`;
const skillPath = (id: string) => `/skills/~${Buffer.from(id, "utf16le").toString("base64url")}`;
const routePath = (page: Page) => page.evaluate(() => new URL(window.location.href).searchParams.get("path"));

async function open(page: Page, path: string, mode: "overview" | "healthy" = "overview") {
  await page.goto(shell(path, mode));
  await expect(page.locator("#page-title")).toBeVisible();
}

const overview = (page: Page) => page.locator(".master-detail-detail > .skills-overview");
const section = (page: Page, title: string) =>
  overview(page).locator(".section").filter({ has: page.locator(".section-title", { hasText: title }) });

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("/skills shows the Library Overview top-aligned at the detail pane's leading edge, with no centred sentence", async ({ page }) => {
    await open(page, "/skills");
    await expect(overview(page).getByRole("heading", { level: 2 })).toHaveText("Library Overview");
    await expect(overview(page).locator(".skills-overview-summary")).toHaveText("8 skills in 3 groups, deployed to agents on 1 machine.");
    await expect(page.locator(".master-detail-detail")).not.toContainText("Select a skill");
    const [pane, content] = await Promise.all([
      page.locator(".master-detail-detail").evaluate((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { left: box.left + parseFloat(style.paddingLeft), top: box.top + parseFloat(style.paddingTop) };
      }),
      overview(page).boundingBox(),
    ]);
    expect(content!.x).toBe(pane.left);
    expect(content!.y).toBe(pane.top);
    await expect(overview(page).locator(".section-title")).toHaveText(
      ["Needs Attention4", "Recommended by Wollipog", "Recently Changed"]);
    await expect(page.locator(".skill-list-overview"), "the list's overview row is for phones").toHaveCount(0);
  });

  test("Needs Attention lists four rows the list's badges agree with, and each Review opens its skill or the orphaned copies", async ({ page }) => {
    await open(page, "/skills");
    const attention = section(page, "Needs Attention");
    await expect(attention.locator(".skills-overview-count")).toHaveText("4");
    const rows = attention.locator(".surface > .row");
    await expect(rows.locator(".row-title")).toHaveText(["deploy-bot", "release-notes", "lint-rules", "Orphaned Copies"]);
    await expect(rows.locator(".row-line > :is(.status, .count-badge)")).toHaveText(["Error", "Edited", "Update Held", "4"]);
    await expect(rows.locator(".row-sub")).toHaveText([
      "Codex on Build Machine: Permission denied writing ~/.codex/skills/deploy-bot.",
      "Build Machine has an edited copy of this skill.",
      "An update to Git commit 9e2a00000000 waits for your review.",
      "Machines keep 4 edited copies that no library skill shows.",
    ]);
    // Every row is one 56px two-line row, its reason on one line.
    for (const box of await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))) {
      expect(box).toBe(56);
    }
    const listMarked = await page.locator(".master-detail-list .skill-row").evaluateAll((elements) => elements
      .filter((row) => row.querySelector(".skill-row-status"))
      .map((row) => `${row.querySelector(".row-title")!.textContent} ${row.querySelector(".skill-row-status")!.textContent}`)
      .sort());
    expect(listMarked).toEqual(["deploy-bot Error", "lint-rules Update Held", "release-notes Edited"]);

    await rows.nth(0).getByRole("button", { name: "Review deploy-bot", exact: true }).click();
    expect(await routePath(page)).toBe(skillPath("skill-1"));
    await page.goBack();
    await section(page, "Needs Attention").getByRole("button", { name: "Review Orphaned Copies", exact: true }).click();
    expect(await routePath(page)).toBe("/skills/orphans");
    await expect(page.locator('.master-detail-detail [aria-label="Orphaned Copies"]')).toBeVisible();
  });

  test("a conflict, a manual-only skip and an unsupported agent show in the list and Needs Attention as Deployment shows them (#2282)", async ({ page }) => {
    await page.goto(`${shell("/skills")}&skillErrors=1`);
    await expect(page.locator("#page-title")).toBeVisible();
    const rows = section(page, "Needs Attention").locator(".surface > .row");
    await expect(rows.locator(".row-title")).toHaveText(
      ["code-review", "deploy-bot", "triage-helper", "writing-tests", "release-notes", "lint-rules", "Orphaned Copies"]);
    await expect(rows.locator(".row-line > :is(.status, .count-badge)")).toHaveText(
      ["Error", "Error", "Error", "Error", "Edited", "Update Held", "4"]);
    // Deployment's reason for Codex, in the machine's own words or ours; the overview ends it with a period.
    const reasons = {
      "code-review": "an unmanaged file or directory already exists at ~/.codex/skills/code-review",
      "triage-helper": "Can't run manual-only skills.",
      "writing-tests": "this agent's driver does not support managed skills",
    };
    const ended = (text: string) => text.endsWith(".") ? text : `${text}.`;
    await expect(rows.locator(".row-sub")).toHaveText([
      `Codex on Build Machine: ${ended(reasons["code-review"])}`,
      "Codex on Build Machine: Permission denied writing ~/.codex/skills/deploy-bot.",
      `Codex on Build Machine: ${reasons["triage-helper"]}`,
      `Codex on Build Machine: ${ended(reasons["writing-tests"])}`,
      "Build Machine has an edited copy of this skill.",
      "An update to Git commit 9e2a00000000 waits for your review.",
      "Machines keep 4 edited copies that no library skill shows.",
    ]);
    const listMarked = await page.locator(".master-detail-list .skill-row").evaluateAll((elements) => elements
      .filter((row) => row.querySelector(".skill-row-status"))
      .map((row) => `${row.querySelector(".row-title")!.textContent} ${row.querySelector(".skill-row-status")!.textContent}`)
      .sort());
    expect(listMarked).toEqual(["code-review Error", "deploy-bot Error", "lint-rules Update Held", "release-notes Edited",
      "triage-helper Error", "writing-tests Error"]);

    // Each Review opens the skill, whose Deployment row gives the same status and reason.
    for (const [name, reason] of Object.entries(reasons)) {
      await section(page, "Needs Attention").getByRole("button", { name: `Review ${name}`, exact: true }).click();
      const codex = page.locator("table.skill-deployment tr.skill-deployment-agent")
        .filter({ has: page.locator(".skill-deployment-agent-name", { hasText: "Codex" }) });
      await expect(codex.locator(".status")).toHaveText("Error");
      await expect(codex.locator(".skill-deployment-reason")).toHaveText(reason);
      await page.goBack();
    }
  });

  test("with nothing to review the section is one line after a green dot, naming the offline machine", async ({ page }) => {
    await open(page, "/skills", "healthy");
    const attention = section(page, "Needs Attention");
    await expect(attention.locator(".skills-overview-ok")).toHaveText(
      "Every skill is deployed as assigned. Studio Workstation is offline; its agents update when it reconnects.");
    await expect(attention.getByRole("button")).toHaveCount(0);
    await expect(attention.locator(".skills-overview-count")).toHaveCount(0);
    const dot = await attention.locator(".skills-overview-dot").evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height, color: getComputedStyle(element).backgroundColor,
      };
    });
    expect([dot.width, dot.height]).toEqual([8, 8]);
    expect(dot.color).not.toBe("rgba(0, 0, 0, 0)");
    await expect(section(page, "Recommended by Wollipog")).toHaveCount(0);
  });

  test("Assign › All Machines assigns the recommended skill, which leaves the section and the list's Recommended group", async ({ page }) => {
    await open(page, "/skills");
    const recommended = section(page, "Recommended by Wollipog");
    await expect(recommended.locator(".skills-hint")).toHaveText(
      "Built-in skills that teach agents to use Wollipog. They aren't on any machine until you assign them.");
    const row = recommended.locator(".surface > .row");
    await expect(row.locator(".row-title")).toHaveText(["using-wollipog"]);
    await expect(row.locator(".status")).toHaveText(["Built-In"]);
    await expect(page.locator('.skill-list-group[aria-label="Recommended"] .row-title')).toHaveText(["using-wollipog"]);

    await row.getByRole("button", { name: "Assign using-wollipog", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Assign using-wollipog" });
    await expect(menu.locator(".menu-text")).toHaveText(["All Machines", "Build Machine", "Studio Workstation", "Dismiss Recommendation"]);
    await expect(menu.locator(".menu-desc")).toHaveText([
      "Every supported agent on every machine.",
      "Its supported agents get it on the next sync.",
      "Its agents get it when it reconnects.",
    ]);
    await expect(menu.getByRole("separator")).toHaveCount(1);
    await menu.getByRole("menuitem", { name: "All Machines" }).click();
    await expect(recommended).toHaveCount(0);
    await expect(page.locator('.skill-list-group[aria-label="Recommended"]')).toHaveCount(0);
    await expect(section(page, "Needs Attention").locator(".skills-overview-count"), "recommendations never counted").toHaveText("4");
    await expect(section(page, "Recently Changed").locator(".row").first().locator(".row-title")).toHaveText("using-wollipog");
  });

  test("Dismiss Recommendation hides the skill without assigning it", async ({ page }) => {
    await open(page, "/skills");
    await section(page, "Recommended by Wollipog").getByRole("button", { name: "Assign using-wollipog", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Dismiss Recommendation" }).click();
    await expect(section(page, "Recommended by Wollipog")).toHaveCount(0);
    await page.locator(".master-detail-list .skill-row", { hasText: "using-wollipog" }).click();
    const recommendation = page.locator(".skill-detail .facts dt", { hasText: "Recommendation" }).locator("xpath=following-sibling::dd[1]");
    await expect(recommendation).toHaveText("DismissedShow Recommendation");
    await expect(recommendation.getByRole("button", { name: "Show Recommendation" })).toBeVisible();
  });

  test("Recently Changed shows five rows newest first, each opening its skill", async ({ page }) => {
    await open(page, "/skills");
    const rows = section(page, "Recently Changed").locator(".surface > .row");
    await expect(rows.locator(".row-title")).toHaveText(["review-checklist", "code-review", "deploy-bot", "release-notes", "lint-rules"]);
    await expect(rows.locator(".row-sub")).toHaveText([
      "v3: Add migration and test-coverage checks",
      "Assignments changed",
      "v4: Sign builds with the release key",
      "New version v2",
      "v7: Automatic update from Git commit 4c1d000",
    ]);
    await expect(rows.locator(".row-trail")).toHaveText(["40m ago", "2h ago", "1d ago", "3d ago", "5d ago"]);
    await rows.nth(1).click();
    expect(await routePath(page)).toBe(skillPath("skill-4"));
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the list's first row is Library Overview with the attention count, and opens /skills/overview with Back", async ({ page }) => {
    await open(page, "/skills");
    const list = page.locator(".master-detail-list-body");
    const first = list.locator(":scope > .row").first();
    await expect(first).toHaveClass(/\bskill-list-overview\b/);
    await expect(first.locator(".row-title")).toHaveText("Library Overview");
    await expect(first.locator(".count-badge")).toHaveText("4");
    await expect(page.locator(".master-detail-detail")).toBeHidden();

    await first.tap();
    expect(await routePath(page)).toBe("/skills/overview");
    const bar = page.locator(".detail-bar");
    await expect(bar.getByRole("heading", { level: 1 })).toHaveText("Library Overview");
    await expect(list).toBeHidden();
    await expect(overview(page)).toBeVisible();
    await expect(overview(page).locator(".skills-overview-title"), "the bar names the route").toHaveCount(0);
    await expect(section(page, "Needs Attention").locator(".skills-overview-count")).toHaveText("4");
    expect(await page.locator(".main-body").evaluate((element) => element.scrollWidth - element.clientWidth), "nothing widens the page").toBe(0);

    await bar.getByRole("button", { name: "Back to Agent Skills", exact: true }).tap();
    expect(await routePath(page)).toBe("/skills");
    await expect(list).toBeVisible();
  });
});
