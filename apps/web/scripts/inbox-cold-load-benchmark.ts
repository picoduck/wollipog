import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium, expect } from "@playwright/test";
import { installInboxFixture } from "../e2e/inbox-production-fixture.js";

// Usage: pnpm benchmark:inbox --dist <production-dist> [--runs 7] [--output report.json]
// Build each revision first. Alternate baseline/current runs on the same idle host.
const args = process.argv.slice(2);
function option(name: string, fallback: string) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]!; }
const root = resolve(option("--dist", "apps/web/dist"));
const runs = Number(option("--runs", "7"));
const width = Number(option("--width", "390"));
assert.ok(Number.isSafeInteger(runs) && runs > 0 && runs <= 100);
assert.ok(Number.isSafeInteger(width) && width >= 320 && width <= 2000);
const evidence = args.includes("--evidence") ? resolve(option("--evidence", "")) : null;
if (evidence) await mkdir(evidence, { recursive: true });
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url!, "http://localhost").pathname;
    const file = resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const bytes = await readFile(file);
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
const browser = await chromium.launch();
const samples = [];
try {
  for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installInboxFixture(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Performance.enable");
    const trace: Array<{ name: string; ph: string; dur?: number; args?: unknown }> = [];
    cdp.on("Tracing.dataCollected", ({ value }) => trace.push(...value));
    await cdp.send("Tracing.start", { categories: "devtools.timeline,v8", options: "record-as-much-as-possible" });
    await page.addInitScript(() => {
      const longTasks: number[] = [];
      Object.assign(window, { __INBOX_LONG_TASKS__: longTasks });
      new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)))
        .observe({ type: "longtask", buffered: true });
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await expect(page.getByRole("grid", { name: "Sessions", exact: true }).getByText("Synthetic Session 1", { exact: true })).toBeVisible();
    // Let observer delivery and the initial paint settle; no interaction is included in samples.
    await page.waitForTimeout(200);
    const metrics = await cdp.send("Performance.getMetrics");
    const finished = new Promise<void>((done) => cdp.once("Tracing.tracingComplete", () => done()));
    await cdp.send("Tracing.end");
    await finished;
    const evaluations = trace.filter((event) => event.ph === "X" && ["EvaluateScript", "v8.evaluateModule"].includes(event.name));
    const timing = await page.evaluate(() => ({
      longTasks: (window as unknown as { __INBOX_LONG_TASKS__: number[] }).__INBOX_LONG_TASKS__,
      firstContentfulPaintMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
      requestedScripts: performance.getEntriesByType("resource").map((entry) => entry.name).filter((url) => /\.js(?:$|\?)/.test(url)).map((url) => new URL(url).pathname),
    }));
    assert.deepEqual(errors, [], "production inbox must render without uncaught errors");
    const sample = { run: run + 1, maxScriptEvaluationMs: Math.max(0, ...evaluations.map((event) => (event.dur ?? 0) / 1000)),
      totalScriptDurationMs: (metrics.metrics.find((metric) => metric.name === "ScriptDuration")?.value ?? 0) * 1000,
      maxLongTaskMs: Math.max(0, ...timing.longTasks), ...timing };
    samples.push(sample);
    console.log(JSON.stringify({ run: sample.run, maxScriptEvaluationMs: sample.maxScriptEvaluationMs,
      totalScriptDurationMs: sample.totalScriptDurationMs, maxLongTaskMs: sample.maxLongTaskMs,
      firstContentfulPaintMs: sample.firstContentfulPaintMs }));
    if (evidence && run === 0) {
      if (width > 760) await expect(page.locator(".detail-bar-title")).toBeVisible();
      await page.screenshot({ path: resolve(evidence, `inbox-${width}.png`) });
    }
    await context.close();
  }
  const median = (key: "maxScriptEvaluationMs" | "maxLongTaskMs" | "totalScriptDurationMs") =>
    samples.map((sample) => sample[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  const report = { browser: browser.version(), viewport: { width, height: 844 }, cpuRate: 4,
    fixture: "20 deterministic synthetic sessions; same-origin API and socket interception", cache: "fresh context; HTTP and browser cache disabled",
    medians: { maxScriptEvaluationMs: median("maxScriptEvaluationMs"), maxLongTaskMs: median("maxLongTaskMs"), totalScriptDurationMs: median("totalScriptDurationMs") }, samples };
  console.log(JSON.stringify({ ...report, samples: undefined, runs: samples.length }));
  if (args.includes("--output")) await writeFile(resolve(option("--output", "")), JSON.stringify(report, null, 2) + "\n");
} finally {
  await browser.close();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}
