import { build, preview } from "vite";
import { chromium } from "@playwright/test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpus, platform, arch } from "node:os";
import { transcriptScrollEvents } from "../src/e2e/transcript-scroll-fixture.js";

// pnpm exec tsx apps/web/scripts/transcript-scroll-benchmark.ts /tmp/scroll-baseline 5
// Build and serve only this synthetic fixture; never uses the hosting control plane.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(process.argv[2] ?? "/tmp/wollipog-scroll-benchmark");
const trials = Number(process.argv[3] ?? 5);
const cpuRate = Number(process.env.SCROLL_BENCHMARK_CPU_RATE ?? 4);
if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error("trials must be 1–20");
if (![1, 4].includes(cpuRate)) throw new Error("CPU rate must be 1 or 4");
await mkdir(output, { recursive: true });
const dist = resolve(output, "dist");
const sourceSnapshot = { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() };
if (process.env.SCROLL_BENCHMARK_REUSE_DIST !== "1") {
  await build({ root, mode: "production-e2e", build: { outDir: dist, emptyOutDir: true,
    sourcemap: true, rolldownOptions: { input: resolve(root, "transcript-scroll-e2e.html") } } });
  await writeFile(resolve(output, "build-snapshot.json"), JSON.stringify(sourceSnapshot, null, 2));
}
const server = await preview({ root, mode: "production-e2e", build: { outDir: dist },
  preview: { host: "127.0.0.1", port: 0, strictPort: true } });
const address = server.httpServer.address();
if (!address || typeof address === "string") throw new Error("benchmark server has no port");
const browser = await chromium.launch({ headless: true });
const data = transcriptScrollEvents();
if (data.length !== 10_503) throw new Error("benchmark requires exactly 10,503 events");
await writeFile(resolve(output, "events.json"), JSON.stringify(data));
const results: unknown[] = [];
const quantile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
try {
  for (let trial = 1; trial <= trials; trial++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // tsx preserves nested function names with this helper when serializing page.evaluate.
    await page.addInitScript("window.__name = (value) => value");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
    await page.goto(`http://127.0.0.1:${address.port}/transcript-scroll-e2e.html`);
    await page.waitForSelector('[data-virtual-measurements="ready"]');
    await page.evaluate(() => new Promise<void>(done => {
      const reader = document.querySelector<HTMLElement>('[data-testid="reader"]')!;
      reader.scrollTop = reader.scrollHeight;
      let frames = 30;
      const settle = () => { if (--frames === 0) done(); else requestAnimationFrame(settle); };
      requestAnimationFrame(settle);
    }));
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
    await cdp.send("Profiler.start");
    const measured = await page.evaluate(() => new Promise<{ frames: number[]; elapsedMs: number; start: number; end: number; mountedRows: number }>(done => {
      const reader = document.querySelector<HTMLElement>('[data-testid="reader"]')!;
      const start = reader.scrollTop;
      const frames: number[] = [];
      let last = performance.now();
      const began = last;
      let mountedRows = 0;
      // Move 400 CSS px per painted frame. All trials cover the entire newest-to-top traversal.
      const tick = (now: number) => {
        frames.push(now - last);
        last = now;
        mountedRows = Math.max(mountedRows, reader.querySelectorAll('[data-virtual-row]').length);
        if (reader.scrollTop <= 1) { done({ frames, elapsedMs: now - began, start, end: reader.scrollTop, mountedRows }); return; }
        reader.scrollTop = Math.max(0, reader.scrollTop - 400);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    const profile = await cdp.send("Profiler.stop");
    const cache = await page.evaluate(() => (window as unknown as {
      __transcriptScrollCache?: () => unknown;
    }).__transcriptScrollCache?.());
    await writeFile(resolve(output, `trial-${trial}.cpuprofile`), JSON.stringify(profile.profile));
    await writeFile(resolve(output, `trial-${trial}.frames.json`), JSON.stringify(measured));
    const result = { trial, ...measured, frames: measured.frames.length, cache,
      p50: quantile(measured.frames, 0.5), p95: quantile(measured.frames, 0.95),
      p99: quantile(measured.frames, 0.99), max: Math.max(...measured.frames),
      over34: measured.frames.filter(value => value > 34).length,
      over50: measured.frames.filter(value => value >= 50).length, errors };
    results.push(result);
    console.log(JSON.stringify(result));
    await page.close();
  }
  if (process.env.SCROLL_BENCHMARK_EVIDENCE === "1") {
    for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`http://127.0.0.1:${address.port}/transcript-scroll-e2e.html`);
      await page.waitForSelector('[data-virtual-measurements="ready"]');
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
        document.querySelector<HTMLElement>('[data-testid="reader"]')!.scrollTop = 0;
      }, theme);
      await page.locator(".md-table-wrap").first().waitFor({ state: "visible" });
      await page.waitForTimeout(1_000);
      await page.screenshot({ path: resolve(output, `evidence-${width}-${theme}.png`) });
      if (width === 390) {
        const table = page.locator(".md-table-wrap").first();
        await table.focus();
        await table.evaluate(element => { element.scrollLeft = element.scrollWidth; });
        await page.waitForTimeout(500);
        await page.screenshot({ path: resolve(output, `evidence-${width}-${theme}-table-end.png`) });
      }
      await page.close();
    }
  }
  if (process.env.SCROLL_BENCHMARK_RECORD_VIDEO === "1") {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
      recordVideo: { dir: resolve(output, "video"), size: { width: 1280, height: 900 } } });
    await context.addInitScript("window.__name = (value) => value");
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
    await page.goto(`http://127.0.0.1:${address.port}/transcript-scroll-e2e.html`);
    await page.waitForSelector('[data-virtual-measurements="ready"]');
    await page.evaluate(() => {
      // Capture-only pointer: Chromium's video recorder does not include the OS cursor.
      const pointer = document.createElement("div");
      pointer.setAttribute("aria-hidden", "true");
      Object.assign(pointer.style, { position: "fixed", width: "12px", height: "12px",
        border: "2px solid white", background: "#222", borderRadius: "50%", pointerEvents: "none", zIndex: "2147483647" });
      document.body.append(pointer);
      addEventListener("pointermove", event => Object.assign(pointer.style, { left: `${event.clientX - 6}px`, top: `${event.clientY - 6}px` }));
    });
    await page.mouse.move(1100, 700);
    await page.waitForTimeout(2_500);
    // A readable, paced scroll, separate from the measured traversal and ordinary test paths.
    for (let step = 0; step < 20; step++) {
      await page.mouse.wheel(0, 60);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(2_000);
    for (let step = 0; step < 20; step++) {
      await page.mouse.wheel(0, -60);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(3_500);
    const video = page.video()!;
    await context.close();
    await video.saveAs(resolve(output, "evidence-scroll-4x.webm"));
    await video.delete();
  }
  const assets = (await readdir(resolve(dist, "assets"))).filter(name => name.endsWith(".js")).sort();
  const assetHashes = await Promise.all(assets.map(async name => ({ name,
    sha256: createHash("sha256").update(await readFile(resolve(dist, "assets", name))).digest("hex") })));
  const report = { sourceSnapshot, reusedDist: process.env.SCROLL_BENCHMARK_REUSE_DIST === "1", assetHashes,
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    browser: browser.version(), cpuRate, viewport: { width: 1280, height: 900 },
    events: data.length, dataSha256: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    sampling: "requestAnimationFrame deltas; 400 CSS px/frame; fresh page per trial; full newest-to-top traversal; CDP profiler 1ms sampling",
    results };
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise<void>((done, reject) => server.httpServer.close(error => error ? reject(error) : done()));
}
