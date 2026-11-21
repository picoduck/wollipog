import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { approvedConfirmationText, legacyConfirmationText, longConfirmationTarget } from "../src/e2e/wollipog-prompt-fixture.js";
import { expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const evidenceDir = process.env.WOLLIPOG_CONFIRMATION_RESULTS_EVIDENCE_DIR;
const threadPath = "/assistants/~dABoAHIAXwB0AHIAaQBhAGcAZQA";
const sessionPath = "/sessions/~" + Buffer.from("sess-flaky", "utf16le").toString("base64url");

async function open(page: Page, theme: string, state: string, path = threadPath) {
  await page.goto("/assistants-e2e.html?" + new URLSearchParams({ theme, "confirmation-result": state, path }));
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function capture(page: Page, surface: string, dimensions: string, theme: string, state: string, row: Locator) {
  await expect(async () => {
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeInViewport({ ratio: 0.99, timeout: 500 });
  }).toPass({ timeout: 5_000 });
  await expect(page.locator(".composer")).toBeInViewport({ ratio: 1 });
  await expectPageNoHorizontalOverflow(page);
  const layout = await row.evaluate((element) => {
    const overflow = element.scrollWidth - element.clientWidth;
    const text = ".tl-prompt-heading > span, .tl-prompt-heading > strong, .tl-prompt-target, .status, .tl-prompt-fact, summary, .tl-prompt-message > strong, .tl-prompt-message > pre";
    const icon = ".tl-prompt-icon svg";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const pixel = canvas.getContext("2d", { willReadFrequently: true })!;
    const fill = (color: string) => {
      pixel.fillStyle = color;
      pixel.fillRect(0, 0, 1, 1);
    };
    const rgb = () => Array.from(pixel.getImageData(0, 0, 1, 1).data).slice(0, 3);
    const luminance = (color: number[]) => color.slice(0, 3).map((channel) => {
      const n = channel / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i]!, 0);
    const contrast = [...element.querySelectorAll(text + ", " + icon)].flatMap((part) => {
      if (!part.getClientRects().length) return [];
      let surface: Element | null = part;
      const backgrounds: string[] = [];
      while (surface) {
        backgrounds.push(getComputedStyle(surface).backgroundColor);
        surface = surface.parentElement;
      }
      fill("white");
      backgrounds.reverse().forEach(fill);
      const background = luminance(rgb());
      fill(getComputedStyle(part).color);
      const lightness = [background, luminance(rgb())];
      return [{ element: part.className.toString(), ratio: (Math.max(...lightness) + 0.05) / (Math.min(...lightness) + 0.05),
        minimum: part.matches(icon) ? 3 : 4.5 }];
    });
    const overhanging = [...element.querySelectorAll("*")].flatMap((child) => {
      const { right, width } = child.getBoundingClientRect();
      return width > 0 && (right > element.getBoundingClientRect().right + 1 || child.scrollWidth > child.clientWidth + 1)
        ? [child.nodeName + "." + child.getAttribute("class") + " " + right + " " + child.scrollWidth + "/" + child.clientWidth]
        : [];
    });
    return { overflow, contrast, overhanging };
  });
  expect(layout.overflow, state + " row overflow " + layout.overhanging.join(", ")).toBeLessThanOrEqual(1);
  for (const { element, ratio, minimum } of layout.contrast) {
    expect(ratio, state + " " + element + " contrast").toBeGreaterThanOrEqual(minimum);
  }
  let size = "";
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    const targets = [row.locator("summary"), ...await row.locator("button.tl-prompt-target").all()];
    const sizes = await Promise.all(targets.map((target) => target.evaluate((element) => {
      const { width, height } = element.getBoundingClientRect();
      return Math.floor(Math.min(width, height));
    })));
    const min = Math.min(...sizes);
    expect(min).toBeGreaterThanOrEqual(44);
    size = "-target" + min + "csspx";
  }
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: join(evidenceDir, ["4800", surface, dimensions, theme, state].join("-") + size + ".png") });
  }
}

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 13"]!;
for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const dimensions = width + "x" + height;
    test(theme + " " + dimensions + " confirmation results, older events and busy transcripts", async ({ browser }) => {
      test.setTimeout(60_000);
      const context = await browser.newContext({
        ...(width === 390 ? phone : {}),
        viewport: { width, height },
        colorScheme: theme,
        deviceScaleFactor: 1,
        timezoneId: "America/Chicago",
      });
      try {
        const page = await context.newPage();
        for (const [state, heading] of [
          ["approved", "You approved Archive Session"],
          ["denied", "You denied Stop Session"],
          ["expired", "Approval expired for Stop Session"],
          ["refused", "Wollipog refused Stop Session"],
          ["legacy", "You approved Archive Session"],
          ["delegation", "Delegated Decision"],
          ["scheduled", "Scheduled Wake-Up"],
        ]) {
          await open(page, theme, state!);
          const row = page.locator(".tl-wollipog-prompt");
          await expect(row.locator(".tl-prompt-heading")).toContainText(heading!);
          await expect(row.locator("details")).not.toHaveAttribute("open");
          if (state === "approved" || state === "legacy") {
            await expect(row.locator(".tl-prompt-fact")).toContainText("Wollipog ran it once · Receipt: Completed");
            await expect(row.getByRole("button", { name: /Bump the Vite Group/ })).toContainText(state === "approved" ? "Archived" : "Awaiting Input");
          } else if (state !== "delegation" && state !== "scheduled") {
            await expect(row.locator(".tl-prompt-fact")).toContainText("Nothing ran");
            await expect(row.getByRole("button", { name: /Fix the Flaky Upload Test/ })).toContainText("Running");
          }
          if (state !== "delegation" && state !== "scheduled") {
            await capture(page, "assistant-thread", dimensions, theme, state!, row);
          }
          if (state === "approved" || state === "legacy") {
            await row.getByText("Details", { exact: true }).click();
            await expect(row.getByText("Message Wollipog Sent to the Assistant")).toBeVisible();
            expect(await row.locator("pre").textContent()).toBe(state === "approved" ? approvedConfirmationText : legacyConfirmationText);
            if (state === "approved") await capture(page, "assistant-thread", dimensions, theme, "approved-expanded", row);
          }
          if (state === "denied") {
            await page.evaluate(() => (window as Window & { assistantsAdvance: () => void }).assistantsAdvance());
            await expect(row.getByRole("button", { name: /Fix the Flaky Upload Test/ })).toContainText("Completed");
          }
        }
        await open(page, theme, "stress");
        const stressedRow = page.locator('[data-confirmation-outcome="refused"]');
        await expect(stressedRow).toContainText(longConfirmationTarget);
        await capture(page, "assistant-thread", dimensions, theme, "stress", stressedRow);
        await open(page, theme, "background", sessionPath);
        const background = page.locator('[data-prompt-origin="background_result"]');
        await expect(background).toContainText("Background Work Finished");
        await expect(page.getByText("All upload tests passed.")).toBeVisible();
        await capture(page, "session", dimensions, theme, "background", background);
      } finally {
        await context.close();
      }
    });
  }
}
