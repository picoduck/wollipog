import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "../../control-plane/src/local-device-credential.js";
import { previewRetainers } from "./fixtures/heap-retainers.js";
import { RETENTION_SESSION_COUNT, retentionPrompt, retentionSessionTitle, seedSessionRetention } from "./fixtures/session-retention-seed.js";

// Reproduce against any clean source tree, including historical 67165338e:
// SESSION_RETENTION_REFERENCE_ROOT=/path/to/source SESSION_RETENTION_EVIDENCE_DIR=/private/path \
//   pnpm exec playwright test apps/web/e2e/session-detail-retention-live.spec.ts
// The production bundle and CP are separate, synthetic processes, never the hosting stack.
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const referenceRoot = process.env.SESSION_RETENTION_REFERENCE_ROOT || root;
const evidenceDir = process.env.SESSION_RETENTION_EVIDENCE_DIR;
let scratch: string;
let base: string;
let token: string;
let child: ChildProcess | undefined;
let logs = "";
let assetSha256: string;

// Playwright tracing snapshots inject their own DOM/style observers and can retain inspected
// elements. This probe measures the production application without that additional owner.
test.use({ trace: "off" });

function isolatedEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("WOLLIPOG_") && !key.startsWith("VITE_CONTROL_PLANE_") &&
    !key.startsWith("CONTROL_PLANE_") && !key.startsWith("CODEX_") && !key.startsWith("CLAUDE_")));
}

test.beforeAll(async ({}, info) => {
  info.setTimeout(180_000);
  scratch = mkdtempSync(join(tmpdir(), "wollipog-session-retention-"));
  const databasePath = join(scratch, "control-plane.db");
  const dist = join(scratch, "dist");
  seedSessionRetention(databasePath);
  token = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));
  const built = spawnSync("pnpm", ["--dir", "apps/web", "exec", "vite", "build", "--outDir", dist, "--sourcemap"], {
    cwd: referenceRoot, encoding: "utf8", timeout: 120_000, env: isolatedEnv(),
  });
  if (built.status !== 0 || !existsSync(join(dist, "index.html"))) {
    throw new Error(`production build failed: ${built.stderr?.slice(-2_000)} ${built.stdout?.slice(-2_000)}`);
  }
  const assets = readdirSync(join(dist, "assets")).filter(name => name.endsWith(".js")).sort();
  const hash = createHash("sha256");
  for (const asset of assets) hash.update(asset).update("\0").update(readFileSync(join(dist, "assets", asset)));
  assetSha256 = hash.digest("hex");
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no retention probe port");
  const port = address.port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  base = `http://127.0.0.1:${port}`;
  // Use the current seed-compatible CP for every reference bundle. Only browser source changes;
  // the transport, complete synthetic event rows and measurements stay identical.
  child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: root, env: { ...isolatedEnv(), CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: databasePath, CONTROL_PLANE_USAGE_PRICING_URL: "off", WOLLIPOG_WEB_DIST: dist },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", data => { logs = (logs + String(data)).slice(-8_192); });
  child.stderr?.on("data", data => { logs = (logs + String(data)).slice(-8_192); });
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(`isolated CP exited: ${logs}`);
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* starting */ }
    await delay(50);
  }
  throw new Error(`isolated CP did not start: ${logs}`);
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise<void>(done => child!.once("exit", () => done())), delay(5_000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise<void>(done => child!.once("exit", () => done())); }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function snapshot(cdp: CDPSession) {
  const chunks: string[] = [];
  const receive = ({ chunk }: { chunk: string }) => chunks.push(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", receive);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    return chunks.join("");
  } finally { cdp.off("HeapProfiler.addHeapSnapshotChunk", receive); }
}

async function select(page: Page, index: number) {
  const row = page.locator(".inbox-row", { hasText: retentionSessionTitle(index) });
  await row.click();
  await expect(page.locator(".session-detail.preview").getByText(retentionPrompt(index), { exact: true })).toBeVisible();
  await expect(page.locator(".session-detail.preview [data-virtual-measurements=ready]")).toHaveCount(1);
  // A weak reference records the real root, with no closure holding the node. Repeated visits
  // must collect their retired roots; a counter reset cannot make this check pass.
  await page.evaluate(() => {
    const probe = window as typeof window & { __retiredPreviews?: WeakRef<Element>[]; __seenPreviews?: WeakSet<Element> };
    probe.__retiredPreviews ??= [];
    probe.__seenPreviews ??= new WeakSet();
    const node = document.querySelector(".session-detail.preview")!;
    if (!probe.__seenPreviews.has(node)) {
      probe.__seenPreviews.add(node);
      probe.__retiredPreviews.push(new WeakRef(node));
    }
  });
}

test("ten nine-session production cycles release detached previews and keep DOM/listeners stable after GC", async ({ page }, info) => {
  // Keep retry captures separate: a later passing attempt must not overwrite a failed series.
  const attemptEvidenceDir = evidenceDir && (info.retry === 0 ? evidenceDir : join(evidenceDir, `retry-${info.retry}`));
  const cycles = Number(process.env.SESSION_RETENTION_CYCLES || 10);
  if (!Number.isInteger(cycles) || cycles < 10 || cycles > 100) throw new Error("SESSION_RETENTION_CYCLES must be from 10 through 100");
  info.setTimeout(120_000 + cycles * 5_000);
  // All nine virtualized rows fit, on both the historical and current Sessions layouts.
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.goto(`${base}/#pair=${token}`);
  await expect(page.locator(".session-detail.preview")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("radio", { name: "List", exact: true }).click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const samples: Array<{ cycle: number; nodes: number; listeners: number; heapBytes: number; detachedWeakRoots: number }> = [];
  const navigateCycle = async () => {
    for (let index = 0; index < RETENTION_SESSION_COUNT; index++) await select(page, index);
    await select(page, 0);
    // Let pending scroll/frame and seen-dwell work settle, then collect real browser objects.
    await page.waitForTimeout(2_100);
    await cdp.send("HeapProfiler.collectGarbage");
  };
  await navigateCycle();
  await navigateCycle();
  if (attemptEvidenceDir) {
    mkdirSync(attemptEvidenceDir, { recursive: true });
    writeFileSync(join(attemptEvidenceDir, "early.heapsnapshot"), await snapshot(cdp));
  }
  for (let cycle = 0; cycle <= cycles; cycle++) {
    if (cycle > 0) await navigateCycle();
    const counters = await cdp.send("Memory.getDOMCounters");
    const perf = await cdp.send("Performance.getMetrics");
    const detachedWeakRoots = await page.evaluate(() => {
      const probe = window as typeof window & { __retiredPreviews: WeakRef<Element>[] };
      return probe.__retiredPreviews.filter(ref => { const node = ref.deref(); return node && !node.isConnected; }).length;
    });
    samples.push({ cycle, nodes: counters.nodes, listeners: counters.jsEventListeners,
      heapBytes: perf.metrics.find(metric => metric.name === "JSHeapUsedSize")!.value, detachedWeakRoots });
  }
  const raw = await snapshot(cdp);
  const retainers = previewRetainers(raw);
  const sourceRevision = process.env.SESSION_RETENTION_REFERENCE_SHA || spawnSync("git", ["rev-parse", "HEAD"],
    { cwd: referenceRoot, encoding: "utf8" }).stdout.trim() || "source-archive";
  const gitStatus = spawnSync("git", ["status", "--porcelain"], { cwd: referenceRoot, encoding: "utf8" });
  const sourceDirty = gitStatus.status === 0 ? Boolean(gitStatus.stdout.trim()) : null;
  const report = { sourceRevision, sourceDirty, assetSha256, retry: info.retry,
    browserVersion: page.context().browser()?.version() ?? "unknown",
    engineMode: info.project.use.launchOptions?.args?.includes("--js-flags=--jitless") ? "jitless" : "default",
    sessions: RETENTION_SESSION_COUNT, warmupCycles: 2, measuredCycles: cycles,
    samples, ...retainers, heapTrendBytesPerCycle: (samples.at(-1)!.heapBytes - samples[0]!.heapBytes) / cycles };
  // CI does not currently upload this test's attachment. Emit only synthetic primitive metadata
  // and counters before assertions so an initial failure stays inspectable after a passing retry.
  console.info("session-retention-measurements", JSON.stringify({ ...report, retainerPath: undefined }));
  await info.attach("session-retention.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  // Preserve before assertions, including when the reference build intentionally fails.
  if (attemptEvidenceDir) {
    mkdirSync(attemptEvidenceDir, { recursive: true });
    writeFileSync(join(attemptEvidenceDir, "measurements.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(attemptEvidenceDir, "final.heapsnapshot"), raw);
    await page.screenshot({ path: join(attemptEvidenceDir, "desktop.png") });
  }
  expect(retainers.detachedPreviewRoots, JSON.stringify(retainers.retainerPath)).toBe(0);
  expect(Math.max(...samples.map(sample => sample.detachedWeakRoots))).toBe(0);
  expect(Math.max(...samples.map(sample => sample.nodes)) - Math.min(...samples.map(sample => sample.nodes))).toBeLessThanOrEqual(20);
  expect(Math.max(...samples.map(sample => sample.listeners)) - Math.min(...samples.map(sample => sample.listeners))).toBeLessThanOrEqual(2);
});
