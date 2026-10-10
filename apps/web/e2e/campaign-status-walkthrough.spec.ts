import { expect, test, type Browser, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ControlPlaneDb } from "../../control-plane/src/db.js";
import {
  defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken,
} from "../../control-plane/src/local-device-credential.js";
import { viewPath } from "../src/navigation.js";
import { restoreCampaignStatuses, seedCampaignStatus } from "./fixtures/campaign-status-seed.js";
import {
  recordFreshWalkthroughObservation, REVIEWER_TOKEN, seedCampaignWalkthrough, WALKTHROUGH_PULL_REQUESTS,
} from "./fixtures/campaign-status-walkthrough-seed.js";

/**
 * The integrated Campaign Status walkthrough (#2417 slice 9b): one seeded control plane serving a
 * production web build, walked as a person would for the root, a member, a nested Orchestrator, a
 * session outside every campaign, and the unsupported-server fixture, with time, cost, and forge
 * facts in each of their states, including what a reader without access sees.
 *
 * Set CAMPAIGN_STATUS_WALKTHROUGH_DIR to save every view at 1440x900 and 390x844 in light and dark.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE_DIR = process.env.CAMPAIGN_STATUS_WALKTHROUGH_DIR;
const VIEWPORTS = [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }] as const;
const SCHEMES = ["light", "dark"] as const;

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

class WalkthroughStack {
  readonly temp = mkdtempSync(join(tmpdir(), "wollipog-campaign-walkthrough-"));
  readonly databasePath = join(this.temp, "control-plane.db");
  readonly webDist = join(this.temp, "web-dist");
  readonly ownerToken: string;
  readonly seeded: ReturnType<typeof seedCampaignStatus>;
  readonly walkthrough: ReturnType<typeof seedCampaignWalkthrough>;
  base = "";
  output = "";
  private controlPlane: ChildProcess | null = null;

  constructor() {
    const workspacePath = join(this.temp, "workspace");
    mkdirSync(workspacePath);
    this.ownerToken = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(this.databasePath));
    this.seeded = seedCampaignStatus(this.databasePath, workspacePath);
    this.walkthrough = seedCampaignWalkthrough(this.databasePath, this.seeded);
  }

  async start(): Promise<void> {
    const env = { ...process.env };
    // Never inherit the hosting Wollipog installation's database, port, credentials, or endpoints:
    // a VITE_CONTROL_PLANE_* value would be built into the bundle and point the browser at it.
    for (const key of Object.keys(env)) if (/^(RUNNER_|CONTROL_PLANE_|WOLLIPOG_|VITE_)/u.test(key)) delete env[key];
    const built = spawnSync("pnpm", ["--dir", "apps/web", "exec", "vite", "build", "--outDir", this.webDist], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, shell: process.platform === "win32", env,
    });
    if (built.status !== 0 || !existsSync(join(this.webDist, "index.html"))) {
      throw new Error(`web build failed: ${(built.stderr ?? "").slice(-2000)} ${(built.stdout ?? "").slice(-2000)}`);
    }
    const port = await reservePort();
    this.base = `http://127.0.0.1:${port}`;
    recordFreshWalkthroughObservation(this.databasePath, this.seeded.rootId);
    const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
      cwd: REPO_ROOT,
      env: { ...env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
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
    // Startup settlement stops every session it finds live. Put them back as they were.
    restoreCampaignStatuses(this.databasePath, this.seeded);
    const db = ControlPlaneDb.open(this.databasePath);
    try {
      for (const id of [this.walkthrough.walkthroughWorkerId, this.walkthrough.sharedRootId, "shared-review-child"]) {
        db.updateSessionStatus(id, "idle", Date.now());
      }
    } finally {
      db.close();
    }
  }

  async dispose(): Promise<void> {
    const child = this.controlPlane;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise<void>((done) => child.once("exit", () => done())), delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(this.temp, { recursive: true, force: true });
  }
}

let stack: WalkthroughStack;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(240_000);
  stack = new WalkthroughStack();
  await stack.start();
});

test.afterAll(async () => {
  await stack?.dispose();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) testInfo.annotations.push({ type: "control-plane", description: stack.output });
});

const panel = (page: Page) => page.locator(".campaign-status");
const summaryBox = (page: Page) => page.locator(".campaign-status-summary");
const workRows = (page: Page) => page.locator(".campaign-work-row");
const launcherRow = (page: Page) => page.locator(".rp-launcher .rp-row", { hasText: "Campaign Status" });
const forgePr = (page: Page, number: number) => page.locator(".campaign-forge-pr", { hasText: `PR #${number}` });

async function signIn(page: Page, token: string, title: string) {
  await page.goto(`${stack.base}/#pair=${token}`);
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 30_000 });
}

async function setScheme(page: Page, scheme: (typeof SCHEMES)[number]) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((theme) => localStorage.setItem("wollipog.theme", theme), scheme);
}

async function openSession(page: Page, sessionId: string) {
  await page.goto(`${stack.base}${viewPath({ name: "session", id: sessionId })}`);
  // A remembered open panel covers a phone's session bar, toggle included (#2843).
  await expect(page.getByRole("button", { name: "Side Panel" }).first().or(page.locator("#right-panel")).first()).toBeVisible();
  if (!await page.locator("#right-panel").isVisible()) await page.getByRole("button", { name: "Side Panel" }).first().click();
}

async function openCampaignStatus(page: Page, sessionId: string) {
  await openSession(page, sessionId);
  const row = launcherRow(page);
  if (await row.isVisible().catch(() => false)) await row.click();
  await expect(summaryBox(page)).toBeVisible();
}

async function openItem(page: Page, title: string) {
  await page.getByRole("button", { name: /^State:/ }).click();
  await page.getByRole("option", { name: "All States" }).click();
  await workRows(page).filter({ hasText: title }).click();
  await expect(page.locator("h3.campaign-detail-title")).toHaveText(title);
}

async function scrollTo(page: Page, heading: string) {
  await panel(page).getByRole("heading", { name: heading, exact: true })
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
}

/** The value beside one definition term in the open details. */
const fact = (page: Page, label: string) =>
  panel(page).locator("dt", { hasText: new RegExp(`^${label}$`, "u") }).locator("xpath=following-sibling::dd[1]");

/** Run one view in every viewport and scheme, saving a capture of each when asked. */
async function everyVariant(page: Page, view: string, walk: (scheme: (typeof SCHEMES)[number]) => Promise<void>,
  options: { appTheme?: boolean } = {}) {
  for (const scheme of SCHEMES) {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      if (options.appTheme === false) await page.emulateMedia({ colorScheme: scheme });
      else await setScheme(page, scheme);
      await walk(scheme);
      if (options.appTheme !== false) await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      const overflow = await page.locator("#right-panel").evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow, `${view} fits ${viewport.name}`).toBeLessThanOrEqual(1);
      if (EVIDENCE_DIR) {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(EVIDENCE_DIR, `${view}-${viewport.name}-${scheme}.png`) });
      }
    }
  }
}

test("the root campaign summarizes progress, elapsed time, and partially priced cost by bucket", async ({ page }) => {
  await signIn(page, stack.ownerToken, "#2417 Campaign Orchestrator");
  await everyVariant(page, "01-root-summary", async () => {
    await openCampaignStatus(page, stack.seeded.rootId);
    await expect(summaryBox(page)).toContainText("1 of 8 Delivered");
    await expect(summaryBox(page)).toContainText("Partially Priced");
    // The campaign predates recording, so each bucket is a lower bound with its own provenance.
    await expect(summaryBox(page)).toContainText("coordination at least $0.35 (provider-reported)");
    // Seeded an hour before the build; the open campaign's clock keeps running while it builds.
    await expect(summaryBox(page).locator("dt", { hasText: /^Elapsed$/u }).locator("xpath=following-sibling::dd[1]"))
      .toHaveText(/^1h( \d{1,2}m)?$/u);
    await expect(workRows(page).first()).toContainText("Merge-Queue Wait With Forge Facts");
  });
});

test("item details show recorded time, attempt cost, and forge facts fresh, stale, unavailable, and never read", async ({ page }) => {
  await signIn(page, stack.ownerToken, "#2417 Campaign Orchestrator");
  const title = "Merge-Queue Wait With Forge Facts";
  await everyVariant(page, "02-details-time-cost", async () => {
    await openCampaignStatus(page, stack.seeded.rootId);
    await openItem(page, title);
    const details = panel(page);
    await expect(details).toContainText("Merge Queued");
    await expect(details).toContainText("Reported by the Orchestrator");
    await expect(fact(page, "Queue Time")).toHaveText("10m");
    await expect(fact(page, "Active Time")).toContainText("27m");
    await expect(fact(page, "Cost")).toContainText("$1.50Provider-Reported");
    await expect(details).toContainText("opus");
    await scrollTo(page, "Time and Cost");
  });
  await everyVariant(page, "03-details-forge", async () => {
    await openCampaignStatus(page, stack.seeded.rootId);
    await openItem(page, title);
    await expect(forgePr(page, WALKTHROUGH_PULL_REQUESTS.fresh)).toContainText("Observed on GitHub");
    // The fresh pull request is listed first; its facts follow its row, the merge-queue wait among them.
    await expect(panel(page).locator(".campaign-forge-fact", { hasText: "Merge Queue" }).first()).toContainText("Awaiting Checks");
    await expect(forgePr(page, WALKTHROUGH_PULL_REQUESTS.stale)).toContainText(/Stale/u);
    await expect(forgePr(page, WALKTHROUGH_PULL_REQUESTS.failed))
      .toContainText("The GitHub CLI on the campaign's runner isn't signed in to github.com.");
    await expect(forgePr(page, WALKTHROUGH_PULL_REQUESTS.neverRead))
      .toContainText("The campaign's runner is disconnected, so GitHub can't be read.");
    // The row wrapper has no box of its own; its term does.
    await forgePr(page, WALKTHROUGH_PULL_REQUESTS.fresh).locator("dt")
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
  });
});

test("a member and a nested Orchestrator read the root campaign; a session outside every campaign has no entry", async ({ page }) => {
  await signIn(page, stack.ownerToken, "#2417 Campaign Orchestrator");
  await everyVariant(page, "04-member", async () => {
    await openCampaignStatus(page, stack.seeded.panelId);
    await expect(page.locator(".campaign-status-context")).toContainText("Its current assignment is highlighted.");
    await expect(page.locator(".campaign-work-row.is-assignment")).toContainText("Campaign Status Panel");
    await page.locator(".campaign-work-row.is-assignment").evaluate((element) => element.scrollIntoView({ block: "center" }));
  });
  await everyVariant(page, "05-nested-orchestrator", async () => {
    await openCampaignStatus(page, stack.seeded.nestedId);
    await expect(page.locator(".campaign-status-context")).toContainText("#2417 Campaign Orchestrator");
    await expect(page.locator(".campaign-status-context")).toContainText("It has no current assignment.");
  });
  await everyVariant(page, "06-non-campaign", async () => {
    await openSession(page, stack.seeded.unrelatedId);
    await expect(page.locator(".rp-launcher")).toBeVisible();
    await expect(launcherRow(page)).toHaveCount(0);
  });
});

test("a server without campaign work explains the unavailable entry (fixture)", async ({ page }) => {
  // An older control plane cannot run in this stack; the fixture serves the same panel without `work`.
  await everyVariant(page, "07-unsupported-peer", async (scheme) => {
    await page.goto(`/campaign-status-e2e.html?scenario=legacy&open=launcher&theme=${scheme}`);
    const row = launcherRow(page);
    await expect(row).toHaveAttribute("aria-disabled", "true");
    await expect(row).toContainText("This Wollipog server does not report campaign work.");
  }, { appTheme: false });
});

test("a reader who may see the campaign but not every contributor or the runner sees not_authorized, never a smaller number", async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page, REVIEWER_TOKEN, "#2417 Campaign Orchestrator");
    await everyVariant(page, "08-not-authorized", async () => {
      await openCampaignStatus(page, stack.walkthrough.sharedRootId);
      await expect(summaryBox(page)).toContainText("You cannot see the cost of every session it includes.");
      await expect(summaryBox(page)).not.toContainText("$0.60");
      await openItem(page, "Review the Shared Change");
      await expect(panel(page)).toContainText("In Review");
      await expect(forgePr(page, 2495)).toContainText(
        "GitHub status is read through the campaign runner's GitHub CLI, and you don't have access to that runner.");
      await expect(panel(page)).not.toContainText("$0.60");
      await scrollTo(page, "Time and Cost");
    });
  } finally {
    await context.close();
  }
});
