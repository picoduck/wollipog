import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "../../control-plane/src/local-device-credential.js";
import { COLD_SESSION_ID, COLD_NAV_SESSION_ID, COLD_NAV_PROMPT, seedColdHistoryPreview, connectColdHistoryRunner } from "./fixtures/cold-history-preview.js";
import { viewPath } from "../src/navigation.js";
import { LONG_TURN_SESSION_ID, LONG_TURN_START_SEQ, LONG_TURN_PROMPT, seedLongTurnOpening } from "./fixtures/long-turn-opening-seed.js";

// Reproduce: pnpm exec playwright test apps/web/e2e/long-turn-opening-live.spec.ts
// Optional evidence/metrics: LONG_TURN_OPENING_EVIDENCE_DIR=/absolute/private/path
// Opt-in paced interaction video: LONG_TURN_OPENING_RECORD_VIDEO=1 (requires evidence directory).
// Serves a separate CP and production bundle. Never connects to or signals the hosting stack.
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const referenceRoot = process.env.LONG_TURN_OPENING_REFERENCE_ROOT || root;
const evidenceDir = process.env.LONG_TURN_OPENING_EVIDENCE_DIR;
let scratch: string;
let base: string;
let token: string;
let child: ChildProcess | undefined;
let logs = "";
let coldRunner: Awaited<ReturnType<typeof connectColdHistoryRunner>> | undefined;

function isolatedEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("WOLLIPOG_") && !key.startsWith("VITE_CONTROL_PLANE_") &&
    !key.startsWith("CONTROL_PLANE_") && !key.startsWith("CODEX_") && !key.startsWith("CLAUDE_")));
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({}, info) => {
  info.setTimeout(180_000);
  scratch = mkdtempSync(join(tmpdir(), "wollipog-long-turn-opening-"));
  const databasePath = join(scratch, "control-plane.db");
  const dist = join(scratch, "web-dist");
  seedLongTurnOpening(databasePath);
  const coldFixture = seedColdHistoryPreview(databasePath, join(scratch, "runner-store"));
  token = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));
  const built = spawnSync("pnpm", ["--dir", "apps/web", "exec", "vite", "build", "--outDir", dist], {
    cwd: referenceRoot, encoding: "utf8", timeout: 120_000, env: isolatedEnv(),
  });
  if (built.status !== 0 || !existsSync(join(dist, "index.html"))) {
    throw new Error(`production build failed: ${built.stderr?.slice(-2_000)} ${built.stdout?.slice(-2_000)}`);
  }
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no benchmark port");
  const port = address.port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: referenceRoot, env: { ...isolatedEnv(), CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: databasePath, CONTROL_PLANE_USAGE_PRICING_URL: "off", WOLLIPOG_WEB_DIST: dist },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", data => { logs = (logs + String(data)).slice(-8_192); });
  child.stderr?.on("data", data => { logs = (logs + String(data)).slice(-8_192); });
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(`isolated control plane exited: ${logs}`);
    let healthy = false;
    try { healthy = (await fetch(`${base}/healthz`)).ok; } catch { /* starting */ }
    if (healthy) { coldRunner = await connectColdHistoryRunner(base, coldFixture); return; }
    await delay(50);
  }
  throw new Error(`isolated control plane did not start: ${logs}`);
});

test.afterAll(async () => {
  coldRunner?.stop();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise<void>(done => child!.once("exit", () => done())), delay(5_000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise<void>(done => child!.once("exit", () => done())); }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function signIn(page: Page) {
  // Warm a fixed different session. The Inbox can select and fetch the measured session's
  // preview before navigation, turning a cold-opening measurement into a cached one.
  await page.goto(`${base}${viewPath({ name: "session", id: "opening-welcome" })}#pair=${token}`);
  await expect(page.getByText("Opening Benchmark Ready").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Warm the application before measuring navigation.", { exact: true })).toBeVisible();
}

for (const rate of [1, 4]) test(`a 10,503-event production opening starts at the current turn at ${rate}x CPU`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const requests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === `/api/sessions/${LONG_TURN_SESSION_ID}/events`) requests.push(request.url());
  });
  await signIn(page);
  expect(requests).toHaveLength(0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await page.evaluate((path) => {
    const state = { started: performance.now(), interactiveMs: 0, firstVisibleKey: "", frames: [] as string[], longTasks: [] as number[] };
    (window as unknown as { __openingMeasurement: typeof state }).__openingMeasurement = state;
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.startTime >= state.started) state.longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: true });
    const frame = () => {
      const reader = document.querySelector<HTMLElement>(".detail-scroll");
      const ready = reader?.querySelector('[data-virtual-measurements="ready"]');
      if (reader && ready) {
        const bounds = reader.getBoundingClientRect();
        const row = [...ready.querySelectorAll<HTMLElement>("[data-virtual-row]")].find(candidate => {
          const rect = candidate.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        if (row) {
          const key = row.dataset.virtualKey!;
          state.firstVisibleKey ||= key;
          state.frames.push(key);
          const control = document.querySelector<HTMLButtonElement>("[data-later-activity-gap] button, .tl-earlier button");
          if (control && !control.disabled && reader.getAttribute("aria-busy") !== "true") {
            state.interactiveMs = performance.now() - state.started;
            requestAnimationFrame(() => observer.disconnect());
            return;
          }
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, viewPath({ name: "session", id: LONG_TURN_SESSION_ID }));
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __openingMeasurement: { interactiveMs: number } }).__openingMeasurement.interactiveMs,
  ), { timeout: 15_000 }).toBeGreaterThan(0);
  const measured = await page.evaluate(() =>
    (window as unknown as { __openingMeasurement: { interactiveMs: number; firstVisibleKey: string; frames: string[]; longTasks: number[] } }).__openingMeasurement);
  const openingRequests = requests.filter(url => new URL(url).searchParams.get("opening") === "current-turn");
  const report = { rate, events: 10_503, toolSteps: 1_500, ...measured,
    requestCount: requests.length, openingRequestCount: openingRequests.length,
    longestTaskMs: Math.max(0, ...measured.longTasks) };
  await info.attach(`opening-${rate}x.json`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  // Save before asserting so running against a reference checkout retains its failing baseline.
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `opening-${rate}x.json`), JSON.stringify(report, null, 2));
    await page.screenshot({ path: join(evidenceDir, `opening-${rate}x-desktop.png`) });
  }
  expect(report.firstVisibleKey).toBe(`item:user_message:${LONG_TURN_START_SEQ}`);
  expect(report.interactiveMs).toBeLessThan(1_000);
  expect(report.longestTaskMs).toBeLessThanOrEqual(200);
  expect(report.requestCount).toBeLessThanOrEqual(2);
  expect(report.openingRequestCount).toBe(1);
  await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
  await expect(page.locator(".detail-scroll")).toHaveAttribute("data-follow-tail-state", "paused");
  await expect(page.getByRole("button", { name: "Load Later Activity", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load Later Activity", exact: true }).click();
  await expect.poll(() => requests.filter(url => new URL(url).searchParams.has("after")).length).toBe(1);
  await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
});

test("the turn-start reader preserves its opening position across viewport and theme variants", async ({ page }) => {
  for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await signIn(page);
    await page.evaluate(theme => localStorage.setItem("wollipog.theme", theme), theme);
    await page.reload();
    await expect(page.getByText("Opening Benchmark Ready").first()).toBeVisible();
    await page.evaluate(path => {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, viewPath({ name: "session", id: LONG_TURN_SESSION_ID }));
    await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
    await expect(page.locator(".detail-scroll")).toHaveAttribute("data-follow-tail-state", "paused");
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `after-${width}-${theme}.png`) });
    await page.getByRole("button", { name: "Load Later Activity", exact: true }).click();
    await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `later-${width}-${theme}.png`) });
  }
});

test("paced evidence of opening and loading later activity", async ({ browser }) => {
  test.skip(process.env.LONG_TURN_OPENING_RECORD_VIDEO !== "1" || !evidenceDir, "opt-in private evidence capture");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
    recordVideo: { dir: join(scratch, "video"), size: { width: 1280, height: 900 } } });
  const page = await context.newPage();
  try {
    await signIn(page);
    await delay(2_000);
    await page.evaluate(path => {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, viewPath({ name: "session", id: LONG_TURN_SESSION_ID }));
    await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
    await expect(page.locator(".detail-scroll")).toHaveAttribute("data-follow-tail-state", "paused");
    await delay(3_000);
    const later = page.getByRole("button", { name: "Load Later Activity", exact: true });
    await later.focus();
    await delay(1_500);
    const response = page.waitForResponse(response => new URL(response.url()).pathname ===
      `/api/sessions/${LONG_TURN_SESSION_ID}/events` && new URL(response.url()).searchParams.has("after"));
    await later.click();
    await response;
    await expect(later).toBeEnabled();
    await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
    await delay(4_000);
    const jump = page.getByRole("button", { name: "Jump to Latest", exact: true });
    await jump.focus();
    await delay(1_500);
    await jump.click();
    await expect(page.locator("[data-later-activity-gap]")).toHaveCount(0);
    await expect(page.locator(".detail-scroll")).toHaveAttribute("data-follow-tail-state", "following");
    await delay(4_000);
  } finally {
    await context.close();
  }
  mkdirSync(evidenceDir!, { recursive: true });
  copyFileSync(await page.video()!.path(), join(evidenceDir!, "opening-and-load-later.webm"));
});


for (const rate of [1, 4]) test(`an incomplete cache opens its real authoritative turn at ${rate}x CPU`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  const requests: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/sessions/${COLD_SESSION_ID}/events`) requests.push(request.url());
  });
  await page.evaluate(path => {
    const state = { started: performance.now(), interactiveMs: 0, firstVisibleKey: "", longTasks: [] as number[] };
    (window as unknown as { __coldOpening: typeof state }).__coldOpening = state;
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.startTime >= state.started) state.longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: true });
    const frame = () => {
      const reader = document.querySelector<HTMLElement>(".detail-scroll");
      const ready = reader?.querySelector('[data-virtual-measurements="ready"]');
      const bounds = reader?.getBoundingClientRect();
      const row = ready && bounds ? [...ready.querySelectorAll<HTMLElement>("[data-virtual-row]")].find(row => {
        const rect = row.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
      }) : undefined;
      if (row) state.firstVisibleKey ||= row.dataset.virtualKey!;
      const control = document.querySelector<HTMLButtonElement>("[data-later-activity-gap] button");
      if (row && control && !control.disabled && reader?.getAttribute("aria-busy") !== "true") {
        state.interactiveMs = performance.now() - state.started;
        requestAnimationFrame(() => observer.disconnect());
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, viewPath({ name: "session", id: COLD_SESSION_ID }));
  if (process.env.LONG_TURN_OPENING_BASELINE === "1") {
    await delay(2_000);
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `cold-before-${rate}x.png`) });
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { __coldOpening: { interactiveMs: number } }).__coldOpening.interactiveMs),
    { timeout: 15_000 }).toBeGreaterThan(0);
  const measured = await page.evaluate(() => (window as unknown as { __coldOpening: {
    interactiveMs: number; firstVisibleKey: string; longTasks: number[] } }).__coldOpening);
  const opening = await page.request.get(`${base}/api/sessions/${COLD_SESSION_ID}/events?opening=current-turn&limit=200&eventEpoch=0`, { headers: { authorization: `Bearer ${token}` } });
  const body = await opening.json();
  const report = { rate, ...measured, longestTaskMs: Math.max(0, ...measured.longTasks),
    requestCount: requests.length, cacheComplete: body.cacheComplete, previewEvents: body.preview?.events.length ?? 0 };
  await info.attach(`cold-opening-${rate}x.json`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `cold-opening-${rate}x.json`), JSON.stringify(report, null, 2));
    await page.screenshot({ path: join(evidenceDir, `cold-after-${rate}x.png`) });
  }
  expect(body.cacheComplete).toBe(false);
  expect(body.preview.events).toHaveLength(200);
  expect(report.firstVisibleKey).toBe(`item:user_message:${LONG_TURN_START_SEQ}`);
  expect(report.interactiveMs).toBeLessThan(1_000);
  expect(report.longestTaskMs).toBeLessThanOrEqual(200);
  expect(report.requestCount).toBeLessThanOrEqual(2);
  await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Load Later Activity", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load Later Activity", exact: true })).toBeEnabled();
  await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
});

async function verifyColdBackgroundTurn(page: Page, paced = false) {
  await signIn(page);
  const before: number[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === `/api/sessions/${COLD_NAV_SESSION_ID}/history-preview` && url.searchParams.has("beforeSeq")) {
      before.push(Number(url.searchParams.get("beforeSeq")));
    }
  });
  await page.goto(`${base}${viewPath({ name: "session", id: COLD_NAV_SESSION_ID })}`);
  await expect(page.getByText("Synthetic navigation turn 3.", { exact: true })).toBeInViewport();
  if (paced) await delay(2_500);
  const pinned = page.getByRole("complementary", { name: "Pinned Summary" });
  if (!await pinned.isVisible()) await page.getByRole("button", { name: "Pinned Summary", exact: true }).click();
  const background = page.getByTitle("Open Background Work", { exact: true }).filter({ visible: true });
  if (paced) { await background.focus(); await delay(1_500); }
  await background.click();
  const viewTurn = page.getByRole("button", { name: "View Turn", exact: true });
  await expect(viewTurn).toBeVisible();
  if (paced) {
    mkdirSync(evidenceDir!, { recursive: true });
    await page.screenshot({ path: join(evidenceDir!, "navigation-before.png") });
    await delay(2_500);
    await viewTurn.focus();
    await delay(1_500);
  }
  await viewTurn.click();
  await expect(page.getByText(COLD_NAV_PROMPT, { exact: true })).toBeInViewport();
  await expect(page.locator('[data-virtual-key="item:user_message:1"]')).toHaveAttribute("data-virtual-target", "true");
  await expect(page.locator('[data-virtual-key="item:user_message:1"]')).toBeFocused();
  expect(before.length).toBeGreaterThan(1);
  expect(before[0]).toBe(803);
  expect(before.at(-1)).toBeLessThanOrEqual(203);
  expect(new Set(before).size).toBe(before.length);
  await expect(page.getByRole("button", { name: "Refresh Recent Activity", exact: true })).toBeVisible();
  const response = await page.request.get(`${base}/api/sessions/${COLD_NAV_SESSION_ID}/events?opening=current-turn&limit=200&eventEpoch=0`,
    { headers: { authorization: `Bearer ${token}` } });
  expect((await response.json()).cacheComplete).toBe(false);
  if (paced) {
    await page.screenshot({ path: join(evidenceDir!, "navigation-after.png") });
    await delay(4_500);
  }
}

test("cold Background Work View Turn pages to its private prompt and reveals it", async ({ page }) => {
  await verifyColdBackgroundTurn(page);
});

test("paced evidence of cold Background Work navigation across private pages", async ({ browser }) => {
  test.skip(!evidenceDir || process.env.LONG_TURN_OPENING_NAV_RECORD_VIDEO !== "1", "Opt-in paced evidence capture only.");
  const viewport = { width: Number(process.env.LONG_TURN_OPENING_NAV_WIDTH ?? 1280), height: 900 };
  const context = await browser.newContext({ viewport, colorScheme: process.env.LONG_TURN_OPENING_NAV_DARK === "1" ? "dark" : "light",
    recordVideo: { dir: join(evidenceDir!, "navigation-recordings"), size: viewport } });
  const page = await context.newPage();
  try { await verifyColdBackgroundTurn(page, true); } finally { await context.close(); }
  copyFileSync(await page.video()!.path(), join(evidenceDir!, "cold-background-navigation.webm"));
});

test("cold preview retries interrupted hydration and retains loaded pages without moving its visible prompt", async ({ page }) => {
  await signIn(page);
  await page.goto(`${base}${viewPath({ name: "session", id: COLD_SESSION_ID })}`);
  await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Load Later Activity", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load Later Activity", exact: true })).toBeEnabled();
  await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
  const before = coldRunner!.ordinaryReadCount();
  expect(coldRunner!.interruptHydration()).toBeGreaterThan(0);
  // Observe a new ordinary request caused by preview polling, before any explicit opening HTTP
  // poll can mask a missing retry. Existing service admission joins and cursor-gates that work.
  await expect.poll(() => coldRunner!.ordinaryReadCount()).toBeGreaterThan(before);
  coldRunner!.releaseHydration();
  await expect.poll(async () => {
    const response = await page.request.get(`${base}/api/sessions/${COLD_SESSION_ID}/events?opening=current-turn&limit=200&eventEpoch=0`, { headers: { authorization: `Bearer ${token}` } });
    return (await response.json()).cacheComplete;
  }).toBe(true);
  await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
  await expect(page.locator(".detail-scroll")).toHaveAttribute("data-follow-tail-state", "paused");
  await expect(page.getByText("Recent activity is readable as a snapshot while full history loads. Refresh to check for new activity.", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-virtual-key="item:user_message:1504"]')).toBeInViewport();
  if (evidenceDir) await page.screenshot({ path: join(evidenceDir, "cold-hydrated-handoff.png") });
});

test("paced evidence of the cold reader paging and hydration handoff", async ({ browser }) => {
  test.skip(process.env.LONG_TURN_OPENING_COLD_RECORD_VIDEO !== "1" || !evidenceDir, "opt-in private evidence capture");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
    recordVideo: { dir: join(scratch, "cold-video"), size: { width: 1280, height: 900 } } });
  const page = await context.newPage();
  try {
    await signIn(page);
    await delay(2_000);
    await page.evaluate(path => { history.pushState(null, "", path); dispatchEvent(new PopStateEvent("popstate")); },
      viewPath({ name: "session", id: COLD_SESSION_ID }));
    await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
    await expect(page.getByText("Recent activity is readable as a snapshot while full history loads. Refresh to check for new activity.", { exact: true })).toBeVisible();
    await delay(3_000);
    const later = page.getByRole("button", { name: "Load Later Activity", exact: true });
    await later.focus(); await delay(1_500); await later.click();
    await expect(later).toBeEnabled();
    await expect(page.getByText(LONG_TURN_PROMPT, { exact: true })).toBeInViewport();
    await delay(3_000);
    const jump = page.getByRole("button", { name: "Refresh Recent Activity", exact: true });
    await jump.focus(); await delay(1_500); await jump.click();
    await expect(page.locator("[data-later-activity-gap]")).toBeVisible();
    await expect(page.locator(".detail-scroll")).toHaveAttribute("data-follow-tail-state", "paused");
    await delay(3_000);
    coldRunner!.releaseHydration();
    await expect.poll(async () => {
      const response = await page.request.get(`${base}/api/sessions/${COLD_SESSION_ID}/events?opening=current-turn&limit=200&eventEpoch=0`,
        { headers: { authorization: `Bearer ${token}` } });
      return (await response.json()).cacheComplete;
    }).toBe(true);
    await expect(page.getByText("Recent activity is readable as a snapshot while full history loads. Refresh to check for new activity.", { exact: true })).toHaveCount(0);
    await expect(page.locator(".detail-scroll")).toHaveAttribute("data-follow-tail-state", "paused");
    await delay(4_000);
  } finally { await context.close(); }
  mkdirSync(evidenceDir!, { recursive: true });
  copyFileSync(await page.video()!.path(), join(evidenceDir!, "cold-paging-and-handoff.webm"));
});
