import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { viewPath } from "../src/navigation.js";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

const EVIDENCE_DIR = process.env.STREAMING_MARKDOWN_EVIDENCE_DIR;
const paths = {
  assistant: viewPath({ name: "assistants", threadId: "thr_triage" }),
  session: viewPath({ name: "session", id: "sess-triage" }),
};
type Surface = keyof typeof paths;
const reply = (page: Page) => page.locator(".tl-agent-msg .md");
const caret = (page: Page) => reply(page).locator(".md-streaming-caret");
const prompt = "What did you find in the tracker review?";

async function open(page: Page, surface: Surface) {
  await page.goto(`/assistants-e2e.html?streaming-reply&path=${encodeURIComponent(paths[surface])}`);
  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
}

async function stream(page: Page, text: string, settle = false) {
  await page.evaluate(({ text, settle }) => {
    (window as unknown as { assistantsReplyChunk(text: string, settle: boolean): void }).assistantsReplyChunk(text, settle);
  }, { text, settle });
}

for (const surface of ["assistant", "session"] as const) {
  test(`streams Tracker Reconciliation without literal markers in the ${surface} transcript`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, surface);
    for (const [chunk, visible] of [
      ["Verified that ", "Verified that"], ["*", "Verified that"], ["*", "Verified that"],
      ["Tracker ", "Verified that Tracker"], ["Reconciliation", "Verified that Tracker Reconciliation"],
      ["*", "Verified that Tracker Reconciliation"], ["*", "Verified that Tracker Reconciliation"],
    ]) {
      await stream(page, chunk!);
      await expect(reply(page)).toHaveText(visible!);
      await expect(caret(page)).toBeVisible();
    }
    await expect(reply(page).locator("strong")).toHaveText("Tracker Reconciliation");
    await expect(caret(page)).toHaveCSS("animation-name", "none");
    await stream(page, " is ready.");
    await expect(reply(page)).toHaveText("Verified that Tracker Reconciliation is ready.");
    await stream(page, "", true);
    await expect(caret(page)).toHaveCount(0);
    await expect(reply(page).locator("strong")).toHaveText("Tracker Reconciliation");
  });
}

async function touchTarget(control: Locator) {
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const after = getComputedStyle(element, "::after");
    const width = rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    const height = rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
    return after.position === "absolute" && after.content !== "none"
      ? Math.min(width - parseFloat(after.left) - parseFloat(after.right), height - parseFloat(after.top) - parseFloat(after.bottom))
      : Math.min(rect.width, rect.height);
  });
}

async function contrast(locator: Locator) {
  return locator.evaluate((element) => {
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    function color(source: string) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = source;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    }
    let background = [255, 255, 255];
    const layers: number[][] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const layer = color(getComputedStyle(node).backgroundColor);
      layers.push(layer);
      if (layer[3] === 255) break;
    }
    for (const [r, g, b, alpha] of layers.reverse()) {
      background = [r!, g!, b!].map((channel, index) => (channel * alpha! + background[index]! * (255 - alpha!)) / 255);
    }
    function luminance([r, g, b]: number[]) {
      const linear = [r!, g!, b!].map((channel) => {
        const s = channel / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
    }
    const a = luminance(color(getComputedStyle(element).color));
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test("captures streaming reply states at both widths and themes", async ({ browser }) => {
  test.skip(!EVIDENCE_DIR, "evidence capture only");
  test.setTimeout(180_000);
  mkdirSync(EVIDENCE_DIR!, { recursive: true });
  // Use the configured browser fixture and Chromium device emulation for real coarse-pointer CSS.
  for (const theme of ["light", "dark"] as const) {
    for (const phone of [false, true]) {
      const context = await browser.newContext({
        ...(phone ? devices["iPhone 13"] : {}),
        viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        colorScheme: theme, reducedMotion: "reduce", deviceScaleFactor: 1,
      });
      try {
        const page = await context.newPage();
        const { width, height } = page.viewportSize()!;
        const capture = async (surface: Surface, state: string, focal: Locator) => {
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(phone);
          await expect(focal).toBeInViewport();
          const composer = page.locator(".composer");
          await expectFullyInViewport(composer, "The composer");
          await expectPageNoHorizontalOverflow(page);
          await expectNoHorizontalOverflow(page.locator(".detail-scroll"), "The transcript");
          expect(await contrast(focal)).toBeGreaterThanOrEqual(4.5);
          const liveCaret = caret(page);
          if (await liveCaret.count()) {
            await expect(liveCaret).toHaveCSS("animation-name", "none");
            // The caret uses currentColor, so the adjacent content must contrast with its backdrop.
            expect(await contrast(liveCaret.locator(".."))).toBeGreaterThanOrEqual(3);
          }
          let measured = "";
          const controls = reply(page).getByRole("button");
          if (phone && await controls.count()) {
            const sizes = await Promise.all((await controls.all()).map(touchTarget));
            const smallest = Math.min(...sizes);
            expect(smallest).toBeGreaterThanOrEqual(44);
            measured = `-target${smallest}csspx`;
          }
          await page.screenshot({ path: join(EVIDENCE_DIR!, `4804-${surface}-${width}x${height}-${theme}-${state}${measured}.png`) });
        };

        for (const surface of ["assistant", "session"] as const) {
          await open(page, surface);
          await stream(page, "Verified that **Tracker Reconciliation");
          const bold = reply(page).locator("strong");
          await expect(reply(page)).toHaveText("Verified that Tracker Reconciliation");
          await expect(caret(page)).toBeInViewport();
          await capture(surface, "bold", bold);
        }
        await stream(page, "** is ready.");
        await stream(page, "", true);
        await expect(reply(page)).toHaveText("Verified that Tracker Reconciliation is ready.");
        await expect(caret(page)).toHaveCount(0);
        await capture("session", "settled", reply(page).locator("strong"));

        await open(page, "session");
        await stream(page, "The verification command is below.\n\n```sh\npnpm test:fast\npnpm test:e2e");
        await expect(reply(page).locator("pre code")).toContainText("pnpm test:e2e");
        await expect(caret(page)).toBeInViewport();
        await capture("session", "open-fence", reply(page).locator("pre code"));

        await open(page, "assistant");
        await stream(page, "Compare [Tracker Reconciliation report](https://example.test/reconcili");
        const link = reply(page).locator(".md-streaming-link");
        await expect(link).toHaveText("Tracker Reconciliation report");
        await expect(reply(page).getByRole("link")).toHaveCount(0);
        await expect(caret(page)).toBeInViewport();
        await capture("assistant", "unfinished-link", link);

        await open(page, "session");
        await stream(page, "The results so far:\n\n| Check | Result |\n| --- |");
        await expect(reply(page)).toContainText("| Check | Result |");
        await expect(reply(page).locator("table")).toHaveCount(0);
        await expect(caret(page)).toBeInViewport();
        await capture("session", "partial-table", reply(page).locator("p").last());

        await open(page, "assistant");
        const paragraphs = Array.from({ length: 8 }, (_, index) =>
          `Pass ${index + 1}. I compared the tracker entries with their verification records and retained the decisions that matched the latest review.`);
        await stream(page, paragraphs.join("\n\n"));
        await stream(page, "\n\nNext I am checking **the remaining reconciliation notes across all projects");
        await expect(reply(page).locator("p")).toHaveCount(9);
        await expect(reply(page).locator("strong")).toHaveText("the remaining reconciliation notes across all projects");
        await expect(caret(page)).toBeInViewport();
        await capture("assistant", "long-reply", reply(page).locator("strong"));
      } finally {
        await context.close();
      }
    }
  }
});
