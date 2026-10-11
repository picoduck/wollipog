import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { ControlPlaneDb } from "../../control-plane/src/db.js";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "../../control-plane/src/local-device-credential.js";
import { PROTOCOL_VERSION } from "@wollipog/protocol";

// Build first. Every navigation uses real isolated CP HTTP/WebSocket routes, never a warm preview.
// node --import tsx apps/web/scripts/inbox-layout-shift-benchmark.ts --output /tmp/cls/report.json
const args = process.argv.slice(2);
function option(name: string, fallback: string) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]!; }
const root = fileURLToPath(new URL("../../../", import.meta.url));
const dist = resolve(option("--dist", "apps/web/dist"));
const output = resolve(option("--output", "/tmp/inbox-layout-shift.json"));
const runs = Number(option("--runs", "7"));
const width = Number(option("--width", "390"));
assert.ok(Number.isSafeInteger(runs) && runs > 0 && runs <= 100);
assert.ok(Number.isSafeInteger(width) && width >= 320 && width <= 2000);
// Validate and fingerprint the requested bundle before starting any process. The CP must not
// silently fall back to another dist if the comparison directory is missing.
const files = ["index.html", ...(await readdir(join(dist, "assets"))).filter(name => /\.(js|css)$/.test(name)).sort().map(name => `assets/${name}`)];
const build = await Promise.all(files.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(dist, path))).digest("hex") })));
const evidence = args.includes("--evidence") ? resolve(option("--evidence", "")) : null;
if (evidence) await mkdir(evidence, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "wollipog-inbox-cls-"));
const databasePath = join(scratch, "control-plane.db");
const db = ControlPlaneDb.open(databasePath);
try {
  db.registerRunner({ runnerId: "cls-runner", hostname: "synthetic-machine", os: "linux", version: "synthetic",
    workspaces: [{ id: "cls-workspace", name: "Synthetic Project", path: "/synthetic/project" }],
    agents: [{ id: "cls-agent", name: "Synthetic Agent", command: "synthetic", args: [], env: {},
      driver: "codex-app-server", context: { kind: "native" }, available: true }] }, 1_700_000_000_000, PROTOCOL_VERSION);
  for (let index = 1; index <= 20; index++) {
    const id = `cls-session-${index}`;
    db.createSession({ id, title: `Synthetic Session ${index}`, runnerId: "cls-runner", workspaceId: "cls-workspace",
      agentId: "cls-agent", useWorktree: false, driver: "codex-app-server", config: {}, now: 1_700_000_000_000 + index });
    db.appendEvent(id, { kind: "user_message", text: "A deterministic synthetic prompt." }, 1_700_000_000_000 + index);
    db.updateSessionStatus(id, "idle", 1_700_000_000_000 + index);
  }
} finally { db.close(); }
const token = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(WOLLIPOG_|CONTROL_PLANE_|VITE_CONTROL_PLANE_|CODEX_|CLAUDE_)/.test(key)));
const portServer = createServer();
await new Promise<void>((done) => portServer.listen(0, "127.0.0.1", done));
const address = portServer.address();
assert.ok(address && typeof address !== "string");
await new Promise<void>((done, reject) => portServer.close(error => error ? reject(error) : done()));
const base = `http://127.0.0.1:${address.port}`;
const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
  cwd: root, env: { ...isolatedEnv, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(address.port),
    CONTROL_PLANE_DB: databasePath, CONTROL_PLANE_USAGE_PRICING_URL: "off", WOLLIPOG_WEB_DIST: dist },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", data => { logs = (logs + String(data)).slice(-16_384); });
child.stderr.on("data", data => { logs = (logs + String(data)).slice(-16_384); });
const samples: unknown[] = [];
const measuredCls: number[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let attempt = 0; ; attempt++) {
    assert.equal(child.exitCode, null, "isolated control plane exited before readiness");
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ }
    assert.ok(attempt < 400, "isolated control plane readiness timed out");
    await delay(50);
  }
  browser = await chromium.launch();
  for (let run = 1; run <= runs; run++) {
    const sample: Record<string, unknown> = { run };
    samples.push(sample);
    const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      // tsx preserves function names with this helper when serializing browser callbacks.
      await page.addInitScript("globalThis.__name = (target) => target;");
      await page.addInitScript((deviceToken) => {
        localStorage.setItem("wollipog.deviceToken", deviceToken);
        type Shift = PerformanceEntry & { value: number; hadRecentInput: boolean; sources: Array<{
          node: Element | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> };
        const state = { firstRowMs: null as number | null, shifts: [] as unknown[] };
        Object.assign(window, { __INBOX_CLS__: state });
        const rect = (r: DOMRectReadOnly) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
        new PerformanceObserver(list => {
          for (const entry of list.getEntries() as Shift[]) {
            if (entry.hadRecentInput) continue;
            state.shifts.push({ startTime: entry.startTime, value: entry.value, sources: entry.sources.map(source => ({
              tag: source.node?.tagName, id: source.node?.id, className: source.node?.getAttribute("class"),
              text: source.node?.textContent?.slice(0, 120), previousRect: rect(source.previousRect), currentRect: rect(source.currentRect),
            })) });
          }
        }).observe({ type: "layout-shift", buffered: true });
        const frame = () => {
          const row = document.querySelector(".inbox-row");
          if (row && row.getBoundingClientRect().height > 0) state.firstRowMs = performance.now();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }, token);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40,
        downloadThroughput: 40_000_000 / 8, uploadThroughput: 40_000_000 / 8, connectionType: "wifi" });
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await expect(page.locator(".inbox-row").first()).toBeVisible({ timeout: 30_000 });
      // Deliver the first-row frame's shift entry, then also retain shifts during settling.
      await page.waitForTimeout(1_000);
      const timing = await page.evaluate(() => {
        const state = (window as unknown as { __INBOX_CLS__: { firstRowMs: number | null;
          shifts: Array<{ startTime: number; value: number }> } }).__INBOX_CLS__;
        const cls = (entries: typeof state.shifts) => {
          let maximum = 0, total = 0, start = -Infinity, previous = -Infinity;
          for (const entry of entries) {
            if (entry.startTime - previous >= 1_000 || entry.startTime - start >= 5_000) { total = 0; start = entry.startTime; }
            total += entry.value; previous = entry.startTime; maximum = Math.max(maximum, total);
          }
          return maximum;
        };
        return { ...state, clsThroughFirstRow: cls(state.shifts.filter(s => s.startTime <= state.firstRowMs!)),
          clsSettled: cls(state.shifts), firstContentfulPaintMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
          resources: performance.getEntriesByType("resource").map(e => ({ path: new URL(e.name).pathname,
            duration: e.duration, transferSize: (e as PerformanceResourceTiming).transferSize })) };
      });
      if (evidence && run === 1) await page.screenshot({ path: join(evidence, `inbox-${width}.png`) });
      let dismissalFocus: unknown;
      if (args.includes("--probe-dismissal") && run === 1) {
        // Optional warm interaction probe, strictly after the cold measurement window.
        await page.getByRole("button", { name: "Dismiss All", exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("region", { name: "Recommended Skills", exact: true })).toBeHidden();
        dismissalFocus = await page.evaluate(() => ({ tag: document.activeElement?.tagName,
          className: document.activeElement?.getAttribute("class") }));
      }
      Object.assign(sample, timing, { errors, dismissalFocus });
      measuredCls.push(timing.clsSettled);
      console.log(JSON.stringify({ run, firstRowMs: timing.firstRowMs, clsThroughFirstRow: timing.clsThroughFirstRow,
        clsSettled: timing.clsSettled, shifts: timing.shifts, errors, dismissalFocus }));
      assert.deepEqual(errors, []);
      assert.ok(timing.firstRowMs !== null);
    } catch (error) {
      sample.failed = String(error);
      throw error;
    } finally { await context.close(); }
  }
  if (args.includes("--assert-max-cls")) assert.ok(measuredCls.every(cls => cls < Number(option("--assert-max-cls", "0.1"))), "every cold-load CLS must be strictly below threshold");
} finally {
  try {
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify({ sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceStatus: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
    measuredAt: new Date().toISOString(), node: process.version,
    lockfileSha256: createHash("sha256").update(await readFile(join(root, "pnpm-lock.yaml"))).digest("hex"),
    harnessSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
    browser: browser?.version(), viewport: { width, height: 844 }, cpuRate: 4, network: { mbps: 40, latencyMs: 40 },
    fixture: "20 fixed-timestamp synthetic sessions, one runner, real isolated CP routes; no preview/session warmup",
    cache: "fresh context per sample, browser HTTP cache disabled, service workers blocked", scratch, build, samples }, null, 2) + "\n");
  await writeFile(join(scratch, "control-plane.log"), logs);
  } finally {
    await Promise.allSettled([browser?.close(), (async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([new Promise<void>(done => child.once("exit", () => done())), delay(5_000)]);
        if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise<void>(done => child.once("exit", () => done())); }
      }
    })()]);
  }
}
