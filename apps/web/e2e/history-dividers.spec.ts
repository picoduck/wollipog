import { expect, test, type Page } from "@playwright/test";

/**
 * History dividers and Agent Logs (#2184): every divider is one neutral centred label with a faint
 * icon in both themes, and a run of nothing but harness output renders only with Show Agent Logs on.
 */

const PAGE = "/timeline-reflow-e2e.html?history=1";
const DIVIDERS = [
  "Files Rewound to Before Turn 1",
  "Forked from Turn 1",
  "Handoff from Claude Code to Codex After Turn 1",
  "Automatically Switched Account to Work",
];

async function themeColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

for (const theme of ["dark", "light"] as const) {
  test(`history dividers are neutral and centred in the ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${PAGE}&theme=${theme}`);
    const accent = await themeColor(page, "--accent");
    const dim = await themeColor(page, "--text-dim");
    const faint = await themeColor(page, "--text-faint");

    for (const name of DIVIDERS) {
      const divider = page.getByRole("separator", { name });
      await expect(divider).toBeVisible();
      const label = divider.locator(".tl-divider-label");
      await expect(label).toHaveCSS("color", dim);
      await expect(label).not.toHaveCSS("color", accent);
      await expect(label.locator(".tl-divider-icon")).toHaveCSS("color", faint);
      await expect(label.locator(".tl-divider-icon svg")).toHaveAttribute("width", "14");
      // The label sits on the divider's centre line.
      const [line, text] = await Promise.all([divider.boundingBox(), label.boundingBox()]);
      expect(Math.abs((text!.x + text!.width / 2) - (line!.x + line!.width / 2))).toBeLessThan(1.5);
    }

    // The handoff's description shares the label's centred axis.
    const handoff = page.getByRole("separator", { name: DIVIDERS[2] });
    const description = page.locator(`[id="${await handoff.getAttribute("aria-describedby")}"]`);
    await expect(description).toHaveCSS("text-align", "center");
    const [line, text] = await Promise.all([handoff.boundingBox(), description.boundingBox()]);
    expect(Math.abs((text!.x + text!.width / 2) - (line!.x + line!.width / 2))).toBeLessThan(1.5);

    // A description's link is the shared link style; it opens the source session.
    const source = page.getByRole("button", { name: "Open Source Session" }).first();
    await expect(source).toHaveClass(/(^|\s)link(\s|$)/);
    await source.click();
    await expect(page.locator("body")).toHaveAttribute("data-opened-session", "release-check");
  });
}

test("a boot-only run hides until Show Agent Logs is on, in the open transcript", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PAGE);
  const work = page.locator(".tl-work");
  await expect(work).toHaveCount(1);
  await expect(page.getByText("codex-cli 0.48.0")).toHaveCount(0);
  await expect(page.getByText("STDERR")).toHaveCount(0);

  // The Settings switch writes this store and announces the change in the same tab.
  await page.evaluate(() => {
    localStorage.setItem("wollipog.show-agent-logs", "true");
    window.dispatchEvent(new Event("wollipog:show-agent-logs-change"));
  });
  await expect(work).toHaveCount(2);
  // The fixture's own debug buttons overlap the reader on a phone; activate the trigger directly.
  await work.first().getByRole("button").dispatchEvent("click");
  const log = page.locator(".tl-step").filter({ has: page.locator(".tl-step-title", { hasText: /^Agent Log$/ }) });
  await expect(log).toHaveCount(1);
  await expect(page.getByText("STDERR")).toHaveCount(0);
});
