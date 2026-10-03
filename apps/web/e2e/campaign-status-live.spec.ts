import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WOLLIPOG_AGENT_ACTOR_SESSION_HEADER } from "@wollipog/protocol";
import { hashToken } from "../../control-plane/src/auth.js";
import { ControlPlaneDb } from "../../control-plane/src/db.js";
import {
  defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken,
} from "../../control-plane/src/local-device-credential.js";
import { titleCaseLabel } from "../src/format.js";
import { viewPath } from "../src/navigation.js";
import { recordPlanOffline, restoreCampaignStatuses, seedCampaignStatus } from "./fixtures/campaign-status-seed.js";

/**
 * Campaign Status (#2417) in the real app against a real control plane and its Read API: the merged
 * panel must read the server's summary, pages and details without a shape mismatch, follow ledger
 * writes live, survive reloads, reconnects and a stale cursor, and navigate between the campaign,
 * its members and unrelated sessions. The tests share one seeded stack and run in order; each says
 * what it adds to the ledger.
 *
 * Set CAMPAIGN_STATUS_EVIDENCE_DIR to also save the summary, list, details and member view at
 * 1440x900 and 390px in light and dark.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE_DIR = process.env.CAMPAIGN_STATUS_EVIDENCE_DIR;
const ORCHESTRATOR_TOKEN = "campaign-status-live-orchestrator";

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("failed to reserve a loopback port");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return address.port;
}

/** A build-time control-plane endpoint the test puts in the build's parent environment on purpose:
 * it must never reach the bundle, or the browser would talk to that control plane instead. */
const HOSTILE_ENDPOINT = { http: "http://127.0.0.1:9/hosting-control-plane", ws: "ws://127.0.0.1:9/hosting-control-plane" };

/** The parent environment without anything that could point the build or the control plane at
 * another Wollipog installation: its database, port, credentials, or a VITE_ build endpoint. */
function isolatedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/^(RUNNER_|CONTROL_PLANE_|WOLLIPOG_|VITE_)/u.test(key)) delete env[key];
  return env;
}

/** Every built file that mentions `needle`, relative to `dir`. */
function filesMentioning(dir: string, needle: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => readFileSync(file, "utf8").includes(needle))
    .map((file) => file.slice(dir.length + 1));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

/** Write to the live database beside the running control plane, retrying a momentary lock. */
async function withLiveDb<T>(databasePath: string, write: (db: ControlPlaneDb) => T): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let db: ControlPlaneDb | null = null;
    try {
      // Opening writes too (schema checks), so it can meet the server's lock as well.
      db = ControlPlaneDb.open(databasePath);
      return write(db);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("database is locked") || attempt === 49) throw error;
    } finally {
      db?.close();
    }
    await delay(20);
  }
}

/** One seeded control plane serving a production web build, restartable on the same port. */
class LiveStack {
  readonly temp = mkdtempSync(join(tmpdir(), "wollipog-campaign-status-"));
  readonly databasePath = join(this.temp, "control-plane.db");
  readonly webDist = join(this.temp, "web-dist");
  readonly ownerToken: string;
  readonly seeded: ReturnType<typeof seedCampaignStatus>;
  base = "";
  private port = 0;
  private controlPlane: ChildProcess | null = null;
  output = "";

  constructor() {
    const workspacePath = join(this.temp, "workspace");
    mkdirSync(workspacePath);
    this.ownerToken = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(this.databasePath));
    this.seeded = seedCampaignStatus(this.databasePath, workspacePath);
  }

  async start(): Promise<void> {
    const parent = { ...process.env, VITE_CONTROL_PLANE_HTTP: HOSTILE_ENDPOINT.http, VITE_CONTROL_PLANE_WS: HOSTILE_ENDPOINT.ws };
    const built = spawnSync("pnpm", ["--dir", "apps/web", "exec", "vite", "build", "--outDir", this.webDist], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, shell: process.platform === "win32", env: isolatedEnv(parent),
    });
    if (built.status !== 0 || !existsSync(join(this.webDist, "index.html"))) {
      throw new Error(`web build failed: ${(built.stderr ?? "").slice(-2000)} ${(built.stdout ?? "").slice(-2000)}`);
    }
    this.port = await reservePort();
    this.base = `http://127.0.0.1:${this.port}`;
    await this.launch();
  }

  /** Start the control plane, wait for health, and put back what startup settlement stopped. */
  async launch(): Promise<void> {
    const env = isolatedEnv();
    const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
      cwd: REPO_ROOT,
      env: { ...env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(this.port),
        CONTROL_PLANE_DB: this.databasePath, CONTROL_PLANE_USAGE_PRICING_URL: "off", WOLLIPOG_WEB_DIST: this.webDist },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.controlPlane = child;
    const capture = (chunk: unknown) => { this.output = (this.output + String(chunk)).slice(-8_192); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let ready = false;
    for (let attempt = 0; attempt < 400 && !ready; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`control plane exited early\n${this.output}`);
      try { ready = (await fetch(`${this.base}/healthz`)).ok; } catch { /* still starting */ }
      if (!ready) await delay(50);
    }
    if (!ready) throw new Error(`control plane did not become healthy\n${this.output}`);
    restoreCampaignStatuses(this.databasePath, this.seeded);
    await withLiveDb(this.databasePath, (db) =>
      db.setAgentControlCredential(this.seeded.rootId, "campaign-status-e2e", hashToken(ORCHESTRATOR_TOKEN), Date.now()));
  }

  async stopControlPlane(): Promise<void> {
    if (this.controlPlane) await stopChild(this.controlPlane);
    this.controlPlane = null;
  }

  async dispose(): Promise<void> {
    await this.stopControlPlane();
    rmSync(this.temp, { recursive: true, force: true });
  }

  /** Call an Orchestrator ledger route with the root Orchestrator's own credential. */
  async orchestrator<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}/api/sessions/${this.seeded.rootId}/orchestrator-campaign/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ORCHESTRATOR_TOKEN}`,
        [WOLLIPOG_AGENT_ACTOR_SESSION_HEADER]: this.seeded.rootId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  }

  /** A plan upsert through the Orchestrator route; returns the recorded ids by key. */
  async recordPlan(items: Array<{ key: string; title: string; queuePosition: number }>): Promise<Map<string, string>> {
    const recorded = await this.orchestrator<{ items: Array<{ key: string; workItemId: string }> }>("POST", "plan", {
      items: items.map((item) => ({ ...item, dispatchState: "queued" })), planComplete: true,
    });
    return new Map(recorded.items.map((item) => [item.key, item.workItemId]));
  }

  async updateItem(workItemId: string, update: Record<string, unknown>): Promise<void> {
    await this.orchestrator("POST", `work-items/${workItemId}`, update);
  }
}

let stack: LiveStack;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(240_000);
  stack = new LiveStack();
  await stack.start();
});

test.afterAll(async () => {
  await stack?.dispose();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) testInfo.annotations.push({ type: "control-plane", description: stack.output });
});

async function signIn(page: Page) {
  await page.goto(`${stack.base}/#pair=${stack.ownerToken}`);
  await expect(page.getByText("#2417 Campaign Orchestrator").first()).toBeVisible({ timeout: 30_000 });
}

async function openCampaignStatus(page: Page, sessionId: string) {
  await page.goto(`${stack.base}${viewPath({ name: "session", id: sessionId })}`);
  await showCampaignStatus(page);
}

async function showCampaignStatus(page: Page) {
  const toggle = page.getByRole("button", { name: "Side Panel" }).first();
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  const row = launcherRow(page);
  // A remembered mode opens straight into Campaign Status; otherwise pick it from the launcher.
  if (await row.isVisible().catch(() => false)) {
    await expect(row).not.toHaveAttribute("aria-disabled", "true");
    await row.click();
  }
  await expect(page.locator(".campaign-status-summary")).toBeVisible();
}

/** Navigate inside the running app, as a sidebar or link click does, without reloading it. */
async function navigateInApp(page: Page, sessionId: string) {
  await page.evaluate((path) => {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, viewPath({ name: "session", id: sessionId }));
}

const launcherRow = (page: Page) => page.locator(".rp-launcher .rp-row", { hasText: "Campaign Status" });
const workRows = (page: Page) => page.locator(".campaign-work-row");
const summaryBox = (page: Page) => page.locator(".campaign-status-summary");

async function assertNoHorizontalOverflow(page: Page, selector: string) {
  const geometry = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

/** The delivered/committed progress line, e.g. [1, 7] for "1 of 7 Delivered". */
async function progress(page: Page): Promise<[number, number]> {
  const text = await summaryBox(page).textContent() ?? "";
  const match = /(\d+) of (\d+) Delivered/u.exec(text);
  expect(match, text).not.toBeNull();
  return [Number(match![1]), Number(match![2])];
}

test("Campaign Status reads the live Read API for a campaign, its items and a member", async ({ page }) => {
  const { seeded, base, ownerToken } = stack;
  const apiFailures: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/campaign/") && response.status() >= 400) {
      apiFailures.push(`${response.status()} ${response.url()}`);
    }
  });

  // The browser endpoints answer for the root and for any member, with the documented shapes.
  const headers = { authorization: `Bearer ${ownerToken}` };
  const summary = await (await fetch(`${base}/api/sessions/${seeded.panelId}/campaign/summary`, { headers })).json() as {
    campaignSessionId: string; summary: { planState: string; counts: { committed: number; delivered: number } };
  };
  expect(summary.campaignSessionId).toBe(seeded.rootId);
  expect([summary.summary.planState, summary.summary.counts.committed, summary.summary.counts.delivered]).toEqual(["recorded", 7, 1]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  // Campaign: summary from the live projection, the unfinished list from the paginated route.
  await openCampaignStatus(page, seeded.rootId);
  const panel = page.locator(".campaign-status");
  await expect(summaryBox(page)).toContainText("1 of 7 Delivered");
  await expect(summaryBox(page)).toContainText("1 rejected, 0 deferred, 1 duplicate");
  // Slice 6 cost: $4.90 attributed with one record unpriced, so the total is a partially priced lower bound.
  await expect(summaryBox(page)).toContainText("$4.90");
  await expect(summaryBox(page)).toContainText("Partially Priced");
  await expect(summaryBox(page)).toContainText("coordination $0.35 (provider-reported)");
  await expect(summaryBox(page)).toContainText("unattributed $0.15 (provider-reported)");
  const rows = workRows(page);
  // Unfinished by default: running, blocked (recorded and by dependency), waiting, planned.
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toContainText("Campaign Status Panel");
  await expect(rows.filter({ hasText: "Ledger Read API" })).toHaveAttribute("data-state", "blocked");
  await expect(rows.filter({ hasText: "Observed Forge Status" })).toHaveAttribute("data-state", "blocked");
  await expect(rows.filter({ hasText: "Time and Cost Attribution" })).toHaveAttribute("data-state", "waiting");

  // Details: reported stage and observed facts are separate, with their freshness.
  await rows.filter({ hasText: "Ledger Read API" }).click();
  await expect(page.locator("h3.campaign-detail-title")).toHaveText("Ledger Read API");
  await expect(panel).toContainText("Waiting for a merge decision on the storage pull request.");
  await expect(panel).toContainText("Rebase onto main once storage merges.");
  await expect(panel.locator("dd", { hasText: /Observed|Stale, observed/u }).first()).toBeVisible();
  // Forge facts (slice 8) from the control plane's store, beside the Orchestrator's claim.
  await expect(panel).toContainText("Reported by the Orchestrator");
  await expect(panel.locator("dd", { hasText: "Observed on GitHub" })).toContainText("Open");
  await expect(panel.locator(".campaign-forge-fact", { hasText: "Required Checks" }))
    .toContainText("GitHub reports no required checks yet. This is not passing.");
  await page.getByRole("button", { name: "Back to Work Items" }).click();

  // The delivered, archived item keeps its history behind the finished filter.
  await page.getByRole("button", { name: /^State:/ }).click();
  await page.getByRole("option", { name: "All States" }).click();
  await expect(rows).toHaveCount(8);
  await rows.filter({ hasText: "Campaign Work Ledger Contract" }).click();
  await expect(panel).toContainText("Verified Delivered");
  await expect(panel).toContainText("archived");
  // Never read, and no runner is connected in this test: unavailable with the reason, not passing.
  await expect(panel.locator(".campaign-forge-pr", { hasText: "PR #2430" }))
    .toContainText("UnavailableThe campaign's runner is disconnected, so GitHub can't be read.");
  await page.getByRole("button", { name: "Back to Work Items" }).click();

  // Member: the child's own assignment is highlighted from its membership.
  await openCampaignStatus(page, seeded.panelId);
  const assignment = page.locator(".campaign-work-row.is-assignment");
  await expect(assignment).toContainText("Campaign Status Panel");
  await expect(page.locator(".campaign-status-context")).toContainText("#2417 Campaign Orchestrator");
  expect(apiFailures).toEqual([]);

  if (EVIDENCE_DIR) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate((theme) => localStorage.setItem("wollipog.theme", theme), scheme);
      for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const shot = (view: string) => page.screenshot({ path: join(EVIDENCE_DIR, `${view}-${viewport.name}-${scheme}.png`) });
        await openCampaignStatus(page, seeded.rootId);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        await expect(rows.first()).toBeVisible();
        await shot("summary-list");
        await rows.filter({ hasText: "Ledger Read API" }).click();
        await expect(page.locator("h3.campaign-detail-title")).toHaveText("Ledger Read API");
        await shot("details");
        await panel.getByRole("heading", { name: "Delivery", exact: true })
          .evaluate((element) => element.scrollIntoView({ block: "start" }));
        await shot("details-observed");
        // An attempt that used nothing reads a known zero, without a provenance claim.
        await page.getByRole("button", { name: "Back to Work Items" }).click();
        await rows.filter({ hasText: "Time and Cost Attribution" }).click();
        await panel.getByRole("heading", { name: "Time and Cost", exact: true })
          .evaluate((element) => element.scrollIntoView({ block: "start" }));
        await expect(panel).toContainText("No usage was recorded.");
        await shot("details-known-zero");
        await openCampaignStatus(page, seeded.panelId);
        await expect(assignment).toBeVisible();
        await shot("member");
      }
    }
  }
});

test("Orchestrator ledger writes appear live in the summary, list and open details, and survive a reload", async ({ page }) => {
  // Adds one queued item, "Live Update Item", at the head of the queue.
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await openCampaignStatus(page, stack.seeded.rootId);
  await expect(workRows(page).first()).toBeVisible();
  const [delivered, committed] = await progress(page);
  const requestsBefore: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/campaign/work-items")) requestsBefore.push(request.url()); });

  const ids = await stack.recordPlan([{ key: "live-update", title: "Live Update Item", queuePosition: 0 }]);
  await expect(summaryBox(page)).toContainText(`${delivered} of ${committed + 1} Delivered`);
  await expect(workRows(page).first()).toContainText("Live Update Item");
  await expect(workRows(page).first()).toHaveAttribute("data-state", "queued");

  // Open details, then report a stage: the open details follow the write without any navigation.
  await workRows(page).first().click();
  await expect(page.locator("h3.campaign-detail-title")).toHaveText("Live Update Item");
  await stack.updateItem(ids.get("live-update")!, {
    stage: { stage: "in_review", note: "Reviewing the live update." }, nextAction: "Merge once checks pass.",
  });
  const details = page.locator(".campaign-status");
  await expect(details).toContainText("Reviewing the live update.");
  await expect(details).toContainText("Merge once checks pass.");
  await expect(details).toContainText("Reported by the Orchestrator");

  // A reload reopens the same item from the server, with nothing lost.
  await page.reload();
  await showCampaignStatus(page);
  await expect(summaryBox(page)).toContainText(`${delivered} of ${committed + 1} Delivered`);
  const reopened = page.locator("h3.campaign-detail-title");
  if (await reopened.isVisible().catch(() => false)) {
    await expect(reopened).toHaveText("Live Update Item");
  } else {
    await workRows(page).filter({ hasText: "Live Update Item" }).click();
  }
  await expect(details).toContainText("Reviewing the live update.");
  await expect(page.locator('.campaign-status [role="alert"]')).toHaveCount(0);
});

test("parent/child navigation follows the campaign through a member and a nested Orchestrator, and leaves it for an unrelated session", async ({ page }) => {
  const { seeded } = stack;
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await openCampaignStatus(page, seeded.rootId);
  await expect(page.locator(".campaign-status-context")).toHaveCount(0);

  // A member: the campaign it works for, and its current assignment highlighted.
  await navigateInApp(page, seeded.panelId);
  await expect(page.locator(".campaign-status-context")).toContainText("#2417 Campaign Orchestrator");
  await expect(page.locator(".campaign-status-context")).toContainText("Its current assignment is highlighted.");
  await expect(page.locator(".campaign-work-row.is-assignment")).toContainText("Campaign Status Panel");

  // A nested Orchestrator reads the root campaign, not a campaign of its own.
  await navigateInApp(page, seeded.nestedId);
  await expect(page.locator(".campaign-status-context")).toContainText("#2417 Campaign Orchestrator");
  await expect(page.locator(".campaign-status-context")).toContainText("It has no current assignment.");
  await expect(page.locator(".campaign-work-row.is-assignment")).toHaveCount(0);

  // Leaving the campaign returns the open panel to the launcher, with no Campaign Status entry.
  await navigateInApp(page, seeded.unrelatedId);
  await expect(page.locator(".rp-launcher")).toBeVisible();
  await expect(launcherRow(page)).toHaveCount(0);
  await expect(page.locator(".campaign-status-summary")).toHaveCount(0);

  // The member's link back to its campaign opens the root, where the entry returns.
  await navigateInApp(page, seeded.panelId);
  await showCampaignStatus(page);
  await page.locator(".campaign-status-context").getByRole("link", { name: "#2417 Campaign Orchestrator" }).click();
  await expect(page).toHaveURL(new RegExp(`${viewPath({ name: "session", id: seeded.rootId })}$`, "u"));
  await expect(summaryBox(page)).toBeVisible();
  await expect(page.locator(".campaign-status-context")).toHaveCount(0);
});

test("labels and accessible names are Title Case, the list is keyboard operable, and the panel fits a phone in light and dark", async ({ page }) => {
  await signIn(page);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate((theme) => localStorage.setItem("wollipog.theme", theme), scheme);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCampaignStatus(page, stack.seeded.rootId);
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await expect(workRows(page).first()).toBeVisible();
    await assertNoHorizontalOverflow(page, ".campaign-status");
    const box = await page.locator("#right-panel").boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);

    // Every label the panel writes is Title Case; item titles are user content and are skipped.
    const body = page.locator(".rp-body");
    const labels = await body.locator("button:not(.campaign-work-row), h3:not(.campaign-detail-title), h4, dt")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")?.split(":")[0] ?? node.textContent ?? "")
        .map((text) => text.trim()).filter(Boolean));
    expect(labels.length).toBeGreaterThan(5);
    for (const label of labels) expect(titleCaseLabel(label), label).toBe(label);

    // One tab stop for the list; arrows move, Enter opens, and Back returns focus to the row.
    await workRows(page).first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(workRows(page).nth(1)).toBeFocused();
    const title = (await workRows(page).nth(1).locator(".campaign-work-row-title").textContent())?.trim();
    await page.keyboard.press("Enter");
    const heading = page.locator("h3.campaign-detail-title");
    await expect(heading).toBeFocused();
    if (title) await expect(heading).toHaveText(title);
    await assertNoHorizontalOverflow(page, ".campaign-status");
    const detailLabels = await body.locator("button:not(.campaign-work-row), h4, dt")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")?.split(":")[0] ?? node.textContent ?? "")
        .map((text) => text.trim()).filter(Boolean));
    for (const label of detailLabels) expect(titleCaseLabel(label), label).toBe(label);
    await page.getByRole("button", { name: "Back to Work Items" }).click();
    await expect(workRows(page).nth(1)).toBeFocused();
  }
});

test("a stalled campaign continuation reads Blocked at the root (#1352)", async ({ page }) => {
  // Stages a failed continuation for the root, then refreshes the root with a stage report.
  const { seeded, databasePath } = stack;
  await signIn(page);
  await openCampaignStatus(page, seeded.rootId);
  const state = summaryBox(page).locator("dt", { hasText: /^State$/u }).locator("xpath=following-sibling::dd[1]");
  await expect(state).not.toHaveText("Blocked");
  await withLiveDb(databasePath, (db) => {
    const now = Date.now();
    db.recordCampaignContinuationEvent({ eventId: `child-ready:${seeded.rootId}:live`, campaignSessionId: seeded.rootId,
      kind: "child_ready", now });
    const [event] = db.campaignContinuationEvents(seeded.rootId, now + 1_000);
    db.stageCampaignContinuation({ continuationId: "live-continuation", commandId: "live-continuation-cmd",
      campaignSessionId: seeded.rootId, runnerId: "campaign-status-e2e", eventFromSeq: event!.seq, eventThroughSeq: event!.seq,
      payloadJson: "{}", payloadSha256: "a".repeat(64), expiresAt: now + 60_000, attemptCount: 1, now });
    db.updateCampaignContinuationForCommand("live-continuation-cmd", "failed", now, "provider refused the turn");
  });
  await stack.updateItem(seeded.panelItemId, { stage: { stage: "implementing", note: "Still binding the panel." } });
  await expect(state).toHaveText("Blocked");
  await expect(workRows(page).filter({ hasText: "Campaign Status Panel" })).toHaveAttribute("data-state", "running",
    { timeout: 10_000 });
});

test("Show More still loads its page when the ledger changes while that page is in flight (revision_changed)", async ({ page }) => {
  // Adds sixty queued "Bulk Item" rows so the unfinished list spans pages.
  await stack.recordPlan(Array.from({ length: 60 }, (_, index) => ({
    key: `bulk-${index + 1}`, title: `Bulk Item ${String(index + 1).padStart(2, "0")}`, queuePosition: 100 + index,
  })));
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await openCampaignStatus(page, stack.seeded.rootId);
  const pageSize = 50;
  await expect(workRows(page)).toHaveCount(pageSize);
  const total = (await stack.orchestrator<{ page: { total: number } }>("GET", "work-items?limit=1")).page.total;
  expect(total).toBeGreaterThan(pageSize);

  // Hold the next page until a ledger write has committed and the browser has started the reload
  // that write's revision triggers, so the page reaches the server stale after the reload began.
  // (The opposite order, a refusal before the revision, is pinned by the DOM tests.)
  const refusals: string[] = [];
  page.on("response", async (response) => {
    if (response.url().includes("cursor=") && response.status() === 409) {
      refusals.push(((await response.json().catch(() => ({}))) as { code?: string }).code ?? "");
    }
  });
  let held = false;
  await page.route(/\/campaign\/work-items\?.*cursor=/u, async (route) => {
    if (!held) {
      held = true;
      const revisionReload = page.waitForRequest((request) =>
        request.url().includes("/campaign/work-items?") && !request.url().includes("cursor="));
      await stack.updateItem(stack.seeded.readApiItemId, { nextAction: "Rebase onto main once storage merges, then retest." });
      await revisionReload;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Show More" }).click();
  await expect(workRows(page)).toHaveCount(total, { timeout: 15_000 });
  expect(held).toBe(true);
  await expect.poll(() => refusals).toEqual(["revision_changed"]);
  await expect(page.locator('.campaign-status [role="alert"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show More" })).toHaveCount(0);
  const keys = await workRows(page).evaluateAll((rows) => rows.map((row) => row.textContent));
  expect(new Set(keys).size, "no row is shown twice").toBe(keys.length);
  await page.unroute(/\/campaign\/work-items\?.*cursor=/u);
});

test("a reconnecting browser catches up on ledger changes made while the control plane was down", async ({ page }) => {
  // Records "Recorded While Offline" while the control plane is stopped, then restarts it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await openCampaignStatus(page, stack.seeded.rootId);
  await expect(workRows(page).first()).toBeVisible();
  const [delivered, committed] = await progress(page);

  await stack.stopControlPlane();
  await expect(page.locator(".campaign-status-offline")).toContainText("Reconnecting…", { timeout: 30_000 });
  await expect(summaryBox(page)).toContainText(`${delivered} of ${committed} Delivered`);
  recordPlanOffline(stack.databasePath, stack.seeded.rootId, [{ key: "offline", title: "Recorded While Offline", queuePosition: 0 }]);

  await stack.launch();
  await expect(page.locator(".campaign-status-offline")).toHaveCount(0, { timeout: 60_000 });
  await expect(summaryBox(page)).toContainText(`${delivered} of ${committed + 1} Delivered`);
  await expect(workRows(page).filter({ hasText: "Recorded While Offline" })).toHaveCount(1);
  await expect(page.locator('.campaign-status [role="alert"]')).toHaveCount(0);
});

test("the web build and control plane never inherit another installation's endpoints or credentials", async () => {
  // The build ran with a hostile VITE_CONTROL_PLANE_* in its parent environment.
  expect(filesMentioning(stack.webDist, "hosting-control-plane")).toEqual([]);
  expect(isolatedEnv({ PATH: "/bin", VITE_CONTROL_PLANE_HTTP: HOSTILE_ENDPOINT.http, VITE_CONTROL_PLANE_WS: HOSTILE_ENDPOINT.ws,
    CONTROL_PLANE_DB: "/hosting/control-plane.db", CONTROL_PLANE_PORT: "4317", WOLLIPOG_SESSION_ID: "s_hosting",
    RUNNER_TOKEN: "secret" })).toEqual({ PATH: "/bin" });
});
